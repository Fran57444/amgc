const CACHE_NAME = 'amgc-mobile-shell-v3';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const appUrl = new URL('./', self.registration.scope);
    const response = await fetch(appUrl);
    if (!response.ok) throw new Error(`No se pudo guardar la interfaz móvil (${response.status}).`);
    const html = await response.clone().text();
    const appAssets = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g))
      .map(match => new URL(match[1], appUrl).href)
      .filter(assetUrl => new URL(assetUrl).origin === self.location.origin);
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll([...new Set([appUrl.href, ...appAssets])]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter(name => name.startsWith('amgc-mobile-shell-') && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin) return;
  if (
    requestUrl.pathname.includes('/api/')
    || requestUrl.pathname.includes('/socket.io/')
    || requestUrl.pathname.startsWith('/mp3/')
    || requestUrl.pathname.startsWith('/uploads/')
    || requestUrl.pathname.startsWith('/media/')
  ) return;
  const isNavigation = event.request.mode === 'navigate';
  const isStaticAsset = ['script', 'style', 'image', 'font', 'manifest'].includes(event.request.destination);
  if (!isNavigation && !isStaticAsset) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (isStaticAsset) {
      const cachedResponse = await cache.match(event.request);
      if (cachedResponse) return cachedResponse;
    }
    try {
      const response = await fetch(event.request);
      if (response.ok && response.type === 'basic') await cache.put(event.request, response.clone());
      return response;
    } catch (error) {
      const cachedResponse = await cache.match(event.request);
      if (cachedResponse) return cachedResponse;
      if (isNavigation) {
        const appUrl = new URL('./', self.registration.scope);
        const appShell = await cache.match(appUrl.href);
        if (appShell) return appShell;
      }
      throw error;
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const { type, friendId } = event.notification.data || {};
    const existingWindow = windows[0];
    if (existingWindow) {
      existingWindow.postMessage(type === 'chat-message'
        ? { type: 'AMGC_CHAT_NOTIFICATION_CLICK', friendId }
        : { type: 'AMGC_PLAYBACK_NOTIFICATION_ACTION', action: event.action || '' });
      await existingWindow.focus();
      return;
    }

    const appUrl = new URL('./', self.registration.scope);
    if (type === 'chat-message' && friendId) appUrl.searchParams.set('chatFriend', friendId);
    else if (event.action) appUrl.searchParams.set('mediaAction', event.action);
    await self.clients.openWindow(appUrl.href);
  })());
});
