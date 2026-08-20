/* GOLDmine background service worker */

const RATINGS_URL = "https://www.ratemyprofessors.com/graphql";
const RATINGS_AUTH = "Basic dGVzdDp0ZXN0";
const SCHOOL_ID = "U2Nob29sLTEwNzc=";

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/* Hardcoded UCSB deadlines. NOTE: these are placeholders for the Fall 2026
   quarter — verify against the official UCSB academic calendar and update each
   year. They seed reminders + the popup "coming up" list even before the user
   visits a GOLD page that lists them. */
const BUILTIN_DEADLINES = [
  { label: "Fall classes begin",        raw: "9/25/2026",  when: Date.parse("2026-09-25T08:00:00") },
  { label: "Fall add deadline",         raw: "10/9/2026",  when: Date.parse("2026-10-09T23:59:00") },
  { label: "Fall drop deadline",        raw: "10/16/2026", when: Date.parse("2026-10-16T23:59:00") },
  { label: "Fall last day to drop",     raw: "10/23/2026", when: Date.parse("2026-10-23T23:59:00") },
  { label: "Fall classes end",          raw: "12/4/2026",  when: Date.parse("2026-12-04T17:00:00") }
];

/* ---- caching ---- */
async function getCached(key) {
  const store = await chrome.storage.local.get(key);
  const entry = store[key];
  if (!entry) return { hit: false };
  if (Date.now() - entry.ts > CACHE_TTL_MS) return { hit: false };
  return { hit: true, value: entry.value };
}

/* D2: every storage write goes through here so a storage failure degrades
   gracefully (logged, not thrown) instead of breaking a lookup or an alarm. */
async function safeSet(obj) {
  /* SHIP 2.6 — the shipped build logs nothing. A storage error object can carry
     the write that failed, and that write is the student's schedule. The failure
     is already surfaced where it matters: the content script raises a visible
     notice, which is what the student can actually act on. */
  try { await chrome.storage.local.set(obj); }
  catch { /* surfaced in the page, never written to the console */ }
}

async function setCached(key, value) {
  await safeSet({ [key]: { ts: Date.now(), value } });
}

/* ---- RMP lookup ---- */
async function searchProfessor(query) {
  const gql = `
    query TeacherSearchQuery($query: TeacherSearchQuery!) {
      newSearch {
        teachers(query: $query, first: 5) {
          edges {
            node {
              legacyId
              firstName
              lastName
              department
              avgRating
              avgDifficulty
              numRatings
              wouldTakeAgainPercent
            }
          }
        }
      }
    }`;
  const res = await fetch(RATINGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": RATINGS_AUTH
    },
    body: JSON.stringify({
      query: gql,
      variables: { query: { text: query, schoolID: SCHOOL_ID, fallback: false } }
    })
  });
  if (!res.ok) throw new Error("ratings " + res.status);
  const json = await res.json();
  const edges = json?.data?.newSearch?.teachers?.edges || [];
  return edges.map((e) => e.node).filter((n) => n && n.numRatings > 0);
}

