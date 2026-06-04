import { parse, HTMLElement } from "node-html-parser";
import type { MarkRecord } from "./types";

const MODULE_CODE_RE = /([A-Z]{2,4}-?\d{4,5}[A-Z]?)/;

function cellText(el: HTMLElement | null | undefined): string {
  return (el?.text ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Walk up the DOM from `el` until we find an ancestor whose tagName is "TR".
 * Returns null if no such ancestor exists.
 */
function closestRow(el: HTMLElement): HTMLElement | null {
  let n: HTMLElement | null = el.parentNode as HTMLElement | null;
  while (n && (n.tagName ?? "").toUpperCase() !== "TR") {
    n = n.parentNode as HTMLElement | null;
  }
  return n;
}

/**
 * Parse one eVision "Module Results" page (the nested sitstablegrid) into marks.
 *
 * Structure:
 *   outer table[summary="Module results grid"]
 *     └─ tbody > tr  (one per module, plus year-separator rows to skip)
 *          └─ td[3]  (the "Component Results" cell)
 *               └─ inner table[summary="attempt 1 results"]
 *                    └─ tbody > tr  (header row uses <th>; data rows use <td>)
 *
 * Inner table columns (0-based td indices):
 *   0: Att | 1: Component Name | 2: Weight | 3: Due Date | 4: Rec'd Date |
 *   5: Prov. Mark | 6: Prov. Grade | 7: Conf. Mark | 8: Conf. Grade
 *
 * componentNumber = 1-based position within the module, zero-padded to 3 digits.
 * No-mark rows still consume a position counter so subsequent positions are correct.
 * Mark = Provisional (td[5]) falling back to Confirmed (td[7]); skip if neither.
 */
export interface EvisionStudent {
  studentNumber: string;
  name: string;
}

/**
 * Extract the student identity from the eVision page. "Student Code" is shown
 * as "<number>/<occurrence>" (e.g. "123456789/1"); we keep only the number,
 * which is what Blackboard's "Student ID" column holds.
 */
export function parseEvisionStudent(html: string): EvisionStudent {
  const root = parse(html);
  const block = root.querySelector("p.sitsmessagecontent") ?? root;
  const text = (block?.text ?? "").replace(/ /g, " ");
  const studentNumber = text.match(/Student Code:\s*([0-9]+)/i)?.[1] ?? "";
  const name = (text.match(/Student Name:\s*(.+?)\s*$/i)?.[1] ?? "").trim();
  return { studentNumber, name };
}

export function parseEvisionTable(html: string): Omit<MarkRecord, "studentNumber">[] {
  const root = parse(html);
  const outer =
    root.querySelector('table[summary="Module results grid"]') ?? root.querySelector("table");
  if (!outer) return [];

  const out: Omit<MarkRecord, "studentNumber">[] = [];

  // Each inner component table represents one module.
  for (const ct of outer.querySelectorAll("table")) {
    // Walk up from the inner table to find the enclosing module <tr> in the outer table.
    const moduleRow = closestRow(ct);
    if (!moduleRow) continue;

    // Module code lives in the first <td> of the module row (e.g. "TEST1001A\n\nSEM1").
    const module = cellText(moduleRow.querySelector("td")).match(MODULE_CODE_RE)?.[1];
    if (!module) continue;

    let position = 0;
    for (const cr of ct.querySelectorAll("tr")) {
      const tds = cr.querySelectorAll("td");
      if (tds.length < 8) continue; // skip header row (uses <th>, so tds.length === 0)
      if (cellText(tds[0]) !== "1") continue; // first attempt only — ignore reassessment/resit rows
      position += 1;

      // Provisional mark (td[5]) with fallback to Confirmed mark (td[7]).
      const markStr = cellText(tds[5]) || cellText(tds[7]);
      const mark = Number(markStr);
      if (!markStr || !Number.isFinite(mark)) continue; // no mark — skip emission but position already counted

      const date = cellText(tds[3]) || undefined;

      out.push({
        module,
        componentNumber: String(position).padStart(3, "0"),
        courseworkName: cellText(tds[1]),
        date,
        mark,
        maxPoints: 100,
      });
    }
  }
  return out;
}
