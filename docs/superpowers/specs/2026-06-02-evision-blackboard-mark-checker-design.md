# eVision ↔ Blackboard Mark Checker — Design Spec

**Project:** `markcheck` (browser extension)
**Date:** 2026-06-02
**Status:** Approved design — ready for implementation planning

## 1. Summary

A browser extension that helps lecturers catch marking-record errors by comparing
student marks held in **eVision** (the official student-records system — the complete
source) against marks exported from **Blackboard** (a partial source). It scrapes the
marks from eVision inside the user's own logged-in browser session, reads a Blackboard
CSV the user provides, and produces a colour-coded report of the two things that matter:
**marks that are missing** from eVision and **marks that differ** between the two systems.

All processing happens locally in the browser. No student data is ever sent to any
server. This is a hard requirement (GDPR).

## 2. Goals

- **Primary:** surface (a) **missing marks** — present in Blackboard but absent in
  eVision — and (b) **differing marks** — present in both but with different values.
- Match students reliably by **student number**.
- Compare **many components per student** across **multiple modules**.
- Be usable by **several non-technical colleagues** with a one-click install, in their
  normal browser.
- Keep all student data **local to the browser**; send nothing anywhere.

### Non-goals (YAGNI)

- No writing back to eVision — the tool is **read-only** on eVision; it never edits marks.
- No server, backend, database, or hosted processing of student data.
- No credential storage or automated login — the user logs in themselves.
- No computing of weighted/overall module marks — comparison is **component-level**.
- No date comparison — dates are captured for context only.
- Deferred (not now): Firefox/Safari builds; a packaged CLI; a separate hosted results viewer.

## 3. Users & context

- **Operators:** several lecturers / module organisers, likely non-technical, who run the
  check themselves each marking period.
- **Institution:** a single eVision (SITS) instance shared by all users (same DOM/URLs).
- **Trigger:** end of a marking/moderation cycle — verifying that marks transcribed into
  eVision match the Blackboard gradebook.

## 4. Constraints

- **GDPR / local-only:** student data must be processed only in the user's browser; never
  transmitted.
- **eVision is behind SSO + MFA:** no automated login; the user authenticates in their
  normal browser session and the extension scrapes that session.
- **Non-technical operators:** install and use must require no terminal, no GitHub, no
  Python — a store install and a couple of buttons.
- **eVision is complete; Blackboard is partial:** only compare a `(module, component)`
  when it exists in **both**; never flag a discrepancy merely because Blackboard lacks
  something eVision has.

## 5. Architecture

A **Manifest V3 browser extension** (Chrome/Edge primary) with five parts, all running
locally in the operator's browser:

1. **Content script** — injected on eVision pages. The only piece that touches eVision.
   Reads the DOM and performs the per-student crawl inside the user's already-authenticated
   session.
2. **Background service worker** — orchestrates the crawl loop, tracks progress, and
   persists each student's marks to local storage as they are scraped (enables resume;
   survives popup close and session timeout).
3. **Popup** (toolbar button) — Start / Stop the scrape, live progress, and "Open results".
4. **Results page** (bundled extension tab) — load the Blackboard CSV locally, confirm
   ambiguous column mappings, view the report, export the discrepancies CSV, and clear
   local data.
5. **Shared logic library** — pure TypeScript modules (Blackboard parser, mapping,
   comparator, report builder), unit-tested, reused by the results page (and the worker
   where relevant).

## 6. Data model

```
Student        { studentNumber, name }
MarkRecord     { studentNumber, module, componentNumber?, courseworkName, date?, mark, maxPoints? }
ScrapeResult   { students: Student[], marks: MarkRecord[], failures: ScrapeFailure[], scrapedAt }
MappingEntry   { blackboardColumnId, blackboardLabel, module, componentNumber | "ignore" }
Discrepancy    { studentNumber, name, module, component, blackboardMark, evisionMark, kind }
                 kind ∈ { different, missing_in_evision, rounding, scale_warning }
```

