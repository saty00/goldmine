# GOLDmine — UCSB Schedule Helper

you know the move. GOLD open, three other tabs open, your pass time somewhere in the back of your head. you're refreshing and praying the section you want doesn't fill before you figure out if the professor is worth it.

GOLDmine puts it all in one place.

**not affiliated with UCSB. built by a gaucho.**

---

## what it does

- **prof ratings right on GOLD** — score chips show up next to every instructor name. hover and you get the full card: difficulty, would-take-again, link to reviews.
- **conflict warnings** — red ✗ on anything that clashes with what's already on your schedule, green ✓ if you're clear. find out before you add it, not after.
- **schedule peek** — your current classes float in the corner while you're searching. no more scrolling back to check if Tuesday's already slammed.
- **pass time countdown** — shows exactly how much time is left until your registration window.
- **finals all in one place** — real dates, real times. no digging through GOLD.
- **add/drop deadlines** — first day, add deadline, drop deadline, last day to drop. all dated, all in the popup.
- **Google Calendar export** — drop your whole schedule in with one click.
- **deadline reminders** — optional notifications before something passes.
- **gaucho tips** — registration tricks passed down from students who already figured it out the hard way.
- **inline prereqs** — shows what a course requires, pulled straight from GOLD's own data.
- **waitlist explainer** — when a class is full and GOLD shows no waitlist button, it tells you why.

## what it doesn't do

- it never sees your login. no password, no NetID, no session token.
- it doesn't register for you. no auto-add, no bots.
- it doesn't upload your schedule. everything stays in your browser.
- no analytics, no tracking, no ads.

## install

### Chrome Web Store
[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/goldmine-%E2%80%94-ucsb-schedule/pannjbcjgahcbfphbbahpeaabfhojfbe)

### load unpacked
1. download or clone this repo
2. open `chrome://extensions`
3. turn on **Developer mode** (top right)
4. click **Load unpacked** and pick this folder
5. open GOLD and go to **My Schedule** once so GOLDmine can read your classes
6. go to **Find Courses** — ratings, peek, and conflict markers all light up

## privacy

ratings cache locally so they load fast. the only outbound network request is a professor's surname — nothing about you. full details in [PRIVACY.md](PRIVACY.md).

## bugs

open an issue with the page you were on, what you expected, and what happened. if a marker landed in the wrong place, the row's outer HTML is the most useful thing you can attach — scrub your enrollment codes first.

security issues: see [SECURITY.md](SECURITY.md).

## roadmap

- [x] prof ratings + hover cards
- [x] conflict markers with tooltips
- [x] schedule peek widget
- [x] pass time countdown
- [x] finals dates
- [x] add/drop deadlines
- [x] Google Calendar export
- [x] inline prerequisites
- [x] waitlist explainer
- [ ] seat-open notifications
- [ ] grade distributions

## license

[MIT](LICENSE). fork it, change it, ship your own.
