import { describe, it, expect } from "vitest";
import { buildMapping, applyMapping, evisionComponents } from "../src/lib/mapping";
import type { BlackboardColumn, BlackboardData, EvisionComponent, ScrapeResult } from "../src/lib/types";

describe("evisionComponents", () => {
  it("returns distinct (module, component) pairs, first courseworkName wins, skips component-less marks", () => {
    const scrape: ScrapeResult = {
      students: [],
      failures: [],
      scrapedAt: "2026-06-02T00:00:00Z",
      marks: [
        { studentNumber: "1", module: "M", componentNumber: "001", courseworkName: "CW1", mark: 60 },
        { studentNumber: "2", module: "M", componentNumber: "001", courseworkName: "CW1-alt", mark: 70 },
        { studentNumber: "1", module: "M", componentNumber: "002", courseworkName: "CW2", mark: 55 },
        { studentNumber: "3", module: "M", courseworkName: "no-component", mark: 40 },
      ],
    };
    expect(evisionComponents(scrape)).toEqual([
      { module: "M", componentNumber: "001", courseworkName: "CW1" },
      { module: "M", componentNumber: "002", courseworkName: "CW2" },
    ]);
  });
});

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
