import type { ComparedMark, Discrepancy, MarkRecord, NormalizedMark, ScrapeResult } from "./types";

const key = (s: string, m: string, c: string) => `${s}|${m}|${c}`;

/** Every Blackboard mark for a SCRAPED student, paired with its eVision mark and whether they agree. */
export function comparedRows(
  scrape: ScrapeResult,
  blackboardMarks: NormalizedMark[],
  nameByNumber: Map<string, string>,
): ComparedMark[] {
  const scraped = new Set(scrape.students.map((s) => s.studentNumber));
  const evIndex = new Map<string, MarkRecord>();
  for (const m of scrape.marks) {
    if (!m.componentNumber) continue;
    evIndex.set(key(m.studentNumber, m.module, m.componentNumber), m);
  }
  const out: ComparedMark[] = [];
  for (const bb of blackboardMarks) {
    if (!scraped.has(bb.studentNumber)) continue;
    const ev = evIndex.get(key(bb.studentNumber, bb.module, bb.componentNumber));
    out.push({
      studentNumber: bb.studentNumber,
      name: nameByNumber.get(bb.studentNumber) ?? "",
      module: bb.module,
      componentNumber: bb.componentNumber,
      courseworkName: ev?.courseworkName ?? "",
      blackboardMark: bb.mark,
      evisionMark: ev?.mark ?? null,
      agree: ev != null && ev.mark != null && Math.abs(bb.mark - ev.mark) === 0,
    });
  }
  return out;
}

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

  const scraped = new Set(scrape.students.map((s) => s.studentNumber));

  const out: Discrepancy[] = [];
  for (const bb of blackboardMarks) {
    if (!scraped.has(bb.studentNumber)) continue; // student not scraped — no eVision data to compare
    const ev = evIndex.get(key(bb.studentNumber, bb.module, bb.componentNumber));
    const base = {
      studentNumber: bb.studentNumber,
      name: nameByNumber.get(bb.studentNumber) ?? "",
      module: bb.module,
      componentNumber: bb.componentNumber,
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
