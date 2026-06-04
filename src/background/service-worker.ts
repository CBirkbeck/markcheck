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
/** Step back to the student list using the page's own Back action (history.back), like the user's Back button. */
async function returnToList(tabId: number): Promise<string> {
  let pt = await pageTypeOf(tabId);
  let hops = 0;
  while (pt !== "list" && pt !== "login" && hops < 5) {
    await send(tabId, { type: "CLICK_BACK" });
    await sleep(500); // let the back navigation begin
    pt = await waitForPageType(tabId, ["list", "detail", "submit", "marks"], T_NAV);
    hops++;
  }
  return pt;
}

async function crawl(tabId: number): Promise<void> {
  running = true;
  let loginPaused = false;
  let aborted = false;
  let skipped = 0;
  const result = (await getScrape()) ?? emptyResult();
  const seen = new Set(result.students.map((s) => s.studentNumber));

  if ((await pageTypeOf(tabId)) !== "list") {
    await publish({ running: false, error: true, message: "Open the student list page in this tab, then press Start." });
    running = false;
    return;
  }
  const { count } = await send<{ count: number }>(tabId, { type: "LIST_COUNT" });
  await publish({ running: true, done: result.students.length, total: count, skipped: 0, scraped: result.students.length, message: "Scraping…", error: false });

  const advance = async (i: number) => {
    await publish({ done: i + 1, total: count, skipped, scraped: result.students.length, message: `Scraping ${i + 1}/${count} · ${result.students.length} captured` });
  };
  // Return to the list via Back; returns true if we made it, publishes login pause if needed.
  const goHome = async (i: number): Promise<boolean> => {
    const pt = await returnToList(tabId);
    if (pt === "login") { loginPaused = true; await publish({ running: false, message: "Paused — log into eVision, then press Start to resume." }); return false; }
    if (pt !== "list") {
      aborted = true;
      await publish({ running: false, error: true, message: `Couldn't get back to the student list after student #${i + 1}. Refresh the eVision list page and press Start to resume — if it keeps stopping here, the Back step isn't working in this browser; tell the developer.` });
      return false;
    }
    return true;
  };

  for (let i = result.students.length; i < count && running; i++) {
    // make sure we're on the list before clicking the next student
    if ((await pageTypeOf(tabId)) !== "list" && !(await goHome(i - 1))) break;

    // 1. open detail; no "Modules and Marks" link → no access → skip
    await send(tabId, { type: "CLICK_DETAILS", index: i });
    let pt = await loadedPageType(tabId);
    if (pt === "login") { loginPaused = true; await publish({ running: false, message: "Paused — log into eVision, then press Start to resume." }); break; }
    if (pt !== "detail") {
      skipped += 1;
      await advance(i);
      if (!(await goHome(i))) break;
      continue;
    }

    // 2. Modules and Marks
    await send(tabId, { type: "CLICK_MARKS" });
    pt = await loadedPageType(tabId);
    if (pt === "login") { loginPaused = true; await publish({ running: false, message: "Paused — log into eVision, then press Start to resume." }); break; }

    // 3. Submit → wait for the table to generate (POST; slow)
    if (pt === "submit") {
      await send(tabId, { type: "CLICK_SUBMIT" });
      pt = await waitForPageType(tabId, ["marks"], T_TABLE);
      if (pt === "login") { loginPaused = true; await publish({ running: false, message: "Paused — log into eVision, then press Start to resume." }); break; }
    }
    if (pt !== "marks") {
      skipped += 1;
      await advance(i);
      if (!(await goHome(i))) break;
      continue;
    }

    // 4. scrape — settle, re-scrape once if empty
    await sleep(1000);
    try {
      let page = await send<{ studentNumber: string; name: string; marks: Omit<MarkRecord, "studentNumber">[] }>(tabId, { type: "SCRAPE" });
      if (page.marks.length === 0) {
        await sleep(2500);
        page = await send<{ studentNumber: string; name: string; marks: Omit<MarkRecord, "studentNumber">[] }>(tabId, { type: "SCRAPE" });
      }
      if (page.studentNumber && !seen.has(page.studentNumber)) {
        seen.add(page.studentNumber);
        result.students.push({ studentNumber: page.studentNumber, name: page.name });
        for (const m of page.marks) result.marks.push({ ...m, studentNumber: page.studentNumber });
      } else if (!page.studentNumber) {
        result.failures.push({ reason: `no student number scraped for student #${i + 1}` });
      }
    } catch (e) {
      result.failures.push({ reason: `scrape error for student #${i + 1}: ${String(e)}` });
    }
    result.scrapedAt = new Date().toISOString();
    await setScrape(result);
    await advance(i);

    if (!(await goHome(i))) break;
    await sleep(DELAY_MS);
  }
  running = false;
  if (!loginPaused && !aborted) {
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
