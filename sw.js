const CACHE_NAME = 'tetris-neon-v3';
const APP_SHELL = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

// HTML/JSはネットワーク優先で取得し、修正が確実に反映されるようにする。
// オフライン時のみキャッシュにフォールバックする。
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // Firebase SDK(gstatic.com)やRealtime Database通信など他オリジンへのリクエストは
  // キャッシュに固定せずブラウザ標準の挙動に任せる（オフライン用途はアプリ本体のみが対象）。
  if (new URL(event.request.url).origin !== self.location.origin) return;
  const isAppShell = event.request.mode === 'navigate' || APP_SHELL.some((path) => event.request.url.endsWith(path.replace('./', '')));
  if (isAppShell) {
    event.respondWith(
      fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      return response;
    }))
  );
});
