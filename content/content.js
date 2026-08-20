/* GOLDmine content script */

(() => {
  "use strict";

  const state = {
    settings: { ratings: true, peek: true, conflicts: true },
    schedule: [],           // [{course, sessions[], units, ...}]
    pending: new Map(),     // prof-key -> Promise (dedupe in-flight lookups)
    scanQueued: false,
    unitCaps: null,         // {pass1: 16, pass2: 24} — read from GOLD, never hardcoded
    currentPass: null,      // 1 | 2 | 3
    goldTrouble: false,
    blindNoted: false,
    dark: false,
    page: detectPage()
  };

  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

  /* Course codes are space-padded in GOLD ("CHEM      1B"), so every code regex
     uses \s* (never \s?) and every capture is normalized before use. */
  const CODE_ANY = /\b([A-Z]{2,6}(?:\s+[A-Z]{1,2})?\s*\d+[A-Z]{0,3})\b/;
  const CODE_AT_START = /^([A-Z]{2,6}(?:\s+[A-Z]{1,2})?\s*\d+[A-Z]{0,3})\b/;

  /* Two-word departments (RG ST 1, INT W 1, ART CS 199) are tried FIRST and
     anchored at the string start. Leaving the second word optional inside one
     alternation lets the engine settle for the shorter parse in some inputs, and
     leaving it unanchored lets a room code ("IV Theatre, THEA2") win outright.
     Two explicit patterns, longest-first, is unambiguous. */
  const CODE_TWO_WORD = /^([A-Z]{2,6}\s+[A-Z]{1,2}\s*\d+[A-Z]{0,3})\b/;
  const CODE_ONE_WORD = /^([A-Z]{2,6}\s*\d+[A-Z]{0,3})\b/;

  function parseCourseCode(text) {
    const t = norm(text);
    const m = t.match(CODE_TWO_WORD) || t.match(CODE_ONE_WORD);
    return m ? norm(m[1]) : null;
  }

  function stripLeadingCode(text, code) {
    const t = norm(text);
    return t.startsWith(code) ? t.slice(code.length).replace(/^\s*[-–]\s*/, "").trim() : t;
  }

  function detectPage() {
    const url = location.href;
    if (/StudentSchedule/i.test(url)) return "schedule";
    if (/RegistrationInfo/i.test(url)) return "info";
    if (/BasicFindCourses|ResultsFindCourses|BasicSkills|SearchResults|CourseSearch|BasicResults/i.test(url)) return "search";
    if (/RegistrationCart|ModifyCart|CartSection|AddStudentSchedule/i.test(url)) return "cart";
    // Fall back to heading text
    const h1 = document.querySelector("h1, h2, .pageHeader")?.textContent || "";
    if (/student schedule|my schedule/i.test(h1)) return "schedule";
    if (/find courses|search results/i.test(h1)) return "search";
    return "other";
  }

  /* ================== SAFE STORAGE (E3) ==================
     Every write goes through here. chrome.storage can both throw synchronously
     (context invalidated after an extension reload) and reject asynchronously
     (quota). Catch both so a storage failure never breaks the page. */

  /* A silent catch here would be the worst kind: the schedule would look saved,
     the peek would quietly show stale data forever, and nothing would say why.
     Swallow the exception (the page must not break) but raise it to the student. */
  function safeLocalSet(obj) {
    try {
      const p = chrome.storage.local.set(obj);
      if (p && typeof p.catch === "function") p.catch(noteStorageTrouble);
    } catch (e) { noteStorageTrouble(e); }
  }

  async function safeLocalGet(defaults) {
    try { return await chrome.storage.local.get(defaults); }
    catch { return { ...defaults }; }
  }

  async function safeSyncGet(defaults) {
    try { return await chrome.storage.sync.get(defaults); }
    catch { return { ...defaults }; }
  }

  /* UNAVAILABLE is not null. "We asked and there are no ratings" and "we never
     got to ask" are different facts, and showing the first when the second is
     true is a claim we can't back up. */
  const UNAVAILABLE = { error: "unavailable" };

  function safeSend(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      return p && typeof p.catch === "function" ? p.catch(() => UNAVAILABLE) : Promise.resolve(p);
    } catch { return Promise.resolve(UNAVAILABLE); }
  }

  /* ================== BOOT ================== */

  async function boot() {
    state.settings = await safeSyncGet({ ratings: true, peek: true, conflicts: true });

    const saved = await safeLocalGet({ savedSchedule: [], unitCaps: null, currentPass: null, scheduleCapturedAt: 0, darkMode: false });
    state.schedule = saved.savedSchedule || [];
    state.scheduleCapturedAt = saved.scheduleCapturedAt || 0;
    // v10 2.9 — the injected UI shares the popup's theme. Without this the peek
    // stayed light while the popup went dark; they are one product.
    state.dark = !!saved.darkMode;
    state.unitCaps = saved.unitCaps || null;
    state.currentPass = saved.currentPass || null;

    if (state.page === "schedule") captureSchedule();
    autoCheckLoginBox();
    // Load the bundled ratings BEFORE the first scan so pills resolve instantly.
    await loadRatingsBundle();
    captureImportantDates();
    captureUnitCaps();      // C1 — from this page, if it's Registration Info
    captureProgressCheck();
    captureFinals();
    scan();
    if (shouldShowPeek()) renderPeek();
    noteNoScheduleYet();

    // GOLD does partial postbacks — rescan on any DOM change
    const mo = new MutationObserver(queueScan);
    mo.observe(document.body, { childList: true, subtree: true });

    // Escape dismisses any focused conflict tooltip (B2).
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const open = document.activeElement;
      if (open && open.classList && open.classList.contains("gm-marker")) open.blur();
    });

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync") {
          for (const k of Object.keys(changes)) state.settings[k] = changes[k].newValue;
          removeAllInjected();
          scan();
          if (shouldShowPeek()) renderPeek(); else removePeek();
          // removeAllInjected takes the status bar with it — a toggle must not
          // silently erase an outage notice that is still true.
          if (state.goldTrouble === "gold-unreachable") noteGoldUnreachable();
          if (state.storageTrouble) { state.storageTrouble = false; noteStorageTrouble(); }
          noteNoScheduleYet();
        }
        if (area === "local" && changes.darkMode) {
          state.dark = !!changes.darkMode.newValue;
          applyTheme();
        }
        if (area === "local" && changes.savedSchedule) {
          state.schedule = changes.savedSchedule.newValue || [];
          if (shouldShowPeek()) renderPeek();
        }
      });
    } catch { /* no storage events — not fatal */ }

    // Fetch the real unit cap once if we haven't got it. This is also our GOLD
    // liveness probe: if it fails at the network level, GOLD is down, not us (C4).
    ensureUnitCaps();
  }

  /* Every injected root carries the theme class itself rather than us touching
     GOLD's <html> or <body> — GOLD's stylesheet is hostile and its classes are
     not ours to edit. */
  function applyTheme() {
    document.querySelectorAll(".gm-peek, .gm-status")
      .forEach((n) => n.classList.toggle("gm-dark", state.dark));
  }

  function shouldShowPeek() {
    return state.settings.peek && state.page !== "schedule" && state.schedule.length > 0;
  }

  /* ================== SCHEDULE CAPTURE ================== */

  function saveSchedule(classes) {
    if (!classes.length) return;
    state.schedule = classes;
    // Timestamped so the peek can admit how old this verdict is. Without it a
    // ✓ silently claims "no clash" against whatever the schedule looked like the
    // last time the student happened to open My Schedule.
    safeLocalSet({ savedSchedule: classes, scheduleCapturedAt: Date.now() });
  }

  /* A1: the course code is NOT in the session row. A .row.session holds only
     days / time / location / instructor, so regexing its own text picked up the
     room ("IV Theatre, THEA2") and named the class THEA2 — which then showed up
     in the peek and in every conflict tooltip. The code lives in .courseTitle on
     the ancestor .scheduleItem / .courseSearchHeader; read it from there. */
  function courseCodeForSession(el) {
    const holder = el.closest(".scheduleItem, .courseSearchHeader, .courseItem");
    const titleEl = holder && holder.querySelector(".courseTitle");
    if (titleEl) {
      const t = norm(titleEl.textContent);
      const m = t.match(CODE_AT_START) || t.match(CODE_ANY);
      if (m) return norm(m[1]);
    }
    // Older layouts put the code at the START of the session row itself. Anchor
    // at the start so a room code sitting mid-row can never win.
    const own = norm(el.innerText || el.textContent);
    const m2 = own.match(CODE_AT_START);
    return m2 ? norm(m2[1]) : null;
  }

  function courseTitleForSession(el) {
    const holder = el.closest(".scheduleItem, .courseSearchHeader, .courseItem");
    const titleEl = holder && holder.querySelector(".courseTitle");
    if (!titleEl) return "";
    const t = norm(titleEl.textContent);
    const m = t.match(/[-–]\s*(.+)$/);
    return m ? m[1].trim() : "";
  }

  /* §2: the instructor is the text node after a <label> whose text is exactly
     "Instructor". Returns "" when this row has no such label, which is a real
     case (discussion sections often list no instructor) — not an error. */
  function instructorTextIn(el) {
    const label = [...el.querySelectorAll("label")].find(
      (l) => norm(l.textContent).replace(/:$/, "").toLowerCase() === "instructor"
    );
    if (!label) return "";
    const node = nextInstructorTextNode(label);
    return node ? norm(node.nodeValue) : "";
  }

  function captureSchedule() {
    const sessionEls = document.querySelectorAll("div.row.session, .row.session");
    if (sessionEls.length) {
      const byCourse = new Map();
      sessionEls.forEach((el) => {
        const course = courseCodeForSession(el);
        if (!course) return;
        const text = norm(el.innerText || el.textContent);
        const parsed = parseClassBlock(text, instructorTextIn(el));
        if (!parsed) return;
        if (!byCourse.has(course)) {
          byCourse.set(course, {
            course,
            title: courseTitleForSession(el),
            sessions: [],
            units: parsed.units,
            profLast: parsed.profLast,
            profFI: parsed.profFI
          });
        }
        const rec = byCourse.get(course);
        if (rec.units == null && parsed.units != null) rec.units = parsed.units;
        if (!rec.profLast && parsed.profLast) { rec.profLast = parsed.profLast; rec.profFI = parsed.profFI; }
        rec.sessions.push({ days: parsed.days, start: parsed.start, end: parsed.end });
      });
      // Keep flat days/start/end (first session) so the peek + older code still work.
      const classes = [...byCourse.values()].map((c) => ({
        ...c,
        days: c.sessions[0]?.days || "",
        start: c.sessions[0]?.start || "",
        end: c.sessions[0]?.end || ""
      }));
      saveSchedule(classes);
      return;
    }

    // Fallback: older table layout (dash header, one row per course).
    const classes = [];
    const courseHeaderRe = /^([A-Z]{2,6}(?:\s+[A-Z]{1,2})?\s*\d+[A-Z]{0,3})\s*[-–]\s*(.+)$/;
    const candidates = document.querySelectorAll("b, strong, h3, h4, .courseHeader, span, td");
    const seen = new Set();
    candidates.forEach((el) => {
      const text = norm(el.textContent);
      const m = text.match(courseHeaderRe);
      if (!m) return;
      const course = norm(m[1]);
      if (seen.has(course)) return;
      seen.add(course);

      const container = el.closest("tr, .classRow, .scheduleRow, div, section") || el.parentElement;
      const searchText = (container?.innerText || "") + "\n" + (container?.nextElementSibling?.innerText || "");
      const parsed = parseClassBlock(searchText);
      if (parsed) {
        classes.push({
          course, title: m[2].trim(),
          sessions: [{ days: parsed.days, start: parsed.start, end: parsed.end }],
          ...parsed
        });
      }
    });
    saveSchedule(classes);
  }

  /* THE BOTTLENECK (v8 Phase 1).
     Day letters and instructor initials are the same character class, and the
     session row is one flat string, so a left-to-right scan for days grabs the
     instructor's initials instead: "BUSTO R V  T R  3:30 PM" parsed as days="R",
     losing Tuesday. Everything downstream reads days — conflict markers, the week
     grid, the peek, .ics export — so one wrong letter here silently turned a real
     clash into a green ✓.

     The day run is always the token run IMMEDIATELY BEFORE the meeting time.
     Anchor on that instead of taking the first match in the string. */
  function parseDaysBefore(text, timeIndex) {
    const before = text.slice(0, timeIndex);
    // NOT \b. GOLD renders the enrollment code and the days as adjacent inline
    // elements, and when no whitespace survives between them ("07969T 1:00 PM")
    // there is no word boundary before the T — \b silently dropped the day and
    // the section lost its verdict. A digit is a perfectly good separator.
    const anchored = before.match(/(?:^|[^A-Za-z])([MTWRF](?:\s?[MTWRF])*)\s*$/);
    if (anchored) return anchored[1];
    // No day run adjacent to the time (asynchronous / T.B.A. rows): fall back to
    // a plain scan rather than inventing days.
    const loose = before.match(/(?:^|[^A-Za-z])([MTWRF](?:\s?[MTWRF])*)(?![A-Za-z])/);
    return loose ? loose[1] : "";
  }

  /* `instructorText` comes from the <label>Instructor</label> anchor, which §2
     says is authoritative. Removing it before parsing is what stops the name from
     poisoning the day letters; matching on it directly is also the only way to
     read a hyphenated surname correctly, because innerText concatenates the label
     straight onto the name ("InstructorCASTELLA-CABE") and the only word boundary
     left is the hyphen — which used to yield the surname "CABE". */
  function parseClassBlock(text, instructorText) {
    const timeRe = /(\d{1,2}:\d{2}\s?[AP]M)\s*[-–]\s*(\d{1,2}:\d{2}\s?[AP]M)/gi;
    const profRe = /\b([A-Z][A-Z'\-]{1,24})\s+([A-Z])(?:\s+[A-Z])?(?=\s|$)/;

    const clean = norm(instructorText)
      ? text.replace(norm(instructorText), " ")
      : text;

    const times = [...clean.matchAll(timeRe)];
    if (!times.length) return null;

    const days = parseDaysBefore(clean, times[0].index);
    const unitsMatch = clean.match(/([0-9]+(?:\.[0-9])?)\s*Units/i) ||
                       clean.match(/Units?\s*:?\s*([0-9]+(?:\.[0-9])?)/i);

    let profLast = null, profFI = null;
    const tokens = norm(instructorText).split(" ").filter(Boolean);
    if (tokens.length) {
      profLast = tokens[0].replace(/[^A-Za-z'\-]/g, "").toUpperCase() || null;
      profFI = tokens[1] ? tokens[1][0].toUpperCase() : null;
    } else {
      const profMatch = clean.match(profRe);
      profLast = profMatch?.[1] || null;
      profFI = profMatch?.[2] || null;
    }

    return {
      days: days.replace(/\s+/g, ""),
      start: times[0][1].replace(/\s+/g, "").toUpperCase(),
      end: times[0][2].replace(/\s+/g, "").toUpperCase(),
      units: unitsMatch ? parseFloat(unitsMatch[1]) : null,
      profLast,
      profFI
    };
  }

  /* ================== TIME MATH FOR CONFLICTS ================== */

  const DAY_MAP = { M: 1, T: 2, W: 3, R: 4, F: 5 };

  function to24h(hm) {
    const m = String(hm || "").match(/(\d{1,2}):(\d{2})([AP]M)/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ap = m[3].toUpperCase();
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return h * 60 + min;
  }

  function daysOverlap(a, b) {
    const setA = new Set(String(a).split("").map((d) => DAY_MAP[d]).filter(Boolean));
    for (const d of String(b)) if (setA.has(DAY_MAP[d])) return true;
    return false;
  }

  // A saved course may meet several times (lecture + discussion). Check against
  // EVERY session — a candidate that overlaps only a discussion still conflicts.
  function sessionsOf(course) {
    return (course.sessions && course.sessions.length)
      ? course.sessions
      : [{ days: course.days, start: course.start, end: course.end }];
  }

  // Return the session that actually clashes, so the tooltip can name the real
  // meeting time instead of guessing at the first one.
  function conflictingSession(candidate, existing) {
    for (const s of sessionsOf(existing)) {
      if (!candidate.days || !s.days) continue;
      if (!daysOverlap(candidate.days, s.days)) continue;
      const cs = to24h(candidate.start), ce = to24h(candidate.end);
      const es = to24h(s.start), ee = to24h(s.end);
      if (cs == null || ce == null || es == null || ee == null) continue;
      if (cs < ee && es < ce) return s;
    }
    return null;
  }

  function findConflicts(candidate) {
    const out = [];
    for (const c of state.schedule) {
      const hit = conflictingSession(candidate, c);
      if (hit) out.push({ course: c.course, hit });
    }
    return out;
  }

  /* ================== PILL / RATING INJECTION ================== */

  function queueScan() {
    if (state.scanQueued) return;
    state.scanQueued = true;
    /* A MutationObserver callback that throws stops the observer, and with it
       every rescan for the life of the page. rAF exists in every browser we
       target, but "exists everywhere" is what was assumed about the row shapes
       too, so fall back to a timeout rather than betting the rescan loop on it. */
    const raf = (typeof requestAnimationFrame === "function")
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    raf(() => { state.scanQueued = false; scan(); });
  }

  /* Fires when we're on a course page but can't find any rows — usually means
     GOLD updated its HTML and GOLDmine needs a fix. Shows once per page load. */
  function noteBlind() {
    if (state.blindNoted) return;
    state.blindNoted = true;
    const bar = mk("div", {
      class: "gm-status gm-status-blind" + (state.dark ? " gm-dark" : ""),
      role: "status", "data-gm-status": "blind"
    },
      mk("span", { class: "gm-status-dot", "aria-hidden": "true" }),
      mk("span", { class: "gm-status-text",
        text: "GOLDmine can't read this page — GOLD may have updated. " }),
      mk("a", { class: "gm-status-link", href: "https://github.com/satyachindam/goldmine/issues/new",
        target: "_blank", rel: "noopener", text: "report it →" })
    );
    const close = mk("button", { class: "gm-status-close", type: "button",
      "aria-label": "Dismiss", text: "×" });
    close.addEventListener("click", () => bar.remove());
    bar.appendChild(close);
    document.body.appendChild(bar);
  }

  function scan() {
    /* A rescan is scheduled on a timer, and a timer can outlive the document it
       was scheduled against. Nothing to scan is not an error condition. */
    if (typeof document === "undefined" || !document || !document.body) return;
    if (state.settings.ratings) scanForProfNames();
    tagCourseHeaders();
    tagCartCourses();
    if (state.settings.conflicts && state.page !== "schedule") scanForConflicts();
    scanForCourseMeta();
    scanForPrereqs();

    /* Canary: if we're on a search or cart page and found zero course rows,
       GOLD's HTML may have changed under us. */
    if (state.page === "search" || state.page === "cart") {
      const rows = document.querySelectorAll(
        ".scheduleItem, .courseSearchHeader, .courseItem, [data-gm-about]"
      );
      if (!rows.length) noteBlind();
    }
  }

  /* Real registration-cart rows have no dash: the code and title are separate
     spans whose ids end in _regCartCourseId / _regCartCourseTitle. Tag the row
     with its course so section-level features (watch, prereqs) know what they're
     looking at. */
  function tagCartCourses() {
    const titleSpans = document.querySelectorAll("[id$='_regCartCourseTitle'], [id*='regCartCourseTitle']");
    titleSpans.forEach((titleEl) => {
      const row = titleEl.closest("tr, .row, .courseRow, div") || titleEl.parentElement;
      if (!row || row.hasAttribute("data-gm-about")) return;
      const idEl = row.querySelector("[id$='_regCartCourseId'], [id*='regCartCourseId']");
      const code = norm((idEl && idEl.textContent) || titleEl.textContent);
      const courseCode = norm((code.match(CODE_ANY) || [, code])[1]);
      row.setAttribute("data-gm-about", "1");
      row.setAttribute("data-gm-course", courseCode);
      titleEl.setAttribute("data-gm-title", "1");
    });
  }

  /* ================== AUTO-CHECK LOGIN / AGREE BOX ================== */
  function autoCheckLoginBox() {
    let boxes;
    try { boxes = document.querySelectorAll("input[type='checkbox']"); }
    catch { return; }
    for (const box of boxes) {
      if (box.checked || box.disabled || box.hasAttribute("data-gm-autocheck")) continue;
      let label = box.closest("label")?.innerText || box.parentElement?.innerText || "";
      if (box.id && /^[A-Za-z][\w-]*$/.test(box.id)) {
        const l = document.querySelector("label[for='" + box.id + "']");
        if (l) label += " " + l.innerText;
      }
      if (/keep me (signed|logged)|stay (signed|logged)|remember (me|this)|i agree|accept the terms/i.test(label)) {
        box.setAttribute("data-gm-autocheck", "1");
        box.checked = true;
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }

  /* ================== EXTRA ROW INFO (defensive) ================== */
  function scanForCourseMeta() {
    if (state.page === "schedule") return;
    const rows = document.querySelectorAll(SECTION_ROWS);
    rows.forEach((row) => {
      if (row.hasAttribute("data-gm-meta")) return;
      const text = row.innerText || "";
      if (!text) return;
      row.setAttribute("data-gm-meta", "1");

      applySeatStatus(row);

      // NOTE: the cell is created lazily, only if a badge actually lands in it.
      // Creating it up-front added an empty <td> to EVERY row in the document —
      // including GOLD's own nav and footer layout tables — which widened them
      // and left the results table with mismatched column counts.
      const wm = text.match(/wait\s*list\s*[:#]?\s*(\d{1,3})/i);
      if (wm) addRowBadge(row, "gm-waitlist-badge", "waitlist #" + wm[1]);

      const fm = text.match(/Final(?:\s*Exam)?\s*:?\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s*\d{1,2}:\d{2}\s*[AP]M)?|[A-Z][a-z]{2,8}\.?\s*\d{1,2}(?:,?\s*\d{4})?)/);
      if (fm) addRowBadge(row, "gm-final-badge", "final " + fm[1]);

      const gm = text.match(/\bGE\s*Area[s]?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9,\/\s]{0,14})/i);
      if (gm) addRowBadge(row, "gm-ge-badge", "GE " + gm[1].trim());
    });
  }

  /* GOLD prints "Space Full" and "Space 3" as identical plain text. Color it by
     state so a 40-row page is scannable, and recede full sections — while
     keeping them clickable. */
  function applySeatStatus(row) {
    const tw = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null);
    const hits = [];
    let node;
    while ((node = tw.nextNode())) {
      if (node.parentElement?.closest(".gm-seat, .gm-peek, .gm-card, .gm-tip, .gm-status")) continue;
      if (/Space\s+(Full|\d{1,3})\b/i.test(node.nodeValue)) hits.push(node);
    }
    for (const n of hits) {
      const m = n.nodeValue.match(/Space\s+(Full|\d{1,3})\b/i);
      if (!m) continue;
      let cls = "gm-seat-ok", full = false;
      if (/full/i.test(m[1])) { cls = "gm-seat-full"; full = true; }
      else if (parseInt(m[1], 10) <= 5) cls = "gm-seat-low";
      wrapTextMatch(n, m.index, m[0].length, "gm-seat " + cls);
      if (full) {
        row.classList.add("gm-closed-row"); // stays clickable; just deprioritized
        explainWaitlist(row);               // C2
      }
    }
  }



  /* Wrap a substring of a text node in a styled span — no innerHTML. */
  function wrapTextMatch(node, index, length, className) {
    const matchNode = node.splitText(index);   // matchNode: from index to end
    matchNode.splitText(length);               // matchNode: exactly the match
    const span = document.createElement("span");
    span.className = className;
    matchNode.parentNode.insertBefore(span, matchNode);
    span.appendChild(matchNode);
  }

  /* BUG 2: every injection used `row.querySelector("td, div")`, which on the cart
     and search pages is the ENROLLMENT CODE cell — so the ✗/✓ markers landed on
     top of the five digits the student has to read and type. The code is
     the one thing on the row they cannot afford to have obscured.

     Markers belong next to what the student clicks. Prefer the cell holding the
     row's own action buttons; never the code cell; fall back to the row itself. */
  /* Everything we add to a row goes in ONE cell of our own, appended after all of
     GOLD's. Injecting into GOLD's action cell (the first version of this fix) put
     a 20px badge and a 22px button beside the Add control and wrapped it on
     narrow rows — trading an obscured code for a displaced button. A trailing
     cell sits to the right of the row's existing content and displaces none of
     it, which is what §3 BUG 2 actually asks for. */
  function injectionTarget(row) {
    const existing = [...row.children].find((c) => c.classList && c.classList.contains("gm-cell"));
    if (existing) return existing;
    const cell = document.createElement(row.tagName === "TR" ? "td" : "span");
    cell.className = "gm-cell";
    row.appendChild(cell);
    return cell;
  }

  /* Create our trailing cell only when something is actually going into it. */
  function addRowBadge(row, cls, label) {
    if (row.querySelector("." + cls)) return;
    addMetaBadge(injectionTarget(row), cls, label);
  }

  function addMetaBadge(target, cls, label) {
    if (target.querySelector("." + cls)) return;
    const b = document.createElement("span");
    b.className = cls;
    b.textContent = label;
    target.appendChild(b);
  }

  /* ================== COURSE BLOCKS ================== */
  /* A "course block" is one course and its sections. Two shapes exist:
     a self-contained container (real GOLD's .scheduleItem / .courseSearchHeader)
     or a header row plus the sibling rows that follow it (older tables). */

  const COURSE_HEADER_RE = /^([A-Z]{2,6}(?:\s+[A-Z]{1,2})?\s*\d+[A-Z]{0,3})\s*[-–]\s*(.{3,60})/;
  //  No-dash form (collapsed registration-cart rows): "DANCE 43A BEG STREET DANCE".
  //  Only accepted when the row also contains "Units:", so arbitrary all-caps
  //  text isn't mistaken for a course.
  const CODE_TITLE_RE = /^([A-Z]{2,6}(?:\s+[A-Z]{1,2})?\s*\d+[A-Z]{0,3})\s+([A-Z][A-Z0-9 &'.\/-]{2,60})$/;

  function matchCourseHeader(firstLine, fullText) {
    let m = firstLine.match(COURSE_HEADER_RE);
    if (m) return { code: m[1], title: m[2].trim() };
    m = firstLine.match(CODE_TITLE_RE);
    if (m && /Units\s*:/i.test(fullText)) return { code: m[1], title: m[2].trim() };
    return null;
  }

  function tagCourseHeaders() {
    const candidates = [...document.querySelectorAll("tr, div, td, b, strong")].filter((el) => {
      if (el.closest(".gm-peek, .gm-card, .gm-status")) return false;
      // Layout-free prefilter FIRST. This runs over every tr/div/td/b/strong on
      // the page on every rescan, and innerText forces a reflow each time — on a
      // 40-section results page that was the single largest cost of a postback.
      // A course header always carries a digit and a run of capitals; textContent
      // is free, so reject the nav links and layout cells before touching layout.
      const raw = el.textContent;
      if (!raw || raw.length > 400) return false;
      if (!/[A-Z]{2}/.test(raw) || !/\d/.test(raw)) return false;
      const text = (el.innerText || "").trim();
      if (!text) return false;
      const firstLine = text.split("\n")[0];
      const mh = matchCourseHeader(firstLine, text);
      if (!mh) return false;
      if (COURSE_HEADER_RE.test(firstLine)) return /Units\s*:/.test(text) || text.length < 120;
      return true; // cart form already required "Units:"
    });

    // Innermost only — outer wrappers containing another candidate are dropped
    const innermost = candidates.filter(
      (el) => !candidates.some((other) => other !== el && el.contains(other))
    );

    for (const el of innermost) {
      const row = el.closest("tr") || el;
      if (row.hasAttribute("data-gm-about")) continue;
      if (row.parentElement?.closest("[data-gm-about]")) continue;

      const text = (el.innerText || "").trim();
      const mh = matchCourseHeader(text.split("\n")[0], text);
      if (!mh) continue;
      row.setAttribute("data-gm-about", "1");
      row.setAttribute("data-gm-course", norm(mh.code));
      el.setAttribute("data-gm-title", "1");   // where inline course info anchors
    }
  }

  /* Header row plus its section rows, until the next tagged header */
  function courseBlockElements(headerRow) {
    const els = [headerRow];
    let el = headerRow.nextElementSibling;
    let steps = 0;
    while (el && steps < 40 && !el.hasAttribute("data-gm-about")) {
      els.push(el);
      el = el.nextElementSibling;
      steps++;
    }
    return els;
  }

  function courseBlockScope(root) {
    if (root.matches(".scheduleItem, .courseSearchHeader, .courseItem")) return [root];
    return courseBlockElements(root);
  }

  /* Outermost course roots. Outermost (not innermost) is deliberate: on a real
     course modal the PreRequisites tab lives OUTSIDE the header row but inside
     the modal, and taking the inner row as the root both missed the tab and let
     the nested .row elements each render their own badge (the A3 double-render). */
  function courseRoots() {
    const roots = [...document.querySelectorAll("[data-gm-about], .scheduleItem, .courseSearchHeader")];
    return roots.filter((r) => !roots.some((o) => o !== r && o.contains(r)));
  }

  /* Where a course-level line (prereqs, the waitlist explainer) should hang.
     GOLD renders .courseSearchHeader as a SIBLING of the section container, so a
     course's title usually is NOT inside its own block — falling straight through
     to `querySelector("td, div")` put "needs MATH 3B, CMPSC 8" inside the lecture
     row, which is already the busiest line on the page. Look just above first. */
  function blockAnchor(root) {
    const own = root.querySelector(".courseTitle, [data-gm-title]");
    if (own) return own;
    const prev = root.previousElementSibling;
    if (prev) {
      const sibTitle = prev.querySelector && prev.querySelector(".courseTitle, [data-gm-title]");
      if (sibTitle) return sibTitle;
      if (prev.classList && prev.classList.contains("courseSearchHeader")) return prev;
    }
    return root.querySelector("td, div") || root;
  }

  function blockText(scope) {
    return scope.map((el) => el.innerText || el.textContent || "").join("\n");
  }

  /* The PreRequisites TAB is present on every course, empty or not, so its own
     label must never be mistaken for a course actually having prerequisites —
     that's the difference between "nothing to show" and a badge on every row. */
  function mentionsPrereq(scope) {
    for (const line of blockText(scope).split("\n")) {
      const t = line.trim().replace(/[:\s]+$/, "");
      if (!/prerequisite/i.test(t)) continue;
      if (/^pre\s*-?\s*requisite[s]?$/i.test(t)) continue;   // bare tab label
      return true;
    }
    return false;
  }

  /* ================== D: INLINE PREREQUISITES ================== */
  /* GOLD's PreRequisites tab lists one <td> per requirement, each reading
     "MATH      4B    with a minimum grade of C" and optionally prefixed "AND".
     The shape is distinctive enough to match on directly, so we don't have to
     guess at the tab container's markup — which differs per page. */

  const PREREQ_CELL_RE =
    /^(?:AND\s+|OR\s+)?([A-Z]{2,6}(?:\s+[A-Z]{1,2})?\s*\d+[A-Z]{0,3})\s+with\s+a\s+minimum\s+grade\s+of\s+([A-D][+-]?|P|CR)\b/i;

  function parsePrereqCells(scope) {
    const out = [];
    const seen = new Set();
    for (const el of scope) {
      const cells = el.matches?.("td") ? [el, ...el.querySelectorAll("td")] : [...(el.querySelectorAll?.("td") || [])];
      for (const td of cells) {
        if (td.querySelector("td")) continue;        // leaf cells only
        const m = norm(td.textContent).match(PREREQ_CELL_RE);
        if (!m) continue;
        const course = norm(m[1]).toUpperCase();
        if (seen.has(course)) continue;
        seen.add(course);
        out.push({ course, minGrade: m[2].toUpperCase() });
      }
    }
    return out;
  }

  /* A3: one prereq line per course block, full stop. It used to be emitted from
     the per-row meta scan, which fires once for the inline row AND once for the
     row inside the tab container — hence the orphaned duplicate after the tabs. */
  function scanForPrereqs() {
    for (const root of courseRoots()) {
      const scope = courseBlockScope(root);
      const list = parsePrereqCells(scope);
      const anchor = blockAnchor(root);

      // Deliberately NOT latched with a done-flag. GOLD loads the PreRequisites
      // tab on a postback, so a course that had nothing to show on the first pass
      // may have the real list a moment later. Dedupe on the rendered node
      // instead, which stays correct however many times we re-scan.
      const existingList = anchor.querySelector(".gm-prereq-list");
      const existingBadge = anchor.querySelector(".gm-prereq-badge");
      if (existingList) continue;
      if (list.length && existingBadge) existingBadge.remove();  // upgrade vague -> real
      else if (existingBadge) continue;

      if (list.length) {
        addMetaBadge(anchor, "gm-prereq-list", "needs " + list.map((p) => p.course).join(", "));
      } else if (mentionsPrereq(scope)) {
        // The tab is empty for most courses; only say "has prereqs" when the page
        // actually claims there are some. An empty tab renders nothing at all.
        addMetaBadge(anchor, "gm-prereq-badge", "has prereqs");
      }
    }
  }

  /* ================== C2: WAITLIST EXPLAINER ================== */
  /* The waitlist control only appears once you're at 12+ enrolled units AND every
     lecture and section of the course is full. GOLD explains none of that, so a
     full class with no waitlist button reads as "broken". */
  function hasWaitlistControl(scope) {
    for (const el of scope) {
      const ctrls = el.querySelectorAll?.("input, button, select, a") || [];
      for (const c of ctrls) {
        const s = ((c.value || "") + " " + (c.textContent || "") + " " +
                   (c.getAttribute?.("name") || "") + " " + (c.id || "") + " " +
                   (c.getAttribute?.("title") || "")).toLowerCase();
        if (/wait\s*list/.test(s)) return true;
      }
    }
    return false;
  }

  /* One explainer per page, not per full section: the rule is the same for every
     course, and a 40-row results page full of the same sentence is exactly the
     noise the compact conflict markers exist to avoid. Also NOT latched — if a
     postback brings GOLD's own waitlist control in, we take our line back down
     rather than leaving stale advice on screen. */
  function explainWaitlist(row) {
    const root = row.closest("[data-gm-about], .scheduleItem, .courseSearchHeader") || row;
    const scope = courseBlockScope(root);
    const existing = document.querySelector(".gm-waitlist-hint");
    if (hasWaitlistControl(scope)) {
      if (existing && existing.closest("[data-gm-about], .scheduleItem, .courseSearchHeader") === root) {
        existing.remove();
      }
      return;
    }
    if (existing) return;
    addMetaBadge(blockAnchor(root), "gm-waitlist-hint",
      "waitlist opens once you're at 12+ units and every section is full.");
  }

  /* ================== INSTRUCTOR NAMES ================== */

  function pageHasInstructorLabels() {
    return [...document.querySelectorAll("label")].some(
      (l) => norm(l.textContent).replace(/:$/, "").toLowerCase() === "instructor"
    );
  }

  function scanForProfNames() {
    scanInstructorLabels();
    // The loose text-shape scan only runs on pages WITHOUT explicit Instructor
    // labels. On real GOLD the labels are authoritative; running the loose scan
    // there mis-pills nav items and ALL-CAPS course titles. Gate on whether the
    // PAGE HAS labels — not on this scan's hit count, which is zero on re-scans
    // once every label is already tagged.
    if (!pageHasInstructorLabels()) scanProfByTextShape();
  }

  /* Real GOLD: every instructor name sits directly after a <label> whose text is
     exactly "Instructor", as a text node ending at <br>. */
  function scanInstructorLabels() {
    const labels = [...document.querySelectorAll("label")].filter(
      (l) => norm(l.textContent).replace(/:$/, "").toLowerCase() === "instructor"
    );
    for (const label of labels) {
      if (label.hasAttribute("data-gm-prof-done")) continue;
      const nameNode = nextInstructorTextNode(label);
      if (!nameNode) continue;
      // Screen the WHOLE string, not just the surname we extract from it:
      // "TO BE ANNOUNCED" tokenises to a surname of "TO", which passes any
      // per-token check. F3 is about the phrase, so test the phrase.
      const rawName = norm(nameNode.nodeValue);
      if (!isRealInstructor(rawName)) continue;
      const tokens = rawName.split(" ").filter(Boolean);
      if (!tokens.length) continue;
      const last = tokens[0].replace(/[^A-Za-z'\-]/g, "").toUpperCase();
      if (last.length < 2) continue;
      const initial = tokens[1] ? tokens[1][0].toUpperCase() : "";
      label.setAttribute("data-gm-prof-done", "1");
      const holder = document.createElement("span");
      holder.className = "gm-pill-holder";
      nameNode.after(holder);
      injectPillAsync(holder, last, initial);
    }
  }

  // First non-empty text after the label, stopping at the next <br>/<label>.
  function nextInstructorTextNode(label) {
    let n = label.nextSibling;
    let steps = 0;
    while (n && steps < 8) {
      if (n.nodeType === 3 && (n.nodeValue || "").trim()) return n;
      if (n.nodeType === 1) {
        if (n.tagName === "LABEL") break;
        if (n.tagName !== "BR") {
          const tw = document.createTreeWalker(n, NodeFilter.SHOW_TEXT, null);
          let t; while ((t = tw.nextNode())) if ((t.nodeValue || "").trim()) return t;
        }
      }
      n = n.nextSibling; steps++;
    }
    return null;
  }

  /* A2: the fallback shape scan had to be loosened to ([A-Z]{1,3}) so that
     instructors GOLD prints with an abbreviated first name (RODRIGUES TOR) still
     resolve — but that also made "ABOUT ME" and ALL-CAPS course titles look like
     names, and <a> can't be excluded because Find Courses wraps instructor names
     in links. Two guards keep both halves true:
       1. structural — never walk GOLD's nav / header / footer chrome;
       2. lexical — a surname is never one of GOLD's own UI words, and an
          initial is never an English function word ("ABOUT ME", "ART OF"). */
  const CHROME_CONTAINERS =
    "script, style, button, input, select, textarea, nav, header, footer, " +
    "[role='navigation'], [role='banner'], [role='menubar'], " +
    ".nav, .navbar, .menu, .mainmenu, .topnav, .header, .footer, .breadcrumb, " +
    ".gm-peek, .gm-card, .gm-status, .gm-tip";

  const NOT_A_SURNAME = new Set([
    "ABOUT", "HOME", "MENU", "HELP", "LOGIN", "LOGOUT", "SIGN", "SKIP", "MAIN",
    "GOLD", "UCSB", "SEARCH", "FIND", "VIEW", "PRINT", "BACK", "NEXT", "SUBMIT",
    "CANCEL", "CLOSE", "OPEN", "ADD", "DROP", "EDIT", "SAVE", "TOTAL", "UNITS",
    "GRADE", "GRADES", "STUDENT", "ACADEMIC", "REGISTRATION", "COURSE", "COURSES",
    "CLASS", "CLASSES", "SCHEDULE", "CART", "PASS", "FINAL", "FINALS", "SPACE",
    "MAX", "DAYS", "TIME", "LOCATION", "INSTRUCTOR", "ENROLLMENT", "CODE",
    "TITLE", "STATUS", "CONTACT", "INFO", "NOTE", "NOTES", "MY", "WAITLIST"
  ]);

  const NOT_AN_INITIAL = new Set([
    "ME", "OF", "AND", "THE", "TO", "IN", "FOR", "ON", "AT", "BY", "OR", "AN",
    "IT", "IS", "AS", "BE", "DO", "GO", "NO", "SO", "UP", "US", "WE", "IF",
    "VS", "PER", "ALL", "NEW", "OUT", "OFF", "ARE", "NOT", "YOU", "ITS", "MY"
  ]);

  function scanProfByTextShape() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const t = node.nodeValue;
        if (!t || t.length < 3 || t.length > 60) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.hasAttribute("data-gm-prof")) return NodeFilter.FILTER_REJECT;
        // <a> is intentionally NOT excluded — Find Courses renders each instructor
        // name inside a link, so excluding <a> hid ratings there.
        if (parent.closest(CHROME_CONTAINERS)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    // "JOSEPH C A" | "KHARITONOVA Y" | "PAZOS S" | "BUSTO R V" | "RODRIGUES TOR"
    const re = /\b([A-Z][A-Z'\-]{1,24})\s+([A-Z]{1,3})(?:\s+[A-Z]{1,2})?\b/;

    const targets = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const raw = node.nodeValue;
      if (/[a-z0-9]/.test(raw)) continue;      // real names here are ALL CAPS
      const clean = raw.trim();
      const m = clean.match(re);
      if (!m) continue;
      // Must be essentially the whole text of the node, not part of a sentence.
      if (clean.length > m[0].length + 4) continue;
      if (NOT_A_SURNAME.has(m[1])) continue;   // "ABOUT ME", "COURSE INFO", …
      if (NOT_AN_INITIAL.has(m[2])) continue;  // "ART OF ANCIENT AMER"
      if (!isRealInstructor(clean)) continue;  // F3: T.B.A. is not a person
      targets.push({ node, last: m[1], fi: m[2].charAt(0) });
    }

    for (const t of targets) {
      const parent = t.node.parentElement;
      if (!parent || parent.hasAttribute("data-gm-prof")) continue;
      parent.setAttribute("data-gm-prof", "1");
      injectPillAsync(parent, t.last, t.fi);
    }
  }

  /* ---- bundled ratings: instant, synchronous hits with zero network ---- */
  async function loadRatingsBundle() {
    if (state.ratingsIndex) return;
    state.ratingsIndex = new Map();
    try {
      if (typeof chrome?.runtime?.getURL !== "function" || typeof fetch !== "function") return;
      const res = await fetch(chrome.runtime.getURL("data/ratings.json"));
      if (!res || !res.ok) return;
      const list = await res.json();
      if (!Array.isArray(list)) return;
      for (const r of list) {
        const last = String(r.lastName || "").toUpperCase().replace(/[^A-Z]/g, "");
        if (!last) continue;
        if (!state.ratingsIndex.has(last)) state.ratingsIndex.set(last, []);
        state.ratingsIndex.get(last).push(r);
      }
    } catch {
      /* bundle is optional — live RMP still covers everything */
    }
  }

  function lookupBundle(lastName, firstInitial) {
    if (!state.ratingsIndex) return null;
    const list = state.ratingsIndex.get(String(lastName).toUpperCase());
    if (!list || !list.length) return null;
    let best = null, bestScore = -1;
    for (const r of list) {
      const fi = String(r.firstName || "")[0]?.toUpperCase();
      let score = r.numRatings || 0;
      if (firstInitial && fi === firstInitial) score += 1000; // prefer the initial match
      if (score > bestScore) { bestScore = score; best = r; }
    }
    if (!best) return null;
    return {
      legacyId: best.legacyId,
      firstName: best.firstName,
      lastName: best.lastName,
      department: best.department,
      rating: best.avgRating,
      difficulty: best.avgDifficulty,
      numRatings: best.numRatings,
      wouldTakeAgain: best.wouldTakeAgainPercent >= 0 ? best.wouldTakeAgainPercent : null
    };
  }

  /* F3: GOLD writes a placeholder into the Instructor field when no one is
     assigned yet. "T.B.A." is not a person, so looking it up and rendering an
     N/A pill states that a professor named T.B.A. has no ratings — which is
     nonsense, and it stacked a second pill next to the real instructor's.
     Screened at the single point every pill passes through, so no caller can
     forget it. */
  const NOT_A_PERSON = new Set([
    "TBA", "TBD", "STAFF", "TOBEANNOUNCED", "TOBEDETERMINED", "NOTASSIGNED", "NONE"
  ]);

  function isRealInstructor(name) {
    const raw = String(name == null ? "" : name);
    if (!/[A-Za-z]/.test(raw)) return false;               // no letters at all
    const squashed = raw.toUpperCase().replace(/[^A-Z]/g, "");
    if (!squashed) return false;                            // whitespace only
    return !NOT_A_PERSON.has(squashed);
  }

  async function injectPillAsync(parent, lastName, firstInitial) {
    // One gate for every pill, whichever scan found the name.
    if (!isRealInstructor(lastName)) return;
    // 1) Instant local hit from the bundled dataset — no network, no flicker.
    const local = lookupBundle(lastName, firstInitial);
    if (local) {
      if (parent.isConnected) parent.appendChild(buildPill(local));
      return;
    }

    // 2) Miss -> live RMP via the background worker (deduped + cached there).
    const key = `${lastName}|${firstInitial}`;
    let promise = state.pending.get(key);
    if (!promise) {
      promise = safeSend({ type: "lookupProf", payload: { lastName, firstInitial } });
      state.pending.set(key, promise);
    }
    const prof = await promise;
    // GOLD replaces whole subtrees on postback; if this node is gone, the rescan
    // that follows the postback will re-inject. Never append to a detached node.
    if (!parent.isConnected) return;
    if (parent.querySelector(".gm-pill-wrap")) return;   // a rescan beat us to it
    if (prof && prof.error) parent.appendChild(buildUnknownPill(lastName));
    else if (prof) parent.appendChild(buildPill(prof));
    else parent.appendChild(buildNAPill(lastName));
  }

  /* Tiny DOM builder so injected UI never touches innerHTML with GOLD/RMP text. */
  function mk(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const kid of kids) {
      if (kid == null) continue;
      n.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return n;
  }

  function buildNAPill(lastName) {
    const wrap = mk("span", { class: "gm-pill-wrap" });
    const pill = mk("span", {
      class: "gm-pill gm-tier-none", text: "N/A", tabindex: "0",
      "aria-label": "No RateMyProfessors ratings found"
    });
    const card = mk("span", { class: "gm-card gm-card-na" },
      mk("span", { class: "gm-card-nabody", text: "No RMP ratings yet for this instructor." }),
      mk("a", {
        class: "gm-card-link", target: "_blank", rel: "noopener",
        href: "https://www.ratemyprofessors.com/search/professors/1077?q=" + encodeURIComponent(lastName),
        text: "search RMP"
      })
    );
    wrap.appendChild(pill);
    wrap.appendChild(card);
    return wrap;
  }

  /* We never reached RateMyProfessors. Saying "no ratings yet" here would be us
     inventing a fact — say what actually happened instead. */
  function buildUnknownPill(lastName) {
    const wrap = mk("span", { class: "gm-pill-wrap" });
    wrap.appendChild(mk("span", {
      class: "gm-pill gm-tier-unknown", text: "?", tabindex: "0",
      "aria-label": "Couldn't reach RateMyProfessors for this instructor"
    }));
    wrap.appendChild(mk("span", { class: "gm-card gm-card-na" },
      mk("span", { class: "gm-card-nabody", text: "couldn't reach RateMyProfessors. this isn't a rating, it's a failed lookup. try again in a bit." }),
      mk("a", {
        class: "gm-card-link", target: "_blank", rel: "noopener",
        href: "https://www.ratemyprofessors.com/search/professors/1077?q=" + encodeURIComponent(lastName),
        text: "search RMP"
      })
    ));
    return wrap;
  }

  function ratingTier(r) {
    if (r > 4.0) return "gm-tier-green";   // 4.1 – 5.0
    if (r > 2.0) return "gm-tier-yellow";  // 2.1 – 4.0
    return "gm-tier-red";                  // 1.0 – 2.0
  }

  function buildPill(prof) {
    const wrap = document.createElement("span");
    wrap.className = "gm-pill-wrap";
    const thin = (prof.numRatings || 0) < 3;
    const pill = document.createElement("span");
    pill.className = `gm-pill ${ratingTier(prof.rating)}${thin ? " gm-pill-thin" : ""}`;
    pill.textContent = Number(prof.rating).toFixed(1);
    pill.setAttribute("tabindex", "0");
    pill.setAttribute("aria-label",
      `${prof.firstName} ${prof.lastName}: ${prof.rating} of 5 on RateMyProfessors`);
    wrap.appendChild(pill);
    wrap.appendChild(buildCard(prof));
    return wrap;
  }

  function buildCard(prof) {
    const wta = prof.wouldTakeAgain != null ? Math.round(prof.wouldTakeAgain) + "%" : "—";
    const diff = prof.difficulty != null ? Number(prof.difficulty).toFixed(1) : "—";
    const name = `${prof.firstName ?? ""} ${prof.lastName ?? ""}`.trim();

    const card = mk("span", { class: "gm-card" },
      mk("span", { class: "gm-card-head" },
        mk("span", { class: "gm-card-name", text: name }),
        mk("span", { class: "gm-card-dept", text: prof.department || "" })
      ),
      mk("span", { class: "gm-card-score" },
        mk("span", { class: "gm-card-big", text: Number(prof.rating).toFixed(1) }),
        mk("span", { class: "gm-card-outof", text: `/ 5 · ${prof.numRatings || 0} ratings` })
      ),
      mk("span", { class: "gm-card-stats" },
        mk("span", { class: "gm-stat" },
          mk("span", { class: "gm-stat-num", text: diff }),
          mk("span", { class: "gm-stat-label", text: "difficulty" })),
        mk("span", { class: "gm-stat" },
          mk("span", { class: "gm-stat-num", text: wta }),
          mk("span", { class: "gm-stat-label", text: "would take again" }))
      )
    );
    if (prof.legacyId) {
      card.appendChild(mk("a", {
        class: "gm-card-link",
        href: "https://www.ratemyprofessors.com/professor/" + encodeURIComponent(prof.legacyId),
        target: "_blank", rel: "noopener", text: "read reviews"
      }));
    }
    return card;
  }

  /* ================== B: CONFLICT MARKERS ================== */
  /* One ✗ or ✓ per row. Nothing else renders inline — the old version repeated
     "clashes with X" on every row and on the Add button, which buried the page.
     The detail lives in a tooltip that appears on hover or keyboard focus, is
     absolutely positioned so it can't push GOLD's layout around, and never gates
     the row: an ✗ section is still fully addable. */

  function stripMeridiem(t) {
    return String(t || "").replace(/\s*([AP]M)$/i, "");
  }

  function describeSession(s) {
    if (!s) return "";
    // v13 §1.2 — "2:00 to 3:15", not "2:00–3:15". A student reads this line at
    // a glance under time pressure; a word is faster to parse than a dash, and
    // the dash was the connector the student called out.
    const time = (s.start && s.end) ? stripMeridiem(s.start) + " to " + stripMeridiem(s.end) : "";
    return [s.days, time].filter(Boolean).join(" ");
  }

  function conflictDetail(conflicts) {
    return conflicts.map((c) => {
      const when = describeSession(c.hit);
      return when ? c.course + " · " + when : c.course;
    }).join("; ");
  }

  function buildMarker({ cls, mark, detail, aria }) {
    const wrap = mk("span", {
      class: "gm-marker " + cls,
      tabindex: "0",
      role: "note",
      "aria-label": aria
    });
    wrap.appendChild(mk("span", { class: "gm-mark", "aria-hidden": "true", text: mark }));
    wrap.appendChild(mk("span", { class: "gm-tip", role: "tooltip", text: detail }));
    return wrap;
  }

  /* Read a row's own meeting time. Returns null for rows that don't schedule
     anything (headers, notes, T.B.A. sections) — those get no marker at all. */
  /* A cheap fingerprint of the row's OWN content, deliberately excluding the cell
     we inject — otherwise our own marker would invalidate the cache on the very
     next scan and we'd never get a hit. textContent costs no layout; innerText
     does, which is the whole point of caching it. */
  function rowSignature(row) {
    const cell = row.querySelector(":scope > .gm-cell");
    const ourText = cell ? cell.textContent.length : 0;
    const kids = row.children.length - (cell ? 1 : 0);
    return kids + "|" + (row.textContent.length - ourText);
  }

  /* Reading innerText forces a synchronous reflow. scanForConflicts asks every
     row on the page for its times, and blockRootFor asks again while walking
     back — on a 40-section results page that was ~1000 layout-forcing reads for
     a rescan where nothing had changed, and GOLD fires a rescan on every
     postback. Memoise per row; a postback replaces the node, which drops the
     expando with it, so the cache cannot go stale across a real update. */
  /* ============ v11 Part 1 — the .row selector ============
     GOLD is a Bootstrap page: `.row` matches page wrappers, the nav block, the
     welcome banner and layout containers as well as course rows. Any wrapper
     that CONTAINS a session row also contains its day and time text, so it
     passed the day+time test and took a marker of its own — which is how a
     check and a calendar ended up beside the student's name.

     Whitelist, never blacklist. Only GOLD's real section rows are scanned. */
  const SECTION_ROWS = [
    ".courseSearchItem .row.session",   // Find Courses results
    ".scheduleItem .row.session",       // My Schedule
    ".row.susbSessionItem",             // sub-sections (GOLD's own typo)
    "tr", ".classRow", ".sectionRow"    // GOLD's table layouts, unambiguous
  ].join(", ");

  const isBootstrapRow = (el) =>
    el.classList && el.classList.contains("row");

  /* GOLD labels its own columns. On a Bootstrap row that label is what tells a
     real section apart from a wrapper that merely contains one. Table rows carry
     no such labels and don't need them — they were never ambiguous. */
  /* GOLD's Bootstrap markup puts the value in a text node right after its
     <label>, with no separator — innerText reads "DaysM W", which the day regex
     cannot parse (it produced "W" for an M-W lecture and nothing at all for a
     T discussion). The label is not just a filter for rule 1; it is where the
     value actually lives. Read it the same way §2 says to read Instructor. */
  function labelledValue(row, re) {
    const label = [...row.querySelectorAll("label")].find(
      (l) => re.test(norm(l.textContent).replace(/:$/, "")));
    if (!label) return "";
    const node = nextInstructorTextNode(label);
    return node ? norm(node.nodeValue) : "";
  }

  function hasDaysOrTimeLabel(row) {
    return [...row.querySelectorAll("label")].some((l) =>
      /^(days|time)$/i.test(norm(l.textContent).replace(/:$/, "")));
  }

  function sectionRows() {
    const all = [...document.querySelectorAll(SECTION_ROWS)];
    const timed = all.filter((row) => {
      if (!candidateOf(row)) return false;                 // rule 2: day + time
      if (isBootstrapRow(row)) {
        if (!hasDaysOrTimeLabel(row)) return false;        // rule 1
        // rule 3: it must belong to a course we can name
        const anc = row.closest(".courseSearchHeader, .scheduleItem, .courseSearchItem");
        if (!anc) return false;
      }
      return true;
    });
    // rule 4, and the important one: a row that CONTAINS another candidate row
    // is a wrapper, never a course row.
    return timed.filter((row) => !timed.some((other) => other !== row && row.contains(other)));
  }

  function candidateOf(row) {
    const sig = rowSignature(row);
    if (row.__gmSig === sig) return row.__gmCand;
    const text = row.innerText || "";
    // Prefer GOLD's own labelled values; fall back to scanning for table layouts.
    const labelDays = labelledValue(row, /^days$/i);
    const labelTime = labelledValue(row, /^time$/i);
    const timeRe = /(\d{1,2}:\d{2}\s?[AP]M)\s*[-–]\s*(\d{1,2}:\d{2}\s?[AP]M)/i;
    if (labelDays && timeRe.test(labelTime)) {
      const t = labelTime.match(timeRe);
      const d = labelDays.replace(/[^MTWRF]/g, "");
      if (d) {
        const cand = {
          days: d,
          start: t[1].replace(/\s+/g, "").toUpperCase(),
          end: t[2].replace(/\s+/g, "").toUpperCase()
        };
        row.__gmSig = sig;
        row.__gmCand = cand;
        return cand;
      }
    }
    const tm = text.match(timeRe);
    let cand = null;
    if (tm) {
      const flat = norm(text);
      const days = parseDaysBefore(flat, flat.indexOf(tm[1]));
      if (days) {
        cand = {
          days: days.replace(/\s+/g, ""),
          start: tm[1].replace(/\s+/g, "").toUpperCase(),
          end: tm[2].replace(/\s+/g, "").toUpperCase()
        };
      }
    }
    row.__gmSig = sig;
    row.__gmCand = cand;
    return cand;
  }



  



  /* §5 — GOLD course blocks are two-tier and the old code marked every timed row
     independently. That produced a green ✓ on a discussion whose lecture was
     already full, which is not a small inaccuracy: it tells the student they can
     take a class they cannot enrol in at all. */
  /* v11 1.3 / 1.4 — one marker per qualifying SECTION ROW, in that row's own
     actions cell. This supersedes v9's "one marker per course block": with the
     .row wrappers gone, only real sections match, so per-row is no longer noisy
     and each verdict sits next to the button it is about.

     If a row has no actions cell, nothing is placed. The old fallback to "first
     td or div" is exactly what put a marker beside the student's name. */
  /* ============ v13 §0 — WHY MOST GRID BUTTONS WERE DEAD ============
     The old rule was "the last direct child containing input/button/select/
     a[href]". Measured against a GOLD-shaped result set, that put the button in
     the wrong place on 5 of 10 rows, for two separate reasons:

     1. GOLD wraps every room name in a map link —
        <a href="https://map.ucsb.edu/...">Girvetz Hall, 2115</a> — which
        satisfies a[href]. So the LOCATION cell was returned as the "actions
        cell", and the marker landed mid-row immediately after the room name.
        That is exactly where the dead buttons appeared in the student's
        screenshot.
     2. The real controls sit inside <div id="actions-XXXXX" class="collapse">.
        When that div is a direct child of the row it was returned as-is — and a
        Bootstrap .collapse is display:none until expanded, so the button placed
        inside it measured 0x0 and could not be clicked or even seen.

     The fix identifies the cell by WHAT IT CONTAINS, not by whether something in
     it happens to be a link. */
  const ACTION_LABEL =
    /^(course\s*info|final|add|add to cart|save to cart|modify|modify cart|remove|drop)$/i;

  const isMapLink = (el) => {
    if (el.tagName !== "A") return false;
    const href = el.getAttribute("href") || "";
    // Relative or javascript: hrefs can't be a map link; only judge real URLs.
    try { return /(^|\.)map\.ucsb\.edu$/i.test(new URL(el.href, location.href).hostname); }
    catch { return /map\.ucsb\.edu/i.test(href); }
  };

  const controlLabel = (el) =>
    norm((el.tagName === "INPUT" || el.tagName === "BUTTON") && el.value
      ? el.value
      : el.textContent);

  /* A collapsed Bootstrap panel is display:none. Anything placed inside one has
     a zero-size rect: invisible to the student and unclickable, while still
     passing every isConnected assertion. Both the Bootstrap 4/5 (.show) and 3
     (.in) expanded markers count as open. */
  function inHiddenCollapse(el, row) {
    for (let n = el; n && n !== row.parentElement; n = n.parentElement) {
      if (!n.classList || !n.classList.contains("collapse")) continue;
      if (n.classList.contains("show") || n.classList.contains("in")) continue;
      return true;
    }
    return false;
  }

  /* v13 /premortem — the shape that would still have failed.
     inHiddenCollapse only knows the word "collapse". A cell GOLD hides some
     other way — the `hidden` attribute, a department stylesheet, its own utility
     class — would still have swallowed the button, and the student would report
     exactly the same bug again. So ask the browser what is actually displayed
     rather than pattern-matching the one class name we happen to know.
     getComputedStyle is absent in no browser; jsdom reports everything as
     displayed, which is why the .collapse check above stays as well. */
  function isDisplayed(el) {
    if (!el) return false;
    if (el.hidden) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
    } catch { /* no view: fall through and trust the class check */ }
    return true;
  }

  function actionsCellOf(row) {
    // Whole subtree, not row.children: GOLD nests the real controls several
    // levels down and row.children never reaches them.
    const controls = [...row.querySelectorAll("input, button, select, a[href]")];
    let best = null;
    for (const c of controls) {
      if (c.closest(".gm-marker, .gm-pill-wrap")) continue;   // our own
      if (isMapLink(c)) continue;                    // a room name is not an action
      if (inHiddenCollapse(c, row)) continue;        // can't click what isn't displayed
      if (!isDisplayed(c)) continue;                 // ...however it was hidden

      // Modify Cart picks a discussion with a bare checkbox and no label, so it
      // is admitted on its own terms; everything else must actually say what it
      // does. This is what stops a stray link from claiming the row.
      const isBareChoice = c.tagName === "INPUT" && /^(checkbox|radio)$/i.test(c.type);
      if (!isBareChoice && !ACTION_LABEL.test(controlLabel(c))) continue;

      // the cell is the control's nearest ancestor that is a direct child of row
      let cell = c;
      while (cell.parentElement && cell.parentElement !== row) cell = cell.parentElement;
      if (cell.parentElement !== row) continue;
      if (inHiddenCollapse(cell, row)) continue;
      if (!isDisplayed(cell)) continue;
      best = cell;                                   // rightmost qualifying cell wins
    }
    return best;
  }

  /* v13 §0.3 — when no cell qualifies, the marker goes at the END OF THE ROW,
     aligned right. Never "any cell with a link", which is what put a marker next
     to the student's name in v10 and beside the room name in v12.
     This is safe now in a way it was not then: sectionRows() already whitelists
     real GOLD section rows that carry a parseable day+time and name a course, so
     nothing outside a course row ever reaches here. */
  function rowEndCell(row) {
    let holder = row.querySelector(":scope > .gm-cell");
    if (holder) return holder;

    /* v13 /premortem — on a table page, appending a <td> to SOME rows and not
       others gives the table a ragged column count, which is the fault v9 hit
       when it created a cell on every row up front. A <tr> may only contain
       cells, so instead of adding one, use the last cell the row already has.
       Only a row with no cells at all gets a new one, and a row with no cells is
       not a table row in any meaningful sense. */
    if (row.tagName === "TR") {
      const cells = row.querySelectorAll(":scope > td, :scope > th");
      if (cells.length) {
        holder = document.createElement("span");
        holder.className = "gm-cell gm-row-end";
        cells[cells.length - 1].appendChild(holder);
        return holder;
      }
      holder = document.createElement("td");
      holder.className = "gm-cell";
      row.appendChild(holder);
      return holder;
    }

    holder = document.createElement("span");
    holder.className = "gm-cell gm-row-end";
    row.appendChild(holder);
    return holder;
  }

  function scanForConflicts() {
    if (!state.schedule.length) return;

    for (const row of sectionRows()) {
      // v13 §0.3: no qualifying actions cell is no longer a reason to show the
      // student nothing — the marker goes at the end of the row instead.
      const cell = actionsCellOf(row) || rowEndCell(row);

      // Already decided and the marker survived? Leave it alone.
      if (row.getAttribute("data-gm-conflict-checked") === "1" && row.querySelector(".gm-marker")) continue;

      // Otherwise re-decide from scratch, so a postback can't leave a stale or
      // duplicated verdict behind.
      row.querySelectorAll(".gm-marker").forEach((n) => n.remove());
      row.classList.remove("gm-conflict-row");

      const cand = candidateOf(row);
      const conflicts = findConflicts(cand);
      if (conflicts.length) {
        const detail = "clashes with " + conflictDetail(conflicts);
        row.classList.add("gm-conflict-row");
        placeInCell(cell, cand, "gm-conflict-badge", "✗", detail, true);
      } else {
        placeInCell(cell, cand, "gm-fits-badge", "✓",
          "looks clear, nothing else is on those hours", false);
      }
      row.setAttribute("data-gm-conflict-checked", "1");
    }
  }

  /* SHIP 1.1 — the week grid is REMOVED, not disabled.
     It was rewritten four times and still missed on most rows; a button that
     does nothing costs more trust than the panel ever earned. What stays is the
     marker, which is the part that actually answers the question a student has
     while scrolling: does this section clash with what I already have.
     `cand` is still passed in because the caller computes it either way and the
     signature is shared with the conflict path; it is not used here. */
  function placeInCell(cell, cand, cls, mark, detail, isClash) {
    cell.appendChild(buildMarker({ cls, mark, detail, aria: detail }));
  }





  

  

  



  /* ============ IMPORTANT DATES + PASS WINDOWS ============ */

  function captureImportantDates() {
    // Collapse spaces/tabs but keep newlines for the per-line anchor: GOLD pads
    // labels and dates with runs of literal spaces.
    const text = (document.body.innerText || "").replace(/[ \t]+/g, " ");
    if (!/Registration Pass|Last [Dd]ay/.test(text)) return;

    capturePassWindows(text);

    const re = /^([A-Z][^:\n]{3,60}):\s*(\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2}\s*[AP]M)?)/gm;
    const dates = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const when = new Date(m[2]);
      if (isNaN(when.getTime())) continue;
      dates.push({ label: norm(m[1]), when: when.getTime(), raw: norm(m[2]) });
    }
    if (dates.length) safeSend({ type: "importantDates", payload: dates });
  }

  /* C1: which pass are we in? The cap depends on it (Pass 1 is far tighter), so
     we have to know before we can warn about units. */
  function capturePassWindows(text) {
    const re = /Registration\s+Pass\s+([123])\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2}\s*[AP]M)?)(?:\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2}\s*[AP]M)?))?/gi;
    const windows = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = new Date(m[2]).getTime();
      const end = m[3] ? new Date(m[3]).getTime() : start;
      if (isNaN(start)) continue;
      windows.push({ pass: parseInt(m[1], 10), start, end: isNaN(end) ? start : end });
    }
    if (!windows.length) return;
    const now = Date.now();
    const live = windows.find((w) => now >= w.start && now <= w.end);
    const next = windows.filter((w) => w.start > now).sort((a, b) => a.start - b.start)[0];
    const last = windows.sort((a, b) => a.start - b.start)[windows.length - 1];
    const pass = (live || next || last).pass;
    state.currentPass = pass;
    // Only currentPass is consumed; the raw windows were dead weight in storage.
    safeLocalSet({ currentPass: pass });
  }

  /* ============ C1: THE REAL UNIT CAP ============ */
  /* GOLD prints it on Registration Info as, verbatim:
       "0.0 (16.0 max for Pass 1, 24.0 max for Pass 2)"
     UCSB cut Pass 1 to 10 units in Winter 2022 and broke a lot of people's
     full-time status, so the cap is read from GOLD every time — never hardcoded,
     never assumed to be the old 12–19 range. */
  function parseUnitCaps(text) {
    const re = /([0-9]+(?:\.[0-9]+)?)\s*max\s*for\s*Pass\s*([123])/gi;
    const caps = {};
    let m;
    while ((m = re.exec(String(text || ""))) !== null) {
      caps["pass" + m[2]] = parseFloat(m[1]);
    }
    return Object.keys(caps).length ? caps : null;
  }

  function unitCapLabelIn(root) {
    return root.querySelector(
      "#pageContent_MaximumStudyLoadLabel, [id$='MaximumStudyLoadLabel'], [id*='MaximumStudyLoad']"
    );
  }

  function captureUnitCaps() {
    const el = unitCapLabelIn(document);
    if (!el) return null;
    const caps = parseUnitCaps(norm(el.textContent));
    if (!caps) return null;
    state.unitCaps = caps;
    safeLocalSet({ unitCaps: caps, unitCapsAt: Date.now() });
    return caps;
  }

  /* C4: this is also our GOLD liveness probe. A network-level failure here means
     GOLD itself is unreachable — it has gone fully down during pass time before —
     and the student needs to be told that plainly rather than watching GOLDmine
     quietly render nothing and look broken. */
  const CAP_REFETCH_MS = 6 * 60 * 60 * 1000;

  async function ensureUnitCaps() {
    if (state.page === "info") return;          // already read from this page
    if (state.unitCaps) return;
    const cached = await safeLocalGet({ unitCaps: null, unitCapsAt: 0 });
    if (cached.unitCaps) { state.unitCaps = cached.unitCaps; return; }
    if (cached.unitCapsAt && Date.now() - cached.unitCapsAt < CAP_REFETCH_MS) return;

    // No fetch at all is a broken environment, not a GOLD outage. Claiming
    // "GOLD is down" here would be us blaming GOLD for our own problem.
    if (typeof fetch !== "function") return;

    let res;
    try {
      res = await fetch(new URL("/gold/RegistrationInfo.aspx", location.origin).href, {
        credentials: "include"
      });
    } catch {
      noteGoldUnreachable();                    // a rejected fetch === no network path to GOLD
      return;
    }
    // 5xx / 0 means GOLD is down. A 401/403 means our session expired, which is a
    // different problem with a different fix, so don't lump them together.
    if (!res) { noteGoldUnreachable(); return; }
    if (res.status === 401 || res.status === 403) {
      renderStatus("gold-signed-out", "looks like GOLD signed you out. reload and sign in, we'll pick right back up.");
      return;
    }
    if (!res.ok) { noteGoldUnreachable(); return; }

    try {
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const el = unitCapLabelIn(doc);
      const caps = el ? parseUnitCaps(norm(el.textContent)) : null;
      if (caps) { state.unitCaps = caps; safeLocalSet({ unitCaps: caps, unitCapsAt: Date.now() }); }
      else safeLocalSet({ unitCapsAt: Date.now() });   // don't re-fetch on a loop
      clearGoldTrouble();
      if (shouldShowPeek()) renderPeek();
    } catch {
      // We reached GOLD but couldn't read it — that's on us, not on GOLD, and it
      // isn't worth a scary banner. The peek says the cap is unknown instead.
      safeLocalSet({ unitCapsAt: Date.now() });
    }
  }

  /* ============ C4: STATUS SURFACE ============ */

  function noteGoldUnreachable() {
    state.goldTrouble = "gold-unreachable";
    renderStatus("gold-unreachable",
      "GOLD isn't answering right now. that's GOLD, not us. " +
      "Your saved schedule and ratings still work.");
  }

  function noteStorageTrouble() {
    if (state.storageTrouble) return;   // one notice, not one per write
    state.storageTrouble = true;
    state.goldTrouble = "storage";
    renderStatus("storage",
      "Chrome won't let us save right now, so your schedule may be out of date. " +
      "Everything on this page still works.");
  }

  function clearGoldTrouble() {
    if (state.goldTrouble !== "gold-unreachable") return;  // don't clear a storage notice
    state.goldTrouble = false;
    document.querySelectorAll("[data-gm-status='gold-unreachable'], .gm-cell").forEach((n) => n.remove());
  }

  /* The student dismissed it — respect that for the rest of the page, rather
     than resurrecting the same bar on the next scan. */
  const dismissedStatus = new Set();

  function renderStatus(kind, message) {
    if (dismissedStatus.has(kind)) return;
    if (document.querySelector("[data-gm-status='" + kind + "']")) return;
    const bar = mk("div", {
      class: "gm-status gm-status-" + kind + (state.dark ? " gm-dark" : ""),
      role: "status", "data-gm-status": kind
    },
      mk("span", { class: "gm-status-dot", "aria-hidden": "true" }),
      mk("span", { class: "gm-status-text", text: message })
    );
    const close = mk("button", { class: "gm-status-close", type: "button", "aria-label": "Dismiss", text: "×" });
    close.addEventListener("click", () => { dismissedStatus.add(kind); bar.remove(); });
    bar.appendChild(close);
    document.body.appendChild(bar);
  }

  /* Conflict checking is silent until we've seen a schedule. Without this the
     student sees no ✗ and no ✓ and cannot tell "everything fits" from "GOLDmine
     isn't working". Say which it is. */
  function noteNoScheduleYet() {
    if (state.schedule.length) return;
    if (!state.settings.conflicts) return;
    if (state.page !== "search" && state.page !== "cart") return;
    renderStatus("no-schedule",
      "Pop over to My Schedule once and we'll start flagging clashes here.");
  }

  /* ============ MAJOR PROGRESS CHECK (GE requirements) ============ */
  function normalizeReqLabel(s) {
    const m = s.match(/Area\s+([A-G])/i);
    if (m) return "Area " + m[1].toUpperCase();
    if (/writing/i.test(s)) return "Writing";
    if (/quantitative/i.test(s)) return "Quantitative";
    if (/world cultures/i.test(s)) return "World Cultures";
    if (/ethnicity/i.test(s)) return "Ethnicity";
    if (/european/i.test(s)) return "European Traditions";
    return s.trim();
  }

  function captureProgressCheck() {
    const text = document.body.innerText || "";
    if (!/Progress Check|Major Progress|General Education Requirement/i.test(text)) return;
    const NAMED = /(Area\s+[A-G]\b|Writing(?:\s+Requirement)?|Quantitative(?:\s+Relationships)?|World Cultures|Ethnicity|European Traditions)/i;
    const remaining = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const nm = line.match(NAMED);
      if (!nm) continue;
      const met = /✓|satisfied|complete|\byes\b/i.test(line);
      const unmet = /✗|\bno\b|not\s+satisfied|incomplete|in\s+progress|remaining|needed/i.test(line);
      if (unmet && !met) {
        const label = normalizeReqLabel(nm[1]);
        if (!remaining.includes(label)) remaining.push(label);
      }
    }
    safeLocalSet({ geRemaining: remaining });
  }

  /* ============ FINAL EXAMS ============ */
  function captureFinals() {
    const finals = [];
    const blocks = document.querySelectorAll(".finalBlock");
    if (blocks.length) {
      blocks.forEach((block) => {
        const header = block.querySelector(".fontbold");
        const headerText = norm(header?.textContent);
        // No .fontbold is a real shape — fall back to the block's own text rather
        // than dropping the final. A missing final is invisible to the student:
        // they just believe they don't have one.
        const course = parseCourseCode(headerText) ||
                       parseCourseCode(norm(block.innerText || block.textContent));
        if (!course) return;
        let dt = norm(block.innerText || block.textContent);
        dt = headerText ? dt.replace(headerText, "").trim() : stripLeadingCode(dt, course);
        if (/contact\s+professor/i.test(dt)) {
          finals.push({ course, date: null, start: null, end: null, datetime: null, raw: "Contact Professor for Final Exam Information" });
          return;
        }
        const dm = dt.match(/([A-Za-z]+\s+\d{1,2}),?\s+(\d{4})/); // "December 10, 2026"
        const tm = dt.match(/(\d{1,2}:\d{2}\s*[AP]M)\s*[-–]\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
        finals.push({
          course,
          date: dm ? norm(dm[1] + " " + dm[2]) : null,
          start: tm ? tm[1].replace(/\s+/g, "").toUpperCase() : null,
          end: tm ? tm[2].replace(/\s+/g, "").toUpperCase() : null,
          datetime: dt || null,
          raw: dt || null
        });
      });
    } else {
      const text = document.body.innerText || "";
      if (!/final exam/i.test(text)) return;
      const dtRe = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*[-–]\s*(\d{1,2}:\d{2}\s*[AP]M)/i;
      for (const raw of text.split("\n")) {
        const course = parseCourseCode(raw);
        if (!course) continue;
        const dm = raw.match(dtRe);
        if (dm) {
          finals.push({
            course,
            date: dm[1],
            start: dm[2].replace(/\s+/g, "").toUpperCase(),
            end: dm[3].replace(/\s+/g, "").toUpperCase(),
            datetime: dm[0], raw: dm[0]
          });
        } else if (/contact\s+professor/i.test(raw)) {
          // A final with no scheduled time is still a final. Dropping it (v7) left
          // the student's Finals list quietly incomplete.
          finals.push({
            course, date: null, start: null, end: null, datetime: null,
            raw: "Contact Professor for Final Exam Information"
          });
        }
      }
    }
    if (!finals.length) return;

    const conflicts = [];
    for (let i = 0; i < finals.length; i++) {
      for (let j = i + 1; j < finals.length; j++) {
        if (!finals[i].date || !finals[j].date || finals[i].date !== finals[j].date) continue;
        const s1 = to24h(finals[i].start), e1 = to24h(finals[i].end);
        const s2 = to24h(finals[j].start), e2 = to24h(finals[j].end);
        if (s1 != null && e1 != null && s2 != null && e2 != null && s1 < e2 && s2 < e1) {
          conflicts.push([finals[i].course, finals[j].course]);
        }
      }
    }
    safeLocalSet({ finals, finalsConflicts: conflicts });
  }

  /* ================== PEEK WIDGET ================== */

  const fmtUnits = (n) => (n % 1 ? n.toFixed(1) : String(n));

  /* C1: warn against the cap GOLD actually published for the pass the student is
     in. No hardcoded 12–19 band — that number has already been wrong once. */
  function capForCurrentPass() {
    if (!state.unitCaps || !state.currentPass) return null;
    const cap = state.unitCaps["pass" + state.currentPass];
    // GOLD only publishes caps for the passes it lists. Mid-quarter (or in Pass 3)
    // there may be no cap for the pass we're in — that's "unknown", not "fine".
    return typeof cap === "number" ? cap : null;
  }

  function unitVerdict(total) {
    const cap = capForCurrentPass();
    if (cap != null && total > cap) {
      return {
        warn: true,
        label: "over the Pass " + state.currentPass + " cap (" + fmtUnits(cap) + ")",
        suffix: ""
      };
    }
    if (total > 0 && total < 12) return { warn: true, label: "under full-time (12)", suffix: "" };
    return { warn: false, label: "units", suffix: "" };
  }

  function renderPeek() {
    removePeek();

    const totalUnits = state.schedule.reduce((s, c) => s + (Number(c.units) || 0), 0);
    const verdict = unitVerdict(totalUnits);

    const peek = mk("div", { class: "gm-peek" + (state.dark ? " gm-dark" : "") });

    const head = mk("div", { class: "gm-peek-head" },
      /* v13 §7.1 — the diamond that used to sit here was a rotated square with
         no job: it stated nothing, it just decorated a header, which is the
         exact tell the popup's own section labels had removed a version ago.
         The label is lowercase for the same reason every other label is. */
      mk("div", { class: "gm-peek-title" }, "your schedule"),
      mk("span", { class: "gm-peek-btns" },
        mk("button", { class: "gm-peek-compact", type: "button", "aria-label": "Compact view", title: "compact", text: "▫" }),
        mk("button", { class: "gm-peek-toggle", type: "button", "aria-label": "Collapse", title: "minimize", text: "–" })
      )
    );

    const body = mk("div", { class: "gm-peek-body" });
    for (const c of state.schedule) {
      body.appendChild(mk("div", { class: "gm-peek-class" },
        mk("div", { class: "gm-peek-code", text: c.course || "" }),
        mk("div", { class: "gm-peek-when" },
          mk("span", { class: "gm-peek-days", text: c.days || "TBA" }),
          mk("span", { class: "gm-peek-time", text: (c.start || "") + (c.end ? "–" + c.end : "") })
        )
      ));
    }

    if (totalUnits > 0) {
      body.appendChild(mk("div", { class: "gm-peek-units" + (verdict.warn ? " gm-units-warn" : "") },
        mk("span", { text: verdict.label }),
        mk("span", { class: "gm-units-num", text: fmtUnits(totalUnits) + verdict.suffix })
      ));
      // Say so when we don't know the cap, rather than staying silent and letting
      // the student assume we checked.
      if (totalUnits >= 12 && capForCurrentPass() == null) {
        body.appendChild(mk("div", { class: "gm-peek-caphint",
          text: "unit cap unknown. open Registration Info once and we'll pick it up" }));
      }
    }

    const staleDays = state.scheduleCapturedAt
      ? Math.floor((Date.now() - state.scheduleCapturedAt) / 86400000) : null;
    // A ✓ is only as good as the schedule it was checked against. Say how old
    // that is rather than letting the marker imply it is current.
    if (staleDays !== null && staleDays >= 3) {
      body.appendChild(mk("div", { class: "gm-peek-stale" },
        mk("span", { text: "checked against your schedule from " + staleDays + " days ago" }),
        mk("a", { href: "/gold/StudentSchedule.aspx", text: "refresh" })
      ));
    }

    body.appendChild(mk("div", { class: "gm-peek-total" },
      mk("span", { text: state.schedule.length + " class" + (state.schedule.length === 1 ? "" : "es") }),
      mk("a", { href: "/gold/StudentSchedule.aspx", text: "full schedule" })
    ));

    peek.appendChild(head);
    peek.appendChild(body);
    document.body.appendChild(peek);

    const toggle = peek.querySelector(".gm-peek-toggle");
    const compact = peek.querySelector(".gm-peek-compact");
    toggle.addEventListener("click", () => {
      const collapsed = peek.classList.toggle("gm-peek-collapsed");
      toggle.textContent = collapsed ? "+" : "–";
      body.style.display = collapsed ? "none" : "";
    });
    compact.addEventListener("click", () => {
      peek.classList.toggle("gm-peek-compact-on");
    });
  }

  function removePeek() {
    document.querySelectorAll(".gm-peek").forEach((n) => n.remove());
  }

  function removeAllInjected() {
    document.querySelectorAll(
      ".gm-pill-wrap, .gm-marker, .gm-conflict-badge, .gm-fits-badge, " +
      ".gm-final-badge, .gm-waitlist-badge, .gm-ge-badge, .gm-prereq-badge, .gm-prereq-list, " +
      ".gm-waitlist-hint, .gm-pill-holder, .gm-status"
    ).forEach((n) => n.remove());

    // Unwrap in-place spans back to plain text.
    document.querySelectorAll(".gm-seat").forEach((n) => {
      const t = document.createTextNode(n.textContent);
      n.replaceWith(t);
      t.parentNode?.normalize?.();
    });

    for (const attr of ["data-gm-prof-done", "data-gm-prof", "data-gm-about", "data-gm-course", "data-gm-marked",
                        "data-gm-title", "data-gm-meta"]) {
      document.querySelectorAll("[" + attr + "]").forEach((n) => n.removeAttribute(attr));
    }
    document.querySelectorAll(".gm-closed-row").forEach((n) => n.classList.remove("gm-closed-row"));
    document.querySelectorAll("[data-gm-conflict-checked]").forEach((n) => {
      n.removeAttribute("data-gm-conflict-checked");
      n.classList.remove("gm-conflict-row");
    });
    removePeek();
  }

  boot();
})();
