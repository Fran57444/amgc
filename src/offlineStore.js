const DATABASE_NAME = 'amgc-offline-cache';
const DATABASE_VERSION = 3;

let databasePromise;

function openDatabase() {
    if (!('indexedDB' in globalThis)) {
        return Promise.reject(new Error('Este dispositivo no permite almacenamiento offline.'));
    }
    if (!databasePromise) {
        databasePromise = new Promise((resolve, reject) => {
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
            request.onsuccess = () => {
                request.result.onversionchange = () => request.result.close();
                resolve(request.result);
            };
            request.onerror = () => reject(request.error || new Error('No se pudo abrir la caché offline.'));
            request.onblocked = () => reject(new Error('La caché offline está ocupada por otra ventana.'));
        }).catch(error => {
            databasePromise = null;
            throw error;
        });
    }
    return databasePromise;
}

async function readRecord(storeName, key) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readonly');
        const request = transaction.objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('No se pudo leer la caché offline.'));
    });
}

async function writeRecord(storeName, record) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).put(record);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('No se pudo guardar la caché offline.'));
        transaction.onabort = () => reject(transaction.error || new Error('Se canceló el guardado offline.'));
    });
}

export async function getOfflineLibrary(userId) {
    return readRecord('libraries', String(userId));
}

export async function saveOfflineLibrary(userId, songs) {
    return writeRecord('libraries', {
        userId: String(userId),
        songs,
        updatedAt: Date.now()
    });
}

export async function getOfflinePlaylists(userId) {
    return readRecord('playlists', String(userId));
}

export async function saveOfflinePlaylists(userId, playlists) {
    const existing = await getOfflinePlaylists(userId);
    return writeRecord('playlists', {
        userId: String(userId),
        playlists,
        profilePlaylists: existing?.profilePlaylists || {},
        playlistSavers: existing?.playlistSavers || {},
        updatedAt: Date.now()
    });
}

export async function getOfflineProfilePlaylists(userId, profileUserId) {
    const record = await getOfflinePlaylists(userId);
    return record?.profilePlaylists?.[String(profileUserId)] || null;
}

export async function saveOfflineProfilePlaylists(userId, profileUserId, playlists) {
    const record = await getOfflinePlaylists(userId);
    return writeRecord('playlists', {
        userId: String(userId),
        playlists: record?.playlists || [],
        profilePlaylists: {
            ...(record?.profilePlaylists || {}),
            [String(profileUserId)]: playlists
        },
        playlistSavers: record?.playlistSavers || {},
        updatedAt: Date.now()
    });
}

export async function getOfflinePlaylistSavers(userId, playlistId) {
    const record = await getOfflinePlaylists(userId);
    return record?.playlistSavers?.[String(playlistId)] || null;
}

export async function saveOfflinePlaylistSavers(userId, playlistId, data) {
    const record = await getOfflinePlaylists(userId);
    return writeRecord('playlists', {
        userId: String(userId),
        playlists: record?.playlists || [],
        profilePlaylists: record?.profilePlaylists || {},
        playlistSavers: {
            ...(record?.playlistSavers || {}),
            [String(playlistId)]: data
        },
        updatedAt: Date.now()
    });
}

export async function getOfflineFriends(userId) {
    return readRecord('friends', String(userId));
}

export async function saveOfflineFriends(userId, friends) {
    return writeRecord('friends', {
        userId: String(userId),
        friends,
        updatedAt: Date.now()
    });
}

export async function getOfflineMedia(key) {
    return readRecord('media', key);
}

export async function getOfflineMediaIndex() {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction('media', 'readonly');
        const request = transaction.objectStore('media').openCursor();
        const records = new Map();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve(records);
                return;
            }
            records.set(cursor.value.key, cursor.value.sourceUrl || '');
            cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error('No se pudo leer el índice offline.'));
    });
}

export async function saveOfflineMedia(key, blob, contentType = '', sourceUrl = '') {
    return writeRecord('media', {
        key,
        blob,
        contentType,
        sourceUrl,
        updatedAt: Date.now()
    });
}
