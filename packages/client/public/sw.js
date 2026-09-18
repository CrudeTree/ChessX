// ChessX service worker: shows push notifications and focuses the game when tapped.
// Deliberately does no caching — the app is small and always fetched fresh.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: 'ChessX', body: '', url: '/', tag: 'chessx' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* plain text or empty payload */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      renotify: true,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { url: data.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Reuse an open ChessX tab if there is one, otherwise open a new one.
      const existing = clients.find((c) => c.url.startsWith(self.location.origin));
      if (existing) {
        existing.postMessage({ type: 'open', url });
        return existing.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
