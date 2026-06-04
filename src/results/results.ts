import { parseBlackboard } from "../lib/blackboard";
import { evisionComponents, buildMapping, applyMapping } from "../lib/mapping";
import { compare, comparedRows } from "../lib/compare";
import { buildReport, toCsv } from "../lib/report";
import { getScrape, getMapping, setMapping, clearAll } from "../lib/storage";
import type { BlackboardColumn, ComparedMark, Discrepancy, EvisionComponent, MappingEntry, ReportModel } from "../lib/types";

function esc(s: string | null | undefined): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Decode an uploaded file, handling Blackboard's UTF-16 Grade Centre exports (BOM-sniffed). */
function decodeFile(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let text: string;
  if (b[0] === 0xff && b[1] === 0xfe) text = new TextDecoder("utf-16le").decode(b);
  else if (b[0] === 0xfe && b[1] === 0xff) text = new TextDecoder("utf-16be").decode(b);
  else text = new TextDecoder("utf-8").decode(b);
  return text.replace(/^﻿/, "");
}

function table(rows: Discrepancy[]): string {
  if (rows.length === 0) return '<p class="muted">None.</p>';
  const head = "<tr><th>Student</th><th>Name</th><th>Module</th><th>Cmp</th><th>Coursework</th><th>Blackboard</th><th>eVision</th><th>Date</th></tr>";
  const body = rows
    .map(
      (r) =>
        `<tr><td>${esc(r.studentNumber)}</td><td>${esc(r.name)}</td><td>${esc(r.module)}</td><td>${esc(r.componentNumber)}</td><td>${esc(r.courseworkName)}</td><td>${r.blackboardMark ?? ""}</td><td>${r.evisionMark ?? "—"}</td><td>${esc(r.evisionDate)}</td></tr>`,
    )
    .join("");
  return `<table>${head}${body}</table>`;
}

