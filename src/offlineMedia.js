import {
    getOfflineMedia,
    getOfflineMediaIndex,
    saveOfflineMedia
} from './offlineStore.js';

export function createOfflineMediaManager({ apiUrl, getState, updateStatus, getActiveObjectUrl }) {
    const objectUrls = new Map();
    let syncInProgress = false;
    let syncRequested = false;
    let cacheCompleted = 0;
    let cacheTotal = 0;

    function getOfflineResourceUrl(resource) {
        const apiOrigin = new URL(apiUrl, window.location.origin).origin;
        const resolvedUrl = new URL(resource, window.location.href);
        if (resolvedUrl.pathname.startsWith('/mp3/')) {
            return new URL(`${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}`, apiOrigin).href;
        }
        if (['localhost', '127.0.0.1', '[::1]'].includes(resolvedUrl.hostname)) {
            return new URL(`${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}`, apiOrigin).href;
        }
        return resolvedUrl.href;
    }

    async function getOfflineObjectUrl(key) {
        if (objectUrls.has(key)) return objectUrls.get(key);
        const record = await getOfflineMedia(key);
        if (!record?.blob) return null;
        const objectUrl = URL.createObjectURL(record.blob);
        objectUrls.set(key, objectUrl);
        return objectUrl;
    }

    async function getOfflineImageUrl(resourceType, id, kind, key) {
        if (!(await getOfflineMedia(key))?.blob) return '';
        if (navigator.serviceWorker?.controller) {
            return `/__offline/${resourceType}/${encodeURIComponent(String(id))}/${kind}`;
        }
        return await getOfflineObjectUrl(key) || '';
    }

    async function hydrateOfflineSongCovers(songs) {
        await Promise.all(songs.map(async song => {
            if (!song.cover) return;
            song.localCover = await getOfflineImageUrl(
                'song',
                song._id,
                'cover',
                `song:${song._id}:cover`
            );
        }));
    }

    async function hydrateOfflinePlaylistCovers(playlists) {
        await Promise.all(playlists.map(async playlistItem => {
            if (!playlistItem.photo || playlistItem.photo === '/img/vinculo.png') return;
            playlistItem.localPhoto = await getOfflineImageUrl(
                'playlist',
                playlistItem.id,
                'photo',
                `playlist:${playlistItem.id}:photo`
            );
        }));
    }

    async function cacheRemoteResource(key, resourceUrl) {
        const resolvedUrl = getOfflineResourceUrl(resourceUrl);
        const existing = await getOfflineMedia(key);
        if (existing?.sourceUrl === resolvedUrl) return false;
        const resourceHost = new URL(resolvedUrl).host;
        let response;
        let blob;
        let lastNetworkError;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                response = await fetch(resolvedUrl, { credentials: 'omit' });
                if (response.ok) {
                    blob = await response.blob();
                    break;
                }
                if (response.status !== 429 && response.status < 500) {
                    throw new Error(`El servidor respondió ${response.status} al descargar un recurso offline.`);
                }
                lastNetworkError = new Error(`El servidor respondió ${response.status}.`);
            } catch (error) {
                if (error instanceof TypeError) {
                    lastNetworkError = error;
                } else {
                    throw error;
                }
            }
            if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 750 * (2 ** attempt)));
            }
        }
        if (!response?.ok || !blob) {
            throw new Error(`No se pudo descargar desde ${resourceHost} después de 3 intentos: ${lastNetworkError?.message || 'respuesta vacía del servidor'}`);
        }
        if (!blob.size) throw new Error('El recurso descargado está vacío.');
        await saveOfflineMedia(key, blob, blob.type, resolvedUrl);
        const cachedObjectUrl = objectUrls.get(key);
        if (cachedObjectUrl && getActiveObjectUrl() !== cachedObjectUrl) {
            URL.revokeObjectURL(cachedObjectUrl);
            objectUrls.delete(key);
        }
        return true;
    }

    async function syncOfflineResources() {
        const initialState = getState();
        if (!initialState.enabled || initialState.offlineOnly
            || !initialState.accessToken || !initialState.online) return;
        if (syncInProgress) {
            syncRequested = true;
            return;
        }
        syncInProgress = true;
        let failureCount = 0;
        let downloadedResourceCount = 0;
        let firstFailure = '';
        let storageFull = false;
        try {
            do {
                syncRequested = false;
                const state = getState();
                const resources = new Map();
                const addResource = (key, url) => {
                    if (url && typeof url === 'string' && !url.startsWith('data:')) resources.set(key, url);
                };
                state.playlist.forEach(song => {
                    addResource(`song:${song._id}:audio`, song.path);
                    addResource(`song:${song._id}:cover`, song.cover);
                });
                state.userPlaylists.forEach(playlistItem => {
                    addResource(`playlist:${playlistItem.id}:photo`, playlistItem.photo);
                });
                state.profilePlaylists.forEach(profilePlaylists => {
                    profilePlaylists.forEach(playlistItem => {
                        addResource(`playlist:${playlistItem.id}:photo`, playlistItem.photo);
                    });
                });
                state.playlistSavers.forEach(users => {
                    users.forEach(user => {
                        addResource(`friend:${user._id}:photo`, user.profilePhoto);
                    });
                });
                const friendsWithAvatars = [...state.currentFriends];
                state.currentFriends.forEach(friend => friendsWithAvatars.push(...(friend.friends || [])));
                friendsWithAvatars.forEach(friend => {
                    addResource(`friend:${friend._id}:photo`, friend.profilePhoto);
                });
                if (state.localUser?._id) {
                    addResource(`friend:${state.localUser._id}:photo`, state.localUser.profilePhoto);
                }

                const cachedResources = await getOfflineMediaIndex();
                const missingResources = [...resources].filter(([key, url]) => (
                    cachedResources.get(key) !== getOfflineResourceUrl(url)
                ));
                cacheTotal = missingResources.length;
                cacheCompleted = 0;
                if (!cacheTotal) {
                    updateStatus('La música, las carátulas y los datos disponibles ya están guardados.');
                    continue;
                }
                updateStatus(`Descargando ${cacheTotal} recursos para uso offline…`, {
                    completed: 0,
                    total: cacheTotal
                });
                let nextResourceIndex = 0;
                const workerCount = Math.min(4, missingResources.length);
                const downloadWorker = async () => {
                    while (
                        getState().enabled
                        && getState().online
                        && !storageFull
                        && nextResourceIndex < missingResources.length
                    ) {
                        const [key, url] = missingResources[nextResourceIndex];
                        nextResourceIndex += 1;
                        try {
                            if (await cacheRemoteResource(key, url)) downloadedResourceCount += 1;
                        } catch (error) {
                            failureCount += 1;
                            if (!firstFailure) firstFailure = error.message;
                            console.warn(`No se pudo guardar ${key} para uso offline.`, error);
                            if (error.name === 'QuotaExceededError') storageFull = true;
                        } finally {
                            cacheCompleted += 1;
                            updateStatus(
                                `Descargas offline: ${cacheCompleted}/${cacheTotal}${failureCount ? ` · ${failureCount} con error` : ''}.`,
                                { completed: cacheCompleted, total: cacheTotal }
                            );
                            if (storageFull) {
                                updateStatus(`Almacenamiento local lleno. Se guardaron ${cacheCompleted}/${cacheTotal} recursos; libera espacio para continuar.`, {
                                    completed: cacheCompleted,
                                    total: cacheTotal
                                });
                            }
                        }
                    }
                };
                await Promise.all(Array.from({ length: workerCount }, () => downloadWorker()));
                if (!getState().online) {
                    updateStatus(`Descarga pausada sin conexión (${cacheCompleted}/${cacheTotal}). Se reanudará al reconectar.`, {
                        completed: cacheCompleted,
                        total: cacheTotal
                    });
                    break;
                }
                if (!getState().enabled) break;
            } while (syncRequested && !storageFull);

            if (storageFull) {
                updateStatus(`Almacenamiento local lleno. Se guardaron ${cacheCompleted}/${cacheTotal} recursos; libera espacio para continuar.`, {
                    completed: cacheCompleted,
                    total: cacheTotal
                });
            } else if (failureCount && navigator.onLine && getState().enabled) {
                updateStatus(`${failureCount} recursos no se pudieron guardar. ${firstFailure}`);
            } else if (!failureCount && downloadedResourceCount > 0 && navigator.onLine && getState().enabled) {
                updateStatus('Descarga offline completada.');
            }
        } catch (error) {
            console.error('No se pudo sincronizar la caché offline.', error);
            updateStatus(`No se pudo completar la caché offline: ${error.message}`);
        } finally {
            syncInProgress = false;
        }
    }

    function forgetObjectUrl(key) {
        objectUrls.delete(key);
    }

    function dispose() {
        objectUrls.forEach(objectUrl => URL.revokeObjectURL(objectUrl));
        objectUrls.clear();
    }

    function getProgress() {
        return { completed: cacheCompleted, total: cacheTotal };
    }

    return {
        dispose,
        forgetObjectUrl,
        getOfflineImageUrl,
        getOfflineObjectUrl,
        getProgress,
        hydrateOfflinePlaylistCovers,
        hydrateOfflineSongCovers,
        syncOfflineResources
    };
}
