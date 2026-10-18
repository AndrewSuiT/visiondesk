// VisionDesk PRO - Progressive Web App Service Worker
const CACHE_NAME = 'visiondesk-shell-v1';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/app.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install: Cache critical application shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CORE_ASSETS).catch((err) => {
        console.warn('[SW] Core assets pre-caching partial failure:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate: Clean old caches and claim existing clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Network-First with cache fallback (bypasses WebSocket and API calls)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Strictly skip non-GET requests, APIs, WebSocket tunnels and WebRTC signaling
  if (req.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws') || url.pathname.includes('/relay')) {
    return;
  }

  // Navigation requests: Network-First falling back to cached index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => {
        return caches.match('/index.html') || caches.match('/');
      })
    );
    return;
  }

  // Static assets: Network-First with cache fallback
  event.respondWith(
    fetch(req).then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(req, responseToCache);
        });
      }
      return response;
    }).catch(() => {
      return caches.match(req);
    })
  );
});
