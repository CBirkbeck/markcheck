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
      [x.studentNumber, x.name, x.module, x.componentNumber, x.courseworkName, x.blackboardMark, x.evisionMark, x.kind, x.evisionDate]
        .map(esc)
        .join(","),
    );
  }
  return lines.join("\r\n"); // CRLF per RFC 4180 — safest for Excel/Numbers
}