Scraped data and mapping config live in `chrome.storage.local`.

## 7. Data flow (entirely in-browser)

```
eVision pages ──content script──▶ chrome.storage.local (ScrapeResult)
Blackboard CSV ──file picker (FileReader)──▶ in memory
mapping (user-confirmed, saved locally) ─┐
ScrapeResult ───────────────────────────┴─▶ compare ─▶ report (HTML) + discrepancies.csv (download)
```

The extension makes no network requests of its own; the only traffic is the user's own
browser loading eVision during a scrape.

## 8. eVision scraping

- **Navigation (per-student crawl):** from the student list, for each student: open
  **details** → **modules and marks** → read the marks table → capture student number +
  name and each `(module, componentNumber?, courseworkName, date, mark, maxPoints?)` row →
  return to the list → next student.
- **Runs in the user's session:** the content script operates in the page where the user
  is already logged in (MFA already cleared). No separate browser, no stored credentials.
- **Pacing:** a short, configurable delay between students to be gentle on the SITS server.
- **Resume:** each student is written to local storage as scraped; re-running skips
  students already captured.
- **Session timeout:** if eVision redirects to login mid-crawl, the crawl pauses and the
  popup prompts the user to re-authenticate, then continues.
- **No silent drops:** any student whose page fails to load or parse is recorded as a
  `ScrapeFailure` and listed in the report.
- **Selectors:** eVision's exact URLs and table HTML are unknown until we inspect the live
  site; we will capture a sanitised sample of the real table during implementation and
  build + unit-test the table-extraction function against it.

## 9. Blackboard parsing

Real exported header (column names only; no student data):

```
Last Name | First Name | Username | Student ID | Last Access | Availability
| {001}{MTHA4007B-25-SEM2-B} [Total Pts: 100 Score] |337483
| {003}{MTHA4007B-25-SEM2-B} [Total Pts: 100 Score] |337485
| New Assignment [Total Pts: 2 Score] |346905
| MTHA4007B Mini Group Project [Total Pts: 100 Score] |378856
```

- **Match key:** the **Student ID** column.
- **Column descriptor parsing:** each mark column is parsed into
  `{ componentNumber?, module?, name, maxPoints, columnId }`:
  - **Coded** — `{001}{MTHA4007B-25-SEM2-B} … |337483` → componentNumber `001`,
    module `MTHA4007B`, maxPoints `100`, columnId `337483`.
  - **Named-only** — `MTHA4007B Mini Group Project … |378856` → module `MTHA4007B`,
    name `Mini Group Project`, no componentNumber.
  - **Junk** — `New Assignment … |346905` → no module/component → skipped by default,
    listed in the report.
- **Delimiter:** Blackboard exports are typically tab-delimited; the parser auto-detects
  tab vs comma and handles quoting.
- **Blank / non-numeric cells** (empty, "Needs Grading", "In Progress", "-") → treated as
  **no mark**, never as 0.

## 10. Matching / mapping strategy (layered)

1. **Coded columns** → exact match to eVision on `(module, componentNumber)`. No guessing.
2. **Named-only columns** → best-guess by module + name, surfaced in the results page for
   the user to **confirm or correct** (assign to an eVision component, or mark "ignore").
   The confirmed mapping is saved in `chrome.storage.local` and reused next time.
3. **Junk columns** → skipped by default, always listed.

The `{00x}` numbers are the SITS assessment sequence numbers, expected to match what
eVision shows — making the common case an exact match.

## 11. Comparison rules (D1–D5)

For each student (by number) and each `(module, component)` present in **both** sources
with numeric marks:

- **D1.** Both present, values differ → **`different`**. Present in Blackboard but **not**
  eVision → **`missing_in_evision`**. Present in eVision but not Blackboard → **ignored**
  (Blackboard is partial).
