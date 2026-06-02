# markcheck — eVision ↔ Blackboard Mark Checker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Manifest V3 browser extension that scrapes student marks from eVision in the user's own logged-in session, compares them against a Blackboard CSV, and reports missing and differing marks — entirely in the browser, sending nothing to any server.

**Architecture:** A pure-TypeScript core library (parse Blackboard, classify/map columns, compare, build report, parse the eVision table) is built and unit-tested first with synthetic fixtures. It is then wrapped in an MV3 extension: a content script scrapes eVision per-student, a background service worker drives the crawl and persists progress to `chrome.storage.local`, a popup controls it, and a bundled results page runs the comparison and renders the report.

**Tech Stack:** TypeScript, Vite + `@crxjs/vite-plugin` (MV3), Vitest (+ jsdom), PapaParse (CSV), node-html-parser (HTML parsing, works in Node and bundled in the content script).

**Spec:** `docs/superpowers/specs/2026-06-02-evision-blackboard-mark-checker-design.md`

---

## File Structure

```
markcheck/
  package.json
  tsconfig.json
  vite.config.ts            Vite + @crxjs build; Vitest config
  .gitignore                node_modules, dist, and ANY local data
  README.md
  src/
    manifest.ts             MV3 manifest (permissions: storage, scripting, eVision host only)
    lib/
      types.ts              All shared types
      blackboard.ts         parseColumnHeader, parseMark, parseBlackboard
      mapping.ts            evisionComponents, buildMapping, applyMapping
      compare.ts            compare() → Discrepancy[]
      report.ts             buildReport(), toCsv()
      evision-parse.ts      parseEvisionTable(html) → marks
      storage.ts            chrome.storage.local wrapper
    content/
      content.ts            injected on eVision: scrape current page, navigation, messaging
    background/
      service-worker.ts     crawl orchestration, pacing, resume, progress
    popup/
      popup.html
      popup.ts
    results/
      results.html
      results.ts            load CSV → pipeline → render; mapping panel; export; clear
      results.css
  tests/
    fixtures/
      blackboard-sample.tsv
      evision-table-sample.html
    blackboard.test.ts
    mapping.test.ts
    compare.test.ts
    report.test.ts
    evision-parse.test.ts
    storage.test.ts
    results-render.test.ts
  docs/superpowers/...
```

**Responsibilities:** `lib/` is pure logic — no `chrome.*`, no DOM globals except via passed-in strings — so it is fully unit-testable in Node. `content/`, `background/`, `popup/`, `results/` are the browser-integration layer and reuse `lib/`. Files that change together (each lib concern) live together; tests mirror lib files.

---

## Phase 1 — Scaffolding

### Task 1: Project scaffold + test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`
- Test: `tests/smoke.test.ts`

- [ ] **Step 1: Create `.gitignore` first (GDPR safeguard — never commit data)**

```
node_modules/
dist/
*.local
# Never commit student data
data/
*.csv
*.tsv
*.xls
*.xlsx
!tests/fixtures/*.tsv
!tests/fixtures/*.csv
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "markcheck",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0-beta.23",
    "@types/chrome": "^0.0.268",
    "jsdom": "^24.0.0",
    "typescript": "^5.4.0",
    "vite": "^5.2.0",
    "vitest": "^1.6.0"
  },
  "dependencies": {
    "node-html-parser": "^6.1.13",
    "papaparse": "^5.4.1",
    "@types/papaparse": "^5.3.14"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["chrome", "vitest/globals"],
    "lib": ["ES2021", "DOM", "DOM.Iterable"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 4: Create `vite.config.ts` (Vitest config lives here for now)**

```ts
import { defineConfig } from "vite";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
});
```

- [ ] **Step 5: Write smoke test `tests/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Install and run**

Run: `npm install && npm test`
Expected: 1 passing test.

- [ ] **Step 7: Commit**

```bash
git add .gitignore package.json package-lock.json tsconfig.json vite.config.ts tests/smoke.test.ts
git commit -m "chore: scaffold markcheck project with vitest"
```

---

## Phase 2 — Core library (pure logic, full TDD)

### Task 2: Shared types

**Files:**
- Create: `src/lib/types.ts`

- [ ] **Step 1: Write `src/lib/types.ts`**

```ts
/** A student identified across both systems. */
export interface Student {
  studentNumber: string;
  name: string;
}

/** One mark for one assessment component, from either source. */
export interface MarkRecord {
  studentNumber: string;
  module: string; // e.g. "MTHA4007B"
  componentNumber?: string; // e.g. "001" (SITS sequence)
  courseworkName: string;
  date?: string; // eVision only; raw display string, context only
  mark: number;
  maxPoints?: number;
}

/** A student/page that failed to scrape. */
export interface ScrapeFailure {
  studentNumber?: string;
  name?: string;
  reason: string;
}

/** The full result of an eVision scrape. */
export interface ScrapeResult {
  students: Student[];
  marks: MarkRecord[];
  failures: ScrapeFailure[];
  scrapedAt: string; // ISO timestamp
}

/** A parsed Blackboard mark-column descriptor (from the header). */
export interface BlackboardColumn {
  columnId: string; // e.g. "337483"
  rawLabel: string;
  module?: string; // e.g. "MTHA4007B"
  componentNumber?: string; // e.g. "001"
  name?: string; // free-text name when present
  maxPoints?: number;
  kind: "coded" | "named" | "junk";
}

/** One student's marks parsed from a Blackboard export. */
export interface BlackboardRow {
  studentNumber: string;
  name: string;
  marks: Record<string, number | null>; // keyed by columnId; null = no mark
}

/** Parsed Blackboard export. */
export interface BlackboardData {
  columns: BlackboardColumn[];
  rows: BlackboardRow[];
}

/** Distinct eVision assessment component. */
export interface EvisionComponent {
  module: string;
  componentNumber: string;
  courseworkName: string;
}

/** User-confirmed mapping from a Blackboard column to an eVision component. */
export interface MappingEntry {
  columnId: string;
  blackboardLabel: string;
  module: string;
  /** target eVision component number, "ignore" to skip, or "" if unresolved */
  target: string;
}

/** Blackboard mark normalised to an eVision (module, component) key. */
export interface NormalizedMark {
  studentNumber: string;
  module: string;
  componentNumber: string;
  mark: number;
  maxPoints?: number;
}

export type DiscrepancyKind =
  | "different"
  | "missing_in_evision"
  | "rounding"
  | "scale_warning";

export interface Discrepancy {
  studentNumber: string;
  name: string;
  module: string;
  component: string; // component number
  courseworkName: string;
  blackboardMark: number | null;
  evisionMark: number | null;
  evisionDate?: string;
  kind: DiscrepancyKind;
}

export interface ReportModel {
  counts: {
    missing: number;
    different: number;
    rounding: number;
    scaleWarning: number;
  };
  missing: Discrepancy[];
  different: Discrepancy[];
  rounding: Discrepancy[];
  scaleWarnings: Discrepancy[];
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add shared types for markcheck core"
```

---

### Task 3: Blackboard header parser

**Files:**
- Create: `src/lib/blackboard.ts`
- Test: `tests/blackboard.test.ts`

