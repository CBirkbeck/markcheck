// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderReport, renderMappingPanel, renderByStudent, renderMarkTable } from "../src/results/results";
import { buildReport } from "../src/lib/report";
import type { BlackboardColumn, ComparedMark, Discrepancy, EvisionComponent, MappingEntry } from "../src/lib/types";

const d = (kind: Discrepancy["kind"]): Discrepancy => ({
  studentNumber: "100200300", name: "Alice Smith", module: "MTHA4007B", componentNumber: "001",
  courseworkName: "Coursework 1", blackboardMark: 65, evisionMark: 70, kind,
});

describe("renderReport", () => {
  it("shows missing and different counts and rows", () => {
    const root = document.createElement("div");
    renderReport(root, buildReport([d("missing_in_evision"), d("different")]));
    expect(root.querySelector("#count-missing")?.textContent).toBe("1");
    expect(root.querySelector("#count-different")?.textContent).toBe("1");
    expect(root.textContent).toContain("100200300");
  });
});

describe("renderMappingPanel", () => {
  const columns: BlackboardColumn[] = [
    { columnId: "1", rawLabel: "cw1", module: "M", componentNumber: "001", kind: "coded" },
    { columnId: "2", rawLabel: "MGP", module: "M", name: "Mini Group Project", kind: "named" },
  ];
  const components: EvisionComponent[] = [
    { module: "M", componentNumber: "001", courseworkName: "CW1" },
    { module: "M", componentNumber: "002", courseworkName: "Mini Group Project" },
  ];

  it("shows only non-coded columns (coded are exact, hidden) with a select each", () => {
    const root = document.createElement("div");
    const mapping: MappingEntry[] = [
      { columnId: "1", blackboardLabel: "cw1", module: "M", target: "001" },
      { columnId: "2", blackboardLabel: "MGP", module: "M", target: "002" },
    ];
    renderMappingPanel(root, columns, components, mapping, () => {});
    expect(root.querySelectorAll("select").length).toBe(1); // only the named column
    expect(root.textContent).toContain("MGP");
  });

  it("warns when two columns map to the same component target", () => {
    const root = document.createElement("div");
    const cols2: BlackboardColumn[] = [
      { columnId: "2", rawLabel: "MGP", module: "M", name: "A", kind: "named" },
      { columnId: "3", rawLabel: "OTHER", module: "M", name: "B", kind: "named" },
    ];
    const mapping: MappingEntry[] = [
      { columnId: "2", blackboardLabel: "MGP", module: "M", target: "002" },
      { columnId: "3", blackboardLabel: "OTHER", module: "M", target: "002" },
    ];
    renderMappingPanel(root, cols2, components, mapping, () => {});
    expect(root.textContent).toContain("duplicate");
  });
});

describe("renderByStudent", () => {
  const students = [{ studentNumber: "1", name: "Alice" }, { studentNumber: "2", name: "Bob" }];
  const compared = new Map([["1", 2], ["2", 3]]);

  it("shows a green row when all of a student's marks agree", () => {
    const root = document.createElement("div");
    renderByStudent(root, students, [], compared);
    expect(root.querySelector(".stu.ok")?.textContent).toContain("Alice");
    expect(root.textContent).toContain("all 2 marks agree");
  });

  it("shows a table of mismatches for a student with discrepancies", () => {
    const root = document.createElement("div");
    const d: Discrepancy = {
      studentNumber: "2", name: "Bob", module: "M", componentNumber: "001",
      courseworkName: "CW1", blackboardMark: 65, evisionMark: 70, kind: "different",
    };
    renderByStudent(root, students, [d], compared);
    expect(root.querySelector(".stu.bad")?.textContent).toContain("Bob");
    expect(root.querySelector("table")).toBeTruthy();
    expect(root.textContent).toContain("CW1");
    expect(root.textContent).toContain("differs");
  });

  it("omits scraped students who aren't in this Blackboard file", () => {
    const root = document.createElement("div");
    renderByStudent(root, students, [], new Map([["1", 1]])); // only student 1 has compared marks
    expect(root.textContent).toContain("Alice");
    expect(root.textContent).not.toContain("Bob");
  });
});

describe("renderMarkTable", () => {
  it("renders agreeing marks green and differing marks red", () => {
    const root = document.createElement("div");
    const rows: ComparedMark[] = [
      { studentNumber: "1", name: "Alice", module: "M", componentNumber: "001", courseworkName: "CW1", blackboardMark: 65, evisionMark: 65, agree: true },
      { studentNumber: "2", name: "Bob", module: "M", componentNumber: "001", courseworkName: "CW1", blackboardMark: 70, evisionMark: 60, agree: false },
    ];
    renderMarkTable(root, rows);
    expect(root.querySelector("tr.agree")?.textContent).toContain("Alice");
    expect(root.querySelector("tr.disagree")?.textContent).toContain("Bob");
    expect(root.textContent).toContain("1/2 agree");
  });
});
