import { parseEvisionTable, parseEvisionStudent } from "../lib/evision-parse";
import type { MarkRecord } from "../lib/types";

const SEL = {
  details: 'a[alt="Link to student details"]',
  marks: 'a[alt="Link to student marks"]',
  submit: 'button[data-sv-action="RUN_NOW"]',
  table: 'table[summary="Module results grid"]',
  student: "p.sitsmessagecontent",
};

type PageType = "list" | "detail" | "submit" | "marks" | "login" | "other";

function pageType(): PageType {
  if (document.querySelector(SEL.table)) return "marks";
  if (document.querySelector(SEL.submit)) return "submit";
  if (document.querySelector(SEL.marks)) return "detail";
  if (document.querySelector(SEL.details)) return "list";
  if (/log[io]n|signin|adfs|\bsso\b|idp|authenticate/i.test(location.href)) return "login";
  return "other";
}

function scrapeCurrent(): { studentNumber: string; name: string; marks: Omit<MarkRecord, "studentNumber">[] } {
  const tableEl = document.querySelector(SEL.table);
  const studentEl = document.querySelector(SEL.student);
  const marks = tableEl ? parseEvisionTable(tableEl.outerHTML) : [];
  const id = studentEl ? parseEvisionStudent(studentEl.outerHTML) : { studentNumber: "", name: "" };
  return { studentNumber: id.studentNumber, name: id.name, marks };
}

function clickFirst(sel: string): boolean {
  const el = document.querySelector<HTMLElement>(sel);
  if (el) { el.click(); return true; }
  return false;
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  try {
    switch (msg?.type) {
      case "PAGE_TYPE":
        send({ pageType: pageType(), url: location.href });
        break;
      case "LIST_COUNT":
        send({ count: document.querySelectorAll(SEL.details).length });
        break;
      case "CLICK_DETAILS": {
        const links = document.querySelectorAll<HTMLAnchorElement>(SEL.details);
        const a = links[msg.index as number];
        if (a) { a.click(); send({ ok: true }); } else send({ ok: false, reason: "no details link at index " + msg.index });
        break;
      }
      case "CLICK_MARKS":
        send({ ok: clickFirst(SEL.marks) });
        break;
      case "CLICK_SUBMIT":
        send({ ok: clickFirst(SEL.submit) });
        break;
      case "CLICK_BACK":
        send({ ok: true });
        setTimeout(() => history.back(), 0);
        break;
      case "SCRAPE":
        send(scrapeCurrent());
        break;
      default:
        send({ ok: false, reason: "unknown message" });
    }
  } catch (e) {
    send({ ok: false, reason: String(e) });
  }
  return true;
});
