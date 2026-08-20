# GOLDmine — privacy policy

Last updated: August 2026. Applies to GOLDmine version 13.

GOLDmine is a browser extension made by a UCSB student. It is not affiliated with
or endorsed by UC Santa Barbara.

## The short version

Your schedule stays on your computer. The only thing GOLDmine ever sends
anywhere is a professor's name, to RateMyProfessors, so it can show you their
rating. There are no analytics, no trackers, no ads, and no third parties.

## What GOLDmine can see

When you are on a GOLD page (`my.sa.ucsb.edu/gold/`), GOLDmine reads what is on
that page: course codes, meeting days and times, locations, seat counts,
instructor names, final exam times, registration deadlines, your unit cap, and
prerequisite text.

It runs on GOLD pages only. It cannot see any other website you have open.

It never reads your name, perm number, NetID, password, grades, GPA, or
financial information, and it has no access to your login.

## What is stored, and where

Everything is stored locally in your own browser, using `chrome.storage.local`.
Nothing is uploaded, and nothing is written to Chrome's account sync except three
on/off switches for the extension's own features.

Stored locally:

- your saved class schedule and when it was last read
- your final exam times and any two that overlap
- registration deadlines and your pass window
- your unit cap and which pass you are in
- GE requirements still outstanding
- a cache of professor ratings already looked up
- your settings, and a `@ucsb.edu` address **only if you choose to type one into
  the popup** (it is optional, it is never sent anywhere, and leaving it blank
  changes nothing)

## What is transmitted

One thing, to one place: a professor's surname is sent to
`ratemyprofessors.com` to fetch their public rating, along with UCSB's school ID
so the right school is searched.

That request does not include your name, your perm number, your NetID, your
schedule, the page you were on, your session cookie, or any identifier for you or
your device beyond the ordinary network metadata every web request carries.

GOLDmine also reads one GOLD page in the background (Registration Info) to find
your unit cap. That request goes to UCSB's own server, on the session you are
already signed in to, and to nowhere else.

The extension loads one webfont from Google Fonts. Like any font on any web page,
that request tells Google your IP address and browser, and nothing about you from
GOLDmine.

## What is never collected

- Your name, perm number, NetID, or password
- Your grades, GPA, transcript, or financial aid
- Your browsing history, or any page outside GOLD
- Anything at all for advertising or profiling

## Third parties

None. GOLDmine contains no analytics SDK, no crash reporter, no tag manager, and
no third-party script of any kind. No data is sold, rented, or shared, because
none is collected.

## How to delete everything

Remove the extension. Chrome deletes its local storage with it, and nothing about
you exists anywhere else to delete. To clear only the cached professor ratings and
keep your settings, use **clear cache** at the bottom of the popup.

## Children

GOLDmine is intended for university students and is not directed at children
under 13.

## Changes

Material changes to this policy will be noted in the repository's release notes.

## Contact

Email **satyaichin@gmail.com**, or open an issue at
<https://github.com/satyachindam/goldmine>.