/** Targets used by more than one column within the same module (would double-count). */
function duplicateTargets(mapping: MappingEntry[]): Set<string> {
  const counts = new Map<string, number>();
  for (const m of mapping) {
    if (m.target === "ignore" || m.target === "") continue;
    const key = `${m.module}|${m.target}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k));
}

/** Panel to confirm/override how non-coded Blackboard columns map to eVision components. */
export function renderMappingPanel(
  root: HTMLElement,
  columns: BlackboardColumn[],
  components: EvisionComponent[],
  mapping: MappingEntry[],
  onChange: (next: MappingEntry[]) => void,
): void {
  const kindOf = (id: string) => columns.find((c) => c.columnId === id)?.kind;
  const ambiguous = mapping.filter((m) => kindOf(m.columnId) !== "coded"); // coded are exact
  if (ambiguous.length === 0) {
    root.innerHTML = "";
    return;
  }
  const dups = duplicateTargets(mapping);
  const optionsFor = (module: string, selected: string) => {
    const opts = components
      .filter((c) => c.module === module)
      .map(
        (c) =>
          `<option value="${esc(c.componentNumber)}" ${selected === c.componentNumber ? "selected" : ""}>${esc(c.componentNumber)} — ${esc(c.courseworkName)}</option>`,
      )
      .join("");
    return `<option value="ignore" ${selected === "ignore" ? "selected" : ""}>(ignore)</option>${opts}`;
  };
  const rowFor = (m: MappingEntry) => {
    const kind = kindOf(m.columnId);
    const tag =
      kind === "junk"
        ? '<span class="muted tag"> (junk — ignored)</span>'
        : m.target && m.target !== "ignore"
          ? '<span class="muted tag"> (auto-guessed — check)</span>'
          : '<span class="warn tag"> (unmatched)</span>';
    const dup =
      m.target && m.target !== "ignore" && dups.has(`${m.module}|${m.target}`)
        ? ' <span class="warn">⚠ duplicate target</span>'
        : "";
    return `<tr><td>${esc(m.blackboardLabel)}${tag}</td><td><select data-col="${esc(m.columnId)}">${optionsFor(m.module, m.target || "ignore")}</select>${dup}</td></tr>`;
  };
  root.innerHTML =
    "<h2>Confirm column mapping</h2>" +
    "<table><tr><th>Blackboard column</th><th>Maps to</th></tr>" +
    ambiguous.map(rowFor).join("") +
    "</table>";
  root.querySelectorAll<HTMLSelectElement>("select[data-col]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const next = mapping.map((m) => (m.columnId === sel.dataset.col ? { ...m, target: sel.value } : m));
      onChange(next);
    });
  });
}

const KIND_LABEL: Record<string, string> = {
  different: "differs",
  missing_in_evision: "missing in eVision",
  rounding: "rounding?",
  scale_warning: "scale mismatch",
};

/** Flat table of every compared mark, green when Blackboard and eVision agree, red when not. */
export function renderMarkTable(root: HTMLElement, rows: ComparedMark[]): void {
  if (rows.length === 0) {
    root.innerHTML = "";
    return;
  }
  const sorted = [...rows].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.studentNumber.localeCompare(b.studentNumber) ||
      a.module.localeCompare(b.module) ||
      a.componentNumber.localeCompare(b.componentNumber),
  );
  const agreeCount = rows.filter((r) => r.agree).length;
  const head =
    "<tr><th>Student</th><th>Name</th><th>Module</th><th>Coursework</th><th>Blackboard</th><th>eVision</th></tr>";
  const body = sorted
    .map(
      (r) =>
        `<tr class="${r.agree ? "agree" : "disagree"}"><td>${esc(r.studentNumber)}</td><td>${esc(r.name)}</td><td>${esc(r.module)}</td><td>${esc(r.courseworkName || r.componentNumber)}</td><td>${r.blackboardMark}</td><td>${r.evisionMark ?? "—"}</td></tr>`,
    )
    .join("");
  root.innerHTML = `<h2>Compared marks — ${agreeCount}/${rows.length} agree</h2><table class="marks">${head}${body}</table>`;
}

/** Per-student view: green when all of a scraped student's marks agree, else a table of the mismatches. */
export function renderByStudent(
  root: HTMLElement,
  students: { studentNumber: string; name: string }[],
  discrepancies: Discrepancy[],
  comparedCounts: Map<string, number>,
): void {
  const byStudent = new Map<string, Discrepancy[]>();
  for (const d of discrepancies) {
    const list = byStudent.get(d.studentNumber);
    if (list) list.push(d);
    else byStudent.set(d.studentNumber, [d]);
  }
  const relevant = students.filter((s) => (comparedCounts.get(s.studentNumber) ?? 0) > 0);
  if (relevant.length === 0) {
    root.innerHTML = '<h2>Scraped students</h2><p class="muted">None of the students you scraped are in this Blackboard file.</p>';
    return;
  }
  const okCount = relevant.filter((s) => !(byStudent.get(s.studentNumber)?.length)).length;
  const rows = relevant
    .map((s) => {
      const ds = byStudent.get(s.studentNumber) ?? [];
      const compared = comparedCounts.get(s.studentNumber) ?? 0;
      const who = `${esc(s.studentNumber)} ${esc(s.name)}`;
      if (ds.length === 0) {
        return `<div class="stu ok">✓ ${who} — all ${compared} mark${compared === 1 ? "" : "s"} agree</div>`;
      }
      const head = "<tr><th>Coursework</th><th>Blackboard</th><th>eVision</th><th>Issue</th></tr>";
      const body = ds
        .map(
          (d) =>
            `<tr><td>${esc(d.module)} ${esc(d.componentNumber)} ${esc(d.courseworkName)}</td><td>${d.blackboardMark ?? ""}</td><td>${d.evisionMark ?? "—"}</td><td>${esc(KIND_LABEL[d.kind] ?? d.kind)}</td></tr>`,
        )
        .join("");
      return `<div class="stu bad">✗ ${who} — ${ds.length} to check</div><table>${head}${body}</table>`;
    })
    .join("");
  root.innerHTML = `<h2>Scraped students — ${okCount}/${relevant.length} fully agree</h2>${rows}`;
}

/** Render a report model into a container. Exported for testing. */
export function renderReport(root: HTMLElement, model: ReportModel): void {
  root.innerHTML = `
    <div class="cards">
      <div class="card missing">Missing in eVision<b id="count-missing">${model.counts.missing}</b></div>
      <div class="card different">Different<b id="count-different">${model.counts.different}</b></div>
      <div class="card">Rounding<b id="count-rounding">${model.counts.rounding}</b></div>
      <div class="card">Scale warnings<b id="count-scale">${model.counts.scaleWarning}</b></div>
    </div>
    <h2>Missing marks</h2>${table(model.missing)}
    <h2>Different marks</h2>${table(model.different)}
    <h2>Rounding</h2>${table(model.rounding)}
    <h2>Scale warnings</h2>${table(model.scaleWarnings)}
  `;
}

// ---- page wiring (skipped under jsdom unit test, which only imports renderReport) ----
async function run(text: string): Promise<Discrepancy[]> {
  const scrape = await getScrape();
  const meta = document.getElementById("meta")!;
  if (!scrape) {
    meta.textContent = "No eVision scrape found — run a scrape from the popup first.";
    return [];
  }
  const data = parseBlackboard(text);
  const components = evisionComponents(scrape);
  const mapping = buildMapping(data.columns, components, await getMapping());
  await setMapping(mapping);
  renderMappingPanel(document.getElementById("mapping")!, data.columns, components, mapping, async (next) => {
    await setMapping(next);
    await run(text);
  });
  const { marks } = applyMapping(data, mapping);
  const names = new Map(scrape.students.map((s) => [s.studentNumber, s.name]));
  const discrepancies = compare(scrape, marks, names);
  renderMarkTable(document.getElementById("marks")!, comparedRows(scrape, marks, names));
  meta.textContent = `eVision: ${scrape.students.length} students, ${scrape.marks.length} marks · scraped ${scrape.scrapedAt}`;
  const evNums = new Set(scrape.students.map((s) => s.studentNumber));
  const inBoth = data.rows.filter((r) => evNums.has(r.studentNumber)).length;
  const comparedMarks = marks.filter((m) => evNums.has(m.studentNumber)).length;
  const comparedCounts = new Map<string, number>();
  for (const m of marks) {
    if (evNums.has(m.studentNumber)) comparedCounts.set(m.studentNumber, (comparedCounts.get(m.studentNumber) ?? 0) + 1);
  }
  renderByStudent(document.getElementById("bystudent")!, scrape.students, discrepancies, comparedCounts);
  const summaryEl = document.getElementById("summary");
  if (summaryEl) {
    let s =
      `Blackboard: ${data.rows.length} students, ${data.columns.length} mark columns. ` +
      `${inBoth} scraped &amp; compared, ${data.rows.length - inBoth} not in your scrape (not scraped yet, or outside your eVision access). ` +
      `Compared ${comparedMarks} marks: <b>${comparedMarks - discrepancies.length} agreed</b>, ${discrepancies.length} flagged below.`;
    if (inBoth === 0 && data.rows.length > 0 && scrape.students.length > 0) {
      s += `<br><span class="warn">No student numbers matched — eVision example: ${esc(scrape.students[0].studentNumber)}, Blackboard example: ${esc(data.rows[0].studentNumber)}.</span>`;
    }
    summaryEl.innerHTML = s;
  }
  const fail = document.getElementById("failures");
  if (fail) {
    fail.innerHTML = scrape.failures.length
      ? `<p class="muted">⚠ ${scrape.failures.length} student page(s) failed to scrape and are NOT compared (nothing hidden): ` +
        esc(scrape.failures.map((f) => f.studentNumber ?? f.reason).join(", ")) +
        `</p>`
      : "";
  }
  renderReport(document.getElementById("report")!, buildReport(discrepancies));
  return discrepancies;
}

const fileInput = document.getElementById("file") as HTMLInputElement | null;
if (fileInput) {
  let current: Discrepancy[] = [];
  const exportBtn = document.getElementById("export") as HTMLButtonElement;
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const meta = document.getElementById("meta")!;
      try {
        current = await run(decodeFile(reader.result as ArrayBuffer));
        exportBtn.disabled = current.length === 0;
      } catch (e) {
        meta.textContent = "Could not read that CSV: " + (e instanceof Error ? e.message : String(e));
        meta.className = "warn";
        current = [];
        exportBtn.disabled = true;
      }
    };
    reader.readAsArrayBuffer(f);
  });
  exportBtn.addEventListener("click", () => {
    const blob = new Blob([toCsv(current)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "discrepancies.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  document.getElementById("clear")!.addEventListener("click", async () => {
    await clearAll();
    location.reload();
  });
}
