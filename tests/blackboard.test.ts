import { describe, it, expect } from "vitest";
import { parseColumnHeader, parseMark, parseBlackboard } from "../src/lib/blackboard";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

  it("extracts a clean name when the module code is embedded mid-label", () => {
    const c = parseColumnHeader("Resit MTHA4007B Essay [Total Pts: 100 Score] |400001");
    expect(c?.kind).toBe("named");
    expect(c?.module).toBe("MTHA4007B");
    expect(c?.name).toBe("Resit Essay");
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

  it("throws a clear error when there is no Student ID column", () => {
    expect(() => parseBlackboard("Last Name\tFirst Name\nSmith\tAlice")).toThrow(/Student ID/);
  });
});
