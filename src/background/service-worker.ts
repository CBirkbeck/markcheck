import { getScrape, setScrape } from "../lib/storage";
import type { ScrapeResult, MarkRecord } from "../lib/types";

const DELAY_MS = 800; // pacing between students
const T_NAV = 8000; // wait for a page navigation (list↔detail, modules-and-marks form)
const T_TABLE = 30000; // wait for the marks table to generate after Submit (can be slower)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let running = false;

const STATUS_KEY = "markcheck.status";
type Status = { running: boolean; done: number; total: number; skipped: number; scraped: number; message: string; error?: boolean };
let status: Status = { running: false, done: 0, total: 0, skipped: 0, scraped: 0, message: "Idle." };

async function publish(patch: Partial<Status>): Promise<void> {
  status = { ...status, ...patch };
  await chrome.storage.local.set({ [STATUS_KEY]: status });
  const color = status.error ? "#dc2626" : status.running ? "#3b82f6" : "#16a34a";
  const text = status.error ? "!" : status.running ? String(status.done) : status.scraped ? String(status.scraped) : "";
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.runtime.sendMessage({ type: "STATUS", status }).catch(() => {});
}

function emptyResult(): ScrapeResult {
  return { students: [], marks: [], failures: [], scrapedAt: new Date().toISOString() };
}
async function send<T>(tabId: number, m: unknown): Promise<T> {
  return (await chrome.tabs.sendMessage(tabId, m)) as T;
}
async function pageTypeOf(tabId: number): Promise<string> {
  try {
    const r = await send<{ pageType: string }>(tabId, { type: "PAGE_TYPE" });
    return r.pageType;
  } catch {
    return "unknown";
  }
}
/** Resolve when the tab finishes loading (or after timeoutMs). */
function waitForComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

/** Wait for the tab to finish loading, then return its settled page type (retries while the content script spins up). */
async function loadedPageType(tabId: number): Promise<string> {
  await waitForComplete(tabId, T_NAV);
  for (let k = 0; k < 5; k++) {
    await sleep(300);
    const pt = await pageTypeOf(tabId);
    if (pt !== "unknown") return pt;
  }
  return "unknown";
}

/** Poll until the tab reports one of `expected` page types (content script may be mid-navigation). */
async function waitForPageType(tabId: number, expected: string[], timeoutMs = 15000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(400);
    const pt = await pageTypeOf(tabId);
    if (expected.includes(pt)) return pt;
    if (pt === "login") return "login";
  }
  return "timeout";
}
/** Resolve with the id of the next tab Chrome creates (or null after timeout). */
function waitForNewTab(timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (id: number | null) => {
      if (done) return;
      done = true;
      chrome.tabs.onCreated.removeListener(listener);
      resolve(id);
    };
    const listener = (tab: chrome.tabs.Tab) => {
      if (tab.id != null) finish(tab.id);
    };
    chrome.tabs.onCreated.addListener(listener);
    setTimeout(() => finish(null), timeoutMs);
  });
}

async function closeTab(id: number): Promise<void> {
  await chrome.tabs.remove(id).catch(() => {});
}

