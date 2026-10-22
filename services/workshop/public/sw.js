const CACHE = 'finance-vps-v67-tryon-tool';
const SHELL = [
  '/',
  '/manifest.webmanifest?v=4',
  '/icon-192-v3.png',
  '/icon-512-v3.png',
  '/icon-maskable-512-v3.png',
  '/apple-touch-icon-v3.png',
  '/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith('finance-vps-') && key !== CACHE)
    .map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin &&
      ['/kanban', '/crm', '/production', '/signs', '/tools/stamp', '/calculator', '/fonts'].some(path => url.pathname === path || url.pathname.startsWith(path + '/'))) return;
  if (event.request.url.includes('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (url.origin === self.location.origin && url.pathname === '/manifest.webmanifest') {
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(event.request)));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok && url.pathname === '/') {
        const copy = response.clone();
        void caches.open(CACHE).then((cache) => cache.put('/', copy));
      }
      return response;
    }).catch(() => caches.match('/')));
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match('/'))));
});
