/* End-to-end acceptance test for the memorial app.
 *
 * Runs the exact scenario from the requirements in a real browser against a throw-away
 * server and database, then exercises the reliability rules (queueing, hide-while-visible,
 * offline behaviour, reload while offline) and the security basics.
 *
 *   npm test        (needs Playwright + Chromium; dev only — the app itself has no dependencies)
 */
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = createRequire('/home/claude/.npm-global/lib/node_modules/')('playwright');
}
const { chromium } = playwright;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3222;
const BASE = `http://localhost:${PORT}`;
const TV_PORT = 3223; // the television reaches the server through a proxy we can cut to simulate an outage
const TV_BASE = `http://localhost:${TV_PORT}`;
const PASSWORD = 'acceptance-pass';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'memorial-test-'));

// ───────────── tiny test harness ─────────────
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 30000, interval = 100, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await sleep(interval);
  }
}

// ───────────── a network we can cut ─────────────
function makeProxy(listenPort, targetPort) {
  const sockets = new Set();
  let srv = null;
  const handler = (client) => {
    const up = net.connect(targetPort, '127.0.0.1');
    sockets.add(client);
    sockets.add(up);
    client.pipe(up);
    up.pipe(client);
    const done = () => {
      client.destroy();
      up.destroy();
      sockets.delete(client);
      sockets.delete(up);
    };
    client.on('error', done);
    up.on('error', done);
    client.on('close', done);
    up.on('close', done);
  };
  return {
    start: () => new Promise((res) => { srv = net.createServer(handler); srv.listen(listenPort, '127.0.0.1', res); }),
    // Drops every open connection (including the live event stream) and refuses new ones.
    cut: () => new Promise((res) => { for (const s of sockets) s.destroy(); sockets.clear(); srv.close(() => res()); }),
  };
}
const proxy = makeProxy(TV_PORT, PORT);

// ───────────── server + API helpers ─────────────
let server;
async function startServer() {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: PASSWORD, PUBLIC_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitFor(async () => {
    try {
      return (await fetch(`${BASE}/healthz`)).ok;
    } catch {
      return false;
    }
  }, { timeout: 10000, label: 'server start' });
}