async function crawl(listTabId: number): Promise<void> {
  running = true;
  let loginPaused = false;
  let skipped = 0;
  const result = (await getScrape()) ?? emptyResult();
  const seen = new Set(result.students.map((s) => s.studentNumber));

  if ((await pageTypeOf(listTabId)) !== "list") {
    await publish({ running: false, error: true, message: "Open the student list page in this tab, then press Start." });
    running = false;
    return;
  }
  const { count } = await send<{ count: number }>(listTabId, { type: "LIST_COUNT" });
  await publish({ running: true, error: false, done: result.students.length, total: count, skipped: 0, scraped: result.students.length, message: "Scraping…" });

  const advance = async (i: number) => {
    await publish({ done: i + 1, total: count, skipped, scraped: result.students.length, message: `Scraping ${i + 1}/${count} · ${result.students.length} captured` });
  };

  for (let i = result.students.length; i < count && running; i++) {
    if ((await pageTypeOf(listTabId)) === "login") {
      loginPaused = true;
      await publish({ running: false, message: "Paused — log into eVision, then press Start to resume." });
      break;
    }

    // Open this student's detail page in a NEW tab (genuine link click → valid token; the list tab is left untouched).
    const newTabP = waitForNewTab(T_NAV);
    await send(listTabId, { type: "OPEN_DETAILS_NEW_TAB", index: i });
    const workerTabId = await newTabP;
    if (workerTabId == null) {
      result.failures.push({ reason: `couldn't open student #${i + 1}` });
      await advance(i);
      continue;
    }
    // Put focus back on the list tab; the worker tab is driven in the background.
    await chrome.tabs.update(listTabId, { active: true }).catch(() => {});

    try {
      let pt = await loadedPageType(workerTabId);
      if (pt === "login") {
        loginPaused = true;
        await publish({ running: false, message: "Paused — log into eVision, then press Start to resume." });
        await closeTab(workerTabId);
        break;
      }
      if (pt !== "detail") {
        skipped += 1; // no Modules-and-Marks link → no access
        await advance(i);
        await closeTab(workerTabId);
        continue;
      }

      await send(workerTabId, { type: "CLICK_MARKS" });
      pt = await loadedPageType(workerTabId);
      if (pt === "submit") {
        await send(workerTabId, { type: "CLICK_SUBMIT" });
        pt = await waitForPageType(workerTabId, ["marks"], T_TABLE);
      }
      if (pt !== "marks") {
        skipped += 1;
        await advance(i);
        await closeTab(workerTabId);
        continue;
      }

      await sleep(1000); // let the generated table settle
      let page = await send<{ studentNumber: string; name: string; marks: Omit<MarkRecord, "studentNumber">[] }>(workerTabId, { type: "SCRAPE" });
      if (page.marks.length === 0) {
        await sleep(2500);
        page = await send<{ studentNumber: string; name: string; marks: Omit<MarkRecord, "studentNumber">[] }>(workerTabId, { type: "SCRAPE" });
      }
      if (page.studentNumber && !seen.has(page.studentNumber)) {
        seen.add(page.studentNumber);
        result.students.push({ studentNumber: page.studentNumber, name: page.name });
        for (const m of page.marks) result.marks.push({ ...m, studentNumber: page.studentNumber });
      } else if (!page.studentNumber) {
        result.failures.push({ reason: `no student number scraped for student #${i + 1}` });
      }
      result.scrapedAt = new Date().toISOString();
      await setScrape(result);
      await advance(i);
    } catch (e) {
      result.failures.push({ reason: `error on student #${i + 1}: ${String(e)}` });
      await advance(i);
    } finally {
      await closeTab(workerTabId);
    }
    await sleep(DELAY_MS);
  }
  running = false;
  if (!loginPaused) {
    await publish({ running: false, error: false, message: `Finished — checked ${count} students: ${result.students.length} captured, ${skipped} skipped (no access).` });
  }
}

/** Manual fallback: scrape just the marks page currently open in the active tab. */
async function scrapeOne(tabId: number): Promise<void> {
  if ((await pageTypeOf(tabId)) !== "marks") {
    await publish({ running: false, message: "Open a student's Modules and Marks page first." });
    return;
  }
  const result = (await getScrape()) ?? emptyResult();
  const seen = new Set(result.students.map((s) => s.studentNumber));
  try {
    const page = await send<{ studentNumber: string; name: string; marks: Omit<MarkRecord, "studentNumber">[] }>(tabId, { type: "SCRAPE" });
    if (page.studentNumber && !seen.has(page.studentNumber)) {
      result.students.push({ studentNumber: page.studentNumber, name: page.name });
      for (const m of page.marks) result.marks.push({ ...m, studentNumber: page.studentNumber });
      result.scrapedAt = new Date().toISOString();
      await setScrape(result);
    }
    await publish({ running: false, scraped: result.students.length, message: `Captured ${result.students.length} student(s) so far. Open results.` });
  } catch (e) {
    await publish({ running: false, message: "Scrape failed: " + String(e) });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, send2) => {
  if (msg?.type === "START_SCRAPE") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id != null) crawl(tab.id);
    });
    send2({ ok: true });
  } else if (msg?.type === "SCRAPE_ONE") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id != null) scrapeOne(tab.id);
    });
    send2({ ok: true });
  } else if (msg?.type === "STOP_SCRAPE") {
    running = false;
    send2({ ok: true });
  } else if (msg?.type === "GET_PROGRESS") {
    chrome.storage.local.get([STATUS_KEY]).then((r) => send2({ status: (r[STATUS_KEY] as Status) ?? status }));
    return true;
  }
  return true;
});
