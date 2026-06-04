# markcheck

**Catch marking-record errors before they count.** `markcheck` is a browser
extension that compares the marks your students have in **eVision** against the
marks in your **Blackboard** grade centre, and shows you — student by student,
coursework by coursework — exactly where the two disagree. **Green where they
agree, red where they don't.**

Everything runs locally in your own browser. **No student data is ever sent to any
server.**

---

## Why

Coursework and exam marks usually start life in Blackboard and are then transcribed
into eVision (the official student record) by hand. Hand-transcription means typos,
missed entries, and rows that quietly drift out of sync — exactly the things a
moderator is supposed to catch. Doing that by eye, across dozens of students and
several components each, is slow and easy to get wrong.

markcheck does the cross-check for you in a couple of minutes, and tells you the two
things that matter: **marks that are missing from eVision**, and **marks that
differ** between the two systems.

## What it does

1. **Scrapes eVision** — in your own logged-in browser session, it walks the student
   list and reads each student's Modules-and-Marks table. It can only ever see the
   students *you* are allowed to see in eVision (see [Access](#access), below).
2. **Reads your Blackboard CSV** — a standard *Full Grade Centre → Download* export.
3. **Compares them** — matching students by student number and assessments by their
   position/name within each module — and shows a per-student, colour-coded table.
4. **Exports discrepancies** as a CSV for your moderation paperwork.

## Privacy by design (GDPR)

This was the first requirement, not an afterthought:

- **No server.** The extension has no backend. The only network traffic is your own
  browser talking to eVision while you scrape. Your students' marks never leave your
  machine.
- **Minimal permissions.** It requests access to the **eVision site only**, plus
  local browser storage. No `<all_urls>`, no analytics, no remote code.
- **It inherits your eVision access** — it never escalates. If eVision won't show you
  a student, neither will markcheck.
- **One-click wipe.** *Clear all local data* removes every scraped mark and saved
  setting from your browser.
- **Auditable.** The source is public, so all of the above can be verified.

## Install

There are two ways to install it. **Option A needs no coding** and is identical on
**Windows, macOS, and Linux**. (A one-click Web Store version may come later.)

### Option A — Download the ready-made extension (easiest)

1. Go to the **[Releases page](https://github.com/CBirkbeck/markcheck/releases)** and,
   under the latest release, download **`markcheck.zip`**.
2. **Unzip it** somewhere you'll keep it — *don't delete the folder afterwards*, because
   the browser loads the extension directly from it:
   - **Windows:** right-click `markcheck.zip` → **Extract All…** → choose a folder (e.g.
     your Documents) → **Extract**.
   - **macOS:** double-click `markcheck.zip` — it unzips into a folder next to it.
   - **Linux:** right-click → **Extract Here**, or run `unzip markcheck.zip` in a terminal.

   You'll end up with a folder that contains a file called **`manifest.json`**.
3. Open your browser's extensions page — type one of these into the address bar and press
   **Enter**:
   - **Chrome:** `chrome://extensions`
   - **Edge:** `edge://extensions`
   - **Brave:** `brave://extensions`
4. Turn on **Developer mode** — a switch in the **top-right** corner (Chrome/Brave) or in
   the **left-hand sidebar** (Edge).
5. Click **Load unpacked**, then select the **folder you unzipped in step 2** (the one
   containing `manifest.json`) and confirm with **Select Folder / Open**.
6. Done — the **markcheck** icon appears in your toolbar. If you don't see it, click the
   **puzzle-piece** icon in the toolbar and **pin** markcheck.

> **A couple of normal things you may notice:**
> - Loaded this way (Developer mode), the browser may show a small reminder about
>   developer extensions on start-up. That's expected for extensions not yet on the Web
>   Store — it's safe to dismiss, and you can keep markcheck enabled.
> - **To update later:** download the newer `markcheck.zip`, unzip it over the same folder,
>   then click the **↻ reload** icon on the markcheck card in the extensions page.

### Option B — Build it from the source

Choose this if you want to change something — most commonly the **eVision web address**
for a different university (it's set in `src/manifest.ts`).

1. **Install Node.js** (version 18 or newer). Download the **LTS** installer from
   **[nodejs.org](https://nodejs.org)**:
   - **Windows / macOS:** run the downloaded installer and click through it.
   - **Linux (Debian/Ubuntu):** `sudo apt install nodejs npm` — or use the installer from
     nodejs.org.

   To check it worked, open a terminal — **Command Prompt** or **PowerShell** on Windows,
   **Terminal** on macOS/Linux — and run `node --version`; it should print a version number.
2. **Get the code:** click the green **Code** button on this page → **Download ZIP**, then
   unzip it. (Or, with git: `git clone https://github.com/CBirkbeck/markcheck.git`.)
3. **Open a terminal in that folder** and run:
   ```bash
   npm install
   npm run build
   ```
   This creates a **`dist`** folder.
4. Load the **`dist`** folder using **Load unpacked**, exactly as in steps 3–6 of Option A.

Works in Chrome, Edge, and Brave (all Chromium-based).

## Use

1. **Log into eVision** and open the **student list** for your cohort/module.
2. Click the **markcheck** icon → **Start scrape**. You can then click away — progress
   shows as a **count on the toolbar icon** (blue while running, green when done). It
   walks every student, skipping the ones you can't access and capturing the rest.
   It saves as it goes, so nothing is lost if you stop or your session times out
   (just press **Start** again to resume).
   - *Just want one student?* Open their Modules-and-Marks page and use **Scrape this
     page** instead.
3. Click **Open results** and choose your **Blackboard CSV**.
4. You'll see a **per-student table** of every compared mark — **green = agree**,
   **red = differ** — plus a summary of what's missing or different. **Export
   discrepancies CSV** saves a copy.
5. **Clear all local data** wipes everything when you're done.

## How it matches marks

- **Students** are matched on **student number** (eVision's "Student Code", with the
  `/occurrence` suffix stripped, equals Blackboard's "Student ID").
- **Assessments** are matched by their **position within each module** — which lines
  up with Blackboard's `{001}` / `{003}` coded columns. eVision doesn't expose a
  sequence number directly, so position is used as the SITS-sequence proxy.
- **Ambiguous columns** (a Blackboard column with a free-text name and no code) are
  shown in a **mapping panel** where you confirm or correct which eVision component
  they map to. Your choices are remembered.
- **Marks** are compared exactly; a gap under 1 is flagged as a possible *rounding*
  difference, and a blank/"Needs Grading" in Blackboard counts as *no mark*, never 0.
- markcheck compares against eVision's **Provisional** mark (the one a marker keys in),
  falling back to the Confirmed mark if Provisional is blank.

## Access

The extension only ever reads students you can already open in eVision:

- An **adviser** sees their own advisees → markcheck checks just those.
- A **module organiser** (full access to the cohort) → markcheck checks the whole
  module.

So a full-module check is run by whoever has full access to that module. A partial
view never produces false "missing" results — only students you actually scraped are
compared.

## Limitations

- **It walks the whole list.** If you can only access a few students out of hundreds,
  the scrape still loads each student's page to check access (skipping the rest
  quickly) — a few hundred students takes ~10–20 minutes.
- **Resume re-walks.** If a scrape is interrupted, resuming starts from your captured
  count and re-skips the inaccessible students before continuing.
- **One institution's eVision.** Selectors and the multi-step navigation
  (Details → Modules and Marks → Submit → table → Back) are tuned to UEA's SITS/eVision;
  a different instance may need the selectors in `src/content/content.ts` adjusted.
- **First-attempt marks only**, and a module retaken in two years is matched by code
  alone.

## For developers

```bash
npm install
npm test          # unit tests (Vitest) — the pure comparison logic
npm run typecheck
npm run build     # outputs dist/ — load unpacked in chrome://extensions
```

### Architecture

The trustworthy core is **pure, unit-tested TypeScript** with no browser
dependencies, wrapped in a thin Manifest V3 extension:

```
src/
  lib/              ← pure logic, fully unit-tested
    blackboard.ts     parse the Blackboard CSV (handles UTF-16, odd headers)
    evision-parse.ts  parse the eVision marks grid + student identity
    mapping.ts        match Blackboard columns to eVision components
    compare.ts        the comparison rules (missing / different / rounding / scale)
    report.ts         report model + discrepancies CSV
    storage.ts        chrome.storage wrapper
  content/          ← content script: reads eVision pages, drives navigation
  background/       ← service worker: orchestrates the per-student crawl
  popup/            ← toolbar popup (start / stop / progress)
  results/          ← results page (load CSV, compare, colour-coded tables)
docs/superpowers/   ← the design spec and the task-by-task build plan
```

The design spec (`docs/superpowers/specs/`) and the implementation plan
(`docs/superpowers/plans/`) document how and why it's built the way it is.

### Tech

Manifest V3 · TypeScript · Vite (`@crxjs`) · Vitest · PapaParse · node-html-parser.

## Contributing

Issues and PRs welcome — especially selector/navigation tweaks for other institutions'
SITS/eVision instances. Please keep student data out of the repo (the `.gitignore`
already excludes CSVs and scraped data; test fixtures use fabricated data only).
