# GOLDmine — security and privacy audit

This is the audit for the shipped build (`manifest.json` version 13.0.0). Every
claim below is checked by the test suite (`npm test`, see `SHIP 2` and
`SHIP 1.2`), so it fails loudly if it stops being true.

---

## For a student, in plain English

GOLDmine can read the GOLD pages you have open, because that is the only way to
tell you a section clashes with a class you already have. It keeps your
schedule, your settings and a cache of professor ratings **on your own computer**
and nowhere else.

It sends exactly one kind of request off your machine: a professor's name to
RateMyProfessors, to look up their rating. That request contains the name and
UCSB's school ID. It does not contain you: not your name, not your perm number,
not your NetID, not the page you were on, not your schedule, not a login cookie.

There is no analytics, no tracking, no crash reporting, no advertising, and no
third party of any kind. Nobody is paid for your data because none of it is
collected. Removing the extension deletes everything it stored.

---

## 1. Data inventory

### 1.1 Read from the page

| what | where from | why | leaves device? |
|---|---|---|---|
| Course codes, days, times, locations, seat counts | GOLD pages you open | to detect clashes and show the peek panel | **no** |
| Instructor names | GOLD `Instructor` labels | to look up a rating | **the surname only**, to RMP |
| Final exam dates and times | GOLD Finals page | to warn about two finals at once | **no** |
| Registration deadlines and pass windows | GOLD Registration Info | countdown and reminders | **no** |
| Unit cap string | GOLD Registration Info | to flag going over your cap | **no** |
| Prerequisite text | GOLD PreRequisites tab | shown inline on the course | **no** |

The extension never reads your name, perm number, NetID, password, grades, GPA,
financial aid, or anything on a page outside `my.sa.ucsb.edu/gold/`.

### 1.2 Stored on the device

All of it is `chrome.storage.local`, which is local to the browser profile and is
**not** synced to a Google account.

| key | holds | why |
|---|---|---|
| `savedSchedule` | your enrolled courses, days, times | the thing every clash check is compared against |
| `scheduleCapturedAt` | timestamp | so a stale ✓ can say how old it is |
| `finals`, `finalsConflicts` | final exam times, overlapping pairs | the finals warning |
| `importantDates` | registration deadlines | countdown and reminders |
| `currentPass`, `unitCaps`, `unitCapsAt` | which pass you are in, your unit cap | the unit warning |
| `geRemaining` | GE areas still outstanding | the "still need" panel |
| `email` | an `@ucsb.edu` address, **only if you type one in** | optional, so the popup can greet a returning user. Never transmitted. |
| `reminders`, `darkMode`, `tipIndex` | your settings | preferences |
| `p\|LASTNAME\|I` | a cached RMP rating | so the same professor is not looked up twice |

`chrome.storage.sync` holds **three booleans only** — `ratings`, `peek`,
`conflicts` — the on/off switches in the popup. No schedule data is ever written
to sync, which is what would carry it to a Google account.

### 1.3 Transmitted

**One outbound destination: `https://www.ratemyprofessors.com/graphql`.**

The request body is a GraphQL query whose only variables are the professor's
surname and UCSB's numeric school ID. No student identifier, no page URL, no
session token, no cookies of yours, no analytics payload.

Two other `fetch` calls exist and neither leaves your machine or your session:

- `chrome.runtime.getURL("data/ratings.json")` — reads a file bundled inside the
  extension. Scheme is `chrome-extension://`; it never touches the network.
- `new URL("/gold/RegistrationInfo.aspx", location.origin)` — a same-origin
  request back to GOLD, using the session you are already signed in to, to read
  your unit cap. It goes to the same server the page came from and to nowhere
  else. The origin comes from the browser, never from page text.

---

## 2. Grep output

### 2.1 Every network primitive in the shipped code

```
$ grep -rn "fetch(\|XMLHttpRequest\|sendBeacon\|WebSocket\|import(" content/ background/ popup/
background/background.js:73:  const res = await fetch(RMP_URL, {
content/content.js:940:      const res = await fetch(chrome.runtime.getURL("data/ratings.json"));
content/content.js:1580:      res = await fetch(new URL("/gold/RegistrationInfo.aspx", location.origin).href, {
```

Three hits, each justified in §1.3 above. Zero `XMLHttpRequest`, zero
`sendBeacon`, zero `WebSocket`, zero dynamic `import()`.

### 2.2 Injection sinks

```
$ grep -rn "innerHTML\|outerHTML\|insertAdjacentHTML\|document.write" content/ background/ popup/
content/content.js:540:  /* Wrap a substring of a text node in a styled span — no innerHTML. */
content/content.js:1024:  /* Tiny DOM builder so injected UI never touches innerHTML with GOLD/RMP text. */

$ grep -rn "eval(\|new Function\|setTimeout(\"\|setInterval(\"" content/ background/ popup/
(no hits)

$ grep -rniE 'on(click|load|error|change|submit|mouse|key)\w*\s*=\s*"' content/ popup/ background/
(no hits)

$ grep -rn "console\." content/ background/ popup/
(no hits)
```

