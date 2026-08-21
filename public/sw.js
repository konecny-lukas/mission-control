/* Mission Control v2 service worker — network-first so edits show on reload,
   with a cached shell as offline fallback (port of the v1 pattern). Live data
   (API/SSE), the terminal and all reverse-proxied apps are never touched.
   SHELL enumerates every v2 file explicitly — no globbing, keep in sync. */
const CACHE = 'mc-v2-oss-1';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/drawers.js',
  '/core/dom.js', '/core/esc.js', '/core/net.js', '/core/store.js',
  '/gl/core.js',
  '/ui/boot.js', '/ui/console-kit.js', '/ui/drawer.js', '/ui/jarvis.js', '/ui/palette.js',
  '/ui/panels.js', '/ui/term.js', '/ui/thread.js', '/ui/timeline.js', '/ui/viewer.js',
  '/icon.svg', '/icon-maskable.svg', '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // live, never cache: API + SSE, terminál, náhledy, /file
  if (/^\/(api|term|preview|file)(\/|$)/.test(url.pathname)) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request)),
  );
});
