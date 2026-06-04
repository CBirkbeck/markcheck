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
  // Loose two-way substring match: a best-effort guess only — the user confirms
  // or overrides named-column mappings in the results page.
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