- [ ] **Step 1: Write the failing test `tests/blackboard.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseColumnHeader } from "../src/lib/blackboard";

describe("parseColumnHeader", () => {
  it("parses a coded column", () => {
    const c = parseColumnHeader("{001}{MTHA4007B-25-SEM2-B} [Total Pts: 100 Score] |337483");
    expect(c).toEqual({
      columnId: "337483",
      rawLabel: "{001}{MTHA4007B-25-SEM2-B} [Total Pts: 100 Score] |337483",
      module: "MTHA4007B",
      componentNumber: "001",
      maxPoints: 100,
      kind: "coded",
    });
  });

  it("parses a named-only column", () => {
    const c = parseColumnHeader("MTHA4007B Mini Group Project [Total Pts: 100 Score] |378856");
    expect(c?.kind).toBe("named");
    expect(c?.module).toBe("MTHA4007B");
    expect(c?.name).toBe("Mini Group Project");
    expect(c?.componentNumber).toBeUndefined();
    expect(c?.columnId).toBe("378856");
  });

  it("classifies a column with no module code as junk", () => {
    const c = parseColumnHeader("New Assignment [Total Pts: 2 Score] |346905");
    expect(c?.kind).toBe("junk");
    expect(c?.maxPoints).toBe(2);
    expect(c?.module).toBeUndefined();
  });

  it("returns null for non-mark standard columns", () => {
    expect(parseColumnHeader("Student ID")).toBeNull();
    expect(parseColumnHeader("Last Access")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/blackboard.test.ts`
Expected: FAIL — `parseColumnHeader` is not exported.

- [ ] **Step 3: Implement `src/lib/blackboard.ts`**

```ts
import type { BlackboardColumn } from "./types";

const COLUMN_ID_RE = /\|(\d+)\s*$/;
const MAX_PTS_RE = /\[Total Pts:\s*([\d.]+)\s*(?:Score)?\]/i;
const CODED_RE = /^\{(\d+)\}\{([^}]+)\}/;
const MODULE_CODE_RE = /\b([A-Z]{3,4}\d{4,5}[A-Z]?)\b/;

/** Parse one Blackboard header cell. Returns null if it is not a mark column. */
export function parseColumnHeader(raw: string): BlackboardColumn | null {
  const idMatch = raw.match(COLUMN_ID_RE);
  if (!idMatch) return null; // standard columns have no trailing |<id>
  const columnId = idMatch[1];
  const maxMatch = raw.match(MAX_PTS_RE);
  const maxPoints = maxMatch ? Number(maxMatch[1]) : undefined;

  const coded = raw.match(CODED_RE);
  if (coded) {
    const componentNumber = coded[1];
    const moduleOcc = coded[2];
    const module = moduleOcc.match(MODULE_CODE_RE)?.[1] ?? moduleOcc.split("-")[0];
    return { columnId, rawLabel: raw, module, componentNumber, maxPoints, kind: "coded" };
  }

  const namePart = raw.replace(COLUMN_ID_RE, "").replace(MAX_PTS_RE, "").trim();
  const moduleMatch = namePart.match(MODULE_CODE_RE);
  if (moduleMatch) {
    const module = moduleMatch[1];
    const name = namePart.replace(module, "").trim() || namePart;
    return { columnId, rawLabel: raw, module, name, maxPoints, kind: "named" };
  }

  return { columnId, rawLabel: raw, name: namePart, maxPoints, kind: "junk" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/blackboard.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/blackboard.ts tests/blackboard.test.ts
git commit -m "feat: parse Blackboard column headers (coded/named/junk)"
```

---

### Task 4: Blackboard cell + full-file parser

**Files:**
- Modify: `src/lib/blackboard.ts`
- Create: `tests/fixtures/blackboard-sample.tsv`
- Modify: `tests/blackboard.test.ts`

- [ ] **Step 1: Create synthetic fixture `tests/fixtures/blackboard-sample.tsv`** (tab-separated; fake students)

```
Last Name	First Name	Username	Student ID	Last Access	Availability	{001}{MTHA4007B-25-SEM2-B} [Total Pts: 100 Score] |337483	{003}{MTHA4007B-25-SEM2-B} [Total Pts: 100 Score] |337485	New Assignment [Total Pts: 2 Score] |346905	MTHA4007B Mini Group Project [Total Pts: 100 Score] |378856
Smith	Alice	asmith	100200300	2025-05-01	Yes	65	70		55
Jones	Bob	bjones	100200301	2025-05-02	Yes	58	Needs Grading		
Patel	Chetna	cpatel	100200302	2025-05-03	Yes		40		61
```

- [ ] **Step 2: Add failing tests for `parseMark` and `parseBlackboard`**

```ts
import { parseMark, parseBlackboard } from "../src/lib/blackboard";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("parseMark", () => {
  it("reads numbers, treats blanks/non-numeric as null", () => {
    expect(parseMark("67")).toBe(67);
    expect(parseMark("67.5")).toBe(67.5);
    expect(parseMark("")).toBeNull();
    expect(parseMark("Needs Grading")).toBeNull();
    expect(parseMark("-")).toBeNull();
    expect(parseMark(undefined)).toBeNull();
  });
});

describe("parseBlackboard", () => {
  const tsv = readFileSync(
    fileURLToPath(new URL("./fixtures/blackboard-sample.tsv", import.meta.url)),
    "utf8",
  );
  const data = parseBlackboard(tsv);

  it("parses the four mark columns", () => {
    expect(data.columns.map((c) => c.kind)).toEqual(["coded", "coded", "junk", "named"]);
  });

  it("parses students by Student ID with first+last name", () => {
    expect(data.rows.map((r) => r.studentNumber)).toEqual(["100200300", "100200301", "100200302"]);
    expect(data.rows[0].name).toBe("Alice Smith");
  });

  it("reads marks keyed by columnId, blanks as null", () => {
    expect(data.rows[0].marks["337483"]).toBe(65);
    expect(data.rows[1].marks["337485"]).toBeNull(); // "Needs Grading"
    expect(data.rows[2].marks["337483"]).toBeNull(); // blank
    expect(data.rows[2].marks["378856"]).toBe(61);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/blackboard.test.ts`
Expected: FAIL — `parseMark`/`parseBlackboard` not exported.

- [ ] **Step 4: Extend `src/lib/blackboard.ts`**

```ts
import Papa from "papaparse";
import type { BlackboardColumn, BlackboardData, BlackboardRow } from "./types";

// ... keep parseColumnHeader and the regexes above ...

const NON_NUMERIC_RE = /needs grading|in progress|^-$|^n\/a$/i;

export function parseMark(cell: string | undefined): number | null {
  if (cell == null) return null;
  const t = cell.trim();
  if (t === "" || NON_NUMERIC_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function parseBlackboard(text: string): BlackboardData {
  const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
  const grid = parsed.data as string[][];
  if (grid.length === 0) return { columns: [], rows: [] };
  const header = grid[0];

  const columns: BlackboardColumn[] = [];
  const markCols: { index: number; columnId: string }[] = [];
  let idIdx = -1;
  let firstIdx = -1;
  let lastIdx = -1;

  header.forEach((h, i) => {
    const norm = h.trim();
    if (/^student id$/i.test(norm)) idIdx = i;
    else if (/^first name$/i.test(norm)) firstIdx = i;
    else if (/^last name$/i.test(norm)) lastIdx = i;
    const col = parseColumnHeader(norm);
    if (col) {
      columns.push(col);
      markCols.push({ index: i, columnId: col.columnId });
    }
  });

  const rows: BlackboardRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const studentNumber = (cells[idIdx] ?? "").trim();
    if (!studentNumber) continue;
    const first = (cells[firstIdx] ?? "").trim();
    const last = (cells[lastIdx] ?? "").trim();
    const name = `${first} ${last}`.trim();
    const marks: Record<string, number | null> = {};
    for (const { index, columnId } of markCols) marks[columnId] = parseMark(cells[index]);
    rows.push({ studentNumber, name, marks });
  }

  return { columns, rows };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/blackboard.test.ts`
