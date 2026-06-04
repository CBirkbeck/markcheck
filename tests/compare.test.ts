import { describe, it, expect } from "vitest";
import { compare, comparedRows } from "../src/lib/compare";
import type { ScrapeResult, NormalizedMark } from "../src/lib/types";

function scrapeWith(
  marks: Partial<NormalizedMark & { courseworkName: string; date: string }>[],
  studentNumbers: string[] = ["1"],
): ScrapeResult {
  return {
    students: studentNumbers.map((n) => ({ studentNumber: n, name: n })),
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
  it("scale_warning takes precedence even when the raw marks are equal", () => {
    const out = compare(
      scrapeWith([{ studentNumber: "1", module: "M", componentNumber: "001", mark: 40, maxPoints: 100 }]),
      [{ studentNumber: "1", module: "M", componentNumber: "001", mark: 40, maxPoints: 40 }],
      names,
    );
    expect(out[0].kind).toBe("scale_warning");
  });
  it("emits a discrepancy per scraped Blackboard student, including one with no eVision mark", () => {
    const out = compare(
      scrapeWith([{ studentNumber: "1", module: "M", componentNumber: "001", mark: 60 }], ["1", "2"]),
      [
        { studentNumber: "1", module: "M", componentNumber: "001", mark: 50, maxPoints: 100 },
        { studentNumber: "2", module: "M", componentNumber: "001", mark: 55, maxPoints: 100 },
      ],
      new Map([["1", "Alice"], ["2", "Bob"]]),
    );
    expect(out.length).toBe(2);
    expect(out.find((d) => d.studentNumber === "1")?.kind).toBe("different");
    expect(out.find((d) => d.studentNumber === "2")?.kind).toBe("missing_in_evision");
  });
  it("skips Blackboard marks for students that were not scraped", () => {
    const out = compare(
      scrapeWith([], ["1"]),
      [{ studentNumber: "9", module: "M", componentNumber: "001", mark: 50, maxPoints: 100 }],
      new Map(),
    );
    expect(out).toEqual([]);
  });
});

describe("comparedRows", () => {
  it("returns every scraped student's marks with an agree flag, skipping un-scraped students", () => {
    const scrape = scrapeWith(
      [
        { studentNumber: "1", module: "M", componentNumber: "001", mark: 65 },
        { studentNumber: "1", module: "M", componentNumber: "002", mark: 70 },
      ],
      ["1"],
    );
    const bb = [
      { studentNumber: "1", module: "M", componentNumber: "001", mark: 65, maxPoints: 100 }, // agree
      { studentNumber: "1", module: "M", componentNumber: "002", mark: 55, maxPoints: 100 }, // differ
      { studentNumber: "9", module: "M", componentNumber: "001", mark: 50, maxPoints: 100 }, // not scraped
    ];
    const rows = comparedRows(scrape, bb, names);
    expect(rows.length).toBe(2); // student 9 skipped
    expect(rows.find((r) => r.componentNumber === "001")?.agree).toBe(true);
    expect(rows.find((r) => r.componentNumber === "002")?.agree).toBe(false);
  });
});
