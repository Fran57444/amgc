const SHELL_CACHE = 'amgc-app-shell-v4';
const DATABASE_NAME = 'amgc-offline-cache';
const DATABASE_VERSION = 3;

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        const response = await fetch('/');
        if (!response.ok) throw new Error(`No se pudo preparar la interfaz offline (${response.status}).`);
        const html = await response.clone().text();
        await cache.put('/', response.clone());
        await cache.put('/index.html', response);
        const assetPaths = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g))
            .map(match => match[1])
            .filter(assetPath => assetPath.startsWith('/assets/'));
        await cache.addAll(['/manifest.webmanifest', '/chaos.ico', ...assetPaths]);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames
            .filter(name => name.startsWith('amgc-app-shell-') && name !== SHELL_CACHE)
            .map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

function readOfflineMedia(key) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains('libraries')) {
                database.createObjectStore('libraries', { keyPath: 'userId' });
            }
            if (!database.objectStoreNames.contains('playlists')) {
                database.createObjectStore('playlists', { keyPath: 'userId' });
            }
            if (!database.objectStoreNames.contains('friends')) {
                database.createObjectStore('friends', { keyPath: 'userId' });
            }
            if (!database.objectStoreNames.contains('media')) {
                database.createObjectStore('media', { keyPath: 'key' });
            }
        };
        request.onerror = () => reject(request.error || new Error('No se pudo abrir la caché offline.'));
        request.onsuccess = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains('media')) {
                database.close();
                resolve(null);
                return;
            }
            const transaction = database.transaction('media', 'readonly');
            const mediaRequest = transaction.objectStore('media').get(key);
            mediaRequest.onsuccess = () => {
                const record = mediaRequest.result;
                database.close();
                resolve(record?.blob || null);
            };
            mediaRequest.onerror = () => {
                database.close();
                reject(mediaRequest.error || new Error('No se pudo leer el archivo offline.'));
            };
        };
    });
}

self.addEventListener('fetch', event => {
    const requestUrl = new URL(event.request.url);
    if (requestUrl.origin !== self.location.origin || event.request.method !== 'GET') return;

    const offlineMedia = requestUrl.pathname.match(/^\/__offline\/(song|playlist|friend)\/([^/]+)\/(audio|cover|photo)$/);
    if (offlineMedia) {
        event.respondWith((async () => {
            const [, resourceType, encodedId, kind] = offlineMedia;
            const id = decodeURIComponent(encodedId);
            const mediaType = resourceType === 'song' ? kind : kind;
            const key = `${resourceType}:${id}:${mediaType}`;
            try {
                const blob = await readOfflineMedia(key);
                if (blob) {
                    return new Response(blob, {
                        headers: {
                            'Content-Type': blob.type || 'application/octet-stream',
                            'Cache-Control': 'no-store'
                        }
                    });
                }
            } catch (error) {
                console.error('No se pudo recuperar un archivo offline:', error);
            }
            return new Response('Recurso no disponible sin conexión.', { status: 404 });
        })());
        return;
    }

    if (
        requestUrl.pathname.startsWith('/api/')
        || requestUrl.pathname.startsWith('/socket.io/')
        || requestUrl.pathname.startsWith('/mp3/')
    ) return;
    event.respondWith((async () => {
        const cache = await caches.open(SHELL_CACHE);
        try {
            const response = await fetch(event.request);
            if (response.ok && response.type === 'basic') {
                await cache.put(event.request, response.clone());
            }
            return response;
        } catch (error) {
            const cached = await cache.match(event.request, { ignoreVary: true });
            if (cached) return cached;
            if (event.request.mode === 'navigate') {
                const appShell = await cache.match('/index.html');
                if (appShell) return appShell;
            }
            throw error;
        }
    })());
});