Expected: PASS (all blackboard tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/blackboard.ts tests/blackboard.test.ts tests/fixtures/blackboard-sample.tsv
git commit -m "feat: parse full Blackboard export into students and marks"
```

---

### Task 5: Mapping (classify, build, apply)

**Files:**
- Create: `src/lib/mapping.ts`
- Test: `tests/mapping.test.ts`

- [ ] **Step 1: Write the failing test `tests/mapping.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildMapping, applyMapping } from "../src/lib/mapping";
import type { BlackboardColumn, BlackboardData, EvisionComponent } from "../src/lib/types";

const columns: BlackboardColumn[] = [
  { columnId: "337483", rawLabel: "cw1", module: "MTHA4007B", componentNumber: "001", maxPoints: 100, kind: "coded" },
  { columnId: "378856", rawLabel: "mgp", module: "MTHA4007B", name: "Mini Group Project", maxPoints: 100, kind: "named" },
  { columnId: "346905", rawLabel: "junk", name: "New Assignment", maxPoints: 2, kind: "junk" },
];
const components: EvisionComponent[] = [
  { module: "MTHA4007B", componentNumber: "001", courseworkName: "Coursework 1" },
  { module: "MTHA4007B", componentNumber: "002", courseworkName: "Mini Group Project" },
];

describe("buildMapping", () => {
  const map = buildMapping(columns, components);
  it("maps coded columns exactly to their component number", () => {
    expect(map.find((m) => m.columnId === "337483")?.target).toBe("001");
  });
  it("best-guesses named columns by name within the module", () => {
    expect(map.find((m) => m.columnId === "378856")?.target).toBe("002");
  });
  it("marks junk columns ignore", () => {
    expect(map.find((m) => m.columnId === "346905")?.target).toBe("ignore");
  });
  it("preserves an existing user choice over a guess", () => {
    const map2 = buildMapping(columns, components, [
      { columnId: "378856", blackboardLabel: "mgp", module: "MTHA4007B", target: "ignore" },
    ]);
    expect(map2.find((m) => m.columnId === "378856")?.target).toBe("ignore");
  });
});

