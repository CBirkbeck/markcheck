import { describe, it, expect } from "vitest";
import { buildReport, toCsv } from "../src/lib/report";
import type { Discrepancy } from "../src/lib/types";

const d = (kind: Discrepancy["kind"], over: Partial<Discrepancy> = {}): Discrepancy => ({
  studentNumber: "1", name: "Alice", module: "M", componentNumber: "001", courseworkName: "CW1",
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
