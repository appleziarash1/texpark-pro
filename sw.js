/* Texpark Pro service worker.
   The app is a single-page local-first tool, so once it is cached it opens
   instantly on a phone - with or without internet.

   The browser only installs a new service worker when this file's bytes
   change, so APP_VERSION must be bumped on every release. If it is not, phones
   keep serving the previous CSS and JS forever with no way to force an update. */
const APP_VERSION = '2027-01-01.3';
const CACHE = 'texpark-pro-' + APP_VERSION;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/db.js',
  './js/voice.js',
  './js/sync.js',
  './js/app.js',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      // An updated worker takes over already-open pages; reload them so the new
      // CSS and JS actually appear without the user knowing to hard-refresh.
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => clients.forEach(c => { try { c.navigate(c.url); } catch (err) {} }))
      .catch(() => {})
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // Google Sheets sync etc. goes straight to the network

  // The page itself and the code that runs it must never win from cache, or a
  // phone stays stuck on an old release. The APK is in this group too: it is a
  // download, and serving a cached copy would quietly reinstall an older build.
  const mustBeFresh = req.mode === 'navigate' ||
    /\.(?:js|css|webmanifest|apk)$/.test(url.pathname);

  if (mustBeFresh) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // Icons and the like: cache first, refresh quietly in the background.
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