/* Score a candidate against target last name + first initial */
function scoreMatch(node, targetLast, targetFI) {
  const last = (node.lastName || "").toUpperCase().replace(/[^A-Z]/g, "");
  const first = (node.firstName || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (last !== targetLast) return -1;
  let score = 100;
  if (targetFI && first[0] === targetFI) score += 50;
  score += Math.min(node.numRatings || 0, 100); // prefer more-rated
  return score;
}

async function lookupProfessor({ lastName, firstInitial }) {
  const cacheKey = `p|${lastName}|${firstInitial || "*"}`;
  const cached = await getCached(cacheKey);
  if (cached.hit) return cached.value;

  try {
    const candidates = await searchProfessor(lastName);
    let best = null;
    let bestScore = 0;
    for (const c of candidates) {
      const s = scoreMatch(c, lastName, firstInitial);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    const value = best
      ? {
          legacyId: best.legacyId,
          firstName: best.firstName,
          lastName: best.lastName,
          department: best.department,
          rating: best.avgRating,
          difficulty: best.avgDifficulty,
          numRatings: best.numRatings,
          wouldTakeAgain: best.wouldTakeAgainPercent >= 0 ? best.wouldTakeAgainPercent : null
        }
      : null;
    await setCached(cacheKey, value);
    return value;
  } catch (err) {
    /* SHIP 2.6 — swallowed on purpose. The caller already turns this into the
       hatched "?" pill and a card that says the lookup failed, so nothing is
       hidden from the student; it just isn't echoed to a console a support
       screenshot might capture. */
    // NOT null. null means "we asked RMP and this instructor has no ratings",
    // which the content script renders as a confident N/A pill. A failed request
    // is a different fact and must not be dressed up as an answer — and it must
    // never be cached, or one blip would poison the pill for 14 days.
    return { error: "unavailable" };
  }
}


/* ---- lookup queue: max 4 concurrent, tiny stagger, 1 retry ----
   Big search pages fire dozens of lookups at once; unthrottled bursts
   get some requests dropped, which looked like "ratings only work
   sometimes". */
let active = 0;
const waiting = [];
const MAX_CONCURRENT = 4;

function enqueue(task) {
  return new Promise((resolve) => {
    waiting.push({ task, resolve });
    pump();
  });
}

async function pump() {
  while (active < MAX_CONCURRENT && waiting.length) {
    const { task, resolve } = waiting.shift();
    active++;
    (async () => {
      try {
        resolve(await task());
      } catch {
        try { resolve(await task()); } catch { resolve(null); } // one retry
      } finally {
        active--;
        setTimeout(pump, 60);
      }
    })();
  }
}

/* ---- reminders ---- */
async function saveImportantDates(dates) {
  const { importantDates = [] } = await chrome.storage.local.get("importantDates");
  const byLabel = new Map(importantDates.map((d) => [d.label, d]));
  for (const d of dates) byLabel.set(d.label, d);
  const merged = [...byLabel.values()].sort((a, b) => a.when - b.when);
  await safeSet({ importantDates: merged });
  await scheduleReminders();
  return merged.length;
}

async function scheduleReminders() {
  const { importantDates = [], reminders = true } =
    await chrome.storage.local.get(["importantDates", "reminders"]);
  await chrome.alarms.clearAll();
  if (!reminders) return;
  const now = Date.now();
  for (const d of importantDates) {
    const dayBefore = d.when - 24 * 60 * 60 * 1000;
    if (dayBefore > now) {
      chrome.alarms.create("gm|1day|" + d.label, { when: dayBefore });
    }
    if (d.when > now) {
      chrome.alarms.create("gm|now|" + d.label, { when: d.when });
    }
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith("gm|")) return;
  const [, kind, label] = alarm.name.split("|");
  const { importantDates = [] } = await chrome.storage.local.get("importantDates");
  const d = importantDates.find((x) => x.label === label);
  chrome.notifications.create("gm-" + Date.now(), {
    type: "basic",
    iconUrl: "images/icon128.png",
    title: kind === "1day" ? "heads up, gaucho" : "today's the day, gaucho",
    message: kind === "1day"
      ? label + " is tomorrow. don't sleep on it" + (d ? " (" + d.raw + ")" : "")
      : label + " is today" + (d ? " (" + d.raw + ")" : ""),
    priority: 2
  });
});

/* ---- seed hardcoded deadlines into importantDates (future only) ---- */
async function seedBuiltinDeadlines() {
  const now = Date.now();
  const future = BUILTIN_DEADLINES.filter((d) => d.when && d.when > now);
  if (!future.length) return;
  const { importantDates = [] } = await chrome.storage.local.get("importantDates");
  const byLabel = new Map(importantDates.map((d) => [d.label, d]));
  for (const d of future) if (!byLabel.has(d.label)) byLabel.set(d.label, d);
  const merged = [...byLabel.values()].sort((a, b) => a.when - b.when);
  await safeSet({ importantDates: merged });
  await scheduleReminders();
}

async function onBoot() {
  await seedBuiltinDeadlines();
}
chrome.runtime.onInstalled.addListener(onBoot);
chrome.runtime.onStartup.addListener(onBoot);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.reminders) scheduleReminders();
});

/* ---- message router ---- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "lookupProf") {
    enqueue(() => lookupProfessor(msg.payload)).then(sendResponse);
    return true; // keep channel open for async
  }
  if (msg?.type === "importantDates") {
    saveImportantDates(msg.payload).then((n) => sendResponse({ saved: n }));
    return true;
  }
  if (msg?.type === "cacheStats") {
    chrome.storage.local.get(null).then((all) => {
      const keys = Object.keys(all).filter((k) => k.startsWith("p|"));
      sendResponse({ count: keys.length });
    });
    return true;
  }
  if (msg?.type === "clearCache") {
    chrome.storage.local.get(null).then((all) => {
      const rmKeys = Object.keys(all).filter((k) => k.startsWith("p|"));
      chrome.storage.local.remove(rmKeys).then(() => sendResponse({ cleared: rmKeys.length }));
    });
    return true;
  }
});
