import Papa from "papaparse";
import type { BlackboardColumn, BlackboardData, BlackboardRow } from "./types";

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
    const name = namePart.replace(module, "").replace(/\s+/g, " ").trim() || namePart;
    return { columnId, rawLabel: raw, module, name, maxPoints, kind: "named" };
  }

  return { columnId, rawLabel: raw, name: namePart, maxPoints, kind: "junk" };
}

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

  if (idIdx === -1) {
    throw new Error(
      'No "Student ID" column found — is this an unedited Blackboard Full Grade Centre export?',
    );
  }

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
