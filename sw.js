// ponytail: network-first 單一快取，改版不用改版本號；離線才吃快取
importScripts('./streak.js');            // 借用 ymd()
const CACHE = 'kamee-v1', STATE = 'kamee-state', REMIND_HOUR = 9;
const ASSETS = ['./', './index.html', './manifest.webmanifest', './streak.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== STATE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then(hit => hit || caches.match('./index.html')))
  );
});

// 已安裝的 PWA 才會拿到 periodicsync，觸發時間由瀏覽器決定（通常一天數次）
self.addEventListener('periodicsync', e => {
  if (e.tag === 'daily-checkin') e.waitUntil(remind());
});

async function remind() {
  const now = new Date();
  if (now.getHours() < REMIND_HOUR) return;          // 早上九點前不吵
  const today = ymd(now);
  const c = await caches.open(STATE);
  const st = await c.match('./state').then(r => r ? r.json() : null).catch(() => null) || {};
  if (st.last === today || st.notified === today) return;   // 今天打過卡或提醒過了
  await self.registration.showNotification('KAMEE 打卡提醒', {
    body: '今天還沒打卡，記得吃保健品 🌿',
    icon: './icons/icon-192.png', badge: './icons/icon-192.png', tag: 'kamee-daily'
  });
  await c.put('./state', new Response(JSON.stringify({ ...st, notified: today })));
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const hit = cs.find(c => c.url.startsWith(self.registration.scope));
    return hit ? hit.focus() : self.clients.openWindow('./');
  }));
});