let cookie = '';
async function api(method, url, body, { headers = {}, auth = true, raw = false } = {}) {
  const h = { 'X-Requested-With': 'memorial', ...headers };
  if (auth && cookie) h.Cookie = cookie;
  let payload;
  if (Buffer.isBuffer(body)) payload = body;
  else if (body !== undefined) {
    h['Content-Type'] ??= 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
const post = (name, message, extra = {}) => api('POST', '/api/messages', { name, message, ...extra }, { auth: false });
const state = async () => (await api('GET', '/api/state', undefined, { auth: false })).json;
const adminMessages = async () => (await api('GET', '/api/admin/messages')).json.messages;

// A neutral stand-in photograph (generated, not a real person).
function makePortrait() {
  const file = path.join(DATA_DIR, 'test-portrait.png');
  execFileSync('python3', ['-I', '-c', `
from PIL import Image, ImageDraw
im = Image.new('RGB', (800, 1000), (70, 82, 110)); d = ImageDraw.Draw(im)
d.ellipse([250, 170, 550, 520], fill=(196, 160, 132)); d.polygon([(120,1000),(200,640),(400,590),(600,640),(680,1000)], fill=(36,44,66))
im.save(${JSON.stringify(file)})`]);
  return fs.readFileSync(file);
}

// ───────────── in-page sampler for the display ─────────────
const SAMPLER = () => {
  window.__log = [];
  window.__phase = 'start';
  const rect = (e) => {
    const r = e.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10);
  };
  setInterval(() => {
    const m = window.__memorial?.state;
    const img = document.getElementById('portraitImg');
    const box = document.getElementById('portraitBox');
    const qr = document.getElementById('qr');
    if (!m || !img || !box || !qr) return;
    const slides = [...document.querySelectorAll('.slide')];
    const visible = slides.filter((s) => s.classList.contains('visible'));
    window.__log.push({
      t: performance.now(),
      phase: window.__phase,
      id: m.currentId,
      kind: m.currentKind,
      text: visible[0]?.querySelector('.text')?.textContent ?? '',
      sender: visible[0]?.querySelector('.sender')?.textContent ?? '',
      visibleLayers: visible.length,
      topOpacity: Math.max(0, ...slides.map((s) => Number(getComputedStyle(s).opacity))),
      portraitOpacity: Number(getComputedStyle(img).opacity),
      portraitBox: rect(box),
      qr: rect(qr),
    });
  }, 100);
};
const getLog = (page) => page.evaluate(() => window.__log);
const mark = (page, p) => page.evaluate((x) => (window.__phase = x), p);
const current = (page) => page.evaluate(() => ({ id: window.__memorial.state.currentId, kind: window.__memorial.state.currentKind }));
const shownText = (page) =>
  page.evaluate(() => document.querySelector('.slide.visible .text')?.textContent ?? '');
const eligibleIds = (page) => page.evaluate(() => window.__memorial.state.messages.map((m) => m.id));

function transitions(log) {
  const out = [];
  for (let i = 1; i < log.length; i++) {
    if (log[i].id !== log[i - 1].id || log[i].kind !== log[i - 1].kind) out.push({ t: log[i].t, from: log[i - 1], to: log[i] });
  }
  return out;
}
const intersects = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

// ───────────── main ─────────────
let browser;
try {
  console.log(`Data dir: ${DATA_DIR}`);
  await startServer();
  await proxy.start();

  // ═════════ Security & validation (API level) ═════════
  section('API: validation, security and publication rules');
  check('admin API rejects unauthenticated requests', (await api('GET', '/api/admin/messages', undefined, { auth: false })).status === 401);
  check('login without the CSRF header is refused', (await api('POST', '/api/admin/login', { password: PASSWORD }, { auth: false, headers: { 'X-Requested-With': '' } })).status === 403);
  check('wrong password is rejected', (await api('POST', '/api/admin/login', { password: 'nope' }, { auth: false })).status === 401);
  const login = await api('POST', '/api/admin/login', { password: PASSWORD }, { auth: false });
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  check('correct password signs in (HttpOnly, SameSite=Strict cookie)', login.status === 200 && /HttpOnly/i.test(login.headers.get('set-cookie')) && /SameSite=Strict/i.test(login.headers.get('set-cookie')));
  check('admin mutations need the CSRF header', (await api('POST', '/api/admin/logout', {}, { headers: { 'X-Requested-With': '' } })).status === 403);

  check('empty name is rejected', (await post('', 'hello')).status === 400);
  check('empty message is rejected', (await post('Ana', '   ')).status === 400);
  check('701-character message is rejected', (await post('Ana', 'x'.repeat(701))).status === 400);
  check('700-character message is accepted', (await post('Ana Long', 'y'.repeat(700))).status === 201);
  const hp = await post('Bot', 'buy my stuff', { website: 'http://spam' });
  check('honeypot submissions are discarded silently', hp.status === 201 && !(await state()).messages.some((m) => m.name === 'Bot'));
  const dirty = await post('Ben‮', 'Rest​ in peace\u0007.');
  const dirtyMsg = (await state()).messages.find((m) => m.name === 'Ben');
  check('invisible / bidi / control characters are stripped', dirty.status === 201 && dirtyMsg && dirtyMsg.message === 'Rest in peace.');
  const d1 = await post('Dup', 'same words');
  const d2 = await post('Dup', 'same words');
  check('double-submitting identical text does not duplicate', d1.json.id === d2.json.id);
  const big = await fetch(`${BASE}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'a', message: 'b'.repeat(20000) }) });
  check('oversized request body is refused', big.status === 413);
  check('static path traversal is blocked', (await fetch(`${BASE}/..%2f..%2fserver.js`)).status !== 200);

  // Clean slate for the browser scenario, but keep one pending row to prove it never shows.
  for (const m of await adminMessages()) await api('DELETE', `/api/admin/messages/${m.id}`);
  const dbFile = path.join(DATA_DIR, 'memorial.db');
  const direct = new DatabaseSync(dbFile);
  direct.prepare("INSERT INTO messages (id,name,message,status,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run('00000000-0000-4000-8000-000000000001', 'Pending Person', 'I must never be displayed.', 'pending', new Date().toISOString(), new Date().toISOString());
  direct.close();
  check('messages with a pending status never reach the public feed', !(await state()).messages.some((m) => m.name === 'Pending Person'));

  const portraitRes = await api('PUT', '/api/admin/portrait', makePortrait(), { headers: { 'Content-Type': 'image/png' } });
  check('administrator can upload the portrait', portraitRes.status === 200);
  check('non-image uploads are refused', (await api('PUT', '/api/admin/portrait', Buffer.from('<svg onload=alert(1)>'), { headers: { 'Content-Type': 'image/svg+xml' } })).status === 415);
  check('fake image bytes are refused', (await api('PUT', '/api/admin/portrait', Buffer.from('not really a png'), { headers: { 'Content-Type': 'image/png' } })).status === 400);

  for (const [n, m] of [
    ['Maria Santos', 'Tatay, thank you for every Sunday lunch and every quiet lesson in kindness.'],
    ['Uncle Ben', 'Rest easy, kuya.'],
    ['The Dela Cruz Family', 'Lord, grant him eternal rest, and let perpetual light shine upon him.'],
    ['<b>Markup Test</b>', '<img src=x onerror="window.__pwned=1"> shown as plain words'],
  ]) await post(n, m);
  check('seed messages are published automatically', (await state()).messages.length === 4);

  browser = await chromium.launch();

  // ═════════ 1. Open /display on a television ═════════
  section('Acceptance 1–2: /display on a 1920×1080 television');
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, serviceWorkers: 'allow' });
  const tv = await tvCtx.newPage();
  const pageErrors = [];
  tv.on('pageerror', (e) => pageErrors.push(e.message));
  await tv.addInitScript(SAMPLER);
  await tv.goto(`${TV_BASE}/display?debug=1`, { waitUntil: 'load' });
  await waitFor(async () => (await current(tv)).kind === 'message', { label: 'first message' });
  await waitFor(() => tv.evaluate(() => Number(getComputedStyle(document.getElementById('portraitImg')).opacity) === 1), { label: 'portrait visible' });
  await tv.waitForTimeout(1600);

  const geo = await tv.evaluate(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
    return { W: innerWidth, H: innerHeight, portrait: r('portraitBox'), message: r('messageArea'), qr: r('qr') };
  });
  const pPct = (geo.portrait.width / geo.W) * 100;
  const mPct = (geo.message.width / geo.W) * 100;
  check('portrait is on the left, ~40% of the width', geo.portrait.right < geo.message.left && pPct > 38 && pPct < 42, `${pPct.toFixed(1)}%`);
  check('message area is on the right, ~45% of the width', mPct > 43 && mPct < 47, `${mPct.toFixed(1)}%`);
  check('QR code sits in a corner and overlaps neither portrait nor message', geo.qr.x > geo.W * 0.8 && geo.qr.y > geo.H * 0.65 && !intersects([geo.qr.x, geo.qr.y, geo.qr.width, geo.qr.height], [geo.message.x, geo.message.y, geo.message.width, geo.message.height]));
  const fit = await tv.evaluate(() => getComputedStyle(document.getElementById('portraitImg')).objectFit);
  check('portrait uses an undistorted fit (cover/contain)', fit === 'cover' || fit === 'contain', fit);
  check('invitation text is shown', (await tv.locator('.invite-line').textContent()) === 'Share a prayer or a message in his memory.');
  const xss = await tv.evaluate(() => window.__pwned === 1 || !!document.querySelector('.slide img'));
  check('message markup is rendered as plain text (no injection)', !xss);

  // Floating keywords must stay out of the portrait, message, caption and QR areas.
  let kwOverlap = 0;
  let kwSamples = 0;
  const kwOpacities = await tv.evaluate(() => [...document.querySelectorAll('.kw')].map((k) => Number(getComputedStyle(k).opacity)));
  for (let i = 0; i < 24; i++) {
    const hit = await tv.evaluate(() => {
      const box = (e) => e.getBoundingClientRect();
      const protectedRects = ['portraitBox', 'messageArea', 'qr'].map((id) => box(document.getElementById(id)));
      let count = 0;
      for (const kw of document.querySelectorAll('.kw')) {
        const lane = box(kw.parentElement);
        const k = box(kw);
        const x1 = Math.max(k.left, lane.left), x2 = Math.min(k.right, lane.right);
        const y1 = Math.max(k.top, lane.top), y2 = Math.min(k.bottom, lane.bottom);
        if (x2 <= x1 || y2 <= y1) continue; // fully clipped by its lane
        for (const p of protectedRects) if (x1 < p.right && p.left < x2 && y1 < p.bottom && p.top < y2) count++;
      }
      return count;
    });
    kwOverlap += hit;
    kwSamples++;
    await tv.waitForTimeout(250);
  }
  check('floating keywords never overlap portrait, message or QR', kwOverlap === 0, `${kwSamples} samples`);
  check('keywords are low-opacity (5–15%)', kwOpacities.length >= 8 && kwOpacities.every((o) => o >= 0.049 && o <= 0.151), `${kwOpacities.length} words`);

  // ═════════ 3. Scan the QR code with a separate phone ═════════
  section('Acceptance 3: scan the on-screen QR code');
  const qrPng = path.join(DATA_DIR, 'qr.png');
  await tv.locator('#qr').screenshot({ path: qrPng });
  let decoded = '';
  try {
    decoded = execFileSync('python3', ['-I', '-c', `
import cv2, sys
img = cv2.imread(sys.argv[1]); img = cv2.copyMakeBorder(img, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=(255, 255, 255))
val, pts, _ = cv2.QRCodeDetector().detectAndDecode(img); print(val)`, qrPng]).toString().trim();
  } catch (e) {
    decoded = `decode error: ${e.message}`;
  }
  check('the QR code decodes to the guest page address', /^https?:\/\/[^/]+\/$/.test(decoded), decoded);

  // ═════════ 4. Submit from a phone; it must queue, not interrupt ═════════
  section('Acceptance 4: submit from a phone — saved, queued, shown at the next transition');
  // Wait for a transition so we know exactly how long the current message has left.
  const before = await current(tv);
  await waitFor(async () => (await current(tv)).id !== before.id, { timeout: 30000, label: 'a rotation' });
  const slideAtSubmit = await current(tv);
  const textAtSubmit = await shownText(tv);

  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phone = await phoneCtx.newPage();
  let guestUrl = decoded.startsWith('http') ? decoded : `${BASE}/`;
  try {
    await phone.goto(guestUrl, { waitUntil: 'load', timeout: 8000 });
  } catch {
    guestUrl = `${BASE}/`; // QR points at the machine's LAN address; fall back to loopback if the sandbox can't route to it
    await phone.goto(guestUrl, { waitUntil: 'load' });
  }
  await phone.fill('#name', 'Lola Remedios');
  await phone.fill('#message', 'Thank you, Tay, for teaching us to pray together. We love you and we miss you.');
  const hScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check('guest page fits a phone screen (no sideways scrolling)', hScroll);
  await phone.click('#submit');
  await phone.waitForSelector('#done:not([hidden])', { timeout: 8000 });
  check('guest sees a confirmation', (await phone.locator('#done h2').textContent()) === 'Thank you');

  const saved = (await adminMessages()).find((m) => m.name === 'Lola Remedios');
  check('message is saved with a published status', saved && saved.status === 'published');
  const newId = saved.id;
  await waitFor(async () => (await eligibleIds(tv)).includes(newId), { timeout: 6000, label: 'sync to display' });
  check('new message synchronised to the TV within seconds', true);
  await tv.waitForTimeout(1500);
  const stillSame = await current(tv);
  check('current slide is preserved (not interrupted)', stillSame.id === slideAtSubmit.id && (await shownText(tv)) === textAtSubmit);

  await waitFor(async () => (await current(tv)).id !== slideAtSubmit.id, { timeout: 30000, label: 'next transition' });
  const afterTransition = await current(tv);
  check('new message appears at the very next transition', afterTransition.id === newId, `${(await shownText(tv)).slice(0, 40)}…`);

  // ═════════ 5–6. Hide it while it is on screen ═════════
  section('Acceptance 5–6: hide it from the admin panel while it is displayed');
  const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const admin = await adminCtx.newPage();
  await admin.goto(`${BASE}/admin`, { waitUntil: 'load' });
  await admin.fill('#password', PASSWORD);
  await admin.click('#loginBtn');
  await admin.waitForSelector('#adminView:not([hidden])');
  const card = admin.locator('.msg', { hasText: 'Lola Remedios' });
  await card.waitFor();
  check('admin sees the submission with timestamp and status', (await card.locator('.badge').textContent()) === 'published' && (await card.locator('time').getAttribute('datetime')) !== null);

  await mark(tv, 'after-hide');
  const hideAt = Date.now();
  await card.getByRole('button', { name: 'Hide' }).click();
  await waitFor(async () => (await current(tv)).id !== newId, { timeout: 4000, label: 'display to move on' });
  const moveMs = Date.now() - hideAt;
  check('hidden message leaves the display immediately', moveMs < 3000, `${moveMs} ms`);
  await tv.waitForTimeout(2500);
  const afterHide = (await getLog(tv)).filter((l) => l.phase === 'after-hide');
  check('presentation continues — never a blank message area', afterHide.every((l) => l.visibleLayers >= 1) && afterHide.at(-1).topOpacity > 0.99 && afterHide.at(-1).text.length > 0);
  check('a different message replaced it', afterHide.at(-1).id !== newId && afterHide.at(-1).text !== '');
  check('admin lists it as hidden', (await card.locator('.badge').textContent()) === 'hidden');

  // Speed up the rotation from the admin settings (also proves settings update the display live).
  await api('PUT', '/api/admin/settings', { rotationSeconds: 8 });
  await mark(tv, 'fast');
  await tv.waitForTimeout(34000);
  const fastLog = (await getLog(tv)).filter((l) => l.phase === 'fast');
  check('hidden message never returns to the rotation', !fastLog.some((l) => l.id === newId), `${transitions(fastLog).length} transitions watched`);

  // Restore → it should rejoin and be shown next.
  await mark(tv, 'restore');
  await card.getByRole('button', { name: 'Restore' }).click();
  await waitFor(async () => (await current(tv)).id === newId, { timeout: 12000, label: 'restored message' });
  check('restored message rejoins the rotation at the next transition', true);

  // ═════════ Whole-run checks on the sampled log ═════════
  section('Whole-run checks: stationary portrait, 20 s cadence, no repeats');
  const log = (await getLog(tv)).filter((l) => l.t > 0);
  const settled = log.filter((l) => l.portraitOpacity !== undefined).slice(15);
  check('portrait never fades or disappears (opacity stays 1)', settled.every((l) => l.portraitOpacity === 1), `${settled.length} samples`);
  const ref = settled[0].portraitBox;
  check('portrait never moves or resizes', settled.every((l) => l.portraitBox.every((v, i) => Math.abs(v - ref[i]) < 0.6)));
  const refQr = settled[0].qr;
  check('QR code never moves', settled.every((l) => l.qr.every((v, i) => Math.abs(v - refQr[i]) < 0.6)));
  const t20 = transitions(log.filter((l) => l.phase === 'start'));
  const intervals = t20.slice(1).map((t, i) => (t.t - t20[i].t) / 1000);
  check('messages change every 20 seconds at the default setting', intervals.length >= 1 && intervals.every((s) => Math.abs(s - 20) < 1.0), intervals.map((s) => s.toFixed(1)).join(', ') + ' s');
  const allT = transitions(log).filter((t) => t.from.kind === 'message' && t.to.kind === 'message');
  check('the same message is never repeated back-to-back', allT.every((t) => t.from.id !== t.to.id));
  check('the screen is never fully blank between messages', log.every((l) => l.visibleLayers >= 1));

  // ═════════ Reliability: temporary network failure ═════════
  section('Reliability: internet drops, then returns');
  await mark(tv, 'offline');
  await proxy.cut();
  const idsBefore = await eligibleIds(tv);
  // While the TV is offline: one new message arrives and one existing message is hidden.
  await post('Offline Olivia', 'This was written while the television had no internet.');
  const victim = (await state()).messages.find((m) => m.name === 'Uncle Ben');
  await api('POST', `/api/admin/messages/${victim.id}/hide`, {});
  await tv.waitForTimeout(20000);
  const offLog = (await getLog(tv)).filter((l) => l.phase === 'offline');
  check('rotation keeps running from loaded messages while offline', transitions(offLog).length >= 2, `${transitions(offLog).length} transitions`);
  check('portrait stays on screen while offline', offLog.slice(5).every((l) => l.portraitOpacity === 1));
  check('TV has not yet seen the offline changes (still the old list)', (await eligibleIds(tv)).join() === idsBefore.join());

  await proxy.start();
  await waitFor(async () => {
    const ids = await eligibleIds(tv);
    return ids.length && !ids.includes(victim.id) && (await tv.evaluate(() => window.__memorial.state.messages.some((m) => m.name === 'Offline Olivia')));
  }, { timeout: 40000, label: 'resync after reconnect' });
  check('new message and moderation change sync when connectivity returns', true);

  // ═════════ Reliability: reload the TV page while offline ═════════
  section('Reliability: reloading the display while offline');
  await tv.waitForTimeout(2500); // let the service worker finish caching
  await proxy.cut();
  await tv.reload({ waitUntil: 'load' }).catch(() => {});
  const reloaded = await waitFor(async () => {
    try {
      return (await current(tv)).kind === 'message';
    } catch {
      return false;
    }
  }, { timeout: 15000, label: 'offline reload' }).then(() => true, () => false);
  check('reloaded page still shows messages without internet', reloaded);
  const offlinePortrait = await waitFor(() => tv.evaluate(() => {
    const i = document.getElementById('portraitImg');
    return i.complete && i.naturalWidth > 0 && Number(getComputedStyle(i).opacity) === 1;
  }).catch(() => false), { timeout: 8000, label: 'portrait offline' }).then(() => true, () => false);
  check('reloaded page still shows the portrait without internet', offlinePortrait);
  await proxy.start();

  // ═════════ Narrow screen ═════════
  section('Responsive: narrow screen keeps the face undistorted');
  const narrow = await browser.newContext({ viewport: { width: 480, height: 900 } });
  const np = await narrow.newPage();
  await np.goto(`${BASE}/display`, { waitUntil: 'load' });
  await np.waitForFunction(() => document.getElementById('portraitImg').naturalWidth > 0 && Number(getComputedStyle(document.getElementById('portraitImg')).opacity) === 1);
  const nm = await np.evaluate(() => {
    const i = document.getElementById('portraitImg');
    const b = document.getElementById('portraitBox').getBoundingClientRect();
    return { fit: getComputedStyle(i).objectFit, imgRatio: i.naturalWidth / i.naturalHeight, boxRatio: b.width / b.height, scrollX: document.documentElement.scrollWidth > innerWidth };
  });
  check('stacked layout shows the whole photograph (contain) for a mismatched shape', nm.fit === 'contain', `photo ${nm.imgRatio.toFixed(2)} vs frame ${nm.boxRatio.toFixed(2)}`);
  check('no horizontal overflow on a narrow screen', !nm.scrollX);

  check('no JavaScript errors on the display', pageErrors.length === 0, pageErrors.join(' | '));

  // ═════════ Rate limit (last: it blocks this IP for a few minutes) ═════════
  section('Abuse protection');
  let limited = 0;
  for (let i = 0; i < 25; i++) if ((await post('Spammer', `message number ${i}`)).status === 429) limited++;
  check('rapid-fire submissions are rate limited', limited > 0, `${limited} blocked`);
} catch (err) {
  console.error('\nTEST ABORTED:', err.message);
  results.push({ name: 'test run completed', ok: false, detail: err.message });
} finally {
  await browser?.close().catch(() => {});
  await proxy.cut().catch(() => {});
  server?.kill('SIGTERM');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('Failed:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exit(1);
}
