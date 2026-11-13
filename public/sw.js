// Caches the app shell (CSS, scripts, icons, manifest) so pages load faster.
// Pages, /api/* and /live/* always go to the network, so scores, crowns and
// the queue are never served stale. Bump CACHE when the shell changes shape.
const CACHE = 'royale-shell-v1';
const SHELL = [
  '/style.css',
  '/live.js',
  '/track.js',
  '/player-preview.js',
  '/result-popup.js',
  '/todays-run.js',
  '/geo.js',
  '/map-tiles.js',
  '/park-photo.js',
  '/home-screen.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!SHELL.includes(url.pathname)) return; // only shell files are cached

  // Stale-while-revalidate: answer from the cache at once, refresh it in the background.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((hit) => {
        const network = fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        });
        if (hit) {
          network.catch(() => {});
          return hit;
        }
        return network;
      })
    )
  );
});