- **D2.** Exact comparison; an absolute gap **< 1** is classified **`rounding`** (visible
  but separated from true differences).
- **D3.** Dates are **not** compared — shown only to identify the assessment.
- **D4.** Blank / non-numeric Blackboard cell = no mark; never 0.
- **D5.** If max-points differ between systems, the row is marked **`scale_warning`**
  rather than silently compared.

## 12. Report & outputs

- **Headline:** two prominent sections — **Missing marks** and **Different marks** — with
  counts.
- **Secondary:** rounding, scale warnings, skipped/junk columns, unmapped columns, and
  scrape failures — all listed, nothing hidden.
- **Each row:** student number, name, module, component/coursework, Blackboard mark,
  eVision mark, and (for context) the eVision date.
- **Mapping UI:** an inline panel to resolve ambiguous named-only columns.
- **Export:** "Export discrepancies CSV" downloads locally (blob).
- **Clear data:** "Clear all local data" wipes scraped marks + mapping from storage.

## 13. GDPR safeguards

- **Minimal permissions:** `host_permissions` for the eVision origin **only**, plus
  `storage` and `scripting`. No `<all_urls>`, no external hosts, no remote code, no
  analytics.
- **No egress:** the extension makes no network requests of its own; the only traffic is
  the user's browser ↔ eVision during a scrape.
- **User-controlled data:** one-click wipe of all local data.
- **Auditable:** source is public on GitHub, so these claims can be independently verified.

## 14. Distribution

- **Source:** public GitHub repo (`markcheck`).
- **Published to:** Chrome Web Store + Edge Add-ons (both Chromium — one package).
  One-time $5 Chrome developer registration; Edge free.
- **Install for colleagues:** one click ("Add to Chrome/Edge"); auto-updates.
- **Development:** "load unpacked" in developer mode.

## 15. Tech stack

- **Manifest V3**, **TypeScript**, **Vite** with the `@crxjs` MV3 plugin (build/dev only —
  colleagues install the built extension, never the toolchain).
- **PapaParse** (bundled locally) for robust CSV parsing.
- Plain HTML/CSS for the popup and results page — no UI framework.
- **Vitest** for unit tests.

## 16. Repo layout

```
markcheck/
  README.md
  package.json
  vite.config.ts
  src/
    manifest.ts     (or manifest.json) — MV3 manifest + permissions
    content/        eVision scraping (DOM + navigation)
    background/     service worker: crawl orchestration, storage
    popup/          toolbar UI
    results/        results page UI + mapping panel
    lib/            blackboard.ts, mapping.ts, compare.ts, report.ts, types.ts
  tests/            unit tests + synthetic fixtures + sanitised eVision sample
  docs/superpowers/specs/2026-06-02-evision-blackboard-mark-checker-design.md
```

## 17. Testing

- **TDD on pure logic:** Blackboard header parser, mapping classifier, comparator
  (different / missing / rounding / scale / blank handling), report builder — against
  **synthetic fixtures**, never real student data.
- **eVision extraction:** tested against a saved, sanitised HTML sample of the real marks
  table (captured during implementation).
- **End-to-end:** first real run driven by the user, verified by eye, on a real eVision
  session.

## 18. Open questions (to resolve during implementation / spec review)

- **Browsers:** confirm colleagues use Chrome/Edge (Chromium). Firefox is addable later
  (MV3 with minor manifest differences); Safari is out of scope.
- **eVision specifics:** exact hostname / URL pattern and the marks-table DOM structure —
  captured live during implementation.
- **Mark scale:** confirm eVision component marks are on the same 0–100 scale as the
  Blackboard `[Total Pts: 100]` columns; per-component scale differences are handled via
  the `scale_warning` path.

## 19. Out of scope / possible future work

- Firefox and Safari builds.
- A packaged Python CLI for power users.
- Computing weighted/overall module marks and comparing those.
- A separate hosted (GitHub Pages) results viewer.
