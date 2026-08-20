(async () => {
  const $ = (id) => document.getElementById(id);

  const toggleRatings = $("toggleRatings");
  const togglePeek = $("togglePeek");
  const toggleConflicts = $("toggleConflicts");
  const toggleReminders = $("toggleReminders");
  const profCount = $("profCount");
  const clearBtn = $("clearCache");
  const bellIcon = $("bellIcon");
  const remindersSub = $("remindersSub");

  const reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Storage can be unavailable (profile corruption, quota). The popup must still
     render — a settings panel that refuses to open is worse than one showing
     defaults, because then the student can't even turn things off. */
  const readSync = async (defaults) => {
    try { return await chrome.storage.sync.get(defaults); } catch { return { ...defaults }; }
  };
  const readLocal = async (defaults) => {
    try { return await chrome.storage.local.get(defaults); } catch { return { ...defaults }; }
  };
  const writeSync = (obj) => {
    try { const p = chrome.storage.sync.set(obj); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ }
  };
  const writeLocal = (obj) => {
    try { const p = chrome.storage.local.set(obj); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ }
  };

  /* ---------- feature toggles (sync) ---------- */
  const stored = await readSync({ ratings: true, peek: true, conflicts: true });
  toggleRatings.checked = stored.ratings;
  togglePeek.checked = stored.peek;
  toggleConflicts.checked = stored.conflicts;

  toggleRatings.addEventListener("change", () => writeSync({ ratings: toggleRatings.checked }));
  togglePeek.addEventListener("change", () => writeSync({ peek: togglePeek.checked }));
  toggleConflicts.addEventListener("change", () => writeSync({ conflicts: toggleConflicts.checked }));

  /* ---------- reminders ---------- */
  const { reminders = true } = await readLocal({ reminders: true });
  toggleReminders.checked = reminders;
  const paintBell = () => {
    bellIcon.classList.toggle("on", toggleReminders.checked);
    remindersSub.textContent = toggleReminders.checked
      ? "we'll remind you before you miss it"
      : "reminders off";
  };
  paintBell();
  toggleReminders.addEventListener("change", () => {
    writeLocal({ reminders: toggleReminders.checked });
    paintBell();
  });

  /* ============================================================
     NIGHT SKY — deep ocean at night.
     Every moving thing here is a DOM node plus a CSS keyframe: no canvas, no
     WebGL, no library. Each transient node removes ITSELF on animationend,
     because the popup gets opened and closed dozens of times during pass week
     and orphaned spans would pile up for the life of the session.
     ============================================================ */
  /* v11 Part 2 — stars and the moon stay behind the content (a moon over the
     text would be wrong); birds, shooting stars and glitch bars go in front,
     which is the whole reason they were never visible. */
  const skyBack = $("skyBack");
  const skyFront = $("skyFront");
  let shootTimer = null;
  let birdTimer = null;
  let perchTimer = null;
  let showerTimer = null;
  /* Every deferred bird/meteor action is registered here so clearSky can cancel
     all of them. Declared beside the other handles, above clearSky, because a
     `const` referenced before its declaration is a ReferenceError, not a null. */
  const birdTimers = new Set();
  const showerTimers = new Set();
  const laterBird = (fn, ms) => {
    const h = setTimeout(() => { birdTimers.delete(h); fn(); }, ms);
    birdTimers.add(h);
    return h;
  };
  const laterShower = (fn, ms) => {
    const h = setTimeout(() => { showerTimers.delete(h); fn(); }, ms);
    showerTimers.add(h);
    return h;
  };

  function clearSky() {
    if (shootTimer) { clearTimeout(shootTimer); shootTimer = null; }
    if (birdTimer) { clearTimeout(birdTimer); birdTimer = null; }
    if (perchTimer) { clearTimeout(perchTimer); perchTimer = null; }
    if (glitchTimer) { clearTimeout(glitchTimer); glitchTimer = null; }
    if (showerTimer) { clearTimeout(showerTimer); showerTimer = null; }
    /* v13 §5 — every stagger and every deferred exit is tracked, so switching
       modes or closing the popup cannot leave a timer running against a node
       that is already gone. A Set, not a variable: a flock has several in
       flight at once and the old single-handle pattern could only cancel one. */
    for (const h of birdTimers) clearTimeout(h);
    birdTimers.clear();
    for (const h of showerTimers) clearTimeout(h);
    showerTimers.clear();
    perched = null;
    while (skyBack.firstChild) skyBack.removeChild(skyBack.firstChild);
    while (skyFront.firstChild) skyFront.removeChild(skyFront.firstChild);
  }

  function makeStars(n) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const s = document.createElement("span");
      s.className = "star";
      const size = Math.random() < 0.55 ? 1 : 2;
      s.style.width = size + "px";
      s.style.height = size + "px";
      s.style.left = (Math.random() * 100).toFixed(2) + "%";
      s.style.top = (Math.random() * 100).toFixed(2) + "%";
      // opacity 0.3-0.9, randomised delay so they never pulse in sync; the
      // greenish tint and bloom halo come from .star in the stylesheet
      s.style.setProperty("--o", (0.3 + Math.random() * 0.6).toFixed(2));
      s.style.animationDelay = (Math.random() * 3.2).toFixed(2) + "s";
      frag.appendChild(s);
    }
    skyBack.appendChild(frag);   // atmosphere: behind the content
  }

  /* v12 §2 — one angle decides everything.
     v11 hardcoded the travel (`translate(-260px, 190px)`) in the keyframe and
     the tail (`right: 2px` + a leftward gradient) in the stylesheet, so the two
     could never agree and never varied. Here a single random heading produces
     the travel vector AND the tail rotation, which is 180° from it by
     construction — the tail cannot lead the star. */
  let lastShootAngle = null;

  /* One meteor. Everything about it comes from a single heading, which is what
     makes it impossible for the tail to disagree with the direction of travel:
     the travel vector and the tail rotation are two readings of one number.
     The shower calls this too, so there is exactly one copy of this maths in the
     codebase and no second copy that can drift out of step (v13 §3). */
  function makeMeteor(deg, opts) {
    opts = opts || {};
    const rad = deg * Math.PI / 180;
    const dist = opts.dist || (190 + Math.random() * 150);
    /* Round the travel vector FIRST, then derive the tail from the rounded
       numbers. The element animates to whole pixels, so those are the real
       direction of travel; deriving the tail from the unrounded vector left it
       up to 0.1° off the path actually taken. Invisible on screen, but it means
       the tail is opposite "roughly" rather than exactly, and "roughly" is how
       this bug survived two releases. */
    const dx = Math.round(Math.cos(rad) * dist);
    const dy = Math.round(-Math.sin(rad) * dist);   // screen y grows downward
    const len = opts.len || (40 + Math.random() * 30);

    const s = document.createElement("span");
    s.className = "shooting-star" + (opts.bright ? " meteor-bright" : "");
    s.style.setProperty("--dx", dx + "px");
    s.style.setProperty("--dy", dy + "px");
    s.style.setProperty("--len", len.toFixed(0) + "px");
    /* The tail trails: it points back along the path the star came from.
       Three decimals, not one: at one decimal the value written to the DOM
       differs from the computed heading by up to 0.1°, which is invisible on
       screen but means the gate cannot prove "every tail is exactly opposite"
       — only "close". Precision here is free, so the check can be exact. */
    s.style.setProperty("--tail",
      (Math.atan2(dy, dx) * 180 / Math.PI + 180).toFixed(3) + "deg");
    s.style.setProperty("--dur", (opts.dur || (900 + Math.random() * 600)).toFixed(0) + "ms");
    if (opts.size) { s.style.width = opts.size + "px"; s.style.height = opts.size + "px"; }

    s.style.left = (opts.left != null ? opts.left : Math.random() * 100).toFixed(1) + "%";
    s.style.top = (opts.top != null ? opts.top : Math.random() * 22).toFixed(1) + "%";
    s.addEventListener("animationend", () => s.remove(), { once: true });
    skyFront.appendChild(s);   // motion: in front of the content
    return { node: s, deg, dx, dy };
  }

  function shootOnce() {
    // 200°-340° measured the usual way (0° = due right, counter-clockwise), so
    // every heading in the range has a downward component: down-left through
    // straight down to down-right.
    let deg;
    do { deg = 200 + Math.random() * 140; }
    while (lastShootAngle != null && Math.abs(deg - lastShootAngle) < 25);
    lastShootAngle = deg;
    return makeMeteor(deg);
  }

  /* ============ v13 §3 — the meteor shower ============
     6-12 meteors over about 2.5s, staggered. They share a general heading, the
     way a real shower radiates from one point, but every one gets its own angle
     variance, speed, length and size, and no two are allowed to be identical.
     A couple are noticeably brighter. Night only. */
  function meteorShower() {
    const n = 6 + Math.floor(Math.random() * 7);        // 6-12
    const base = 210 + Math.random() * 120;             // the shower's radiant
    const brightOnes = new Set([Math.floor(Math.random() * n),
                                Math.floor(Math.random() * n)]);
    const used = [];
    for (let i = 0; i < n; i++) {
      // each meteor varies around the radiant, and never lands on a heading
      // another one already took
      let deg, guard = 0;
      do {
        deg = base + (Math.random() * 26 - 13);
        deg = Math.min(340, Math.max(200, deg));
      } while (used.some((d) => Math.abs(d - deg) < 1.2) && guard++ < 24);
      used.push(deg);

      const bright = brightOnes.has(i);
      laterShower(() => makeMeteor(deg, {
        dist: 210 + Math.random() * 190,
        len: (bright ? 60 : 34) + Math.random() * 34,
        dur: 700 + Math.random() * 700,
        size: bright ? 4 : (Math.random() < 0.4 ? 2 : 3),
        bright,
        left: Math.random() * 100,
        top: Math.random() * 26
      }), (i / n) * 2500 + Math.random() * 160);        // staggered across ~2.5s
    }
    return n;
  }

  function scheduleShower() {
    // §3 — random, roughly every 3-6 minutes of night mode: rare enough to be a
    // surprise, common enough that a student actually sees one.
    const delay = 180000 + Math.random() * 180000;
    showerTimer = setTimeout(() => {
      if (document.body.classList.contains("dark")) {
        meteorShower();
        scheduleShower();
      }
    }, delay);
  }

  function scheduleShoot() {
    const delay = 8000 + Math.random() * 4000;   // 8-12s
    shootTimer = setTimeout(() => {
      if (document.body.classList.contains("dark")) {
        shootOnce();
        scheduleShoot();
      }
    }, delay);
  }

  /* v10 2.5 — birds are visible now, and they land.
     Two behaviours alternate so the sky isn't predictable: a fly-through that
     exits the far side, and a perch that lands on the TOP EDGE of a section
     header box, sits 4-8s, then leaves. One bird at a time, every 12-20s.
     A perching bird sits on the border, above the words — never over text. */
  let birdMode = 0;
  let perched = null;        // the one bird currently sitting still, if any

  /* ============ v13 §2 — flocks ============
     §2.4: 1-4 birds, never more, mixed sizes, staggered entry so they do not
     move as one rigid block. Smaller birds fly faster and higher because that is
     what distance looks like.
     §2.5: nothing fades while it is still on screen. A bird's node is removed
     only after its rect has actually cleared the viewport, which is checked
     rather than assumed. */
  const BIRD_SIZES = [
    { name: "large",  scale: 1,    fade: 0.72, speed: 1,    lift: 0 },
    { name: "small",  scale: 0.72, fade: 0.6,  speed: 1.24, lift: -14 },
    { name: "xsmall", scale: 0.5,  fade: 0.48, speed: 1.5,  lift: -26 }
  ];

  function makeBird(size, flapMs) {
    const b = document.createElement("span");
    b.className = "bird bird-flap bird-bob";
    b.style.setProperty("--scale", String(size.scale));
    b.style.setProperty("--fade", String(size.fade));
    // §2.3 — 160-200ms base, jittered per bird so a flock is never in step
    b.style.setProperty("--flap", Math.round(flapMs) + "ms");
    b.style.setProperty("--bob", Math.round(1100 + Math.random() * 900) + "ms");
    b.style.setProperty("--amp", (2 + Math.random() * 3).toFixed(1) + "px");
    const body = document.createElement("span");
    body.className = "bird-body";
    b.appendChild(body);
    return b;
  }

  /* §2.5 — "they shouldn't disappear before they leave screen". The animation
     ends off-frame by construction, but construction is what has been wrong
     three times, so measure it: only remove once no part of the rect is inside
     the viewport. If it somehow is still visible, give it one more beat. */
  function removeWhenOffScreen(b, tries) {
    const r = b.getBoundingClientRect();
    /* A rect with no area means the environment gave us no layout to measure —
       a hidden tab, a detached node, a test runner. That is not evidence the
       bird is still on screen, and holding the node hostage to a measurement
       nobody can make is how you leak. Treat "cannot tell" as done. */
    const unmeasurable = r.width === 0 && r.height === 0;
    const clear = r.right < 0 || r.left > window.innerWidth ||
                  r.bottom < 0 || r.top > window.innerHeight;
    if (unmeasurable || clear || (tries || 0) > 6) { b.remove(); return; }
    laterBird(() => removeWhenOffScreen(b, (tries || 0) + 1), 240);
  }

  function flyThrough(size, delay) {
    size = size || BIRD_SIZES[0];
    // gliding is the slow end of the beat; a small bird beats a little quicker
    const b = makeBird(size, (185 + Math.random() * 30) / size.speed);
    b.classList.add("bird-fly");
    const w = window.innerWidth || 344;
    b.style.top = (10 + Math.random() * 40 + size.lift).toFixed(0) + "px";
    b.style.setProperty("--from", "-60px");
    b.style.setProperty("--to", (w + 80) + "px");
    b.style.setProperty("--rise", (-8 - Math.random() * 22).toFixed(0) + "px");
    b.style.setProperty("--cross", ((6.5 + Math.random() * 3) / size.speed).toFixed(2) + "s");
    b.addEventListener("animationend", (e) => {
      if (e.animationName === "gm-glide") removeWhenOffScreen(b, 0);
    });
    if (delay) { b.style.visibility = "hidden"; laterBird(() => { b.style.visibility = ""; }, delay); }
    skyFront.appendChild(b);
    return b;
  }

  /* §2.4 — a flock is 1 to 4 birds. The count is random every time, the sizes
     are mixed, and entry is staggered 200-600ms apart. */
  function flock() {
    const n = 1 + Math.floor(Math.random() * 4);         // 1-4, never more
    /* Sizes are mixed WITHIN a flock, not merely drawn at random: three birds
       that happen to roll the same class read as one bird copied, which is the
       stiffness complaint in another form. So the first two birds are always
       given different classes and the rest are free. */
    const pool = BIRD_SIZES.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    let delay = 0;
    for (let i = 0; i < n; i++) {
      const size = i < pool.length ? pool[i]
                                   : BIRD_SIZES[Math.floor(Math.random() * BIRD_SIZES.length)];
      flyThrough(size, delay);
      delay += 200 + Math.random() * 400;                // 200-600ms apart
    }
    return n;
  }

  /* takeoff: wings beat fast, the bird arcs up and out, and it stops being
     "perched" the instant it commits. Used by the flee-on-approach handler and
     by the scroll handler alike, so a bird is never left standing on a perch
     that has moved. */
  function takeOff(b) {
    if (!b || b.dataset.leaving === "1") return;
    b.dataset.leaving = "1";
    if (perched === b) perched = null;
    if (perchTimer) { clearTimeout(perchTimer); perchTimer = null; }
    b.style.setProperty("--flap", "120ms");     // climbing: fast
    b.classList.add("bird-flap", "bird-bob");
    b.classList.remove("bird-perch");
    b.classList.add("bird-leaving");
    b.addEventListener("animationend", (e) => {
      if (e.animationName === "gm-takeoff") removeWhenOffScreen(b, 0);
    });
  }

  function perch() {
    // Land on the top border of a panel, never on top of its text.
    const panels = [...document.querySelectorAll(".panel")];
    if (!panels.length) { flock(); return; }
    const panel = panels[Math.floor(Math.random() * panels.length)];
    const r = panel.getBoundingClientRect();
    if (r.top < 8 || r.width < 40) { flock(); return; }

    const size = BIRD_SIZES[Math.floor(Math.random() * 2)];   // large or small
    const b = makeBird(size, 210);
    b.classList.add("bird-perch");
    /* The sky layer is `position: fixed`, so its children are placed in VIEWPORT
       coordinates. v11 added window.scrollY here, which is page coordinates, and
       that pushed a perched bird out of the layer's box entirely. */
    b.style.top = Math.round(r.top - 7) + "px";
    b.style.left = Math.round(r.left + 24 + Math.random() * Math.max(1, r.width - 60)) + "px";
    b.dataset.perchTop = String(Math.round(r.top));
    const stay = 4000 + Math.random() * 4000;   // 4-8s
    skyFront.appendChild(b);
    perched = b;
    // a bird that has landed stops beating and stops bobbing
    b.addEventListener("animationend", (e) => {
      if (e.animationName === "gm-land") b.classList.remove("bird-flap", "bird-bob");
    });
    perchTimer = laterBird(() => takeOff(b), stay);
  }

  function flyBirds() {
    // alternate, so it never settles into a pattern
    birdMode = (birdMode + 1) % 2;
    if (birdMode === 0) flock(); else perch();
  }

  function scheduleBirds() {
    const delay = 12000 + Math.random() * 8000;   // 12-20s
    birdTimer = setTimeout(() => {
      if (!document.body.classList.contains("dark")) {
        flyBirds();
        scheduleBirds();
      }
    }, delay);
  }

  /* v12 §3.2 — Option A. A perched bird sits at the viewport coordinates its
     panel occupied when it landed. Scrolling moves the panel and not the bird,
     so it would be left standing on nothing. Re-anchoring on every frame is the
     alternative; taking off is less code and it means a bird is never in the
     wrong place. */
  window.addEventListener("scroll", () => { if (perched) takeOff(perched); }, { passive: true });

  /* §3.4 — flee on approach: within ~60px, it goes. */
  document.addEventListener("mousemove", (e) => {
    if (!perched) return;
    const r = perched.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    if (dx * dx + dy * dy < 60 * 60) takeOff(perched);
  }, { passive: true });

  /* v10 2.4 — the 2000s camera tell. Roughly three times a minute a brief
     horizontal glitch sweeps the popup: a few thin bars in the fringe colours,
     offset from each other, gone in under 200ms. Never two in a row. */
  let glitchTimer = null;

  let lastGlitchY = -99;

  /* v12 §5 — the hues shift between firings.
     v11 fired the identical two hex values every time (`["#e4b8c8","#b8d8c8"]`),
     so the effect replayed rather than misbehaved, and after the second sighting
     the eye stopped registering it as noise. Early-2000s sensor noise is not one
     effect: it lands pink-heavy, then cyan-heavy, and every so often throws a
     warm yellow-green fringe. So the palette is generated per firing, inside a
     washed-out band — saturation stays under 60%, nothing here pops. */
  function glitchPalette(dark) {
    const jitter = (h, s, l) => `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`;
    if (dark) {
      // pale green and dim sage, drifting a little either side of #c8d4c0/#a8c098
      return [jitter(80 + Math.random() * 30, 16 + Math.random() * 14, 74 + Math.random() * 8),
              jitter(85 + Math.random() * 25, 18 + Math.random() * 12, 62 + Math.random() * 8)];
    }
    const lean = Math.random();
    const pink = jitter(320 + Math.random() * 30, 34 + Math.random() * 20, 78 + Math.random() * 8);
    const cyan = jitter(140 + Math.random() * 45, 28 + Math.random() * 20, 76 + Math.random() * 8);
    // roughly one firing in six picks up the yellow-green fringe instead
    if (lean > 0.84) return [jitter(66 + Math.random() * 14, 38, 72), pink];
    return lean > 0.5 ? [pink, cyan, pink] : [cyan, pink, cyan];
  }

  function glitchOnce() {
    const dark = document.body.classList.contains("dark");
    const bars = 2 + Math.floor(Math.random() * 3);       // 2-4
    const palette = glitchPalette(dark);

    // Never twice in a row at the same height.
    let baseY = Math.random() * 88;
    let guard = 0;
    while (Math.abs(baseY - lastGlitchY) < 12 && guard++ < 8) baseY = Math.random() * 88;
    lastGlitchY = baseY;

    const frag = document.createDocumentFragment();
    for (let i = 0; i < bars; i++) {
      const bar = document.createElement("span");
      bar.className = "glitch-bar";
      bar.style.top = (baseY + i * (0.6 + Math.random())).toFixed(2) + "%";
      bar.style.height = (1 + Math.floor(Math.random() * 3)) + "px";
      bar.style.background = palette[i % palette.length];
      // offset slightly left/right of each other
      bar.style.transform = "translateX(" + (Math.random() * 14 - 7).toFixed(1) + "px)";
      bar.style.animationDuration = (140 + Math.random() * 80).toFixed(0) + "ms";   // 140-220ms
      bar.addEventListener("animationend", () => bar.remove(), { once: true });
      frag.appendChild(bar);
    }
    skyFront.appendChild(frag);

    /* v11 Part 5 — at night the whole popup rolls 1-2px, like a tracking error.
       v10 rolled the BAR, which just looked like a moving line; rolling the
       frame is what reads as tape. */
    if (dark) {
      document.body.classList.add("gm-tracking");
      // routed through the registry so closing the popup or flipping modes
      // cannot leave a roll class behind on a later glitch
      laterShower(() => document.body.classList.remove("gm-tracking"), 180);
    }
  }

  function scheduleGlitch() {
    // ~3 per minute, jittered so it never lands on a beat
    const delay = 12000 + Math.random() * 14000;
    glitchTimer = setTimeout(() => {
      glitchOnce();
      scheduleGlitch();
    }, delay);
  }

  function paintSky(on) {
    clearSky();
    if (reduceMotion) {
      // static only: stars still render at night, nothing moves in either mode
      if (on) makeStars(60 + Math.floor(Math.random() * 21));
      return;
    }
    if (on) {
      makeStars(60 + Math.floor(Math.random() * 21));   // 60-80
      scheduleShoot();
      scheduleShower();
    } else {
      flyBirds();        // one pass on open, then on the ambient interval
      scheduleBirds();
    }
    scheduleGlitch();    // the tape glitches in both modes
  }

  const darkToggle = $("darkToggle");
  const { darkMode = false } = await readLocal({ darkMode: false });
  document.body.classList.toggle("dark", darkMode);
  paintSky(darkMode);
  darkToggle.addEventListener("click", () => {
    const on = document.body.classList.toggle("dark");
    writeLocal({ darkMode: on });
    paintSky(on);
  });
  window.addEventListener("unload", clearSky);

  /* ============ v10 2.1 — bind the gradient to scroll position ============
     0 at the top, 1 at the bottom; CSS reads it as background-position. Written
     on a rAF so a fast scroll can't queue a write per event. */
  /* v11 Part 4 — the gradient moves for two independent reasons.
     v10 bound background-position to --gm-scroll and stopped there. Two things
     were wrong: the value was read from `window.scrollY`, which never changes in
     a popup whose content fits inside Chrome's 600px auto-size (so t stayed 0
     forever and nothing moved); and there was no idle drift on the day layer at
     all, so a popup that doesn't scroll was completely static.

     Now: the scroll link reads the real scrolling element, and a separate
     always-on drift lives on .sky-back so the popup breathes regardless. They
     are on different layers and cannot fight over one background-position. */
  (function bindScrollGradient() {
    const root = document.documentElement;
    let queued = false;

    const scroller = () =>
      document.scrollingElement || document.documentElement || document.body;

    const paint = () => {
      queued = false;
      const el = scroller();
      const max = Math.max(1, el.scrollHeight - el.clientHeight);
      const top = el.scrollTop || window.scrollY || 0;
      const t = Math.min(1, Math.max(0, top / max));
      root.style.setProperty("--gm-scroll", t.toFixed(4));
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      (typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (fn) => setTimeout(fn, 16))(paint);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    paint();
  })();

  /* ---------- account ---------- */
  const emailInput = $("emailInput");
  const saveEmail = $("saveEmail");
  const emailStatus = $("emailStatus");
  const { email = "" } = await readLocal({ email: "" });
  if (email) {
    emailInput.value = email;
    emailStatus.textContent = "saved, you're all set";
    emailStatus.className = "login-status ok";
  }

  const isUcsb = (v) => /^[^\s@]+@(?:[\w-]+\.)*ucsb\.edu$/i.test(v.trim());
  const doSaveEmail = () => {
    const v = emailInput.value.trim();
    if (!v) { emailStatus.textContent = "type your @ucsb.edu first"; emailStatus.className = "login-status bad"; return; }
    if (!isUcsb(v)) { emailStatus.textContent = "gotta be a @ucsb.edu address"; emailStatus.className = "login-status bad"; return; }
    writeLocal({ email: v });
    emailStatus.textContent = "saved, we'll keep this on your device";
    emailStatus.className = "login-status ok";
  };
  saveEmail.addEventListener("click", doSaveEmail);
  emailInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSaveEmail(); });

  /* ---------- upcoming deadlines ---------- */
  const { importantDates = [] } = await readLocal({ importantDates: [] });
  const upcoming = importantDates.filter((d) => d.when > Date.now()).sort((a, b) => a.when - b.when);
  if (upcoming.length) {
    $("datesSection").hidden = false;
    const dl = $("datesList");
    for (const d of upcoming.slice(0, 4)) {
      const dt = new Date(d.when);
      const row = document.createElement("div");
      row.className = "date-row";
      const lab = document.createElement("span");
      lab.className = "date-label";
      // v12 §7.4 — GOLD writes these in Title Case ("Registration Pass 2 Begins").
      // Everything else in this popup is lowercase and conversational; leaving
      // one column shouting in headline caps is what makes a UI read as assembled
      // rather than written. textContent, so no markup can come through with it.
      lab.textContent = String(d.label).toLowerCase();
      const when = document.createElement("span");
      when.className = "date-when";
      when.textContent = (dt.getMonth() + 1) + "/" + dt.getDate();
      row.append(lab, when);
      dl.appendChild(row);
    }
  }

  /* ---------- schedule / finals / GE ---------- */
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const local = await readLocal({
    savedSchedule: [], finals: [], finalsConflicts: [], geRemaining: []
  });

  if (Array.isArray(local.savedSchedule) && local.savedSchedule.length) {
    $("scheduleSection").hidden = false;
    const list = $("scheduleList");
    for (const c of local.savedSchedule) {
      const row = el("div", "mini-row");
      row.appendChild(el("span", "mini-code", c.course || ""));
      const when = (c.days || "TBA") + " " + (c.start || "") + (c.end ? "-" + c.end : "");
      row.appendChild(el("span", "mini-when", when.trim()));
      list.appendChild(row);
    }
  }

  if (Array.isArray(local.finals) && local.finals.length) {
    $("finalsSection").hidden = false;
    const list = $("finalsList");
    for (const f of local.finals) {
      const row = el("div", "mini-row");
      row.appendChild(el("span", "mini-code", f.course || ""));
      const when = f.start
        ? (f.date || "") + " " + f.start + (f.end ? "-" + f.end : "")
        : (f.raw || "contact professor");
      row.appendChild(el("span", "mini-when", when.trim()));
      list.appendChild(row);
    }
    if (Array.isArray(local.finalsConflicts) && local.finalsConflicts.length) {
      const warn = $("finalsWarn");
      warn.hidden = false;
      warn.textContent = "two finals overlap: " +
        local.finalsConflicts.map((p) => p.join(" & ")).join(", ");
    }
  }

  if (Array.isArray(local.geRemaining) && local.geRemaining.length) {
    $("geSection").hidden = false;
    const list = $("geList");
    for (const g of local.geRemaining) list.appendChild(el("span", "ge-chip", g));
  }

  /* ---------- pass time countdown ---------- */
  const nextPass = upcoming.find((d) => /pass/i.test(d.label)) || upcoming[0];
  if (nextPass) {
    $("passSection").hidden = false;
    const passCountdown = $("passCountdown");
    $("passLabel").textContent = String(nextPass.label).replace(/[<>&]/g, "").toLowerCase();
    const tick = () => {
      let ms = nextPass.when - Date.now();
      if (ms <= 0) { passCountdown.textContent = "it's go time"; return; }
      const d = Math.floor(ms / 86400000); ms -= d * 86400000;
      const h = Math.floor(ms / 3600000); ms -= h * 3600000;
      const m = Math.floor(ms / 60000); ms -= m * 60000;
      const s = Math.floor(ms / 1000);
      const pad = (n) => String(n).padStart(2, "0");
      passCountdown.textContent = (d > 0 ? d + "d " : "") + pad(h) + ":" + pad(m) + ":" + pad(s);
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ---------- calendar export ---------- */
  const exportIcs = $("exportIcs");
  const EXPORT_LABEL = "drop my classes into Google Calendar";
  exportIcs.addEventListener("click", async () => {
    const { savedSchedule = [] } = await readLocal({ savedSchedule: [] });
    if (!savedSchedule.length) {
      exportIcs.textContent = "visit My Schedule first, then try again";
      setTimeout(() => (exportIcs.textContent = EXPORT_LABEL), 2600);
      return;
    }
    const blob = new Blob([buildIcs(savedSchedule)], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "my-ucsb-schedule.ics";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    exportIcs.textContent = "done. open it to add to Google Calendar";
    setTimeout(() => (exportIcs.textContent = EXPORT_LABEL), 3000);
  });

  /* ============================================================
     GAUCHO TIPS — a senior talking to a freshman. Hardcoded and vetted, never
     scraped: a wrong tip during pass week costs somebody a class.
     Advances one step per popup OPEN and stores the index, so the student sees
     the whole set before anything repeats.
     ============================================================ */
  /* ============================================================
     v13 §4 — GAUCHO TIPS. Hardcoded and vetted, never scraped: a wrong tip
     during pass week costs somebody a class. Every tip that asserts a RULE is
     traceable to a page that states it, listed here so the next person can
     re-check them rather than trust them:

       [R-WL] registrar.sa.ucsb.edu/enrollment/quarterly-enrollment/course-waitlists
       [R-PT] registrar.sa.ucsb.edu/enrollment/quarterly-enrollment/pass-times
       [R-CR] registrar.sa.ucsb.edu/enrollment/quarterly-enrollment/course-registration
       [MATH] math.ucsb.edu/undergraduate/course-registration-waitlist-policies
       [HIST] history.ucsb.edu/registration-tips-and-reminders
       [GOLD] structures this extension reads directly off live GOLD pages

     Two things are deliberately NOT asserted. The registrar publishes 11.5 and
     15.5 unit maximums for undergraduate Pass 1 and Pass 2, but the live GOLD
     page this extension parses has been observed printing a different pair, so
     no tip states a number: they send the student to read their own cap. And
     department rules below are labelled by department, because they genuinely
     differ between them and a rule stated flatly would be wrong somewhere.

     Advances one step per popup OPEN and stores the index, so the student sees
     the whole set before anything repeats.
     ============================================================ */
  const TIPS = [
    // waitlists [R-WL]
    "the waitlist button won't even appear until you're enrolled in 12 UCSB units",
    "a waitlist only opens once every lecture AND every section of that course is full",
    "waitlisted units count against your pass unit cap unless you link the waitlist to a class you're already in",
    "a linked waitlist has to be equal or fewer units than the class you link it to, one for one",
    "after the 5th day of instruction GOLD won't let you drop yourself off a waitlist anymore",
    "auto add only pulls you in if you already clear the prereqs and restrictions, otherwise it skips you",
    // pass times [R-PT]
    "pass times go by how many quarters you've done here, and summer sessions don't count",
    "transfers get credited with 6 completed quarters on arrival, so your first pass isn't bottom of the pile",
    "if two people have identical tenure the tie is broken at random, not by who logs in first",
    "your pass 1 cap is lower than your pass 2 cap on purpose, and Registration Info prints both",
    // registration mechanics [R-CR] [HIST]
    "saving to your cart doesn't enroll you in anything, it just saves you typing at 7:45am",
    "past the 5th day of instruction you need instructor approval to add at all",
    "approval code and enrollment code are different things, and the wrong box is a red error every time",
    "when GOLD throws a red error, read it, it usually names the exact thing blocking you",
    "check Course Info for prereqs and restrictions BEFORE your pass, not while the clock is running",
    "grading option is per course and some are letter grade only, so check before you plan on P/NP",
    // crashing and department differences [MATH] [HIST]
    "how a waitlist is ordered is up to the instructor, so read the waitlist notes on the course",
    "some instructors run the waitlist with auto add off and sort out crashers on day one instead",
    "in math the department hands out add codes, not the instructor, so emailing the professor won't help",
    "math auto adds off the waitlist through the end of week 1, then switches to approval codes in weeks 2 and 3",
    "if a department emails you an approval code you usually get 24 hours before it goes to the next person",
    "crash lists run on attendance, and TAs take it for the first two weeks, so show up to section",
    "being a major doesn't reserve you a seat unless that specific course is major restricted",
    // what this extension can see for itself [GOLD]
    "a full lecture means its discussions are out too, whatever seat count they show",
    "Course Info is a postback, not a link, so ctrl clicking it won't open a second tab",
    "if the final says contact professor, that's not a scheduled time, chase it down early",
    "your cart is not your schedule, nothing is real until you hit Add"
  ];

  const tipEl = $("tipText");
  if (tipEl) {
    const { tipIndex = 0 } = await readLocal({ tipIndex: 0 });
    const i = ((Number(tipIndex) || 0) % TIPS.length + TIPS.length) % TIPS.length;
    tipEl.textContent = TIPS[i];
    writeLocal({ tipIndex: (i + 1) % TIPS.length });
  }

  /* ---------- cache stats ---------- */
  const send = async (msg) => {
    try { return await chrome.runtime.sendMessage(msg); } catch { return null; }
  };
  const refreshStats = async () => {
    const stats = await send({ type: "cacheStats" });
    // null means the worker never answered. Printing "0" would state as fact that
    // nothing is cached; say we don't know instead.
    profCount.textContent = stats && typeof stats.count === "number"
      ? stats.count.toLocaleString()
      : "—";
  };
  refreshStats();

  clearBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    await send({ type: "clearCache" });
    refreshStats();
  });
})();
