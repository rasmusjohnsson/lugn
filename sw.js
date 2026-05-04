// Lugn — service worker
// - Caches the app shell for offline use
// - Handles notification click (focus/open the app)
// - Handles background scheduled notifications via Notification Triggers when supported

const VERSION = 'lugn-v3';
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

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cached = await caches.match(e.request);
    if (cached) {
      // Update in background
      fetch(e.request).then((res) => {
        if (res && res.ok) caches.open(VERSION).then(c => c.put(e.request, res.clone()));
      }).catch(() => {});
      return cached;
    }
    try {
      const res = await fetch(e.request);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
      }
      return res;
    } catch (err) {
      // Last resort: serve index for navigations
      if (e.request.mode === 'navigate') {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
      }
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
