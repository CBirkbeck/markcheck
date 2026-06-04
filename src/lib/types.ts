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
  componentNumber: string; // SITS component number
  courseworkName: string;
  blackboardMark: number | null;
  evisionMark: number | null;
  evisionDate?: string;
  kind: DiscrepancyKind;
}

/** One Blackboard mark compared against eVision (agree = both present and exactly equal). */
export interface ComparedMark {
  studentNumber: string;
  name: string;
  module: string;
  componentNumber: string;
  courseworkName: string;
  blackboardMark: number;
  evisionMark: number | null;
  agree: boolean;
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