describe("applyMapping", () => {
  const data: BlackboardData = {
    columns,
    rows: [
      { studentNumber: "1", name: "A", marks: { "337483": 65, "378856": 55, "346905": 1 } },
      { studentNumber: "2", name: "B", marks: { "337483": null, "378856": 61, "346905": null } },
    ],
  };
  it("normalises mapped marks and skips ignored/null", () => {
    const { marks } = applyMapping(data, buildMapping(columns, components));
    // student 1: 001=65, 002=55 ; student 2: 002=61 ; junk ignored ; nulls skipped
    expect(marks).toContainEqual({ studentNumber: "1", module: "MTHA4007B", componentNumber: "001", mark: 65, maxPoints: 100 });
    expect(marks).toContainEqual({ studentNumber: "1", module: "MTHA4007B", componentNumber: "002", mark: 55, maxPoints: 100 });
    expect(marks).toContainEqual({ studentNumber: "2", module: "MTHA4007B", componentNumber: "002", mark: 61, maxPoints: 100 });
    expect(marks.some((m) => m.componentNumber === "001" && m.studentNumber === "2")).toBe(false);
    expect(marks.length).toBe(3);
  });
  it("reports unresolved named columns as unmapped", () => {
    const mapping = buildMapping(columns, []); // no eVision components → named can't be guessed
    const { unmapped } = applyMapping(data, mapping);
    expect(unmapped.map((c) => c.columnId)).toContain("378856");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mapping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/mapping.ts`**

```ts
import type {
  BlackboardColumn,
  BlackboardData,
  EvisionComponent,
  MappingEntry,
  NormalizedMark,
  ScrapeResult,
} from "./types";

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Distinct (module, component) pairs present in a scrape. */
export function evisionComponents(scrape: ScrapeResult): EvisionComponent[] {
  const seen = new Map<string, EvisionComponent>();
  for (const m of scrape.marks) {
    if (!m.componentNumber) continue;
    const key = `${m.module}|${m.componentNumber}`;
    if (!seen.has(key)) {
      seen.set(key, { module: m.module, componentNumber: m.componentNumber, courseworkName: m.courseworkName });
    }
  }
  return [...seen.values()];
}

function bestNameGuess(col: BlackboardColumn, components: EvisionComponent[]): string {
  const target = normName(col.name ?? "");
  if (!target) return "";
  const inModule = components.filter((c) => c.module === col.module);
  const exact = inModule.find((c) => normName(c.courseworkName) === target);
  if (exact) return exact.componentNumber;
  const partial = inModule.find(
    (c) => normName(c.courseworkName).includes(target) || target.includes(normName(c.courseworkName)),
  );
  return partial ? partial.componentNumber : "";
}

/** Build a mapping for every column; preserve any existing user choices. */
export function buildMapping(
  columns: BlackboardColumn[],
  components: EvisionComponent[],
  existing: MappingEntry[] = [],
): MappingEntry[] {
  const prior = new Map(existing.map((e) => [e.columnId, e]));
  return columns.map((col) => {
    const kept = prior.get(col.columnId);
    if (kept) return kept;
    if (col.kind === "junk" || !col.module) {
      return { columnId: col.columnId, blackboardLabel: col.rawLabel, module: col.module ?? "", target: "ignore" };
    }
    if (col.kind === "coded" && col.componentNumber) {
      return { columnId: col.columnId, blackboardLabel: col.rawLabel, module: col.module, target: col.componentNumber };
    }
    return { columnId: col.columnId, blackboardLabel: col.rawLabel, module: col.module, target: bestNameGuess(col, components) };
  });
}

/** Turn Blackboard rows into normalised (module, component) marks using the mapping. */
export function applyMapping(
  data: BlackboardData,
  mapping: MappingEntry[],
): { marks: NormalizedMark[]; unmapped: BlackboardColumn[] } {
  const byId = new Map(mapping.map((m) => [m.columnId, m]));
  const marks: NormalizedMark[] = [];
  const unmapped: BlackboardColumn[] = [];
  for (const col of data.columns) {
    const map = byId.get(col.columnId);
    if (!map || map.target === "ignore") continue;
    if (map.target === "") {
      unmapped.push(col);
      continue;
    }
    for (const row of data.rows) {
      const v = row.marks[col.columnId];
      if (v == null) continue;
      marks.push({
        studentNumber: row.studentNumber,
        module: map.module,
        componentNumber: map.target,
        mark: v,
        maxPoints: col.maxPoints,
      });
    }
  }
  return { marks, unmapped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mapping.ts tests/mapping.test.ts
git commit -m "feat: classify, build and apply Blackboard→eVision column mapping"
```

---

### Task 6: Comparator (D1–D5)

**Files:**
- Create: `src/lib/compare.ts`
- Test: `tests/compare.test.ts`

- [ ] **Step 1: Write the failing test `tests/compare.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { compare } from "../src/lib/compare";
import type { ScrapeResult, NormalizedMark } from "../src/lib/types";

function scrapeWith(marks: Partial<NormalizedMark & { courseworkName: string; date: string }>[]): ScrapeResult {
  return {
    students: [],
    failures: [],
    scrapedAt: "2026-06-02T00:00:00Z",
    marks: marks.map((m) => ({
      studentNumber: m.studentNumber!,
      module: m.module!,
      componentNumber: m.componentNumber!,
      courseworkName: m.courseworkName ?? "CW",
      date: m.date,
      mark: m.mark!,
      maxPoints: m.maxPoints,
    })),
  };
}
const names = new Map([["1", "Alice"]]);
const bb = (mark: number, maxPoints = 100): NormalizedMark => ({ studentNumber: "1", module: "M", componentNumber: "001", mark, maxPoints });

describe("compare", () => {
  it("equal marks are not a discrepancy", () => {
    const out = compare(scrapeWith([{ studentNumber: "1", module: "M", componentNumber: "001", mark: 65 }]), [bb(65)], names);
    expect(out).toEqual([]);
  });
  it("different marks → different", () => {
    const out = compare(scrapeWith([{ studentNumber: "1", module: "M", componentNumber: "001", mark: 70 }]), [bb(60)], names);
    expect(out[0].kind).toBe("different");
    expect(out[0].name).toBe("Alice");
  });
  it("gap < 1 → rounding", () => {
    const out = compare(scrapeWith([{ studentNumber: "1", module: "M", componentNumber: "001", mark: 68 }]), [bb(67.5)], names);
    expect(out[0].kind).toBe("rounding");
  });
  it("present in Blackboard, absent in eVision → missing_in_evision", () => {
    const out = compare(scrapeWith([]), [bb(65)], names);
    expect(out[0].kind).toBe("missing_in_evision");
  });
  it("different max points → scale_warning", () => {
    const out = compare(scrapeWith([{ studentNumber: "1", module: "M", componentNumber: "001", mark: 30, maxPoints: 40 }]), [bb(75, 100)], names);
    expect(out[0].kind).toBe("scale_warning");
  });
  it("present in eVision only → ignored", () => {
    const out = compare(scrapeWith([{ studentNumber: "1", module: "M", componentNumber: "001", mark: 65 }]), [], names);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compare.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/compare.ts`**

```ts
import type { Discrepancy, MarkRecord, NormalizedMark, ScrapeResult } from "./types";

const key = (s: string, m: string, c: string) => `${s}|${m}|${c}`;

/**
 * Compare Blackboard (partial) marks against eVision (complete). We iterate the
 * Blackboard marks, so eVision-only marks are naturally ignored (D1).
 */
export function compare(
  scrape: ScrapeResult,
  blackboardMarks: NormalizedMark[],
  nameByNumber: Map<string, string>,
): Discrepancy[] {
  const evIndex = new Map<string, MarkRecord>();
  for (const m of scrape.marks) {
    if (!m.componentNumber) continue;
    evIndex.set(key(m.studentNumber, m.module, m.componentNumber), m);
  }

  const out: Discrepancy[] = [];
  for (const bb of blackboardMarks) {
    const ev = evIndex.get(key(bb.studentNumber, bb.module, bb.componentNumber));
    const base = {
      studentNumber: bb.studentNumber,
      name: nameByNumber.get(bb.studentNumber) ?? "",
      module: bb.module,
      component: bb.componentNumber,
      courseworkName: ev?.courseworkName ?? "",
      blackboardMark: bb.mark,
      evisionMark: ev?.mark ?? null,
      evisionDate: ev?.date,
    };

    if (!ev || ev.mark == null) {
      out.push({ ...base, kind: "missing_in_evision" });
      continue;
    }
    if (bb.maxPoints != null && ev.maxPoints != null && bb.maxPoints !== ev.maxPoints) {
      out.push({ ...base, kind: "scale_warning" });
      continue;
    }
    const diff = Math.abs(bb.mark - ev.mark);
    if (diff === 0) continue;
    out.push({ ...base, kind: diff < 1 ? "rounding" : "different" });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/compare.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/compare.ts tests/compare.test.ts
git commit -m "feat: compare Blackboard vs eVision marks (D1-D5)"
```

---

### Task 7: Report model + CSV

**Files:**
- Create: `src/lib/report.ts`
- Test: `tests/report.test.ts`

- [ ] **Step 1: Write the failing test `tests/report.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildReport, toCsv } from "../src/lib/report";
import type { Discrepancy } from "../src/lib/types";

const d = (kind: Discrepancy["kind"], over: Partial<Discrepancy> = {}): Discrepancy => ({
  studentNumber: "1", name: "Alice", module: "M", component: "001", courseworkName: "CW1",
  blackboardMark: 65, evisionMark: 70, kind, ...over,
});

describe("buildReport", () => {
  const model = buildReport([d("different"), d("missing_in_evision"), d("rounding"), d("scale_warning"), d("different")]);
  it("groups by kind with counts", () => {
    expect(model.counts).toEqual({ missing: 1, different: 2, rounding: 1, scaleWarning: 1 });
    expect(model.different.length).toBe(2);
  });
});

describe("toCsv", () => {
  it("includes a header and escapes commas/quotes", () => {
    const csv = toCsv([d("different", { name: 'Smith, "Al"' })]);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("Student Number");
    expect(lines[1]).toContain('"Smith, ""Al"""');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/report.ts`**

```ts
import type { Discrepancy, ReportModel } from "./types";

export function buildReport(d: Discrepancy[]): ReportModel {
  const by = (k: Discrepancy["kind"]) => d.filter((x) => x.kind === k);
  const missing = by("missing_in_evision");
  const different = by("different");
  const rounding = by("rounding");
  const scaleWarnings = by("scale_warning");
  return {
    counts: {
      missing: missing.length,
      different: different.length,
      rounding: rounding.length,
      scaleWarning: scaleWarnings.length,
    },
    missing,
    different,
    rounding,
    scaleWarnings,
  };
}

const HEADERS = [
  "Student Number", "Name", "Module", "Component", "Coursework",
  "Blackboard Mark", "eVision Mark", "Kind", "eVision Date",
];

function esc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(d: Discrepancy[]): string {
  const lines = [HEADERS.join(",")];
  for (const x of d) {
    lines.push(
      [x.studentNumber, x.name, x.module, x.component, x.courseworkName, x.blackboardMark, x.evisionMark, x.kind, x.evisionDate]
        .map(esc)
        .join(","),
    );
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/report.ts tests/report.test.ts
git commit -m "feat: build report model and discrepancies CSV"
```

---

### Task 8: eVision table parser (provisional — reconciled in Task 11)

**Files:**
- Create: `src/lib/evision-parse.ts`
- Create: `tests/fixtures/evision-table-sample.html`
- Test: `tests/evision-parse.test.ts`

> NOTE: eVision's real HTML is unknown until Task 11. This task builds a
> **header-driven** parser against a plausible synthetic table. Task 11 replaces
> the fixture with sanitised real HTML and adjusts the header keywords so the
> tests stay green.

- [ ] **Step 1: Create synthetic fixture `tests/fixtures/evision-table-sample.html`**

```html
<table id="marks">
  <thead>
    <tr><th>Module</th><th>Seq</th><th>Assessment</th><th>Date</th><th>Mark</th></tr>
  </thead>
  <tbody>
    <tr><td>MTHA4007B Calculus</td><td>001</td><td>Coursework 1</td><td>01-MAR-2025</td><td>65</td></tr>
    <tr><td>MTHA4007B Calculus</td><td>002</td><td>Mini Group Project</td><td>15-APR-2025</td><td>55</td></tr>
    <tr><td>MTHA4007B Calculus</td><td>003</td><td>Coursework 2</td><td>01-MAY-2025</td><td>70</td></tr>
  </tbody>
</table>
```

- [ ] **Step 2: Write the failing test `tests/evision-parse.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseEvisionTable } from "../src/lib/evision-parse";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(
  fileURLToPath(new URL("./fixtures/evision-table-sample.html", import.meta.url)),
  "utf8",
);

describe("parseEvisionTable", () => {
  const marks = parseEvisionTable(html);
  it("extracts one record per assessment row", () => {
    expect(marks.length).toBe(3);
  });
  it("splits the module code and reads component, name, date, mark", () => {
    expect(marks[0]).toMatchObject({
      module: "MTHA4007B",
      componentNumber: "001",
      courseworkName: "Coursework 1",
      date: "01-MAR-2025",
      mark: 65,
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/evision-parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/lib/evision-parse.ts`**

```ts
import { parse } from "node-html-parser";
import type { MarkRecord } from "./types";

const MODULE_CODE_RE = /\b([A-Z]{3,4}\d{4,5}[A-Z]?)\b/;

/**
 * Parse one eVision "modules and marks" table (passed as outerHTML) into marks.
 * Header-driven: locates columns by header keyword, so it tolerates column
 * re-ordering. Adjust the keyword lists in Task 11 to match real eVision.
 */
export function parseEvisionTable(html: string): Omit<MarkRecord, "studentNumber">[] {
  const root = parse(html);
  const table = root.querySelector("table");
  if (!table) return [];

  const headers = table.querySelectorAll("thead th, thead td").map((c) => c.text.trim().toLowerCase());
  const find = (...names: string[]) => headers.findIndex((h) => names.some((n) => h.includes(n)));
  const idx = {
    module: find("module"),
    seq: find("seq", "component", "no."),
    name: find("assessment", "coursework", "element"),
    date: find("date"),
    mark: find("mark", "result", "score", "%"),
  };

  const out: Omit<MarkRecord, "studentNumber">[] = [];
  for (const tr of table.querySelectorAll("tbody tr")) {
    const cells = tr.querySelectorAll("td").map((c) => c.text.trim());
    const moduleCell = idx.module >= 0 ? cells[idx.module] ?? "" : "";
    const module = moduleCell.match(MODULE_CODE_RE)?.[1] ?? moduleCell.split(/\s+/)[0];
    const componentNumber = idx.seq >= 0 ? cells[idx.seq] || undefined : undefined;
    const courseworkName = idx.name >= 0 ? cells[idx.name] ?? "" : "";
    const date = idx.date >= 0 ? cells[idx.date] || undefined : undefined;
    const mark = Number(idx.mark >= 0 ? cells[idx.mark] : "");
    if (!module || !Number.isFinite(mark)) continue;
    out.push({ module, componentNumber, courseworkName, date, mark });
  }
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/evision-parse.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/evision-parse.ts tests/evision-parse.test.ts tests/fixtures/evision-table-sample.html
git commit -m "feat: provisional eVision marks-table parser (header-driven)"
```

---

### Task 9: Storage wrapper

**Files:**
- Create: `src/lib/storage.ts`
- Test: `tests/storage.test.ts`

- [ ] **Step 1: Write the failing test `tests/storage.test.ts`** (with an in-memory `chrome` mock)

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getScrape, setScrape, getMapping, setMapping, clearAll } from "../src/lib/storage";
import type { ScrapeResult } from "../src/lib/types";

function installChromeMock() {
  const store: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, store[k]])),
        set: async (obj: Record<string, unknown>) => Object.assign(store, obj),
        remove: async (keys: string[]) => keys.forEach((k) => delete store[k]),
      },
    },
  };
}

const sample: ScrapeResult = { students: [], marks: [], failures: [], scrapedAt: "2026-06-02T00:00:00Z" };

describe("storage", () => {
  beforeEach(installChromeMock);

  it("round-trips a scrape result", async () => {
    expect(await getScrape()).toBeNull();
    await setScrape(sample);
    expect(await getScrape()).toEqual(sample);
  });

  it("round-trips mapping and clears everything", async () => {
    await setMapping([{ columnId: "1", blackboardLabel: "x", module: "M", target: "001" }]);
    expect((await getMapping()).length).toBe(1);
    await setScrape(sample);
    await clearAll();
    expect(await getScrape()).toBeNull();
    expect(await getMapping()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/storage.ts`**

```ts
import type { MappingEntry, ScrapeResult } from "./types";

const SCRAPE_KEY = "markcheck.scrape";
const MAPPING_KEY = "markcheck.mapping";

export async function getScrape(): Promise<ScrapeResult | null> {
  const r = await chrome.storage.local.get([SCRAPE_KEY]);
  return (r[SCRAPE_KEY] as ScrapeResult) ?? null;
}
export async function setScrape(s: ScrapeResult): Promise<void> {
  await chrome.storage.local.set({ [SCRAPE_KEY]: s });
}
export async function getMapping(): Promise<MappingEntry[]> {
  const r = await chrome.storage.local.get([MAPPING_KEY]);
  return (r[MAPPING_KEY] as MappingEntry[]) ?? [];
}
export async function setMapping(m: MappingEntry[]): Promise<void> {
  await chrome.storage.local.set({ [MAPPING_KEY]: m });
}
export async function clearAll(): Promise<void> {
  await chrome.storage.local.remove([SCRAPE_KEY, MAPPING_KEY]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/storage.ts tests/storage.test.ts
git commit -m "feat: chrome.storage.local wrapper for scrape + mapping"
```

---

## Phase 3 — Extension shell

### Task 10: MV3 manifest + Vite build + minimal popup

**Files:**
- Create: `src/manifest.ts`, `src/popup/popup.html`, `src/popup/popup.ts`
- Modify: `vite.config.ts`

- [ ] **Step 1: Create `src/manifest.ts`** (minimal permissions; eVision host is a placeholder to confirm in Task 11)

```ts
import { defineManifest } from "@crxjs/vite-plugin";

// TODO(Task 11): replace EVISION_MATCH with the real eVision host pattern.
export const EVISION_MATCH = "https://evision.*.ac.uk/*";

export default defineManifest({
  manifest_version: 3,
  name: "markcheck — eVision/Blackboard mark checker",
  version: "0.1.0",
  description: "Compare student marks between eVision and Blackboard, entirely in your browser.",
  permissions: ["storage", "scripting", "tabs"],
  host_permissions: [EVISION_MATCH],
  action: { default_popup: "src/popup/popup.html", default_title: "markcheck" },
  background: { service_worker: "src/background/service-worker.ts", type: "module" },
  content_scripts: [{ matches: [EVISION_MATCH], js: ["src/content/content.ts"], run_at: "document_idle" }],
});
```

- [ ] **Step 2: Update `vite.config.ts` to use @crxjs**

```ts
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: { target: "es2021" },
  test: { globals: true, environment: "node" },
});
```

- [ ] **Step 3: Create a minimal `src/popup/popup.html`**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><style>body{font:13px system-ui;width:260px;padding:12px}</style></head>
  <body>
    <h3>markcheck</h3>
    <p id="status">Loading…</p>
    <script type="module" src="./popup.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: Create a minimal `src/popup/popup.ts`**

```ts
const status = document.getElementById("status")!;
status.textContent = "Extension loaded.";
```

- [ ] **Step 5: Create empty stubs so the manifest references resolve**

Create `src/background/service-worker.ts`:
```ts
// Filled in Task 13.
console.log("markcheck service worker loaded");
```
Create `src/content/content.ts`:
```ts
// Filled in Task 12.
console.log("markcheck content script loaded");
```

- [ ] **Step 6: Build and load unpacked**

Run: `npm run build`
Expected: a `dist/` folder is produced with `manifest.json`.

Then, manually:
1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked**, select the `dist/` folder.
3. Confirm the markcheck icon appears and clicking it shows "Extension loaded."

- [ ] **Step 7: Commit**

```bash
git add src/manifest.ts vite.config.ts src/popup src/background src/content
git commit -m "feat: MV3 manifest, vite build, minimal popup shell"
```

---

### Task 11: Capture & reconcile real eVision DOM (human-in-the-loop)

> This task needs a real eVision session. The operator (Chris) performs the
> capture; the worker then adjusts the parser. Do NOT commit real student data —
> sanitise first.

**Files:**
- Modify: `tests/fixtures/evision-table-sample.html`
- Modify: `src/lib/evision-parse.ts`
- Modify: `src/manifest.ts` (real host), `src/content/content.ts` (selectors, Task 12)

- [ ] **Step 1: Capture the marks table HTML**

Manual (operator): log into eVision, open one student's **details → modules and marks** page. Right-click the marks table → **Inspect**. In DevTools, right-click the `<table>` element → **Copy → Copy outerHTML**. Paste into `tests/fixtures/evision-table-sample.html`.

- [ ] **Step 2: Sanitise the fixture**

Replace every real mark with a fake number and remove any student name/number that appears inside the table. Keep the **structure, header text, and date format** exactly as they are. (Column header text and date format are what the parser depends on — keep them real.)

- [ ] **Step 3: Note the real host + student-page structure**

Manual: record the eVision hostname (e.g. `https://evision.uea.ac.uk/*`) and, in DevTools, the selectors for: the student list rows + their "details" links, the "modules and marks" link, and where the **student number** and **name** appear on the page. Write these into a comment block at the top of `src/content/content.ts` for Task 12.

- [ ] **Step 4: Update the manifest host**

In `src/manifest.ts`, set `EVISION_MATCH` to the real host pattern recorded in Step 3.

- [ ] **Step 5: Re-run the parser test and adjust keywords**

Run: `npx vitest run tests/evision-parse.test.ts`
If it fails, adjust the header keyword lists in `parseEvisionTable` (`find("module")`, `find("seq", ...)`, etc.) and the `MODULE_CODE_RE` if module codes differ, until the test passes against the real header. Update the test's expected `componentNumber`/`courseworkName`/`date` to match the sanitised fixture values.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/evision-table-sample.html src/lib/evision-parse.ts tests/evision-parse.test.ts src/manifest.ts src/content/content.ts
git commit -m "chore: reconcile eVision parser + host with real DOM"
```

---

### Task 12: Content script — scrape current page

**Files:**
- Modify: `src/content/content.ts`

- [ ] **Step 1: Implement `src/content/content.ts`**

> Selectors marked `/* CONFIRM */` come from Task 11 Step 3. Replace them with
> the real ones. The table extraction reuses the tested `parseEvisionTable`.

```ts
import { parseEvisionTable } from "../lib/evision-parse";
import type { MarkRecord } from "../lib/types";

interface PageScrape {
  studentNumber: string;
  name: string;
  marks: Omit<MarkRecord, "studentNumber">[];
}

function textOf(sel: string): string {
  return document.querySelector(sel)?.textContent?.trim() ?? "";
}

/** Extract the student identity + marks from the current modules-and-marks page. */
function scrapeCurrentPage(): PageScrape {
  const studentNumber = textOf("/* CONFIRM */ .student-number").replace(/\s+/g, "");
  const name = textOf("/* CONFIRM */ .student-name");
  const table = document.querySelector("/* CONFIRM */ table#marks");
  const marks = table ? parseEvisionTable(table.outerHTML) : [];
  return { studentNumber, name, marks };
}

/** List the student-detail links on the student-list page. */
function listStudentLinks(): string[] {
  return Array.from(document.querySelectorAll<HTMLAnchorElement>("/* CONFIRM */ a.student-details"))
    .map((a) => a.href);
}

function onLoginPage(): boolean {
  return /login|signin|adfs|sso/i.test(location.href);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "SCRAPE_PAGE") sendResponse(scrapeCurrentPage());
  else if (msg?.type === "LIST_STUDENTS") sendResponse({ links: listStudentLinks() });
  else if (msg?.type === "PING") sendResponse({ onLogin: onLoginPage() });
  return true; // keep the channel open for the async response
});
```

- [ ] **Step 2: Manual verification on a real student page**

Run: `npm run build`, reload the unpacked extension. Open a student's modules-and-marks page. In the eVision tab's DevTools console:
```js
chrome.runtime.sendMessage({ type: "SCRAPE_PAGE" }, console.log)
```
Expected: an object with `studentNumber`, `name`, and a non-empty `marks` array. Adjust the `/* CONFIRM */` selectors until correct.

- [ ] **Step 3: Commit**

```bash
git add src/content/content.ts
git commit -m "feat: content script scrapes student identity + marks table"
```

---

### Task 13: Background service worker — crawl loop

**Files:**
- Modify: `src/background/service-worker.ts`

- [ ] **Step 1: Implement `src/background/service-worker.ts`**

```ts
import { getScrape, setScrape } from "../lib/storage";
import type { MarkRecord, ScrapeResult, Student, ScrapeFailure } from "../lib/types";

const DELAY_MS = 1200; // pacing between students
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let running = false;
let progress = { done: 0, total: 0, current: "" };

async function send<T>(tabId: number, message: unknown): Promise<T> {
  return (await chrome.tabs.sendMessage(tabId, message)) as T;
}

async function navigate(tabId: number, url: string): Promise<void> {
  await chrome.tabs.update(tabId, { url });
  await new Promise<void>((resolve) => {
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function crawl(tabId: number): Promise<void> {
  running = true;
  const existing = (await getScrape()) ?? emptyResult();
  const seen = new Set(existing.students.map((s) => s.studentNumber));

  const { links } = await send<{ links: string[] }>(tabId, { type: "LIST_STUDENTS" });
  progress = { done: 0, total: links.length, current: "" };

  for (const link of links) {
    if (!running) break;
    await navigate(tabId, link);
    const ping = await send<{ onLogin: boolean }>(tabId, { type: "PING" });
    if (ping.onLogin) {
      broadcast({ type: "PAUSED_LOGIN" });
      running = false;
      break;
    }
    try {
      const page = await send<{ studentNumber: string; name: string; marks: Omit<MarkRecord, "studentNumber">[] }>(
        tabId,
        { type: "SCRAPE_PAGE" },
      );
      if (page.studentNumber && !seen.has(page.studentNumber)) {
        seen.add(page.studentNumber);
        existing.students.push({ studentNumber: page.studentNumber, name: page.name } as Student);
        for (const m of page.marks) existing.marks.push({ ...m, studentNumber: page.studentNumber });
      }
    } catch (e) {
      existing.failures.push({ reason: String(e) } as ScrapeFailure);
    }
    existing.scrapedAt = new Date().toISOString();
    await setScrape(existing); // persist incrementally → resume-safe
    progress = { ...progress, done: progress.done + 1 };
    broadcast({ type: "PROGRESS", progress });
    await sleep(DELAY_MS);
  }
  running = false;
  broadcast({ type: "DONE", progress });
}

function broadcast(msg: unknown) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
function emptyResult(): ScrapeResult {
  return { students: [], marks: [], failures: [], scrapedAt: new Date().toISOString() };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "START_SCRAPE") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id != null) crawl(tab.id);
    });
    sendResponse({ ok: true });
  } else if (msg?.type === "STOP_SCRAPE") {
    running = false;
    sendResponse({ ok: true });
  } else if (msg?.type === "GET_PROGRESS") {
    sendResponse({ running, progress });
  }
  return true;
});
```

- [ ] **Step 2: Manual verification**

Build, reload, open the eVision student-list page, then from the popup (next task) or the service-worker console (`chrome://extensions` → "service worker" → console):
```js
chrome.runtime.sendMessage({ type: "START_SCRAPE" })
```
Expected: the tab steps through students; `chrome.storage.local` accumulates `markcheck.scrape`. Re-running skips already-captured students. Confirm pacing (~1.2s) and that a login redirect emits `PAUSED_LOGIN`.

- [ ] **Step 3: Commit**

```bash
git add src/background/service-worker.ts
git commit -m "feat: background crawl loop with pacing, resume, login-pause"
```

---

### Task 14: Popup controls

**Files:**
- Modify: `src/popup/popup.html`, `src/popup/popup.ts`

- [ ] **Step 1: Replace `src/popup/popup.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font: 13px system-ui; width: 280px; padding: 12px; }
      button { font: inherit; padding: 6px 10px; margin-right: 6px; }
      #bar { height: 6px; background: #eee; border-radius: 3px; margin: 8px 0; }
      #fill { height: 6px; background: #3b82f6; border-radius: 3px; width: 0; }
      .warn { color: #b45309; }
    </style>
  </head>
  <body>
    <h3>markcheck</h3>
    <button id="start">Start scrape</button>
    <button id="stop">Stop</button>
    <div id="bar"><div id="fill"></div></div>
    <p id="status">Idle.</p>
    <button id="results">Open results</button>
    <script type="module" src="./popup.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Replace `src/popup/popup.ts`**

```ts
const $ = (id: string) => document.getElementById(id)!;
const status = $("status");
const fill = $("fill") as HTMLDivElement;

function render(p: { done: number; total: number; current: string }, running: boolean, login = false) {
  if (login) {
    status.innerHTML = '<span class="warn">Paused — please log in to eVision, then Start again.</span>';
  } else if (p.total > 0) {
    status.textContent = `${running ? "Scraping" : "Stopped"} ${p.done}/${p.total}`;
    fill.style.width = `${(p.done / p.total) * 100}%`;
  } else {
    status.textContent = running ? "Starting…" : "Idle.";
  }
}

$("start").addEventListener("click", () => chrome.runtime.sendMessage({ type: "START_SCRAPE" }));
$("stop").addEventListener("click", () => chrome.runtime.sendMessage({ type: "STOP_SCRAPE" }));
$("results").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("src/results/results.html") }),
);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "PROGRESS") render(msg.progress, true);
  else if (msg?.type === "DONE") render(msg.progress, false);
  else if (msg?.type === "PAUSED_LOGIN") render({ done: 0, total: 0, current: "" }, false, true);
});

chrome.runtime.sendMessage({ type: "GET_PROGRESS" }, (r) => r && render(r.progress, r.running));
```

- [ ] **Step 3: Manual verification**

Build, reload. Open the eVision student list, click the markcheck icon, click **Start scrape**. Expected: progress bar advances; **Stop** halts; **Open results** opens the results tab (blank until Task 15).

- [ ] **Step 4: Commit**

```bash
git add src/popup/popup.html src/popup/popup.ts
git commit -m "feat: popup with start/stop, progress, open results"
```

---

## Phase 4 — Results page

### Task 15: Results page — load CSV, compare, render

**Files:**
- Create: `src/results/results.html`, `src/results/results.ts`, `src/results/results.css`
- Test: `tests/results-render.test.ts`

- [ ] **Step 1: Write a failing render test `tests/results-render.test.ts`** (jsdom)

```ts
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderReport } from "../src/results/results";
import { buildReport } from "../src/lib/report";
import type { Discrepancy } from "../src/lib/types";

const d = (kind: Discrepancy["kind"]): Discrepancy => ({
  studentNumber: "100200300", name: "Alice Smith", module: "MTHA4007B", component: "001",
  courseworkName: "Coursework 1", blackboardMark: 65, evisionMark: 70, kind,
});

describe("renderReport", () => {
  it("shows missing and different counts and rows", () => {
    const root = document.createElement("div");
    renderReport(root, buildReport([d("missing_in_evision"), d("different")]));
    expect(root.querySelector("#count-missing")?.textContent).toBe("1");
    expect(root.querySelector("#count-different")?.textContent).toBe("1");
    expect(root.textContent).toContain("100200300");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/results-render.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Create `src/results/results.css`**

```css
body { font: 14px system-ui; margin: 24px; max-width: 1000px; }
h1 { font-size: 20px; }
.cards { display: flex; gap: 12px; margin: 16px 0; }
.card { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; min-width: 120px; }
.card b { font-size: 24px; display: block; }
.missing b { color: #dc2626; }
.different b { color: #d97706; }
table { border-collapse: collapse; width: 100%; margin: 10px 0 24px; }
th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
th { background: #f9fafb; }
.controls { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; }
.muted { color: #6b7280; }
```

- [ ] **Step 4: Create `src/results/results.html`**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>markcheck results</title><link rel="stylesheet" href="./results.css" /></head>
  <body>
    <h1>markcheck — comparison</h1>
    <div class="controls">
      <label>Blackboard CSV: <input id="file" type="file" accept=".csv,.tsv,.txt" /></label>
      <button id="export" disabled>Export discrepancies CSV</button>
      <button id="clear">Clear all local data</button>
    </div>
    <p id="meta" class="muted"></p>
    <div id="failures"></div>
    <div id="report"></div>
    <script type="module" src="./results.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `src/results/results.ts`** (export `renderReport` for the test; wire the page)

```ts
import Papa from "papaparse";
import { parseBlackboard } from "../lib/blackboard";
import { evisionComponents, buildMapping, applyMapping } from "../lib/mapping";
import { compare } from "../lib/compare";
import { buildReport, toCsv } from "../lib/report";
import { getScrape, getMapping, setMapping, clearAll } from "../lib/storage";
import type { Discrepancy, ReportModel } from "../lib/types";

function table(rows: Discrepancy[]): string {
  if (rows.length === 0) return '<p class="muted">None.</p>';
  const head = "<tr><th>Student</th><th>Name</th><th>Module</th><th>Cmp</th><th>Coursework</th><th>Blackboard</th><th>eVision</th><th>Date</th></tr>";
  const body = rows
    .map(
      (r) =>
        `<tr><td>${r.studentNumber}</td><td>${r.name}</td><td>${r.module}</td><td>${r.component}</td><td>${r.courseworkName}</td><td>${r.blackboardMark ?? ""}</td><td>${r.evisionMark ?? "—"}</td><td>${r.evisionDate ?? ""}</td></tr>`,
    )
    .join("");
  return `<table>${head}${body}</table>`;
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
  const { marks } = applyMapping(data, mapping);
  const names = new Map(scrape.students.map((s) => [s.studentNumber, s.name]));
  const discrepancies = compare(scrape, marks, names);
  meta.textContent = `eVision: ${scrape.students.length} students, ${scrape.marks.length} marks · scraped ${scrape.scrapedAt}`;
  const fail = document.getElementById("failures");
  if (fail) {
    fail.innerHTML = scrape.failures.length
      ? `<p class="muted">⚠ ${scrape.failures.length} student page(s) failed to scrape and are NOT compared (nothing hidden): ` +
        scrape.failures.map((f) => f.studentNumber ?? f.reason).join(", ") +
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
      current = await run(String(reader.result));
      exportBtn.disabled = current.length === 0;
    };
    reader.readAsText(f);
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
```

- [ ] **Step 6: Run the render test to verify it passes**

Run: `npx vitest run tests/results-render.test.ts`
Expected: PASS.

- [ ] **Step 7: Manual end-to-end check**

Build, reload. After a scrape, open results, choose the synthetic `tests/fixtures/blackboard-sample.tsv` (rename a copy to `.csv` if your file dialog filters it). Expected: cards show counts; Missing/Different tables populate. Export downloads `discrepancies.csv`.

- [ ] **Step 8: Commit**

```bash
git add src/results tests/results-render.test.ts
git commit -m "feat: results page — load CSV, compare, render, export, clear"
```

---

### Task 16: Mapping panel for ambiguous columns

**Files:**
- Modify: `src/results/results.ts`

- [ ] **Step 1: Add a mapping panel that lists unresolved/named columns and lets the user assign a component or ignore**

Add to `src/results/results.ts` (call `renderMappingPanel` inside `run()` before computing marks, and re-run on change):

```ts
import type { BlackboardColumn, EvisionComponent, MappingEntry } from "../lib/types";

function renderMappingPanel(
  root: HTMLElement,
  columns: BlackboardColumn[],
  components: EvisionComponent[],
  mapping: MappingEntry[],
  onChange: (next: MappingEntry[]) => void,
): void {
  const ambiguous = mapping.filter((m) => {
    const col = columns.find((c) => c.columnId === m.columnId);
    return col?.kind !== "coded"; // coded are exact; show named + junk for confirmation
  });
  if (ambiguous.length === 0) {
    root.innerHTML = "";
    return;
  }
  const optionsFor = (module: string, selected: string) => {
    const opts = components
      .filter((c) => c.module === module)
      .map((c) => `<option value="${c.componentNumber}" ${selected === c.componentNumber ? "selected" : ""}>${c.componentNumber} — ${c.courseworkName}</option>`)
      .join("");
    return `<option value="ignore" ${selected === "ignore" ? "selected" : ""}>(ignore)</option>${opts}`;
  };
  root.innerHTML =
    "<h2>Confirm column mapping</h2>" +
    '<table><tr><th>Blackboard column</th><th>Maps to</th></tr>' +
    ambiguous
      .map(
        (m) =>
          `<tr><td>${m.blackboardLabel}</td><td><select data-col="${m.columnId}">${optionsFor(m.module, m.target || "ignore")}</select></td></tr>`,
      )
      .join("") +
    "</table>";
  root.querySelectorAll<HTMLSelectElement>("select[data-col]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const next = mapping.map((m) =>
        m.columnId === sel.dataset.col ? { ...m, target: sel.value } : m,
      );
      onChange(next);
    });
  });
}
```

Then in `run()`, after building `mapping`, render the panel into a `#mapping` div and re-run `run(text)` on change (persisting via `setMapping`). Add `<div id="mapping"></div>` above `<div id="report">` in `results.html`.

- [ ] **Step 2: Wire it in `run()`**

```ts
// inside run(), replace the mapping/marks section:
const mapping = buildMapping(data.columns, components, await getMapping());
await setMapping(mapping);
renderMappingPanel(document.getElementById("mapping")!, data.columns, components, mapping, async (next) => {
  await setMapping(next);
  await run(text); // recompute with the user's choice
});
const { marks } = applyMapping(data, mapping);
```

- [ ] **Step 3: Manual verification**

Build, reload. Load a CSV containing a named-only column (the fixture's "Mini Group Project"). Expected: a "Confirm column mapping" table appears; changing the dropdown re-runs the comparison and the choice persists across reloads.

- [ ] **Step 4: Commit**

```bash
git add src/results/results.ts src/results/results.html
git commit -m "feat: mapping panel to confirm ambiguous columns"
```

---

## Phase 5 — Docs & packaging

### Task 17: README + GDPR notes

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

````markdown
# markcheck

A browser extension that compares student marks between **eVision** and a
**Blackboard** CSV export, and reports **missing** and **differing** marks —
entirely in your browser. No student data ever leaves your machine.

## For colleagues (install)

1. Install from the Chrome/Edge store: _[link added after publishing]_.
2. Log into eVision as normal and open the student list for your module.
3. Click the **markcheck** icon → **Start scrape**. Wait for it to finish.
4. Click **Open results**, choose your Blackboard CSV download, and read the
   Missing / Different tables. **Export discrepancies CSV** saves a copy.
5. **Clear all local data** wipes everything from the browser when you're done.

## Privacy / GDPR

- Processing happens locally in your browser; the extension sends data to **no
  server**. The only network traffic is your own browser loading eVision.
- Permissions are limited to the eVision site and local storage.
- Source is public so the above can be audited.

## For developers

```bash
npm install
npm test          # unit tests (Vitest)
npm run typecheck
npm run build     # outputs dist/ — load unpacked in chrome://extensions
```

See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for
the build plan.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with install + GDPR notes"
```

---

### Task 18: Production build + store package

**Files:**
- Modify: `package.json` (add a zip script)

- [ ] **Step 1: Add a packaging script to `package.json`**

```json
"scripts": {
  "dev": "vite",
  "build": "vite build",
  "package": "vite build && cd dist && zip -r ../markcheck.zip . && cd ..",
  "test": "vitest run",
  "test:watch": "vitest",
  "typecheck": "tsc --noEmit"
}
```

- [ ] **Step 2: Build the package**

Run: `npm run package`
Expected: `markcheck.zip` is produced from `dist/`.

- [ ] **Step 3: Verify the full suite once more**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green; `dist/manifest.json` present.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build: add store packaging script"
```

- [ ] **Step 5: Publishing (manual, operator)**

Create a Chrome Web Store developer account ($5 one-time), upload `markcheck.zip`, fill the listing (justify the `storage`/`scripting`/eVision-host permissions: "compare marks locally; no data leaves the browser"), and submit for review. Repeat on the Edge Add-ons store (free). Add the published links to `README.md`.

---

## Self-Review checklist (for the plan author)

- [ ] **Spec coverage:** scrape (Tasks 12–13), Blackboard parse (3–4), mapping (5, 16), compare D1–D5 (6), missing+different headline (15), report+CSV (7), local-only/permissions (10, 17), resume/pacing/login-pause (13), no-silent-drops (failures captured in 13 + shown in results 15; junk/unmapped surfaced in mapping panel 16), clear-data (15), store distribution (18). ✔
- [ ] **Open questions from spec §18:** browsers (manifest targets Chromium; 18 notes Edge), eVision host+DOM (Task 11), mark scale (compare scale_warning, Task 6). ✔
- [ ] **Type consistency:** `MappingEntry.target` is a string everywhere (`""` unresolved, `"ignore"`, or a component number); `componentNumber` optional on `MarkRecord`; `NormalizedMark.componentNumber` required. ✔
```
