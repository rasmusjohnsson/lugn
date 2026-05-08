// Lugn — service worker
// - Caches the app shell for offline use
// - Handles notification click (focus/open the app)
// - Handles background scheduled notifications via Notification Triggers when supported

const VERSION = 'lugn-v6';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Strategy:
//   Network-first for the app shell (HTML/JS/CSS/JSON) so updates roll out
//   immediately when online, with cache as offline fallback.
//   Cache-first for static assets (icons, images) since they rarely change.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  const path = url.pathname;
  const isShell = path.endsWith('/') || /\.(html|js|css|json)$/.test(path);

  if (isShell) {
    e.respondWith((async () => {
      try {
        const res = await fetch(e.request, { cache: 'no-cache' });
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      } catch (err) {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        if (e.request.mode === 'navigate') {
          const fb = await caches.match('./index.html');
          if (fb) return fb;
        }
        throw err;
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const cached = await caches.match(e.request);
    if (cached) return cached;
    try {
      const res = await fetch(e.request);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      throw err;
    }
  })());
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: e.data ? e.data.text() : 'Lugn' }; }
  const title = data.title || 'Lugn';
  const opts = {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: './icon.svg',
    badge: './icon.svg',
    renotify: !!data.tag,
    data: data
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = list.find(c => c.url.includes(self.registration.scope)) || list[0];
    if (target) return target.focus();
    return self.clients.openWindow('./');
  })());
});

// Allow the page to ask the SW to schedule a notification at a specific timestamp
// using Notification Triggers (Chromium experimental). Falls back silently if unsupported.
self.addEventListener('message', (e) => {
  const data = e.data || {};
  if (data.type === 'schedule' && data.timestamp && data.title) {
    try {
      self.registration.showNotification(data.title, {
        body: data.body || '',
        tag: data.tag,
        showTrigger: 'TimestampTrigger' in self ? new TimestampTrigger(data.timestamp) : undefined,
        icon: './icon.svg'
      }).catch(() => {});
    } catch {}
  }
});
