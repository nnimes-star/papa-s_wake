/* Memorial display controller.
 *
 * - The portrait, background, keywords and QR code never change with the rotation.
 * - Only the message area crossfades, once per rotationSeconds (default 20).
 * - New messages are queued and shown at the next transition; they never interrupt the current one.
 * - Hidden / deleted messages are removed immediately; if one is on screen it is replaced gracefully.
 * - Everything keeps working offline from the last synchronised state.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CACHE_KEY = 'memorial:display:v1';
  const DEBUG = new URLSearchParams(location.search).has('debug');
  const KEYWORDS_TOP = ['Love', 'Gratitude', 'Peace', 'Forever'];
  const KEYWORDS_BOTTOM = ['Family', 'Hope', 'Memories', 'Faith'];
  const KEYWORDS_GUTTER = ['Hope', 'Peace', 'Love'];

  const el = {
    frame: $('frame'),
    portrait: $('portrait'),
    portraitBox: $('portraitBox'),
    portraitImg: $('portraitImg'),
    portraitBg: $('portraitBg'),
    captionName: $('captionName'),
    captionDates: $('captionDates'),
    slides: [$('slideA'), $('slideB')],
    inviteUrl: $('inviteUrl'),
    qr: $('qr'),
    debug: $('debug'),
  };

  const state = {
    messages: [], // currently eligible (published) messages, oldest first
    settings: { rotationSeconds: 20, portraitFocusY: 30, portraitVersion: null, displayName: '', dates: '' },
    guestUrl: '',
    initialized: false,
    priority: [], // newly published ids: shown at the very next transitions
    pool: [], // remaining ids of the current shuffled cycle
    currentId: null,
    currentKind: null, // 'message' | 'placeholder' | null
    front: -1, // index of the visible slide layer
    shownAt: 0,
    timer: null,
    online: null,
    sse: 'connecting',
    portraitLoaded: null,
  };

  // ───────────── helpers ─────────────
  const rotationMs = () => Math.min(120, Math.max(8, Number(state.settings.rotationSeconds) || 20)) * 1000;
  const byId = (id) => state.messages.find((m) => m.id === id);

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ───────────── choosing the next message ─────────────
  function chooseNext() {
    const eligible = state.messages;
    if (!eligible.length) return null;

    // 1. Anything newly published goes first (oldest arrival first).
    while (state.priority.length) {
      const id = state.priority.shift();
      const m = byId(id);
      if (!m) continue;
      if (m.id === state.currentId && eligible.length > 1) continue; // never repeat back-to-back
      state.pool = state.pool.filter((x) => x !== id); // avoid showing it twice in one cycle
      return m;
    }

    // 2. Otherwise continue through a shuffled cycle of all eligible messages.
    state.pool = state.pool.filter((id) => byId(id));
    if (!state.pool.length) {
      state.pool = shuffle(eligible.map((m) => m.id));
      if (state.pool.length > 1 && state.pool[0] === state.currentId) {
        const k = 1 + Math.floor(Math.random() * (state.pool.length - 1));
        [state.pool[0], state.pool[k]] = [state.pool[k], state.pool[0]];
      }
    }
    return byId(state.pool.shift()) || null;
  }

  // ───────────── showing a message (crossfade confined to the message area) ─────────────
  function fitText(slide, text) {
    const len = [...text.textContent].length;
    let size = len <= 80 ? 3.5 : len <= 160 ? 3.0 : len <= 280 ? 2.5 : len <= 450 ? 2.05 : 1.75;
    const MIN = 1.3;
    text.style.setProperty('--fs', size);
    let guard = 40;
    while (slide.scrollHeight > slide.clientHeight + 1 && size > MIN && guard--) {
      size = Math.max(MIN, size * 0.94);
      text.style.setProperty('--fs', size);
    }
  }

  function render(item) {
    const next = state.front === 0 ? 1 : 0;
    const incoming = el.slides[next];
    const outgoing = state.front >= 0 ? el.slides[state.front] : null;
    const text = incoming.querySelector('.text');
    const sender = incoming.querySelector('.sender');

    if (item) {
      text.textContent = item.message;
      sender.textContent = item.name;
      incoming.classList.remove('placeholder');
    } else {
      text.textContent = 'Messages from family and friends will appear here.';
      sender.textContent = '';
      incoming.classList.add('placeholder');
    }
    fitText(incoming, text);

    // Force a style flush so the transition runs even on the very first message.
    void incoming.offsetWidth;
    incoming.classList.add('visible');
    if (outgoing) outgoing.classList.remove('visible');

    state.front = next;
    state.currentId = item ? item.id : null;
    state.currentKind = item ? 'message' : 'placeholder';
    state.shownAt = Date.now();
    schedule();
  }

  function advance() {
    const next = chooseNext();
    if (!next) {
      if (state.currentKind === 'placeholder') {
        state.shownAt = Date.now();
        schedule();
      } else {
        render(null); // nothing eligible: show the quiet placeholder instead of a blank screen
      }
      return;
    }
    if (next.id === state.currentId) {
      // Only one eligible message: keep it on screen rather than re-fading the same words.
      state.shownAt = Date.now();
      schedule();
      return;
    }
    render(next);
  }

  function schedule() {
    clearTimeout(state.timer);
    const wait = Math.max(250, state.shownAt + rotationMs() - Date.now());
    state.timer = setTimeout(advance, wait);
  }

  // ───────────── applying server state ─────────────
  function applyState(data, { fromCache = false } = {}) {
    if (!data || !Array.isArray(data.messages)) return;
    const before = new Set(state.messages.map((m) => m.id));
    const prevSettings = state.settings;

    state.messages = data.messages;
    state.settings = { ...state.settings, ...(data.settings || {}) };
    if (data.guestUrl) state.guestUrl = data.guestUrl;

    const ids = new Set(state.messages.map((m) => m.id));
    state.priority = state.priority.filter((id) => ids.has(id));
    state.pool = state.pool.filter((id) => ids.has(id));

    // Newly eligible messages (new submissions or restored ones) wait in line for the next transition.
    if (state.initialized) {
      for (const m of state.messages) {
        if (!before.has(m.id) && !state.priority.includes(m.id)) state.priority.push(m.id);
      }
    }
    state.initialized = true;

    applyPortrait();
    applyCaption();
    applyInvite();

    if (state.currentKind === null) {
      advance(); // first paint
    } else if (state.currentKind === 'message' && !ids.has(state.currentId)) {
      advance(); // the visible message was hidden or deleted: move on gracefully
    } else if (state.currentKind === 'placeholder' && state.messages.length) {
      advance(); // first messages have arrived
    } else if (state.settings.rotationSeconds !== prevSettings.rotationSeconds) {
      schedule();
    }

    if (!fromCache) {
      try {
        localStorage.setItem(
          CACHE_KEY,
          JSON.stringify({ messages: state.messages, settings: state.settings, guestUrl: state.guestUrl })
        );
      } catch {}
    }
  }

  function applyCaption() {
    const { displayName, dates } = state.settings;
    el.captionName.textContent = displayName || '';
    el.captionDates.textContent = dates || '';
    const has = Boolean(displayName || dates);
    if (el.portrait.classList.contains('has-caption') !== has) {
      el.portrait.classList.toggle('has-caption', has);
      requestAnimationFrame(fitPortrait);
    }
  }

  function applyInvite() {
    if (!state.guestUrl) return;
    el.inviteUrl.textContent = state.guestUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const wanted = `/qr.svg?u=${encodeURIComponent(state.guestUrl)}`;
    if (el.qr.getAttribute('src') !== wanted) el.qr.setAttribute('src', wanted);
  }

  // ───────────── portrait ─────────────
  function fitPortrait() {
    const img = el.portraitImg;
    if (!img.naturalWidth) return;
    const box = el.portraitBox.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const boxRatio = box.width / box.height;
    const imgRatio = img.naturalWidth / img.naturalHeight;
    // Close enough in shape: fill the frame. Otherwise show the whole photograph, undistorted.
    const fills = imgRatio > boxRatio * 0.72 && imgRatio < boxRatio * 1.4;
    img.classList.toggle('contain', !fills);
    el.portraitBg.classList.toggle('show', !fills);
    img.style.objectPosition = `50% ${Number(state.settings.portraitFocusY) || 30}%`;
  }

  function applyPortrait() {
    const version = state.settings.portraitVersion;
    el.portrait.classList.toggle('no-portrait', !version && !state.portraitLoaded);
    if (!version) {
      if (state.portraitLoaded) {
        // Administrator removed the portrait.
        state.portraitLoaded = null;
        el.portraitImg.classList.remove('ready');
        el.portraitBg.classList.remove('ready', 'show');
        el.portrait.classList.add('no-portrait');
      }
      return;
    }
    if (version === state.portraitLoaded) {
      fitPortrait();
      return;
    }
    // Preload so a replaced photograph swaps in without ever leaving the frame empty.
    const src = `/portrait?v=${encodeURIComponent(version)}`;
    const probe = new Image();
    probe.onload = () => {
      el.portraitImg.src = src;
      el.portraitBg.src = src;
      state.portraitLoaded = version;
      el.portrait.classList.remove('no-portrait');
      el.portraitImg.classList.add('ready');
      el.portraitBg.classList.add('ready');
      fitPortrait();
      rememberPortrait(src);
    };
    probe.onerror = () => {}; // offline or transient failure: keep whatever is already shown
    probe.src = src;
  }
  el.portraitImg.addEventListener('load', fitPortrait);

  // Keep the current portrait (and only it) in the offline cache, whether or not the
  // service worker was in control when the page first loaded.
  function rememberPortrait(src) {
    if (!('caches' in window)) return;
    caches
      .open('memorial-v1')
      .then(async (cache) => {
        await cache.add(src);
        for (const req of await cache.keys()) {
          const u = new URL(req.url);
          if (u.pathname === '/portrait' && u.search !== new URL(src, location.href).search) await cache.delete(req);
        }
      })
      .catch(() => {});
  }

  // ───────────── synchronisation (live push + polling fallback) ─────────────
  let inFlight = false;
  let dirty = false;
  let retryDelay = 3000;
  let retryTimer = null;

  async function sync() {
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch('/api/state', { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyState(await res.json());
      state.online = true;
      retryDelay = 3000;
    } catch {
      state.online = false; // keep showing the last known content
      clearTimeout(retryTimer);
      retryTimer = setTimeout(sync, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    } finally {
      inFlight = false;
      if (dirty) {
        dirty = false;
        sync();
      }
    }
  }

  let es = null;
  let lastBeat = Date.now();
  function connectEvents() {
    try {
      if (es) es.close();
    } catch {}
    state.sse = 'connecting';
    es = new EventSource('/api/events');
    lastBeat = Date.now();
    es.addEventListener('hello', () => {
      lastBeat = Date.now();
      state.sse = 'live';
      sync(); // (re)connected: pull anything missed while offline
    });
    es.addEventListener('sync', () => {
      lastBeat = Date.now();
      sync();
    });
    es.addEventListener('ping', () => {
      lastBeat = Date.now();
      state.sse = 'live';
    });
    es.onerror = () => {
      state.sse = 'reconnecting';
    };
  }
  // Watchdog: a silently dead connection is replaced.
  setInterval(() => {
    if (Date.now() - lastBeat > 40000) connectEvents();
  }, 10000);
  setInterval(sync, 30000);
  window.addEventListener('online', () => {
    connectEvents();
    sync();
  });

  // ───────────── ambience ─────────────
  function buildKeywords(lane, words, kind) {
    const rnd = (a, b) => a + Math.random() * (b - a);
    words.forEach((word, i) => {
      const s = document.createElement('span');
      s.className = 'kw';
      s.textContent = word;
      const d = kind === 'gutter' ? rnd(150, 210) : rnd(190, 280);
      s.style.setProperty('--d', `${d.toFixed(0)}s`);
      s.style.setProperty('--delay', `${(-(d * (i + Math.random() * 0.6)) / words.length).toFixed(1)}s`);
      s.style.setProperty('--o', rnd(0.05, 0.12).toFixed(3));
      if (kind === 'gutter') {
        s.style.setProperty('--s', rnd(1.45, 1.75).toFixed(2));
        s.style.setProperty('--x', `calc(var(--u) * ${(0.2 + (i % 2) * 0.5 + Math.random() * 0.3).toFixed(2)})`);
      } else {
        s.style.setProperty('--s', rnd(2.3, 3.1).toFixed(2));
        s.style.setProperty('--y', `calc(var(--u) * ${rnd(0, 0.8).toFixed(2)})`);
      }
      lane.appendChild(s);
    });
  }
  buildKeywords($('laneTop'), KEYWORDS_TOP, 'x');
  buildKeywords($('laneBottom'), KEYWORDS_BOTTOM, 'x');
  buildKeywords($('laneGutter'), KEYWORDS_GUTTER, 'gutter');

  // Hide the cursor when idle; double-click or F toggles full screen.
  let idleTimer;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
  };
  window.addEventListener('mousemove', wake);
  wake();
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  window.addEventListener('dblclick', toggleFullscreen);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  });

  // Keep the television awake while the tribute is playing.
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => (wakeLock = null));
      }
    } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake();
  });
  keepAwake();

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      fitPortrait();
      if (state.front >= 0) {
        const slide = el.slides[state.front];
        fitText(slide, slide.querySelector('.text'));
      }
    }, 150);
  });

  // ───────────── offline support ─────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // ───────────── debug overlay & test hook ─────────────
  if (DEBUG) {
    el.debug.hidden = false;
    setInterval(() => {
      const left = Math.max(0, Math.round((state.shownAt + rotationMs() - Date.now()) / 1000));
      el.debug.textContent =
        `online:${state.online}  sse:${state.sse}\n` +
        `eligible:${state.messages.length} priority:${state.priority.length} pool:${state.pool.length}\n` +
        `showing:${state.currentKind}${state.currentId ? ' ' + state.currentId.slice(0, 8) : ''}  next in ${left}s`;
    }, 500);
    window.__memorial = { state, advance };
  }

  // ───────────── start ─────────────
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached) applyState(cached, { fromCache: true }); // instant, works offline
  } catch {}
  if (state.currentKind === null) advance();
  connectEvents();
  sync();
})();
