'use strict';
/**
 * Memorial tribute server — zero npm dependencies (Node >= 22.13).
 *
 *   /          guest submission page (mobile first)
 *   /display   cinematic TV display
 *   /admin     protected moderation panel
 *
 * Messages are stored in SQLite (node:sqlite) in DATA_DIR and are published
 * automatically. Changes are pushed to every open display over Server-Sent Events.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { qrSvg } = require('./lib/qr');

// ───────────────────────── configuration ─────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const LIMITS = {
  name: 80,
  message: 700,
  jsonBody: 16 * 1024,
  portraitBytes: 15 * 1024 * 1024,
  sseClients: 300,
};
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ───────────────────────── database ─────────────────────────
const db = new DatabaseSync(path.join(DATA_DIR, 'memorial.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    message     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'published'
                CHECK (status IN ('published', 'hidden', 'pending')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages (status, created_at);
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const q = {
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ),
  delSetting: db.prepare('DELETE FROM settings WHERE key = ?'),
  published: db.prepare(
    "SELECT id, name, message, created_at AS createdAt FROM messages WHERE status = 'published' ORDER BY created_at ASC, rowid ASC"
  ),
  all: db.prepare(
    'SELECT id, name, message, status, created_at AS createdAt, updated_at AS updatedAt FROM messages ORDER BY created_at DESC, rowid DESC'
  ),
  insert: db.prepare(
    'INSERT INTO messages (id, name, message, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  recentDuplicate: db.prepare(
    "SELECT id FROM messages WHERE name = ? AND message = ? AND created_at > ? AND status != 'hidden' LIMIT 1"
  ),
  setStatus: db.prepare('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM messages WHERE id = ?'),
};

const getSetting = (key, fallback = null) => {
  const row = q.getSetting.get(key);
  return row ? row.value : fallback;
};
const setSetting = (key, value) => q.setSetting.run(key, String(value));

// ───────────────────────── admin credentials ─────────────────────────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifyStoredPassword(pw, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

let generatedPassword = null;
if (!process.env.ADMIN_PASSWORD && !getSetting('admin_password_hash')) {
  generatedPassword = crypto.randomBytes(9).toString('base64url');
  setSetting('admin_password_hash', hashPassword(generatedPassword));
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length === 0 || pw.length > 200) return false;
  if (process.env.ADMIN_PASSWORD) {
    return crypto.timingSafeEqual(sha256(pw), sha256(process.env.ADMIN_PASSWORD));
  }
  return verifyStoredPassword(pw, getSetting('admin_password_hash'));
}

let sessionSecret = getSetting('session_secret');
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  setSetting('session_secret', sessionSecret);
}
// Changing the admin password invalidates existing sessions.
const sessionKey = () =>
  crypto
    .createHmac('sha256', sessionSecret)
    .update(process.env.ADMIN_PASSWORD || getSetting('admin_password_hash', ''))
    .digest();
function signSession(exp) {
  return crypto.createHmac('sha256', sessionKey()).update(`v1.${exp}`).digest('base64url');
}
function issueSession() {
  const exp = Date.now() + SESSION_TTL_MS;
  return `${exp}.${signSession(exp)}`;
}
function sessionValid(token) {
  if (typeof token !== 'string') return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  const expected = Buffer.from(signSession(exp));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ───────────────────────── helpers ─────────────────────────
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}
function isHttps(req) {
  return TRUST_PROXY ? req.headers['x-forwarded-proto'] === 'https' : Boolean(req.socket.encrypted);
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Sliding-window rate limiter.
const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    return true;
  }
  arr.push(now);
  hits.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) {
    if (!arr.length || now - arr[arr.length - 1] > 30 * 60 * 1000) hits.delete(k);
  }
}, 5 * 60 * 1000).unref();

// Strip control characters and invisible/bidi-override characters that could be used to spoof text.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁩﻿]/g;
function cleanText(value, { max, multiline }) {
  if (typeof value !== 'string') return null;
  let s = value.normalize('NFC').replace(/\r\n?/g, '\n').replace(INVISIBLE, '');
  if (multiline) {
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  } else {
    s = s.replace(/\s+/g, ' ');
  }
  s = s.trim();
  if (!s || [...s].length > max) return null;
  return s;
}

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(Object.assign(new Error('Request too large'), { status: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) tooBig = true;
      else chunks.push(chunk);
    });
    req.on('end', () =>
      tooBig ? reject(Object.assign(new Error('Request too large'), { status: 413 })) : resolve(Buffer.concat(chunks))
    );
    req.on('error', reject);
  });
}
async function readJson(req, limit = LIMITS.jsonBody) {
  const buf = await readBody(req, limit);
  try {
    const parsed = JSON.parse(buf.toString('utf8') || '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

// ───────────────────────── live sync (SSE) ─────────────────────────
let rev = 1;
const clients = new Set();
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}
function bump() {
  rev += 1;
  broadcast('sync', { rev });
}
setInterval(() => broadcast('ping', { t: Date.now() }), 15000).unref();

function openEvents(req, res) {
  if (clients.size >= LIMITS.sseClients) return sendJson(res, 503, { error: 'Too many connections' });
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\nevent: hello\ndata: ${JSON.stringify({ rev })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

// ───────────────────────── settings / state ─────────────────────────
const DEFAULTS = { rotationSeconds: 20, portraitFocusY: 30 };

function publicSettings() {
  return {
    displayName: getSetting('display_name', ''),
    dates: getSetting('dates', ''),
    rotationSeconds: Number(getSetting('rotation_seconds', DEFAULTS.rotationSeconds)),
    portraitFocusY: Number(getSetting('portrait_focus_y', DEFAULTS.portraitFocusY)),
    portraitVersion: getSetting('portrait_version', null),
  };
}
function currentState(req) {
  return { rev, guestUrl: guestUrl(req), settings: publicSettings(), messages: q.published.all() };
}

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list || []) {
      if (nic.family === 'IPv4' && !nic.internal) return nic.address;
    }
  }
  return null;
}
function guestUrl(req) {
  const override = getSetting('guest_url', '');
  if (override) return override;
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const proto = isHttps(req) ? 'https' : 'http';
  let host = String((TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${PORT}`);
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1'].includes(hostname) && lanIp()) {
    host = `${lanIp()}:${PORT}`;
  }
  return `${proto}://${host}/`;
}

// ───────────────────────── portrait ─────────────────────────
const PORTRAIT_TYPES = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
};
const portraitFile = (ext) => path.join(DATA_DIR, `portrait.${ext}`);
function removePortraitFiles() {
  for (const t of Object.values(PORTRAIT_TYPES)) fs.rmSync(portraitFile(t.ext), { force: true });
}

function servePortrait(req, res, url) {
  const type = getSetting('portrait_type');
  const version = getSetting('portrait_version');
  const info = type && PORTRAIT_TYPES[type];
  if (!info) return send(res, 404, 'No portrait', { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  const file = portraitFile(info.ext);
  if (!fs.existsSync(file)) return send(res, 404, 'No portrait', { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  const etag = `"${version}"`;
  const versioned = url.searchParams.get('v') === version;
  const headers = {
    'Content-Type': type,
    ETag: etag,
    'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
  };
  if (req.headers['if-none-match'] === etag) return send(res, 304, '', headers);
  res.writeHead(200, { ...SECURITY_HEADERS, ...headers, 'Content-Length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
}

// ───────────────────────── static files ─────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const PAGES = { '/': 'guest.html', '/display': 'display.html', '/admin': 'admin.html' };

function serveStatic(req, res, pathname, noStore = false) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' });
  }
  if (rel.includes('\0')) return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' });
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }
  if (!stat.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': noStore ? 'no-store' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

// ───────────────────────── routing ─────────────────────────
const isAdmin = (req) => sessionValid(parseCookies(req).mem_admin);

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  // ---- public pages & assets
  if (method === 'GET' && PAGES[pathname]) {
    return serveStatic(req, res, PAGES[pathname], pathname === '/admin');
  }
  if (method === 'GET' && pathname === '/healthz') return sendJson(res, 200, { ok: true });
  if (method === 'GET' && pathname === '/portrait') return servePortrait(req, res, url);
  if (method === 'GET' && pathname === '/qr.svg') {
    const svg = qrSvg(guestUrl(req));
    const etag = `"${crypto.createHash('sha1').update(svg).digest('hex')}"`;
    const headers = { 'Content-Type': 'image/svg+xml', ETag: etag, 'Cache-Control': 'no-cache' };
    if (req.headers['if-none-match'] === etag) return send(res, 304, '', headers);
    return send(res, 200, svg, headers);
  }

  // ---- public API
  if (method === 'GET' && pathname === '/api/state') return sendJson(res, 200, currentState(req));
  if (method === 'GET' && pathname === '/api/events') return openEvents(req, res);

  if (method === 'POST' && pathname === '/api/messages') {
    if (rateLimited(`msg:${clientIp(req)}`, 20, 5 * 60 * 1000)) {
      return sendJson(res, 429, { error: 'Please wait a moment before sending another message.' });
    }
    const body = await readJson(req);
    // Honeypot: real people never fill this hidden field. Pretend success, store nothing.
    if (typeof body.website === 'string' && body.website.trim() !== '') return sendJson(res, 201, { ok: true });

    const name = cleanText(body.name, { max: LIMITS.name, multiline: false });
    const message = cleanText(body.message, { max: LIMITS.message, multiline: true });
    if (!name) return sendJson(res, 400, { error: `Please enter your name (up to ${LIMITS.name} characters).`, field: 'name' });
    if (!message) return sendJson(res, 400, { error: `Please write a message (up to ${LIMITS.message} characters).`, field: 'message' });

    // A double tap should not publish the same message twice.
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const dup = q.recentDuplicate.get(name, message, since);
    if (dup) return sendJson(res, 200, { ok: true, id: dup.id });

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    q.insert.run(id, name, message, 'published', now, now);
    bump();
    return sendJson(res, 201, { ok: true, id });
  }

  // ---- admin API
  if (pathname.startsWith('/api/admin/')) return handleAdmin(req, res, url, method);

  // ---- static assets (css/js/sw)
  if (method === 'GET') return serveStatic(req, res, pathname);

  return sendJson(res, 404, { error: 'Not found' });
}

async function handleAdmin(req, res, url, method) {
  const { pathname } = url;

  if (method === 'POST' && pathname === '/api/admin/login') {
    const ip = clientIp(req);
    if (rateLimited(`login:${ip}`, 8, 10 * 60 * 1000)) {
      return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    }
    if (req.headers['x-requested-with'] !== 'memorial') return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readJson(req);
    if (!checkPassword(body.password)) return sendJson(res, 401, { error: 'Incorrect password.' });
    const cookie =
      `mem_admin=${issueSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` +
      (isHttps(req) ? '; Secure' : '');
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  if (method === 'GET' && pathname === '/api/admin/session') {
    return sendJson(res, 200, { authenticated: isAdmin(req) });
  }

  // Everything below requires a valid session.
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Not signed in.' });
  // CSRF defence in depth on top of SameSite=Strict: mutating calls need a custom header.
  if (method !== 'GET' && req.headers['x-requested-with'] !== 'memorial') {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  if (method === 'POST' && pathname === '/api/admin/logout') {
    const cookie = 'mem_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + (isHttps(req) ? '; Secure' : '');
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  if (method === 'GET' && pathname === '/api/admin/messages') {
    return sendJson(res, 200, { rev, messages: q.all.all() });
  }

  const m = pathname.match(/^\/api\/admin\/messages\/([0-9a-f-]{36})(?:\/(hide|restore))?$/);
  if (m) {
    const [, id, action] = m;
    const now = new Date().toISOString();
    if (method === 'POST' && (action === 'hide' || action === 'restore')) {
      const status = action === 'hide' ? 'hidden' : 'published';
      const { changes } = q.setStatus.run(status, now, id);
      if (!changes) return sendJson(res, 404, { error: 'Message not found.' });
      bump();
      return sendJson(res, 200, { ok: true, status });
    }
    if (method === 'DELETE' && !action) {
      const { changes } = q.remove.run(id);
      if (!changes) return sendJson(res, 404, { error: 'Message not found.' });
      bump();
      return sendJson(res, 200, { ok: true });
    }
  }

  if (method === 'GET' && pathname === '/api/admin/settings') {
    return sendJson(res, 200, { ...publicSettings(), guestUrl: getSetting('guest_url', ''), effectiveGuestUrl: guestUrl(req) });
  }
  if (method === 'PUT' && pathname === '/api/admin/settings') {
    const body = await readJson(req);
    if ('displayName' in body) {
      const v = typeof body.displayName === 'string' ? body.displayName.replace(INVISIBLE, '').trim() : null;
      if (v === null || [...v].length > 80) return sendJson(res, 400, { error: 'Name is too long.' });
      setSetting('display_name', v);
    }
    if ('dates' in body) {
      const v = typeof body.dates === 'string' ? body.dates.replace(INVISIBLE, '').trim() : null;
      if (v === null || [...v].length > 40) return sendJson(res, 400, { error: 'Dates are too long.' });
      setSetting('dates', v);
    }
    if ('rotationSeconds' in body) {
      const v = Number(body.rotationSeconds);
      if (!Number.isInteger(v) || v < 8 || v > 120) return sendJson(res, 400, { error: 'Seconds per message must be between 8 and 120.' });
      setSetting('rotation_seconds', v);
    }
    if ('portraitFocusY' in body) {
      const v = Number(body.portraitFocusY);
      if (!Number.isFinite(v) || v < 0 || v > 100) return sendJson(res, 400, { error: 'Focus must be between 0 and 100.' });
      setSetting('portrait_focus_y', Math.round(v));
    }
    if ('guestUrl' in body) {
      const v = typeof body.guestUrl === 'string' ? body.guestUrl.trim() : null;
      if (v === null) return sendJson(res, 400, { error: 'Invalid address.' });
      if (v !== '') {
        let ok = false;
        try {
          const u = new URL(v);
          ok = (u.protocol === 'http:' || u.protocol === 'https:') && v.length <= 300;
        } catch {}
        if (!ok) return sendJson(res, 400, { error: 'The guest page address must be a full http(s) URL.' });
        setSetting('guest_url', v);
      } else {
        q.delSetting.run('guest_url');
      }
    }
    bump();
    return sendJson(res, 200, { ok: true, ...publicSettings(), guestUrl: getSetting('guest_url', ''), effectiveGuestUrl: guestUrl(req) });
  }

  if (method === 'PUT' && pathname === '/api/admin/portrait') {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const info = PORTRAIT_TYPES[type];
    if (!info) return sendJson(res, 415, { error: 'Please upload a JPEG, PNG or WebP photograph.' });
    const buf = await readBody(req, LIMITS.portraitBytes);
    if (!buf.length || !info.magic(buf)) return sendJson(res, 400, { error: 'That file does not look like a valid image.' });
    removePortraitFiles();
    const tmp = portraitFile(info.ext) + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, portraitFile(info.ext));
    setSetting('portrait_type', type);
    setSetting('portrait_version', Date.now().toString(36));
    bump();
    return sendJson(res, 200, { ok: true, portraitVersion: getSetting('portrait_version') });
  }
  if (method === 'DELETE' && pathname === '/api/admin/portrait') {
    removePortraitFiles();
    q.delSetting.run('portrait_type');
    q.delSetting.run('portrait_version');
    bump();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// ───────────────────────── server ─────────────────────────
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.end();
    const headers = status === 413 ? { Connection: 'close' } : {};
    sendJson(res, status, { error: status === 500 ? 'Something went wrong.' : err.message }, headers);
  });
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(PORT, HOST, () => {
  const ip = lanIp();
  const base = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : `http://${ip || 'localhost'}:${PORT}`;
  console.log('\nMemorial tribute is running');
  console.log(`  TV display : ${base}/display`);
  console.log(`  Guest page : ${base}/`);
  console.log(`  Admin panel: ${base}/admin`);
  console.log(`  Data folder: ${DATA_DIR}`);
  if (generatedPassword) {
    console.log('\n  First run — your admin password (shown once, save it now):');
    console.log(`  ${generatedPassword}`);
    console.log('  Set the ADMIN_PASSWORD environment variable to choose your own.\n');
  } else if (!process.env.ADMIN_PASSWORD) {
    console.log('  Admin password: the one generated on first run (or set ADMIN_PASSWORD).');
  }
});

function shutdown() {
  for (const res of clients) res.end();
  server.close(() => {
    try {
      db.close();
    } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