The only two `innerHTML` hits are comments stating that it is not used. Every
value taken from GOLD or RMP reaches the DOM through `textContent` or
`createElement`, via one small builder (`mk()` in `content/content.js`).

---

## 3. Permissions, mapped to the call that needs them

| permission | required by | verdict |
|---|---|---|
| `storage` | `chrome.storage.local.*` (19 call sites) — the saved schedule, settings, rating cache | **keep** |
| `alarms` | `chrome.alarms.create` / `clearAll` / `onAlarm` in `background/background.js` — deadline reminders | **keep**, the feature ships and is toggleable in the popup |
| `notifications` | `chrome.notifications.create` in the `onAlarm` handler — the reminder itself | **keep**, same feature |
| `https://my.sa.ucsb.edu/*` | the content script, and the same-origin Registration Info read | **keep** |
| `https://www.ratemyprofessors.com/*` | the rating lookup | **keep** |

Nothing was over-scoped: there is no `tabs`, no `scripting`, no `cookies`, no
`webRequest`, no `<all_urls>`. `chrome.tabs` and `chrome.scripting` appear zero
times in the source.

**`content_scripts.matches` stays `https://my.sa.ucsb.edu/gold/*`** rather than an
enumerated page list. `detectPage()` matches twelve URL patterns and then falls
back to reading the page heading, precisely because GOLD's URLs are not stable
across its sections. Narrowing the match list would silently disable the
extension on pages it currently handles, which is a worse outcome than a match
pattern already scoped to one path on one host.

`web_accessible_resources` contains exactly one entry, `data/ratings.json`, which
the content script genuinely fetches as an offline fallback. It is exposed only
to `https://my.sa.ucsb.edu/*`, not to all origins. **Known limitation:** that file
currently ships empty (`[]`), so the offline fallback has nothing to serve; the
UI correctly shows a hatched `?` and says the lookup failed rather than inventing
a rating.

---

## 4. Manifest hardening

- Manifest V3.
- No `content_security_policy` key at all, so nothing is relaxed: no
  `unsafe-eval`, no `unsafe-inline`, no remote script origins.
- `homepage_url` points at the public repository.
- `description` is written for a student, names what the extension does, and
  makes the privacy claim up front.

---

## 5. Hostile-page assumptions

GOLD is a trusted site, but the content script is written as though the page is
not:

- Nothing read from the page is ever executed. There is no `eval`, no
  `new Function`, and no string-bodied timer.
- Page text is never used as a URL, a selector string, or a code path that could
  reach outside a fixed set of internal branches. `detectPage()` tests the page
  heading against literal regexes to choose among five hardcoded outcomes; it
  cannot be steered anywhere else.
- The content script is an IIFE and assigns **nothing** to `window`, so a page
  script has no handle to call into it.
- Stored data lives in `chrome.storage`, which a page script cannot read.

**One disclosed exposure.** The schedule peek panel renders your course codes and
times into the page's DOM, because that is what makes it visible. A script
running on that GOLD page could therefore read what is on screen. This is
inherent to drawing anything on a page and applies to GOLD's own display of the
same information; it is listed here rather than left implicit. Turning the peek
panel off in the popup removes it.

## 6. Failure states

- If RateMyProfessors is unreachable or rate-limits us, the pill renders a
  hatched `?` and the card says the lookup failed. It never renders a number it
  does not have, and it never caches a failure as if it were a rating.
- If your GOLD session has expired, the extension says so and asks you to sign in
  again, and distinguishes that (401/403) from GOLD being down (5xx).
- No error message includes personal data, and no request contents are echoed
  back to the screen.
- The shipped build writes nothing to the console, so a screenshot of devtools
  cannot leak what you were looking at.

## 7. Dependencies

Zero runtime dependencies.

```
$ npm ls --omit=dev
goldmine@13.0.0
`-- (empty)
```

`jsdom` is a `devDependency`, used only by the test suite, and is not part of the
packaged extension.

The one external asset loaded at runtime is the **Bricolage Grotesque** webfont
from Google Fonts, requested by CSS `@import`. A webfont request carries the
usual HTTP metadata (your IP and user agent) to Google, as any web page's font
would; it carries no GOLDmine data, no schedule, and no identifier of yours.

---

## Reporting a vulnerability

Open an issue at the repository, or email **satyaichin@gmail.com**. If the issue
is sensitive, say so in the first message and do not include screenshots
containing your own registration data.
