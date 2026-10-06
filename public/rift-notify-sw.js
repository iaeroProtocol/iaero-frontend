// public/rift-notify-sw.js
//
// Shows "Get iAERO" order notifications where a page cannot show them itself (Android's browsers only allow
// notifications through a service worker). Registered by the page only when the user turns notifications on,
// with a scope no page lives under, so it never controls the site. It has no fetch handler and caches nothing.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Tapping a notification brings the site back (an open tab if there is one).
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = windows.find(w => new URL(w.url).origin === self.location.origin);
    if (page) return page.focus();
    return self.clients.openWindow('/');
  })());
});
