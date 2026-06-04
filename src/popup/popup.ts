const $ = (id: string) => document.getElementById(id)!;
const statusEl = $("status");
const fill = $("fill") as HTMLDivElement;

type Status = { running: boolean; done: number; total: number; skipped: number; scraped: number; message: string };

function render(s: Status | undefined): void {
  statusEl.textContent = s?.message ?? "Idle.";
  const warn = !!s && !s.running && /paused|couldn't|failed|open the student/i.test(s.message);
  statusEl.className = warn ? "warn" : "";
  fill.style.width = s && s.total > 0 ? `${Math.min(100, (s.done / s.total) * 100)}%` : "0";
}

$("start").addEventListener("click", () => chrome.runtime.sendMessage({ type: "START_SCRAPE" }));
$("stop").addEventListener("click", () => chrome.runtime.sendMessage({ type: "STOP_SCRAPE" }));
$("one").addEventListener("click", () => chrome.runtime.sendMessage({ type: "SCRAPE_ONE" }));
$("results").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("src/results/results.html") }),
);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "STATUS") render(msg.status);
});
chrome.runtime.sendMessage({ type: "GET_PROGRESS" }, (r) => render(r?.status));
