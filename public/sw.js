// Lets the app open with no connection. Your own files are fetched fresh when online (cache as fallback);
// the versioned Firebase library files never change, so they come from the cache first.
const CACHE = 'todo-v9';
const SHELL = [
  './', './index.html', './style.css', './app.js', './model.js', './store.js', './richtext.js',
  './firebase-backend.js', './firebase-config.js', './manifest.webmanifest', './icon.svg', './help.html',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    })));
    return;
  }

  if (url.origin === self.location.origin && url.pathname.startsWith(new URL('./', self.registration.scope).pathname)) {
    e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  }
});
