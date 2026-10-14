/* Offline support for the TV display.
 * The display page, its assets, the portrait, the QR code and the last synchronised
 * message list are cached, so a reload during an internet outage still shows the tribute.
 * (Browsers only allow service workers on https:// or localhost.) */
const CACHE = 'memorial-v1';
const SHELL = ['/display', '/display.css', '/display.js', '/qr.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) {
      cache.put(request, res.clone());
      return res;
    }
    if (res.status >= 500) {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
    }
    return res;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const p = url.pathname;
  if (p === '/api/events') return; // live stream: never cache
  if (p === '/api/state' || p === '/display' || p === '/display.css' || p === '/display.js' || p === '/qr.svg') {
    event.respondWith(networkFirst(request));
  } else if (p === '/portrait') {
    event.respondWith(url.searchParams.has('v') ? cacheFirst(request) : networkFirst(request));
  }
});
