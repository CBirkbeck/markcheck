import { describe, it, expect } from "vitest";
import { parseEvisionTable, parseEvisionStudent } from "../src/lib/evision-parse";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(
  fileURLToPath(new URL("./fixtures/evision-table-sample.html", import.meta.url)),
  "utf8",
);

describe("parseEvisionTable (nested eVision module-results grid)", () => {
  const marks = parseEvisionTable(html);

  it("extracts one record per component that has a mark (skips year rows and no-mark components)", () => {
    expect(marks.length).toBe(4);
  });

  it("numbers components by 1-based position within each module, zero-padded", () => {
    const m1 = marks.filter((m) => m.module === "TEST1001A");
    expect(m1.map((m) => m.componentNumber)).toEqual(["001", "002", "003"]);
  });

  it("reads module code, component name, due date, and provisional mark", () => {
    expect(marks[0]).toMatchObject({
      module: "TEST1001A",
      componentNumber: "001",
      courseworkName: "Coursework 001 - Intro",
      date: "10 Oct 25",
      mark: 72,
      maxPoints: 100,
    });
  });

  it("falls back to the confirmed mark and skips components with neither mark", () => {
    expect(marks.find((m) => m.courseworkName === "Group Project")?.mark).toBe(80);
    expect(marks.some((m) => m.courseworkName === "Final Exam")).toBe(false);
  });

  it("position counts no-mark components too (Examination is 003, not 002-after-skip)", () => {
    expect(marks.find((m) => m.courseworkName === "Examination")?.componentNumber).toBe("003");
  });

  it("accepts hyphenated module codes like CMP-5046B", () => {
    const one = parseEvisionTable(
      '<table summary="Module results grid"><tbody>' +
        "<tr><td>CMP-5046B<br><i>SEM2</i></td><td>X</td><td>20</td><td>" +
        '<table summary="attempt 1 results"><tbody>' +
        "<tr><th>Att</th><th>Component Name</th><th>Weight</th><th>Due Date</th><th>Rec'd Date</th><th>Prov. Mark</th><th>Prov. Grade</th><th>Conf. Mark</th><th>Conf. Grade</th></tr>" +
        "<tr><td>1</td><td>Test</td><td>100 / 100</td><td>01 Jan 26</td><td></td><td>50.00</td><td>P</td><td></td><td></td></tr>" +
        "</tbody></table></td><td></td><td></td><td></td><td></td></tr></tbody></table>",
    );
    expect(one[0].module).toBe("CMP-5046B");
  });

  it("ignores reassessment rows (Att != 1) without shifting component positions", () => {
    const out = parseEvisionTable(
      '<table summary="Module results grid"><tbody>' +
        "<tr><td>TST1001A<br><i>SEM1</i></td><td>X</td><td>20</td><td>" +
        '<table summary="attempt 1 results"><tbody>' +
        "<tr><th>Att</th><th>Component Name</th><th>Weight</th><th>Due Date</th><th>Rec'd Date</th><th>Prov. Mark</th><th>Prov. Grade</th><th>Conf. Mark</th><th>Conf. Grade</th></tr>" +
        "<tr><td>1</td><td>CW1</td><td>50 / 100</td><td>01 Jan 26</td><td></td><td>60.00</td><td>P</td><td></td><td></td></tr>" +
        "<tr><td>1</td><td>Exam</td><td>50 / 100</td><td></td><td></td><td>70.00</td><td>P</td><td></td><td></td></tr>" +
        "<tr><td>2</td><td>CW1 Resit</td><td>50 / 100</td><td></td><td></td><td>40.00</td><td>P</td><td></td><td></td></tr>" +
        "</tbody></table></td><td></td><td></td><td></td><td></td></tr></tbody></table>",
    );
    expect(out.map((m) => m.courseworkName)).toEqual(["CW1", "Exam"]);
    expect(out.find((m) => m.courseworkName === "Exam")?.componentNumber).toBe("002");
  });
});

describe("parseEvisionStudent", () => {
  it("reads the student number (dropping the /occurrence suffix) and the name", () => {
    const html =
      '<p class="sitsmessagecontent"><b>Student Code:</b> 123456789/1<br><br><b>Student Name:</b> Test Student<br><br></p>';
    expect(parseEvisionStudent(html)).toEqual({ studentNumber: "123456789", name: "Test Student" });
  });

  it("returns empty strings when the block is missing", () => {
    expect(parseEvisionStudent("<p>nothing here</p>")).toEqual({ studentNumber: "", name: "" });
  });
});
