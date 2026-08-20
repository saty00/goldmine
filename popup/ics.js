/* ============================================================
   GOLDmine .ics calendar generator (standalone, unit-testable)
   Sessions-aware: emits one VEVENT per meeting (lecture AND
   discussion), falling back to a course's flat days/start/end
   when it has no sessions[] array.
   ============================================================ */
(function (root) {
  "use strict";
  const DAY_TO_JS = { M: 1, T: 2, W: 3, R: 4, F: 5 };
  const DAY_TO_ICS = { M: "MO", T: "TU", W: "WE", R: "TH", F: "FR" };
  const pad2 = (n) => String(n).padStart(2, "0");
  const icsEsc = (s) => String(s).replace(/[\\;,]/g, (m) => "\\" + m).replace(/\n/g, "\\n");

  function parseHM(s) {
    const m = String(s || "").match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ap = m[3].toUpperCase();
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return { h, min };
  }

  function sessionsOf(c) {
    return (c.sessions && c.sessions.length)
      ? c.sessions
      : [{ days: c.days, start: c.start, end: c.end }];
  }

  function buildIcs(schedule) {
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//GOLDmine//UCSB//EN",
      "CALSCALE:GREGORIAN", "METHOD:PUBLISH"
    ];
    const now = new Date();
    const stamp = now.getUTCFullYear() + pad2(now.getUTCMonth() + 1) + pad2(now.getUTCDate()) +
      "T" + pad2(now.getUTCHours()) + pad2(now.getUTCMinutes()) + pad2(now.getUTCSeconds()) + "Z";
    let uid = 0;

    (schedule || []).forEach((c) => {
      for (const sess of sessionsOf(c)) {
        const days = String(sess.days || "").toUpperCase().replace(/[^MTWRF]/g, "");
        const start = parseHM(sess.start);
        const end = parseHM(sess.end);
        if (!days || !start || !end) continue;

        const daySet = [...new Set(days.split(""))].filter((d) => DAY_TO_JS[d]);
        if (!daySet.length) continue;

        // First occurrence: next date matching the earliest listed day.
        const firstDay = DAY_TO_JS[daySet[0]];
        const d0 = new Date(now);
        d0.setHours(start.h, start.min, 0, 0);
        let delta = (firstDay - d0.getDay() + 7) % 7;
        if (delta === 0 && d0 < now) delta = 7;
        d0.setDate(d0.getDate() + delta);

        const dtDate = d0.getFullYear() + pad2(d0.getMonth() + 1) + pad2(d0.getDate());
        const dtStart = dtDate + "T" + pad2(start.h) + pad2(start.min) + "00";
        const dtEnd = dtDate + "T" + pad2(end.h) + pad2(end.min) + "00";
        const byday = daySet.map((d) => DAY_TO_ICS[d]).join(",");

        lines.push(
          "BEGIN:VEVENT",
          "UID:goldmine-" + (uid++) + "-" + now.getTime() + "@ucsb",
          "DTSTAMP:" + stamp,
          "SUMMARY:" + icsEsc(c.course + (c.title ? " — " + c.title : "")),
          "DTSTART;TZID=America/Los_Angeles:" + dtStart,
          "DTEND;TZID=America/Los_Angeles:" + dtEnd,
          "RRULE:FREQ=WEEKLY;BYDAY=" + byday + ";COUNT=11",
          "END:VEVENT"
        );
      }
    });

    lines.push("END:VCALENDAR");
    return lines.join("\r\n");
  }

  root.buildIcs = buildIcs;
})(typeof self !== "undefined" ? self : globalThis);
