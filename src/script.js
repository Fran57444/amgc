import { io } from 'socket.io-client';
import {
    getOfflineFriends,
    getOfflineLibrary,
    getOfflinePlaylistSavers,
    getOfflineProfilePlaylists,
    getOfflinePlaylists,
    saveOfflineFriends,
    saveOfflineLibrary,
    saveOfflinePlaylistSavers,
    saveOfflineProfilePlaylists,
    saveOfflinePlaylists
} from './offlineStore.js';
import { createOfflineMediaManager } from './offlineMedia.js';
import { createSongListRenderer } from './songList.js';
import { fetchSpotifyLikedTracksPage } from './spotifyClient.js';
import {
    formatPlaybackRelativeTime,
    getPlaybackElapsedSeconds,
    getPlaybackLastHeardAt,
    getPlaybackLastHeardLabel
} from './playbackActivity.js';

export function initMusicPlayer() {
    const API_URL = import.meta.env.VITE_API_URL || '/api';
    const realtimeEnabled = import.meta.env.VITE_REALTIME_ENABLED !== 'false';
    const desktopYoutubeDownloader = window.amgcDesktop?.downloadYoutubeAudio;
    const desktopYoutubeLocalSaver = window.amgcDesktop?.saveYoutubeAudioLocally;
    const desktopOpenLocalMp3Folder = window.amgcDesktop?.openLocalMp3Folder;
    const desktopSetDiscordPresence = window.amgcDesktop?.setDiscordPresence;
    const desktopSubscribeTaskbarControls = window.amgcDesktop?.subscribeTaskbarControls;
    const desktopUnsubscribeTaskbarControls = window.amgcDesktop?.unsubscribeTaskbarControls;
    const desktopSetTaskbarPlaybackState = window.amgcDesktop?.setTaskbarPlaybackState;
    const desktopUpdates = window.amgcDesktop;
    const accessTokenStorageKey = 'amgc-access-token';
    const playbackDeviceStorageKey = 'amgc-playback-device-id';
    let playbackDeviceId = localStorage.getItem(playbackDeviceStorageKey);
    if (!playbackDeviceId) {
        playbackDeviceId = window.crypto && typeof window.crypto.randomUUID === 'function'
            ? window.crypto.randomUUID()
            : `desktop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem(playbackDeviceStorageKey, playbackDeviceId);
    }
    const playbackDeviceType = 'desktop';
    let accessToken = localStorage.getItem(accessTokenStorageKey) || '';
    let isLoggingOut = false;
    let offlineOnly = false;
    let offlineModeEnabled = false;
    let offlineDownloadPopupTimer = null;
    let offlineRecoveryTimer = null;
    let offlineSessionRefreshInProgress = false;
    let offlineListeningBuffer = 0;
    let offlineListeningLastSample = null;
    let offlineListeningLastPersistAt = 0;
    let offlineListeningSyncInProgress = false;
    let suppressNextListeningDelta = false;
    let playbackStatusSyncTimer = null;
    let sharedDevicePlayback = null;
    let playbackOwnerConfirmed = false;
    let suppressRemotePlaybackPause = false;
    let sharedPlaybackClockTimer = null;
    let connectedPlaybackDevices = [];
    let playbackTransferPending = false;
    let deferredPlaybackOwnerUpdate = null;
    let playbackDeviceRemovalPending = false;
    let playbackRequestLoadingCount = 0;
    let audioLoading = false;
    let loadingTrackId = '';
    let offlineAudioSongIds = new Set();
    let renderAllSongs = () => {};
    let pendingPlaybackTakeoverRetryTimer = null;
    let pendingPlaybackTakeoverRetryDelay = 30000;
    let pendingPlaybackTakeoverNotifiedSongId = '';
    let activePlaybackTransferId = null;
    let activePlaybackTransferUserId = null;
    let isActivatingPlaybackTransfer = false;
    const socket = io(import.meta.env.VITE_SOCKET_URL || window.location.origin, {
        autoConnect: false,
        transports: ['websocket', 'polling'],
        auth: callback => callback({ token: accessToken })
    });
    const connectRealtime = () => {
        if (realtimeEnabled) socket.connect();
    };
    const offlineMediaManager = createOfflineMediaManager({
        apiUrl: API_URL,
        getState: () => ({
            enabled: offlineModeEnabled,
            offlineOnly,
            accessToken,
            online: navigator.onLine,
            playlist,
            userPlaylists,
            profilePlaylists: [...profilePlaylistCache.values()],
            playlistSavers: [...playlistSaversCache.values()],
            currentFriends,
            localUser: getCachedOfflineUser() || getStoredUser()
        }),
        updateStatus: updateOfflineCacheStatus,
        getActiveObjectUrl: () => activeAudioObjectUrl
    });
    const getOfflineObjectUrl = (key, source) => offlineMediaManager.getOfflineObjectUrl(key, source);
    const getOfflineAudioSongIds = () => offlineMediaManager.getOfflineAudioSongIds();
    const getOfflineImageUrl = (...args) => offlineMediaManager.getOfflineImageUrl(...args);
    const hydrateOfflineSongCovers = songs => offlineMediaManager.hydrateOfflineSongCovers(songs);
    const hydrateOfflinePlaylistCovers = playlists => offlineMediaManager.hydrateOfflinePlaylistCovers(playlists);
    const syncOfflineResources = async () => {
        await offlineMediaManager.syncOfflineResources();
        await hydrateOfflineSongCovers(playlist);
        await hydrateOfflinePlaylistCovers(userPlaylists);
        await Promise.all([...profilePlaylistCache.values()].map(hydrateOfflinePlaylistCovers));
        await refreshOfflineAudioAvailability();
        if (isAllSongsMode) renderAllSongs();
        else if (isPlaylistViewMode && activePlaylistId) openPlaylistView(activePlaylistId);
        renderQueue({ syncAccount: false, syncShared: false });
        const currentTrack = getCurrentTrack();
        if (currentTrack) bottomBarCover.src = getSongCover(currentTrack) || '/img/vinculo.png';
    };
    let realtimeConnectedBefore = false;
    let skipNextRealtimeReconciliation = false;
    const profilePlaylistCache = new Map();
    const playlistSaversCache = new Map();
    socket.off('friendsChanged').on('friendsChanged', async () => {
        socket.emit('friendsChanged');
        await loadFriends();
        if (isPlaylistViewMode && activePlaylistId) openPlaylistView(activePlaylistId);
    });
    socket.off('songCatalogChanged').on('songCatalogChanged', async () => {
        const queueTrackIds = activeQueueTracks.map(track => String(track._id));
        await fetchMusicData();
        if (isPlaylistViewMode && activePlaylistId) openPlaylistView(activePlaylistId);
        if (generalQueueAnchorTrackId) {
            const anchorTrack = playlist.find(track => String(track._id) === generalQueueAnchorTrackId);
            if (!anchorTrack) generalQueueAnchorTrackId = null;
        }
        activeQueueTracks = queueTrackIds
            .map(trackId => playlist.find(track => String(track._id) === trackId))
            .filter(Boolean);
        renderQueue();
        if (isLyricsMode) updateLyricsView();
        if (isProfileMode) renderProfile();
        syncOfflineResources();
    });
    socket.off('songSuggestionsChanged').on('songSuggestionsChanged', () => {
        void loadSongSuggestions();
    });
    socket.off('userStatsChanged').on('userStatsChanged', ({ userId } = {}) => {
        const profileUser = selectedProfileUser || getStoredUser();
        if (isProfileMode && profileUser?._id && String(profileUser._id) === String(userId)) {
            renderProfile(true);
        }
    });
    socket.off('userHistoryChanged').on('userHistoryChanged', ({ userId, lastPlayedHistory } = {}) => {
        if (!userId || !Array.isArray(lastPlayedHistory)) return;
        const normalizedUserId = String(userId);
        const friend = currentFriends.find(item => String(item._id) === normalizedUserId);
        if (friend) friend.lastPlayedHistory = lastPlayedHistory;
        if (String(getStoredUser()?._id || '') === normalizedUserId) {
            const currentUser = getStoredUser();
            if (currentUser) setStoredUser({ ...currentUser, lastPlayedHistory });
        }
        const displayedProfile = selectedProfileUser || getStoredUser();
        if (String(displayedProfile?._id || '') === normalizedUserId) {
            if (selectedProfileUser) {
                selectedProfileUser = { ...selectedProfileUser, lastPlayedHistory };
            }
            if (isProfileMode) renderProfile();
        }
        if (friend) scheduleFriendsOfflineSave();
    });
    socket.off('userChanged').on('userChanged', async ({ userId } = {}) => {
        if (String(getStoredUser()?._id || '') !== String(userId || '') || !accessToken || offlineOnly) return;
        try {
            const response = await apiFetch(`${API_URL}/auth/me`);
            if (!response.ok) throw new Error(`No se pudo actualizar el perfil (${response.status}).`);
            const updatedUser = await response.json();
            const previousUser = getStoredUser();
            const permissionsChanged = previousUser?.isAdmin !== updatedUser.isAdmin
                || JSON.stringify(previousUser?.permissions || []) !== JSON.stringify(updatedUser.permissions || []);
            setStoredUser(updatedUser);
            saveCachedOfflineUser(updatedUser);
            syncSecretPhrasesFromUser(updatedUser);
            await loadSecretPhrases(updatedUser);
            if (Number.isFinite(Number(updatedUser.settings?.seekSeconds))) {
                seekSeconds = Number(updatedUser.settings.seekSeconds);
                if (inputSeekSeconds) inputSeekSeconds.value = String(seekSeconds);
            }
            if (Number.isFinite(Number(updatedUser.settings?.maxVolume))) {
                maxVolume = Math.min(10, Math.max(1, Number(updatedUser.settings.maxVolume) / 100));
                localStorage.setItem('maxVolume', String(maxVolume));
                if (inputMaxVolume) inputMaxVolume.value = String(Math.round(maxVolume * 100));
                if (volumeSlider) volumeSlider.max = String(maxVolume * 100);
                if (currentVolume > maxVolume) {
                    currentVolume = maxVolume;
                    gainNode.gain.value = maxVolume;
                    if (volumeSlider) volumeSlider.value = String(maxVolume * 100);
                }
                updateVolumeSliderUI(currentVolume);
            }
            syncAccessControls();
            if (isAdminMode && !canCurrentUser('manage_users')) {
                isAdminMode = false;
                updateBackgroundAndViews();
            }
            if (realtimeEnabled && permissionsChanged && socket.connected) {
                socket.disconnect();
                connectRealtime();
            }
            if (isAllSongsMode) renderAllSongs();
            if (isProfileMode) renderProfile();
        } catch (error) {
            console.warn('No se pudo sincronizar el perfil en tiempo real.', error);
        }
    });
    socket.off('playlistsChanged').on('playlistsChanged', async () => {
        try {
            await loadPlaylists();
        } catch (error) {
            console.warn('No se pudieron actualizar las playlists guardadas en tiempo real.', error);
        }
    });
    socket.off('playlistSavesChanged').on('playlistSavesChanged', payload => {
        if (!payload?.playlistId || !Number.isFinite(Number(payload.savedCount))) return;
        const playlistId = String(payload.playlistId);
        const savedCount = Math.max(0, Number(payload.savedCount));
        const matchingPlaylists = [
            ...userPlaylists,
            ...(publicProfilePlaylists || []),
            ...[...profilePlaylistCache.values()].flat()
        ];
        matchingPlaylists.forEach(item => {
            if (String(item.id) === playlistId) item.savedCount = savedCount;
        });
        const savedCountButton = plViewOwner?.querySelector('#pl-view-saved-count');
        if (String(savedCountButton?.dataset.playlistId || '') === playlistId) {
            savedCountButton.textContent = savedCount
                ? `guardada - ${savedCount} ${savedCount === 1 ? 'vez' : 'veces'}`
                : '';
            savedCountButton.hidden = savedCount === 0;
        }
        if (payload.user?._id && typeof payload.saved === 'boolean' && playlistSaversCache.has(playlistId)) {
            const cachedSavers = playlistSaversCache.get(playlistId);
            const nextSavers = cachedSavers.filter(user => String(user._id) !== String(payload.user._id));
            if (payload.saved) nextSavers.push(payload.user);
            nextSavers.sort((a, b) => String(a.username).localeCompare(String(b.username), 'es'));
            playlistSaversCache.set(playlistId, nextSavers);
            if (playlistSaversModal?.classList.contains('active') && activePlaylistId === playlistId) {
                renderPlaylistSavers(nextSavers).catch(error => {
                    console.warn('No se pudieron mostrar los cambios en las personas que guardaron la playlist.', error);
                });
            }
            const viewerId = String(getStoredUser()?._id || '');
            if (viewerId) {
                saveOfflinePlaylistSavers(viewerId, playlistId, { count: savedCount, users: nextSavers }).catch(error => {
                    console.warn('No se pudo actualizar la caché offline de personas que guardaron la playlist.', error);
                });
            }
        }
        const viewerId = String(getStoredUser()?._id || '');
        if (viewerId) {
            saveOfflinePlaylists(viewerId, userPlaylists).catch(error => {
                console.warn('No se pudo actualizar la caché offline de playlists.', error);
            });
            profilePlaylistCache.forEach((items, profileId) => {
                saveOfflineProfilePlaylists(viewerId, profileId, items).catch(error => {
                    console.warn('No se pudo actualizar la caché offline del perfil.', error);
                });
            });
        }
    });
    socket.off('adminUsersChanged').on('adminUsersChanged', () => {
        if (isAdminMode) loadAdminUsers();
    });
    socket.off('accountRemoved').on('accountRemoved', () => {
        accessToken = '';
        localStorage.removeItem(accessTokenStorageKey);
        socket.disconnect();
        setStoredUser(null);
        localStorage.removeItem('amgc-offline-user');
        showAuthOverlay();
        showToast('Esta cuenta fue eliminada. Inicia sesión con otra cuenta.', true);
    });
    socket.off('accountAccessChanged').on('accountAccessChanged', () => {
        if (!accessToken) return;
        socket.disconnect();
        connectRealtime();
    });
    socket.off('connect').on('connect', async () => {
        playbackOwnerConfirmed = false;
        accountQueueDeviceId = null;
        restoreAccountQueueCache();
        flushPendingAccountQueue();
        socket.emit('playbackStateRequest', { deviceId: playbackDeviceId, deviceType: playbackDeviceType });
        void resumePendingPlaybackTakeover();
        const isReconnect = realtimeConnectedBefore;
        realtimeConnectedBefore = true;
        void loadSongSuggestions(false);
        const shouldReconcile = isReconnect && !skipNextRealtimeReconciliation;
        skipNextRealtimeReconciliation = false;
        if (shouldReconcile && accessToken && !offlineOnly && navigator.onLine) {
            try {
                const response = await apiFetch(`${API_URL}/auth/me`);
                if (!response.ok) throw new Error(`No se pudo reconciliar la sesión (${response.status}).`);
                const updatedUser = await response.json();
                setStoredUser(updatedUser);
                saveCachedOfflineUser(updatedUser);
                syncSecretPhrasesFromUser(updatedUser);
                await loadSecretPhrases(updatedUser);
                syncAccessControls();
                await syncOfflineListening();
                await Promise.all([fetchMusicData(), loadPlaylists(), loadFriends()]);
                if (isProfileMode) renderProfile();
                if (offlineModeEnabled) await syncOfflineResources();
            } catch (error) {
                console.warn('No se pudo reconciliar el estado tras reconectar.', error);
            }
        }
        if (listeningTogetherUserId) joinListenTogetherQueue(listeningTogetherUserId, true);
        if (!audio.paused && getCurrentTrack() && !getRemotePlaybackSession()) {
            broadcastPlaybackState(true);
        }
        if (activeChatFriendId) loadChatMessages(false);
        refreshChatNotifications();
    });
    socket.off('disconnect').on('disconnect', () => {
        playbackOwnerConfirmed = false;
        renderSharedPlaybackStatus();
        leaveListenTogetherQueue();
        if (!listeningTogetherUserId) return;
        listeningTogetherAwaitingFreshPlayback = true;
        friendRealtimeUpdates.delete(String(listeningTogetherUserId));
        if (currentTrackSource === 'together') {
            resetSynchronizedPlaybackRate();
            if (!audio.paused) audio.pause();
        }
        updateListeningTogetherStatus();
    });
    const refreshFriendsAfterForeground = () => {
        if (!accessToken || offlineOnly || !navigator.onLine) return;
        if (realtimeEnabled && !socket.connected) connectRealtime();
        void loadFriends();
    };
    window.addEventListener('online', refreshFriendsAfterForeground);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            refreshFriendsAfterForeground();
            syncProfileActivityTimer();
        }
    });
    const apiFetch = async (url, options = {}) => {
        const isLoginRequest = String(url).includes('/auth/login');
        if (!navigator.onLine || (offlineOnly && !isLoginRequest)) {
            const error = new Error('Esta acción requiere conexión. El contenido guardado sigue disponible offline.');
            error.name = 'OfflineModeError';
            throw error;
        }
        const headers = new Headers(options.headers || {});
        if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
        const response = await fetch(url, { ...options, headers });
        if (response.status === 401 && !String(url).includes('/auth/login')) {
            accessToken = '';
            localStorage.removeItem(accessTokenStorageKey);
            localStorage.removeItem('amgc-user');
            socket.disconnect();
            const overlay = document.getElementById('auth-overlay');
            if (overlay) overlay.style.display = 'flex';
        }
        return response;
    };
    async function refreshOfflineSession() {
        if (!accessToken || !navigator.onLine || offlineSessionRefreshInProgress) return false;
        offlineSessionRefreshInProgress = true;
        try {
            const response = await fetch(`${API_URL}/auth/me`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            if (response.status === 401) {
                accessToken = '';
                localStorage.removeItem(accessTokenStorageKey);
                if (offlineRecoveryTimer) {
                    clearInterval(offlineRecoveryTimer);
                    offlineRecoveryTimer = null;
                }
                if (authOverlay) authOverlay.style.display = 'flex';
                return false;
            }
            if (!response.ok) return false;
            const refreshedUser = await response.json();
            const updatedUser = { ...(getStoredUser() || refreshedUser), ...refreshedUser };
            setStoredUser(updatedUser);
            saveCachedOfflineUser(updatedUser);
            offlineOnly = false;
            syncOfflineStatusIndicators();
            syncAccessControls();
            if (isProfileMode) renderProfile();
            if (!(await syncOfflineListening())) {
                offlineOnly = true;
                syncOfflineStatusIndicators();
                syncAccessControls();
                socket.disconnect();
                return false;
            }
            if (offlineRecoveryTimer) {
                clearInterval(offlineRecoveryTimer);
                offlineRecoveryTimer = null;
            }
            skipNextRealtimeReconciliation = true;
            connectRealtime();
            await Promise.all([fetchMusicData(), loadFriends(), loadPlaylists()]);
            await syncOfflineResources();
            if (isProfileMode) renderProfile();
            return true;
        } catch (error) {
            offlineOnly = true;
            syncOfflineStatusIndicators();
            syncAccessControls();
            socket.disconnect();
            console.warn('El servidor aún no está disponible para salir del modo offline.', error);
            return false;
        } finally {
            offlineSessionRefreshInProgress = false;
        }
    }
    function startOfflineRecoveryTimer() {
        if (offlineRecoveryTimer || !accessToken) return;
        offlineRecoveryTimer = setInterval(() => {
            if (offlineOnly && navigator.onLine) refreshOfflineSession();
            else if (!offlineOnly) {
                clearInterval(offlineRecoveryTimer);
                offlineRecoveryTimer = null;
            }
        }, 30000);
    }
    async function renderPlaylistSavers(users) {
        if (!playlistSaversList) return;
        playlistSaversList.replaceChildren();
        if (!users.length) {
            const emptyItem = document.createElement('li');
            emptyItem.textContent = 'Nadie la ha guardado todavía.';
            playlistSaversList.appendChild(emptyItem);
            return;
        }
        for (const user of users) {
            const item = document.createElement('li');
            item.className = 'playlist-saver-item';
            const photo = document.createElement('img');
            photo.alt = '';
            photo.loading = 'lazy';
            const photoKey = `friend:${user._id}:photo`;
            const photoUrl = offlineOnly
                ? await getOfflineImageUrl('friend', user._id, 'photo', photoKey)
                : (user.profilePhoto || '');
            if (photoUrl) {
                photo.src = photoUrl;
            } else {
                photo.hidden = true;
            }
            const name = document.createElement('span');
            name.textContent = user.username || 'Usuario';
            item.append(photo, name);
            playlistSaversList.appendChild(item);
        }
    }
    const applyOfflineProfilePhoto = async (user) => {
        if (!user?._id || !user.profilePhoto) return;
        const profilePhoto = await getOfflineImageUrl(
            'friend',
            user._id,
            'photo',
            `friend:${user._id}:photo`
        );
        if (!profilePhoto) return;
        localStorage.setItem('amgc-user', JSON.stringify({ ...user, profilePhoto }));
        renderProfile();
    };
    const handleOfflineStorageChange = event => {
        if (!event.key?.startsWith('amgc-offline-enabled-')) return;
        const user = getStoredUser() || getCachedOfflineUser();
        if (!user?._id || event.key !== `amgc-offline-enabled-${user._id}`) return;
        offlineModeEnabled = event.newValue === 'true';
        if (offlineModeToggle) offlineModeToggle.checked = offlineModeEnabled;
        if (offlineModeEnabled) syncOfflineResources();
    };
    window.addEventListener('storage', handleOfflineStorageChange);
    const showToast = (message, error = false) => {
        if (!error) return;
        let toast = document.getElementById('app-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'app-toast';
            document.body.appendChild(toast);
        }

        toast.textContent = message;
        toast.classList.remove('annoy-indicator');
        toast.removeAttribute('title');
        toast.removeAttribute('aria-label');
        toast.classList.toggle('error', error);
        toast.classList.add('visible');
        clearTimeout(showToast.timer);
        showToast.timer = setTimeout(() => toast.classList.remove('visible'), 3500);
    };
    const showAnnoyIndicator = (description) => {
        let toast = document.getElementById('app-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'app-toast';
            document.body.appendChild(toast);
        }

        toast.textContent = '!';
        toast.title = description;
        toast.setAttribute('aria-label', description);
        toast.classList.remove('error');
        toast.classList.add('annoy-indicator', 'visible');
        clearTimeout(showToast.timer);
        showToast.timer = setTimeout(() => toast.classList.remove('visible'), 1600);
    };
    const playMessageNotification = () => {
        try {
            const context = new AudioContext();
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.frequency.value = 880;
            gain.gain.setValueAtTime(0.08, context.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start();
            oscillator.stop(context.currentTime + 0.18);
        } catch (error) {
            console.warn('No se pudo reproducir la notificación de mensaje', error);
        }
    };
    let boomAudioBufferPromise = null;
    async function getBoomAudioBuffer(context) {
        if (!boomAudioBufferPromise) {
            boomAudioBufferPromise = fetch('/airhorn.mp3')
                .then(response => {
                    if (!response.ok) throw new Error(`No se pudo cargar airhorn.mp3 (${response.status}).`);
                    return response.arrayBuffer();
                })
                .then(buffer => context.decodeAudioData(buffer));
        }
        return boomAudioBufferPromise;
    }
    async function playAnnoySound() {
        const buffer = await getBoomAudioBuffer(audioCtx);
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        if (audioCtx.state !== 'running') {
            throw new Error('El navegador bloqueó el audio. Haz clic en la página y vuelve a intentarlo.');
        }
        const source = audioCtx.createBufferSource();
        const gain = audioCtx.createGain();
        source.buffer = buffer;
        gain.gain.value = 0.8;
        source.connect(gain);
        gain.connect(audioCtx.destination);
        source.addEventListener('ended', () => {
            source.disconnect();
            gain.disconnect();
        }, { once: true });
        source.start();
    }
    async function refreshChatNotifications() {
        const user = getStoredUser();
        if (!user || !chatFriendsList) return;
        if (offlineOnly || !navigator.onLine) {
            chatNotificationDot?.classList.remove('visible');
            if (unreadMessageIndicator) unreadMessageIndicator.hidden = true;
            return;
        }
        let notifications = [];
        try {
            notifications = await fetchJsonWithRetry(`${API_URL}/notifications/${user._id}`, {}, 2);
        } catch {
            notifications = [];
        }
        const states = currentFriends.map(friend => ({
            friend,
            unread: notifications.some(message => String(message.sender) === String(friend._id)),
            annoyed: annoyedFriendIds.has(String(friend._id))
        }));
        chatFriendsList.innerHTML = states.map(({ friend, unread, annoyed }) => `
            <li class="chat-friend-item" data-chat-friend-id="${escapeHtml(friend._id)}">
                <img src="${escapeHtml(friend.profilePhoto || '/img/perrocorasongif.gif')}" alt="" />
                <span class="chat-friend-name">${escapeHtml(friend.username)}</span>
                <i class="chat-friend-status-dot ${friend.isOnline ? 'online' : ''}" aria-label="${friend.isOnline ? 'En línea' : 'Desconectado'}"></i>
                ${annoyed ? '<span class="chat-annoy-indicator" aria-label="Te ha molestado">!</span>' : ''}
                ${unread ? '<i class="chat-unread-dot" aria-label="Mensajes nuevos"></i>' : ''}
            </li>
        `).join('');
        const hasUnread = notifications.length > 0;
        chatNotificationDot?.classList.toggle('visible', hasUnread);
        if (unreadMessageIndicator) unreadMessageIndicator.hidden = !hasUnread;
        chatFriendsList.querySelectorAll('[data-chat-friend-id]').forEach(item => {
            item.addEventListener('click', () => {
                const friend = currentFriends.find(entry => String(entry._id) === String(item.dataset.chatFriendId));
                if (friend) {
                    annoyedFriendIds.delete(String(friend._id));
                    openChat(friend._id, friend.username);
                }
            });
        });
    }
    const mainContent = document.getElementById("main-content");
    const merged = document.getElementById("merged-symbol");
    const playerPopup = document.getElementById("music-player-popup");
    const popupCover = document.getElementById("popup-cover");
    const popupSongName = document.getElementById("popup-song-name");
    const bottomBarWrapper = document.getElementById("bottom-bar-wrapper");
    const bottomBar = document.getElementById("bottom-bar");
    const trackNameEl = document.getElementById("track-name");
    const trackArtistEl = document.getElementById("track-artist");
    const trackDurationEl = document.getElementById("track-duration");
    const btnPrev = document.getElementById("btn-prev");
    const btnPlayPause = document.getElementById("btn-playpause");
    const btnNext = document.getElementById("btn-next");
    const btnRewind = document.getElementById("btn-rewind");
    const btnForward = document.getElementById("btn-forward");
    const progressContainer = document.getElementById("progress-container");
    const progressBar = document.getElementById("progress-bar");
    const sharedPlaybackStatus = document.getElementById('shared-playback-status');
    const sharedPlaybackTitleText = document.getElementById('shared-playback-title-text');
    const sharedPlaybackArtist = document.getElementById('shared-playback-artist');
    const sharedPlaybackCover = document.getElementById('shared-playback-cover');
    const sharedPlaybackProgressFill = document.getElementById('shared-playback-progress-fill');
    const sharedPlaybackTimeLabel = document.getElementById('shared-playback-time');
    const playbackDevicePicker = document.getElementById('playback-device-picker');
    const playbackDeviceList = document.getElementById('playback-device-list');
    const playbackDeviceTriggers = [...document.querySelectorAll('[data-playback-device-trigger]')];
    const bottomBarCover = document.getElementById("bottom-bar-cover");
    const btnShuffle = document.getElementById("btn-shuffle");
    const btnQueue = document.getElementById("btn-queue");
    const queueContainer = document.getElementById("queue-container");
    const queueList = document.getElementById("queue-list");
    const queueJamControls = document.getElementById('queue-jam-controls');
    const btnRequestJam = document.getElementById('btn-request-jam');
    const jamRequestNotification = document.getElementById('jam-request-notification');
    const jamRequestMessage = document.getElementById('jam-request-message');
    const btnAcceptJamRequest = document.getElementById('jam-request-accept');
    const btnDeclineJamRequest = document.getElementById('jam-request-decline');
    const btnVolume = document.getElementById("btn-volume");
    const volumeSlider = document.getElementById("volume-slider");
    const volumeTooltip = document.getElementById("volume-tooltip");
    const btnLyrics = document.getElementById("btn-lyrics");
    const btnAllSongs = document.getElementById("btn-all-songs");
    const btnSettings = document.getElementById("btn-settings");
    const btnAdmin = document.getElementById("btn-admin");
    const btnProfile = document.getElementById("btn-profile");
    const btnCloseProfile = document.getElementById("btn-close-profile");
    const btnProfileChatFriend = document.getElementById("btn-profile-chat-friend");
    const profilePanel = document.getElementById("profile-panel");
    const profileName = document.getElementById("profile-name");
    const profileAvatar = document.getElementById("profile-avatar");
    const sidebarProfileAvatar = document.querySelector(".profile-sidebar-avatar");
    const profilePhotoButton = document.getElementById("profile-photo-button");
    const profilePhotoInput = document.getElementById("profile-photo-input");
    const sidebarProfileName = document.getElementById("sidebar-profile-name");
    const sidebarOfflineStatus = document.getElementById("sidebar-offline-status");
    const profilePlaylists = document.getElementById("profile-playlists");
    const profileActivity = document.getElementById("profile-activity");
    const profileStatus = document.getElementById("profile-status");
    const profileHistoryCard = document.getElementById("profile-history-card");
    const profileHistory = document.getElementById("profile-history");
    const profileFriends = document.getElementById("profile-friends");
    const profileStats = document.getElementById("profile-stats");
    const btnAddSongHeader = document.getElementById("btn-add-song-header");
    const lyricsPanel = document.getElementById("lyrics-panel");
    const nowPlayingLyric = document.getElementById("now-playing-lyric");
    const nowPlayingLyricText = document.getElementById("now-playing-lyric-text");
    const nowPlayingLyricIncoming = document.getElementById("now-playing-lyric-incoming");
    const nowPlayingLyricNext = document.getElementById("now-playing-lyric-next");
    const nowPlayingLyricTrack = nowPlayingLyric?.querySelector('.now-playing-lyric-track');
    const secretText = document.getElementById("secret-text");
    const secretPhrasesInput = document.getElementById("secret-phrases-input");
    const secretPhrasesPersonalToggle = document.getElementById("secret-phrases-personal");
    const btnSaveSecretPhrases = document.getElementById("btn-save-secret-phrases");
    const secretPhrasesStatus = document.getElementById("secret-phrases-status");
    const allSongsPanel = document.getElementById("all-songs-panel");
    const quickAddPanel = document.getElementById("quick-add-panel");
    const quickAddSuggestionsList = document.getElementById("quick-add-suggestions-list");
    const btnCloseQuickAdd = document.getElementById("btn-close-quick-add");
    const settingsPanel = document.getElementById("settings-panel");
    const adminPanel = document.getElementById("admin-panel");
    const allSongsList = document.getElementById("all-songs-list");
    const allSongsSearch = document.getElementById("all-songs-search");
    const songSuggestionForm = document.getElementById("song-suggestion-form");
    const songSuggestionInput = document.getElementById("song-suggestion-input");
    const spotifyConnectButton = document.getElementById('spotify-connect-button');
    const spotifyRefreshButton = document.getElementById('spotify-refresh-button');
    const spotifyDisconnectButton = document.getElementById('spotify-disconnect-button');
    const spotifyLoadMoreButton = document.getElementById('spotify-load-more-button');
    const spotifyImportButton = document.getElementById('spotify-import-button');
    const spotifyLikesSearch = document.getElementById('spotify-likes-search');
    const spotifyLikesStatus = document.getElementById('spotify-likes-status');
    const spotifyLikesList = document.getElementById('spotify-likes-list');
    const spotifyLikesSection = document.getElementById('spotify-likes-section');
    const spotifyPlaylistImportStatus = document.getElementById('spotify-playlist-import-status');
    const spotifyPlaylistConnectButton = document.getElementById('spotify-playlist-connect-button');
    const spotifyPlaylistsLoadButton = document.getElementById('spotify-playlist-load-button');
    const spotifyPlaylistsMoreButton = document.getElementById('spotify-playlist-more-button');
    const spotifyPlaylistsList = document.getElementById('spotify-playlist-list');
    const inputSeekSeconds = document.getElementById("input-seek-seconds");
    const inputMaxVolume = document.getElementById("input-max-volume");
    const discordPresenceImageTextInput = document.getElementById("discord-presence-image-text");
    const btnSaveDiscordPresenceImageText = document.getElementById("btn-save-discord-presence-image-text");
    const discordPresenceImageTextStatus = document.getElementById("discord-presence-image-text-status");
    const offlineModeToggle = document.getElementById('offline-mode-toggle');
    const offlineCacheProgress = document.getElementById('offline-cache-progress');
    const offlineCacheStatus = document.getElementById('offline-cache-status');
    const offlineDownloadPopup = document.getElementById('offline-download-popup');
    const offlineDownloadPopupTitle = document.getElementById('offline-download-popup-title');
    const offlineDownloadPopupMessage = document.getElementById('offline-download-popup-message');
    const offlineDownloadProgressFill = document.getElementById('offline-download-progress-fill');
    const offlineDownloadProgressLabel = document.getElementById('offline-download-progress-label');
    const btnLogoutSettings = document.getElementById("btn-logout-settings");
    const adminUsersList = document.getElementById("admin-users-list");
    const adminUserForm = document.getElementById("admin-user-form");
    const adminBackToCreate = document.getElementById("admin-back-to-create");
    const adminFormStatus = document.getElementById("admin-form-status");
    const adminFormUsername = document.getElementById("admin-form-username");
    const adminFormPassword = document.getElementById("admin-form-password");
    const adminFormIsAdmin = document.getElementById("admin-form-is-admin");
    const adminPermissionOptions = Array.from(document.querySelectorAll('[data-permission-option]'));
    
    const editInputYt = document.getElementById("edit-input-yt");
    const editYoutubeSearchInput = document.getElementById("edit-youtube-search-input");
    const editYoutubeSearchButton = document.getElementById("edit-youtube-search-button");
    const editYoutubeSearchResults = document.getElementById("edit-youtube-search-results");
    const editYoutubeSelectedResult = document.getElementById("edit-youtube-selected-result");
    const btnSettingsYt = document.getElementById("btn-settings-yt-download");
    const btnOpenLocalMp3Folder = document.getElementById("btn-open-local-mp3-folder");
    const inputSettingsYt = document.getElementById("settings-yt-link");
    const inputSettingsYtName = document.getElementById("settings-yt-name");
    const statusSettingsYt = document.getElementById("settings-yt-status");
    const ytDownloadPopupTemplate = document.getElementById("yt-download-popup");
    const downloadNotificationStack = document.getElementById("download-notification-stack");
    let spotifyLikedTracks = [];
    let spotifySelectedTrackIds = new Set();
    let spotifyIsConnected = false;
    let spotifyRequiredScopesGranted = false;
    let spotifyPlaylistScopesGranted = false;
    let spotifyIdentityLinked = false;
    let spotifyNextOffset = 0;
    let spotifyTotal = 0;
    let spotifyHasMore = false;
    let spotifyLikedTracksLoaded = false;
    let spotifyPlaylists = [];
    let spotifyPlaylistsNextOffset = 0;
    let spotifyPlaylistsHasMore = false;
    let spotifyPlaylistsLoaded = false;
    const spotifyPlaylistSyncs = new Set();
    let spotifyApiAccessToken = '';
    let spotifyApiAccessTokenExpiresAt = 0;
    let spotifyApiAccessTokenUserId = '';
    let spotifyApiAccessTokenRequest = null;

    const btnPlayAllSongs = document.getElementById("btn-play-all-songs");
    const btnPlayPlaylist = document.getElementById("btn-play-playlist");

    const sidebarShell = document.querySelector(".sidebar-shell");
    const sidebarTrigger = document.querySelector(".sidebar-trigger");
    const btnHome = document.getElementById("btn-home");
    const btnCreatePlaylist = document.getElementById("btn-create-playlist");
    const sidebarPlaylists = document.getElementById("sidebar-playlists");
    
    const friendsPanel = document.getElementById("friends-panel");
    const btnCloseFriends = document.getElementById("btn-close-friends");
    const inputAddFriend = document.getElementById("input-add-friend");
    const btnAddFriend = document.getElementById("btn-add-friend");
    const friendsList = document.getElementById("friends-list");
    const friendsSidebarList = document.getElementById("friends-sidebar-list");
    const chatModal = document.getElementById("chat-modal");
    const chatTitle = document.getElementById("chat-title");
    const chatTitleStatus = document.getElementById("chat-title-status");
    const chatMessages = document.getElementById("chat-messages");
    const btnOpenChat = document.getElementById("btn-open-chat");
    const chatNotificationDot = document.getElementById("chat-notification-dot");
    const btnDesktopUpdate = document.getElementById("btn-desktop-update");
    const desktopUpdateIcon = btnDesktopUpdate?.querySelector('.desktop-update-icon');
    const desktopUpdateDot = document.getElementById("desktop-update-dot");
    const unreadMessageIndicator = document.getElementById("unread-message-indicator");
    const chatFriendsList = document.getElementById("chat-friends-list");
    const chatFriendsView = document.getElementById("chat-friends-view");
    const chatConversationView = document.getElementById("chat-conversation-view");
    const btnChatBack = document.getElementById("btn-chat-back");
    const chatHeaderAvatar = document.getElementById("chat-header-avatar");
    const chatInput = document.getElementById("chat-input");
    const btnSendMessage = document.getElementById("btn-send-message");
    const btnAnnoyFriend = document.getElementById("btn-annoy-friend");
    const btnCloseChat = document.getElementById("btn-close-chat");
    const listeningTogetherStatus = document.getElementById("listening-together-status");
    const btnExitListeningTogether = document.getElementById("btn-exit-listening-together");
    const profileFriendsGrid = document.getElementById("profile-friends-grid");
    const btnOpenFriendsPanel = document.getElementById("btn-open-friends-panel");

    let desktopUpdateState = null;
    const renderDesktopUpdateState = state => {
        if (!btnDesktopUpdate || !state) return;
        desktopUpdateState = state;
        const versionLabel = state.version ? ` v${state.version}` : '';
        if (!['available', 'downloading', 'downloaded'].includes(state.status)) {
            btnDesktopUpdate.hidden = true;
            desktopUpdateDot?.classList.remove('visible');
            return;
        }

        btnDesktopUpdate.hidden = false;
        desktopUpdateDot?.classList.add('visible');
        if (state.status === 'available') {
            btnDesktopUpdate.disabled = false;
            btnDesktopUpdate.setAttribute('aria-label', `Descargar actualización${versionLabel}`);
            btnDesktopUpdate.title = state.error
                ? `${state.error} Pulsa para reintentar.`
                : `Descargar actualización${versionLabel}`;
            if (desktopUpdateIcon) desktopUpdateIcon.textContent = '↓';
        } else if (state.status === 'downloading') {
            btnDesktopUpdate.disabled = true;
            btnDesktopUpdate.setAttribute('aria-label', `Descargando actualización${versionLabel}: ${state.progress || 0}%`);
            btnDesktopUpdate.title = `Descargando actualización${versionLabel}: ${state.progress || 0}%`;
            if (desktopUpdateIcon) desktopUpdateIcon.textContent = `${state.progress || 0}%`;
        } else {
            btnDesktopUpdate.disabled = false;
            btnDesktopUpdate.setAttribute('aria-label', `Reiniciar para instalar actualización${versionLabel}`);
            btnDesktopUpdate.title = `Reiniciar para instalar actualización${versionLabel}`;
            if (desktopUpdateIcon) desktopUpdateIcon.textContent = '↻';
        }
    };
    const onDesktopUpdateState = state => renderDesktopUpdateState(state);
    if (btnDesktopUpdate && desktopUpdates?.getUpdateState
        && desktopUpdates?.subscribeUpdateState) {
        desktopUpdates.subscribeUpdateState(onDesktopUpdateState);
        desktopUpdates.getUpdateState().then(renderDesktopUpdateState).catch(error => {
            console.error('No se pudo consultar el estado de las actualizaciones.', error);
        });
        btnDesktopUpdate.addEventListener('click', async () => {
            if (desktopUpdateState?.status === 'available') {
                btnDesktopUpdate.disabled = true;
                try {
                    await desktopUpdates.downloadUpdate();
                } catch (error) {
                    console.error('No se pudo descargar la actualización.', error);
                    renderDesktopUpdateState({
                        ...desktopUpdateState,
                        status: 'available',
                        error: error.message || 'No se pudo descargar la actualización.'
                    });
                }
                return;
            }
            if (desktopUpdateState?.status === 'downloaded') {
                btnDesktopUpdate.disabled = true;
                try {
                    await desktopUpdates.installUpdate();
                } catch (error) {
                    console.error('No se pudo instalar la actualización.', error);
                    btnDesktopUpdate.disabled = false;
                    btnDesktopUpdate.title = error.message || 'No se pudo iniciar la instalación.';
                }
            }
        });
    }

    const modalOverlay = document.getElementById("modal-overlay");
    const addToPlModal = document.getElementById("add-to-pl-modal");
    const btnCloseAddPl = document.getElementById("btn-close-add-pl");
    const addToPlList = document.getElementById("add-to-pl-list");
    const btnEditPlaylist = document.getElementById("btn-edit-playlist");
    const btnSavePlaylist = document.getElementById("btn-save-playlist");
    const btnSavePlaylistIcon = btnSavePlaylist?.querySelector('img');
    const btnDeletePlaylist = document.getElementById('btn-delete-playlist');
    const manageMembersModal = document.getElementById("manage-members-modal");
    const manageMembersList = document.getElementById("manage-members-list");
    const btnCloseManageMembers = document.getElementById("btn-close-manage-members");
    const playlistSaversModal = document.getElementById("playlist-savers-modal");
    const playlistSaversTitle = document.getElementById("playlist-savers-title");
    const playlistSaversList = document.getElementById("playlist-savers-list");
    const btnClosePlaylistSavers = document.getElementById("btn-close-playlist-savers");
    const btnAddToPlaylistBar = document.getElementById("btn-add-to-playlist-bar");
    const bottomBarActionMenu = document.getElementById("bottom-bar-action-menu");
    
    const editSongPanel = document.getElementById("edit-song-panel");
    const editSongDisplayCover = document.getElementById("edit-song-display-cover");
    const editSongMetadata = document.getElementById("edit-song-metadata");
    const editSongAddedBy = document.getElementById("edit-song-added-by");
    const editSongEditedBy = document.getElementById("edit-song-edited-by");
    const editSongAddedAt = document.getElementById("edit-song-added-at");
    const editInputName = document.getElementById("edit-input-name");
    const editInputArtist = document.getElementById("edit-input-artist");
    const editInputColor = document.getElementById("edit-input-color");
    const editInputMp3 = document.getElementById("edit-input-mp3");
    const editInputFileName = document.getElementById("edit-input-file-name");
    const editInputLyrics = document.getElementById("edit-input-lyrics");
    const editInputLyricsReady = document.getElementById("edit-input-lyrics-ready");
    const btnPlayEditedSong = document.getElementById("btn-play-edited-song");
    const btnInsertEditLyricTime = document.getElementById("btn-insert-edit-lyric-time");
    const btnAddLyricColor = document.getElementById("btn-add-lyric-color");
    const inputNewLyricColor = document.getElementById("input-new-lyric-color");
    const lyricColorPicker = document.getElementById("lyric-color-picker");
    const lyricColorSelectionValue = document.getElementById("lyric-color-selection-value");
    const btnConfirmLyricColor = document.getElementById("btn-confirm-lyric-color");
    const btnCancelLyricColor = document.getElementById("btn-cancel-lyric-color");
    const lyricColorPalette = document.getElementById("lyric-color-palette");
    const editLyricsStatus = document.getElementById("edit-lyrics-status");
    const editLyricsTime = document.getElementById("edit-lyrics-time");
    const editLyricsPreview = document.getElementById("edit-lyrics-preview");
    const btnSaveEditedSong = document.getElementById("btn-save-edited-song");
    const btnCancelEditedSong = document.getElementById("btn-cancel-edited-song");
    const btnDeleteSong = document.getElementById("btn-delete-song");
    const deleteSongConfirmation = document.getElementById("delete-song-confirmation");
    const deleteSongNameStep = document.getElementById("delete-song-name-step");
    const deleteSongConfirmationTitle = document.getElementById("delete-song-confirmation-title");
    const deleteSongNameConfirmation = document.getElementById("delete-song-name-confirmation");
    const btnConfirmDeleteSong = document.getElementById("btn-confirm-delete-song");
    const songImageEditWrapper = document.getElementById("song-image-edit-wrapper");
    const editSongPhoto = document.getElementById("edit-song-photo");
    const editSongPhotoStatus = document.getElementById("edit-song-photo-status");

    const editPlaylistPanel = document.getElementById("edit-playlist-panel");
    const editPlDisplayCover = document.getElementById("edit-pl-display-cover");
    const editPlPhoto = document.getElementById("edit-pl-photo");
    const editPlPhotoStatus = document.getElementById("edit-pl-photo-status");
    const plImageEditWrapper = document.getElementById("pl-image-edit-wrapper");
    const editPlName = document.getElementById("edit-pl-name");
    const editPlDesc = document.getElementById("edit-pl-desc");
    const btnSaveEditedPl = document.getElementById("btn-save-edited-pl");
    const btnCancelEditedPl = document.getElementById("btn-cancel-edited-pl");
    const btnDeletePl = document.getElementById("btn-delete-pl");

    const plViewPanel = document.getElementById("pl-view-panel");
    const plViewPhoto = document.getElementById("pl-view-photo");
    const plViewName = document.getElementById("pl-view-name");
    const plViewDesc = document.getElementById("pl-view-desc");
    const plViewOwner = document.getElementById("pl-view-owner");
    const plViewTracks = document.getElementById("pl-view-tracks");
    const btnSharePlaylist = document.getElementById("btn-share-playlist");
    const shareModal = document.getElementById("share-pl-modal");
    const shareFriendsList = document.getElementById("share-friends-list");
    const btnCloseSharePl = document.getElementById("btn-close-share-pl");
    
    const loadingSpinner = document.getElementById("loading-spinner");
    const inlineSpinner = document.getElementById("inline-spinner");
    const perroGif = document.getElementById("perro-gif");
    function renderSongLoadingState() {
        document.querySelectorAll('.all-songs-item[data-song-id], .playlist-track-row[data-song-id], .queue-item[data-song-id]').forEach(item => {
            const isLoading = item.dataset.songId === loadingTrackId;
            const isSyncing = item.classList.contains('is-syncing');
            const isCoverLoading = item.dataset.coverLoading === 'true';
            item.classList.toggle('is-loading', isLoading);
            item.setAttribute('aria-busy', String(isLoading || isSyncing || isCoverLoading));
            let cover = item.querySelector('.song-cover-loading');
            const image = item.querySelector('.item-cover, .queue-item-img');
            if (!cover && image) {
                cover = document.createElement('span');
                cover.className = 'song-cover-loading';
                image.replaceWith(cover);
                cover.appendChild(image);
            }
            if (!cover) return;
            let spinner = cover.querySelector('.song-loading-spinner');
            if (isLoading || isSyncing || isCoverLoading) {
                if (!spinner) {
                    spinner = document.createElement('span');
                    spinner.className = 'song-loading-spinner';
                    cover.appendChild(spinner);
                }
                spinner.classList.toggle('syncing', isSyncing);
            } else {
                spinner?.remove();
            }
        });
    }
    function renderPlaybackLoading() {
        const loading = playbackRequestLoadingCount > 0 || audioLoading;
        if (inlineSpinner) inlineSpinner.style.display = loading ? 'block' : 'none';
        if (perroGif) perroGif.style.display = loading || !getCurrentTrack() ? 'none' : 'block';
        renderSongLoadingState();
    }

    function beginPlaybackRequestLoading() {
        playbackRequestLoadingCount += 1;
        renderPlaybackLoading();
        let finished = false;
        return () => {
            if (finished) return;
            finished = true;
            playbackRequestLoadingCount = Math.max(0, playbackRequestLoadingCount - 1);
            renderPlaybackLoading();
        };
    }
    const authOverlay = document.getElementById("auth-overlay");
    const authTitle = document.getElementById("auth-title");
    const authUsername = document.getElementById("auth-username");
    const authPassword = document.getElementById("auth-password");
    const authSubmit = document.getElementById("auth-btn-submit");
    const authError = document.getElementById("auth-error");
    let currentFriends = [];
    let friendsOwnerId = null;
    let friendsRequestSequence = 0;
    const annoyedFriendIds = new Set();
    const friendRealtimeUpdates = new Map();
    let selectedProfileUser = null;
    let profileActivityTimer = null;
    let listeningTogetherUserId = null;
    let sharedQueueSessionId = null;
    let sharedQueueRole = null;
    let sharedQueueSavedLocalQueue = null;
    let sharedQueueJoinPending = false;
    let sharedQueueSnapshotRevision = 0;
    let sharedQueueIds = [];
    let sharedQueueUpcomingIds = [];
    let sharedQueueHostQueueName = 'GENERAL';
    let sharedQueueJamActive = false;
    let sharedQueueJamRequestPending = false;
    let sharedQueueJamRequestId = null;
    let sharedQueueJamUpdateInFlight = false;
    let sharedQueueJamPendingUpcomingIds = null;
    let hostJamRequestId = null;
    let lastSharedQueueSnapshot = null;
    let accountQueueIds = [];
    let accountQueueSourceIds = [];
    let accountQueueName = 'GENERAL';
    let accountQueueRevision = 0;
    let accountQueueSnapshotSignature = null;
    let accountQueueDeviceId = null;
    let accountQueueSnapshotCached = false;
    let accountQueuePendingIds = null;
    let accountQueueRetryTimer = null;
    let accountQueueRetryDelay = 15000;
    let accountQueueSyncInFlight = false;
    let accountQueueSyncGeneration = 0;
    let accountQueueLastNotifiedSignature = '';
    let listeningTogetherAwaitingFreshPlayback = false;
    let listeningTogetherNeedsUserGesture = false;
    let listeningTogetherMetadataWaitTrackId = null;
    let listeningTogetherMetadataWaitToken = 0;
    let sharedPlaybackTime = 0;
    let sharedPlaybackDuration = 0;
    let sharedPlaybackPlaying = false;
    let activeChatFriendId = null;
    let activeChatFriendName = '';
    let localChatMessages = [];
    let serverChatMessages = [];
    let lastChatMessageOrderTime = 0;
    const chatMessageDisplayTimes = new Map();
    const chatSendQueues = new Map();
    let chatMessagesRequestSequence = 0;
    let chatPollTimer = null;
    let friendsUiTimer = null;
    let friendsRealtimeFallbackTimer = null;
    let friendsFallbackRefreshInProgress = false;
    let friendCacheSaveTimer = null;
    let queueName = 'GENERAL';
    let playlist = [];
    let currentTrackIndex = 0;
    let currentTrackId = null;
    let generalQueueAnchorTrackId = null;
    let playbackActivityUserId = null;
    let isRestoringInitialPlayback = false;
    let suppressStartupPlaybackUpdates = false;
    let currentTrackSource = 'regular';
    let audioSourceLoadToken = 0;
    let activeAudioObjectUrl = null;
    let activeAudioObjectUrlKey = null;
    let playbackUiTrackId = null;
    let playbackUiTime = 0;
    let playbackUiFrame = null;
    let lastPlaybackBroadcastAt = 0;
    let lastPlaybackPersistenceAt = 0;
    let publicProfilePlaylists = null;
    let profilePlaylistsRequestToken = 0;
    let profileStatsRequestSequence = 0;
    const profileStatsCache = new Map();
    const profileStatsRequests = new Map();
    let adminUsersCache = null;
    let adminUsersCacheOwnerId = null;
    let adminUsersRequestToken = 0;
    const timedLyricsStorageKey = 'amgc-timed-lyrics-v1';
    const defaultSecretPhrases = [];
    let timedLyricsByTrack = {};
    let globalSecretPhrases = defaultSecretPhrases;
    let secretPhrases = defaultSecretPhrases;
    let secretPhrasesRequestSequence = 0;
    let previousSecretPhrase = '';
    let nowPlayingLyricAnimationTimeout = null;
    let nowPlayingLyricPendingIndex = null;

    function getCurrentTrack() {
        if (currentTrackId !== null) {
            return playlist.find(track => String(track._id) === String(currentTrackId)) || null;
        }
        return playlist[currentTrackIndex] || null;
    }

    function getLyricsTrack() {
        const playback = getRemotePlaybackSession();
        if (!playback) return getCurrentTrack();
        const songId = String(playback.songId || '');
        const track = findRemotePlaybackTrack();
        const playbackColor = typeof playback.color === 'string' && CSS.supports('color', playback.color)
            ? playback.color
            : track?.color;
        return {
            ...(track || {}),
            _id: songId || track?._id,
            name: playback.songName || track?.name || '',
            artist: playback.artist || track?.artist || '',
            cover: getPlaybackCover(playback, track),
            color: playbackColor || '#151515'
        };
    }

    function getPlaybackCover(playback, fallbackTrack = null) {
        const cover = typeof playback?.cover === 'string' ? playback.cover.trim() : '';
        if (cover && cover !== '/img/vinculo.png' && !/^(?:blob|file|filesystem|capacitor|content):/i.test(cover)) {
            return cover;
        }
        const songId = String(playback?.songId || '');
        const track = fallbackTrack || playlist.find(item => String(item._id || item.id || '') === songId);
        const libraryCover = typeof track?.cover === 'string' ? track.cover.trim() : '';
        if (libraryCover && libraryCover !== '/img/vinculo.png'
            && !/^(?:blob|file|filesystem|capacitor|content):/i.test(libraryCover)) {
            return libraryCover;
        }
        return getSongCover(track) || '/img/vinculo.png';
    }

    function findRemotePlaybackTrack() {
        const playback = getRemotePlaybackSession();
        if (!playback?.songId) return null;
        const songId = String(playback.songId);
        return playlist.find(track => String(track._id || track.id || '') === songId) || null;
    }

    try {
        const storedLyrics = localStorage.getItem(timedLyricsStorageKey);
        if (storedLyrics) {
            const parsedLyrics = JSON.parse(storedLyrics);
            if (!parsedLyrics || typeof parsedLyrics !== 'object' || Array.isArray(parsedLyrics)) {
                throw new Error('El formato guardado de lyrics no es válido.');
            }
            if (Object.values(parsedLyrics).some(entries => !Array.isArray(entries) || !entries.every(entry =>
                entry && Number.isFinite(entry.time) && entry.time >= 0 && typeof entry.text === 'string'
            ))) {
                throw new Error('Una o más letras guardadas tienen un formato no válido.');
            }
            timedLyricsByTrack = parsedLyrics;
        }
    } catch (error) {
        console.error('No se pudieron cargar las lyrics sincronizadas guardadas.', error);
    }

    function getTrackStorageId(track) {
        return String(track?._id || track?.id || track?.path || '');
    }

    function formatLyricTimestamp(time) {
        const minutes = Math.floor(time / 60);
        const seconds = (time % 60).toFixed(3).padStart(6, '0');
        return `${String(minutes).padStart(2, '0')}:${seconds}`;
    }

    function parseLyricTimestamp(value) {
        const trimmed = value.trim();
        if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
        const match = trimmed.match(/^(\d+):([0-5]?\d)(?:\.(\d{1,3}))?$/);
        if (!match) return null;
        return Number(match[1]) * 60 + Number(match[2]) + (match[3] ? Number(`0.${match[3]}`) : 0);
    }

    function getLyricColorLineKey(lineIndex, time) {
        return `${lineIndex}:${Number(time).toFixed(3)}`;
    }

    function renderLyricColorPalette() {
        if (!lyricColorPalette) return;
        lyricColorPalette.replaceChildren();
        const defaultColor = document.createElement('span');
        defaultColor.className = 'lyric-color-swatch';
        defaultColor.title = `Color predeterminado de la canción: ${editInputColor?.value || '#ffffff'}`;
        const defaultSample = document.createElement('span');
        defaultSample.className = 'lyric-color-sample';
        defaultSample.style.backgroundColor = editInputColor?.value || '#ffffff';
        const defaultLabel = document.createElement('span');
        defaultLabel.textContent = 'Predeterminado';
        defaultColor.append(defaultSample, defaultLabel);
        lyricColorPalette.appendChild(defaultColor);
        editingLyricColors.forEach((color, index) => {
            const item = document.createElement('span');
            item.className = 'lyric-color-swatch';
            item.title = `Color ${index + 1}: ${color}`;
            const sample = document.createElement('span');
            sample.className = 'lyric-color-sample';
            sample.style.backgroundColor = color;
            const label = document.createElement('span');
            label.textContent = `Color ${index + 1}`;
            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'lyric-color-remove';
            removeButton.textContent = '×';
            removeButton.setAttribute('aria-label', `Eliminar Color ${index + 1}`);
            removeButton.title = `Eliminar Color ${index + 1}`;
            removeButton.addEventListener('click', () => {
                const removedColor = editingLyricColors[index];
                editingLyricColors.splice(index, 1);
                Object.entries(editingLyricColorAssignments).forEach(([lineKey, assignments]) => {
                    const retainedAssignments = Object.fromEntries(
                        Object.entries(assignments).filter(([, assignedColor]) => (
                            typeof assignedColor !== 'string'
                            || assignedColor.toLowerCase() !== removedColor.toLowerCase()
                        ))
                    );
                    if (Object.keys(retainedAssignments).length) {
                        editingLyricColorAssignments[lineKey] = retainedAssignments;
                    } else {
                        delete editingLyricColorAssignments[lineKey];
                    }
                });
                renderLyricColorPalette();
                updateEditLyricsPreview(false);
            });
            item.append(sample, label, removeButton);
            lyricColorPalette.appendChild(item);
        });
    }

    function updateLyricColorSelectionPreview() {
        if (!inputNewLyricColor || !lyricColorSelectionValue) return;
        selectedLyricColor = inputNewLyricColor.value.toLowerCase();
        lyricColorSelectionValue.textContent = selectedLyricColor;
        lyricColorSelectionValue.style.color = selectedLyricColor;
    }

    function cycleEditedLyricWordColor(lineKey, wordIndex) {
        if (!canCurrentUser('edit_songs') || editingLyricColors.length === 0) return;
        const lineAssignments = editingLyricColorAssignments[lineKey] || {};
        const currentColor = lineAssignments[String(wordIndex)];
        const currentColorIndex = editingLyricColors.findIndex(
            color => color.toLowerCase() === String(currentColor || '').toLowerCase()
        );
        const nextColor = currentColor === 'default' || currentColorIndex < 0
            ? editingLyricColors[0]
            : editingLyricColors[currentColorIndex + 1] || 'default';
        editingLyricColorAssignments[lineKey] = {
            ...lineAssignments,
            [wordIndex]: nextColor
        };
        setEditorStatus(
            editLyricsStatus,
            `${nextColor === 'default' ? 'Color predeterminado de la canción' : `Color ${editingLyricColors.indexOf(nextColor) + 1}`} aplicado. Guarda los cambios para compartirlos.`
        );
        updateEditLyricsPreview(false);
    }

    function getTrackLyrics(track) {
        if (!track) return [];
        const savedLyrics = timedLyricsByTrack[getTrackStorageId(track)];
        if (Array.isArray(savedLyrics)) return savedLyrics;

        if (Array.isArray(track.lyrics)) {
            return track.lyrics.filter(line =>
                line && Number.isFinite(Number(line.time)) && Number(line.time) >= 0 && typeof line.text === 'string'
            ).map(line => ({ time: Number(line.time), text: line.text }))
                .sort((left, right) => left.time - right.time);
        }

        if (typeof track.lyrics !== 'string' || !track.lyrics.trim()) return [];
        const lines = track.lyrics.split(/\r?\n/).filter(line => line.trim());
        const timedLines = lines.map(line => {
            const match = line.match(/^\s*\[(\d+:\d{1,2}(?:\.\d{1,3})?)\]\s*(.*)$/)
                || line.match(/^\s*(\d+:\d{1,2}(?:\.\d{1,3})?|\d+(?:\.\d+)?)\s*(?:\||-)\s*(.*)$/);
            if (!match) return null;
            const time = parseLyricTimestamp(match[1]);
            return time === null ? null : { time, text: match[2] };
        });
        if (timedLines.length && timedLines.every(Boolean)) {
            return timedLines.sort((left, right) => left.time - right.time);
        }
        return lines.map(text => ({ time: 0, text }));
    }

    function parseLyricsEditor(value, includeSourceLineIndex = false) {
        const lyrics = [];
        for (const [index, line] of value.split(/\r?\n/).entries()) {
            if (!line.trim()) continue;
            const separator = line.indexOf('|');
            if (separator < 0) throw new Error(`Línea ${index + 1}: separa el tiempo y el texto con |.`);
            const time = parseLyricTimestamp(line.slice(0, separator));
            if (time === null || !Number.isFinite(time) || time < 0) {
                throw new Error(`Línea ${index + 1}: usa segundos o el formato mm:ss.mmm.`);
            }
            const lyric = { time, text: line.slice(separator + 1).trim() };
            if (includeSourceLineIndex) lyric.sourceLineIndex = index;
            lyrics.push(lyric);
        }
        return lyrics.map((lyric, index) => ({ lyric, index }))
            .sort((left, right) => left.lyric.time - right.lyric.time || left.index - right.index)
            .map(({ lyric }) => lyric);
    }

    function formatLyricsEditor(lyrics) {
        return lyrics.map(({ time, text }) => `${formatLyricTimestamp(time)} | ${text}`).join('\n');
    }

    function getActiveLyricIndex(lyrics, time) {
        if (lyrics.length > 1 && lyrics.every(line => line.time === 0)) return -1;
        let activeIndex = -1;
        for (let index = 0; index < lyrics.length; index += 1) {
            if (time < lyrics[index].time) break;
            activeIndex = index;
        }
        return activeIndex;
    }

    function seekAudioToTime(audioElement, time, onSeek = () => {}) {
        const seek = () => {
            const targetTime = Number.isFinite(audioElement.duration)
                ? Math.min(time, audioElement.duration)
                : time;
            audioElement.currentTime = Math.max(0, targetTime);
            onSeek();
        };
        if (audioElement.readyState === 0) {
            audioElement.addEventListener('loadedmetadata', seek, { once: true });
            return;
        }
        seek();
    }

    function appendLyricText(
        target,
        text,
        color,
        interactiveWords = false,
        flatHighlight = false,
        track = null,
        lineKey = '',
        useDraftColors = false,
        ignoreAssignedColors = false
    ) {
        let wordIndex = 0;
        const appendWords = (container, segment, isMarkedSegment = false) => {
            if (!interactiveWords && !track && !useDraftColors) {
                container.appendChild(document.createTextNode(segment));
                return;
            }
            const words = /[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*/gu;
            let lastWordEnd = 0;
            let word;
            while ((word = words.exec(segment)) !== null) {
                container.appendChild(document.createTextNode(segment.slice(lastWordEnd, word.index)));
                const wordElement = document.createElement('span');
                wordElement.textContent = word[0];
                wordElement.className = 'lyric-word';
                wordElement.dataset.lyricWordIndex = String(wordIndex);
                const assignedColor = !ignoreAssignedColors && isMarkedSegment && (useDraftColors
                    ? editingLyricColorAssignments[lineKey]?.[String(wordIndex)]
                    : track?.lyricColorAssignments?.[lineKey]?.[String(wordIndex)]);
                if (assignedColor) {
                    wordElement.dataset.lyricAssignedColor = assignedColor;
                }
                wordElement.style.color = assignedColor === 'default'
                    ? (useDraftColors ? editInputColor?.value : track?.color) || ''
                    : assignedColor || '';
                if (isMarkedSegment && assignedColor && assignedColor !== 'default') {
                    wordElement.style.textShadow = `0 0 8px ${assignedColor}`;
                }
                container.appendChild(wordElement);
                wordIndex += 1;
                lastWordEnd = words.lastIndex;
            }
            container.appendChild(document.createTextNode(segment.slice(lastWordEnd)));
        };
        const markedText = /(?<!\*)\*([^*]+?)\*(?!\*)/g;
        let lastIndex = 0;
        let match;
        while ((match = markedText.exec(text)) !== null) {
            appendWords(target, text.slice(lastIndex, match.index));
            if (match[1]) {
                const highlighted = document.createElement('span');
                highlighted.className = 'lyric-highlight';
                highlighted.style.fontWeight = '700';
                highlighted.style.color = color;
                if (!flatHighlight) highlighted.style.textShadow = `0 0 8px ${color}`;
                appendWords(highlighted, match[1], true);
                target.appendChild(highlighted);
            }
            lastIndex = markedText.lastIndex;
        }
        appendWords(target, text.slice(lastIndex));
    }

    function getContrastingTextColor(backgroundColor) {
        const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(backgroundColor || '').trim());
        if (!match) return '#fff';
        const hex = match[1].length === 3
            ? [...match[1]].map(channel => channel + channel).join('')
            : match[1];
        const channels = [0, 2, 4].map(offset => {
            const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        return luminance > 0.179 ? '#000' : '#fff';
    }

    function setLyricHighlightAppearance(target, color, glow = false) {
        target.querySelectorAll('.lyric-highlight').forEach(highlight => {
            highlight.style.color = color;
            highlight.style.textShadow = glow ? `0 0 8px ${color}` : 'none';
        });
    }

    function setLyricTextAppearance(target, color, highlightColor = color, glow = false) {
        target.style.color = color;
        setLyricHighlightAppearance(target, highlightColor, glow);
    }

    function setLyricAssignedColorsAppearance(target, enabled, mutedColor = '#929292') {
        target.querySelectorAll('[data-lyric-assigned-color]').forEach(word => {
            const assignedColor = word.dataset.lyricAssignedColor;
            const visibleColor = assignedColor === 'default'
                ? word.closest('.lyric-highlight')?.style.color || mutedColor
                : assignedColor;
            word.style.color = enabled ? visibleColor : mutedColor;
            word.style.textShadow = enabled && assignedColor !== 'default'
                ? `0 0 8px ${assignedColor}`
                : 'none';
        });
    }

    function renderSyncedLyrics(track, time, list, lyricsOverride, scrollActiveLyric = true) {
        if (!list) return;
        const lyrics = lyricsOverride || getTrackLyrics(track);
        const renderKey = `${getTrackStorageId(track)}:${track?.color || ''}:${JSON.stringify(lyrics)}:${JSON.stringify(
            list === editLyricsPreview
                ? { colors: editingLyricColors, assignments: editingLyricColorAssignments }
                : track?.lyricColorAssignments || {}
        )}`;
        if (list.dataset.renderKey !== renderKey) {
            const preservedScrollTop = list === editLyricsPreview && !scrollActiveLyric
                ? list.scrollTop
                : null;
            list.dataset.renderKey = renderKey;
            list.replaceChildren();
            if (!lyrics.length) {
                const empty = document.createElement('li');
                empty.className = list.closest('#lyrics-panel')
                    ? 'timed-lyric-line active lyrics-empty-state'
                    : 'lyrics-empty-state';
                const content = document.createElement('span');
                content.className = 'timed-lyric-content';
                content.textContent = 'Aún no hay letra sincronizada para esta canción.';
                empty.appendChild(content);
                list.appendChild(empty);
            } else {
                lyrics.forEach(({ time: lineTime, text }, index) => {
                    const line = document.createElement('li');
                    line.className = 'timed-lyric-line';
                    line.dataset.lyricIndex = String(index);
                    const lineKey = getLyricColorLineKey(index, lineTime);
                    line.dataset.lyricColorKey = lineKey;
                    if (Number.isInteger(lyrics[index].sourceLineIndex)) {
                        line.dataset.sourceLineIndex = String(lyrics[index].sourceLineIndex);
                    }
                    const seek = document.createElement('button');
                    seek.type = 'button';
                    seek.className = 'timed-lyric-seek';
                    seek.dataset.lyricTime = String(lineTime);
                    const timestamp = document.createElement('span');
                    timestamp.className = 'timed-lyric-timestamp';
                    timestamp.textContent = formatLyricTimestamp(lineTime);
                    const content = document.createElement('span');
                    content.className = 'timed-lyric-content';
                    const isFullLyricsPanel = Boolean(list.closest('#lyrics-panel'));
                    appendLyricText(
                        content,
                        text,
                        isFullLyricsPanel
                            ? getContrastingTextColor(track?.color || '#151515')
                            : (track?.color || '#ff8a00'),
                        list === editLyricsPreview,
                        isFullLyricsPanel,
                        track,
                        lineKey,
                        list === editLyricsPreview,
                        isFullLyricsPanel
                    );
                    seek.append(timestamp, content);
                    line.appendChild(seek);
                    list.appendChild(line);
                });
            }
            if (preservedScrollTop !== null) list.scrollTop = preservedScrollTop;
            list.dataset.activeIndex = '';
        }

        const activeIndex = getActiveLyricIndex(lyrics, time);
        const previousActiveIndex = list.dataset.activeIndex === ''
            ? null
            : Number(list.dataset.activeIndex);
        const changedIndices = new Set([
            activeIndex - 1, activeIndex, activeIndex + 1,
            ...(Number.isInteger(previousActiveIndex)
                ? [previousActiveIndex - 1, previousActiveIndex, previousActiveIndex + 1]
                : [])
        ]);
        changedIndices.forEach(index => {
            const line = list.querySelector(`[data-lyric-index="${index}"]`);
            if (!line) return;
            line.classList.toggle('active', index === activeIndex);
            line.classList.toggle('previous', index === activeIndex - 1);
            line.classList.toggle('next', index === activeIndex + 1);
            setLyricAssignedColorsAppearance(
                line,
                list === editLyricsPreview || index === activeIndex,
                getContrastingTextColor(track?.color || '#151515')
            );
        });
        if (list.dataset.activeIndex !== String(activeIndex)) {
            list.dataset.activeIndex = String(activeIndex);
            if (scrollActiveLyric && activeIndex >= 0 && (
                isLyricsMode ||
                (list === editLyricsPreview && isEditSongMode)
            )) {
                const activeLine = list.querySelector(`[data-lyric-index="${activeIndex}"]`);
                if (isLyricsMode && activeLine) {
                    const lineTop = activeLine.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
                    list.scrollTo({
                        top: Math.max(0, lineTop - list.clientHeight * 0.38),
                        behavior: 'smooth'
                    });
                } else {
                    activeLine?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }
            }
        }
    }

    function finishNowPlayingLyricTransition() {
        if (!nowPlayingLyricAnimationTimeout) return;
        clearTimeout(nowPlayingLyricAnimationTimeout);
        nowPlayingLyricAnimationTimeout = null;
        nowPlayingLyricText.replaceChildren(...nowPlayingLyricNext.childNodes);
        nowPlayingLyricNext.replaceChildren(...nowPlayingLyricIncoming.childNodes);
        nowPlayingLyricIncoming.replaceChildren();
        setLyricTextAppearance(nowPlayingLyricText, '#fff', nowPlayingLyric.dataset.trackColor || '#ff8a00', true);
        setLyricAssignedColorsAppearance(nowPlayingLyricText, true);
        setLyricTextAppearance(nowPlayingLyricNext, '#929292');
        setLyricAssignedColorsAppearance(nowPlayingLyricNext, false, '#929292');
        nowPlayingLyric.classList.remove('is-advancing');
        nowPlayingLyric.classList.add('is-repositioning');
        void nowPlayingLyricTrack.offsetHeight;
        nowPlayingLyric.classList.remove('is-repositioning');
        if (nowPlayingLyricPendingIndex !== null) {
            nowPlayingLyric.dataset.activeIndex = String(nowPlayingLyricPendingIndex);
            nowPlayingLyricPendingIndex = null;
        }
    }

    nowPlayingLyricTrack?.addEventListener('transitionend', event => {
        if (
            event.target === nowPlayingLyricNext
            && event.propertyName === 'transform'
            && nowPlayingLyricAnimationTimeout
        ) {
            finishNowPlayingLyricTransition();
        }
    });

    function updateCurrentLyric(track, time) {
        if (!nowPlayingLyric || !nowPlayingLyricText || !nowPlayingLyricNext || !nowPlayingLyricIncoming) return;
        const lyrics = getTrackLyrics(track);
        const activeIndex = getActiveLyricIndex(lyrics, time);
        const activeLyric = activeIndex >= 0 ? lyrics[activeIndex] : null;
        nowPlayingLyric.hidden = !activeLyric || !activeLyric.text.trim();
        const activeKey = `${getTrackStorageId(track)}:${activeIndex}:${activeLyric?.text || ''}:${JSON.stringify(track?.lyricColorAssignments || {})}`;
        if (nowPlayingLyric.dataset.activeKey !== activeKey) {
            finishNowPlayingLyricTransition();
            const previousTrackId = nowPlayingLyric.dataset.trackId;
            const previousIndex = Number(nowPlayingLyric.dataset.activeIndex);
            const shouldAdvance = Boolean(
                activeLyric &&
                previousTrackId === String(getTrackStorageId(track)) &&
                Number.isInteger(previousIndex) &&
                previousIndex >= 0 &&
                activeIndex === previousIndex + 1
            );
            nowPlayingLyric.dataset.activeKey = activeKey;
            nowPlayingLyric.dataset.trackId = String(getTrackStorageId(track));
            nowPlayingLyric.dataset.trackColor = track?.color || '#ff8a00';
            if (shouldAdvance) {
                const nextLyric = lyrics[activeIndex + 1];
                nowPlayingLyricIncoming.replaceChildren();
                if (nextLyric) appendLyricText(
                    nowPlayingLyricIncoming,
                    nextLyric.text,
                    '#929292',
                    false,
                    true,
                    track,
                    getLyricColorLineKey(activeIndex + 1, nextLyric.time)
                );
                setLyricTextAppearance(nowPlayingLyricText, '#929292');
                setLyricTextAppearance(nowPlayingLyricNext, '#fff', track?.color || '#ff8a00', true);
                setLyricAssignedColorsAppearance(nowPlayingLyricNext, true);
                setLyricAssignedColorsAppearance(nowPlayingLyricIncoming, false, '#929292');
                nowPlayingLyricPendingIndex = activeIndex;
                nowPlayingLyric.classList.add('is-advancing');
                const transitionDuration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 20 : 900;
                nowPlayingLyricAnimationTimeout = setTimeout(finishNowPlayingLyricTransition, transitionDuration);
                return;
            }

            nowPlayingLyricText.replaceChildren();
            nowPlayingLyricNext.replaceChildren();
            nowPlayingLyricIncoming.replaceChildren();
            const nextLyric = activeIndex >= 0 ? lyrics[activeIndex + 1] : null;
            if (activeLyric) appendLyricText(
                nowPlayingLyricText,
                activeLyric.text,
                track?.color || '#ff8a00',
                false,
                false,
                track,
                getLyricColorLineKey(activeIndex, activeLyric.time)
            );
            if (nextLyric) appendLyricText(
                nowPlayingLyricNext,
                nextLyric.text,
                '#929292',
                false,
                true,
                track,
                getLyricColorLineKey(activeIndex + 1, nextLyric.time)
            );
            setLyricAssignedColorsAppearance(nowPlayingLyricText, true);
            setLyricTextAppearance(nowPlayingLyricNext, '#929292');
            setLyricAssignedColorsAppearance(nowPlayingLyricNext, false, '#929292');
            nowPlayingLyric.dataset.activeIndex = String(activeIndex);
        }
    }

    function getEditedTrack() {
        return editingTrackId
            ? playlist.find(track => String(track._id) === editingTrackId) || null
            : null;
    }

    function updateEditLyricsPreview(scrollActiveLyric = true) {
        if (!editLyricsPreview) return;
        const track = getEditedTrack();
        const isCurrentTrack = Boolean(track && getTrackStorageId(track) === getTrackStorageId(getCurrentTrack()));
        const previewTime = editPreviewAudio
            ? (Number.isFinite(editPreviewAudio.currentTime) ? editPreviewAudio.currentTime : 0)
            : (isCurrentTrack && Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
        if (editLyricsTime) editLyricsTime.textContent = formatLyricTimestamp(previewTime);
        if (!editInputLyrics?.value.trim()) {
            renderSyncedLyrics(track, previewTime, editLyricsPreview, [], scrollActiveLyric);
            return;
        }
        try {
            const draftLyrics = parseLyricsEditor(editInputLyrics.value, true);
            setEditorStatus(editLyricsStatus, '');
            renderSyncedLyrics(track, previewTime, editLyricsPreview, draftLyrics, scrollActiveLyric);
        } catch (error) {
            setEditorStatus(editLyricsStatus, error.message, true);
            renderSyncedLyrics(track, previewTime, editLyricsPreview, [], scrollActiveLyric);
        }
    }

    function toggleEditedLyricWord(sourceLineIndex, wordIndex) {
        if (!editInputLyrics) return;
        const lines = editInputLyrics.value.split(/\r?\n/);
        const line = lines[sourceLineIndex];
        const separator = line?.indexOf('|') ?? -1;
        if (separator < 0) return;

        const lyricPart = line.slice(separator + 1);
        const markedText = /(?<!\*)\*([^*]+?)\*(?!\*)/g;
        const highlightRanges = [];
        let plainText = '';
        let lastIndex = 0;
        let match;
        while ((match = markedText.exec(lyricPart)) !== null) {
            plainText += lyricPart.slice(lastIndex, match.index);
            const start = plainText.length;
            plainText += match[1];
            highlightRanges.push({ start, end: plainText.length });
            lastIndex = markedText.lastIndex;
        }
        plainText += lyricPart.slice(lastIndex);
        const words = [...plainText.matchAll(/[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*/gu)];
        const selectedWord = words[wordIndex];
        if (!selectedWord) return;

        const wordStates = words.map(word => highlightRanges.some(range => (
            word.index >= range.start && word.index + word[0].length <= range.end
        )));
        wordStates[wordIndex] = !wordStates[wordIndex];

        let updatedLyricPart = '';
        let cursor = 0;
        for (let index = 0; index < words.length;) {
            const word = words[index];
            updatedLyricPart += plainText.slice(cursor, word.index);
            if (!wordStates[index]) {
                updatedLyricPart += word[0];
                cursor = word.index + word[0].length;
                index += 1;
                continue;
            }

            let endIndex = index;
            while (endIndex + 1 < words.length && wordStates[endIndex + 1]) {
                const currentWord = words[endIndex];
                const nextWord = words[endIndex + 1];
                const separatorText = plainText.slice(
                    currentWord.index + currentWord[0].length,
                    nextWord.index
                );
                if (!/^\s+$/.test(separatorText)) break;
                endIndex += 1;
            }
            const lastWord = words[endIndex];
            const rangeEnd = lastWord.index + lastWord[0].length;
            updatedLyricPart += `*${plainText.slice(word.index, rangeEnd)}*`;
            cursor = rangeEnd;
            index = endIndex + 1;
        }
        updatedLyricPart += plainText.slice(cursor);
        lines[sourceLineIndex] = `${line.slice(0, separator + 1)}${updatedLyricPart}`;
        editInputLyrics.value = lines.join('\n');
        updateEditLyricsPreview(false);
    }

    function formatTrackLyricsForEditor(track) {
        if (!track) return '';
        const savedLyrics = timedLyricsByTrack[getTrackStorageId(track)];
        if (Array.isArray(savedLyrics)) return formatLyricsEditor(savedLyrics);
        const source = typeof track.lyrics === 'string' ? track.lyrics : '';
        const parsedLyrics = getTrackLyrics(track);
        const hasTimestampFormat = source.split(/\r?\n/).filter(line => line.trim()).every(line => (
            /^\s*\[\d+:\d{1,2}(?:\.\d{1,3})?\]\s*/.test(line)
            || /^\s*(?:\d+:\d{1,2}(?:\.\d{1,3})?|\d+(?:\.\d+)?)\s*(?:\||-)\s*/.test(line)
        ));
        return hasTimestampFormat ? formatLyricsEditor(parsedLyrics) : source;
    }

    function prepareLyricsForSongSave(value) {
        const trimmedValue = value.trim();
        if (!trimmedValue) return '';
        const hasTimingMarkup = trimmedValue.split(/\r?\n/).some(line => (
            /^\s*\[?\d+:\d{1,2}(?:\.\d{1,3})?\]?\s*(?:\||-)?/.test(line)
            || line.includes('|')
        ));
        if (!hasTimingMarkup) return value;
        return formatLyricsEditor(parseLyricsEditor(value));
    }

    function setEditorStatus(element, message, error = false) {
        if (!element) return;
        element.textContent = message;
        element.classList.toggle('error', error);
    }

    function showRandomSecretPhrase() {
        if (!secretText || secretPhrases.length === 0) {
            if (secretText) secretText.hidden = true;
            return;
        }
        const choices = secretPhrases.filter(phrase => phrase !== previousSecretPhrase);
        const phrase = (choices.length ? choices : secretPhrases)[Math.floor(Math.random() * (choices.length || secretPhrases.length))];
        previousSecretPhrase = phrase;
        secretText.textContent = phrase;
        secretText.hidden = false;
    }

    const setAuthError = (message = '') => {
        if (!authError) return;
        authError.textContent = message;
        authError.style.display = message ? 'block' : 'none';
    };

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
    const isValidSongColor = value => (
        typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value)
    );
    const safeColor = (value, fallback = '#ff8a00') => (
        isValidSongColor(value) ? value : fallback
    );

    const syncSecretPhrasesFromUser = (user) => {
        const isPersonal = user?.settings?.secretPhrasesPersonal === true;
        const storedPhrases = isPersonal ? user?.settings?.secretPhrases : globalSecretPhrases;
        if (storedPhrases !== undefined && (
            !Array.isArray(storedPhrases) || !storedPhrases.every(phrase => typeof phrase === 'string')
        )) {
            console.error('El usuario tiene una lista de frases secretas con formato no válido.');
            secretPhrases = defaultSecretPhrases;
        } else {
            secretPhrases = storedPhrases ?? defaultSecretPhrases;
        }
        if (secretPhrasesPersonalToggle) secretPhrasesPersonalToggle.checked = isPersonal;
        if (secretPhrasesInput) secretPhrasesInput.value = secretPhrases.join('\n');
        if (secretPhrases.length > 0) {
            if (!secretPhrases.includes(previousSecretPhrase)) previousSecretPhrase = '';
            if (!previousSecretPhrase) showRandomSecretPhrase();
        } else if (secretText) {
            secretText.hidden = true;
            previousSecretPhrase = '';
        }
    };

    const loadSecretPhrases = async (user = getStoredUser()) => {
        if (!user?._id || offlineOnly || !navigator.onLine) return;
        const requestSequence = ++secretPhrasesRequestSequence;
        const response = await apiFetch(`${API_URL}/secret-phrases`);
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.error || 'No se pudieron cargar las frases secretas.');
        if (!Array.isArray(result?.globalPhrases) || !result.globalPhrases.every(phrase => typeof phrase === 'string')
            || !Array.isArray(result?.personalPhrases) || !result.personalPhrases.every(phrase => typeof phrase === 'string')
            || typeof result.personal !== 'boolean') {
            throw new Error('El servidor devolvió las frases secretas con un formato no válido.');
        }
        if (requestSequence !== secretPhrasesRequestSequence
            || String(getStoredUser()?._id || '') !== String(user._id)) return;
        globalSecretPhrases = result.globalPhrases;
        const updatedUser = {
            ...user,
            settings: {
                ...user.settings,
                secretPhrases: result.personalPhrases,
                secretPhrasesPersonal: result.personal
            }
        };
        setStoredUser(updatedUser);
        syncSecretPhrasesFromUser(updatedUser);
    };

    const syncDiscordImageTextFromUser = (user) => {
        const imageText = user?.settings?.discordImageText;
        if (discordPresenceImageTextInput) {
            discordPresenceImageTextInput.value = typeof imageText === 'string' ? imageText : 'amgc';
        }
    };

    const hideAuthOverlay = () => {
        if (authOverlay) {
            authOverlay.style.display = 'none';
        }
        if (bottomBarWrapper) {
            bottomBarWrapper.style.display = 'block';
        }
    };

    const showAuthOverlay = () => {
        if (authOverlay) {
            authOverlay.style.display = 'flex';
        }
        if (bottomBarWrapper) {
            bottomBarWrapper.style.display = 'none';
        }
    };

    const getStoredUser = () => {
        try {
            const raw = localStorage.getItem('amgc-user');
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    };

    const getCachedOfflineUser = () => {
        try {
            const record = JSON.parse(localStorage.getItem('amgc-offline-user') || 'null');
            return record?.user || null;
        } catch {
            return null;
        }
    };

    function createOfflineListeningBatchId() {
        return globalThis.crypto?.randomUUID?.()
            || `offline-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    }

    function persistOfflineListeningBuffer(force = false) {
        const user = getStoredUser();
        if (!user?._id || offlineListeningBuffer <= 0) return;
        const now = Date.now();
        if (!force && offlineListeningBuffer < 5 && now - offlineListeningLastPersistAt < 10000) return;
        const key = `amgc-offline-listening-${user._id}`;
        try {
            const stored = JSON.parse(localStorage.getItem(key) || 'null') || {};
            const seconds = Math.max(0, Number(stored.seconds) || 0) + offlineListeningBuffer;
            localStorage.setItem(key, JSON.stringify({
                batchId: stored.batchId || createOfflineListeningBatchId(),
                seconds,
                updatedAt: now
            }));
            offlineListeningBuffer = 0;
            offlineListeningLastPersistAt = now;
        } catch (error) {
            console.error('No se pudo guardar la escucha offline en este dispositivo.', error);
            updateOfflineCacheStatus('No se pudo guardar el tiempo escuchado offline en este dispositivo.');
        }
    }

    async function syncOfflineListening() {
        const user = getStoredUser();
        if (
            offlineListeningSyncInProgress
            || !user?._id
            || !accessToken
            || offlineOnly
            || !navigator.onLine
        ) return false;

        persistOfflineListeningBuffer(true);
        offlineListeningSyncInProgress = true;
        let syncedAnyBatch = false;
        try {
            const key = `amgc-offline-listening-${user._id}`;
            while (navigator.onLine && !offlineOnly) {
                let pending;
                try {
                    pending = JSON.parse(localStorage.getItem(key) || 'null');
                } catch (error) {
                    throw new Error(`No se pudo leer el tiempo offline pendiente: ${error.message}`);
                }
                const pendingSeconds = Math.max(0, Number(pending?.seconds) || 0);
                if (pendingSeconds < 0.01) {
                    localStorage.removeItem(key);
                    break;
                }
                const seconds = Math.min(3600, pendingSeconds);
                const batchId = pending.batchId || createOfflineListeningBatchId();
                const response = await apiFetch(`${API_URL}/users/offline-listening`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ batchId, seconds })
                });
                const result = await response.json().catch(() => null);
                if (!response.ok) {
                    throw new Error(result?.error || `No se pudo sincronizar la escucha offline (${response.status}).`);
                }

                syncedAnyBatch = true;
                const latest = JSON.parse(localStorage.getItem(key) || 'null');
                if (latest?.batchId !== batchId) continue;
                const remainingSeconds = Math.max(0, (Number(latest.seconds) || 0) - seconds);
                if (remainingSeconds < 0.01) {
                    localStorage.removeItem(key);
                } else {
                    localStorage.setItem(key, JSON.stringify({
                        batchId: createOfflineListeningBatchId(),
                        seconds: remainingSeconds,
                        updatedAt: Date.now()
                    }));
                }
            }
            if (syncedAnyBatch) {
                suppressNextListeningDelta = true;
                await updateUserStatus(true);
            }
            return true;
        } catch (error) {
            console.warn('La escucha offline permanece guardada y se reintentará al reconectar.', error);
            return false;
        } finally {
            offlineListeningSyncInProgress = false;
        }
    }

    const saveCachedOfflineUser = (user) => {
        if (!user?._id) return;
        let verifier = null;
        try {
            verifier = JSON.parse(localStorage.getItem('amgc-offline-user') || 'null')?.verifier || null;
        } catch {
            verifier = null;
        }
        localStorage.setItem('amgc-offline-user', JSON.stringify({ user, verifier }));
    };

    async function deriveOfflinePasswordVerifier(password, salt) {
        if (!globalThis.crypto?.subtle) {
            throw new Error('El almacenamiento seguro offline requiere HTTPS o una aplicación instalada compatible.');
        }
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(password),
            'PBKDF2',
            false,
            ['deriveBits']
        );
        const derivedBits = await crypto.subtle.deriveBits({
            name: 'PBKDF2',
            salt,
            iterations: 250000,
            hash: 'SHA-256'
        }, key, 256);
        return new Uint8Array(derivedBits);
    }

    async function saveOfflineCredential(password) {
        const record = JSON.parse(localStorage.getItem('amgc-offline-user') || 'null') || {};
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const verifier = await deriveOfflinePasswordVerifier(password, salt);
        record.verifier = {
            salt: Array.from(salt),
            hash: Array.from(verifier)
        };
        localStorage.setItem('amgc-offline-user', JSON.stringify(record));
    }

    async function verifyOfflineCredential(password, userId) {
        try {
            const record = JSON.parse(localStorage.getItem('amgc-offline-user') || 'null');
            if (
                String(record?.user?._id) !== String(userId)
                || !Array.isArray(record?.verifier?.salt)
                || !Array.isArray(record?.verifier?.hash)
            ) return false;
            const candidate = await deriveOfflinePasswordVerifier(
                password,
                new Uint8Array(record.verifier.salt)
            );
            const expected = new Uint8Array(record.verifier.hash);
            if (candidate.length !== expected.length) return false;
            let difference = 0;
            for (let index = 0; index < candidate.length; index += 1) {
                difference |= candidate[index] ^ expected[index];
            }
            return difference === 0;
        } catch (error) {
            console.warn('No se pudo verificar el acceso offline.', error);
            return false;
        }
    };

    const isOfflineEnabledFor = (userId) => (
        localStorage.getItem(`amgc-offline-enabled-${userId}`) === 'true'
    );

    const setStoredUser = (user) => {
        if (!user) {
            localStorage.removeItem('amgc-user');
            secretPhrasesRequestSequence += 1;
            syncSecretPhrasesFromUser(null);
            syncDiscordImageTextFromUser(null);
            return;
        }
        localStorage.setItem('amgc-user', JSON.stringify(user));
        saveCachedOfflineUser(user);
        syncDiscordImageTextFromUser(user);
    };

    const canCurrentUser = (permission) => {
        if (offlineOnly) return false;
        const currentUser = getStoredUser();
        if (!currentUser) return false;
        if (currentUser.isAdmin) return true;
        const permissions = Array.isArray(currentUser.permissions) ? currentUser.permissions : [];
        return permissions.includes('admin') || permissions.includes(permission);
    };

    const syncAccessControls = () => {
        const canManageUsers = canCurrentUser('manage_users');
        if (btnAdmin) {
            btnAdmin.style.display = canManageUsers ? 'inline-block' : 'none';
        }
        if (btnAddSongHeader) {
            btnAddSongHeader.style.display = canCurrentUser('edit_songs') ? 'inline-block' : 'none';
        }
        if (btnDeleteSong) {
            btnDeleteSong.hidden = !canCurrentUser('delete_songs');
        }
    };

    function syncOfflineStatusIndicators() {
        if (sidebarOfflineStatus) {
            sidebarOfflineStatus.hidden = !offlineOnly || !getStoredUser();
        }
    }

    function renderProfile(forceStatsRefresh = false) {
        syncOfflineStatusIndicators();
        const user = selectedProfileUser || getStoredUser();
        const currentUser = getStoredUser();
        const profilePlaylistsToken = ++profilePlaylistsRequestToken;
        const isFriendProfile = Boolean(
            selectedProfileUser &&
            currentUser?._id &&
            String(selectedProfileUser._id) !== String(currentUser._id) &&
            selectedProfileUser.username !== currentUser.username
        );
        const name = user?.username || 'Usuario';
        const profilePhoto = user?.profilePhoto || '/img/perrocorasongif.gif';
        if (profileName) profileName.textContent = name;
        if (profileAvatar) profileAvatar.src = profilePhoto;
        if (!isFriendProfile) {
            if (sidebarProfileName) sidebarProfileName.textContent = name;
            if (sidebarProfileAvatar) sidebarProfileAvatar.src = profilePhoto;
        }
        if (profilePhotoButton) {
            profilePhotoButton.hidden = false;
            profilePhotoButton.disabled = isFriendProfile;
            profilePhotoButton.style.display = '';
            profilePhotoButton.classList.toggle('profile-photo-view-only', isFriendProfile);
        }
        if (btnProfileChatFriend) {
            btnProfileChatFriend.hidden = !isFriendProfile;
            btnProfileChatFriend.style.display = isFriendProfile ? '' : 'none';
            btnProfileChatFriend.setAttribute('aria-hidden', String(!isFriendProfile));
            btnProfileChatFriend.onclick = isFriendProfile
                ? () => openChat(selectedProfileUser._id, selectedProfileUser.username)
                : null;
        }
        if (btnOpenFriendsPanel) {
            btnOpenFriendsPanel.style.display = isFriendProfile ? 'none' : '';
        }
        const myPlaylists = user
            ? userPlaylists.filter(item => {
                const isOwner = String(item.ownerId) === String(user._id);
                const isSharedMember = (item.sharedWith || []).some(member => (
                    String(member?._id || member) === String(user._id)
                ));
                return isOwner || isSharedMember;
            })
            : [];
        const renderProfilePlaylists = (items) => {
            if (!profilePlaylists) return;
            profilePlaylists.replaceChildren();
            if (!items.length) {
                const emptyItem = document.createElement('li');
                emptyItem.textContent = 'Aún no hay listas públicas.';
                profilePlaylists.appendChild(emptyItem);
                return;
            }
            items.forEach(playlistItem => {
                const item = document.createElement('li');
                item.dataset.playlistId = playlistItem.id;
                if (isFriendProfile) item.classList.add('profile-visitor-playlist');
                const coverUrl = getPlaylistCover(playlistItem);
                const cover = coverUrl
                    ? document.createElement('img')
                    : document.createElement('div');
                if (coverUrl) {
                    cover.className = 'profile-playlist-cover';
                    cover.src = coverUrl;
                    cover.alt = '';
                    cover.loading = 'lazy';
                    cover.dataset.fallbackPlaceholder = 'true';
                } else {
                    cover.className = 'no-image-placeholder profile-playlist-cover-placeholder';
                    cover.textContent = 'SIN FOTO';
                    cover.setAttribute('aria-label', 'Playlist sin foto');
                }
                const name = document.createElement('span');
                name.textContent = playlistItem.name || 'Lista sin nombre';
                const details = document.createElement('small');
                const isMine = String(playlistItem.ownerId) === String(currentUser?._id);
                const creator = isMine ? 'tú' : (playlistItem.ownerName || 'desconocido');
                const playlistTrackCount = playlistItem.spotifyPlaylistId
                    ? playlistItem.playlistItems?.length || 0
                    : playlistItem.tracks?.length || 0;
                details.textContent = `${playlistTrackCount} canciones · ${creator}`;
                item.append(cover, name, details);
                item.addEventListener('click', () => openPlaylistView(playlistItem.id));
                profilePlaylists.appendChild(item);
            });
        };

        if (profileStats) {
            loadProfileStats(user, forceStatsRefresh);
        }

        if (profilePlaylists) {
            const profileUserId = String(user?._id || '');
            const visibleProfilePlaylists = isFriendProfile
                ? (publicProfilePlaylists
                    || profilePlaylistCache.get(profileUserId)
                    || userPlaylists.filter(item => (
                        String(item.ownerId) === profileUserId
                        || (item.sharedWith || []).some(member => (
                            String(member?._id || member) === profileUserId
                        ))
                    )))
                : myPlaylists;
            renderProfilePlaylists(visibleProfilePlaylists);
            if (isFriendProfile) {
                const isCurrentProfileRequest = () => (
                    profilePlaylistsToken === profilePlaylistsRequestToken
                    && String((selectedProfileUser || getStoredUser())?._id || '') === profileUserId
                );
                const applyCachedProfilePlaylists = async () => {
                    const viewerId = String(currentUser?._id || '');
                    if (!viewerId) return;
                    try {
                        const cachedPlaylists = await getOfflineProfilePlaylists(viewerId, profileUserId);
                        if (!cachedPlaylists || !isCurrentProfileRequest()) return;
                        profilePlaylistCache.set(profileUserId, cachedPlaylists);
                        if (!publicProfilePlaylists) {
                            publicProfilePlaylists = cachedPlaylists;
                            renderProfilePlaylists(cachedPlaylists);
                        }
                        await hydrateOfflinePlaylistCovers(cachedPlaylists);
                        if (
                            isCurrentProfileRequest()
                            && profilePlaylistCache.get(profileUserId) === cachedPlaylists
                        ) renderProfilePlaylists(cachedPlaylists);
                    } catch (error) {
                        console.warn('No se pudo leer la caché offline de playlists del perfil.', error);
                    }
                };
                applyCachedProfilePlaylists();
                if (!offlineOnly && navigator.onLine) fetchJsonWithRetry(`${API_URL}/playlists?profileUserId=${encodeURIComponent(profileUserId)}`, {}, 2).then(async publicPlaylists => {
                    if (
                        !isCurrentProfileRequest()
                    ) return;
                    publicProfilePlaylists = publicPlaylists.filter(item => (
                        String(item.ownerId) === profileUserId
                        || (item.sharedWith || []).some(member => (
                            String(member?._id || member) === profileUserId
                        ))
                    ));
                    profilePlaylistCache.set(profileUserId, publicProfilePlaylists);
                    renderProfilePlaylists(publicProfilePlaylists);
                    const viewerId = String(currentUser?._id || '');
                    if (viewerId) {
                        try {
                            await saveOfflineProfilePlaylists(viewerId, profileUserId, publicProfilePlaylists);
                            await hydrateOfflinePlaylistCovers(publicProfilePlaylists);
                            syncOfflineResources();
                        } catch (error) {
                            console.warn('No se pudo guardar la caché offline de playlists del perfil.', error);
                        }
                    }
                }).catch(error => {
                    if (!isCurrentProfileRequest()) return;
                    showToast(`No se pudieron cargar las playlists del perfil: ${error.message}`, true);
                });
            }
        }

        async function loadProfileStats(user, forceRefresh = false) {
            if (!profileStats || !user?._id) return;
            const profileId = String(user._id);
            const cacheKey = `amgc-profile-stats-${profileId}`;
            let requestToken = null;
            const currentProfileId = () => String((selectedProfileUser || getStoredUser())?._id || '');
            const isCurrentProfileRequest = () => (
                isProfileMode
                && currentProfileId() === profileId
                && (requestToken === null || profileStatsRequests.get(profileId) === requestToken)
            );
            const statElements = [
                'profile-stat-role',
                'profile-stat-hours',
                'profile-stat-played',
                'profile-stat-added',
                'profile-stat-edited',
                'profile-stat-friends',
                'profile-stat-messages',
                'profile-stat-created-at'
            ];
            statElements.forEach(id => {
                const element = document.getElementById(id);
                if (element) element.textContent = '…';
            });
            const applyStats = stats => {
                if (!isCurrentProfileRequest()) return;
                let pendingListeningSeconds = 0;
                if (String(getStoredUser()?._id) === String(user._id)) {
                    try {
                        const pending = JSON.parse(localStorage.getItem(`amgc-offline-listening-${user._id}`) || 'null');
                        pendingListeningSeconds = Math.max(0, Number(pending?.seconds) || 0) + offlineListeningBuffer;
                    } catch (error) {
                        console.warn('No se pudo leer la escucha offline pendiente del perfil.', error);
                    }
                }
                const totalListeningSeconds = Math.max(
                    0,
                    (Number.isFinite(Number(stats.listeningSeconds)) ? Number(stats.listeningSeconds) : 0)
                    + pendingListeningSeconds
                );
                const totalListeningMinutes = Math.floor(totalListeningSeconds / 60);
                const hours = Math.floor(totalListeningMinutes / 60);
                const minutes = totalListeningMinutes % 60;
                const createdAt = stats.createdAt
                    ? new Date(stats.createdAt).toLocaleDateString('es-CL', { timeZone: 'America/Santiago' })
                    : '-';
                const values = {
                    'profile-stat-role': stats.role || (user.isAdmin ? 'Administrador' : 'Usuario'),
                    'profile-stat-hours': `${hours} h ${minutes} min`,
                    'profile-stat-played': stats.songsPlayed || 0,
                    'profile-stat-added': stats.songsAdded || 0,
                    'profile-stat-edited': stats.songsEdited || 0,
                    'profile-stat-friends': stats.friendsAdded ?? (user.friends || []).length,
                    'profile-stat-messages': stats.messagesSent || 0,
                    'profile-stat-created-at': createdAt
                };
                Object.entries(values).forEach(([id, value]) => {
                    const element = document.getElementById(id);
                    if (element) element.textContent = String(value);
                });
            };

            const isOwnProfile = String(getStoredUser()?._id) === profileId;
            const memoryCachedStats = profileStatsCache.get(profileId);
            if (memoryCachedStats) applyStats(memoryCachedStats.stats);
            if (isOwnProfile) {
                try {
                    const cachedStats = JSON.parse(localStorage.getItem(cacheKey) || 'null');
                    if (cachedStats && !memoryCachedStats) applyStats(cachedStats);
                } catch (error) {
                    console.warn('No se pudieron leer las estadísticas guardadas del perfil.', error);
                }
            }

            if (!forceRefresh && memoryCachedStats && Date.now() - memoryCachedStats.cachedAt < 30000) return;
            if (!forceRefresh && profileStatsRequests.has(profileId)) return;

            requestToken = ++profileStatsRequestSequence;
            profileStatsRequests.set(profileId, requestToken);
            try {
                const stats = await fetchJsonWithRetry(`${API_URL}/users/${user._id}/stats`, {}, 2);
                if (!isCurrentProfileRequest()) return;
                profileStatsCache.set(profileId, { stats, cachedAt: Date.now() });
                if (isOwnProfile) {
                    try {
                        localStorage.setItem(cacheKey, JSON.stringify(stats));
                    } catch (error) {
                        console.warn('No se pudieron guardar las estadísticas del perfil en este dispositivo.', error);
                    }
                }
                applyStats(stats);
            } catch (error) {
                console.warn('No se pudieron cargar las estadísticas del perfil', error);
                if (isCurrentProfileRequest()) {
                    statElements.forEach(id => {
                        const element = document.getElementById(id);
                        if (element) element.textContent = '—';
                    });
                }
            }
            finally {
                if (profileStatsRequests.get(profileId) === requestToken) {
                    profileStatsRequests.delete(profileId);
                }
            }
        }

        if (profileActivity) {
            const isOwnProfile = !isFriendProfile;
            const ownRemotePlayback = isOwnProfile
                && sharedDevicePlayback?.deviceId !== playbackDeviceId
                ? sharedDevicePlayback
                : null;
            const track = isOwnProfile && currentTrackId !== null ? getCurrentTrack() : null;
            const recentTrack = hasPlaybackEvidence(user?.lastPlayed) ? user.lastPlayed : null;
            const localPlayback = isOwnProfile && track
                ? {
                    ...track,
                    isPlaying: !audio.paused,
                    currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
                    duration: Number.isFinite(audio.duration) && audio.duration > 0
                        ? audio.duration
                        : Number(track.duration) || 0,
                    updatedAt: new Date().toISOString(),
                    deviceId: playbackDeviceId,
                    deviceType: playbackDeviceType
                }
                : null;
            const displayTrack = isOwnProfile ? (ownRemotePlayback || localPlayback || recentTrack) : recentTrack;
            const currentSourceMatchesTrack = Boolean(!ownRemotePlayback && track && isCurrentAudioSource(track));
            const isLoadingTrack = Boolean(isOwnProfile && track && !ownRemotePlayback && !currentSourceMatchesTrack);
            const isListening = isOwnProfile
                ? Boolean(ownRemotePlayback
                    ? ownRemotePlayback.isPlaying !== false
                    : track && !audio.paused)
                : Boolean(user?.isOnline && displayTrack && displayTrack.isPlaying !== false);
            const isOnline = Boolean(user) && (isListening || user.isOnline !== false);
            const isOfflineProfile = isOwnProfile && offlineOnly;
            const profileDevicePlayback = ownRemotePlayback || (isOwnProfile && track
                ? { deviceId: playbackDeviceId, deviceType: playbackDeviceType }
                : displayTrack);
            const displayDeviceType = getPlaybackDeviceType(profileDevicePlayback);
            const currentCover = ownRemotePlayback
                ? getPlaybackCover(ownRemotePlayback)
                : track
                    ? getSongCover(track)
                    : getPlaybackCover(displayTrack);
            const activityColor = displayTrack?.color || '#ff8a00';
            const listeningLabel = isLoadingTrack
                ? 'Cargando'
                : displayTrack
                    ? isListening ? 'Escuchando' : 'Estaba escuchando'
                    : 'Sin actividad reciente';
            const lastHeardAt = displayTrack
                ? getPlaybackLastHeardAt(ownRemotePlayback || displayTrack, user?.lastPlayed)
                : '';
            const lastHeardLabel = displayTrack && !isListening
                ? getPlaybackLastHeardLabel(ownRemotePlayback || displayTrack, false, user?.lastPlayed)
                : '';
            const playbackStatusLabel = `${listeningLabel}${lastHeardLabel ? ` · ${lastHeardLabel}` : ''}`;
            const statusLabel = isOfflineProfile ? 'Modo offline' : isOnline ? 'En línea' : 'Desconectado';
            const statusMeta = !isOfflineProfile && !isOnline && user?.lastActive ? ` · ${timeAgo(user.lastActive)}` : '';
            const elapsed = isOwnProfile
                ? (ownRemotePlayback
                    ? getSharedPlaybackTime(ownRemotePlayback)
                    : currentSourceMatchesTrack && Number.isFinite(audio.currentTime) ? audio.currentTime : 0)
                : getPlaybackElapsedSeconds(displayTrack, isListening);
            const total = isOwnProfile
                ? (ownRemotePlayback
                    ? Number(ownRemotePlayback.duration) || 0
                    : currentSourceMatchesTrack && Number.isFinite(audio.duration) && audio.duration > 0
                        ? audio.duration
                        : Number(track?.duration) || 0)
                : (Number(displayTrack?.duration) || 0);
            const progress = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
            const localTrackIndex = isFriendProfile && displayTrack?.songId
                ? playlist.findIndex(item => String(item._id) === String(displayTrack.songId))
                : currentTrackIndex;
            const canJoin = Boolean(
                isFriendProfile
                && realtimeEnabled
                && !offlineOnly
                && navigator.onLine
                && user?.isOnline
                && displayTrack
                && localTrackIndex >= 0
            );

            if (profileStatus) {
                profileStatus.innerHTML = `
                    <span class="friend-status-dot ${isOfflineProfile ? 'offline' : isOnline ? 'online' : ''}"></span>
                    <span>${statusLabel}${statusMeta}</span>
                `;
            }

            profileActivity.innerHTML = `
                <div class="profile-activity-group">
                    <button
                        type="button"
                        class="profile-activity-song ${canJoin ? '' : 'disabled'}"
                        style="--profile-track-color: ${safeColor(activityColor)}"
                        ${canJoin ? `data-track-index="${localTrackIndex}"` : 'disabled'}
                        aria-label="Escuchar la misma canción"
                    >
                        <img src="${escapeHtml(currentCover)}" alt="Portada de la canción" class="profile-activity-cover" draggable="false" />
                        <div class="profile-activity-details">
                            <span class="profile-activity-label"><span
                                data-playback-status
                                data-is-listening="${isListening}"
                                data-last-heard-at="${escapeHtml(lastHeardAt)}"
                                data-fixed="${isLoadingTrack || !displayTrack}"
                            >${escapeHtml(playbackStatusLabel)}</span>${displayDeviceType ? playbackDeviceIconMarkup(displayDeviceType) : ''}</span>
                            <strong>${escapeHtml(displayTrack?.name || displayTrack?.songName || 'Sin actividad reciente')}</strong>
                            <small>${escapeHtml(displayTrack?.artist || 'Sin artista')}</small>
                            <div class="profile-activity-progress${displayTrack ? '' : ' is-hidden'}">
                                <span style="width: ${progress}%"></span>
                            </div>
                            <small class="profile-activity-time${displayTrack ? '' : ' is-hidden'}" data-profile-time>${formatTrackTime(elapsed)} / ${formatTrackTime(total)}</small>
                        </div>
                    </button>
                </div>
            `;

            profileActivity.style.pointerEvents = isFriendProfile ? '' : 'none';
            const joinSongButton = isFriendProfile
                ? profileActivity.querySelector('.profile-activity-song:not(.disabled)')
                : null;
            if (joinSongButton) {
                joinSongButton.addEventListener('click', () => {
                    if (!socket.connected) {
                        showToast('Espera a que se restablezca la conexión en tiempo real para escuchar junto a tu amigo.', true);
                        return;
                    }
                    const trackIndex = Number(joinSongButton.dataset.trackIndex);
                    if (!Number.isInteger(trackIndex) || !playlist[trackIndex]) return;
                    const targetUserId = isFriendProfile ? String(user._id) : null;
                    if (
                        sharedQueueRole === 'host'
                        || (sharedQueueRole === 'follower'
                            && (!isFriendProfile || String(listeningTogetherUserId || '') !== targetUserId))
                    ) {
                        leaveListenTogetherQueue();
                    }
                    listeningTogetherUserId = targetUserId;
                    listeningTogetherAwaitingFreshPlayback = isFriendProfile;
                    listeningTogetherNeedsUserGesture = false;
                    updateListeningTogetherStatus();
                    loadAndPlayTrack(trackIndex, isFriendProfile ? 'together' : 'regular', !isFriendProfile);
                    if (isFriendProfile) {
                        joinListenTogetherQueue(listeningTogetherUserId);
                        syncListeningTogether();
                    }
                });
            }
        }

        if (profileHistoryCard && profileHistory) {
            const history = Array.isArray(user?.lastPlayedHistory) ? user.lastPlayedHistory : [];
            profileHistoryCard.style.display = isFriendProfile && history.length ? 'block' : 'none';
            profileHistory.innerHTML = history.slice().reverse().slice(0, 10).map(item => `
                <li class="profile-history-item">
                    <span>${escapeHtml(item.songName || 'Canción desconocida')}${item.artist ? ` · ${escapeHtml(item.artist)}` : ''}</span>
                    <small>${item.playedAt ? timeAgo(item.playedAt) : ''}</small>
                </li>
            `).join('');
        }

        renderProfileFriendsSection(isFriendProfile ? (user?.friends || []) : currentFriends, !isFriendProfile);

        profilePlaylists?.querySelectorAll('li[data-playlist-id]').forEach((item) => {
            item.addEventListener('click', () => openPlaylistView(item.dataset.playlistId));
        });
        syncProfileActivityTimer();
    }

    function timeAgo(dateValue) {
        if (dateValue === null || dateValue === undefined || dateValue === '') return '';
        const timestamp = new Date(dateValue).getTime();
        if (!Number.isFinite(timestamp)) return '';
        const diffMs = Math.max(0, Date.now() - timestamp);
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1) return 'justo ahora';
        if (diffMin < 60) return `hace ${diffMin} min`;
        const diffH = Math.floor(diffMin / 60);
        if (diffH < 24) return `hace ${diffH} h`;
        return `hace ${Math.floor(diffH / 24)} d`;
    }

    function updateProfileActivityProgress() {
        if (!profileActivity || !isProfileMode) return;
        updateProfileActivityStatusLabel();
        const profileUser = selectedProfileUser || getStoredUser();
        const ownRemotePlayback = String(profileUser?._id || '') === String(getStoredUser()?._id || '')
                && sharedDevicePlayback?.deviceId !== playbackDeviceId
                ? sharedDevicePlayback
                : null;
        if (selectedProfileUser || ownRemotePlayback) {
            const playback = ownRemotePlayback || selectedProfileUser.lastPlayed;
            const duration = Number(playback?.duration) || 0;
            if (!playback || !playback.songName || duration <= 0) return;
            const isPlaying = Boolean(ownRemotePlayback
                ? playback.isPlaying !== false
                : selectedProfileUser?.isOnline && playback.isPlaying !== false);
            const elapsed = ownRemotePlayback
                ? getSharedPlaybackTime(playback)
                : getPlaybackElapsedSeconds(playback, isPlaying);
            const progressFill = profileActivity.querySelector('.profile-activity-progress span');
            const timeLabel = profileActivity.querySelector('[data-profile-time]');
            if (progressFill) progressFill.style.width = `${Math.min(100, (elapsed / duration) * 100)}%`;
            if (timeLabel) timeLabel.textContent = `${formatTrackTime(elapsed)} / ${formatTrackTime(duration)}`;
            return;
        }
        if (
            String(playbackActivityUserId || '') !== String(getStoredUser()?._id || '')
            && !isFollowingPlayback()
        ) return;
        const track = getCurrentTrack();
        if (!track) return;
        updateListeningTogetherStatus();

        const total = Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : Number(track.duration) || 0;
        const elapsed = Number.isFinite(playbackUiTime) ? playbackUiTime : 0;
        const progress = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
        const progressFill = profileActivity.querySelector('.profile-activity-progress span');
        const timeLabel = profileActivity.querySelector('[data-profile-time]');

        if (progressFill) progressFill.style.width = `${progress}%`;
        if (timeLabel) timeLabel.textContent = `${formatTrackTime(elapsed)} / ${formatTrackTime(total)}`;
    }

    function updateProfileActivityStatusLabel() {
        const status = profileActivity?.querySelector('[data-playback-status]');
        if (!status || status.dataset.fixed === 'true') return;
        const isListening = status.dataset.isListening === 'true';
        const lastHeard = formatPlaybackRelativeTime(status.dataset.lastHeardAt);
        const label = isListening
            ? 'Escuchando'
            : `Estaba escuchando${lastHeard ? ` · ${lastHeard}` : ''}`;
        if (status.textContent !== label) status.textContent = label;
    }

    function syncProfileActivityTimer() {
        if (!isProfileMode || document.hidden || !profileActivity?.querySelector('[data-playback-status]')) {
            if (profileActivityTimer) clearInterval(profileActivityTimer);
            profileActivityTimer = null;
            return;
        }
        if (profileActivityTimer) return;
        updateProfileActivityProgress();
        profileActivityTimer = window.setInterval(() => {
            if (!isProfileMode || document.hidden) {
                clearInterval(profileActivityTimer);
                profileActivityTimer = null;
                return;
            }
            updateProfileActivityProgress();
        }, 1000);
    }

    function getFriendPlaybackElapsed(friendId) {
        const playback = friendRealtimeUpdates.get(String(friendId || ''))?.lastPlayed;
        const isOnline = friendRealtimeUpdates.get(String(friendId || ''))?.isOnline !== false;
        return Math.max(0, getPlaybackElapsedSeconds(playback, isOnline) - (Number(playback?.currentTime) || 0));
    }

    function formatTrackTime(seconds = 0) {
        const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
        const mins = Math.floor(safeSeconds / 60);
        const secs = safeSeconds % 60;
        return `${mins}:${String(secs).padStart(2, '0')}`;
    }

    function playbackDeviceIconMarkup(deviceType) {
        const iconContents = deviceType === 'mobile'
            ? '<rect x="6.5" y="2.5" width="11" height="19" rx="2.2"></rect><path d="M10 5.5h4M11 18.5h2"></path>'
            : deviceType === 'desktop'
                ? '<rect x="3" y="3" width="18" height="13" rx="1.5"></rect><path d="M8 21h8M12 16v5M5 21h14"></path>'
                : '';
        if (!iconContents) return '';
        return `<svg class="playback-device-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconContents}</svg>`;
    }

    function getPlaybackDeviceType(playback) {
        if (['mobile', 'desktop'].includes(playback?.deviceType)) return playback.deviceType;
        const registeredDevice = connectedPlaybackDevices.find(device => device.deviceId === playback?.deviceId);
        if (['mobile', 'desktop'].includes(registeredDevice?.deviceType)) return registeredDevice.deviceType;
        const deviceName = `${playback?.deviceName || registeredDevice?.deviceName || ''}`;
        if (/android|iphone|ipad|móvil/i.test(deviceName)) return 'mobile';
        if (/windows|macos|linux|escritorio/i.test(deviceName)) return 'desktop';
        return playback?.deviceId === playbackDeviceId ? playbackDeviceType : 'mobile';
    }

    function getPlaybackDeviceName(playback) {
        const registeredDevice = connectedPlaybackDevices.find(device => device.deviceId === playback?.deviceId);
        if (playback?.deviceName || registeredDevice?.deviceName) {
            return (playback.deviceName || registeredDevice.deviceName)
                .replace(/\s*(?:·|[-–—])\s*(?:Microsoft Edge|Edge|Chrome|Chromium|Firefox|Safari|Opera|Brave|Samsung Internet|AMGC)\s*$/i, '')
                .trim();
        }
        const deviceType = getPlaybackDeviceType(playback);
        return deviceType === 'mobile' ? 'AMGC en Android'
            : deviceType === 'desktop' ? 'AMGC en escritorio'
                : playback?.deviceId === playbackDeviceId
                    ? 'Este equipo'
                    : playback?.deviceId
                        ? `Dispositivo · ${String(playback.deviceId).slice(-4).toUpperCase()}`
                        : 'Dispositivo';
    }

    function updatePlaybackDevicePickerIcons() {
        const playback = getRemotePlaybackSession() || {
            deviceId: playbackDeviceId,
            deviceType: playbackDeviceType
        };
        const deviceType = getPlaybackDeviceType(playback);
        playbackDeviceTriggers.forEach(trigger => {
            trigger.innerHTML = playbackDeviceIconMarkup(deviceType)
                .replace('class="playback-device-inline"', 'class="playback-device-trigger-icon"');
        });
    }

    function renderPlaybackDevicePicker() {
        if (!playbackDeviceList) return;
        const devices = connectedPlaybackDevices.length
            ? [...connectedPlaybackDevices]
            : [{
                deviceId: playbackDeviceId,
                deviceName: getPlaybackDeviceName({ deviceId: playbackDeviceId, deviceType: playbackDeviceType }),
                deviceType: playbackDeviceType,
                isConnected: true
            }];
        if (!devices.some(device => device.deviceId === playbackDeviceId)) {
            devices.unshift({
                deviceId: playbackDeviceId,
                deviceName: 'Este equipo',
                deviceType: playbackDeviceType,
                isConnected: true
            });
        }
        const activeDeviceId = sharedDevicePlayback?.deviceId
            || (getCurrentTrack() ? playbackDeviceId : '');
        playbackDeviceList.replaceChildren();
        devices.sort((first, second) => Number(second.deviceId === playbackDeviceId) - Number(first.deviceId === playbackDeviceId));
        devices.forEach(device => {
            const isCurrentDevice = device.deviceId === playbackDeviceId;
            const isCurrentPlaybackDevice = device.deviceId === activeDeviceId;
            const label = isCurrentDevice ? 'Este equipo' : device.deviceName || 'Dispositivo';
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'playback-device-option';
            option.classList.toggle('is-current-playback', isCurrentPlaybackDevice);
            option.setAttribute('aria-current', String(isCurrentPlaybackDevice));
            option.setAttribute('aria-label', isCurrentDevice ? label : `Transferir reproducción a ${label}`);
            option.disabled = playbackTransferPending || isCurrentPlaybackDevice || device.isConnected === false;
            const icon = document.createElement('span');
            icon.className = 'playback-device-option-icon';
            icon.innerHTML = playbackDeviceIconMarkup(getPlaybackDeviceType(device) || device.deviceType);
            const name = document.createElement('span');
            name.className = 'playback-device-option-name';
            name.textContent = label;
            const status = document.createElement('small');
            status.className = 'playback-device-option-status';
            status.textContent = device.isConnected === false
                ? 'Desconectado'
                : isCurrentDevice ? '' : 'Conectado';
            option.append(icon, name, status);
            option.addEventListener('click', () => void transferPlaybackToDevice(device.deviceId));
            const row = document.createElement('div');
            row.className = 'playback-device-row';
            row.append(option);
            if (!isCurrentDevice) {
                const removeButton = document.createElement('button');
                removeButton.type = 'button';
                removeButton.className = 'playback-device-remove';
                removeButton.textContent = '×';
                removeButton.title = device.isConnected === false
                    ? `Eliminar ${label}`
                    : `Desconecta ${label} para poder eliminarlo`;
                removeButton.setAttribute('aria-label', `Eliminar dispositivo ${label}`);
                removeButton.disabled = playbackDeviceRemovalPending || device.isConnected !== false;
                removeButton.addEventListener('click', () => void removePlaybackDevice(device));
                row.append(removeButton);
            }
            playbackDeviceList.append(row);
        });
    }

    function setPlaybackDevicePickerOpen(open) {
        if (!playbackDevicePicker) return;
        playbackDevicePicker.hidden = !open;
        playbackDeviceTriggers.forEach(trigger => trigger.setAttribute('aria-expanded', String(open)));
        if (open) renderPlaybackDevicePicker();
    }

    async function transferPlaybackToDevice(targetDeviceId) {
        if (playbackTransferPending) return;
        setPlaybackDevicePickerOpen(false);
        playbackTransferPending = true;
        const endLoading = beginPlaybackRequestLoading();
        renderPlaybackDevicePicker();
        try {
            const response = await requestPlaybackSocket(
                'playbackTransferRequest',
                { targetDeviceId },
                55000
            );
            if (!response.success) throw new Error(response.error || 'No se pudo transferir la reproducción.');
            if (response.alreadyOwner) showToast('Ese dispositivo ya tiene el control de reproducción.');
        } catch (error) {
            showToast(error.message || 'No se pudo transferir la reproducción.', true);
        } finally {
            endLoading();
            playbackTransferPending = false;
            renderPlaybackDevicePicker();
            const deferredPlaybackUpdate = deferredPlaybackOwnerUpdate;
            deferredPlaybackOwnerUpdate = null;
            if (deferredPlaybackUpdate) handleOwnPlaybackUpdate(deferredPlaybackUpdate);
        }
    }

    async function removePlaybackDevice(device) {
        if (
            playbackDeviceRemovalPending
            || playbackTransferPending
            || !device?.deviceId
            || device.deviceId === playbackDeviceId
            || device.isConnected !== false
            || !window.confirm(`¿Eliminar el dispositivo «${device.deviceName || 'Dispositivo'}» de tu cuenta?`)
        ) return;
        playbackDeviceRemovalPending = true;
        renderPlaybackDevicePicker();
        try {
            const response = await requestPlaybackSocket('playbackDeviceRemoveRequest', {
                deviceId: device.deviceId
            });
            if (!response.success) throw new Error(response.error || 'No se pudo eliminar el dispositivo.');
            connectedPlaybackDevices = connectedPlaybackDevices.filter(
                item => item.deviceId !== device.deviceId
            );
            renderPlaybackDevicePicker();
            showToast('Dispositivo eliminado.');
        } catch (error) {
            showToast(error.message || 'No se pudo eliminar el dispositivo.', true);
        } finally {
            playbackDeviceRemovalPending = false;
            renderPlaybackDevicePicker();
        }
    }

    async function activateTransferredPlayback(request = {}, acknowledge = () => {}) {
        const acknowledgeResult = typeof acknowledge === 'function' ? acknowledge : () => {};
        const playback = request.playback;
        if (!playback?.songId) {
            acknowledgeResult({ success: false, error: 'La transferencia no contiene una canción válida.' });
            return;
        }
        const requestedSongId = String(request.requestedSongId || playback.songId);
        const pendingRequestedSongId = getPendingPlaybackTakeoverSongId();
        if (pendingRequestedSongId && pendingRequestedSongId !== requestedSongId) {
            acknowledgeResult({ success: false, error: 'La transferencia fue reemplazada por una selección más reciente.' });
            return;
        }
        const transferId = request.transferId || playback.transferId || null;
        if (
            isActivatingPlaybackTransfer
            && transferId === activePlaybackTransferId
            && activePlaybackTransferUserId === String(getStoredUser()?._id || '')
            && requestedSongId === String(getCurrentTrack()?._id || getCurrentTrack()?.id || '')
        ) {
            acknowledgeResult({ success: true });
            return;
        }
        const endLoading = beginPlaybackRequestLoading();
        if (transferId) {
            activePlaybackTransferId = transferId;
            activePlaybackTransferUserId = String(getStoredUser()?._id || '');
        }
        playbackOwnerConfirmed = false;
        isActivatingPlaybackTransfer = true;
        playbackTransferPending = true;
        renderPlaybackDevicePicker();
        try {
            let trackIndex = playlist.findIndex(track => String(track._id || track.id) === requestedSongId);
            if (trackIndex < 0 && !offlineOnly && navigator.onLine) {
                const refreshedLibrary = await fetchJsonWithRetry(`${API_URL}/songs`);
                playlist = Array.isArray(refreshedLibrary?.songs) ? refreshedLibrary.songs : [];
                trackIndex = playlist.findIndex(track => String(track._id || track.id) === requestedSongId);
            }
            if (trackIndex < 0) {
                throw new Error('La canción transferida no está disponible en la biblioteca de este dispositivo.');
            }
            const duration = Math.max(0, Number(playback.duration) || 0);
            let restoreTime = requestedSongId === String(playback.songId)
                ? getSharedPlaybackTime(playback)
                : 0;
            if (duration > 0 && restoreTime >= duration - 1) restoreTime = 0;
            const shouldResume = request.resumeAfterTransfer === true;
            sharedDevicePlayback = null;
            if (sharedPlaybackClockTimer) clearInterval(sharedPlaybackClockTimer);
            sharedPlaybackClockTimer = null;
            const queueSource = 'regular';
            const alreadyPlayingRequestedSong = shouldResume
                && !audio.paused
                && String(getCurrentTrack()?._id || getCurrentTrack()?.id || '') === requestedSongId;
            let loaded = alreadyPlayingRequestedSong;
            if (alreadyPlayingRequestedSong) {
                currentTrackIndex = trackIndex;
                currentTrackId = String(playlist[trackIndex]._id || playlist[trackIndex].id);
                currentTrackSource = queueSource;
            } else {
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    loaded = await loadAndPlayTrack(trackIndex, queueSource, shouldResume, restoreTime);
                    if (loaded || attempt > 0) break;
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
            if (!loaded) {
                throw new Error('No se pudo iniciar la canción en esta PC.');
            }
            await waitForAudioMetadata();
            if (!alreadyPlayingRequestedSong) {
                audio.currentTime = Math.min(restoreTime, audio.duration || restoreTime);
            }
            sharedPlaybackTime = Number(audio.currentTime) || 0;
            sharedPlaybackDuration = Number(audio.duration) || duration;
            if (shouldResume && audio.paused) await audio.play();
            customQueue = [];
            activePlaylistId = null;
            queueName = 'GENERAL';
            activeQueueTracks = [...playlist];
            generalQueueAnchorTrackId = String(playlist[trackIndex]._id || playlist[trackIndex].id);
            unplayedIndices = [];
            savePendingAccountQueueIds([]);
            renderQueue();
            isActivatingPlaybackTransfer = false;
            clearPendingPlaybackTakeover(requestedSongId);
            broadcastPlaybackState(true);
            void updateUserStatus(true);
            acknowledgeResult({ success: true });
        } catch (error) {
            if (!audio.paused) audio.pause();
            isActivatingPlaybackTransfer = false;
            if (activePlaybackTransferId === transferId) {
                activePlaybackTransferId = null;
                activePlaybackTransferUserId = null;
            }
            if (transferId && socket.connected) socket.emit('playbackTransferRepairFailed', { transferId });
            sharedDevicePlayback = { ...playback, isPlaying: false };
            renderSharedPlaybackStatus();
            acknowledgeResult({ success: false, error: error.message || 'No se pudo iniciar la reproducción en esta PC.' });
        } finally {
            endLoading();
            isActivatingPlaybackTransfer = false;
            playbackTransferPending = false;
            renderPlaybackDevicePicker();
            renderSharedPlaybackStatus();
        }
    }

    function getSharedPlaybackTime(playback) {
        const duration = Math.max(0, Number(playback?.duration) || 0);
        const baseTime = Math.max(0, Number(playback?.currentTime) || 0);
        const updatedAt = Date.parse(playback?.updatedAt || '');
        const elapsed = playback?.isPlaying !== false && Number.isFinite(updatedAt)
            ? Math.max(0, (Date.now() - updatedAt) / 1000)
            : 0;
        const currentTime = baseTime + elapsed;
        return duration > 0 ? Math.min(duration, currentTime) : currentTime;
    }

    function isRemotePlaybackLocked() {
        return Boolean(
            sharedDevicePlayback?.deviceId
            && sharedDevicePlayback.deviceId !== playbackDeviceId
            && sharedDevicePlayback.isPlaying !== false
        );
    }

    function getRemotePlaybackSession() {
        return sharedDevicePlayback?.deviceId && sharedDevicePlayback.deviceId !== playbackDeviceId
            ? sharedDevicePlayback
            : null;
    }

    function requestPlaybackSocket(eventName, payload, timeout = 8000) {
        return new Promise(resolve => {
            if (!socket?.connected) {
                resolve({ success: false, error: 'No hay conexión en tiempo real.' });
                return;
            }
            socket.timeout(timeout).emit(eventName, payload, (timeoutError, response) => {
                resolve(timeoutError
                    ? { success: false, error: 'El servidor no confirmó la acción a tiempo.' }
                    : response || { success: false, error: 'El servidor devolvió una respuesta vacía.' });
            });
        });
    }

    function getPendingPlaybackTakeoverStorageKey() {
        return `amgc-desktop-pending-playback-${getStoredUser()?._id || 'guest'}`;
    }

    function getPendingPlaybackTakeoverSongId() {
        try {
            return localStorage.getItem(getPendingPlaybackTakeoverStorageKey()) || '';
        } catch (error) {
            console.error('No se pudo leer la intención de reproducción pendiente.', error);
            return '';
        }
    }

    function savePendingPlaybackTakeover(songId) {
        try {
            localStorage.setItem(getPendingPlaybackTakeoverStorageKey(), String(songId));
        } catch (error) {
            console.error('No se pudo guardar la intención de reproducción pendiente.', error);
            showToast('No se pudo guardar la reproducción pendiente localmente.', true);
        }
    }

    function clearPendingPlaybackTakeover(expectedSongId = '') {
        try {
            const key = getPendingPlaybackTakeoverStorageKey();
            if (!expectedSongId || localStorage.getItem(key) === expectedSongId) {
                localStorage.removeItem(key);
                if (pendingPlaybackTakeoverRetryTimer) {
                    clearTimeout(pendingPlaybackTakeoverRetryTimer);
                    pendingPlaybackTakeoverRetryTimer = null;
                }
                pendingPlaybackTakeoverRetryDelay = 30000;
                pendingPlaybackTakeoverNotifiedSongId = '';
            }
        } catch (error) {
            console.error('No se pudo limpiar la intención de reproducción pendiente.', error);
        }
    }

    async function playLocalTrackForTakeover(songId) {
        const trackIndex = playlist.findIndex(track => String(track._id || track.id) === String(songId));
        if (trackIndex < 0) {
            showToast('La canción no está disponible en esta PC.', true);
            return false;
        }
        savePendingPlaybackTakeover(songId);
        sharedDevicePlayback = null;
        if (sharedPlaybackClockTimer) clearInterval(sharedPlaybackClockTimer);
        sharedPlaybackClockTimer = null;
        const started = await loadAndPlayTrack(trackIndex, 'regular', true, 0, true);
        if (!started) {
            clearPendingPlaybackTakeover(String(songId));
            return false;
        }
        customQueue = [];
        activePlaylistId = null;
        queueName = 'GENERAL';
        activeQueueTracks = [...playlist];
        generalQueueAnchorTrackId = String(playlist[trackIndex]._id || playlist[trackIndex].id);
        unplayedIndices = [];
        savePendingAccountQueueIds([]);
        renderQueue();
        if (socket.connected) void resumePendingPlaybackTakeover();
        return true;
    }

    async function resumePendingPlaybackTakeover() {
        const requestedSongId = getPendingPlaybackTakeoverSongId();
        if (!requestedSongId || !socket.connected) return;
        const currentSongId = String(getCurrentTrack()?._id || getCurrentTrack()?.id || '');
        if (currentSongId && currentSongId !== requestedSongId) {
            clearPendingPlaybackTakeover(requestedSongId);
            return;
        }
        const endLoading = beginPlaybackRequestLoading();
        try {
            const response = await requestPlaybackSocket('playbackTransferRequest', {
                targetDeviceId: playbackDeviceId,
                requestedSongId,
                authoritative: true
            }, 55000);
            if (response.success) {
                clearPendingPlaybackTakeover(requestedSongId);
            } else if (pendingPlaybackTakeoverNotifiedSongId !== requestedSongId) {
                showToast(response.error || 'La reproducción local sigue activa; no se pudo transferir.', true);
                pendingPlaybackTakeoverNotifiedSongId = requestedSongId;
                schedulePendingPlaybackTakeoverRetry();
            }
        } finally {
            endLoading();
        }
    }

    function schedulePendingPlaybackTakeoverRetry() {
        if (pendingPlaybackTakeoverRetryTimer || !socket.connected || !getPendingPlaybackTakeoverSongId()) return;
        const delay = pendingPlaybackTakeoverRetryDelay;
        pendingPlaybackTakeoverRetryDelay = Math.min(pendingPlaybackTakeoverRetryDelay * 2, 180000);
        pendingPlaybackTakeoverRetryTimer = window.setTimeout(() => {
            pendingPlaybackTakeoverRetryTimer = null;
            void resumePendingPlaybackTakeover();
        }, delay);
    }

    function waitForAudioMetadata() {
        if (audio.readyState >= 1) return Promise.resolve();
        if (audio.error) return Promise.reject(new Error(getTransferAudioErrorMessage()));
        return new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => {
                cleanup();
                reject(new Error('La canción no terminó de cargar en esta PC.'));
            }, 12000);
            const cleanup = () => {
                window.clearTimeout(timeout);
                audio.removeEventListener('loadedmetadata', onLoaded);
                audio.removeEventListener('error', onError);
            };
            const onLoaded = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error(getTransferAudioErrorMessage()));
            };
            audio.addEventListener('loadedmetadata', onLoaded, { once: true });
            audio.addEventListener('error', onError, { once: true });
        });
    }

    function getTransferAudioErrorMessage() {
        const messages = {
            2: 'Error de red al cargar la canción en esta PC.',
            3: 'El formato de audio de esta canción no se pudo decodificar.',
            4: 'El servidor no ofrece un formato de audio compatible con esta PC.'
        };
        return messages[audio.error?.code] || 'No se pudo cargar la canción en esta PC.';
    }

    async function requestRemotePlaybackControl(action, details = {}, notifyError = true) {
        const playback = getRemotePlaybackSession();
        if (!playback) return false;
        const requestedSongId = String(details.songId || '');
        if (action === 'playTrack' && !socket.connected) {
            return playLocalTrackForTakeover(requestedSongId);
        }
        const endLoading = beginPlaybackRequestLoading();
        try {
            let response = await requestPlaybackSocket('playbackControlRequest', {
                action,
                deviceId: playbackDeviceId,
                ...details
            }, 7000);
            if (
                !response.success
                && ['toggle', 'next', 'previous', 'playTrack'].includes(action)
                && (
                    response.ownerDisconnected
                    || response.ownerUnresponsive
                    || response.playbackUnavailable
                    || !socket.connected
                    || response.error === 'El servidor no confirmó la acción a tiempo.'
                )
            ) {
                const transferSongId = action === 'playTrack'
                    ? requestedSongId
                    : action === 'next'
                        ? accountQueueIds[0]
                            || String(playlist[getSequentialQueueIndices()[0]]?._id || playback.songId || '')
                        : action === 'previous'
                            ? String(playlist[playbackHistory.at(-1)?.index]?._id || playback.songId || '')
                            : String(playback.songId || '');
                return await playLocalTrackForTakeover(transferSongId);
            }
            if (!response.success && notifyError) showToast(response.error || 'No se pudo controlar la reproducción remota.', true);
            return Boolean(response.success);
        } finally {
            endLoading();
        }
    }

    let remoteSeekTimer = null;
    let queuedRemoteSeekPosition = 0;
    function queueRemotePlaybackSeek(position) {
        queuedRemoteSeekPosition = Math.max(0, Number(position) || 0);
        if (remoteSeekTimer) clearTimeout(remoteSeekTimer);
        remoteSeekTimer = window.setTimeout(() => {
            remoteSeekTimer = null;
            void requestRemotePlaybackControl('seek', { position: queuedRemoteSeekPosition });
        }, 120);
    }

    function updatePlaybackControlLock() {
        if (progressContainer) progressContainer.setAttribute('aria-disabled', 'false');
        bottomBar?.classList.toggle('is-remote-playback', Boolean(sharedDevicePlayback?.songName));
    }

    function renderSharedPlaybackStatus() {
        const playback = sharedDevicePlayback;
        if (!sharedPlaybackStatus) return;
        const visible = Boolean(playback?.songName && playback.deviceId !== playbackDeviceId);
        sharedPlaybackStatus.hidden = !visible;
        if (!visible) {
            updatePlaybackDevicePickerIcons();
            const localTrack = getCurrentTrack();
            if (localTrack) {
                bottomBar.style.setProperty('--track-color', safeColor(localTrack.color));
                updateVolumeSliderUI(currentVolume);
                trackNameEl.textContent = localTrack.name || '';
                trackArtistEl.textContent = localTrack.artist || '';
                bottomBarCover.src = getSongCover(localTrack);
                trackDurationEl.textContent = formatTrackTime(Number(audio.duration) || Number(localTrack.duration) || 0);
                if (progressBar) {
                    const duration = Number(audio.duration) || 0;
                    progressBar.style.width = `${duration > 0 ? Math.min(100, audio.currentTime / duration * 100) : 0}%`;
                }
                updateTrackDurationLabel(audio.currentTime || 0, Number(audio.duration) || Number(localTrack.duration) || 0);
                btnShuffle.classList.toggle('active', isShuffle);
            }
            const playPauseIcon = btnPlayPause.querySelector('img');
            if (playPauseIcon) playPauseIcon.src = audio.paused ? '/img/play.png' : '/img/pause.png';
            updatePlaybackControlLock();
            return;
        }
        const duration = Math.max(0, Number(playback.duration) || 0);
        const currentTime = getSharedPlaybackTime(playback);
        const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
        updatePlaybackDevicePickerIcons();
        sharedPlaybackTitleText.textContent = playback.songName || '';
        sharedPlaybackArtist.textContent = playback.artist || '';
        const playbackCover = getPlaybackCover(playback);
        sharedPlaybackCover.src = playbackCover;
        bottomBar.style.setProperty('--track-color', safeColor(playback.color));
        updateVolumeSliderUI(currentVolume);
        sharedPlaybackProgressFill.style.width = `${progress}%`;
        sharedPlaybackTimeLabel.textContent = `${formatTrackTime(currentTime)} / ${formatTrackTime(duration)}`;
        trackNameEl.textContent = playback.songName || '';
        trackArtistEl.textContent = playback.artist || '';
        bottomBarCover.src = playbackCover;
        trackDurationEl.textContent = formatTrackTime(duration);
        if (progressBar) progressBar.style.width = `${progress}%`;
        updateTrackDurationLabel(currentTime, duration);
        const playPauseIcon = btnPlayPause.querySelector('img');
        if (playPauseIcon) playPauseIcon.src = playback.isPlaying === false ? '/img/play.png' : '/img/pause.png';
        btnShuffle.classList.toggle('active', playback.shuffle === true);
        updatePlaybackControlLock();
    }

    function pauseForRemotePlayback() {
        if (audio.paused) return;
        suppressRemotePlaybackPause = true;
        audio.pause();
    }

    function handleOwnPlaybackUpdate({ userId, playback } = {}) {
        const ownUserId = String(getStoredUser()?._id || '');
        if (!ownUserId || String(userId || '') !== ownUserId || !playback) return;
        if (
            isActivatingPlaybackTransfer
            && playback.transferId === activePlaybackTransferId
            && activePlaybackTransferUserId === ownUserId
        ) return;
        if (playbackTransferPending && !isActivatingPlaybackTransfer) {
            deferredPlaybackOwnerUpdate = { userId, playback };
        }
        const pendingPlaybackSongId = getPendingPlaybackTakeoverSongId();
        const localTrackId = String(getCurrentTrack()?._id || getCurrentTrack()?.id || '');
        if (
            playback.deviceId
            && playback.deviceId !== playbackDeviceId
            && pendingPlaybackSongId
            && pendingPlaybackSongId === localTrackId
        ) return;
        if (
            !playback.deviceId
            || playback.deviceId === playbackDeviceId
        ) {
            playbackOwnerConfirmed = playback.transferPending !== true;
            const localTrack = getCurrentTrack();
            const expectedTime = getSharedPlaybackTime(playback);
            if (playback.transferPending === true && playback.isPlaying === false) {
                audioSourceLoadToken += 1;
                pauseForRemotePlayback();
            }
            if (
                playback.transferId
                && playback.isPlaying !== false
                && !playbackTransferPending
                && (
                    !localTrack
                    || getTrackStorageId(localTrack) !== String(playback.songId || '')
                    || audio.paused
                    || Math.abs((Number(audio.currentTime) || 0) - expectedTime) > 3
                )
            ) {
                void activateTransferredPlayback({
                    playback,
                    transferId: playback.transferId,
                    resumeAfterTransfer: true
                });
                return;
            }
            if (playback.transferId) {
                activePlaybackTransferId = playback.transferId;
                activePlaybackTransferUserId = ownUserId;
            }
            const hadRemotePlayback = Boolean(sharedDevicePlayback);
            sharedDevicePlayback = null;
            syncAccountQueue();
            if (sharedPlaybackClockTimer) clearInterval(sharedPlaybackClockTimer);
            sharedPlaybackClockTimer = null;
            renderSharedPlaybackStatus();
            if (isLyricsMode) updateLyricsView();
            if (!getRemotePlaybackSession()) {
                updateCurrentLyric(getCurrentTrack(), Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
                renderQueue();
            }
            const profileUser = selectedProfileUser || getStoredUser();
            if (hadRemotePlayback && isProfileMode && String(profileUser?._id || '') === ownUserId) {
                renderProfile();
            }
            return;
        }
        const previousSongId = sharedDevicePlayback?.songId;
        const previousColor = sharedDevicePlayback?.color;
        playbackOwnerConfirmed = false;
        sharedDevicePlayback = playback;
        syncAccountQueue();
        playbackActivityUserId = null;
        sharedPlaybackPlaying = false;
        stopPlaybackStatusSync();
        pauseForRemotePlayback();
        renderSharedPlaybackStatus();
        updateCurrentLyric(getLyricsTrack(), getSharedPlaybackTime(playback));
        renderQueue();
        if (sharedPlaybackClockTimer) clearInterval(sharedPlaybackClockTimer);
        if (playback.isPlaying !== false) {
            sharedPlaybackClockTimer = setInterval(() => {
                renderSharedPlaybackStatus();
                updateCurrentLyric(getLyricsTrack(), getSharedPlaybackTime(sharedDevicePlayback));
                if (isLyricsMode) updateLyricsPlaybackProgress();
                if (isProfileMode) updateProfileActivityProgress();
            }, 1000);
        }
        if (
            isLyricsMode
            && (
                String(previousSongId || '') !== String(playback.songId || '')
                || previousColor !== playback.color
            )
        ) updateLyricsView();
        else if (isLyricsMode) updateLyricsPlaybackProgress();
        const profileUser = selectedProfileUser || getStoredUser();
        if (isProfileMode && String(profileUser?._id || '') === ownUserId) {
            if (String(previousSongId || '') !== String(playback.songId || '')) renderProfile();
            else updateProfileActivityProgress();
        }
    }

    function hasPlaybackEvidence(playback) {
        return Boolean(
            playback?.songName
            && (
                playback.isPlaying === true
                || Number(playback.currentTime) > 0
                || Number(playback.duration) > 0
            )
        );
    }

    function formatPlaylistDuration(seconds = 0) {
        const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        if (hours > 0) return `${hours} h ${minutes} min`;
        return `${minutes} min`;
    }

    function updateTrackDurationLabel(current = 0, duration = 0) {
        if (trackDurationEl) {
            trackDurationEl.textContent = `${formatTrackTime(current)} / ${formatTrackTime(duration)}`;
        }
    }

    function persistPlaybackPosition(force = false) {
        const user = getStoredUser();
        const track = getCurrentTrack();
        if (
            !user?._id
            || !track
            || (
                String(playbackActivityUserId || '') !== String(user._id)
                && currentTrackSource !== 'together'
            )
        ) return;
        const now = Date.now();
        if (!force && now - lastPlaybackPersistenceAt < 5000) return;
        lastPlaybackPersistenceAt = now;
        localStorage.setItem(`amgc-last-playback-${user._id}`, JSON.stringify({
            songId: track._id,
            currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0
        }));
    }

    function recordOfflineListeningProgress(track, currentTime, includePaused = false) {
        if ((!offlineOnly && navigator.onLine) || (!includePaused && audio.paused) || !track) {
            offlineListeningLastSample = null;
            return;
        }
        const now = performance.now();
        const sample = { trackId: String(track._id), currentTime, sampledAt: now };
        const previous = offlineListeningLastSample;
        if (previous?.trackId === sample.trackId) {
            const playbackDelta = currentTime - previous.currentTime;
            const wallDelta = Math.max(0, (now - previous.sampledAt) / 1000);
            if (playbackDelta > 0 && playbackDelta <= wallDelta + 1.5) {
                offlineListeningBuffer += playbackDelta;
            }
        }
        offlineListeningLastSample = sample;
        if (offlineListeningBuffer >= 5 || now - offlineListeningLastPersistAt >= 10000) {
            persistOfflineListeningBuffer();
        }
    }

    function updatePlaybackProgressFrame() {
        playbackUiFrame = null;
        updateProfileActivityProgress();
    }

    function createCurrentPlaybackSnapshot(isPlaying = !audio.paused) {
        const track = getCurrentTrack();
        if (!track) return null;
        return {
            songId: track._id,
            songName: track.name,
            artist: track.artist || '',
            cover: track.cover || '',
            color: track.color || '#ff8a00',
            currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : sharedPlaybackTime,
            duration: Number.isFinite(audio.duration) && audio.duration > 0
                ? audio.duration
                : Number(track.duration) || 0,
            isPlaying,
            shuffle: isShuffle,
            deviceId: playbackDeviceId,
            deviceType: playbackDeviceType,
            transferId: activePlaybackTransferUserId === String(getStoredUser()?._id || '')
                ? activePlaybackTransferId || undefined
                : undefined,
            updatedAt: new Date().toISOString()
        };
    }

    function broadcastPlaybackState(force = false) {
        if (isRestoringInitialPlayback || suppressStartupPlaybackUpdates || isActivatingPlaybackTransfer) return;
        const user = getStoredUser();
        const track = getCurrentTrack();
        if (
            !user?._id
            || !track
            || !socket.connected
            || (
                String(playbackActivityUserId || '') !== String(user._id)
                && !isFollowingPlayback()
            )
        ) return;
        const now = Date.now();
        if (!force && now - lastPlaybackBroadcastAt < 1000) return;
        lastPlaybackBroadcastAt = now;
        socket.emit('songChanged', {
            userId: user._id,
            excludeUserId: listeningTogetherUserId,
            playback: createCurrentPlaybackSnapshot()
        });
    }

    function friendStatusLabel(friend) {
        const playback = friend.lastPlayed;
        if (hasPlaybackEvidence(playback)) {
            const isListening = Boolean(friend.isOnline && playback?.isPlaying !== false);
            if (!isListening) {
                const lastHeard = getPlaybackLastHeardLabel(playback, false);
                return `Estaba escuchando${lastHeard ? ` · ${lastHeard}` : ''}`;
            }
            const duration = Number(playback?.duration) || 0;
            const progress = duration > 0
                ? ` · ${formatTrackTime(Number(playback.currentTime) || 0)} / ${formatTrackTime(duration)}`
                : '';
            return `Escuchando ${playbackDeviceIconMarkup(getPlaybackDeviceType(playback))}${progress}`;
        }
        if (friend.isOnline) return 'En línea';
        return `${friend.lastActive ? 'Desconectado · ' + timeAgo(friend.lastActive) : 'Desconectado'}`;
    }

    function renderFriendsSidebar() {
        if (!friendsSidebarList) return;
        friendsSidebarList.innerHTML = currentFriends.length
            ? currentFriends.map(friend => {
                const playback = friend.lastPlayed;
                const hasActivity = hasPlaybackEvidence(playback);
                const duration = Number(playback?.duration) || 0;
                const elapsed = Number(playback?.currentTime) || 0;
                const progress = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;
                const statusText = friend.isOnline
                    ? 'En línea'
                    : `${friend.lastActive ? '  ' + timeAgo(friend.lastActive) : ''}`;
                const isListening = Boolean(friend.isOnline && playback?.isPlaying !== false);
                const lastHeard = getPlaybackLastHeardLabel(playback, isListening);
                const playbackLabel = `${isListening ? 'Escuchando' : 'Estaba escuchando'}${lastHeard ? ` · ${lastHeard}` : ''} ${playbackDeviceIconMarkup(getPlaybackDeviceType(playback))}`;
                return `
                    <li class="friend-sidebar-item" data-friend-id="${escapeHtml(friend._id)}" data-friend-name="${escapeHtml(friend.username)}">
                        <img class="friend-sidebar-avatar" src="${escapeHtml(friend.profilePhoto || '/img/perrocorasongif.gif')}" alt="" loading="lazy" />
                        <div class="friend-sidebar-meta">
                            <span class="friend-sidebar-name">${escapeHtml(friend.username)}</span>
                            <span class="friend-sidebar-status">
                                <span class="friend-status-dot ${friend.isOnline ? 'online' : ''}"></span>
                                ${escapeHtml(statusText)}
                            </span>
                        </div>
                        ${hasActivity ? `
                            <div class="friend-sidebar-song" style="--profile-track-color: ${safeColor(playback.color)}">
                                <small>${playbackLabel}</small>
                                <strong>${escapeHtml(playback.songName)}</strong>
                                <small>${escapeHtml(playback.artist || '')}</small>
                                <div class="friend-sidebar-progress${duration > 0 ? '' : ' is-hidden'}">
                                    <span data-friend-progress style="width: ${progress}%"></span>
                                </div>
                                <small class="friend-sidebar-playback-time${duration > 0 ? '' : ' is-hidden'}" data-friend-playback-time>${formatTrackTime(elapsed)} / ${formatTrackTime(duration)}</small>
                            </div>` : ''}
                    </li>
                `;
            }).join('')
            : '<li class="friend-sidebar-item"><span class="friend-sidebar-name">Sin amigos todavía</span></li>';

        friendsSidebarList.querySelectorAll('.friend-sidebar-item[data-friend-id]').forEach(item => {
            item.addEventListener('click', () => openFriendProfile(item.dataset.friendId));
        });
    }

    function renderFriendsPanelList() {
        if (!friendsList) return;
        friendsList.innerHTML = currentFriends.length
            ? currentFriends.map(friend => `
                <li class="friend-item" data-friend-id="${escapeHtml(friend._id)}" data-friend-name="${escapeHtml(friend.username)}">
                    <button type="button" class="friend-name-button">${escapeHtml(friend.username)}</button>
                    <span class="friend-status-label">
                        <span class="friend-status-dot ${friend.isOnline ? 'online' : ''}"></span>
                        ${friendStatusLabel(friend)}
                    </span>
                </li>
            `).join('')
            : '<li class="friend-item">Todavía no tienes amigos.</li>';

        friendsList.querySelectorAll('.friend-name-button').forEach(button => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                openFriendProfile(button.closest('.friend-item')?.dataset.friendId);
            });
        });

    }

    function openFriendProfile(friendId) {
        const friend = currentFriends.find(item => String(item._id) === String(friendId))
            || selectedProfileUser?.friends?.find(item => String(item._id) === String(friendId));
        if (!friend) {
            const current = getStoredUser();
            if (!friendId || (current?._id && String(current._id) === String(friendId))) {
                openProfile();
                return;
            }
            return;
        } else {
            selectedProfileUser = {
                ...friend,
                friends: Array.isArray(friend.friends) ? friend.friends : currentFriends,
                profilePhoto: friend.profilePhoto || ''
            };
        }
        publicProfilePlaylists = null;
        closeFriendsPanel();
        isProfileMode = true;
        isAllSongsMode = false;
        isLyricsMode = false;
        isPlaylistViewMode = false;
        isEditSongMode = false;
        isEditPlaylistMode = false;
        isSettingsMode = false;
        isAdminMode = false;
        renderProfile();
        updateBackgroundAndViews();
    }

    function renderProfileFriendsSection(friends = currentFriends, canRemoveFriends = !selectedProfileUser) {
        if (profileFriends) {
            profileFriends.innerHTML = friends.length
                ? friends.map(friend => `
                    <li data-friend-id="${escapeHtml(friend._id)}" data-friend-name="${escapeHtml(friend.username)}" class="profile-friend-mini-item">
                        <img class="profile-friend-mini-avatar" src="${escapeHtml(friend.profilePhoto || '/img/perrocorasongif.gif')}" alt="" loading="lazy" />
                        <span class="friend-status-dot ${friend.isOnline ? 'online' : ''}"></span>
                        <span>${escapeHtml(friend.username)}</span>
                        ${canRemoveFriends ? '<button type="button" class="profile-friend-remove-btn" aria-label="Eliminar amigo" title="Eliminar amigo">×</button>' : ''}
                    </li>
                `).join('')
                : '<li>Todavía no hay amigos.</li>';
            profileFriends.querySelectorAll('li[data-friend-id]').forEach(item => {
                item.addEventListener('click', event => {
                    if (event.target.closest('.profile-friend-remove-btn')) return;
                    openFriendProfile(item.dataset.friendId);
                });
                item.querySelector('.profile-friend-remove-btn')?.addEventListener('click', event => {
                    event.stopPropagation();
                    void removeFriend(item.dataset.friendId, item.dataset.friendName);
                });
            });
        }
        if (!profileFriendsGrid) return;
        if (!friends.length) {
            profileFriendsGrid.innerHTML = '<p class="profile-friends-empty">Todavía no hay amigos. Usá el botón "+" para agregar uno.</p>';
            return;
        }
        profileFriendsGrid.innerHTML = friends.map(friend => `
            <div class="profile-friend-card" data-friend-id="${escapeHtml(friend._id)}" data-friend-name="${escapeHtml(friend.username)}">
                <div class="profile-friend-avatar">
                    <img src="${escapeHtml(friend.profilePhoto || '/img/perrocorasongif.gif')}" alt="" loading="lazy" />
                    <span class="friend-status-dot ${friend.isOnline ? 'online' : ''}"></span>
                </div>
                <span class="profile-friend-name">${escapeHtml(friend.username)}</span>
                <span class="profile-friend-status">${friendStatusLabel(friend)}</span>
                <button type="button" class="profile-friend-chat-btn">Chatear</button>
                ${canRemoveFriends ? '<button type="button" class="profile-friend-remove-btn" aria-label="Eliminar amigo" title="Eliminar amigo">×</button>' : ''}
            </div>
        `).join('');

        profileFriendsGrid.querySelectorAll('.profile-friend-card').forEach(card => {
            card.addEventListener('click', (event) => {
                if (event.target.closest('.profile-friend-chat-btn')) return;
                openFriendProfile(card.dataset.friendId);
            });
            card.querySelector('.profile-friend-chat-btn')?.addEventListener('click', (event) => {
                event.stopPropagation();
                openChat(card.dataset.friendId, card.dataset.friendName);
            });
            card.querySelector('.profile-friend-remove-btn')?.addEventListener('click', event => {
                event.stopPropagation();
                void removeFriend(card.dataset.friendId, card.dataset.friendName);
            });
        });
    }

    function rememberFriendRealtimeUpdate(userId, update = {}) {
        const normalizedId = String(userId || '');
        if (!normalizedId) return;
        const previous = friendRealtimeUpdates.get(normalizedId);
        friendRealtimeUpdates.set(normalizedId, {
            receivedAt: performance.now(),
            updatedAt: update.updatedAt || update.lastPlayed?.updatedAt || previous?.updatedAt || null,
            playbackReceivedAt: update.lastPlayed
                ? performance.now()
                : previous?.playbackReceivedAt,
            ...(typeof update.isOnline === 'boolean'
                ? { isOnline: update.isOnline }
                : previous && { isOnline: previous.isOnline }),
            ...(update.lastPlayed
                ? { lastPlayed: update.lastPlayed }
                : previous?.lastPlayed && { lastPlayed: previous.lastPlayed })
        });
    }

    function scheduleFriendsOfflineSave() {
        const user = getStoredUser();
        if (!offlineModeEnabled || !user?._id) return;
        if (friendCacheSaveTimer) return;
        friendCacheSaveTimer = setTimeout(() => {
            friendCacheSaveTimer = null;
            saveOfflineFriends(user._id, currentFriends).catch(error => {
                console.error('No se pudo guardar la actividad de amigos para uso offline.', error);
            });
        }, 15000);
    }

    async function hydrateOfflineFriends(friends = []) {
        return Promise.all(friends.map(async friend => ({
            ...friend,
            profilePhoto: friend.profilePhoto
                ? await getOfflineImageUrl('friend', friend._id, 'photo', `friend:${friend._id}:photo`)
                : '',
            friends: await Promise.all((friend.friends || []).map(async nestedFriend => ({
                ...nestedFriend,
                profilePhoto: nestedFriend.profilePhoto
                    ? await getOfflineImageUrl('friend', nestedFriend._id, 'photo', `friend:${nestedFriend._id}:photo`)
                    : ''
            })))
        })));
    }

    async function loadFriends({ skipOfflineResourceSync = false } = {}) {
        const user = getStoredUser();
        if (!user) return;
        const requestedOwnerId = String(user._id);
        const requestSequence = ++friendsRequestSequence;
        if (friendsOwnerId !== requestedOwnerId) {
            currentFriends = [];
            friendRealtimeUpdates.clear();
            friendsOwnerId = requestedOwnerId;
        }
        if (offlineOnly || !navigator.onLine) {
            const offlineCacheProgress = offlineMediaManager.getProgress();
            if (offlineCacheProgress.completed === 0 && offlineCacheProgress.total === 0) {
                updateOfflineCacheStatus('La caché offline está vacía. Conéctate e inicia sesión para descargar el contenido.');
            }
            let cachedFriends;
            try {
                cachedFriends = await getOfflineFriends(user._id);
            } catch (error) {
                console.error('No se pudo leer la actividad offline de tus amigos.', error);
                updateOfflineCacheStatus(`No se pudo leer la actividad guardada: ${error.message}`);
                return;
            }
            if (
                String(getStoredUser()?._id || '') !== requestedOwnerId
                || requestSequence !== friendsRequestSequence
            ) return;
            currentFriends = await hydrateOfflineFriends(cachedFriends?.friends || []);
            if (requestSequence !== friendsRequestSequence) return;
            if (selectedProfileUser) {
                const refreshedFriend = currentFriends.find(friend => String(friend._id) === String(selectedProfileUser._id));
                if (refreshedFriend) {
                    selectedProfileUser = {
                        ...selectedProfileUser,
                        ...refreshedFriend,
                        profilePhoto: refreshedFriend.profilePhoto || selectedProfileUser.profilePhoto || ''
                    };
                }
            }
            renderFriendsSidebar();
            renderFriendsPanelList();
            if (isProfileMode) renderProfile();
            return;
        }
        const requestStartedAt = performance.now();
        try {
            const refreshedFriends = await fetchJsonWithRetry(`${API_URL}/users/friends/${user._id}`);
            if (
                String(getStoredUser()?._id || '') !== requestedOwnerId
                || requestSequence !== friendsRequestSequence
            ) return;
            currentFriends = refreshedFriends.map(friend => {
                const previousFriend = currentFriends.find(item => String(item._id) === String(friend._id));
                const friendId = String(friend._id);
                const realtimeUpdate = friendRealtimeUpdates.get(friendId);
                const hasFreshRealtimeUpdate = (realtimeUpdate?.receivedAt || 0) > requestStartedAt;
                const useRealtimePresence = typeof realtimeUpdate?.isOnline === 'boolean'
                    && (socket.connected || hasFreshRealtimeUpdate);
                const useRealtimePlayback = Boolean(
                    realtimeUpdate?.lastPlayed
                    && (socket.connected || hasFreshRealtimeUpdate)
                );
                return {
                    ...friend,
                    ...(useRealtimePresence && {
                        isOnline: realtimeUpdate.isOnline,
                        ...(realtimeUpdate.updatedAt && { lastActive: realtimeUpdate.updatedAt })
                    }),
                    ...((useRealtimePlayback || friend.lastPlayed || previousFriend?.lastPlayed) && {
                        lastPlayed: useRealtimePlayback
                            ? realtimeUpdate.lastPlayed
                            : friend.lastPlayed || previousFriend?.lastPlayed
                    }),
                    ...(previousFriend && {
                        ...(useRealtimePresence && !realtimeUpdate.updatedAt && previousFriend.lastActive
                            ? { lastActive: previousFriend.lastActive }
                            : {})
                    })
                };
            });
            currentFriends.forEach(friend => {
                const friendId = String(friend._id);
                if (
                    friend.lastPlayed
                    && (!friendRealtimeUpdates.get(friendId)?.lastPlayed || !socket.connected)
                ) {
                    rememberFriendRealtimeUpdate(friendId, {
                        isOnline: friend.isOnline,
                        lastPlayed: friend.lastPlayed,
                        updatedAt: friend.lastActive
                    });
                }
            });
            const refreshedFriendIds = new Set(currentFriends.map(friend => String(friend._id)));
            friendRealtimeUpdates.forEach((_update, friendId) => {
                if (!refreshedFriendIds.has(friendId)) friendRealtimeUpdates.delete(friendId);
            });
            if (offlineModeEnabled) {
                try {
                    await saveOfflineFriends(user._id, currentFriends);
                } catch (error) {
                    console.error('No se pudo guardar la lista de amigos offline.', error);
                    updateOfflineCacheStatus(`No se pudo guardar la actividad de amigos: ${error.message}`);
                }
            }
        } catch (e) {
            console.warn(e);
            if (
                String(getStoredUser()?._id || '') !== requestedOwnerId
                || requestSequence !== friendsRequestSequence
            ) return;
            if (!offlineModeEnabled) return;
            let cachedFriends;
            try {
                cachedFriends = await getOfflineFriends(user._id);
            } catch (cacheError) {
                console.error('No se pudo leer la actividad offline de tus amigos.', cacheError);
                updateOfflineCacheStatus(`No se pudo leer la actividad guardada: ${cacheError.message}`);
                return;
            }
            if (
                String(getStoredUser()?._id || '') !== requestedOwnerId
                || requestSequence !== friendsRequestSequence
            ) return;
            if (!cachedFriends) return;
            offlineOnly = true;
            syncOfflineStatusIndicators();
            socket.disconnect();
            startOfflineRecoveryTimer();
            const cachedUser = getCachedOfflineUser();
            if (cachedUser) setStoredUser(cachedUser);
            currentFriends = await hydrateOfflineFriends(cachedFriends.friends || []);
            if (requestSequence !== friendsRequestSequence) return;
        }
        if (String(getStoredUser()?._id || '') !== requestedOwnerId) return;
        if (
            listeningTogetherUserId
            && !currentFriends.some(friend => String(friend._id) === String(listeningTogetherUserId))
        ) {
            stopFollowingRemovedFriend();
        }
        if (selectedProfileUser) {
            const refreshedFriend = currentFriends.find(friend => String(friend._id) === String(selectedProfileUser._id));
            if (refreshedFriend) {
                selectedProfileUser = {
                    ...selectedProfileUser,
                    ...refreshedFriend,
                    profilePhoto: refreshedFriend.profilePhoto || selectedProfileUser.profilePhoto || ''
                };
            }
        }
        renderFriendsSidebar();
        renderFriendsPanelList();
        updateFriendsSidebarPlayback();
        refreshChatNotifications();
        if (isProfileMode) {
            if (selectedProfileUser) renderProfile();
            else renderProfileFriendsSection();
        }
        if (!skipOfflineResourceSync) syncOfflineResources();
    }

    async function addFriend() {
        const user = getStoredUser();
        const friendUsername = inputAddFriend?.value.trim();
        if (!user || !friendUsername) return;
        try {
            const res = await apiFetch(`${API_URL}/users/friends/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: user._id, friendUsername })
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result?.error || 'No se pudo agregar al amigo');
            inputAddFriend.value = '';
            await loadFriends();
        } catch (e) {
            showToast(e.message || 'No se pudo agregar al amigo', true);
        }
    }

    async function removeFriend(friendId, friendName = 'este amigo') {
        if (!friendId || !window.confirm(`¿Eliminar a ${friendName} de tus amigos?`)) return;
        try {
            const response = await apiFetch(`${API_URL}/users/friends/${encodeURIComponent(friendId)}`, {
                method: 'DELETE'
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result?.error || 'No se pudo eliminar al amigo.');
            if (String(activeChatFriendId || '') === String(friendId)) closeChat();
            await loadFriends();
            showToast(`${friendName} se eliminó de tus amigos.`);
        } catch (error) {
            showToast(error.message || 'No se pudo eliminar al amigo.', true);
        }
    }

    function openFriendsPanel() {
        if (!friendsPanel) return;
        friendsPanel.classList.add('active');
        friendsPanel.setAttribute('aria-hidden', 'false');
    }

    function closeFriendsPanel() {
        if (!friendsPanel) return;
        friendsPanel.classList.remove('active');
        friendsPanel.setAttribute('aria-hidden', 'true');
    }

    function scrollChatToBottom() {
        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function chatDraftsKey(userId, friendId) {
        return `amgc-chat-drafts-${userId}-${friendId}`;
    }

    function readLocalChatMessages(userId, friendId) {
        try {
            const messages = JSON.parse(localStorage.getItem(chatDraftsKey(userId, friendId)) || '[]');
            return Array.isArray(messages) ? messages : [];
        } catch {
            return [];
        }
    }

    function saveLocalChatMessages(userId, friendId) {
        const drafts = localChatMessages.filter(message => ['enviando', 'fallido'].includes(message.status));
        if (drafts.length) localStorage.setItem(chatDraftsKey(userId, friendId), JSON.stringify(drafts));
        else localStorage.removeItem(chatDraftsKey(userId, friendId));
    }

    function updateStoredChatDraft(userId, friendId, localId, status) {
        const drafts = readLocalChatMessages(userId, friendId)
            .map(message => message._localId === localId ? { ...message, status } : message)
            .filter(message => ['enviando', 'fallido'].includes(message.status));
        const storageKey = chatDraftsKey(userId, friendId);
        if (drafts.length) localStorage.setItem(storageKey, JSON.stringify(drafts));
        else localStorage.removeItem(storageKey);
    }

    function formatMessageDate(value) {
        const date = new Date(value);
        const now = new Date();
        const chileOptions = { timeZone: 'America/Santiago' };
        const time = date.toLocaleTimeString('es-CL', { ...chileOptions, hour: '2-digit', minute: '2-digit' });
        const sameDay = date.toLocaleDateString('es-CL', chileOptions) === now.toLocaleDateString('es-CL', chileOptions);
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        if (sameDay) return time;
        if (date.toLocaleDateString('es-CL', chileOptions) === yesterday.toLocaleDateString('es-CL', chileOptions)) return `ayer a las ${time}`;
        return `${date.toLocaleDateString('es-CL', chileOptions)} a las ${time}`;
    }

    function renderChatMessages(messages, user, forceScrollToBottom = false) {
        const previousScrollTop = chatMessages.scrollTop;
        const wasNearBottom = chatMessages.scrollHeight - previousScrollTop - chatMessages.clientHeight < 24;
        const serverMessages = messages.map(message => ({
            ...message,
            status: String(message.sender) === String(user._id) ? (message.readAt ? 'visto' : 'enviado') : undefined
        }));
        const pendingMessages = localChatMessages.filter(message => ['enviando', 'fallido'].includes(message.status));
        const getMessageDisplayTime = message => {
            const clientId = message.clientId || message._localId;
            const optimisticTimestamp = clientId ? chatMessageDisplayTimes.get(clientId) : null;
            return optimisticTimestamp
                ?? chatMessageDisplayTimes.get(String(message._id || ''))
                ?? new Date(message.timestamp).getTime();
        };
        const allMessages = [...serverMessages, ...pendingMessages].sort((a, b) => (
            getMessageDisplayTime(a) - getMessageDisplayTime(b)
            || new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            || String(a.clientId || a._localId || a._id).localeCompare(String(b.clientId || b._localId || b._id))
        ));
        let previousSenderId = null;
        let lastOwnMessageIndex = -1;
        allMessages.forEach((message, index) => {
            if (String(message.sender) === String(user._id)) lastOwnMessageIndex = index;
        });
        chatMessages.innerHTML = allMessages.length
            ? allMessages.map((message, index) => {
                const messageIndex = index;
                const isSelf = String(message.sender) === String(user._id);
                const friend = currentFriends.find(item => String(item._id) === String(message.sender));
                const senderId = String(message.sender);
                const avatar = senderId !== previousSenderId
                    ? `<img class="chat-message-avatar" src="${escapeHtml(isSelf ? (user.profilePhoto || '/img/perrocorasongif.gif') : (friend?.profilePhoto || '/img/perrocorasongif.gif'))}" alt="" />`
                    : '';
                previousSenderId = senderId;
                const status = isSelf && message.status && messageIndex === lastOwnMessageIndex
                    ? `<span class="chat-message-status ${message.status}">${message.status}</span>`
                    : '';
                return `
                    <div class="chat-message ${isSelf ? 'self' : ''} ${message.type === 'playlist_invitation' ? 'playlist-invitation-message' : ''}">
                        <div class="chat-message-row">
                            <div class="chat-message-content">
                                ${avatar}
                                <div class="chat-message-body">
                                    <span>${escapeHtml(message.content)}</span>
                                    ${message.type === 'playlist_invitation' && message.invitationStatus === 'pending' && String(message.receiver) === String(user._id) ? `
                                        <div class="playlist-invitation-actions">
                                            <button type="button" data-invitation-action="accept" data-message-id="${message._id}">Guardar playlist</button>
                                            <button type="button" data-invitation-action="decline" data-message-id="${message._id}">Rechazar</button>
                                        </div>` : ''}
                                    <span class="chat-time">${formatMessageDate(message.timestamp)} ${status}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('')
            : '<div class="chat-message">Todavía no hay mensajes.</div>';
        if (forceScrollToBottom || wasNearBottom) scrollChatToBottom();
        else chatMessages.scrollTop = previousScrollTop;
        chatMessages.querySelectorAll('[data-invitation-action]').forEach(button => {
            button.addEventListener('click', async () => {
                const accept = button.dataset.invitationAction === 'accept';
                button.disabled = true;
                try {
                    const response = await apiFetch(`${API_URL}/playlists/invitations/${button.dataset.messageId}/respond`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: user._id, accept })
                    });
                    const result = await response.json().catch(() => null);
                    if (!response.ok) throw new Error(result?.error || 'No se pudo responder la invitación');
                    await loadPlaylists();
                    await loadChatMessages(false);
                } catch (error) {
                    button.disabled = false;
                    showToast(error.message || 'No se pudo responder la invitación', true);
                }
            });
        });
    }

    async function loadChatMessages(forceScrollToBottom = false) {
        const user = getStoredUser();
        const friendId = activeChatFriendId;
        if (!user || !friendId || !chatMessages) return;
        const requestSequence = ++chatMessagesRequestSequence;
        if (offlineOnly || !navigator.onLine) {
            chatMessages.textContent = 'Los mensajes estarán disponibles cuando vuelvas a conectarte.';
            return;
        }
        try {
            const messages = await fetchJsonWithRetry(`${API_URL}/messages/${user._id}/${friendId}`);
            if (requestSequence !== chatMessagesRequestSequence || String(activeChatFriendId) !== String(friendId)) return;
            serverChatMessages = messages;
            refreshChatNotifications();
            const serverClientIds = new Set(messages.map(message => String(message.clientId || '')).filter(Boolean));
            const serverKeys = new Set(messages.map(message => `${message.content}|${message.sender}`));
            localChatMessages = localChatMessages.filter(message => (
                ['enviando', 'fallido'].includes(message.status)
                && !serverClientIds.has(String(message.clientId || ''))
                && (message.clientId || !serverKeys.has(`${message.content}|${message.sender}`))
            ));
            saveLocalChatMessages(user._id, activeChatFriendId);
            renderChatMessages(messages, user, forceScrollToBottom);
        } catch (e) {
            console.warn(e);
        }
    }

    function openChat(friendId, friendName) {
        if (!friendId) return;
        activeChatFriendId = friendId;
        annoyedFriendIds.delete(String(friendId));
        refreshChatNotifications();
        activeChatFriendName = friendName || 'Amigo';
        const friend = currentFriends.find(item => String(item._id) === String(friendId));
        if (chatHeaderAvatar) {
            const headerImage = chatHeaderAvatar.querySelector('img');
            if (headerImage) headerImage.src = friend?.profilePhoto || '/img/perrocorasongif.gif';
            chatHeaderAvatar.hidden = false;
        }
        localChatMessages = readLocalChatMessages(getStoredUser()?._id, friendId);
        serverChatMessages = [];
        localStorage.setItem(`amgc-chat-read-${friendId}`, new Date().toISOString());
        if (chatTitle) chatTitle.textContent = `${activeChatFriendName}`;
        if (chatTitleStatus) {
            chatTitleStatus.hidden = false;
            chatTitleStatus.classList.toggle('online', Boolean(friend?.isOnline));
        }
        if (btnChatBack) btnChatBack.hidden = false;
        if (chatModal) chatModal.classList.add('active');
        if (chatFriendsView) chatFriendsView.hidden = true;
        if (chatConversationView) chatConversationView.hidden = false;
        loadChatMessages(true);
        if (chatPollTimer) clearInterval(chatPollTimer);
        chatPollTimer = offlineOnly || !navigator.onLine
            ? null
            : setInterval(() => loadChatMessages(false), 30000);
    }

    function closeChat() {
        chatMessagesRequestSequence += 1;
        if (chatModal) chatModal.classList.remove('active');
        if (chatFriendsView) chatFriendsView.hidden = false;
        if (chatConversationView) chatConversationView.hidden = true;
        if (chatTitle) chatTitle.textContent = 'CHAT';
        if (chatTitleStatus) chatTitleStatus.hidden = true;
        if (btnChatBack) btnChatBack.hidden = true;
        if (chatHeaderAvatar) chatHeaderAvatar.hidden = true;
        activeChatFriendId = null;
        if (chatPollTimer) {
            clearInterval(chatPollTimer);
            chatPollTimer = null;
        }
    }

    async function sendChatMessage() {
        const user = getStoredUser();
        const receiverId = activeChatFriendId;
        const content = chatInput?.value.trim();
        if (!user || !receiverId || !content) return;
        chatInput.value = '';
        const clientId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timestamp = new Date().toISOString();
        lastChatMessageOrderTime = Math.max(Date.now(), lastChatMessageOrderTime + 1);
        const localMessage = {
            _localId: clientId,
            clientId,
            sender: user._id,
            receiver: receiverId,
            content,
            timestamp,
            status: 'enviando'
        };
        chatMessageDisplayTimes.set(clientId, lastChatMessageOrderTime);
        if (chatMessageDisplayTimes.size > 500) {
            chatMessageDisplayTimes.delete(chatMessageDisplayTimes.keys().next().value);
        }
        localChatMessages.push(localMessage);
        saveLocalChatMessages(user._id, receiverId);
        renderChatMessages(serverChatMessages, user);
        const send = async () => {
            try {
                const response = await apiFetch(`${API_URL}/messages`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sender: user._id,
                        receiver: receiverId,
                        content,
                        clientId: localMessage.clientId
                    })
                });
                const result = await response.json().catch(() => null);
                if (!response.ok || !result?._id) throw new Error(result?.error || 'No se pudo enviar el mensaje');
                const acknowledgedMessage = { ...result, clientId: result.clientId || localMessage.clientId };
                chatMessageDisplayTimes.set(String(acknowledgedMessage._id), chatMessageDisplayTimes.get(localMessage.clientId));
                updateStoredChatDraft(user._id, receiverId, localMessage._localId, 'enviado');
                if (String(activeChatFriendId) !== String(receiverId)) return;
                localChatMessages = localChatMessages.filter(message => message._localId !== localMessage._localId);
                saveLocalChatMessages(user._id, receiverId);
                if (!serverChatMessages.some(message => String(message._id) === String(acknowledgedMessage._id))) {
                    serverChatMessages = [...serverChatMessages, acknowledgedMessage];
                }
                renderChatMessages(serverChatMessages, user);
            } catch (error) {
                localMessage.status = 'fallido';
                updateStoredChatDraft(user._id, receiverId, localMessage._localId, 'fallido');
                if (String(activeChatFriendId) === String(receiverId)) {
                    localChatMessages = localChatMessages.map(message => (
                        message._localId === localMessage._localId ? localMessage : message
                    ));
                    renderChatMessages(serverChatMessages, user);
                }
                console.warn('No se pudo enviar el mensaje', error);
            }
        };
        const previousSend = chatSendQueues.get(String(receiverId)) || Promise.resolve();
        const queuedSend = previousSend.catch(() => {}).then(send);
        chatSendQueues.set(String(receiverId), queuedSend);
        await queuedSend;
        if (chatSendQueues.get(String(receiverId)) === queuedSend) chatSendQueues.delete(String(receiverId));
    }

    function stopPlaybackStatusSync() {
        if (playbackStatusSyncTimer) {
            clearInterval(playbackStatusSyncTimer);
            playbackStatusSyncTimer = null;
        }
    }

    function startPlaybackStatusSync() {
        stopPlaybackStatusSync();
        const user = getStoredUser();
        if (!user?._id || !getCurrentTrack() || audio.paused) return;
        playbackStatusSyncTimer = setInterval(() => {
            const activeUser = getStoredUser();
            const currentTrack = getCurrentTrack();
            if (
                !activeUser?._id
                || !currentTrack
                || audio.paused
                || (
                    String(playbackActivityUserId || '') !== String(activeUser._id)
                    && !isFollowingPlayback()
                )
            ) {
                stopPlaybackStatusSync();
                return;
            }
            updateUserStatus(true);
        }, 15000);
    }

    async function updateUserStatus(isOnline) {
        if (isRestoringInitialPlayback || suppressStartupPlaybackUpdates || isActivatingPlaybackTransfer) return;
        const user = getStoredUser();
        if (!user) return;
        const track = getCurrentTrack();
        const payload = { userId: user._id, isOnline };
        if (
            track
            && isOnline
            && (
                String(playbackActivityUserId || '') === String(user._id)
                || isFollowingPlayback()
            )
        ) {
            payload.lastPlayed = {
                ...createCurrentPlaybackSnapshot(sharedPlaybackPlaying),
                countListeningDelta: isFollowingPlayback() || !suppressNextListeningDelta
            };
        }
        try {
            const response = await apiFetch(`${API_URL}/users/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error(`No se pudo actualizar la actividad (${response.status}).`);
            if (payload.lastPlayed?.countListeningDelta === false) suppressNextListeningDelta = false;
            if (payload.lastPlayed && !playbackOwnerConfirmed && socket.connected) {
                socket.emit('playbackStateRequest', { deviceId: playbackDeviceId, deviceType: playbackDeviceType });
            }
        } catch (e) {
            console.warn(e);
        }
    }

    function startRealtime() {
        stopRealtime();
        const user = getStoredUser();
        if (user?._id) connectRealtime();
        const handleFriendPlayback = ({ userId, playback } = {}) => {
            if (!userId || !playback) return;
            if (String(userId) === String(listeningTogetherUserId || '')) {
                listeningTogetherAwaitingFreshPlayback = false;
                if (!sharedQueueSessionId && !sharedQueueJoinPending && socket.connected) {
                    joinListenTogetherQueue(userId, true);
                }
            }
            rememberFriendRealtimeUpdate(userId, { isOnline: true, lastPlayed: playback });
            const friend = currentFriends.find(item => String(item._id) === String(userId));
            if (!friend) return;
            const previousPlayback = friend.lastPlayed;
            const wasOnline = friend.isOnline;
            const playbackDetailsChanged = String(previousPlayback?.songId || '') !== String(playback.songId || '')
                || previousPlayback?.songName !== playback.songName
                || previousPlayback?.artist !== playback.artist
                || previousPlayback?.cover !== playback.cover
                || previousPlayback?.color !== playback.color
                || previousPlayback?.deviceType !== playback.deviceType
                || Number(previousPlayback?.duration) !== Number(playback.duration)
                || previousPlayback?.isPlaying !== playback.isPlaying
                || !wasOnline;
            friend.lastPlayed = playback;
            friend.isOnline = true;
            scheduleFriendsOfflineSave();
            if (playbackDetailsChanged) {
                renderFriendsSidebar();
                renderFriendsPanelList();
            }
            updateFriendsSidebarPlayback();
            if (selectedProfileUser && String(selectedProfileUser._id) === String(userId)) {
                selectedProfileUser = { ...selectedProfileUser, lastPlayed: friend.lastPlayed, isOnline: true };
                const playbackIdentityChanged = String(previousPlayback?.songId || '') !== String(friend.lastPlayed?.songId || '')
                    || previousPlayback?.isPlaying !== friend.lastPlayed?.isPlaying
                    || !wasOnline;
                if (playbackIdentityChanged) renderProfile();
                else updateProfileActivityProgress();
            }
        };
        socket.off('playbackOwnerChanged').on('playbackOwnerChanged', handleOwnPlaybackUpdate);
        socket.off('playbackDevicesChanged').on('playbackDevicesChanged', ({ userId, devices } = {}) => {
            if (
                String(userId || '') !== String(getStoredUser()?._id || '')
                || !Array.isArray(devices)
            ) return;
            connectedPlaybackDevices = devices.filter(device => (
                typeof device?.deviceId === 'string'
                && ['mobile', 'desktop', 'unknown'].includes(device.deviceType)
            ));
            updatePlaybackDevicePickerIcons();
            renderPlaybackDevicePicker();
            renderSharedPlaybackStatus();
            syncAccountQueue();
        });
        socket.off('playbackTransferCommand').on('playbackTransferCommand', activateTransferredPlayback);
        socket.off('playbackControlCommand').on('playbackControlCommand', async (command = {}, acknowledge = () => {}) => {
            const acknowledgeResult = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!getCurrentTrack()) {
                acknowledgeResult({ success: false, error: 'No hay una canción cargada en este dispositivo.' });
                return;
            }
            if (command.action === 'toggle') {
                btnPlayPause.click();
            } else if (command.action === 'next') {
                btnNext.click();
            } else if (command.action === 'previous') {
                btnPrev.click();
            } else if (command.action === 'seek' && Number.isFinite(Number(command.position))) {
                const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number.MAX_SAFE_INTEGER;
                audio.currentTime = Math.min(duration, Math.max(0, Number(command.position)));
                sharedPlaybackTime = audio.currentTime;
                broadcastPlaybackState(true);
                void updateUserStatus(true);
            } else if (command.action === 'shuffle') {
                btnShuffle.click();
            } else if (command.action === 'playTrack') {
                const trackIndex = playlist.findIndex(track => String(track._id) === String(command.songId));
                if (trackIndex < 0) {
                    acknowledgeResult({ success: false, error: 'La canción solicitada no está disponible en esta biblioteca.' });
                    return;
                }
                const loaded = await loadAndPlayTrack(trackIndex);
                if (!loaded) {
                    acknowledgeResult({ success: false, error: 'No se pudo iniciar la canción solicitada.' });
                    return;
                }
            } else {
                acknowledgeResult({ success: false, error: 'El control remoto solicitado no es válido.' });
                return;
            }
            acknowledgeResult({ success: true });
        });
        socket.off('playbackHandoffRequest').on('playbackHandoffRequest', (request = {}, acknowledge = () => {}) => {
            const acknowledgeResult = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!getCurrentTrack()) {
                acknowledgeResult({ success: false, error: 'No hay una canción cargada para transferir.' });
                return;
            }
            const wasPlaying = !audio.paused;
            if (wasPlaying) {
                suppressRemotePlaybackPause = true;
                audio.pause();
            }
            sharedPlaybackTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
            sharedPlaybackDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
            sharedPlaybackPlaying = false;
            stopPlaybackStatusSync();
            const playback = createCurrentPlaybackSnapshot(false);
            broadcastPlaybackState(true);
            void updateUserStatus(true);
            acknowledgeResult({ success: true, playback, requesterDeviceId: request.requesterDeviceId });
        });
        socket.off('songChanged').on('songChanged', handleFriendPlayback);
        socket.off('playbackStatusChanged').on('playbackStatusChanged', handleFriendPlayback);
        if (socket.connected) {
            socket.emit('playbackStateRequest', { deviceId: playbackDeviceId, deviceType: playbackDeviceType });
        }
        socket.off('playlistChanged').on('playlistChanged', ({ playlistId, deleted, changedBy } = {}) => {
            if (String(changedBy || '') === String(getStoredUser()?._id || '')) return;
            playlistRealtimeRefresh = playlistRealtimeRefresh.then(async () => {
                await loadPlaylists();
                if (isPlaylistViewMode && activePlaylistId === playlistId) {
                    if (deleted) {
                        activePlaylistId = null;
                        isPlaylistViewMode = false;
                        updateBackgroundAndViews();
                    } else {
                        openPlaylistView(activePlaylistId);
                    }
                }
                renderProfile();
            }).catch(error => console.warn('No se pudo actualizar la playlist en tiempo real', error));
        });
        socket.off('messageReceived').on('messageReceived', ({ message } = {}) => {
            if (!message) return;
            refreshChatNotifications();
            playMessageNotification();
            const ownUserId = String(getStoredUser()?._id || '');
            if (activeChatFriendId && (
                String(message.sender) === String(activeChatFriendId)
                || (String(message.sender) === ownUserId && String(message.receiver) === String(activeChatFriendId))
            )) {
                loadChatMessages(false);
            } else {
                if (unreadMessageIndicator) unreadMessageIndicator.hidden = false;
            }
        });
        socket.off('messageSent').on('messageSent', ({ message } = {}) => {
            const ownUserId = String(getStoredUser()?._id || '');
            if (
                message
                && activeChatFriendId
                && String(message.sender) === ownUserId
                && String(message.receiver) === String(activeChatFriendId)
            ) {
                loadChatMessages(false);
            }
        });
        socket.off('messageUpdated').on('messageUpdated', () => {
            refreshChatNotifications();
            if (activeChatFriendId) loadChatMessages(false);
        });
        socket.off('messagesRead').on('messagesRead', ({ readerId } = {}) => {
            if (activeChatFriendId && String(activeChatFriendId) === String(readerId)) {
                loadChatMessages(false);
            }
        });
        socket.off('listenTogetherQueueSessionStarted').on('listenTogetherQueueSessionStarted', ({
            sessionId,
            peerId,
            jamActive = false,
            songIds = [],
            upcomingSongIds = [],
            revision = 0,
            queueName = 'GENERAL'
        } = {}) => {
            if (!sessionId || !peerId) return;
            sharedQueueSessionId = String(sessionId);
            sharedQueueRole = 'host';
            lastSharedQueueSnapshot = null;
            sharedQueueSnapshotRevision = Number(revision) || 0;
            sharedQueueIds = Array.isArray(songIds) ? songIds.map(String) : [];
            sharedQueueUpcomingIds = Array.isArray(upcomingSongIds) ? upcomingSongIds.map(String) : [];
            sharedQueueHostQueueName = typeof queueName === 'string' && queueName.trim()
                ? queueName.trim()
                : 'GENERAL';
            sharedQueueJamActive = Boolean(jamActive);
            hostJamRequestId = null;
            if (sharedQueueJamActive) {
                applyJamQueue(sharedQueueIds, { hostCommand: true });
                applyJamUpcomingQueue(sharedQueueUpcomingIds, { hostCommand: true });
                sharedQueueSavedLocalQueue = null;
                return;
            }
            renderQueue();
        });
        socket.off('listenTogetherQueueSnapshotRequest').on('listenTogetherQueueSnapshotRequest', ({ sessionId } = {}) => {
            if (
                sharedQueueRole !== 'host'
                || String(sessionId || '') !== String(sharedQueueSessionId || '')
            ) return;
            renderQueue();
        });
        socket.off('listenTogetherQueueSnapshot').on('listenTogetherQueueSnapshot', ({
            sessionId,
            revision,
            songIds,
            upcomingSongIds = [],
            queueName = sharedQueueHostQueueName
        } = {}) => {
            if (
                String(sessionId || '') !== String(sharedQueueSessionId || '')
                || !Number.isInteger(revision)
                || revision <= sharedQueueSnapshotRevision
                || !Array.isArray(songIds)
                || !Array.isArray(upcomingSongIds)
            ) return;
            sharedQueueSnapshotRevision = revision;
            sharedQueueIds = songIds.map(String);
            sharedQueueUpcomingIds = upcomingSongIds.map(String);
            sharedQueueHostQueueName = typeof queueName === 'string' && queueName.trim()
                ? queueName.trim()
                : 'GENERAL';
            if (sharedQueueRole === 'host') return;
            if (sharedQueueRole !== 'follower') return;
            if (sharedQueueJamPendingUpcomingIds) {
                if (sharedQueueJamPendingUpcomingIds.join(',') === sharedQueueUpcomingIds.join(',')) {
                    sharedQueueJamPendingUpcomingIds = null;
                    sharedQueueJamUpdateInFlight = false;
                }
                renderQueue({ syncAccount: false });
                return;
            }
            renderQueue();
        });
        socket.off('listenTogetherJamRequestReceived').on('listenTogetherJamRequestReceived', ({
            sessionId,
            requestId,
            followerId
        } = {}) => {
            if (String(sessionId || '') !== String(sharedQueueSessionId || '')) return;
            showJamRequestNotification(requestId, followerId);
        });
        socket.off('listenTogetherJamRequestClosed').on('listenTogetherJamRequestClosed', ({
            sessionId,
            requestId,
            reason
        } = {}) => {
            if (String(sessionId || '') !== String(sharedQueueSessionId || '')) return;
            if (sharedQueueJamRequestId === String(requestId || '')) {
                sharedQueueJamRequestPending = false;
                sharedQueueJamRequestId = null;
                renderJamControls();
                if (reason === 'expired') showToast('La solicitud de Jam venció sin respuesta.', true);
            }
            closeJamRequestNotification(requestId);
        });
        socket.off('listenTogetherJamState').on('listenTogetherJamState', ({
            sessionId,
            requestId,
            active,
            accepted,
            songIds,
            upcomingSongIds = [],
            revision,
            queueName = sharedQueueHostQueueName
        } = {}) => {
            if (String(sessionId || '') !== String(sharedQueueSessionId || '')) return;
            if (requestId && sharedQueueJamRequestId === String(requestId)) {
                sharedQueueJamRequestPending = false;
                sharedQueueJamRequestId = null;
            }
            if (!accepted) {
                sharedQueueJamActive = false;
                closeJamRequestNotification(requestId);
                renderJamControls();
                updateListeningTogetherControls();
                if (sharedQueueRole === 'follower') {
                    showToast('El anfitrión rechazó la propuesta de Jam.', true);
                }
                return;
            }
            sharedQueueJamActive = Boolean(active);
            sharedQueueJamUpdateInFlight = false;
            sharedQueueJamPendingUpcomingIds = null;
            sharedQueueSnapshotRevision = Number(revision) || sharedQueueSnapshotRevision;
            sharedQueueHostQueueName = typeof queueName === 'string' && queueName.trim()
                ? queueName.trim()
                : 'GENERAL';
            if (sharedQueueJamActive) {
                sharedQueueIds = Array.isArray(songIds) ? songIds.map(String) : [];
                sharedQueueUpcomingIds = Array.isArray(upcomingSongIds) ? upcomingSongIds.map(String) : [];
                const applied = applyJamQueue(songIds || [], { hostCommand: sharedQueueRole === 'host' });
                const upcomingApplied = applyJamUpcomingQueue(upcomingSongIds, {
                    hostCommand: sharedQueueRole === 'host'
                });
                if (!applied || !upcomingApplied) {
                    showToast('No se pudo preparar la cola de la Jam; revisa que las canciones estén cargadas.', true);
                    return;
                }
                if (sharedQueueRole === 'host') sharedQueueSavedLocalQueue = null;
                showToast(sharedQueueRole === 'host'
                    ? 'Jam iniciada; la cola y la reproducción se comparten.'
                    : 'Jam aceptada; puedes controlar la reproducción y editar «A continuación».');
            }
            closeJamRequestNotification(requestId);
            renderJamControls();
            updateListeningTogetherControls();
        });
        socket.off('listenTogetherJamQueueReplaceCommand').on('listenTogetherJamQueueReplaceCommand', ({
            sessionId,
            requestId,
            revision,
            songIds
        } = {}, acknowledge = () => {}) => {
            if (
                sharedQueueRole !== 'host'
                || !sharedQueueJamActive
                || String(sessionId || '') !== String(sharedQueueSessionId || '')
                || revision !== sharedQueueSnapshotRevision
            ) {
                acknowledge({ success: false, error: 'La Jam cambió; vuelve a sincronizar la cola.' });
                return;
            }
            const success = applyJamUpcomingQueue(songIds, { hostCommand: true });
            acknowledge(success
                ? { success: true, requestId }
                : { success: false, error: 'La cola contiene canciones no disponibles en el dispositivo anfitrión.' });
        });
        socket.off('listenTogetherJamPlaybackCommand').on('listenTogetherJamPlaybackCommand', async ({
            sessionId,
            action,
            songId,
            queueKind = 'source'
        } = {}, acknowledge = () => {}) => {
            if (
                sharedQueueRole !== 'host'
                || !sharedQueueJamActive
                || String(sessionId || '') !== String(sharedQueueSessionId || '')
            ) {
                acknowledge({ success: false, error: 'La Jam ya no está activa en el anfitrión.' });
                return;
            }
            try {
                if (action === 'playTrack') {
                    const requestedTrackId = String(songId || '');
                    const currentTrackId = getTrackStorageId(getCurrentTrack());
                    const targetQueue = queueKind === 'upcoming' ? customQueue : activeQueueTracks;
                    const queuePosition = targetQueue.findIndex(track => (
                        getTrackStorageId(track) === requestedTrackId
                    ));
                    const trackIndex = playlist.findIndex(track => (
                        String(track._id || track.id) === requestedTrackId
                    ));
                    if (queuePosition < 0 || trackIndex < 0) {
                        acknowledge({ success: false, error: 'La canción ya no está en la cola de la Jam.' });
                        return;
                    }
                    if (requestedTrackId === currentTrackId) {
                        acknowledge({ success: true });
                        return;
                    }
                    if (getCurrentTrack()) {
                        playbackHistory.push({ index: currentTrackIndex, source: currentTrackSource });
                    }
                    const started = await (queueKind === 'upcoming'
                        ? playUpcomingQueueTrack(queuePosition)
                        : loadAndPlayTrack(trackIndex, 'regular'));
                    renderQueue();
                    acknowledge(started === false
                        ? { success: false, error: 'No se pudo reproducir la canción en el anfitrión.' }
                        : { success: true });
                    return;
                }
                if (action === 'next') playNextTrack();
                else if (action === 'previous') btnPrev?.click();
                else if (action === 'pause') audio.pause();
                else if (action === 'play') await audio.play();
                else {
                    acknowledge({ success: false, error: 'Control de reproducción no válido.' });
                    return;
                }
                acknowledge({ success: true });
            } catch (error) {
                console.error('No se pudo aplicar un control remoto de Jam.', error);
                acknowledge({ success: false, error: error.message || 'No se pudo controlar la reproducción.' });
            }
        });
        socket.off('accountQueueSnapshot').on('accountQueueSnapshot', ({
            revision,
            songIds,
            sourceSongIds,
            queueName
        } = {}) => {
            if (!Number.isInteger(revision) || revision < accountQueueRevision || !Array.isArray(songIds)) return;
            const shouldReconcileLocalQueue = playbackOwnerConfirmed
                && !getRemotePlaybackSession()
                && !listeningTogetherUserId
                && !accountQueuePendingIds;
            if (shouldReconcileLocalQueue) {
                const tracksById = new Map(playlist.map(track => [
                    String(track?._id || track?.id || ''),
                    track
                ]));
                const tracks = songIds.map(songId => tracksById.get(String(songId)));
                if (tracks.every(Boolean)) customQueue = tracks;
            }
            accountQueueRevision = revision;
            accountQueueIds = songIds.map(String);
            if (Array.isArray(sourceSongIds)) accountQueueSourceIds = sourceSongIds.map(String);
            if (typeof queueName === 'string' && queueName.trim()) accountQueueName = queueName.trim();
            accountQueueSnapshotSignature = getAccountQueueSnapshotSignature();
            accountQueueSnapshotCached = true;
            accountQueueDeviceId = getRemotePlaybackSession()?.deviceId || null;
            persistAccountQueueSnapshot();
            if (accountQueuePendingIds?.join(',') === accountQueueIds.join(',')) {
                clearPendingAccountQueueIds();
            } else if (accountQueuePendingIds) {
                flushPendingAccountQueue();
            }
            if (accountQueueSnapshotCached) renderQueue();
        });
        socket.off('accountQueuePublishRequest').on('accountQueuePublishRequest', () => {
            if (!getRemotePlaybackSession() && !listeningTogetherUserId) publishAccountQueueSnapshot(true);
        });
        socket.off('accountQueueAddCommand').on('accountQueueAddCommand', async ({ songId } = {}, acknowledge = () => {}) => {
            if (getRemotePlaybackSession() || listeningTogetherUserId) {
                acknowledge({ success: false, error: 'La reproducción cambió de dispositivo.' });
                return;
            }
            const track = playlist.find(item => String(item._id || item.id) === String(songId || ''));
            if (!track) {
                acknowledge({ success: false, error: 'La canción no está disponible en esta biblioteca.' });
                return;
            }
            const previousQueue = [...customQueue];
            const success = addTrackToQueue(track, true, true);
            if (!success) {
                acknowledge({ success: false, error: 'No se pudo añadir la canción a la cola.' });
                return;
            }
            if (!await publishAccountQueueSnapshot(true, true)) {
                customQueue = previousQueue;
                renderQueue();
                acknowledge({ success: false, error: 'No se pudo confirmar la actualización de la cola.' });
                return;
            }
            acknowledge({ success: true, revision: accountQueueRevision });
        });
        socket.off('accountQueueReplaceCommand').on('accountQueueReplaceCommand', async ({ revision, songIds } = {}, acknowledge = () => {}) => {
            if (
                getRemotePlaybackSession()
                || listeningTogetherUserId
                || revision !== accountQueueRevision
                || !Array.isArray(songIds)
                || songIds.length > 5000
            ) {
                acknowledge({ success: false, error: 'La cola cambió. Vuelve a intentarlo.' });
                return;
            }
            const tracks = songIds.map(songId => playlist.find(track => (
                String(track._id || track.id) === String(songId)
            )));
            if (tracks.some(track => !track)) {
                acknowledge({ success: false, error: 'La cola contiene canciones que ya no están disponibles.' });
                return;
            }
            const previousQueue = [...customQueue];
            customQueue = tracks;
            renderQueue({ syncAccount: false });
            const synchronized = await publishAccountQueueSnapshot(true, true);
            if (!synchronized) {
                customQueue = previousQueue;
                renderQueue({ syncAccount: false });
                acknowledge({ success: false, error: 'No se pudo confirmar la actualización de la cola.' });
                return;
            }
            acknowledge({ success: true, revision: accountQueueRevision });
        });
        socket.off('accountQueuePlayCommand').on('accountQueuePlayCommand', async ({ songId } = {}, acknowledge = () => {}) => {
            if (getRemotePlaybackSession() || listeningTogetherUserId) {
                acknowledge({ success: false, error: 'La reproducción cambió de dispositivo.' });
                return;
            }
            if (sharedDevicePlayback?.deviceId === playbackDeviceId && sharedDevicePlayback.transferPending === true) {
                acknowledge({
                    success: false,
                    ownerUnresponsive: true,
                    error: 'La reproducción se está transfiriendo a otro dispositivo.'
                });
                return;
            }
            const requestedSongId = String(songId || '');
            const sourceIndices = isShuffle ? [...unplayedIndices] : getSequentialQueueIndices();
            const explicitQueueLength = customQueue.length;
            const queuedSongIds = [
                ...customQueue.map(track => String(track?._id || track?.id || '')).filter(Boolean),
                ...sourceIndices.map(index => String(playlist[index]?._id || playlist[index]?.id || '')).filter(Boolean)
            ];
            const currentPosition = queuedSongIds.indexOf(requestedSongId);
            const trackIndex = playlist.findIndex(track => String(track._id || track.id) === requestedSongId);
            if (trackIndex < 0) {
                acknowledge({ success: false, error: 'La canción ya no está disponible en esta biblioteca.' });
                return;
            }
            let source = currentPosition < 0 ? 'regular' : 'custom';
            if (currentPosition >= 0 && currentPosition < explicitQueueLength) {
                customQueue.splice(0, currentPosition + 1);
            } else if (currentPosition >= explicitQueueLength) {
                customQueue.length = 0;
                if (isShuffle) unplayedIndices.splice(0, currentPosition - explicitQueueLength + 1);
                source = isShuffle ? 'shuffle' : 'regular';
            }
            playbackHistory.push({ index: currentTrackIndex, source: currentTrackSource });
            try {
                const loaded = await loadAndPlayTrack(trackIndex, source);
                renderQueue();
                acknowledge(loaded
                    ? { success: true }
                    : { success: false, error: 'No se pudo iniciar la canción en este dispositivo.' });
            } catch (error) {
                console.error('No se pudo reproducir una canción solicitada desde otro dispositivo.', error);
                acknowledge({ success: false, error: error.message || 'No se pudo iniciar la canción.' });
            }
        });
        socket.off('listenTogetherQueueSessionEnded').on('listenTogetherQueueSessionEnded', ({ sessionId } = {}) => {
            if (String(sessionId || '') !== String(sharedQueueSessionId || '')) return;
            const wasFollower = sharedQueueRole === 'follower';
            sharedQueueSessionId = null;
            sharedQueueRole = null;
            lastSharedQueueSnapshot = null;
            sharedQueueSnapshotRevision = 0;
            sharedQueueIds = [];
            sharedQueueUpcomingIds = [];
            sharedQueueHostQueueName = 'GENERAL';
            sharedQueueJamActive = false;
            sharedQueueJamRequestPending = false;
            sharedQueueJamRequestId = null;
            sharedQueueJamUpdateInFlight = false;
            sharedQueueJamPendingUpcomingIds = null;
            closeJamRequestNotification();
            if (wasFollower && sharedQueueSavedLocalQueue) {
                customQueue = sharedQueueSavedLocalQueue;
                sharedQueueSavedLocalQueue = null;
                renderQueue();
            } else if (wasFollower) {
                customQueue = [];
                renderQueue();
            } else {
                renderQueue();
            }
            renderJamControls();
            updateListeningTogetherControls();
        });
        socket.off('annoy').on('annoy', ({ senderId, senderName } = {}, acknowledge = () => {}) => {
            playAnnoySound().then(() => {
                if (senderId) {
                    annoyedFriendIds.add(String(senderId));
                    refreshChatNotifications();
                }
                acknowledge({ success: true });
                showAnnoyIndicator(senderName ? `${senderName} te ha molestado` : 'Recibiste una molestia');
            }).catch(error => {
                console.warn('No se pudo reproducir la notificación de molestia.', error);
                acknowledge({ success: false, error: error.message });
                showToast(error.message || 'No se pudo reproducir el audio de molestia.', true);
            });
        });
        socket.off('presenceChanged').on('presenceChanged', ({ userId, isOnline, updatedAt } = {}) => {
            rememberFriendRealtimeUpdate(userId, { isOnline, updatedAt });
            const friend = currentFriends.find(item => String(item._id) === String(userId));
            if (!friend) return;
            const wasOnline = friend.isOnline;
            friend.isOnline = Boolean(isOnline);
            if (
                String(userId) === String(listeningTogetherUserId || '')
                && (!friend.isOnline || !wasOnline)
            ) {
                listeningTogetherAwaitingFreshPlayback = true;
            }
            if (updatedAt) friend.lastActive = updatedAt;
            if (wasOnline === friend.isOnline) return;
            scheduleFriendsOfflineSave();
            renderFriendsSidebar();
            renderFriendsPanelList();
            updateFriendsSidebarPlayback();
            if (activeChatFriendId && String(activeChatFriendId) === String(userId) && chatTitleStatus) {
                chatTitleStatus.classList.toggle('online', friend.isOnline);
            }
            if (selectedProfileUser && String(selectedProfileUser._id) === String(userId)) {
                selectedProfileUser = {
                    ...selectedProfileUser,
                    isOnline: friend.isOnline,
                    lastActive: friend.lastActive,
                    lastPlayed: friend.lastPlayed
                };
                if (wasOnline !== friend.isOnline) renderProfile();
                else updateProfileActivityProgress();
            }
        });
        updateUserStatus(true);
        loadFriends();
        friendsUiTimer = setInterval(() => {
            updateFriendsSidebarPlayback();
        }, 1000);
        friendsRealtimeFallbackTimer = setInterval(async () => {
            if (
                !accessToken
                || offlineOnly
                || !navigator.onLine
                || socket.connected
                || document.visibilityState !== 'visible'
                || friendsFallbackRefreshInProgress
            ) return;
            friendsFallbackRefreshInProgress = true;
            try {
                await loadFriends({ skipOfflineResourceSync: true });
            } catch (error) {
                console.warn('No se pudo actualizar el panel de amigos mientras Socket.IO está desconectado.', error);
            } finally {
                friendsFallbackRefreshInProgress = false;
            }
        }, 15000);
        if (btnOpenChat) btnOpenChat.onclick = () => {
            chatModal?.classList.add('active');
            if (chatFriendsView) chatFriendsView.hidden = false;
            if (chatConversationView) chatConversationView.hidden = true;
            if (chatTitle) chatTitle.textContent = 'CHAT';
            if (btnChatBack) btnChatBack.hidden = true;
            if (chatHeaderAvatar) chatHeaderAvatar.hidden = true;
            activeChatFriendId = null;
            refreshChatNotifications();
        };
        if (unreadMessageIndicator) {
            unreadMessageIndicator.addEventListener('click', () => btnOpenChat?.click());
        }
        if (chatHeaderAvatar) chatHeaderAvatar.onclick = () => {
            if (!activeChatFriendId) return;
            const friend = currentFriends.find(item => String(item._id) === String(activeChatFriendId));
            closeChat();
            if (friend) openFriendProfile(friend._id);
        };
    }

    function stopRealtime() {
        leaveListenTogetherQueue();
        socket.disconnect();
        accountQueueSyncGeneration += 1;
        accountQueueSyncInFlight = false;
        if (accountQueueRetryTimer) {
            clearTimeout(accountQueueRetryTimer);
            accountQueueRetryTimer = null;
        }
        sharedDevicePlayback = null;
        accountQueueIds = [];
        accountQueueSourceIds = [];
        accountQueueName = 'GENERAL';
        accountQueueRevision = 0;
        accountQueueSnapshotSignature = null;
        accountQueueDeviceId = null;
        if (sharedPlaybackClockTimer) clearInterval(sharedPlaybackClockTimer);
        sharedPlaybackClockTimer = null;
        renderSharedPlaybackStatus();
        realtimeConnectedBefore = false;
        skipNextRealtimeReconciliation = false;
        friendsFallbackRefreshInProgress = false;
        if (friendCacheSaveTimer) {
            clearTimeout(friendCacheSaveTimer);
            friendCacheSaveTimer = null;
        }
        if (chatPollTimer) {
            clearInterval(chatPollTimer);
            chatPollTimer = null;
        }
        if (friendsUiTimer) {
            clearInterval(friendsUiTimer);
            friendsUiTimer = null;
        }
        if (friendsRealtimeFallbackTimer) {
            clearInterval(friendsRealtimeFallbackTimer);
            friendsRealtimeFallbackTimer = null;
        }
        closeChat();
        currentFriends = [];
        friendRealtimeUpdates.clear();
        friendsRequestSequence += 1;
        friendsOwnerId = null;
        listeningTogetherUserId = null;
        listeningTogetherAwaitingFreshPlayback = false;
        listeningTogetherNeedsUserGesture = false;
        if (currentTrackSource === 'together') currentTrackSource = 'regular';
        resetSynchronizedPlaybackRate();
        updateListeningTogetherStatus();
        renderFriendsSidebar();
        renderFriendsPanelList();
    }

    function updateFriendsSidebarPlayback() {
        updateProfileActivityProgress();
        syncListeningTogether();
        updateListeningTogetherStatus();
        const friendsById = new Map(currentFriends.map(friend => [String(friend._id), friend]));
        friendsSidebarList?.querySelectorAll('.friend-sidebar-item[data-friend-id]').forEach(item => {
            const friend = friendsById.get(String(item.dataset.friendId));
            const playback = friend?.lastPlayed;
            const duration = Number(playback?.duration) || 0;
            if (!friend || !playback) return;

            const isPlaying = Boolean(friend.isOnline && playback.songName && playback.isPlaying !== false);
            const elapsed = getPlaybackElapsedSeconds(playback, isPlaying);
            const progress = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;
            const progressFill = item.querySelector('[data-friend-progress]');
            const timeLabel = item.querySelector('[data-friend-playback-time]');
            if (progressFill) progressFill.style.width = `${progress}%`;
            if (timeLabel && isPlaying) timeLabel.textContent = `${formatTrackTime(elapsed)} / ${formatTrackTime(duration)}`;
        });
        friendsList?.querySelectorAll('.friend-item[data-friend-id]').forEach(item => {
            const friend = friendsById.get(String(item.dataset.friendId));
            const statusText = item.querySelector('.friend-status-label')?.lastChild;
            if (friend && statusText?.nodeType === Node.TEXT_NODE) {
                statusText.textContent = ` ${friendStatusLabel(friend)}`;
            }
        });
        profileFriendsGrid?.querySelectorAll('.profile-friend-card[data-friend-id]').forEach(card => {
            const friend = friendsById.get(String(card.dataset.friendId));
            const statusLabel = card.querySelector('.profile-friend-status');
            if (friend && statusLabel) statusLabel.textContent = friendStatusLabel(friend);
        });
    }

    function syncListeningTogether() {
        if (!listeningTogetherUserId) return;
        const friend = currentFriends.find(item => String(item._id) === String(listeningTogetherUserId));
        if (!friend) return;
        if (!friend.lastPlayed?.songId) {
            if (currentTrackSource === 'together') {
                stopFollowingUnavailablePlayback('Tu amigo ya no está compartiendo una reproducción.');
            }
            return;
        }
        if (offlineOnly || !navigator.onLine) {
            if (currentTrackSource === 'together') {
                listeningTogetherAwaitingFreshPlayback = true;
                resetSynchronizedPlaybackRate();
                if (!audio.paused) audio.pause();
            }
            return;
        }
        const playback = friend.lastPlayed;

        const remoteIndex = playlist.findIndex(item => String(item._id) === String(playback.songId));
        if (remoteIndex < 0) {
            if (currentTrackSource === 'together') {
                stopFollowingUnavailablePlayback('La canción de tu amigo no está disponible en tu biblioteca.');
            }
            return;
        }

        const remoteTime = Math.max(0, Number(playback.currentTime) || 0);
        if (!friend.isOnline) {
            if (currentTrackSource === 'together') {
                listeningTogetherAwaitingFreshPlayback = true;
                resetSynchronizedPlaybackRate();
                if (!audio.paused) audio.pause();
            }
            return;
        }
        if (listeningTogetherAwaitingFreshPlayback) {
            if (currentTrackSource === 'together' && !audio.paused) {
                resetSynchronizedPlaybackRate();
                audio.pause();
            }
            return;
        }
        const playbackAge = getFriendPlaybackElapsed(listeningTogetherUserId);
        const extraTime = playback.isPlaying !== false ? playbackAge : 0;
        const durationLimits = [
            Number(playback.duration),
            currentTrackIndex === remoteIndex ? audio.duration : 0
        ].filter(duration => Number.isFinite(duration) && duration > 0);
        const durationLimit = durationLimits.length
            ? Math.min(...durationLimits)
            : Number.MAX_SAFE_INTEGER;
        const targetTime = Math.min(
            durationLimit,
            remoteTime + extraTime
        );
        const currentTrackChanged = currentTrackIndex !== remoteIndex || currentTrackSource !== 'together';

        if (currentTrackChanged) {
            loadAndPlayTrack(remoteIndex, 'together', false);
            waitForSynchronizedTrackMetadata(playback.songId);
            return;
        }

        if (!isCurrentAudioSource(playlist[remoteIndex])) return;
        if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
            waitForSynchronizedTrackMetadata(playback.songId);
            return;
        }
        const drift = targetTime - audio.currentTime;
        if (audio.ended || Math.abs(drift) > 2) {
            resetSynchronizedPlaybackRate();
            audio.currentTime = Math.min(
                targetTime,
                Math.max(0, durationLimit - 0.05)
            );
        } else if (playback.isPlaying === false && Math.abs(drift) > 0.12) {
            resetSynchronizedPlaybackRate();
            audio.currentTime = targetTime;
        } else {
            resetSynchronizedPlaybackRate();
        }
        if (playback.isPlaying === false) {
            resetSynchronizedPlaybackRate();
            if (!audio.paused && currentTrackSource === 'together') audio.pause();
        }
        if (playback.isPlaying !== false && audio.paused) {
            if (listeningTogetherNeedsUserGesture) {
                updateListeningTogetherControls();
                return;
            }
            audio.play().catch(error => {
                if (error?.name === 'NotAllowedError') {
                    listeningTogetherNeedsUserGesture = true;
                    updateListeningTogetherStatus();
                    showToast('Tu navegador bloqueó la reproducción sincronizada. Pulsa reproducir para continuar.', true);
                    return;
                }
                if (!isExpectedAudioPlayInterruption(error)) {
                    console.warn('No se pudo reanudar la reproducción sincronizada.', error);
                }
            });
        }
    }

    function waitForSynchronizedTrackMetadata(trackId) {
        const normalizedTrackId = String(trackId);
        if (listeningTogetherMetadataWaitTrackId === normalizedTrackId) return;
        listeningTogetherMetadataWaitTrackId = normalizedTrackId;
        const waitToken = ++listeningTogetherMetadataWaitToken;
        audio.addEventListener('loadedmetadata', () => {
            if (
                listeningTogetherMetadataWaitToken !== waitToken
                || listeningTogetherMetadataWaitTrackId !== normalizedTrackId
            ) return;
            listeningTogetherMetadataWaitTrackId = null;
            if (
                String(getCurrentTrack()?._id || '') === normalizedTrackId
                && currentTrackSource === 'together'
                && isCurrentAudioSource(getCurrentTrack())
            ) {
                syncListeningTogether();
            }
        }, { once: true });
    }

    function resetSynchronizedPlaybackRate() {
        if (audio.playbackRate !== 1) audio.playbackRate = 1;
    }

    function stopFollowingUnavailablePlayback(message) {
        if (currentTrackSource !== 'together') return;
        leaveListenTogetherQueue();
        listeningTogetherUserId = null;
        listeningTogetherAwaitingFreshPlayback = false;
        listeningTogetherNeedsUserGesture = false;
        resetSynchronizedPlaybackRate();
        audio.pause();
        currentTrackSource = 'regular';
        playbackActivityUserId = null;
        updateListeningTogetherStatus();
        showToast(message, true);
    }

    function stopFollowingRemovedFriend() {
        leaveListenTogetherQueue();
        listeningTogetherUserId = null;
        listeningTogetherAwaitingFreshPlayback = false;
        listeningTogetherNeedsUserGesture = false;
        if (currentTrackSource === 'together' && getCurrentTrack()) {
            currentTrackSource = 'regular';
            playbackActivityUserId = String(getStoredUser()?._id || '') || null;
            sharedPlaybackTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
            sharedPlaybackDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
            sharedPlaybackPlaying = !audio.paused;
            persistPlaybackPosition(true);
            startPlaybackStatusSync();
        }
        resetSynchronizedPlaybackRate();
        updateListeningTogetherStatus();
        renderQueue();
        if (!isRestoringInitialPlayback && !suppressStartupPlaybackUpdates) {
            updateUserStatus(true);
            broadcastPlaybackState(true);
        }
        showToast('Se detuvo la escucha compartida porque ya no está en tu lista de amigos.', true);
    }

    function updateListeningTogetherStatus() {
        const friend = listeningTogetherUserId
            ? currentFriends.find(item => String(item._id) === String(listeningTogetherUserId))
            : null;
        updateListeningTogetherControls();
        if (!listeningTogetherStatus) return;
        listeningTogetherStatus.hidden = !listeningTogetherUserId;
        if (listeningTogetherUserId) {
            const label = listeningTogetherStatus.querySelector('span');
            const status = listeningTogetherNeedsUserGesture
                ? 'PULSA REPRODUCIR PARA ESCUCHAR A'
                : listeningTogetherAwaitingFreshPlayback
                    ? (friend?.isOnline ? 'SINCRONIZANDO CON' : 'ESPERANDO A')
                    : friend?.lastPlayed?.isPlaying === false
                        ? 'EN PAUSA CON'
                        : 'ESCUCHANDO JUNTO A';
            if (label) label.textContent = `${status}: ${friend?.username || 'tu amigo'}`;
        }
    }

    function isFollowingPlayback() {
        return Boolean(listeningTogetherUserId && currentTrackSource === 'together');
    }

    function updateListeningTogetherControls() {
        const following = isFollowingPlayback();
        const canControlJam = following && sharedQueueJamActive;
        [btnPrev, btnNext, btnRewind, btnForward].forEach(button => {
            if (button) button.disabled = following && !canControlJam;
        });
        const followedFriend = listeningTogetherUserId
            ? currentFriends.find(item => String(item._id) === String(listeningTogetherUserId))
            : null;
        const canRetryBlockedPlayback = following
            && listeningTogetherNeedsUserGesture
            && audio.paused
            && followedFriend?.isOnline
            && followedFriend.lastPlayed?.isPlaying !== false;
        if (btnPlayPause) btnPlayPause.disabled = following && !canControlJam && !canRetryBlockedPlayback;
        if (progressContainer) {
            progressContainer.setAttribute('aria-disabled', String(following));
            progressContainer.classList.toggle('is-playback-following', following);
        }
    }

    if (btnExitListeningTogether) {
        btnExitListeningTogether.addEventListener('click', () => {
            leaveListenTogetherQueue();
            listeningTogetherUserId = null;
            listeningTogetherAwaitingFreshPlayback = false;
            listeningTogetherNeedsUserGesture = false;
            if (currentTrackSource === 'together' && getCurrentTrack()) {
                currentTrackSource = 'regular';
                playbackActivityUserId = String(getStoredUser()?._id || '') || null;
                sharedPlaybackTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
                sharedPlaybackDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
                sharedPlaybackPlaying = !audio.paused;
                persistPlaybackPosition(true);
                startPlaybackStatusSync();
            }
            updateListeningTogetherStatus();
            if (!isRestoringInitialPlayback && !suppressStartupPlaybackUpdates) {
                updateUserStatus(true);
                broadcastPlaybackState(true);
            }
        });
    }

    if (btnOpenFriendsPanel) btnOpenFriendsPanel.addEventListener('click', openFriendsPanel);
    if (btnCloseFriends) btnCloseFriends.addEventListener('click', closeFriendsPanel);
    if (btnAddFriend) btnAddFriend.addEventListener('click', addFriend);
    if (inputAddFriend) {
        inputAddFriend.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); addFriend(); }
        });
    }
    if (btnCloseChat) btnCloseChat.addEventListener('click', closeChat);
    if (btnChatBack) {
        btnChatBack.addEventListener('click', () => {
            if (chatFriendsView) chatFriendsView.hidden = false;
            if (chatConversationView) chatConversationView.hidden = true;
            if (chatTitle) chatTitle.textContent = 'CHAT';
            if (chatTitleStatus) chatTitleStatus.hidden = true;
            btnChatBack.hidden = true;
            if (chatHeaderAvatar) chatHeaderAvatar.hidden = true;
            activeChatFriendId = null;
            if (chatPollTimer) {
                clearInterval(chatPollTimer);
                chatPollTimer = null;
            }
        });
    }
    if (btnSendMessage) btnSendMessage.addEventListener('click', sendChatMessage);
    if (btnAnnoyFriend) {
        btnAnnoyFriend.addEventListener('click', () => {
            if (!activeChatFriendId) {
                showToast('Abre primero el chat del amigo al que quieres molestar.', true);
                return;
            }
            if (!socket.connected) {
                showToast('No se pudo molestar: no hay conexión en tiempo real.', true);
                return;
            }
            btnAnnoyFriend.disabled = true;
            socket.timeout(7000).emit('annoy', { friendId: activeChatFriendId }, (timeoutError, result) => {
                btnAnnoyFriend.disabled = false;
                if (timeoutError) {
                    showToast('El servidor no confirmó la reproducción. Actualiza ambos clientes y reinicia el backend si acaba de cambiar.', true);
                    return;
                }
                if (!result?.success) {
                    showToast(result?.error || 'No se pudo reproducir el audio en el dispositivo del amigo.', true);
                    return;
                }
            });
        });
    }
    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); }
        });
    }

    function openSharePlaylistModal(plId) {
        if (!shareModal || !modalOverlay) return;
        playlistIdPendingShare = plId;
        if (!currentFriends.length) {
            shareFriendsList.innerHTML = '<li>Agregá amigos primero para poder compartir.</li>';
        } else {
            shareFriendsList.innerHTML = currentFriends.map(friend => `
                <li class="share-playlist-item" data-friend-id="${escapeHtml(friend._id)}">
                    ${friend.profilePhoto ? `<img src="${escapeHtml(friend.profilePhoto)}" alt="" class="share-friend-avatar" />` : '<span class="share-friend-avatar-placeholder">?</span>'}
                    <span>${escapeHtml(friend.username)}</span>
                </li>
            `).join('');
            shareFriendsList.querySelectorAll('li[data-friend-id]').forEach(item => {
                item.addEventListener('click', () => sharePlaylistWithFriend(item.dataset.friendId));
            });
        }
        modalOverlay.classList.add('active');
        shareModal.classList.add('active');
    }

    function closeSharePlaylistModal() {
        if (shareModal) shareModal.classList.remove('active');
        if (
            modalOverlay
            && !addToPlModal.classList.contains('active')
            && !manageMembersModal?.classList.contains('active')
            && !playlistSaversModal?.classList.contains('active')
        ) modalOverlay.classList.remove('active');
        playlistIdPendingShare = null;
    }

    async function sharePlaylistWithFriend(friendId) {
        const user = getStoredUser();
        if (!user || !playlistIdPendingShare || !friendId) return;
        try {
            const res = await apiFetch(`${API_URL}/playlists/${playlistIdPendingShare}/share`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fromUserId: user._id, friendId })
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result?.error || 'No se pudo compartir la playlist');
            closeSharePlaylistModal();
        } catch (e) {
            console.error(e);
        }
    }

    if (btnSharePlaylist) {
        btnSharePlaylist.addEventListener('click', async () => {
            if (!activePlaylistId) return;
            const currentUser = getStoredUser();
            const playlistToActOn = [...userPlaylists, ...(publicProfilePlaylists || [])]
                .find(item => item.id === activePlaylistId);
            const isOwner = Boolean(currentUser?._id && String(playlistToActOn?.ownerId) === String(currentUser._id));
            if (isOwner) {
                openSharePlaylistModal(activePlaylistId);
            }
        });
    }
    if (btnDeletePlaylist) {
        btnDeletePlaylist.addEventListener('click', async () => {
            const user = getStoredUser();
            const targetPlaylist = userPlaylists.find(item => item.id === activePlaylistId);
            if (
                !user?._id
                || !targetPlaylist?.spotifyPlaylistId
                || String(targetPlaylist.ownerId) !== String(user._id)
            ) return;
            if (!window.confirm(
                `¿Eliminar “${targetPlaylist.name}” de AMGC? La playlist original de Spotify no se eliminará.`
            )) return;

            btnDeletePlaylist.disabled = true;
            try {
                const response = await apiFetch(`${API_URL}/playlists/${encodeURIComponent(targetPlaylist.id)}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: user._id })
                });
                const result = await response.json().catch(() => null);
                if (!response.ok) throw new Error(result?.error || 'No se pudo eliminar la playlist sincronizada.');
                activePlaylistId = null;
                isPlaylistViewMode = false;
                isAllSongsMode = true;
                await loadPlaylists();
                updateBackgroundAndViews();
                showToast(`“${targetPlaylist.name}” se eliminó de AMGC.`);
            } catch (error) {
                console.error('No se pudo eliminar la playlist sincronizada.', error);
                showToast(error.message || 'No se pudo eliminar la playlist sincronizada.', true);
            } finally {
                btnDeletePlaylist.disabled = false;
            }
        });
    }
    if (btnCloseSharePl) btnCloseSharePl.addEventListener('click', closeSharePlaylistModal);
    function closeManageMembersModal() {
        if (manageMembersModal) manageMembersModal.classList.remove('active');
        if (
            modalOverlay
            && !addToPlModal.classList.contains('active')
            && !shareModal.classList.contains('active')
            && !playlistSaversModal?.classList.contains('active')
        ) {
            modalOverlay.classList.remove('active');
        }
    }

    function openManageMembersModal(pl) {
        if (!manageMembersModal || !manageMembersList) return;
        const members = Array.isArray(pl.sharedWith) ? pl.sharedWith : [];
        manageMembersList.innerHTML = members.length
            ? members.map(member => `
                <li class="share-playlist-item manage-member-item" data-member-id="${escapeHtml(member._id)}">
                    ${member.profilePhoto ? `<img src="${escapeHtml(member.profilePhoto)}" alt="" class="share-friend-avatar" />` : '<span class="share-friend-avatar-placeholder">?</span>'}
                    <span>${escapeHtml(member.username || 'Usuario')}</span>
                    <img src="/img/cancel.png" alt="Quitar integrante" class="manage-member-remove-icon" />
                </li>
            `).join('')
            : '<li class="playlist-members-empty">No hay integrantes unidos.</li>';
        manageMembersList.querySelectorAll('[data-member-id]').forEach(item => {
            item.addEventListener('click', async () => {
                const user = getStoredUser();
                if (!user || !activePlaylistId) return;
                item.classList.add('is-removing');
                try {
                    const response = await apiFetch(`${API_URL}/playlists/${activePlaylistId}/members/remove`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: user._id, memberId: item.dataset.memberId })
                    });
                    const result = await response.json().catch(() => null);
                    if (!response.ok) throw new Error(result?.error || 'No se pudo quitar al integrante');
                    await loadPlaylists();
                    closeManageMembersModal();
                    openPlaylistView(activePlaylistId);
                } catch (error) {
                    item.classList.remove('is-removing');
                    showToast(error.message || 'No se pudo quitar al integrante', true);
                }
            });
        });
        modalOverlay.classList.add('active');
        manageMembersModal.classList.add('active');
    }

    if (btnCloseManageMembers) btnCloseManageMembers.addEventListener('click', closeManageMembersModal);
    const closePlaylistSaversModal = () => {
        playlistSaversModal?.classList.remove('active');
        if (
            modalOverlay
            && !addToPlModal.classList.contains('active')
            && !shareModal.classList.contains('active')
            && !manageMembersModal?.classList.contains('active')
        ) {
            modalOverlay.classList.remove('active');
        }
    };
    btnClosePlaylistSavers?.addEventListener('click', closePlaylistSaversModal);
    if (btnSavePlaylist) {
        btnSavePlaylist.addEventListener('click', async () => {
            const user = getStoredUser();
            const playlistToSave = [...userPlaylists, ...(publicProfilePlaylists || [])]
                .find(item => item.id === activePlaylistId);
            if (!user?._id || !playlistToSave) return;
            if (btnSavePlaylist.dataset.action === 'manage-members') {
                openManageMembersModal(playlistToSave);
                return;
            }
            if (btnSavePlaylist.dataset.action === 'leave-playlist') {
                try {
                    const response = await apiFetch(`${API_URL}/playlists/${activePlaylistId}/members/remove`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: user._id, memberId: user._id })
                    });
                    const result = await response.json().catch(() => null);
                    if (!response.ok) throw new Error(result?.error || 'No se pudo salir de la playlist');
                    await loadPlaylists();
                    activePlaylistId = null;
                    isPlaylistViewMode = false;
                    updateBackgroundAndViews();
                } catch (error) {
                    showToast(error.message || 'No se pudo salir de la playlist', true);
                }
                return;
            }
            const saved = btnSavePlaylist.dataset.saved === 'true';
            try {
                const response = await apiFetch(`${API_URL}/playlists/${activePlaylistId}/save`, {
                    method: saved ? 'DELETE' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: user._id })
                });
                const result = await response.json().catch(() => null);
                if (!response.ok) throw new Error(result?.error || 'No se pudo actualizar la playlist guardada');
                if (Number.isFinite(Number(result?.savedCount))) {
                    playlistToSave.savedCount = Number(result.savedCount);
                }
                if (Array.isArray(result?.savedPlaylists)) {
                    setStoredUser({ ...user, savedPlaylists: result.savedPlaylists });
                } else {
                    const savedPlaylists = new Set(user.savedPlaylists || []);
                    if (saved) savedPlaylists.delete(activePlaylistId);
                    else savedPlaylists.add(activePlaylistId);
                    setStoredUser({ ...user, savedPlaylists: [...savedPlaylists] });
                }
                await loadPlaylists();
                openPlaylistView(activePlaylistId);
            } catch (error) {
                showToast(error.message || 'No se pudo actualizar la playlist guardada', true);
            }
        });
    }

    if (profilePhotoButton && profilePhotoInput) {
        profilePhotoButton.addEventListener('click', () => profilePhotoInput.click());
        profilePhotoInput.addEventListener('change', async () => {
            const file = profilePhotoInput.files?.[0];
            const user = getStoredUser();
            if (!file || !user?._id) return;
            const formData = new FormData();
            formData.append('photo', file);
            try {
                if (loadingSpinner) loadingSpinner.style.display = 'flex';
                const response = await apiFetch(`${API_URL}/users/${user._id}/profile-photo`, { method: 'POST', body: formData });
                if (!response.ok) throw new Error('No se pudo guardar la foto de perfil');
                const updatedUser = await response.json();
                const updatedProfile = { ...user, profilePhoto: updatedUser.profilePhoto };
                setStoredUser(updatedProfile);
                saveCachedOfflineUser(updatedProfile);
                renderProfile();
                syncOfflineResources();
            } catch (error) {
                console.error(error);
                showToast('No se pudo guardar la foto de perfil', true);
            } finally {
                if (loadingSpinner) loadingSpinner.style.display = 'none';
                profilePhotoInput.value = '';
            }
        });
    }

    const currentSavedUser = getStoredUser();

    const cachedOfflineUser = getCachedOfflineUser();
    if (!navigator.onLine && cachedOfflineUser?._id && isOfflineEnabledFor(cachedOfflineUser._id)) {
        offlineOnly = true;
        offlineModeEnabled = true;
        accessToken = '';
        setStoredUser(null);
        if (offlineModeToggle) offlineModeToggle.checked = true;
        if (authUsername) authUsername.value = cachedOfflineUser.username;
        showAuthOverlay();
        updateOfflineCacheStatus('Sin conexión. Inicia sesión con la contraseña de este dispositivo para abrir el contenido guardado.');
    } else if (currentSavedUser && accessToken) {
        if (authUsername) authUsername.value = currentSavedUser.username || '';
        const restoreSession = async () => {
            try {
                const response = await apiFetch(`${API_URL}/auth/me`);
                if (!response.ok) {
                    throw new Error(`El servidor respondió ${response.status} al restaurar la sesión.`);
                }
                const restoredUser = await response.json();
                if (String(restoredUser?._id || '') !== String(currentSavedUser._id)) {
                    accessToken = '';
                    localStorage.removeItem(accessTokenStorageKey);
                    setStoredUser(null);
                    throw new Error('La sesión guardada no coincide con el perfil de este dispositivo. Inicia sesión nuevamente.');
                }
                setStoredUser(restoredUser);
                saveCachedOfflineUser(restoredUser);
                isLoggingOut = false;
                offlineOnly = false;
                offlineModeEnabled = isOfflineEnabledFor(restoredUser._id);
                if (offlineModeToggle) offlineModeToggle.checked = offlineModeEnabled;
                await syncOfflineListening();
                syncSecretPhrasesFromUser(restoredUser);
                await loadSecretPhrases(restoredUser);
                renderProfile();
                syncAccessControls();
                if (canCurrentUser('manage_users')) void loadAdminUsers();
                startRealtime();
                fetchMusicData();
                loadPlaylists();
                loadFriends();
                if (offlineModeEnabled) syncOfflineResources();
                if (authTitle) authTitle.textContent = `Bienvenido, ${restoredUser.username}`;
                hideAuthOverlay();
            } catch (error) {
                console.error('No se pudo restaurar la sesión guardada.', error);
                showAuthOverlay();
                if (authError) {
                    setAuthError(accessToken
                        ? 'No se pudo comprobar la sesión guardada. Revisa tu conexión e intenta ingresar nuevamente.'
                        : 'La sesión expiró o dejó de ser válida. Inicia sesión nuevamente.');
                }
            }
        };
        void restoreSession();
    } else {
        accessToken = '';
        localStorage.removeItem(accessTokenStorageKey);
        if (currentSavedUser) setStoredUser(null);
    }

    if (btnLogoutSettings) {
        btnLogoutSettings.addEventListener('click', () => {
            const loggingOutUser = getStoredUser();
            recordOfflineListeningProgress(
                getCurrentTrack(),
                Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
                true
            );
            offlineListeningLastSample = null;
            persistOfflineListeningBuffer(true);
            updateUserStatus(false);
            isLoggingOut = true;
            stopRealtime();
            playbackActivityUserId = null;
            accessToken = '';
            localStorage.removeItem(accessTokenStorageKey);
            offlineOnly = false;
            offlineModeEnabled = false;
            musicDataRequestSequence += 1;
            playlistsRequestSequence += 1;
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            playlist = [];
            userPlaylists = [];
            currentTrackIndex = 0;
            currentTrackId = null;
            activePlaylistId = null;
            generalQueueAnchorTrackId = null;
            activeQueueTracks = [];
            customQueue = [];
            resetPlaybackHistory();
            if (loggingOutUser?._id) localStorage.removeItem(getOfflinePreferenceKey(loggingOutUser._id));
            localStorage.removeItem('amgc-offline-user');
            if (offlineModeToggle) offlineModeToggle.checked = false;
            setStoredUser(null);
            syncOfflineStatusIndicators();
            syncAccessControls();
            if (authOverlay) showAuthOverlay();
            if (authUsername) authUsername.value = '';
            if (authPassword) authPassword.value = '';
            if (authError) setAuthError('');
            isAllSongsMode = false;
            isPlaylistViewMode = false;
            isEditSongMode = false;
            isEditPlaylistMode = false;
            isSettingsMode = false;
            isAdminMode = false;
            isProfileMode = false;
            isLyricsMode = false;
            updateBackgroundAndViews();
        });
    }

    if (authSubmit && authUsername && authPassword) {
        const submitLogin = async () => {
            const username = authUsername.value.trim();
            const password = authPassword.value.trim();

            if (!username || !password) {
                setAuthError('Ingresá usuario y contraseña para continuar.');
                return;
            }

            authSubmit.disabled = true;
            authSubmit.textContent = 'Ingresando...';
            setAuthError('');

            try {
                const response = await apiFetch(`${API_URL}/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });

                const result = await response.json().catch(() => null);

                if (!response.ok) {
                    throw new Error(result?.error || 'Credenciales incorrectas/Cuenta inexistente. Pidele acceso a un administrador.');
                }

                const userPayload = {
                    _id: result._id,
                    username: result.username,
                    isAdmin: Boolean(result.isAdmin),
                    permissions: result.permissions || [],
                    settings: result.settings || { seekSeconds: 5, maxVolume: 200 },
                    savedPlaylists: Array.isArray(result.savedPlaylists) ? result.savedPlaylists : [],
                    lastPlayed: result.lastPlayed || null,
                    lastPlayedHistory: Array.isArray(result.lastPlayedHistory) ? result.lastPlayedHistory : [],
                    profilePhoto: result.profilePhoto || ''
                };

                if (typeof result.token !== 'string' || !result.token) {
                    throw new Error('El servidor no devolvió una sesión autenticada.');
                }
                localStorage.setItem(accessTokenStorageKey, result.token);
                isLoggingOut = false;
                accessToken = result.token;
                setStoredUser(userPayload);
                void loadSpotifyStatus();
                saveCachedOfflineUser(userPayload);
                try {
                    await saveOfflineCredential(password);
                } catch (offlineCredentialError) {
                    console.warn('No se pudo preparar autenticación offline en este dispositivo.', offlineCredentialError);
                    updateOfflineCacheStatus(offlineCredentialError.message);
                }
                offlineOnly = false;
                offlineModeEnabled = isOfflineEnabledFor(userPayload._id);
                if (offlineModeToggle) offlineModeToggle.checked = offlineModeEnabled;
                await syncOfflineListening();
                syncSecretPhrasesFromUser(userPayload);
                await loadSecretPhrases(userPayload);
                renderProfile();
                syncAccessControls();
                if (canCurrentUser('manage_users')) void loadAdminUsers();
                startRealtime();
                fetchMusicData();
                loadPlaylists();
                loadFriends();
                if (offlineModeEnabled) syncOfflineResources();
                if (authTitle) authTitle.textContent = `Bienvenido, ${result.username}`;
                hideAuthOverlay();
            } catch (error) {
                const offlineUser = getCachedOfflineUser();
                const matchingOfflineUser = (
                    (error?.name === 'TypeError' || error?.name === 'OfflineModeError' || !navigator.onLine)
                    && offlineUser?._id
                    && isOfflineEnabledFor(offlineUser._id)
                    && String(offlineUser.username).toLocaleLowerCase() === username.toLocaleLowerCase()
                );
                const canUseSavedOfflineUser = matchingOfflineUser
                    && await verifyOfflineCredential(password, offlineUser._id);
                if (canUseSavedOfflineUser) {
                    isLoggingOut = false;
                    offlineOnly = true;
                    offlineModeEnabled = true;
                    accessToken = '';
                    setStoredUser(offlineUser);
                    syncOfflineStatusIndicators();
                    applyOfflineProfilePhoto(offlineUser).catch(photoError => console.warn('No se pudo mostrar la foto guardada offline.', photoError));
                    if (offlineModeToggle) offlineModeToggle.checked = true;
                    syncSecretPhrasesFromUser(offlineUser);
                    renderProfile();
                    syncAccessControls();
                    hideAuthOverlay();
                    updateOfflineCacheStatus('Sin conexión: se abrió el perfil guardado. Las funciones sociales volverán al reconectar.');
                    fetchMusicData();
                    loadPlaylists();
                    loadFriends();
                    return;
                }
                if (matchingOfflineUser) {
                    setAuthError('La contraseña no coincide con la credencial guardada para el acceso offline.');
                    return;
                }
                setAuthError(error?.message || 'No se pudo iniciar sesión.');
            } finally {
                authSubmit.disabled = false;
                authSubmit.textContent = 'Ingresar';
            }
        };

        authSubmit.addEventListener('click', submitLogin);
        [authUsername, authPassword].forEach((input) => {
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    submitLogin();
                }
            });
        });
    }

    if (offlineModeToggle) {
        offlineModeToggle.addEventListener('change', async () => {
            const user = getStoredUser();
            if (!user?._id) {
                offlineModeToggle.checked = false;
                updateOfflineCacheStatus('Inicia sesión para activar las descargas offline.');
                return;
            }
            offlineModeEnabled = offlineModeToggle.checked;
            localStorage.setItem(getOfflinePreferenceKey(user._id), String(offlineModeEnabled));
            if (!offlineModeEnabled) {
                updateOfflineCacheStatus('Descargas automáticas pausadas. Los archivos ya guardados se conservarán.');
                return;
            }
            saveCachedOfflineUser(user);
            if (navigator.storage?.persist) {
                try {
                    const storageIsPersistent = await navigator.storage.persist();
                    if (!storageIsPersistent) {
                        updateOfflineCacheStatus('El navegador puede liberar espacio offline si el dispositivo se queda sin almacenamiento.');
                    }
                } catch (error) {
                    console.warn('No se pudo solicitar almacenamiento persistente.', error);
                }
            }
            if (!navigator.onLine || offlineOnly || !accessToken) {
                updateOfflineCacheStatus('Sin conexión. Las descargas comenzarán al conectarte e iniciar sesión.');
                return;
            }
            updateOfflineCacheStatus('Actualizando catálogo y preparando descargas offline…');
            await Promise.all([fetchMusicData(), loadFriends()]);
            await loadPlaylists();
            await syncOfflineResources();
        });
    }

    const handleOffline = () => {
        if (!offlineModeEnabled) {
            showToast('Sin conexión. Activa el modo offline para usar el contenido guardado.', true);
            return;
        }
        offlineOnly = true;
        syncOfflineStatusIndicators();
        if (isProfileMode) renderProfile();
        socket.disconnect();
        startOfflineRecoveryTimer();
        const cachedUser = getCachedOfflineUser();
        if (cachedUser) applyOfflineProfilePhoto(cachedUser)
            .catch(error => console.warn('No se pudo mostrar la foto guardada offline.', error));
        updateOfflineCacheStatus('Sin conexión. Se usarán canciones, playlists y actividad guardadas.');
        fetchMusicData();
        loadFriends();
        loadPlaylists();
    };
    window.addEventListener('offline', handleOffline);

    const handleOnline = async () => {
        if (offlineOnly && !accessToken) {
            showToast('Conexión recuperada. Inicia sesión para sincronizar y actualizar las descargas.');
            if (authOverlay) showAuthOverlay();
            return;
        }
        if (offlineOnly) {
            if (!(await refreshOfflineSession())) {
                startOfflineRecoveryTimer();
            } else {
                void syncPendingPlaylistAdds();
            }
        } else {
            void syncPendingPlaylistAdds();
            syncOfflineResources();
        }
    };
    window.addEventListener('online', handleOnline);

    syncAccessControls();

    if (!mainContent || !bottomBarWrapper || !btnPlayPause) return () => {};

    async function loadAdminUsers() {
        if (!adminUsersList) return;
        const requester = getStoredUser();
        if (!canCurrentUser('manage_users') || !requester?._id) {
            showToast('No tienes permiso para gestionar usuarios.', true);
            return;
        }

        const requestToken = ++adminUsersRequestToken;
        const canApplyResult = () => requestToken === adminUsersRequestToken
            && String(getStoredUser()?._id || '') === String(requester._id)
            && canCurrentUser('manage_users');
        const renderAdminUsers = users => {
            if (!users.length) {
                adminUsersList.innerHTML = '<li class="admin-user-row"><span class="admin-user-name">No hay usuarios disponibles.</span></li>';
                return;
            }

            adminUsersList.innerHTML = users.map((user) => {
                const permissions = user.isAdmin
                    ? ['admin', 'manage_users', 'edit_songs', 'delete_songs']
                    : (Array.isArray(user.permissions) ? user.permissions : []);
                const permissionOptions = [
                    { value: 'manage_users', label: 'Usuarios' },
                    { value: 'edit_songs', label: 'Editar' },
                    { value: 'delete_songs', label: 'Borrar' }
                ];

                return `
                    <li class="admin-user-row" data-user-id="${escapeHtml(user._id)}">
                        <div class="admin-user-main">
                            <span class="admin-user-name">${escapeHtml(user.username)}</span>
                            <span class="admin-user-role">${user.isAdmin ? 'Administrador' : 'Usuario'}</span>
                            <span class="admin-user-permissions">${escapeHtml(permissions.length ? permissions.join(', ') : 'Sin permisos')}</span>
                        </div>
                        <div class="admin-user-controls">
                            <div class="admin-user-actions-inline">
                                <button class="admin-edit-user" data-user-id="${escapeHtml(user._id)}" type="button" aria-label="Editar usuario" title="Editar usuario">
                                    <img src="/img/edit.png" alt="Editar usuario" draggable="false" />
                                </button>
                                <button class="admin-delete-user" data-user-id="${escapeHtml(user._id)}" type="button" aria-label="Eliminar usuario" title="Eliminar usuario">
                                    <img src="/img/cancel.png" alt="Eliminar usuario" draggable="false" />
                                </button>
                            </div>
                            <div class="admin-user-bottom">
                                <div class="admin-user-permissions-grid">
                                    ${permissionOptions.map((option) => `
                                        <label class="permission-check">
                                            <input type="checkbox" data-user-id="${escapeHtml(user._id)}" data-permission="${option.value}" ${permissions.includes(option.value) ? 'checked' : ''} />
                                            <span>${option.label}</span>
                                        </label>
                                    `).join('')}
                                    <label class="admin-role-toggle">
                                        <input type="checkbox" data-user-id="${escapeHtml(user._id)}" data-role-admin ${user.isAdmin ? 'checked' : ''} />
                                        <span>Admin</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </li>
                `;
            }).join('');
        };

        if (adminUsersCache && adminUsersCacheOwnerId === String(requester._id)) {
            renderAdminUsers(adminUsersCache);
        } else {
            adminUsersList.innerHTML = '<li class="admin-user-row"><span class="admin-user-name">Cargando usuarios...</span></li>';
        }

        try {
            const response = await apiFetch(`${API_URL}/users?requesterId=${encodeURIComponent(requester._id)}`);
            const data = await response.json().catch(() => null);
            if (!response.ok || !Array.isArray(data)) {
                throw new Error(data?.error || 'No se pudieron cargar los usuarios.');
            }
            if (!canApplyResult()) return;
            adminUsersCache = data;
            adminUsersCacheOwnerId = String(requester._id);
            renderAdminUsers(data);
        } catch (error) {
            console.error(error);
            if (canApplyResult() && (!adminUsersCache || adminUsersCacheOwnerId !== String(requester._id))) {
                adminUsersList.innerHTML = '<li class="admin-user-row"><span class="admin-user-name">No se pudieron cargar los usuarios.</span></li>';
            }
        }
    }

    async function setUserAccess(userId, { isAdmin, permissions }) {
        try {
            const requester = getStoredUser();
            if (!requester?._id || !canCurrentUser('manage_users')) {
                throw new Error('No tienes permiso para gestionar usuarios.');
            }
            const response = await apiFetch(`${API_URL}/users/${userId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isAdmin, permissions, requesterId: requester._id })
            });

            const result = await response.json().catch(() => null);
            if (!response.ok) {
                throw new Error(result?.error || 'No se pudo actualizar el usuario.');
            }

            const storedUser = getStoredUser();
            if (storedUser && storedUser._id === userId) {
                setStoredUser({
                    ...storedUser,
                    isAdmin: Boolean(result.isAdmin),
                    permissions: Array.isArray(result.permissions) ? result.permissions : []
                });
                syncAccessControls();
            }
            await loadAdminUsers();
            return result;
        } catch (error) {
            console.error(error);
            return null;
        }
    }

    if (adminUserForm) {
        adminUserForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!adminFormUsername || !adminFormPassword) return;

            const username = adminFormUsername.value.trim();
            const password = adminFormPassword.value.trim();
            const isAdmin = Boolean(adminFormIsAdmin?.checked);
            const selectedPermissions = Array.from(document.querySelectorAll('[data-permission-option]:checked')).map((input) => input.value);
            const editUserId = adminUserForm.dataset.editUserId;

            if (!username || (!password && !editUserId)) {
                if (adminFormStatus) {
                    adminFormStatus.textContent = 'Usuario y contraseña requeridos.';
                    adminFormStatus.classList.add('error');
                }
                return;
            }

            try {
                const payload = {
                    username,
                    isAdmin,
                    permissions: isAdmin ? ['admin', 'manage_users', 'edit_songs', 'delete_songs'] : selectedPermissions,
                    requesterId: getStoredUser()?._id
                };

                if (password) payload.password = password;

                const response = await apiFetch(editUserId ? `${API_URL}/users/${editUserId}` : `${API_URL}/users`, {
                    method: editUserId ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const responseBody = await response.json().catch(() => null);
                if (!response.ok) {
                    throw new Error(responseBody?.error || (editUserId ? 'No se pudo guardar el usuario.' : 'No se pudo crear el usuario.'));
                }

                const adminViewerId = String(getStoredUser()?._id || '');
                if (adminUsersCache && adminUsersCacheOwnerId === adminViewerId && responseBody?._id) {
                    const updatedUsers = adminUsersCache.filter(user => String(user._id) !== String(responseBody._id));
                    updatedUsers.push(responseBody);
                    adminUsersCache = updatedUsers.sort((left, right) => left.username.localeCompare(right.username));
                }

                adminUserForm.reset();
                delete adminUserForm.dataset.editUserId;
                const submitButton = adminUserForm.querySelector('button[type="submit"]');
                if (submitButton) submitButton.textContent = 'Crear usuario';
                const formTitle = document.querySelector('.admin-add-user-card .admin-card-header h3');
                if (formTitle) formTitle.textContent = 'Crear usuario';

                if (adminFormStatus) {
                    adminFormStatus.textContent = editUserId ? 'Usuario actualizado correctamente.' : 'Usuario creado correctamente.';
                    adminFormStatus.classList.remove('error');
                }
                await loadAdminUsers();
            } catch (error) {
                if (adminFormStatus) {
                    adminFormStatus.textContent = error.message || 'Error al guardar el usuario.';
                    adminFormStatus.classList.add('error');
                }
            }
        });
    }

    if (adminBackToCreate) {
        adminBackToCreate.addEventListener('click', () => {
            if (adminUserForm) {
                adminUserForm.reset();
                delete adminUserForm.dataset.editUserId;
                const submitButton = adminUserForm.querySelector('button[type="submit"]');
                if (submitButton) submitButton.textContent = 'Crear usuario';
            }

            const formTitle = document.querySelector('.admin-add-user-card .admin-card-header h3');
            if (formTitle) formTitle.textContent = 'Crear usuario';

            if (adminFormStatus) {
                adminFormStatus.textContent = '';
                adminFormStatus.classList.remove('error');
            }
        });
    }

    if (adminUsersList) {
        adminUsersList.addEventListener('change', async (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;

            const userId = target.getAttribute('data-user-id');
            if (!userId) return;

            const row = target.closest('.admin-user-row');
            if (!row) return;

            const permissionInputs = row.querySelectorAll('[data-permission]');
            const selectedPermissions = Array.from(permissionInputs)
                .filter((input) => input.checked)
                .map((input) => input.getAttribute('data-permission'))
                .filter(Boolean);

            const isAdmin = row.querySelector('[data-role-admin]')?.checked || false;
            const finalPermissions = isAdmin
                ? ['admin', 'manage_users', 'edit_songs', 'delete_songs']
                : (selectedPermissions.length ? selectedPermissions : ['user']);

            await setUserAccess(userId, { isAdmin, permissions: finalPermissions });
        });

        adminUsersList.addEventListener('click', async (event) => {
            const editButton = event.target.closest('.admin-edit-user');
            if (editButton) {
                const userId = editButton.getAttribute('data-user-id');
                const row = editButton.closest('.admin-user-row');
                const nameEl = row?.querySelector('.admin-user-name');
                const username = nameEl?.textContent?.trim() || '';
                const currentUser = getStoredUser();

                if (adminFormStatus) {
                    adminFormStatus.textContent = '';
                    adminFormStatus.classList.remove('error');
                }

                if (adminFormUsername) adminFormUsername.value = username;
                if (adminFormPassword) adminFormPassword.value = '';
                if (adminFormIsAdmin) adminFormIsAdmin.checked = row?.querySelector('[data-role-admin]')?.checked || false;

                const permissionInputs = row?.querySelectorAll('[data-permission]') || [];
                const checkedPermissions = Array.from(permissionInputs)
                    .filter((input) => input.checked)
                    .map((input) => input.getAttribute('data-permission'));

                document.querySelectorAll('[data-permission-option]').forEach((input) => {
                    input.checked = checkedPermissions.includes(input.value);
                });

                if (adminUserForm) {
                    adminUserForm.dataset.editUserId = userId || '';
                    const submitButton = adminUserForm.querySelector('button[type="submit"]');
                    if (submitButton) {
                        submitButton.textContent = 'Guardar cambios';
                    }
                }

                const formTitle = document.querySelector('.admin-add-user-card .admin-card-header h3');
                if (formTitle) formTitle.textContent = 'Editar usuario';
                return;
            }

            const deleteButton = event.target.closest('.admin-delete-user');
            if (!deleteButton) return;

            const userId = deleteButton.getAttribute('data-user-id');
            if (!userId) return;

            const currentUser = getStoredUser();
            if (currentUser && currentUser._id === userId) {
                if (adminFormStatus) {
                    adminFormStatus.textContent = 'No puedes eliminar tu propio usuario.';
                    adminFormStatus.classList.add('error');
                }
                return;
            }

            const row = deleteButton.closest('.admin-user-row');
            const username = row?.querySelector('.admin-user-name')?.textContent?.trim() || 'este usuario';
            const confirmed = window.confirm(`¿Eliminar al usuario "${username}"?`);
            if (!confirmed) return;

            try {
                const requester = getStoredUser();
                if (!requester?._id || !canCurrentUser('manage_users')) {
                    throw new Error('No tienes permiso para gestionar usuarios.');
                }
                const response = await apiFetch(`${API_URL}/users/${userId}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requesterId: requester._id })
                });
                const result = await response.json().catch(() => null);
                if (!response.ok) {
                    throw new Error(result?.error || 'No se pudo eliminar el usuario.');
                }
                if (adminUsersCache && adminUsersCacheOwnerId === String(requester._id)) {
                    adminUsersCache = adminUsersCache.filter(user => String(user._id) !== String(userId));
                }
                await loadAdminUsers();
            } catch (error) {
                console.error(error);
                if (adminFormStatus) {
                    adminFormStatus.textContent = error.message || 'Error al eliminar el usuario.';
                    adminFormStatus.classList.add('error');
                }
            }
        });
    }

    if (adminUsersList && canCurrentUser('manage_users')) {
        loadAdminUsers();
    }

    let popupTimeout = null;
    let isQueueOpen = false;
    let isShuffle = false;
    let currentVolume = 1;
    let maxVolume = Math.min(10, Math.max(1, Number(localStorage.getItem('maxVolume')) || 2));
    if (inputMaxVolume) inputMaxVolume.value = String(Math.round(maxVolume * 100));
    if (volumeSlider) volumeSlider.max = String(maxVolume * 100);
    let customQueue = []; 
    let activeQueueTracks = [];
    let unplayedIndices = [];
    let playbackHistory = [];
    
    let isLyricsMode = false;
    let isAllSongsMode = false;
    let isQuickAddMode = false;
    let isPlaylistViewMode = false;
    let isEditSongMode = false;
    let isEditPlaylistMode = false;
    let isSettingsMode = false;
    let isAdminMode = false;
    let isProfileMode = false;

    let seekSeconds = 5;
    
    let editingPlaylistId = null;
    let activePlaylistId = null;
    let trackToAddIndex = null;
    let editingTrackIndex = null;
    let editingTrackId = null;
    let editingSuggestionId = null;
    let songSaveInProgress = false;
    const pendingCatalogSongs = new Map();
    let editingLyricColors = [];
    let editingLyricColorAssignments = {};
    let selectedLyricColor = '#ff8a00';
    let songSuggestions = [];
    let playlistEditorPreviousView = null;
    let originalEditLyrics = '';
    let lyricsCancelPromptIndex = 0;
    const cancelEditedSongLabel = btnCancelEditedSong?.textContent || 'Cancelar';
    let editPreviewAudio = null;
    let editPreviewObjectUrl = null;
    let resumeAudioAfterEditPreview = false;
    
    let autoSpinTimer = null; 
    let svgRot = 0;
    let spinAf = null;
    let lastSpinFrameAt = 0;
    let isAutoSpinning = false;
    const mergedSvg = merged.querySelector('svg');

    let userPlaylists = [];
    let playlistsRequestSequence = 0;
    let playlistRealtimeRefresh = Promise.resolve();
    const pendingPlaylistTrackChanges = new Set();
    const pendingPlaylistOrderSaves = new Map();
    const pendingSongDeletes = new Set();
    let statusHeartbeatTimer = null;
    let playlistIdPendingShare = null;

    function getSequentialQueueIndices() {
        const anchorTrackId = generalQueueAnchorTrackId || getTrackStorageId(getCurrentTrack());
        const currentPosition = activeQueueTracks.findIndex(track => (
            getTrackStorageId(track) === String(anchorTrackId)
        ));
        if (currentPosition === -1) return [];
        return activeQueueTracks
            .slice(currentPosition + 1)
            .map(track => playlist.indexOf(track))
            .filter(index => index !== -1);
    }

    function shuffleIndices(indices) {
        for (let index = indices.length - 1; index > 0; index -= 1) {
            const randomIndex = Math.floor(Math.random() * (index + 1));
            [indices[index], indices[randomIndex]] = [indices[randomIndex], indices[index]];
        }
        return indices;
    }

    function buildShuffleQueue() {
        const anchorTrackId = generalQueueAnchorTrackId || getTrackStorageId(getCurrentTrack());
        const indices = activeQueueTracks
            .map(track => playlist.indexOf(track))
            .filter(index => index !== -1 && getTrackStorageId(playlist[index]) !== String(anchorTrackId));

        return shuffleIndices(indices);
    }

    function resetPlaybackHistory() {
        playbackHistory = [];
        unplayedIndices = isShuffle ? buildShuffleQueue() : [];
    }
    async function fetchJsonWithRetry(url, options = {}, attempts = 5) {
        let lastError;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                const response = await apiFetch(url, options);
                if (!response.ok) throw new Error(`API respondió con ${response.status}`);
                return await response.json();
            } catch (error) {
                lastError = error;
                if (error?.name === 'OfflineModeError') break;
                if (attempt < attempts - 1) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
        }
        throw lastError;
    }

    function getPlaylistCover(pl) {
        if (pl && pl.photo && pl.photo !== '' && pl.photo !== '/img/vinculo.png') {
            if (pl.localPhoto) return pl.localPhoto;
            if (offlineOnly) return '';
            return pl.photo;
        }
        return '';
    }

    function getSongCover(track) {
        const cover = track?.cover || '';
        if (!cover || cover === '/img/vinculo.png') return '';
        if (track.localCover) return track.localCover;
        if (offlineOnly) return '';
        return cover;
    }

    async function refreshOfflineAudioAvailability() {
        try {
            offlineAudioSongIds = await getOfflineAudioSongIds();
        } catch (error) {
            console.warn('No se pudo actualizar qué canciones están disponibles offline.', error);
        }
    }

    function registerPendingCatalogSong({ name, artist, cover = '', status }) {
        const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const coverObjectUrl = cover instanceof File ? URL.createObjectURL(cover) : '';
        pendingCatalogSongs.set(id, {
            id,
            name,
            artist,
            cover: coverObjectUrl || cover,
            coverObjectUrl,
            status
        });
        renderAllSongs();
        return id;
    }

    function updatePendingCatalogSong(id, status) {
        const pendingSong = pendingCatalogSongs.get(id);
        if (!pendingSong) return;
        pendingSong.status = status;
        renderAllSongs();
    }

    function removePendingCatalogSong(id) {
        const pendingSong = pendingCatalogSongs.get(id);
        if (!pendingSong) return;
        if (pendingSong.coverObjectUrl) URL.revokeObjectURL(pendingSong.coverObjectUrl);
        pendingCatalogSongs.delete(id);
        renderAllSongs();
    }

    async function showSavedCatalogSong(track) {
        const trackId = String(track?._id || '');
        if (!trackId) return;
        const existingIndex = playlist.findIndex(song => String(song._id || song.id) === trackId);
        if (existingIndex < 0) playlist.unshift(track);
        else playlist[existingIndex] = track;
        renderAllSongs();
        const currentUser = getStoredUser();
        if (currentUser?._id) {
            try {
                await saveOfflineLibrary(currentUser._id, playlist);
            } catch (error) {
                console.warn('La canción se guardó, pero no se pudo actualizar el catálogo offline.', error);
            }
        }
    }

    function updateOfflineCacheStatus(message, progress = null) {
        if (offlineCacheStatus) offlineCacheStatus.textContent = message;
        if (offlineCacheProgress && progress) {
            offlineCacheProgress.max = Math.max(1, progress.total);
            offlineCacheProgress.value = Math.min(progress.completed, progress.total);
        }
        if (!offlineDownloadPopup || !offlineDownloadPopupTitle || !offlineDownloadPopupMessage) return;
        const isDownloadUpdate = Boolean(progress)
            || /descarga offline completada|recursos no se pudieron guardar|almacenamiento local lleno|descarga pausada sin conexión/i.test(message);
        if (!isDownloadUpdate) return;
        const isError = /no se pudieron guardar|almacenamiento local lleno/i.test(message);
        const isComplete = /descarga offline completada/i.test(message);
        const percent = progress
            ? progress.total > 0
                ? Math.min(100, (progress.completed / progress.total) * 100)
                : isComplete ? 100 : 0
            : isComplete ? 100 : 0;
        offlineDownloadPopupTitle.textContent = isError
            ? 'Descargas offline'
            : isComplete ? 'Descarga completada' : 'Preparando modo offline';
        offlineDownloadPopupMessage.textContent = message;
        if (offlineDownloadProgressFill) offlineDownloadProgressFill.style.width = `${percent}%`;
        if (offlineDownloadProgressLabel) offlineDownloadProgressLabel.textContent = `${Math.round(percent)}%`;
        offlineDownloadPopup.classList.toggle('error', isError);
        offlineDownloadPopup.hidden = false;
        offlineDownloadPopup.classList.add('active');
        if (offlineDownloadPopupTimer) clearTimeout(offlineDownloadPopupTimer);
        if (isComplete || isError) {
            offlineDownloadPopupTimer = setTimeout(() => {
                offlineDownloadPopup.classList.remove('active');
                offlineDownloadPopup.hidden = true;
            }, isComplete ? 2200 : 4500);
        }
    }

    function getOfflinePreferenceKey(userId) {
        return `amgc-offline-enabled-${userId}`;
    }

    function createImageMarkup(src, className = '', alt = '') {
        if (src) {
            return `<img src="${escapeHtml(src)}" loading="lazy" decoding="async" draggable="false" class="no-drag ${escapeHtml(className)}" alt="${escapeHtml(alt)}" data-fallback-placeholder="true">`;
        }
        return `<div class="no-image-placeholder ${className}" aria-label="Sin imagen">SIN IMG</div>`;
    }

    const handleImageFallback = (event) => {
        const image = event.target;
        if (!(image instanceof HTMLImageElement) || image.dataset.fallbackPlaceholder !== 'true') return;
        const retryCount = Number(image.dataset.fallbackRetryCount || 0);
        const source = image.getAttribute('src');
        if (retryCount < 2 && source) {
            try {
                const retryUrl = new URL(source, window.location.href);
                if (retryUrl.protocol === 'http:' || retryUrl.protocol === 'https:') {
                    const nextRetryCount = retryCount + 1;
                    image.dataset.fallbackRetryCount = String(nextRetryCount);
                    setTimeout(() => {
                        if (!image.isConnected || image.getAttribute('src') !== source) return;
                        retryUrl.searchParams.set('amgcRetry', String(nextRetryCount));
                        image.src = retryUrl.href;
                    }, nextRetryCount * 350);
                    return;
                }
            } catch {
            }
        }
        const placeholder = document.createElement('div');
        placeholder.className = `no-image-placeholder ${[...image.classList]
            .filter(className => className !== 'no-drag' && className !== 'no-image')
            .map(className => className === 'profile-playlist-cover' ? 'profile-playlist-cover-placeholder' : className)
            .join(' ')}`;
        placeholder.textContent = 'SIN FOTO';
        placeholder.setAttribute('aria-label', 'Imagen no disponible');
        image.replaceWith(placeholder);
    };
    document.addEventListener('error', handleImageFallback, true);

    async function savePlaylistsToDB(plData) {
        try {
            const tracks = Array.isArray(plData?.tracks) ? plData.tracks : [];
            const currentUser = getStoredUser();
            const duration = Number(plData?.duration) > 0
                ? Number(plData.duration)
                : tracks.reduce((total, track) => total + Math.max(0, Number(track?.duration) || 0), 0);
            const response = await apiFetch(`${API_URL}/playlists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...plData, userId: currentUser?._id, duration })
            });
            if (!response.ok) {
                const result = await response.json().catch(() => null);
                throw new Error(result?.error || `No se pudo guardar la playlist (${response.status})`);
            }
            return await response.json();
        } catch (e) {
            console.error(e);
            throw e;
        }
    }

    function savePlaylistOrder(plData) {
        const playlistId = String(plData.id);
        const previousSave = pendingPlaylistOrderSaves.get(playlistId) || Promise.resolve();
        const currentSave = previousSave.catch(() => {}).then(() => savePlaylistsToDB(plData));
        pendingPlaylistOrderSaves.set(playlistId, currentSave);
        renderSidebarPlaylists();
        return currentSave.finally(() => {
            if (pendingPlaylistOrderSaves.get(playlistId) === currentSave) {
                pendingPlaylistOrderSaves.delete(playlistId);
                renderSidebarPlaylists();
            }
        });
    }

    async function syncPendingPlaylistAdds() {
        const user = getStoredUser();
        if (!navigator.onLine || offlineOnly || !accessToken || !user?._id) return;
        const userId = String(user._id);
        const token = accessToken;
        const playlistsForSync = userPlaylists;
        const isCurrentSync = () => (
            String(getStoredUser()?._id || '') === userId
            && accessToken === token
            && userPlaylists === playlistsForSync
        );
        for (const pl of playlistsForSync) {
            if (!isCurrentSync()) return;
            for (const track of pl.tracks || []) {
                if (!track.syncPending) continue;
                const playlistId = String(pl.id);
                const songId = String(track._id || track.id || '');
                const changeKey = `${playlistId}:${songId}`;
                if (!songId || pendingPlaylistTrackChanges.has(changeKey)) continue;
                pendingPlaylistTrackChanges.add(changeKey);
                try {
                    const response = await apiFetch(`${API_URL}/playlists/${encodeURIComponent(playlistId)}/tracks`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: user._id, songId })
                    });
                    if (!isCurrentSync()) return;
                    const result = await response.json().catch(() => null);
                    if (!isCurrentSync()) return;
                    if (!response.ok && !/ya está en la playlist/i.test(result?.error || '')) {
                        const error = new Error(result?.error || 'No se pudo sincronizar la canción con la playlist.');
                        error.status = response.status;
                        throw error;
                    }
                    if (Number.isFinite(Number(result?.duration))) pl.duration = Number(result.duration);
                    delete track.syncPending;
                } catch (error) {
                    if (!isCurrentSync()) return;
                    const status = Number(error?.status);
                    if (status >= 400 && status < 500 && ![408, 429].includes(status)) {
                        const trackIndex = (pl.tracks || []).indexOf(track);
                        if (trackIndex >= 0) {
                            pl.tracks.splice(trackIndex, 1);
                            pl.duration = Math.max(0, (Number(pl.duration) || 0) - (Number(track.duration) || 0));
                        }
                        delete track.syncPending;
                        showToast(`No se pudo sincronizar “${track.name || 'la canción'}” en “${pl.name}”.`, true);
                    } else {
                        console.warn(`No se pudo sincronizar la canción pendiente de "${pl.name}".`, error);
                    }
                } finally {
                    pendingPlaylistTrackChanges.delete(changeKey);
                }
            }
        }
        if (!isCurrentSync()) return;
        try {
            await saveOfflinePlaylists(userId, playlistsForSync);
        } catch (error) {
            console.error('No se pudieron guardar los cambios sincronizados de playlists.', error);
        }
        if (isPlaylistViewMode && activePlaylistId) openPlaylistView(activePlaylistId);
        renderSidebarPlaylists();
    }

    async function loadPlaylists() {
        const requestSequence = ++playlistsRequestSequence;
        const user = getStoredUser();
        const isCurrentRequest = () => (
            requestSequence === playlistsRequestSequence
            && String(getStoredUser()?._id || '') === String(user?._id || '')
        );
        try {
            let cachedPlaylists = null;
            if (user?._id) {
                try {
                    cachedPlaylists = await getOfflinePlaylists(user._id);
                } catch (cacheError) {
                    console.warn('No se pudieron leer las playlists locales antes de sincronizar.', cacheError);
                }
                if (!isCurrentRequest()) return;
                if (cachedPlaylists) {
                    const cachedItems = cachedPlaylists.playlists || [];
                    userPlaylists = cachedItems;
                    renderSidebarPlaylists();
                    renderProfile();
                    await hydrateOfflinePlaylistCovers(cachedItems);
                    if (!isCurrentRequest()) return;
                    renderSidebarPlaylists();
                    renderProfile();
                }
            }
            if (user?._id && (offlineOnly || !navigator.onLine)) {
                const loadedPlaylists = cachedPlaylists?.playlists || [];
                userPlaylists = loadedPlaylists;
                renderSidebarPlaylists();
                renderProfile();
                return;
            }
            if (user?._id) {
                const refreshedUser = await fetchJsonWithRetry(`${API_URL}/auth/me`, {}, 2);
                if (!isCurrentRequest()) return;
                setStoredUser({ ...user, ...refreshedUser });
                saveCachedOfflineUser({ ...user, ...refreshedUser });
                syncAccessControls();
            }
            syncAccessControls();
            const query = user?._id ? `?userId=${encodeURIComponent(user._id)}` : '';
            const fetchedPlaylists = await fetchJsonWithRetry(`${API_URL}/playlists${query}`);
            if (!isCurrentRequest()) return;
            const pendingTracksByPlaylist = new Map(userPlaylists.map(item => [
                String(item.id),
                (item.tracks || []).filter(track => track.syncPending)
            ]).filter(([, tracks]) => tracks.length));
            const loadedPlaylists = fetchedPlaylists.map(item => ({
                ...item,
                tracks: [...(item.tracks || [])]
            }));
            loadedPlaylists.forEach(item => {
                (pendingTracksByPlaylist.get(String(item.id)) || []).forEach(track => {
                    if (!(item.tracks || []).some(existing => String(existing._id || existing.id) === String(track._id || track.id))) {
                        item.tracks.push(track);
                    }
                });
            });
            if (user?._id) {
                try {
                    await saveOfflinePlaylists(user._id, loadedPlaylists);
                } catch (error) {
                    console.error('No se pudieron guardar las playlists offline.', error);
                    updateOfflineCacheStatus(`No se pudieron guardar las playlists: ${error.message}`);
                }
            }
            if (!isCurrentRequest()) return;
            userPlaylists = loadedPlaylists;
            renderSidebarPlaylists();
            renderProfile();
            void syncPendingPlaylistAdds();
            syncOfflineResources();
        } catch (e) {
            if (!isCurrentRequest()) return;
            console.warn(e);
            const cachedUser = getCachedOfflineUser();
            const activeUser = getStoredUser();
            if (
                !offlineModeEnabled
                || !cachedUser?._id
                || String(activeUser?._id) !== String(cachedUser._id)
            ) return;
            let cachedPlaylists;
            try {
                cachedPlaylists = await getOfflinePlaylists(cachedUser._id);
            } catch (cacheError) {
                console.error('No se pudieron leer las playlists offline.', cacheError);
                updateOfflineCacheStatus(`No se pudieron leer las playlists guardadas: ${cacheError.message}`);
                return;
            }
            if (!isCurrentRequest()) return;
            if (!cachedPlaylists) return;
            const loadedPlaylists = cachedPlaylists.playlists || [];
            await hydrateOfflinePlaylistCovers(loadedPlaylists);
            if (!isCurrentRequest()) return;
            offlineOnly = true;
            syncOfflineStatusIndicators();
            socket.disconnect();
            startOfflineRecoveryTimer();
            setStoredUser(cachedUser);
            userPlaylists = loadedPlaylists;
            hideAuthOverlay();
            renderSidebarPlaylists();
            renderProfile();
        }
    }

    function isValidYoutubeLink(value) {
        if (!value || typeof value !== 'string') return false;
        try {
            const url = new URL(value.trim());
            const host = url.hostname.replace(/^www\./, '').toLowerCase();
            return host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
        } catch {
            return false;
        }
    }

    function isSlowYoutubeStatusMessage(message = '') {
        return /(tardó demasiado|tardó|sigue en curso|procesando|demora|demor|espere|puede tardar)/i.test(message);
    }

    function showYoutubeLinkStatus(message, isError = false) {
        const safeMessage = message || 'No se pudo procesar el enlace de YouTube.';
        if (statusSettingsYt) {
            statusSettingsYt.style.display = 'block';
            statusSettingsYt.textContent = safeMessage;
            statusSettingsYt.style.color = isError ? '#ff4d4d' : '#ff8a00';
        }
        if (isError && !isSlowYoutubeStatusMessage(safeMessage)) {
            showToast(safeMessage, isError);
        }
    }

    function updateYtDownloadPopup(progress, { title = 'Descargando canción', message = 'Preparando audio...', percent = 0, isError = false, visible = true } = {}) {
        if (!progress?.popup) return;
        progress.title.textContent = title;
        progress.message.textContent = message;
        progress.fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
        progress.label.textContent = `${Math.round(percent)}%`;
        progress.popup.classList.toggle('error', isError);
        progress.popup.classList.toggle('active', visible);
        if (!visible) progress.popup.remove();
    }

    function startYtDownloadProgress(title = 'Descargando canción') {
        if (!ytDownloadPopupTemplate || !downloadNotificationStack) return null;
        const popup = ytDownloadPopupTemplate.cloneNode(true);
        popup.removeAttribute('id');
        popup.removeAttribute('hidden');
        popup.style.removeProperty('display');
        popup.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
        const progress = {
            popup,
            title: popup.querySelector('.yt-download-popup-header strong'),
            message: popup.querySelector('.yt-download-popup-header small'),
            fill: popup.querySelector('.yt-download-progress-fill'),
            label: popup.querySelector('.yt-download-progress-text span'),
            progressTimer: null,
            longWaitTimer: null,
            hideTimer: null
        };
        if (!progress.title || !progress.message || !progress.fill || !progress.label) return null;
        downloadNotificationStack.append(popup);
        let current = 8;
        updateYtDownloadPopup(progress, { title, message: 'Conectando con YouTube...', percent: current, visible: true, isError: false });

        progress.progressTimer = setInterval(() => {
            current = Math.min(current + Math.random() * 8 + 3, 90);
            const progressText = current < 25
                ? 'Solicitando audio a YouTube...'
                : current < 55
                    ? 'Descargando audio...'
                    : current < 85
                        ? 'Convirtiendo a MP3...'
                        : 'Guardando el MP3 localmente...';
            updateYtDownloadPopup(progress, { title, message: progressText, percent: current, visible: true, isError: false });
        }, 800);

        progress.longWaitTimer = setTimeout(() => {
            showYoutubeLinkStatus('La descarga sigue en curso. Esto puede tardar unos segundos más...', false);
        }, 15000);
        return progress;
    }

    function stopYtDownloadProgress(progress, { success = false, message = 'Descarga finalizada', error = false } = {}) {
        if (!progress?.popup) return;
        if (progress.progressTimer) clearInterval(progress.progressTimer);
        if (progress.longWaitTimer) clearTimeout(progress.longWaitTimer);
        if (progress.hideTimer) clearTimeout(progress.hideTimer);
        if (success) {
            updateYtDownloadPopup(progress, { title: 'Canción añadida', message, percent: 100, visible: true, isError: false });
            progress.hideTimer = setTimeout(() => {
                    updateYtDownloadPopup(progress, { visible: false });
            }, 1200);
        } else {
            updateYtDownloadPopup(progress, { title: error ? 'No se pudo descargar' : 'Descarga detenida', message, percent: 100, visible: true, isError: true });
            progress.hideTimer = setTimeout(() => {
                    updateYtDownloadPopup(progress, { visible: false });
            }, 2500);
        }
    }

    let musicDataRequestSequence = 0;
    async function fetchMusicData() {
        const requestSequence = ++musicDataRequestSequence;
        const playbackLoadTokenAtRequestStart = audioSourceLoadToken;
        const userAtRequestStart = getStoredUser();
        const previousCatalogTrackIds = new Set(playlist.map(getTrackStorageId));
        const previousActiveQueueTrackIds = activeQueueTracks.map(getTrackStorageId);
        const previousTracksById = new Map(playlist.map(track => [getTrackStorageId(track), track]));
        const previousShuffleTrackIds = isShuffle
            ? unplayedIndices.map(index => getTrackStorageId(playlist[index])).filter(Boolean)
            : null;
        const previousShuffleHistory = isShuffle
            ? playbackHistory.map(({ index, source }) => ({
                trackId: getTrackStorageId(playlist[index]),
                source
            })).filter(entry => entry.trackId)
            : null;
        const ownsCurrentPlayback = Boolean(
            userAtRequestStart?._id
            && String(playbackActivityUserId || '') === String(userAtRequestStart._id)
        );
        const previousTrackId = ownsCurrentPlayback ? getCurrentTrack()?._id : null;
        const previousPlaybackTime = ownsCurrentPlayback && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        const wasPlayingBeforeRefresh = ownsCurrentPlayback && !audio.paused && !audio.ended;
        let libraryLoaded = false;
        let cachedLibrary = null;
        if (inlineSpinner) inlineSpinner.style.display = 'block';
        if (perroGif) perroGif.style.display = 'none';

        try {
            if (userAtRequestStart?._id) {
                try {
                    cachedLibrary = await getOfflineLibrary(userAtRequestStart._id);
                } catch (cacheError) {
                    console.warn('No se pudo leer el catálogo local antes de sincronizar.', cacheError);
                }
                if (requestSequence !== musicDataRequestSequence) return;
                if (cachedLibrary) {
                    playlist = cachedLibrary.songs || [];
                    libraryLoaded = true;
                    renderAllSongs();
                    await hydrateOfflineSongCovers(playlist);
                    if (requestSequence !== musicDataRequestSequence) return;
                    renderAllSongs();
                }
            }
            if (offlineOnly || !navigator.onLine) {
                if (cachedLibrary) {
                    playlist = cachedLibrary.songs || [];
                    libraryLoaded = true;
                    if (!playlist.length) updateOfflineCacheStatus('No hay canciones guardadas en este dispositivo.');
                }
            } else {
                const data = await fetchJsonWithRetry(`${API_URL}/songs`);
                if (requestSequence !== musicDataRequestSequence) return;
                playlist = data.songs || [];
                libraryLoaded = true;
                if (userAtRequestStart?._id) {
                    try {
                        await saveOfflineLibrary(userAtRequestStart._id, playlist);
                    } catch (error) {
                        console.error('No se pudo guardar el catálogo offline.', error);
                        updateOfflineCacheStatus(`No se pudo guardar el catálogo: ${error.message}`);
                    }
                }
            }
        } catch (e) {
            if (requestSequence !== musicDataRequestSequence) return;
            console.warn(e);
            const cachedUser = getCachedOfflineUser();
            const activeUser = getStoredUser();
            let cachedLibrary = null;
            if (
                offlineModeEnabled
                && cachedUser?._id
                && String(activeUser?._id) === String(cachedUser._id)
            ) {
                try {
                    cachedLibrary = await getOfflineLibrary(cachedUser._id);
                } catch (cacheError) {
                    console.error('No se pudo leer el catálogo offline.', cacheError);
                    updateOfflineCacheStatus(`No se pudo leer el catálogo guardado: ${cacheError.message}`);
                }
            }
            if (cachedLibrary) {
                offlineOnly = true;
                syncOfflineStatusIndicators();
                socket.disconnect();
                startOfflineRecoveryTimer();
                setStoredUser(cachedUser);
                playlist = cachedLibrary.songs || [];
                libraryLoaded = true;
                await hydrateOfflineSongCovers(playlist);
                hideAuthOverlay();
                updateOfflineCacheStatus('Sin conexión: reproduciendo el catálogo guardado en este dispositivo.');
            }
        } finally {
            if (requestSequence === musicDataRequestSequence) {
                if (inlineSpinner) inlineSpinner.style.display = 'none';
                if (perroGif) perroGif.style.display = 'block';
            }
        }

        if (requestSequence !== musicDataRequestSequence) return;
        if (!libraryLoaded) return;
        const selectedTrackId = currentTrackId || previousTrackId;
        let selectedTrackWasRemoved = false;
        if (selectedTrackId) {
            const refreshedTrackIndex = playlist.findIndex(track => String(track._id) === String(selectedTrackId));
            selectedTrackWasRemoved = refreshedTrackIndex === -1;
            currentTrackIndex = refreshedTrackIndex >= 0
                ? refreshedTrackIndex
                : Math.min(currentTrackIndex, Math.max(0, playlist.length - 1));
            currentTrackId = playlist[currentTrackIndex]?._id ?? null;
        } else {
            currentTrackIndex = Math.min(currentTrackIndex, Math.max(0, playlist.length - 1));
        }

        activeQueueTracks = queueName === 'GENERAL'
            ? [...playlist]
            : previousActiveQueueTrackIds
                .map(trackId => playlist.find(track => getTrackStorageId(track) === trackId))
                .filter(Boolean);
        if (selectedTrackWasRemoved) {
            const replacementTrack = activeQueueTracks[0]
                || (queueName === 'GENERAL' ? playlist[0] : null);
            currentTrackIndex = replacementTrack ? playlist.indexOf(replacementTrack) : 0;
            currentTrackId = replacementTrack?._id ?? null;
        }
        if (previousShuffleTrackIds) {
            const indexByTrackId = new Map(playlist.map((track, index) => [getTrackStorageId(track), index]));
            const queuedIndices = new Set();
            unplayedIndices = [];
            previousShuffleTrackIds.forEach(trackId => {
                const index = indexByTrackId.get(trackId);
                if (!Number.isInteger(index) || index === currentTrackIndex || queuedIndices.has(index)) return;
                queuedIndices.add(index);
                unplayedIndices.push(index);
            });
            const newTrackIndices = playlist
                .map((track, index) => ({ trackId: getTrackStorageId(track), index }))
                .filter(({ trackId, index }) => (
                    !previousCatalogTrackIds.has(trackId)
                    && index !== currentTrackIndex
                    && !queuedIndices.has(index)
                ))
                .map(({ index }) => index);
            unplayedIndices.push(...shuffleIndices(newTrackIndices));
            playbackHistory = previousShuffleHistory
                .map(({ trackId, source }) => ({ index: indexByTrackId.get(trackId), source }))
                .filter(entry => Number.isInteger(entry.index));
        } else {
            resetPlaybackHistory();
        }
        if (editingTrackId) {
            editingTrackIndex = playlist.findIndex(track => String(track._id) === editingTrackId);
            const trackStillExists = editingTrackIndex !== -1;
            if (!songSaveInProgress) {
                if (btnSaveEditedSong) btnSaveEditedSong.disabled = !trackStillExists;
                if (btnDeleteSong) btnDeleteSong.disabled = !trackStillExists;
            }
            if (!trackStillExists && isEditSongMode) {
                setEditorStatus(editLyricsStatus, 'Esta canción ya no está en el catálogo. Cancela la edición para continuar.', true);
            }
        }
        await refreshOfflineAudioAvailability();
        renderAllSongs();
        const refreshedCurrentTrack = selectedTrackId
            ? playlist.find(track => String(track._id) === String(selectedTrackId))
            : null;
        const previousCurrentTrack = selectedTrackId
            ? previousTracksById.get(String(selectedTrackId))
            : null;
        const refreshedSource = refreshedCurrentTrack?.path || refreshedCurrentTrack?.audioUrl || '';
        const previousSource = previousCurrentTrack?.path || previousCurrentTrack?.audioUrl || '';
        if (
            selectedTrackWasRemoved
            && ownsCurrentPlayback
            && playbackLoadTokenAtRequestStart === audioSourceLoadToken
            && currentTrackSource !== 'together'
            && !getRemotePlaybackSession()
        ) {
            if (currentTrackId !== null) {
                await loadAndPlayTrack(currentTrackIndex, currentTrackSource, wasPlayingBeforeRefresh);
            } else {
                audio.pause();
                audioSourceLoadToken += 1;
                audio.removeAttribute('src');
                audio.load();
                if (activeAudioObjectUrl) URL.revokeObjectURL(activeAudioObjectUrl);
                if (activeAudioObjectUrlKey) offlineMediaManager.forgetObjectUrl(activeAudioObjectUrlKey);
                activeAudioObjectUrl = null;
                activeAudioObjectUrlKey = null;
                trackNameEl.textContent = '';
                trackArtistEl.textContent = '';
                bottomBarCover.removeAttribute('src');
                bottomBarCover.alt = 'SIN IMG';
                bottomBarCover.classList.add('no-image');
                updateDiscordPresence();
            }
        }
        if (
            refreshedCurrentTrack
            && previousSource
            && refreshedSource !== previousSource
            && playbackLoadTokenAtRequestStart === audioSourceLoadToken
            && !offlineOnly
            && currentTrackSource !== 'together'
            && !getRemotePlaybackSession()
        ) {
            const refreshedIndex = playlist.indexOf(refreshedCurrentTrack);
            await loadAndPlayTrack(
                refreshedIndex,
                currentTrackSource,
                !audio.paused && !audio.ended,
                Number.isFinite(audio.currentTime) ? audio.currentTime : 0
            );
        }
        if (
            playlist.length > 0
            && !audio.src
            && playbackLoadTokenAtRequestStart === audioSourceLoadToken
            && userAtRequestStart?._id
        ) {
            const user = userAtRequestStart;
            let savedPlayback = null;
            if (user?._id) {
                try {
                    savedPlayback = JSON.parse(localStorage.getItem(`amgc-last-playback-${user._id}`) || 'null');
                } catch {
                    savedPlayback = null;
                }
            }
            const savedIndex = savedPlayback?.songId
                ? playlist.findIndex(track => String(track._id) === String(savedPlayback.songId))
                : -1;
            const initialIndex = savedIndex >= 0 ? savedIndex : 0;
            isRestoringInitialPlayback = true;
            suppressStartupPlaybackUpdates = true;
            const restorePosition = () => {
                const restoredTime = Math.max(0, Math.min(
                    Number(savedPlayback?.currentTime) || 0,
                    Number.isFinite(audio.duration) ? audio.duration : Number(savedPlayback?.currentTime) || 0
                ));
                audio.currentTime = restoredTime;
                playbackUiTime = restoredTime;
                sharedPlaybackTime = restoredTime;
                sharedPlaybackDuration = Number.isFinite(audio.duration) ? audio.duration : Number(playlist[initialIndex]?.duration) || 0;
                sharedPlaybackPlaying = false;
                isRestoringInitialPlayback = false;
                updateTrackDurationLabel(restoredTime, sharedPlaybackDuration);
                if (isProfileMode) updateProfileActivityProgress();
                if (isProfileMode) renderProfile();
            };
            audio.addEventListener('loadedmetadata', restorePosition, { once: true });
            loadAndPlayTrack(initialIndex, 'regular', false);
        }

        await loadPlaylists();
        if (
            offlineOnly
            && previousTrackId
            && !audio.src.startsWith('blob:')
        ) {
            const cachedTrackIndex = playlist.findIndex(track => String(track._id) === String(previousTrackId));
            if (cachedTrackIndex >= 0) {
                const cachedTrack = playlist[cachedTrackIndex];
                try {
                    const cachedAudioUrl = await getOfflineObjectUrl(
                        `song:${cachedTrack._id}:audio`,
                        cachedTrack.path || cachedTrack.audioUrl
                    );
                    if (!cachedAudioUrl) {
                        showToast(`"${cachedTrack.name}" no está descargada para reproducirse sin conexión.`, true);
                    } else if (
                        offlineOnly
                        && String(getCurrentTrack()?._id) === String(previousTrackId)
                    ) {
                        const restoreCachedPosition = () => {
                            const restoredTime = Math.min(
                                previousPlaybackTime,
                                Number.isFinite(audio.duration) ? audio.duration : previousPlaybackTime
                            );
                            audio.currentTime = restoredTime;
                            playbackUiTime = restoredTime;
                            sharedPlaybackTime = restoredTime;
                            updateTrackDurationLabel(restoredTime, Number.isFinite(audio.duration)
                                ? audio.duration
                                : Number(cachedTrack.duration) || 0);
                        };
                        const handleCachedMetadata = () => {
                            clearRestoreListeners();
                            restoreCachedPosition();
                        };
                        const clearRestoreListeners = () => {
                            audio.removeEventListener('loadedmetadata', handleCachedMetadata);
                            audio.removeEventListener('error', clearRestoreListeners);
                        };
                        audio.addEventListener('loadedmetadata', handleCachedMetadata, { once: true });
                        audio.addEventListener('error', clearRestoreListeners, { once: true });
                        loadAndPlayTrack(cachedTrackIndex, currentTrackSource, wasPlayingBeforeRefresh);
                    }
                } catch (error) {
                    console.error('No se pudo continuar la canción desde la caché offline.', error);
                    showToast('No se pudo continuar la canción guardada sin conexión.', true);
                }
            }
        }
        syncOfflineResources();
    }

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.song-actions-wrapper')) {
            document.querySelectorAll('.song-actions-menu').forEach(m => m.classList.remove('show'));
            document.querySelectorAll('.all-songs-item, .playlist-track-row, .queue-item').forEach(el => el.style.zIndex = '1');
        }
        if (sidebarShell && sidebarShell.classList.contains('open') && !e.target.closest('.sidebar-shell')) {
            sidebarShell.classList.remove('open');
        }
    });

    if (sidebarTrigger) {
        sidebarTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebarShell.classList.toggle('open');
        });
    }

    const closeSidebar = () => {
        if (sidebarShell && sidebarShell.classList.contains('open')) {
            sidebarShell.classList.remove('open');
        }
    };

    if (btnHome) {
        btnHome.addEventListener('click', () => {
            const returningToHome = isAllSongsMode || isLyricsMode || isPlaylistViewMode
                || isEditSongMode || isEditPlaylistMode || isSettingsMode || isAdminMode || isProfileMode;
            isAllSongsMode = false;
            isLyricsMode = false;
            isPlaylistViewMode = false;
            isEditSongMode = false;
            isEditPlaylistMode = false;
            isSettingsMode = false;
            isAdminMode = false;
            isProfileMode = false;
            updateBackgroundAndViews();
            if (returningToHome) showRandomSecretPhrase();
            closeSidebar();
        });
    }

    const openProfile = (userId = null) => {
        if (userId) {
            const current = getStoredUser();
            if (current?._id && String(current._id) !== String(userId)) {
                openFriendProfile(userId);
                return;
            }
        }
        selectedProfileUser = null;
        publicProfilePlaylists = null;
        isProfileMode = true;
        isAllSongsMode = false;
        isLyricsMode = false;
        isPlaylistViewMode = false;
        isEditSongMode = false;
        isEditPlaylistMode = false;
        isSettingsMode = false;
        isAdminMode = false;
        renderProfile();
        updateBackgroundAndViews();
        closeSidebar();
    };

    if (btnProfile) btnProfile.addEventListener('click', () => openProfile());
    if (btnCloseProfile) btnCloseProfile.addEventListener('click', () => {
        selectedProfileUser = null;
        isProfileMode = false;
        updateBackgroundAndViews();
        showRandomSecretPhrase();
    });

    const doSpin = timestamp => {
        if (!isAutoSpinning || document.hidden) {
            spinAf = null;
            return;
        }
        if (!lastSpinFrameAt || timestamp - lastSpinFrameAt >= 1000 / 30) {
            const elapsed = lastSpinFrameAt ? Math.min(timestamp - lastSpinFrameAt, 100) : 1000 / 30;
            svgRot += 9 * elapsed / 1000;
            mergedSvg.style.transform = `rotate(${svgRot}deg)`;
            lastSpinFrameAt = timestamp;
        }
        spinAf = requestAnimationFrame(doSpin);
    };

    const startSpin = () => {
        if (isAutoSpinning) return;
        isAutoSpinning = true;
        lastSpinFrameAt = 0;
        mergedSvg.style.transition = 'none';
        if (!document.hidden) spinAf = requestAnimationFrame(doSpin);
    };

    const stopSpin = () => {
        if (!isAutoSpinning) return;
        isAutoSpinning = false;
        cancelAnimationFrame(spinAf);
        spinAf = null;
        lastSpinFrameAt = 0;
        const remainder = svgRot % 360;
        let targetRot = svgRot - remainder;
        if (remainder > 180) targetRot += 360; 
        mergedSvg.style.transition = 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)';
        mergedSvg.style.transform = `rotate(${targetRot}deg)`;
        setTimeout(() => {
            if (!isAutoSpinning) {
                mergedSvg.style.transition = 'none';
                svgRot = 0;
                mergedSvg.style.transform = `rotate(0deg)`;
            }
        }, 450);
    };

    const resetAutoSpin = () => {
        if (autoSpinTimer) clearTimeout(autoSpinTimer);
        stopSpin();
        autoSpinTimer = setTimeout(() => startSpin(), 10000);
    };

    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.preservesPitch = true;
    audio.volume = currentVolume;
    function isExpectedAudioPlayInterruption(error) {
        return error?.name === 'AbortError'
            || /play\(\) request was interrupted by a call to (?:pause|load)/i.test(error?.message || '');
    }

    function isCurrentAudioSource(track) {
        if (!track || !audio.src || !track.path) return false;
        if (audio.src.startsWith('blob:')) {
            return activeAudioObjectUrlKey === `song:${track._id}:audio`;
        }
        try {
            return new URL(audio.src, window.location.href).href
                === new URL(track.path, window.location.href).href;
        } catch {
            return false;
        }
    }
    const resolveDiscordArtworkUrl = track => {
        if (offlineOnly || !navigator.onLine || !accessToken || !track?.cover
            || track.cover === '/img/vinculo.png') return null;
        try {
            const apiOrigin = new URL(API_URL, window.location.href).origin;
            const artworkUrl = new URL(track.cover, `${apiOrigin}/`);
            if (artworkUrl.protocol !== 'https:' || artworkUrl.username || artworkUrl.password) return null;
            if (artworkUrl.origin === apiOrigin
                && /^\/(?:api\/)?spotify\/cover$/.test(artworkUrl.pathname)) {
                const spotifyCoverUrl = artworkUrl.searchParams.get('url');
                if (!spotifyCoverUrl) return null;
                const directCoverUrl = new URL(spotifyCoverUrl);
                if (directCoverUrl.protocol === 'https:'
                    && directCoverUrl.hostname.toLowerCase() === 'i.scdn.co'
                    && !directCoverUrl.username && !directCoverUrl.password
                    && (!directCoverUrl.port || directCoverUrl.port === '443')) {
                    return directCoverUrl.href;
                }
                return null;
            }
            const driveFileId = (artworkUrl.origin === apiOrigin
                ? artworkUrl.pathname.match(/^\/(?:api\/)?media\/([\w-]{25,})$/)?.[1]
                : null)
                || (/^(?:drive\.google\.com|drive\.usercontent\.google\.com)$/i.test(artworkUrl.hostname)
                    ? artworkUrl.searchParams.get('id')
                        || artworkUrl.pathname.match(/\/file\/d\/([\w-]+)/)?.[1]
                    : null);
            if (driveFileId && /^[\w-]{25,}$/.test(driveFileId)) {
                return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveFileId)}`;
            }
            if (artworkUrl.hostname.toLowerCase() === 'i.scdn.co'
                && (!artworkUrl.port || artworkUrl.port === '443')) return artworkUrl.href;
            return artworkUrl.origin === apiOrigin ? artworkUrl.href : null;
        } catch (error) {
            console.warn('La URL de portada para Discord no es válida.', error);
            return null;
        }
    };
    let lastDiscordPresenceSignature = null;
    let discordPresenceRequestSequence = 0;
    const updateDiscordPresence = () => {
        if (!desktopSetDiscordPresence) return;
        const track = getCurrentTrack();
        if (!track || !isCurrentAudioSource(track)) return;
        const hasCurrentMetadata = audio.readyState >= HTMLMediaElement.HAVE_METADATA;
        const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        const duration = hasCurrentMetadata && Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : Number(track.duration) || 0;
        const discordImageText = getStoredUser()?.settings?.discordImageText;
        const largeImageUrl = resolveDiscordArtworkUrl(track);
        const isPlaying = !audio.paused && !audio.ended;
        const signature = JSON.stringify([
            getTrackStorageId(track),
            isPlaying,
            Math.floor(currentTime),
            duration,
            largeImageUrl,
            typeof discordImageText === 'string' ? discordImageText : 'amgc'
        ]);
        if (signature === lastDiscordPresenceSignature) return;
        lastDiscordPresenceSignature = signature;
        const requestSequence = ++discordPresenceRequestSequence;
        const statusPromise = desktopSetDiscordPresence({
            songName: track.name || 'Canción desconocida',
            artist: track.artist || 'Artista desconocido',
            currentTime,
            duration,
            isPlaying,
            largeImageUrl,
            discordImageText: typeof discordImageText === 'string'
                ? discordImageText
                : 'amgc'
        });
        void statusPromise.then(status => {
            if (requestSequence !== discordPresenceRequestSequence) return;
            if (status && (!status.configured || !status.connected || !status.published)) {
                console.warn('Discord Rich Presence no está activa:', status);
            }
        }).catch(error => {
            if (requestSequence !== discordPresenceRequestSequence) return;
            console.warn('No se pudo actualizar Discord Rich Presence.', error);
        });
    };
    if (editLyricsPreview) {
        editLyricsPreview.addEventListener('contextmenu', event => {
            const clickedWord = event.target.closest('.lyric-word');
            const lyricLine = clickedWord?.closest('[data-lyric-color-key]');
            if (
                !clickedWord
                || !clickedWord.closest('.lyric-highlight')
                || !lyricLine
                || editingLyricColors.length === 0
            ) return;
            event.preventDefault();
            cycleEditedLyricWordColor(
                lyricLine.dataset.lyricColorKey,
                Number(clickedWord.dataset.lyricWordIndex)
            );
        });
        editLyricsPreview.addEventListener('click', event => {
            const clickedWord = event.target.closest('[data-lyric-word-index]');
            if (clickedWord) {
                const lyricLine = clickedWord.closest('[data-lyric-index]');
                if (lyricLine) {
                    toggleEditedLyricWord(
                        Number(lyricLine.dataset.sourceLineIndex),
                        Number(clickedWord.dataset.lyricWordIndex)
                    );
                }
                return;
            }
            if (!event.target.closest('.timed-lyric-timestamp')) return;
            const seekButton = event.target.closest('[data-lyric-time]');
            const time = Number(seekButton?.dataset.lyricTime);
            if (!Number.isFinite(time)) return;
            if (editPreviewAudio) {
                seekAudioToTime(editPreviewAudio, time, updateEditLyricsPreview);
                return;
            }
            const track = getEditedTrack();
            if (!track || getTrackStorageId(track) !== getTrackStorageId(getCurrentTrack())) {
                setEditorStatus(editLyricsStatus, 'Reproduce esta canción para comparar el tiempo de la letra.', true);
                return;
            }
            seekAudioToTime(audio, time, () => {
                updateCurrentLyric(track, audio.currentTime);
                updateEditLyricsPreview();
            });
        });
    }
    syncSecretPhrasesFromUser(getStoredUser());
    syncDiscordImageTextFromUser(getStoredUser());
    void loadSecretPhrases().catch(error => {
        console.warn('No se pudieron cargar las frases globales.', error);
    });

    if (secretPhrasesPersonalToggle) {
        secretPhrasesPersonalToggle.addEventListener('change', () => {
            const user = getStoredUser();
            const nextPhrases = secretPhrasesPersonalToggle.checked
                ? user?.settings?.secretPhrases || []
                : globalSecretPhrases;
            if (secretPhrasesInput) secretPhrasesInput.value = nextPhrases.join('\n');
        });
    }

    socket.off('secretPhrasesChanged').on('secretPhrasesChanged', () => {
        void loadSecretPhrases().catch(error => {
            console.warn('No se pudieron actualizar las frases globales.', error);
        });
    });

    if (btnSaveSecretPhrases) {
        btnSaveSecretPhrases.addEventListener('click', async () => {
            const phrases = (secretPhrasesInput?.value || '').split(/\r?\n/).map(phrase => phrase.trim()).filter(Boolean);
            const user = getStoredUser();
            if (!user?._id) {
                setEditorStatus(secretPhrasesStatus, 'Inicia sesión para guardar tus frases secretas.', true);
                return;
            }

            btnSaveSecretPhrases.disabled = true;
            setEditorStatus(secretPhrasesStatus, 'Guardando frases...');
            try {
                const response = await apiFetch(`${API_URL}/secret-phrases`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        phrases,
                        personal: secretPhrasesPersonalToggle?.checked === true
                    })
                });
                const result = await response.json().catch(() => null);
                if (!response.ok) throw new Error(result?.error || 'No se pudieron guardar las frases secretas.');
                if (!Array.isArray(result?.globalPhrases)
                    || !result.globalPhrases.every(phrase => typeof phrase === 'string')
                    || !Array.isArray(result?.personalPhrases)
                    || !result.personalPhrases.every(phrase => typeof phrase === 'string')
                    || typeof result.personal !== 'boolean') {
                    throw new Error('El servidor devolvió una respuesta no válida al guardar las frases.');
                }
                globalSecretPhrases = result.globalPhrases;
                const updatedUser = {
                    ...user,
                    settings: {
                        ...user.settings,
                        secretPhrases: result.personalPhrases,
                        secretPhrasesPersonal: result.personal
                    }
                };
                setStoredUser(updatedUser);
                syncSecretPhrasesFromUser(updatedUser);
                const scopeLabel = result.personal ? 'personales' : 'globales';
                setEditorStatus(
                    secretPhrasesStatus,
                    phrases.length ? `${phrases.length} frases ${scopeLabel} guardadas.` : `Lista de frases ${scopeLabel} vacía.`
                );
            } catch (error) {
                console.error('No se pudieron guardar las frases secretas.', error);
                setEditorStatus(secretPhrasesStatus, error.message || 'No se pudieron guardar las frases secretas.', true);
            } finally {
                btnSaveSecretPhrases.disabled = false;
            }
        });
    }

    if (btnSaveDiscordPresenceImageText) {
        btnSaveDiscordPresenceImageText.addEventListener('click', async () => {
            const user = getStoredUser();
            if (!user?._id) {
                setEditorStatus(discordPresenceImageTextStatus, 'Inicia sesión para guardar este ajuste.', true);
                return;
            }
            const discordImageText = (discordPresenceImageTextInput?.value || '').trim();
            if (discordImageText.length > 128) {
                setEditorStatus(discordPresenceImageTextStatus, 'El texto no puede superar 128 caracteres.', true);
                return;
            }
            btnSaveDiscordPresenceImageText.disabled = true;
            setEditorStatus(discordPresenceImageTextStatus, 'Guardando texto...');
            try {
                const response = await apiFetch(`${API_URL}/users/settings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: user._id,
                        settings: { ...user.settings, discordImageText }
                    })
                });
                const result = await response.json().catch(() => null);
                if (!response.ok) throw new Error(result?.error || 'No se pudo guardar el texto de Discord.');
                setStoredUser({ ...user, settings: result });
                updateDiscordPresence();
                setEditorStatus(discordPresenceImageTextStatus, discordImageText ? 'Texto guardado.' : 'Texto eliminado.');
            } catch (error) {
                console.error('No se pudo guardar el texto de Discord.', error);
                setEditorStatus(discordPresenceImageTextStatus, error.message || 'No se pudo guardar el texto de Discord.', true);
            } finally {
                btnSaveDiscordPresenceImageText.disabled = false;
            }
        });
    }

    audio.addEventListener('loadedmetadata', () => {
        updateDiscordPresence();
        sharedPlaybackDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
        if (isProfileMode) renderProfile();
    });
    renderProfile();
    fetchMusicData();

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    getBoomAudioBuffer(audioCtx).catch(error => {
        boomAudioBufferPromise = null;
        console.warn('No se pudo precargar airhorn.mp3.', error);
    });
    const gainNode = audioCtx.createGain();
    const compressor = audioCtx.createDynamicsCompressor();

    compressor.threshold.setValueAtTime(-16, audioCtx.currentTime);
    compressor.knee.setValueAtTime(30, audioCtx.currentTime);
    compressor.ratio.setValueAtTime(4, audioCtx.currentTime);
    compressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
    compressor.release.setValueAtTime(0.25, audioCtx.currentTime);

    const source = audioCtx.createMediaElementSource(audio);
    source.connect(gainNode);
    gainNode.connect(compressor);
    compressor.connect(audioCtx.destination);   
    gainNode.gain.value = currentVolume;

    const unlockAudio = () => {
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().then(() => {
                if (audioCtx.state !== 'running') return;
                document.removeEventListener('click', unlockAudio);
                document.removeEventListener('pointerdown', unlockAudio);
                document.removeEventListener('keydown', unlockAudio);
            }).catch(error => console.warn('No se pudo habilitar la reproducción de audio.', error));
        } else {
            document.removeEventListener('click', unlockAudio);
            document.removeEventListener('pointerdown', unlockAudio);
            document.removeEventListener('keydown', unlockAudio);
        }
    };
    document.addEventListener('click', unlockAudio);
    document.addEventListener('pointerdown', unlockAudio);
    document.addEventListener('keydown', unlockAudio);

    function hideAllModals() {
        modalOverlay.classList.remove('active');
        addToPlModal.classList.remove('active');
        shareModal?.classList.remove('active');
        manageMembersModal?.classList.remove('active');
        playlistSaversModal?.classList.remove('active');
    }

    function createSongContextMenuHtml(i, isSongsTab = false) {
        const editBtnHtml = isSongsTab && canCurrentUser('edit_songs') ? `<button class="action-edit" data-index="${i}">Editar canción</button>` : '';
        const copyBtnHtml = isSongsTab ? `<button class="action-copy" data-index="${i}">Copiar nombre y artista</button>` : '';
        return `
            <div class="song-actions-wrapper" style="display:flex; gap:8px; align-items:center;">
                <button class="song-actions-btn" data-index="${i}" type="button" style="background:transparent; border:none; cursor:pointer; color: white; font-size: 1.4rem; padding: 0 5px;" title="Opciones">
                    ⋮
                </button>
                <div class="song-actions-menu">
                    ${copyBtnHtml}
                    <button class="action-add-queue" data-index="${i}">Añadir a cola</button>
                    <button class="action-add-pl" data-index="${i}">Añadir a playlist</button>
                    ${editBtnHtml}
                </div>
            </div>
        `;
    }

    function positionSongActionsMenu(menu, wrapper) {
        menu.classList.remove('opens-up');
        menu.classList.add('show');

        const wrapperRect = wrapper.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const playerTop = bottomBarWrapper?.getBoundingClientRect().top ?? window.innerHeight;
        const bottomLimit = Math.min(playerTop, window.innerHeight) - 8;
        const hasRoomBelow = wrapperRect.bottom + menuRect.height <= bottomLimit;
        const hasRoomAbove = wrapperRect.top - menuRect.height >= 8;

        if (!hasRoomBelow && hasRoomAbove) {
            menu.classList.add('opens-up');
        }
    }

    function publishSharedQueueSnapshot() {
        if (
            sharedQueueRole !== 'host'
            || !sharedQueueSessionId
            || !socket.connected
        ) return;
        const sourceIndices = isShuffle ? [...unplayedIndices] : getSequentialQueueIndices();
        const sourceSongIds = sourceIndices
            .map(index => playlist[index])
            .map(track => String(track?._id || track?.id || ''))
            .filter(Boolean);
        const songIds = sourceSongIds.slice(0, 5000);
        const upcomingSongIds = getAccountQueueSongIds();
        const sharedQueueName = sharedQueueJamActive ? sharedQueueHostQueueName : queueName;
        const signature = `${sharedQueueSessionId}:${sharedQueueName}:${songIds.join(',')}:${upcomingSongIds.join(',')}`;
        if (signature === lastSharedQueueSnapshot) return;
        lastSharedQueueSnapshot = signature;
        socket.emit('listenTogetherQueueSnapshot', {
            sessionId: sharedQueueSessionId,
            songIds,
            upcomingSongIds,
            queueName: sharedQueueName
        }, response => {
            if (response?.success) {
                if (Number.isInteger(response.revision)) {
                    sharedQueueSnapshotRevision = Math.max(sharedQueueSnapshotRevision, response.revision);
                }
                return;
            }
            if (lastSharedQueueSnapshot === signature) lastSharedQueueSnapshot = null;
            showToast(response?.error || 'No se pudo sincronizar la cola compartida.', true);
        });
    }

    function renderJamControls() {
        if (!queueJamControls || !btnRequestJam) return;
        const isFollower = sharedQueueRole === 'follower' && Boolean(listeningTogetherUserId);
        const jamActive = sharedQueueJamActive;
        queueJamControls.hidden = !isFollower || jamActive;
        if (!isFollower || jamActive) return;
        btnRequestJam.disabled = sharedQueueJamRequestPending
            || sharedQueueSnapshotRevision < 1
            || !isFollowingPlayback()
            || !socket.connected;
        btnRequestJam.setAttribute(
            'aria-label',
            sharedQueueJamRequestPending ? 'Esperando respuesta a la propuesta de Jam' : 'Proponer Jam'
        );
        btnRequestJam.title = sharedQueueJamRequestPending
            ? 'Esperando respuesta a la propuesta de Jam'
            : 'Proponer Jam';
        btnRequestJam.innerHTML = sharedQueueJamRequestPending
            ? '<span class="sync-spinner" aria-hidden="true"></span>'
            : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17V5l11-2v12M10 17c0 1.7-1.6 3-3.5 3S3 19 3 17.5 4.6 15 6.5 15s3.5.9 3.5 2Zm11-2c0 1.7-1.6 3-3.5 3S14 17 14 15.5s1.6-2.5 3.5-2.5 3.5.9 3.5 2Zm-4-10v5m-2.5-2.5h5"/></svg>';
    }

    function showJamRequestNotification(requestId, followerId) {
        if (
            sharedQueueRole !== 'host'
            || !sharedQueueSessionId
            || !requestId
            || !jamRequestNotification
            || !jamRequestMessage
        ) return;
        hostJamRequestId = String(requestId);
        const follower = currentFriends.find(friend => String(friend._id) === String(followerId));
        jamRequestMessage.textContent = `${follower?.username || 'Un amigo'} quiere controlar la reproducción contigo.`;
        jamRequestNotification.hidden = false;
        btnAcceptJamRequest?.focus();
    }

    function closeJamRequestNotification(requestId = null) {
        if (requestId && String(requestId) !== String(hostJamRequestId || '')) return;
        hostJamRequestId = null;
        if (jamRequestNotification) jamRequestNotification.hidden = true;
        if (btnAcceptJamRequest) btnAcceptJamRequest.disabled = false;
        if (btnDeclineJamRequest) btnDeclineJamRequest.disabled = false;
    }

    function requestJamResponse(accepted) {
        if (!sharedQueueSessionId || !hostJamRequestId || !socket.connected) return;
        const sessionId = sharedQueueSessionId;
        const requestId = hostJamRequestId;
        if (btnAcceptJamRequest) btnAcceptJamRequest.disabled = true;
        if (btnDeclineJamRequest) btnDeclineJamRequest.disabled = true;
        socket.timeout(7000).emit('listenTogetherJamResponse', {
            sessionId,
            requestId,
            accepted
        }, (timeoutError, response) => {
            if (sessionId !== sharedQueueSessionId || requestId !== hostJamRequestId) return;
            if (!response?.success) {
                if (btnAcceptJamRequest) btnAcceptJamRequest.disabled = false;
                if (btnDeclineJamRequest) btnDeclineJamRequest.disabled = false;
                showToast(response?.error || (timeoutError
                    ? 'No se pudo responder a la solicitud de Jam.'
                    : 'La solicitud de Jam ya no está disponible.'), true);
                return;
            }
            closeJamRequestNotification(requestId);
        });
    }

    function requestJam() {
        if (
            sharedQueueRole !== 'follower'
            || !isFollowingPlayback()
            || !sharedQueueSessionId
            || sharedQueueSnapshotRevision < 1
            || sharedQueueJamRequestPending
            || sharedQueueJamActive
        ) return;
        const sessionId = sharedQueueSessionId;
        sharedQueueJamRequestPending = true;
        renderJamControls();
        socket.timeout(7000).emit('listenTogetherJamRequest', { sessionId }, (timeoutError, response) => {
            if (sessionId !== sharedQueueSessionId) return;
            if (!response?.success) {
                sharedQueueJamRequestPending = false;
                renderJamControls();
                showToast(response?.error || (timeoutError
                    ? 'No se pudo enviar la solicitud de Jam.'
                    : 'No se pudo proponer la Jam.'), true);
                return;
            }
            sharedQueueJamRequestId = String(response.requestId || '');
            renderJamControls();
        });
    }

    function applyJamQueue(songIds, { hostCommand = false } = {}) {
        if (!Array.isArray(songIds) || songIds.length > 5000) return false;
        const tracks = songIds.map(songId => (
            playlist.find(track => String(track._id || track.id) === String(songId))
        ));
        if (tracks.some(track => !track)) return false;
        if (hostCommand) {
            const currentTrack = getCurrentTrack();
            const currentTrackId = getTrackStorageId(currentTrack);
            const currentPosition = activeQueueTracks.findIndex(track => (
                getTrackStorageId(track) === currentTrackId
            ));
            const playedTracks = currentPosition >= 0
                ? activeQueueTracks.slice(0, currentPosition + 1)
                : currentTrack ? [currentTrack] : [];
            activeQueueTracks = [...playedTracks, ...tracks];
            queueName = sharedQueueHostQueueName || queueName || 'GENERAL';
            isShuffle = false;
            unplayedIndices = [];
            generalQueueAnchorTrackId = currentTrackId || null;
            lastSharedQueueSnapshot = null;
        }
        renderQueue({ syncAccount: false, syncShared: false });
        return true;
    }

    function applyJamUpcomingQueue(songIds, { hostCommand = false } = {}) {
        if (!Array.isArray(songIds) || songIds.length > 5000) return false;
        const tracks = songIds.map(songId => (
            playlist.find(track => String(track._id || track.id) === String(songId))
        ));
        if (tracks.some(track => !track)) return false;
        sharedQueueUpcomingIds = songIds.map(String);
        if (hostCommand) {
            customQueue = tracks;
            lastSharedQueueSnapshot = null;
        }
        renderQueue({ syncAccount: false, syncShared: false });
        return true;
    }

    function requestJamQueueUpdate(songIds) {
        if (
            sharedQueueRole !== 'follower'
            || !sharedQueueJamActive
            || !sharedQueueSessionId
            || sharedQueueJamUpdateInFlight
            || songIds.length > 5000
        ) return;
        const normalizedSongIds = songIds.map(String);
        const tracks = normalizedSongIds.map(songId => (
            playlist.find(track => String(track._id || track.id) === songId)
        ));
        if (tracks.some(track => !track)) {
            showToast('Una canción de la cola no está disponible en este dispositivo.', true);
            return;
        }
        const socketForRequest = socket;
        const sessionId = sharedQueueSessionId;
        const revision = sharedQueueSnapshotRevision;
        const signature = normalizedSongIds.join(',');
        sharedQueueJamUpdateInFlight = true;
        sharedQueueJamPendingUpcomingIds = normalizedSongIds;
        renderQueue({ syncAccount: false });
        socketForRequest.timeout(9000).emit('listenTogetherJamQueueUpdateRequest', {
            sessionId,
            revision,
            songIds: normalizedSongIds
        }, (timeoutError, response) => {
            if (socketForRequest !== socket || sessionId !== sharedQueueSessionId) return;
            sharedQueueJamUpdateInFlight = false;
            if (response?.success) {
                sharedQueueSnapshotRevision = Math.max(
                    sharedQueueSnapshotRevision,
                    Number(response.revision) || 0
                );
                if (sharedQueueJamPendingUpcomingIds?.join(',') === signature) {
                    sharedQueueUpcomingIds = normalizedSongIds;
                    sharedQueueJamPendingUpcomingIds = null;
                }
                renderQueue({ syncAccount: false });
                return;
            }
            if (Array.isArray(response?.upcomingSongIds)) {
                sharedQueueUpcomingIds = response.upcomingSongIds.map(String);
                sharedQueueSnapshotRevision = Number(response.revision) || sharedQueueSnapshotRevision;
            } else {
                socket.emit('listenTogetherQueueSnapshotRequest', { sessionId });
            }
            sharedQueueJamPendingUpcomingIds = null;
            renderQueue({ syncAccount: false });
            showToast(response?.error || (timeoutError
                ? 'El anfitrión no confirmó el cambio de la cola.'
                : 'No se pudo actualizar la cola de la Jam.'), true);
        });
    }

    function requestJamPlayback(action, songId = '', queueKind = 'source') {
        if (
            sharedQueueRole !== 'follower'
            || !sharedQueueJamActive
            || !sharedQueueSessionId
        ) return;
        if (sharedQueueJamUpdateInFlight) {
            showToast('Espera a que se sincronice el cambio de la cola.', true);
            return;
        }
        const sessionId = sharedQueueSessionId;
        socket.timeout(8000).emit('listenTogetherJamPlaybackRequest', {
            sessionId,
            action,
            songId,
            queueKind
        }, (timeoutError, response) => {
            if (sessionId !== sharedQueueSessionId) return;
            if (!response?.success) {
                showToast(response?.error || (timeoutError
                    ? 'El anfitrión no respondió al control.'
                    : 'No se pudo controlar la reproducción.'), true);
            }
        });
    }

    function joinListenTogetherQueue(hostId, quiet = false) {
        if (!hostId || !socket.connected) {
            if (!quiet) showToast('No se pudo conectar con la cola compartida.', true);
            return;
        }
        if (sharedQueueRole === 'follower' && sharedQueueSessionId) return;
        if (sharedQueueJoinPending) return;
        if (!sharedQueueSavedLocalQueue && sharedQueueRole !== 'follower') {
            sharedQueueSavedLocalQueue = [...customQueue];
        }
        sharedQueueJoinPending = true;
        socket.emit('listenTogetherQueueSessionJoin', { hostId: String(hostId) }, response => {
            sharedQueueJoinPending = false;
            if (!response?.success || !response.sessionId) {
                if (sharedQueueRole !== 'follower' && !sharedQueueSessionId) {
                    sharedQueueSavedLocalQueue = null;
                }
                if (String(listeningTogetherUserId || '') === String(hostId)) {
                    if (quiet) console.warn(response?.error || 'No se pudo sincronizar la cola compartida.');
                    else showToast(response?.error || 'No se pudo sincronizar la cola compartida.', true);
                }
                return;
            }
            if (String(listeningTogetherUserId || '') !== String(hostId)) {
                socket.emit('listenTogetherQueueSessionLeave', { sessionId: response.sessionId });
                leaveListenTogetherQueue();
                if (listeningTogetherUserId) joinListenTogetherQueue(listeningTogetherUserId, true);
                return;
            }
            sharedQueueSessionId = response.sessionId;
            sharedQueueRole = 'follower';
            sharedQueueSnapshotRevision = 0;
            sharedQueueIds = [];
            sharedQueueUpcomingIds = [];
            sharedQueueHostQueueName = typeof response.queueName === 'string' && response.queueName.trim()
                ? response.queueName.trim()
                : 'GENERAL';
            lastSharedQueueSnapshot = null;
            sharedQueueJamActive = false;
            sharedQueueJamRequestPending = false;
            sharedQueueJamRequestId = null;
            sharedQueueJamUpdateInFlight = false;
            sharedQueueJamPendingUpcomingIds = null;
            socket.emit('listenTogetherQueueSnapshotRequest', {
                sessionId: sharedQueueSessionId
            }, snapshotResponse => {
                if (!snapshotResponse?.success) {
                    showToast(snapshotResponse?.error || 'No se pudo cargar la cola compartida.', true);
                }
            });
            renderQueue();
        });
    }

    function getAccountQueueSongIds() {
        return customQueue
            .map(track => String(track?._id || track?.id || ''))
            .filter(Boolean)
            .slice(0, 5000);
    }

    function getAccountQueueSourceSongIds() {
        const sourceIndices = isShuffle ? [...unplayedIndices] : getSequentialQueueIndices();
        return sourceIndices
            .map(index => playlist[index])
            .map(track => String(track?._id || track?.id || ''))
            .filter(Boolean)
            .slice(0, 5000);
    }

    function getAccountQueueStorageKey(kind) {
        const userId = String(getStoredUser()?._id || 'guest');
        return `amgc-desktop-account-queue-${kind}-${userId}`;
    }

    function getDisplayedAccountQueueIds() {
        return accountQueuePendingIds || accountQueueIds;
    }

    function getAccountQueueSnapshotSignature(
        songIds = accountQueueIds,
        sourceSongIds = accountQueueSourceIds,
        sourceQueueName = accountQueueName
    ) {
        return JSON.stringify([sourceQueueName, sourceSongIds, songIds]);
    }

    function persistAccountQueueSnapshot() {
        try {
            localStorage.setItem(getAccountQueueStorageKey('snapshot'), JSON.stringify({
                revision: accountQueueRevision,
                songIds: accountQueueIds,
                sourceSongIds: accountQueueSourceIds,
                queueName: accountQueueName
            }));
        } catch (error) {
            console.error('No se pudo guardar la instantánea de la cola de la cuenta.', error);
        }
    }

    function restoreAccountQueueCache() {
        try {
            const snapshot = JSON.parse(localStorage.getItem(getAccountQueueStorageKey('snapshot')) || 'null');
            if (
                snapshot
                && Number.isInteger(snapshot.revision)
                && Array.isArray(snapshot.songIds)
                && snapshot.songIds.every(songId => typeof songId === 'string')
            ) {
                accountQueueRevision = snapshot.revision;
                accountQueueIds = snapshot.songIds.slice(0, 5000);
                accountQueueSourceIds = Array.isArray(snapshot.sourceSongIds)
                    && snapshot.sourceSongIds.every(songId => typeof songId === 'string')
                    ? snapshot.sourceSongIds.slice(0, 5000)
                    : [];
                accountQueueName = typeof snapshot.queueName === 'string' && snapshot.queueName.trim()
                    ? snapshot.queueName.trim().slice(0, 100)
                    : 'GENERAL';
                accountQueueSnapshotSignature = getAccountQueueSnapshotSignature();
                accountQueueSnapshotCached = true;
            }
            const pendingIds = JSON.parse(localStorage.getItem(getAccountQueueStorageKey('pending')) || 'null');
            accountQueuePendingIds = Array.isArray(pendingIds)
                && pendingIds.length <= 5000
                && pendingIds.every(songId => typeof songId === 'string')
                ? pendingIds
                : null;
            if (accountQueueSnapshotCached || accountQueuePendingIds) renderQueue();
        } catch (error) {
            console.error('No se pudo restaurar la cola de la cuenta guardada.', error);
        }
    }

    function savePendingAccountQueueIds(songIds) {
        accountQueuePendingIds = songIds.map(String).slice(0, 5000);
        updateQueueSyncIndicator();
        try {
            localStorage.setItem(
                getAccountQueueStorageKey('pending'),
                JSON.stringify(accountQueuePendingIds)
            );
        } catch (error) {
            console.error('No se pudo guardar la cola pendiente de la cuenta.', error);
            showToast('No se pudo guardar el cambio de cola localmente.', true);
        }
    }

    function clearPendingAccountQueueIds() {
        accountQueuePendingIds = null;
        updateQueueSyncIndicator();
        if (accountQueueRetryTimer) {
            clearTimeout(accountQueueRetryTimer);
            accountQueueRetryTimer = null;
        }
        accountQueueRetryDelay = 15000;
        accountQueueLastNotifiedSignature = '';
        try {
            localStorage.removeItem(getAccountQueueStorageKey('pending'));
        } catch (error) {
            console.error('No se pudo limpiar la cola pendiente de la cuenta.', error);
        }
    }

    function schedulePendingAccountQueueRetry() {
        if (accountQueueRetryTimer || !accountQueuePendingIds || !socket.connected) return;
        const delay = accountQueueRetryDelay;
        accountQueueRetryDelay = Math.min(accountQueueRetryDelay * 2, 180000);
        accountQueueRetryTimer = window.setTimeout(() => {
            accountQueueRetryTimer = null;
            flushPendingAccountQueue();
        }, delay);
    }

    function flushPendingAccountQueue() {
        if (!accountQueuePendingIds || !socket.connected || accountQueueSyncInFlight) return;
        if (!accountQueueSnapshotCached) {
            requestAccountQueueSnapshot();
            return;
        }
        accountQueueSyncInFlight = true;
        updateQueueSyncIndicator();
        const songIds = [...accountQueuePendingIds];
        const syncGeneration = accountQueueSyncGeneration;
        const userId = String(getStoredUser()?._id || '');
        const token = accessToken;
        socket.timeout(15000).emit('accountQueueUpdateRequest', {
            revision: accountQueueRevision,
            songIds
        }, (timeoutError, response) => {
            if (
                syncGeneration !== accountQueueSyncGeneration
                || userId !== String(getStoredUser()?._id || '')
                || token !== accessToken
            ) return;
            const hasNewerIntent = Boolean(
                accountQueuePendingIds
                && accountQueuePendingIds.join(',') !== songIds.join(',')
            );
            accountQueueSyncInFlight = false;
            updateQueueSyncIndicator();
            if (response?.success) {
                accountQueueIds = songIds;
                if (Number.isInteger(response.revision) && response.revision > accountQueueRevision) {
                    accountQueueRevision = response.revision;
                }
                accountQueueSnapshotCached = true;
                accountQueueSnapshotSignature = getAccountQueueSnapshotSignature(songIds);
                persistAccountQueueSnapshot();
                if (accountQueuePendingIds?.join(',') === songIds.join(',')) clearPendingAccountQueueIds();
                renderQueue();
                if (hasNewerIntent) window.setTimeout(() => flushPendingAccountQueue(), 0);
                return;
            }
            if (String(response?.error || '').toLowerCase().includes('cola cambió')) {
                requestAccountQueueSnapshot();
            }
            const signature = songIds.join(',');
            if (accountQueueLastNotifiedSignature !== signature) {
                showToast(timeoutError || response?.error
                    ? 'El cambio permanece guardado localmente; se reintentará al recuperar la conexión.'
                    : 'No se pudo sincronizar la cola; el cambio sigue guardado localmente.', true);
                accountQueueLastNotifiedSignature = signature;
            }
            schedulePendingAccountQueueRetry();
        });
    }

    function publishAccountQueueSnapshot(force = false, allowPending = false) {
        if (
            !playbackOwnerConfirmed
            || getRemotePlaybackSession()
            || sharedQueueSessionId
            || (accountQueuePendingIds && !allowPending)
            || !socket.connected
        ) {
            return Promise.resolve(false);
        }
        const songIds = getAccountQueueSongIds();
        const sourceSongIds = getAccountQueueSourceSongIds();
        const sourceQueueName = queueName || 'GENERAL';
        const signature = getAccountQueueSnapshotSignature(songIds, sourceSongIds, sourceQueueName);
        if (!force && signature === accountQueueSnapshotSignature) return Promise.resolve(true);
        accountQueueSnapshotSignature = signature;
        return new Promise(resolve => {
            socket.emit('accountQueueSnapshot', {
                revision: accountQueueRevision,
                songIds,
                sourceSongIds,
                queueName: sourceQueueName
            }, response => {
                if (response?.success) {
                    if (response.stale) {
                        if (Number.isInteger(response.revision)) accountQueueRevision = response.revision;
                        resolve(true);
                        return;
                    }
                    if (Number.isInteger(response.revision)) accountQueueRevision = response.revision;
                    accountQueueIds = songIds;
                    accountQueueSourceIds = sourceSongIds;
                    accountQueueName = sourceQueueName;
                    accountQueueSnapshotCached = true;
                    persistAccountQueueSnapshot();
                    resolve(true);
                    return;
                }
                if (accountQueueSnapshotSignature === signature) accountQueueSnapshotSignature = null;
                showToast(response?.error || 'No se pudo sincronizar la cola de la cuenta.', true);
                resolve(false);
            });
        });
    }

    function requestAccountQueueSnapshot() {
        if (!socket.connected) return;
        socket.emit('accountQueueRequest', response => {
            if (!response?.success) {
                accountQueueDeviceId = null;
                showToast(response?.error || 'No se pudo cargar la cola de la cuenta.', true);
            }
        });
    }

    function requestAccountQueueAdd(songId) {
        const currentIds = getDisplayedAccountQueueIds();
        if (!songId || currentIds.length >= 5000) {
            showToast('La cola alcanzó el máximo de 5000 canciones.', true);
            return;
        }
        requestAccountQueueUpdate([...currentIds, String(songId)]);
    }

    async function requestAccountQueuePlay(track, position) {
        const songId = String(track?._id || track?.id || '');
        if (!songId) return false;
        if (!socket.connected || accountQueuePendingIds) {
            return playLocalTrackForTakeover(songId);
        }
        if (!accountQueueRevision) {
            showToast('La cola compartida todavía se está cargando.', true);
            return false;
        }
        const endLoading = beginPlaybackRequestLoading();
        try {
            let response = await requestPlaybackSocket('accountQueuePlayRequest', {
                songId,
                position,
                revision: accountQueueRevision
            }, 7000);
            if (
                !response.success
                && (
                    response.ownerDisconnected
                    || response.ownerUnresponsive
                    || response.error === 'El servidor no confirmó la acción a tiempo.'
                )
            ) {
                return await playLocalTrackForTakeover(songId);
            }
            if (!response.success) {
                if (String(response.error || '').toLowerCase().includes('cola cambió')) requestAccountQueueSnapshot();
                showToast(response.error || 'No se pudo reproducir la canción.', true);
            }
            return Boolean(response.success);
        } finally {
            endLoading();
        }
    }

    function requestAccountQueueUpdate(songIds) {
        savePendingAccountQueueIds(songIds);
        accountQueueSnapshotCached = true;
        renderQueue();
        if (!socket.connected || !accountQueueRevision) {
            showToast('Cambio guardado localmente; se sincronizará al recuperar la conexión.');
            return;
        }
        flushPendingAccountQueue();
    }

    function removeAccountQueueTrack(position) {
        const currentIds = getDisplayedAccountQueueIds();
        if (!Number.isInteger(position) || position < 0 || position >= currentIds.length) return;
        const songIds = [...currentIds];
        songIds.splice(position, 1);
        requestAccountQueueUpdate(songIds);
    }

    function reorderAccountQueue(fromPosition, toPosition) {
        if (
            fromPosition === toPosition
            || fromPosition < 0
            || toPosition < 0
            || fromPosition >= getDisplayedAccountQueueIds().length
            || toPosition >= getDisplayedAccountQueueIds().length
        ) return;
        const songIds = [...getDisplayedAccountQueueIds()];
        const [movedSongId] = songIds.splice(fromPosition, 1);
        songIds.splice(toPosition, 0, movedSongId);
        requestAccountQueueUpdate(songIds);
    }

    function syncAccountQueue() {
        const remotePlayback = getRemotePlaybackSession();
        if (remotePlayback) {
            if (accountQueueDeviceId !== remotePlayback.deviceId) {
                accountQueueDeviceId = remotePlayback.deviceId;
                requestAccountQueueSnapshot();
            }
            if (accountQueuePendingIds) flushPendingAccountQueue();
            return;
        }
        accountQueueDeviceId = null;
        if (accountQueuePendingIds) {
            flushPendingAccountQueue();
            return;
        }
        if (getCurrentTrack() && !listeningTogetherUserId) publishAccountQueueSnapshot();
    }

    function leaveListenTogetherQueue() {
        if (sharedQueueSessionId && socket.connected) {
            socket.emit('listenTogetherQueueSessionLeave', { sessionId: sharedQueueSessionId });
        }
        const shouldRestoreQueue = sharedQueueRole === 'follower' || sharedQueueSavedLocalQueue !== null;
        const restoredQueue = sharedQueueSavedLocalQueue;
        sharedQueueSessionId = null;
        sharedQueueRole = null;
        sharedQueueJoinPending = false;
        sharedQueueSnapshotRevision = 0;
        sharedQueueIds = [];
        sharedQueueUpcomingIds = [];
        sharedQueueHostQueueName = 'GENERAL';
        lastSharedQueueSnapshot = null;
        sharedQueueJamActive = false;
        sharedQueueJamRequestPending = false;
        sharedQueueJamRequestId = null;
        sharedQueueJamUpdateInFlight = false;
        sharedQueueJamPendingUpcomingIds = null;
        sharedQueueSavedLocalQueue = null;
        closeJamRequestNotification();
        if (restoredQueue) {
            customQueue = restoredQueue;
        } else if (shouldRestoreQueue) {
            customQueue = [];
        }
        if (shouldRestoreQueue) {
            renderQueue();
        }
        renderJamControls();
    }

    function addTrackToQueue(track, shouldRender = true, forceLocal = false) {
        if (!track) return false;
        const trackIds = [track._id, track.id].filter(Boolean).map(String);
        const queuedTrack = playlist.find(candidate => (
            trackIds.includes(String(candidate._id))
            || trackIds.includes(String(candidate.id))
            || (track.path && candidate.path === track.path)
        ));
        if (!queuedTrack?._id) {
            showToast('No se pudo identificar la canción para añadirla a la cola.', true);
            return false;
        }
        const isJamHost = sharedQueueRole === 'host' && sharedQueueJamActive;
        const isSharedQueueFollower = sharedQueueRole === 'follower';
        if (!forceLocal && !isJamHost && !isSharedQueueFollower && !isFollowingPlayback()
            && (getRemotePlaybackSession() || accountQueueSnapshotCached || accountQueuePendingIds)) {
            requestAccountQueueAdd(queuedTrack._id);
            return true;
        }
        if (isSharedQueueFollower) {
            if (!sharedQueueJamActive) {
                showToast('La cola del anfitrión es de solo lectura. Propón una Jam desde la cola para colaborar.', true);
                return false;
            }
            const sharedUpcomingIds = sharedQueueJamPendingUpcomingIds || sharedQueueUpcomingIds;
            if (sharedUpcomingIds.length >= 5000) {
                showToast('La cola de la Jam alcanzó el máximo de 5000 canciones.', true);
                return false;
            }
            requestJamQueueUpdate([
                ...sharedUpcomingIds,
                String(queuedTrack._id)
            ]);
            if (queueContainer && bottomBarWrapper) {
                isQueueOpen = true;
                queueContainer.classList.add('show');
                bottomBarWrapper.classList.add('queue-open');
            }
            return true;
        }
        if (sharedQueueRole === 'host' && sharedQueueJamActive) {
            if (customQueue.length >= 5000) {
                showToast('La cola de la Jam alcanzó el máximo de 5000 canciones.', true);
                return false;
            }
            customQueue.push(queuedTrack);
        } else {
            customQueue.push(queuedTrack);
        }
        if (queueContainer && bottomBarWrapper) {
            isQueueOpen = true;
            queueContainer.classList.add('show');
            bottomBarWrapper.classList.add('queue-open');
        }
        if (shouldRender) renderQueue();
        return true;
    }

    function setupPointerMovementGuard(element, callbacks = {}) {
        const state = {
            pointerId: null,
            startX: 0,
            startY: 0,
            moved: false,
            horizontalIntent: false,
            suppressClick: false,
            pointerCaptured: false
        };
        let clickResetTimer;

        const recordMovement = event => {
            const deltaX = event.clientX - state.startX;
            const deltaY = event.clientY - state.startY;
            if (!state.moved && (deltaX !== 0 || deltaY !== 0)) {
                state.moved = true;
                state.suppressClick = true;
            }
            if (deltaX >= 5 && deltaX >= Math.abs(deltaY) * queueSwipeAxisRatio) {
                state.horizontalIntent = true;
            }
            if (state.moved) callbacks.onMove?.(event, state, deltaX, deltaY);
        };

        element.addEventListener('pointerdown', event => {
            clearTimeout(clickResetTimer);
            state.suppressClick = false;
            state.pointerId = null;
            state.moved = false;
            state.horizontalIntent = false;
            state.pointerCaptured = false;
            state.startX = event.clientX;
            state.startY = event.clientY;
            if (!event.isPrimary || event.button !== 0 || event.target.closest('button, a, input, .song-actions-wrapper, .remove-queue-btn')) return;
            state.pointerId = event.pointerId;
            callbacks.onStart?.(event, state);
        });

        element.addEventListener('pointermove', event => {
            if (event.pointerId !== state.pointerId) return;
            recordMovement(event);
        });

        const finishPointer = event => {
            if (event.pointerId !== state.pointerId) return;
            recordMovement(event);
            callbacks.onFinish?.(event, state, event.clientX - state.startX, event.clientY - state.startY);
            state.pointerId = null;
            if (state.suppressClick) {
                clickResetTimer = setTimeout(() => {
                    state.suppressClick = false;
                }, 800);
            }
        };

        element.addEventListener('pointerup', finishPointer);
        element.addEventListener('pointercancel', finishPointer);
        element.addEventListener('click', event => {
            if (!state.suppressClick) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            state.suppressClick = false;
            clearTimeout(clickResetTimer);
        }, true);
        element.addEventListener('lostpointercapture', event => {
            if (event.pointerId === state.pointerId) {
                state.pointerId = null;
                state.pointerCaptured = false;
            }
        });

        return state;
    }

    const trackQueueSwipeThreshold = 32;
    const queueSwipeAxisRatio = 0.85;

    function setupQueueAddSwipe(element, track) {
        element.classList.add('track-queue-gesture');
        return setupPointerMovementGuard(element, {
            onStart: (_event, gesture) => {
                gesture.enqueued = false;
                element.style.transform = '';
                element.classList.remove('queue-add-dragging', 'queue-add-ready');
            },
            onMove: (event, gesture, deltaX) => {
                if (!gesture.horizontalIntent || deltaX <= 0) {
                    element.style.transform = '';
                    element.classList.remove('queue-add-dragging', 'queue-add-ready');
                    return;
                }
                if (!gesture.pointerCaptured && event.type === 'pointermove') {
                    element.setPointerCapture(event.pointerId);
                    gesture.pointerCaptured = true;
                }
                const rightwardDistance = deltaX;
                element.classList.add('queue-add-dragging');
                element.style.transform = `translateX(${Math.min(rightwardDistance, trackQueueSwipeThreshold + 28)}px)`;
                const reachedQueueThreshold = rightwardDistance >= trackQueueSwipeThreshold;
                element.classList.toggle('queue-add-ready', reachedQueueThreshold);
            },
            onFinish: (event, gesture, deltaX) => {
                if (
                    event.type === 'pointerup'
                    && gesture.horizontalIntent
                    && deltaX >= trackQueueSwipeThreshold
                ) {
                    gesture.enqueued = addTrackToQueue(track, false);
                }
                element.style.transform = '';
                element.classList.remove('queue-add-dragging', 'queue-add-ready');
                if (gesture.enqueued) renderQueue();
            }
        });
    }

    let activeNativeReorder = null;
    function setupNativeReorderDrag(element, group, position, reorder, canStart = () => true) {
        element.addEventListener('dragstart', event => {
            if (!canStart()) {
                event.preventDefault();
                return;
            }
            activeNativeReorder = { group, position };
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', `${group}:${position}`);
            element.classList.add('dragging');
            element.dataset.wasDragged = 'true';
        });
        element.addEventListener('dragend', () => {
            activeNativeReorder = null;
            element.classList.remove('dragging');
            document.querySelectorAll('.drag-over').forEach(target => target.classList.remove('drag-over'));
            setTimeout(() => delete element.dataset.wasDragged, 500);
        });
        element.addEventListener('dragover', event => {
            if (!activeNativeReorder || activeNativeReorder.group !== group) return;
            event.preventDefault();
            element.classList.add('drag-over');
            event.dataTransfer.dropEffect = 'move';
        });
        element.addEventListener('dragleave', event => {
            if (!element.contains(event.relatedTarget)) element.classList.remove('drag-over');
        });
        element.addEventListener('drop', event => {
            event.preventDefault();
            element.classList.remove('drag-over');
            if (!activeNativeReorder || activeNativeReorder.group !== group) return;
            const { position: fromPosition } = activeNativeReorder;
            if (fromPosition !== position) reorder(fromPosition, position);
        });
    }

    function setupPlaylistDrag(element, playlistData, trackPosition, isQueueSwipe) {
        element.draggable = true;
        setupNativeReorderDrag(element, `playlist:${playlistData.id}`, trackPosition, (fromPosition, toPosition) => {
            if (fromPosition >= playlistData.tracks.length || toPosition >= playlistData.tracks.length) return;
            const previousTracks = [...playlistData.tracks];
            const [movedTrack] = playlistData.tracks.splice(fromPosition, 1);
            playlistData.tracks.splice(toPosition, 0, movedTrack);
            const movedTrackIds = playlistData.tracks.map(track => String(track._id || track.id));
            openPlaylistView(playlistData.id);
            savePlaylistOrder(playlistData).catch(error => {
                const currentTrackIds = playlistData.tracks.map(track => String(track._id || track.id));
                if (currentTrackIds.every((trackId, index) => trackId === movedTrackIds[index])) {
                    playlistData.tracks = previousTracks;
                    if (activePlaylistId === playlistData.id) openPlaylistView(playlistData.id);
                    showToast(error.message || 'No se pudo guardar el nuevo orden de la playlist.', true);
                }
            });
        }, () => !isQueueSwipe());

    }

    function reorderCustomQueue(fromPosition, toPosition) {
        if (
            fromPosition === toPosition
            || fromPosition < 0
            || toPosition < 0
            || fromPosition >= customQueue.length
            || toPosition >= customQueue.length
        ) return;
        const [movedTrack] = customQueue.splice(fromPosition, 1);
        customQueue.splice(toPosition, 0, movedTrack);
        renderQueue();
    }

    function reorderJamQueue(fromPosition, toPosition) {
        const upcomingIds = [...(sharedQueueJamPendingUpcomingIds || sharedQueueUpcomingIds)];
        if (
            fromPosition === toPosition
            || fromPosition < 0
            || toPosition < 0
            || fromPosition >= upcomingIds.length
            || toPosition >= upcomingIds.length
        ) return;
        const [movedId] = upcomingIds.splice(fromPosition, 1);
        upcomingIds.splice(toPosition, 0, movedId);
        requestJamQueueUpdate(upcomingIds);
    }

    async function playUpcomingQueueTrack(position) {
        const track = customQueue[position];
        if (!track) return false;
        const trackIndex = playlist.findIndex(item => (
            getTrackStorageId(item) === getTrackStorageId(track)
        ));
        if (trackIndex < 0) return false;
        customQueue.splice(0, position + 1);
        return loadAndPlayTrack(trackIndex, 'custom');
    }

    function setupCustomQueueDrag(element, position) {
        element.draggable = true;
        element.dataset.queueKind = 'custom';
        setupNativeReorderDrag(element, 'custom-queue', position, reorderCustomQueue);
    }

    function setupSongMenuListeners(element, trackIndex) {
        element.addEventListener('click', (e) => {
            if (element.dataset.wasDragged === 'true') {
                delete element.dataset.wasDragged;
                return;
            }
            const btn3Dots = e.target.closest('.song-actions-btn');
            const actionAddQueue = e.target.closest('.action-add-queue');
            const actionAddPl = e.target.closest('.action-add-pl');
            const actionEdit = e.target.closest('.action-edit');
            const actionCopy = e.target.closest('.action-copy');
            const removeQueueItem = e.target.closest('.remove-queue-btn');

            if (removeQueueItem) {
                e.stopPropagation();
                const queueKind = element.dataset.queueKind;
                const queuePosition = Number(element.dataset.queuePosition);
                if (queueKind === 'shuffle') {
                    unplayedIndices.splice(queuePosition, 1);
                } else if (queueKind === 'regular') {
                    const currentPosition = activeQueueTracks.findIndex(track => playlist.indexOf(track) === currentTrackIndex);
                    if (currentPosition !== -1) activeQueueTracks.splice(currentPosition + 1 + queuePosition, 1);
                }
                renderQueue();
                return;
            }

            if (btn3Dots) {
                e.stopPropagation();
                const menu = element.querySelector('.song-actions-menu');
                const wasOpen = menu.classList.contains('show');
                
                document.querySelectorAll('.song-actions-menu').forEach(m => m.classList.remove('show'));
                document.querySelectorAll('.all-songs-item, .playlist-track-row, .queue-item').forEach(el => el.style.zIndex = '1');
                
                if (!wasOpen) {
                    element.style.zIndex = '9999';
                    positionSongActionsMenu(menu, btn3Dots.closest('.song-actions-wrapper'));
                }
                return;
            }

            if (actionAddQueue) {
                e.stopPropagation();
                document.querySelectorAll('.song-actions-menu').forEach(m => m.classList.remove('show'));
                if (addTrackToQueue(playlist[trackIndex], false)) renderQueue();
                return;
            }

            if (actionCopy) {
                e.stopPropagation();
                const track = playlist[trackIndex];
                const text = `${track?.name || 'Canción'} - ${track?.artist || 'Artista desconocido'}`;
                copySongText(text, actionCopy);
                return;
            }

            if (actionAddPl) {
                e.stopPropagation();
                document.querySelectorAll('.song-actions-menu').forEach(m => m.classList.remove('show'));
                openAddToPlaylistModal(trackIndex);
                return;
            }

            if (actionEdit) {
                e.stopPropagation();
                if (!canCurrentUser('edit_songs')) return;
                document.querySelectorAll('.song-actions-menu').forEach(m => m.classList.remove('show'));
                openEditSongPanel(trackIndex);
                return;
            }

            if (!e.target.closest('.song-actions-wrapper')) {
                const queueSource = element.dataset.queueSource;
                const selectedTrackIndex = queueSource && element.dataset.trackIndex !== undefined
                    ? Number(element.dataset.trackIndex)
                    : trackIndex;
                if (!Number.isInteger(selectedTrackIndex) || !playlist[selectedTrackIndex]) return;
                if (queueSource && !activeQueueTracks.some(track => (
                    String(track._id || track.id) === String(playlist[selectedTrackIndex]._id || playlist[selectedTrackIndex].id)
                ))) {
                    const selectedPlaylist = activePlaylistId
                        ? userPlaylists.find(playlistItem => playlistItem.id === activePlaylistId)
                        : null;
                    activeQueueTracks = selectedPlaylist
                        ? selectedPlaylist.tracks
                            .map(track => playlist.find(main => String(main._id || main.id) === String(track._id || track.id)))
                            .filter(Boolean)
                        : [...playlist];
                    queueName = selectedPlaylist?.name || 'GENERAL';
                    generalQueueAnchorTrackId = String(getCurrentTrack()?._id || getCurrentTrack()?.id || '');
                    resetPlaybackHistory();
                }
                if (queueSource && selectedTrackIndex !== currentTrackIndex && playlist[currentTrackIndex]) {
                    playbackHistory.push({ index: currentTrackIndex, source: currentTrackSource });

                    if (queueSource === 'shuffle') {
                        const queuedPosition = unplayedIndices.indexOf(selectedTrackIndex);
                        if (queuedPosition !== -1) {
                            unplayedIndices.slice(0, queuedPosition).forEach(index => {
                                playbackHistory.push({ index, source: 'shuffle' });
                            });
                            unplayedIndices.splice(0, queuedPosition + 1);
                        }
                    } else {
                        const upcomingIndices = getSequentialQueueIndices();
                        const queuedPosition = upcomingIndices.indexOf(selectedTrackIndex);
                        if (queuedPosition > 0) {
                            upcomingIndices.slice(0, queuedPosition).forEach(index => {
                                playbackHistory.push({ index, source: 'regular' });
                            });
                        }
                    }
                } else if (!queueSource) {
                    activePlaylistId = null;
                    queueName = 'GENERAL';
                    activeQueueTracks = [...playlist];
                    playbackHistory = [];
                    unplayedIndices = [];
                }
                loadAndPlayTrack(selectedTrackIndex, queueSource || 'regular');
            }
        });
    }

    async function copySongText(text, button) {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                const helper = document.createElement('textarea');
                helper.value = text;
                helper.setAttribute('readonly', '');
                helper.style.position = 'fixed';
                helper.style.opacity = '0';
                document.body.appendChild(helper);
                helper.select();
                document.execCommand('copy');
                helper.remove();
            }
            const originalText = button.textContent;
            button.textContent = '¡Copiado!';
            setTimeout(() => { button.textContent = originalText; }, 1200);
        } catch (error) {
            console.warn('No se pudo copiar la canción:', error);
        }
    }

    function setupGlobalSongContextMenu() {
        const menu = document.createElement('div');
        menu.className = 'app-song-context-menu';
        menu.hidden = true;
        menu.innerHTML = `
            <button type="button" data-song-action="copy">Copiar nombre y artista</button>
            <button type="button" data-song-action="queue">Añadir a la cola</button>
            <button type="button" data-song-action="playlist">Añadir a playlist</button>
        `;
        document.body.appendChild(menu);

        const closeMenu = () => {
            menu.hidden = true;
            menu.removeAttribute('data-track-index');
        };

        document.addEventListener('contextmenu', event => {
            const target = event.target instanceof Element ? event.target : null;
            const songRow = target?.closest(
                '.playlist-track-row, .all-songs-item:not(.add-song-card), .queue-item, .queue-source-item'
            );
            const isCurrentTrackControl = target?.closest('#track-name, #track-artist, #bottom-bar-cover');
            let trackIndex = -1;

            if (songRow?.dataset.trackIndex !== undefined) {
                trackIndex = Number(songRow.dataset.trackIndex);
            }
            if ((!Number.isInteger(trackIndex) || !playlist[trackIndex]) && songRow?.dataset.songId) {
                trackIndex = playlist.findIndex(track => (
                    String(track._id || track.id) === songRow.dataset.songId
                ));
            }
            if ((!Number.isInteger(trackIndex) || !playlist[trackIndex]) && songRow?.dataset.playlistTrackId) {
                trackIndex = playlist.findIndex(track => (
                    String(track._id || track.id) === songRow.dataset.playlistTrackId
                ));
            }
            if (
                (!Number.isInteger(trackIndex) || !playlist[trackIndex])
                && songRow?.classList.contains('queue-item')
                && songRow.classList.contains('active')
            ) {
                trackIndex = currentTrackIndex;
            }
            if ((!Number.isInteger(trackIndex) || !playlist[trackIndex]) && isCurrentTrackControl) {
                trackIndex = currentTrackIndex;
            }

            if (!Number.isInteger(trackIndex) || !playlist[trackIndex]) return;
            event.preventDefault();
            event.stopPropagation();

            menu.dataset.trackIndex = String(trackIndex);
            menu.hidden = false;
            menu.style.left = `${Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8)}px`;
            menu.style.top = `${Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8)}px`;
        });

        menu.addEventListener('click', event => {
            const button = event.target instanceof Element
                ? event.target.closest('[data-song-action]')
                : null;
            if (!button) return;
            const trackIndex = Number(menu.dataset.trackIndex);
            const track = playlist[trackIndex];
            if (!track) {
                closeMenu();
                return;
            }

            if (button.dataset.songAction === 'copy') {
                void copySongText(`${track.name || 'Canción'} - ${track.artist || 'Artista desconocido'}`, button);
            } else if (button.dataset.songAction === 'queue') {
                addTrackToQueue(track);
                closeMenu();
            } else if (button.dataset.songAction === 'playlist') {
                closeMenu();
                openAddToPlaylistModal(trackIndex);
            }
        });

        document.addEventListener('click', event => {
            if (!(event.target instanceof Node) || !menu.contains(event.target)) closeMenu();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') closeMenu();
        });
        window.addEventListener('blur', closeMenu);
    }

    setupGlobalSongContextMenu();

    if (btnAddToPlaylistBar && bottomBarActionMenu) {
        btnAddToPlaylistBar.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasOpen = bottomBarActionMenu.classList.contains('show');
            document.querySelectorAll('.song-actions-menu').forEach(m => m.classList.remove('show'));
            if (!wasOpen) bottomBarActionMenu.classList.add('show');
        });
        
        bottomBarActionMenu.querySelector('.action-add-queue').addEventListener('click', (e) => {
            e.stopPropagation();
            bottomBarActionMenu.classList.remove('show');
            const track = getRemotePlaybackSession() ? findRemotePlaybackTrack() : getCurrentTrack();
            if (!track) {
                showToast('La canción del otro dispositivo no está disponible en esta biblioteca.', true);
                return;
            }
            if (addTrackToQueue(track, false)) renderQueue();
        });
        
        bottomBarActionMenu.querySelector('.action-add-pl').addEventListener('click', (e) => {
            e.stopPropagation();
            bottomBarActionMenu.classList.remove('show');
            const track = getRemotePlaybackSession() ? findRemotePlaybackTrack() : getCurrentTrack();
            const trackIndex = track ? playlist.indexOf(track) : -1;
            if (trackIndex < 0) {
                showToast('La canción del otro dispositivo no está disponible en esta biblioteca.', true);
                return;
            }
            openAddToPlaylistModal(trackIndex);
        });
    }

    renderAllSongs = createSongListRenderer({
        listElement: allSongsList,
        searchInput: allSongsSearch,
        getSongs: () => playlist,
        getLoadingTrackId: () => loadingTrackId,
        getSongSuggestions: () => songSuggestions,
        getPendingSongs: () => [...pendingCatalogSongs.values()],
        isOfflineReady: track => offlineAudioSongIds.has(String(track._id || track.id || '')),
        getSongCover,
        createImageMarkup,
        escapeHtml,
        createSongContextMenuHtml,
        setupSongMenuListeners,
        setupQueueAddSwipe,
        openEditSongPanel,
        openSongSuggestion: suggestion => openQuickAddPanel(suggestion),
        deleteSongSuggestion: suggestion => deleteSongSuggestion(suggestion),
        canEditSuggestions: () => canCurrentUser('edit_songs'),
        canDeleteSuggestions: () => canCurrentUser('delete_songs')
    });

    function renderSpotifyLikedTracks() {
        if (!spotifyLikesList) return;
        const searchTerm = spotifyLikesSearch?.value.trim().toLocaleLowerCase() || '';
        const filteredTracks = spotifyLikedTracks.filter(track => (
            !searchTerm || `${track.name} ${track.artist}`.toLocaleLowerCase().includes(searchTerm)
        ));
        const fragment = document.createDocumentFragment();
        if (!filteredTracks.length) {
            const empty = document.createElement('li');
            empty.className = 'spotify-likes-empty';
            empty.textContent = spotifyLikedTracks.length
                ? 'No hay canciones que coincidan con la búsqueda.'
                : 'No se encontraron canciones guardadas.';
            fragment.appendChild(empty);
        }
        for (const track of filteredTracks) {
            const item = document.createElement('li');
            item.className = 'spotify-like-item';
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = spotifySelectedTrackIds.has(track.id);
            checkbox.disabled = Boolean(track.isInProgram || track.isSuggested);
            checkbox.setAttribute(
                'aria-label',
                checkbox.disabled
                    ? `${track.name} de ${track.artist} ya está ${track.isInProgram ? 'en la lista de canciones' : 'en sugerencias'}`
                    : `Seleccionar ${track.name} de ${track.artist}`
            );
            checkbox.addEventListener('change', () => {
                if (checkbox.checked && spotifySelectedTrackIds.size >= 100) {
                    checkbox.checked = false;
                    showToast('Puedes importar hasta 100 canciones por vez.', true);
                    return;
                }
                if (checkbox.checked) spotifySelectedTrackIds.add(track.id);
                else spotifySelectedTrackIds.delete(track.id);
                if (spotifyImportButton) spotifyImportButton.hidden = !spotifySelectedTrackIds.size;
            });
            label.appendChild(checkbox);
            if (track.coverUrl) {
                const cover = document.createElement('img');
                cover.src = track.coverUrl;
                cover.alt = '';
                cover.loading = 'lazy';
                label.appendChild(cover);
            }
            const info = document.createElement('span');
            info.className = 'spotify-like-info';
            const name = document.createElement('strong');
            name.textContent = track.name;
            const artist = document.createElement('span');
            artist.textContent = track.artist;
            info.append(name, artist);
            if (track.isInProgram || track.isSuggested) {
                const badges = document.createElement('span');
                badges.className = 'spotify-like-badges';
                if (track.isInProgram) {
                    const programBadge = document.createElement('small');
                    programBadge.textContent = 'Ya está en AMGC';
                    programBadge.className = 'spotify-like-badge is-in-program';
                    badges.appendChild(programBadge);
                }
                if (track.isSuggested) {
                    const suggestionBadge = document.createElement('small');
                    suggestionBadge.textContent = 'Ya sugerida';
                    suggestionBadge.className = 'spotify-like-badge is-suggested';
                    badges.appendChild(suggestionBadge);
                }
                info.appendChild(badges);
            }
            label.appendChild(info);
            item.appendChild(label);
            fragment.appendChild(item);
        }
        spotifyLikesList.replaceChildren(fragment);
        if (spotifyImportButton) spotifyImportButton.hidden = !spotifySelectedTrackIds.size;
    }

    async function getSpotifyApiAccessToken(forceRefresh = false) {
        const userId = String(getStoredUser()?._id || '');
        if (spotifyApiAccessTokenUserId !== userId) {
            spotifyApiAccessToken = '';
            spotifyApiAccessTokenExpiresAt = 0;
            spotifyApiAccessTokenRequest = null;
            spotifyApiAccessTokenUserId = userId;
        }
        if (!forceRefresh && spotifyApiAccessToken
            && spotifyApiAccessTokenExpiresAt > Date.now() + 30_000) {
            return spotifyApiAccessToken;
        }
        if (!forceRefresh && spotifyApiAccessTokenRequest) return spotifyApiAccessTokenRequest;
        const tokenRequest = (async () => {
            const query = forceRefresh ? '?refresh=true' : '';
            const response = await apiFetch(`${API_URL}/spotify/access-token${query}`);
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || 'No se pudo autorizar la consulta directa a Spotify.');
            if (typeof result?.accessToken !== 'string' || !result.accessToken) {
                throw new Error('El servidor no devolvió un token válido para Spotify.');
            }
            if (String(getStoredUser()?._id || '') !== userId || !spotifyIsConnected) {
                throw new Error('La sesión cambió mientras se autorizaba Spotify.');
            }
            spotifyApiAccessToken = result.accessToken;
            spotifyApiAccessTokenExpiresAt = Number(result.expiresAt) || Date.now() + 3500_000;
            return spotifyApiAccessToken;
        })();
        spotifyApiAccessTokenRequest = tokenRequest;
        try {
            return await tokenRequest;
        } finally {
            if (spotifyApiAccessTokenRequest === tokenRequest) {
                spotifyApiAccessTokenRequest = null;
            }
        }
    }

    async function loadSpotifyLikedTracks(refresh = false, append = false) {
        if (!spotifyIsConnected || !spotifyLikesStatus) return;
        if (!spotifyRequiredScopesGranted) {
            spotifyLikesStatus.textContent = 'Actualiza los permisos de Spotify para habilitar todas sus funciones.';
            return;
        }
        const offset = append ? spotifyNextOffset : 0;
        if (append && spotifyLoadMoreButton) spotifyLoadMoreButton.disabled = true;
        else if (spotifyRefreshButton) spotifyRefreshButton.disabled = true;
        spotifyLikesStatus.textContent = append
            ? 'Cargando más canciones guardadas de Spotify...'
            : 'Cargando canciones guardadas de Spotify...';
        try {
            const page = await fetchSpotifyLikedTracksPage(offset, getSpotifyApiAccessToken);
            const statusResponse = await apiFetch(`${API_URL}/spotify/track-status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tracks: page.tracks.map(({ id, name, artist, primaryArtist }) => ({
                        id,
                        name,
                        artist,
                        primaryArtist
                    }))
                })
            });
            const statusResult = await statusResponse.json().catch(() => null);
            if (!statusResponse.ok) {
                throw new Error(statusResult?.error || 'No se pudieron comprobar las canciones del catálogo.');
            }
            const statuses = new Map((statusResult?.statuses || []).map(status => [status.id, status]));
            const tracks = page.tracks.map(track => ({ ...track, ...statuses.get(track.id) }));
            spotifyLikedTracks = append
                ? [...spotifyLikedTracks, ...tracks]
                : tracks;
            spotifyNextOffset = Number(page.nextOffset) || offset;
            spotifyTotal = Number(page.total) || 0;
            spotifyHasMore = Boolean(page.hasMore);
            spotifyLikedTracksLoaded = true;
            if (refresh) spotifySelectedTrackIds.clear();
            spotifySelectedTrackIds = new Set(
                [...spotifySelectedTrackIds].filter(id => spotifyLikedTracks.some(
                    track => track.id === id && !track.isInProgram && !track.isSuggested
                ))
            );
            renderSpotifyLikedTracks();
            spotifyLikesSearch.hidden = false;
            spotifyRefreshButton.hidden = false;
            spotifyLikesStatus.textContent = `${spotifyLikedTracks.length} de ${spotifyTotal} canciones cargadas.`;
            if (spotifyLoadMoreButton) spotifyLoadMoreButton.hidden = !spotifyHasMore;
        } catch (error) {
            console.error('No se pudieron cargar los Me gusta de Spotify.', error);
            spotifyLikesStatus.textContent = error.message || 'No se pudieron cargar tus Me gusta.';
            showToast(spotifyLikesStatus.textContent, true);
        } finally {
            if (append && spotifyLoadMoreButton) spotifyLoadMoreButton.disabled = false;
            else if (spotifyRefreshButton) spotifyRefreshButton.disabled = false;
        }
    }

    function renderSpotifyPlaylists() {
        if (!spotifyPlaylistsList) return;
        const fragment = document.createDocumentFragment();
        if (!spotifyPlaylists.length) {
            const empty = document.createElement('li');
            empty.className = 'spotify-likes-empty';
            empty.textContent = 'No se encontraron playlists en Spotify.';
            fragment.appendChild(empty);
        }
        for (const spotifyPlaylist of spotifyPlaylists) {
            const item = document.createElement('li');
            item.className = 'spotify-like-item';
            item.appendChild(createSpotifyPlaylistArtwork(spotifyPlaylist.image, spotifyPlaylist.name));
            const info = document.createElement('span');
            info.className = 'spotify-like-info';
            const name = document.createElement('strong');
            name.textContent = spotifyPlaylist.name;
            const detail = document.createElement('span');
            detail.textContent = `${spotifyPlaylist.ownerName} · ${spotifyPlaylist.totalTracks} canciones · ${spotifyPlaylist.isPublic ? 'Pública' : 'No pública'}`;
            info.append(name, detail);
            item.appendChild(info);
            const action = document.createElement('button');
            action.type = 'button';
            action.className = 'modal-btn-text';
            action.textContent = spotifyPlaylist.linkedPlaylistId ? 'Sincronizar' : 'Importar';
            action.disabled = !spotifyIsConnected || !spotifyPlaylistScopesGranted;
            action.setAttribute(
                'aria-label',
                `${spotifyPlaylist.linkedPlaylistId ? 'Sincronizar' : 'Importar'} playlist ${spotifyPlaylist.name}`
            );
            action.addEventListener('click', async () => {
                action.disabled = true;
                spotifyPlaylistImportStatus.textContent = `Sincronizando “${spotifyPlaylist.name}”...`;
                try {
                    const response = await apiFetch(
                        `${API_URL}/spotify/playlists/${encodeURIComponent(spotifyPlaylist.id)}/import`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ refreshAttribution: true })
                        }
                    );
                    const result = await response.json().catch(() => null);
                    if (!response.ok) throw new Error(result?.error || 'No se pudo importar esta playlist.');
                    await loadPlaylists();
                    spotifyPlaylistSyncs.add(String(result.playlistId));
                    openPlaylistView(result.playlistId);
                    spotifyPlaylistSyncs.delete(String(result.playlistId));
                    spotifyPlaylistImportStatus.textContent = result.changed
                        ? `“${spotifyPlaylist.name}” se importó o sincronizó correctamente.`
                        : `“${spotifyPlaylist.name}” ya está sincronizada.`;
                    spotifyPlaylist.linkedPlaylistId = result.playlistId;
                    action.textContent = 'Sincronizar';
                } catch (error) {
                    console.error('No se pudo importar o sincronizar la playlist de Spotify.', error);
                    spotifyPlaylistImportStatus.textContent = error.message || 'No se pudo sincronizar la playlist.';
                    showToast(spotifyPlaylistImportStatus.textContent, true);
                } finally {
                    action.disabled = false;
                }
            });
            item.appendChild(action);
            fragment.appendChild(item);
        }
        spotifyPlaylistsList.replaceChildren(fragment);
    }

    function createSpotifyPlaylistArtwork(imageUrl, playlistName) {
        const frame = document.createElement('span');
        frame.className = 'spotify-playlist-cover-frame';
        frame.setAttribute('role', 'img');
        frame.setAttribute('aria-label', `Portada de ${playlistName || 'playlist'}`);
        const placeholder = document.createElement('span');
        placeholder.className = 'spotify-playlist-cover-placeholder';
        placeholder.setAttribute('aria-hidden', 'true');
        placeholder.textContent = '♫';
        frame.appendChild(placeholder);

        if (typeof imageUrl !== 'string' || !imageUrl) return frame;

        const image = document.createElement('img');
        image.className = 'spotify-playlist-cover';
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        const spinner = document.createElement('span');
        spinner.className = 'spotify-playlist-cover-spinner';
        spinner.setAttribute('role', 'status');
        spinner.setAttribute('aria-label', 'Cargando portada');
        frame.classList.add('is-loading');
        frame.setAttribute('aria-busy', 'true');

        const finishLoading = () => {
            frame.classList.remove('is-loading');
            frame.setAttribute('aria-busy', 'false');
            spinner.remove();
        };
        image.addEventListener('load', () => {
            placeholder.hidden = true;
            finishLoading();
        }, { once: true });
        image.addEventListener('error', () => {
            image.remove();
            finishLoading();
        }, { once: true });

        frame.append(image, spinner);
        image.src = imageUrl;
        if (image.complete) {
            if (image.naturalWidth > 0) placeholder.hidden = true;
            finishLoading();
        }
        return frame;
    }

    function updateSpotifyPlaylistImportForm() {
        if (!spotifyPlaylistImportStatus || !spotifyPlaylistConnectButton) return;
        spotifyPlaylistConnectButton.textContent = spotifyIsConnected
            ? 'Actualizar permisos de Spotify'
            : 'Conectar Spotify';
        spotifyPlaylistConnectButton.hidden = spotifyIsConnected
            && spotifyRequiredScopesGranted
            && spotifyIdentityLinked;
        spotifyPlaylistConnectButton.disabled = spotifyConnectButton?.disabled ?? true;
        if (spotifyPlaylistsLoadButton) {
            spotifyPlaylistsLoadButton.hidden = !spotifyIsConnected || !spotifyPlaylistScopesGranted;
            spotifyPlaylistsLoadButton.textContent = spotifyPlaylistsLoaded
                ? 'Actualizar playlists'
                : 'Cargar playlists';
        }
        if (spotifyPlaylistsMoreButton) {
            spotifyPlaylistsMoreButton.hidden = !spotifyIsConnected
                || !spotifyPlaylistScopesGranted
                || !spotifyPlaylistsHasMore;
        }
        if (!spotifyIsConnected) {
            spotifyPlaylistImportStatus.textContent = 'Conecta Spotify para importar una playlist vinculada.';
        } else if (!spotifyRequiredScopesGranted) {
            spotifyPlaylistImportStatus.textContent = 'Actualiza los permisos desde aquí o desde Me gusta para habilitar todas las funciones de Spotify.';
        } else if (!spotifyPlaylistScopesGranted) {
            spotifyPlaylistImportStatus.textContent = 'Actualiza los permisos de Spotify para permitir la lectura de playlists.';
        } else if (!spotifyIdentityLinked) {
            spotifyPlaylistImportStatus.textContent = 'Actualiza la conexión de Spotify para vincular esta cuenta con tu usuario de AMGC.';
        } else if (!spotifyPlaylistsLoaded) {
            spotifyPlaylistImportStatus.textContent = 'Carga las playlists de tu cuenta de Spotify.';
        } else {
            spotifyPlaylistImportStatus.textContent = `${spotifyPlaylists.length} playlists cargadas.`;
        }
        renderSpotifyPlaylists();
    }

    function openDirectSpotifyTrackAdd(playlistData) {
        if (!canCurrentUser('edit_songs')) {
            showToast('No tienes permiso para agregar canciones al catálogo.', true);
            return;
        }
        const missingTracks = Array.isArray(playlistData.playlistItems)
            ? [...new Map(playlistData.playlistItems
                .filter(track => track?.spotifyUnavailable === true && track.spotifyTrackId)
                .map(track => [String(track.spotifyTrackId), track])).values()]
            : [];
        if (!missingTracks.length) {
            showToast('No quedan canciones faltantes en esta playlist.');
            return;
        }
        const dialog = document.createElement('dialog');
        dialog.className = 'playlist-direct-add-dialog';
        const dialogHeader = document.createElement('header');
        const dialogTitle = document.createElement('h2');
        dialogTitle.textContent = `Añadir canciones faltantes (${missingTracks.length})`;
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'modal-btn-text';
        closeButton.textContent = 'Cerrar';
        closeButton.addEventListener('click', () => dialog.close());
        dialogHeader.append(dialogTitle, closeButton);

        const cards = document.createElement('ul');
        cards.className = 'quick-add-suggestions-list';
        dialog.append(dialogHeader, cards);
        document.body.appendChild(dialog);
        dialog.addEventListener('click', event => {
            if (event.target === dialog) dialog.close();
        });
        dialog.addEventListener('close', () => dialog.remove(), { once: true });
        dialog.showModal();

        missingTracks.forEach(track => {
        const card = document.createElement('li');
        card.className = 'quick-add-card';
        card.dataset.spotifyTrackId = String(track.spotifyTrackId);
        const cardHeading = document.createElement('div');
        cardHeading.className = 'quick-add-card-heading';
        const headingText = document.createElement('div');
        const headingName = document.createElement('h3');
        headingName.textContent = track.name || 'Canción sin nombre';
        const headingArtist = document.createElement('p');
        headingArtist.textContent = track.artist || 'Artista desconocido';
        headingText.append(headingName, headingArtist);
        const playlistLabel = document.createElement('span');
        playlistLabel.className = 'quick-add-author';
        playlistLabel.textContent = `Playlist: ${playlistData.name || 'Spotify'}`;
        cardHeading.append(headingText, playlistLabel);

        const form = document.createElement('div');
        form.className = 'quick-add-card-form';
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = '#ffffff';
        let colorWasChanged = false;
        colorInput.addEventListener('input', () => {
            colorWasChanged = true;
        });
        const imageWrapper = document.createElement('div');
        imageWrapper.className = 'quick-add-cover image-dropzone';
        imageWrapper.setAttribute('role', 'button');
        imageWrapper.tabIndex = 0;
        imageWrapper.setAttribute('aria-label', `Seleccionar o arrastrar una portada para ${track.name || 'la canción'}`);
        const imagePreview = document.createElement('img');
        imagePreview.className = 'quick-add-cover-preview';
        imagePreview.alt = '';
        imagePreview.hidden = true;
        const imagePlaceholder = document.createElement('span');
        imagePlaceholder.className = 'quick-add-cover-placeholder';
        imagePlaceholder.innerHTML = '<strong>+</strong><span>Seleccionar o arrastrar foto</span>';
        const imageStatus = document.createElement('span');
        imageStatus.className = 'image-drop-hint';
        imageStatus.textContent = 'Portada';
        const imageInput = document.createElement('input');
        imageInput.type = 'file';
        imageInput.accept = 'image/*';
        imageInput.hidden = true;
        imageWrapper.append(imagePreview, imagePlaceholder);
        if (Number(track.duration) > 0) {
            const durationBadge = document.createElement('span');
            durationBadge.className = 'quick-add-duration-badge';
            durationBadge.textContent = formatTrackTime(Number(track.duration));
            imageWrapper.appendChild(durationBadge);
        }
        imageWrapper.append(imageStatus, imageInput);
        bindImageDropzone(imageWrapper, imageInput, imagePreview, imageStatus, colorInput, imagePlaceholder);

        let spotifyCoverAvailable = false;
        const spotifyCoverLoaded = new Promise(resolve => {
            if (!track.cover) {
                resolve(false);
                return;
            }
            imagePreview.addEventListener('load', async () => {
                spotifyCoverAvailable = true;
                imagePreview.hidden = false;
                imagePlaceholder.hidden = true;
                imageStatus.textContent = 'Portada de Spotify. Puedes reemplazarla.';
                try {
                    const response = await fetch(track.cover);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const coverColor = await getDominantImageColor(await response.blob());
                    if (!imageInput.files?.[0] && !colorWasChanged) colorInput.value = coverColor;
                } catch (error) {
                    console.error('No se pudo determinar el color de la portada de Spotify.', error);
                }
                resolve(true);
            }, { once: true });
            imagePreview.addEventListener('error', () => {
                imagePreview.hidden = true;
                imagePlaceholder.hidden = false;
                imageStatus.textContent = 'No se cargó la portada. Selecciona una imagen para reemplazarla.';
                resolve(false);
            }, { once: true });
            imagePreview.src = track.cover;
        });

        const details = document.createElement('div');
        details.className = 'quick-add-details';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.maxLength = 200;
        nameInput.required = true;
        nameInput.value = track.name || '';
        nameInput.setAttribute('aria-label', 'Nombre de la canción');
        const artistInput = document.createElement('input');
        artistInput.type = 'text';
        artistInput.maxLength = 200;
        artistInput.required = true;
        artistInput.value = track.artist || '';
        artistInput.setAttribute('aria-label', 'Artista');
        details.append(createQuickAddField('NOMBRE', nameInput), createQuickAddField('ARTISTA', artistInput));

        const mediaRow = document.createElement('div');
        mediaRow.className = 'quick-add-media-row';
        const audioInput = document.createElement('input');
        audioInput.type = 'file';
        audioInput.accept = 'audio/*';
        audioInput.setAttribute('aria-label', 'Seleccionar archivo MP3');
        const youtubeInput = document.createElement('input');
        youtubeInput.type = 'url';
        youtubeInput.placeholder = 'O pega un enlace de YouTube...';
        youtubeInput.setAttribute('aria-label', 'Enlace de YouTube');
        mediaRow.append(createQuickAddField('ARCHIVO MP3', audioInput), createQuickAddField('YOUTUBE', youtubeInput));

        const youtubeSearch = document.createElement('div');
        youtubeSearch.className = 'youtube-search';
        const youtubeSearchControls = document.createElement('div');
        youtubeSearchControls.className = 'quick-add-media-row';
        const youtubeSearchInput = document.createElement('input');
        youtubeSearchInput.type = 'search';
        youtubeSearchInput.maxLength = 200;
        youtubeSearchInput.value = `${track.name || ''} ${track.artist || ''}`.trim();
        youtubeSearchInput.placeholder = 'Buscar título y artista en YouTube...';
        youtubeSearchInput.setAttribute('aria-label', 'Buscar esta canción en YouTube');
        const youtubeSearchButton = document.createElement('button');
        youtubeSearchButton.type = 'button';
        youtubeSearchButton.className = 'main-play-btn';
        youtubeSearchButton.textContent = 'Buscar en YouTube';
        youtubeSearchControls.append(createQuickAddField('BÚSQUEDA', youtubeSearchInput), youtubeSearchButton);
        const youtubeSearchResults = document.createElement('div');
        youtubeSearchResults.className = 'youtube-search-results';
        const youtubeSelectedResult = document.createElement('div');
        youtubeSelectedResult.className = 'youtube-selected-result';
        youtubeSelectedResult.setAttribute('aria-live', 'polite');
        youtubeSearch.append(youtubeSearchControls, youtubeSearchResults, youtubeSelectedResult);

        const optionsRow = document.createElement('div');
        optionsRow.className = 'quick-add-options-row';
        const colorField = createQuickAddField('COLOR', colorInput);
        colorField.classList.add('quick-add-color-field');
        const uploadStatus = document.createElement('span');
        uploadStatus.className = 'quick-add-upload-status';
        uploadStatus.setAttribute('aria-live', 'polite');
        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'main-play-btn quick-add-save';
        saveButton.textContent = 'Añadir canción';
        optionsRow.append(colorField, uploadStatus, saveButton);

        form.append(imageWrapper, details, mediaRow, youtubeSearch, optionsRow);
        card.append(cardHeading, form);
        cards.appendChild(card);
        bindYoutubeSearch({
            searchInput: youtubeSearchInput,
            searchButton: youtubeSearchButton,
            searchResults: youtubeSearchResults,
            selectedResult: youtubeSelectedResult,
            youtubeInput,
            searchContext: 'la canción'
        });
        youtubeInput.addEventListener('input', () => {
            if (youtubeInput.value.trim()) audioInput.value = '';
        });
        audioInput.addEventListener('change', () => {
            if (audioInput.files?.[0]) {
                youtubeInput.value = '';
                youtubeInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });

        saveButton.addEventListener('click', async () => {
            const name = nameInput.value.trim();
            const artist = artistInput.value.trim();
            const youtubeLink = youtubeInput.value.trim();
            const audioFile = audioInput.files?.[0];
            if (!name || !artist) {
                showToast('Indica el nombre de la canción y su artista.', true);
                return;
            }
            if (!audioFile && !youtubeLink) {
                showToast('Selecciona un archivo MP3 o ingresa un enlace de YouTube.', true);
                return;
            }
            if (youtubeLink && !isValidYoutubeLink(youtubeLink)) {
                showToast('El enlace de YouTube no es válido.', true);
                youtubeInput.focus();
                return;
            }

            saveButton.disabled = true;
            let ytProgress = null;
            let pendingCatalogSongId = null;
            let savedSong = null;
            try {
                if (track.cover && !imageInput.files?.[0]) {
                    await Promise.race([spotifyCoverLoaded, new Promise(resolve => setTimeout(resolve, 4000))]);
                }
                const formData = new FormData();
                formData.append('name', name);
                formData.append('artist', artist);
                formData.append('color', colorInput.value);
                formData.append('lyricsReady', 'false');
                formData.append('lyrics', '');
                formData.append('lyricColors', '[]');
                formData.append('lyricColorAssignments', '{}');
                formData.append('duration', String(Math.max(0, Number(track.duration) || 0)));
                if (imageInput.files?.[0]) formData.append('cover', imageInput.files[0]);
                else if (spotifyCoverAvailable && track.cover) formData.append('coverUrl', track.cover);

                pendingCatalogSongId = registerPendingCatalogSong({
                    name,
                    artist,
                    cover: imageInput.files?.[0] || (spotifyCoverAvailable ? track.cover : ''),
                    status: youtubeLink ? 'Descargando audio...' : 'Subiendo canción...'
                });
                if (youtubeLink) {
                    ytProgress = startYtDownloadProgress(`Descargando: ${name} - ${artist}`);
                    if (desktopYoutubeDownloader) {
                        const downloadedAudio = await desktopYoutubeDownloader(youtubeLink);
                        formData.append(
                            'mp3',
                            new File([downloadedAudio.bytes], `${downloadedAudio.title}.mp3`, { type: 'audio/mpeg' })
                        );
                    } else {
                        formData.append('ytLink', youtubeLink);
                    }
                } else if (audioFile) {
                    formData.append('mp3', audioFile);
                }

                uploadStatus.textContent = 'Guardando en el catálogo...';
                updatePendingCatalogSong(pendingCatalogSongId, 'Guardando canción...');
                const createResponse = await apiFetch(`${API_URL}/songs`, { method: 'POST', body: formData });
                const createResult = await createResponse.json().catch(() => null);
                if (!createResponse.ok) throw new Error(createResult?.error || 'No se pudo agregar la canción al catálogo.');
                savedSong = createResult;
                await showSavedCatalogSong(savedSong);
                removePendingCatalogSong(pendingCatalogSongId);
                pendingCatalogSongId = null;

                const linkResponse = await apiFetch(
                    `${API_URL}/playlists/${encodeURIComponent(playlistData.id)}/spotify-tracks/${encodeURIComponent(track.spotifyTrackId)}/add`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ songId: savedSong._id })
                    }
                );
                const linkResult = await linkResponse.json().catch(() => null);
                if (!linkResponse.ok) {
                    throw new Error(`La canción se agregó al catálogo, pero no se pudo vincular a la playlist: ${linkResult?.error || 'error del servidor'}`);
                }

                if (ytProgress) stopYtDownloadProgress(ytProgress, { success: true, message: `${name} - ${artist} agregada.` });
                card.remove();
                await loadPlaylists();
                if (activePlaylistId === playlistData.id) openPlaylistView(playlistData.id);
                const remainingTracks = cards.querySelectorAll('.quick-add-card').length;
                dialogTitle.textContent = `Añadir canciones faltantes (${remainingTracks})`;
                if (remainingTracks === 0) {
                    dialog.close();
                    showToast(`Todas las canciones faltantes se agregaron a “${playlistData.name}”.`);
                } else {
                    showToast(`“${name}” se agregó. Quedan ${remainingTracks} canciones por añadir.`);
                }
            } catch (error) {
                if (pendingCatalogSongId) removePendingCatalogSong(pendingCatalogSongId);
                if (ytProgress) {
                    stopYtDownloadProgress(ytProgress, {
                        success: false,
                        message: error.message || 'No se pudo agregar la canción.',
                        error: true
                    });
                }
                console.error('No se pudo agregar directamente la canción de Spotify.', error);
                uploadStatus.textContent = error.message || 'No se pudo agregar la canción.';
                showToast(error.message || 'No se pudo agregar la canción.', true);
                saveButton.disabled = false;
            }
        });
        });
    }

    async function loadSpotifyPlaylists(append = false) {
        if (!spotifyIsConnected || !spotifyPlaylistScopesGranted || !spotifyPlaylistImportStatus) return;
        const offset = append ? spotifyPlaylistsNextOffset : 0;
        if (spotifyPlaylistsLoadButton) spotifyPlaylistsLoadButton.disabled = true;
        if (spotifyPlaylistsMoreButton) spotifyPlaylistsMoreButton.disabled = true;
        spotifyPlaylistImportStatus.textContent = append ? 'Cargando más playlists...' : 'Cargando playlists de Spotify...';
        try {
            const response = await apiFetch(`${API_URL}/spotify/playlists?offset=${offset}`);
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || 'No se pudieron cargar las playlists.');
            const rows = Array.isArray(result?.playlists) ? result.playlists : [];
            spotifyPlaylists = append ? [...spotifyPlaylists, ...rows] : rows;
            spotifyPlaylistsNextOffset = Number(result.nextOffset) || offset;
            spotifyPlaylistsHasMore = result.hasMore === true;
            spotifyPlaylistsLoaded = true;
            renderSpotifyPlaylists();
            spotifyPlaylistImportStatus.textContent = `${spotifyPlaylists.length} de ${Number(result.total) || 0} playlists cargadas.`;
            if (spotifyPlaylistsMoreButton) spotifyPlaylistsMoreButton.hidden = !spotifyPlaylistsHasMore;
            if (spotifyPlaylistsLoadButton) spotifyPlaylistsLoadButton.hidden = spotifyPlaylistsHasMore || spotifyPlaylists.length > 0;
        } catch (error) {
            console.error('No se pudieron cargar las playlists de Spotify.', error);
            spotifyPlaylistImportStatus.textContent = error.message || 'No se pudieron cargar las playlists de Spotify.';
            showToast(spotifyPlaylistImportStatus.textContent, true);
        } finally {
            if (spotifyPlaylistsLoadButton) spotifyPlaylistsLoadButton.disabled = false;
            if (spotifyPlaylistsMoreButton) spotifyPlaylistsMoreButton.disabled = false;
        }
    }

    async function loadSpotifyStatus(loadTracks = false) {
        if (!getStoredUser()?._id || !accessToken || !navigator.onLine) return;
        try {
            const response = await apiFetch(`${API_URL}/spotify/status`);
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || 'No se pudo consultar Spotify.');
            const connectionChanged = spotifyIsConnected !== result.connected;
            const requiredScopesChanged = spotifyRequiredScopesGranted !== (result.requiredScopesGranted === true);
            const playlistScopesChanged = spotifyPlaylistScopesGranted !== (result.playlistScopesGranted === true);
            const identityLinkChanged = spotifyIdentityLinked !== (result.identityLinked === true);
            spotifyIsConnected = result.connected;
            spotifyRequiredScopesGranted = result.requiredScopesGranted === true;
            spotifyPlaylistScopesGranted = result.playlistScopesGranted === true;
            spotifyIdentityLinked = result.identityLinked === true;
            if (!result.connected) {
                spotifyIdentityLinked = false;
                spotifyApiAccessToken = '';
                spotifyApiAccessTokenExpiresAt = 0;
                spotifyApiAccessTokenUserId = '';
                spotifyApiAccessTokenRequest = null;
                spotifyPlaylists = [];
                spotifyPlaylistsNextOffset = 0;
                spotifyPlaylistsHasMore = false;
                spotifyPlaylistsLoaded = false;
                spotifyPlaylistsList?.replaceChildren();
            }
            if (spotifyConnectButton) {
                spotifyConnectButton.hidden = result.connected
                    && spotifyRequiredScopesGranted
                    && spotifyIdentityLinked;
                spotifyConnectButton.disabled = !result.configured;
                spotifyConnectButton.textContent = result.connected
                    ? 'Actualizar permisos de Spotify'
                    : 'Conectar Spotify';
                if (!result.configured) spotifyConnectButton.title = 'Configura Spotify en el servidor.';
            }
            if (spotifyRefreshButton) spotifyRefreshButton.hidden = !result.connected || !spotifyRequiredScopesGranted;
            if (spotifyDisconnectButton) spotifyDisconnectButton.hidden = !result.connected;
            if (spotifyLoadMoreButton) spotifyLoadMoreButton.hidden = !result.connected || !spotifyRequiredScopesGranted || !spotifyHasMore;
            if (spotifyLikesSearch) spotifyLikesSearch.hidden = !result.connected;
            if (spotifyLikesStatus) {
                spotifyLikesStatus.textContent = result.connected
                    ? `Conectado${result.displayName ? ` como ${result.displayName}` : ''}.${!spotifyRequiredScopesGranted
                        ? ' Actualiza los permisos para habilitar todas las funciones de Spotify.'
                        : !spotifyIdentityLinked
                            ? ' Actualiza la conexión para vincular Spotify con tu usuario de AMGC.'
                            : ''}`
                    : result.configured
                        ? 'Conecta Spotify para cargar tus canciones guardadas.'
                        : 'Spotify requiere configuración del servidor.';
            }
            updateSpotifyPlaylistImportForm();
            if (
                result.connected
                && result.playlistScopesGranted
                && (connectionChanged || requiredScopesChanged || playlistScopesChanged || identityLinkChanged)
                && isPlaylistViewMode
                && activePlaylistId
            ) {
                openPlaylistView(activePlaylistId);
            }
            if (result.connected && spotifyRequiredScopesGranted && (
                loadTracks
                || (connectionChanged && !spotifyLikedTracksLoaded)
                || (spotifyLikesSection?.open && !spotifyLikedTracksLoaded)
            )) {
                await loadSpotifyLikedTracks();
            }
        } catch (error) {
            console.error('No se pudo consultar el estado de Spotify.', error);
            if (spotifyLikesStatus) spotifyLikesStatus.textContent = error.message || 'No se pudo consultar Spotify.';
        }
    }

    async function startSpotifyAuthorization(button) {
        button.disabled = true;
        try {
            const response = await apiFetch(`${API_URL}/spotify/connect`, { method: 'POST' });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || 'No se pudo iniciar la conexión con Spotify.');
            window.location.assign(result.authorizationUrl);
        } catch (error) {
            console.error('No se pudo iniciar la conexión con Spotify.', error);
            showToast(error.message || 'No se pudo conectar Spotify.', true);
            button.disabled = false;
        }
    }

    spotifyConnectButton?.addEventListener('click', () => startSpotifyAuthorization(spotifyConnectButton));
    spotifyPlaylistConnectButton?.addEventListener('click', () => startSpotifyAuthorization(spotifyPlaylistConnectButton));

    spotifyRefreshButton?.addEventListener('click', () => loadSpotifyLikedTracks(true));
    spotifyLoadMoreButton?.addEventListener('click', () => loadSpotifyLikedTracks(false, true));
    spotifyDisconnectButton?.addEventListener('click', async () => {
        spotifyDisconnectButton.disabled = true;
        try {
            const response = await apiFetch(`${API_URL}/spotify/disconnect`, { method: 'POST' });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || 'No se pudo desconectar Spotify.');
            spotifyIsConnected = false;
            spotifyRequiredScopesGranted = false;
            spotifyPlaylistScopesGranted = false;
            spotifyIdentityLinked = false;
            spotifyApiAccessToken = '';
            spotifyApiAccessTokenExpiresAt = 0;
            spotifyApiAccessTokenUserId = '';
            spotifyApiAccessTokenRequest = null;
            spotifyLikedTracks = [];
            spotifySelectedTrackIds.clear();
            spotifyNextOffset = 0;
            spotifyTotal = 0;
            spotifyHasMore = false;
            spotifyLikedTracksLoaded = false;
            spotifyPlaylists = [];
            spotifyPlaylistsNextOffset = 0;
            spotifyPlaylistsHasMore = false;
            spotifyPlaylistsLoaded = false;
            spotifyPlaylistsList?.replaceChildren();
            spotifyLikesList?.replaceChildren();
            if (spotifyLikesSearch) {
                spotifyLikesSearch.value = '';
                spotifyLikesSearch.hidden = true;
            }
            spotifyRefreshButton.hidden = true;
            spotifyDisconnectButton.hidden = true;
            spotifyLoadMoreButton.hidden = true;
            spotifyImportButton.hidden = true;
            spotifyConnectButton.hidden = false;
            spotifyConnectButton.textContent = 'Conectar Spotify';
            if (spotifyLikesStatus) spotifyLikesStatus.textContent = 'Spotify desconectado.';
            if (spotifyPlaylistImportStatus) spotifyPlaylistImportStatus.textContent = 'Spotify desconectado.';
            if (spotifyPlaylistsLoadButton) spotifyPlaylistsLoadButton.hidden = true;
            if (spotifyPlaylistsMoreButton) spotifyPlaylistsMoreButton.hidden = true;
            updateSpotifyPlaylistImportForm();
        } catch (error) {
            console.error('No se pudo desconectar Spotify.', error);
            showToast(error.message || 'No se pudo desconectar Spotify.', true);
        } finally {
            spotifyDisconnectButton.disabled = false;
        }
    });
    spotifyLikesSearch?.addEventListener('input', renderSpotifyLikedTracks);
    spotifyPlaylistsLoadButton?.addEventListener('click', () => loadSpotifyPlaylists());
    spotifyPlaylistsMoreButton?.addEventListener('click', () => loadSpotifyPlaylists(true));
    spotifyLikesSection?.addEventListener('toggle', () => {
        if (spotifyLikesSection.open && spotifyIsConnected && !spotifyLikedTracksLoaded) {
            void loadSpotifyLikedTracks();
        }
    });
    spotifyImportButton?.addEventListener('click', async () => {
        const trackIds = [...spotifySelectedTrackIds];
        if (!trackIds.length) return;
        const tracks = spotifyLikedTracks
            .filter(track => spotifySelectedTrackIds.has(track.id))
            .map(({ id, name, artist, coverUrl, duration }) => ({ id, name, artist, coverUrl, duration }));
        spotifyImportButton.disabled = true;
        spotifyLikesStatus.textContent = 'Importando canciones como sugerencias...';
        try {
            const response = await apiFetch(`${API_URL}/spotify/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tracks })
            });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || 'No se pudieron importar las canciones.');
            spotifySelectedTrackIds.clear();
            await loadSongSuggestions(false);
            await loadSpotifyLikedTracks(true);
            spotifyLikesStatus.textContent = `Se importaron ${result.imported} sugerencias; ${result.duplicates} ya existían.`;
            showToast(spotifyLikesStatus.textContent);
        } catch (error) {
            console.error('No se pudieron importar las canciones de Spotify.', error);
            spotifyLikesStatus.textContent = error.message || 'No se pudieron importar las canciones.';
            showToast(spotifyLikesStatus.textContent, true);
        } finally {
            spotifyImportButton.disabled = false;
        }
    });

    const spotifyCallbackResult = new URLSearchParams(window.location.search).get('spotify');
    if (spotifyCallbackResult) {
        const callbackUrl = new URL(window.location.href);
        callbackUrl.searchParams.delete('spotify');
        window.history.replaceState({}, '', callbackUrl);
        if (spotifyCallbackResult === 'connected') {
            showToast('Cuenta de Spotify conectada.');
            void loadSpotifyStatus(true);
        } else {
            showToast('No se pudo conectar Spotify. Revisa la configuración y vuelve a intentarlo.', true);
            void loadSpotifyStatus();
        }
    } else {
        void loadSpotifyStatus();
    }
    window.addEventListener('focus', () => {
        void loadSpotifyStatus(spotifyLikesSection?.open && !spotifyLikedTracksLoaded);
    });

    function openQuickAddPanel(selectedSuggestion = null) {
        if (!canCurrentUser('edit_songs')) {
            showToast('No tienes permiso para agregar canciones desde las sugerencias.', true);
            return;
        }
        isLyricsMode = false;
        isAllSongsMode = false;
        isQuickAddMode = true;
        isPlaylistViewMode = false;
        isEditSongMode = false;
        isEditPlaylistMode = false;
        isSettingsMode = false;
        isAdminMode = false;
        isProfileMode = false;
        renderQuickAddSuggestions();
        updateBackgroundAndViews();
        if (selectedSuggestion?._id) {
            requestAnimationFrame(() => {
                Array.from(quickAddSuggestionsList?.children || [])
                    .find(item => item.dataset.suggestionId === String(selectedSuggestion._id))
                    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            });
        }
    }

    function createQuickAddField(labelText, input) {
        const label = document.createElement('label');
        label.className = 'quick-add-field';
        const labelTextElement = document.createElement('span');
        labelTextElement.textContent = labelText;
        label.append(labelTextElement, input);
        return label;
    }

    function bindYoutubeSearch({
        searchInput,
        searchButton,
        searchResults,
        selectedResult,
        youtubeInput,
        searchContext
    }) {
        let selectedUrl = '';
        searchButton.addEventListener('click', async () => {
            const query = searchInput.value.trim();
            if (!query) {
                showToast('Escribe una canción y un artista para buscar en YouTube.', true);
                return;
            }

            if (youtubeInput.value.trim() === selectedUrl) youtubeInput.value = '';
            selectedUrl = '';
            selectedResult.replaceChildren();
            searchResults.replaceChildren();
            searchButton.disabled = true;
            searchButton.textContent = 'Buscando...';
            try {
                const response = await apiFetch(`${API_URL}/youtube/search?q=${encodeURIComponent(query)}`);
                const results = await response.json().catch(() => null);
                if (!response.ok) throw new Error(results?.error || 'No se pudo buscar en YouTube.');
                if (!Array.isArray(results) || !results.length) {
                    searchResults.textContent = 'No se encontraron resultados.';
                    return;
                }

                for (const result of results) {
                    const resultButton = document.createElement('button');
                    resultButton.type = 'button';
                    resultButton.className = 'youtube-search-result';
                    if (result.thumbnail) {
                        const thumbnail = document.createElement('img');
                        thumbnail.src = result.thumbnail;
                        thumbnail.alt = '';
                        thumbnail.loading = 'lazy';
                        resultButton.appendChild(thumbnail);
                    }
                    const resultInfo = document.createElement('span');
                    const resultTitle = document.createElement('strong');
                    resultTitle.textContent = result.title || 'Video sin título';
                    const resultChannel = document.createElement('small');
                    resultChannel.textContent = result.channel || 'Canal desconocido';
                    const resultDuration = document.createElement('small');
                    resultDuration.className = 'youtube-duration';
                    resultDuration.textContent = result.duration || 'Duración no disponible';
                    resultInfo.append(resultTitle, resultChannel, resultDuration);
                    resultButton.appendChild(resultInfo);
                    resultButton.addEventListener('click', () => {
                        selectedUrl = result.url;
                        youtubeInput.value = result.url;
                        youtubeInput.dispatchEvent(new Event('input', { bubbles: true }));
                        const selectedLabel = document.createElement('span');
                        selectedLabel.textContent = 'Video seleccionado:';
                        const selectedLink = document.createElement('a');
                        selectedLink.href = result.url;
                        selectedLink.target = '_blank';
                        selectedLink.rel = 'noopener noreferrer';
                        selectedLink.textContent = result.url;
                        selectedLink.setAttribute('aria-label', `Abrir ${result.title || 'video'} en YouTube`);
                        selectedResult.replaceChildren(selectedLabel, selectedLink);
                    });
                    searchResults.appendChild(resultButton);
                }
            } catch (error) {
                console.error(`No se pudo buscar ${searchContext} en YouTube.`, error);
                searchResults.textContent = error.message || 'No se pudo buscar en YouTube.';
            } finally {
                searchButton.disabled = false;
                searchButton.textContent = 'Buscar en YouTube';
            }
        });

        youtubeInput.addEventListener('input', () => {
            if (youtubeInput.value.trim() !== selectedUrl) {
                selectedUrl = '';
                selectedResult.replaceChildren();
            }
        });

        return () => {
            selectedUrl = '';
            searchResults.replaceChildren();
            selectedResult.replaceChildren();
            searchButton.disabled = false;
            searchButton.textContent = 'Buscar en YouTube';
        };
    }

    const resetEditYoutubeSearch = bindYoutubeSearch({
        searchInput: editYoutubeSearchInput,
        searchButton: editYoutubeSearchButton,
        searchResults: editYoutubeSearchResults,
        selectedResult: editYoutubeSelectedResult,
        youtubeInput: editInputYt,
        searchContext: 'la canción'
    });

    function renderQuickAddSuggestions() {
        if (!quickAddSuggestionsList) return;
        if (!canCurrentUser('edit_songs')) {
            quickAddSuggestionsList.replaceChildren();
            return;
        }

        const existingCards = new Map(
            Array.from(quickAddSuggestionsList.querySelectorAll('.quick-add-card'))
                .map(card => [card.dataset.suggestionId, card])
        );
        const fragment = document.createDocumentFragment();
        if (!songSuggestions.length) {
            const emptyMessage = document.createElement('li');
            emptyMessage.className = 'quick-add-empty';
            emptyMessage.textContent = 'No hay sugerencias pendientes.';
            fragment.appendChild(emptyMessage);
        }

        songSuggestions.forEach(suggestion => {
            const suggestionId = String(suggestion._id || '');
            const existingCard = existingCards.get(suggestionId);
            if (existingCard) {
                fragment.appendChild(existingCard);
                return;
            }

            const card = document.createElement('li');
            card.className = 'quick-add-card';
            card.dataset.suggestionId = suggestionId;

            const heading = document.createElement('div');
            heading.className = 'quick-add-card-heading';
            const headingText = document.createElement('div');
            const title = document.createElement('h3');
            title.textContent = suggestion.name || 'Canción sin nombre';
            const artist = document.createElement('p');
            artist.textContent = suggestion.artist || 'Artista desconocido';
            headingText.append(title, artist);
            const author = document.createElement('span');
            author.className = 'quick-add-author';
            author.textContent = `Sugerida por ${suggestion.suggestedByName || 'Desconocido'}`;
            heading.append(headingText, author);

            const form = document.createElement('div');
            form.className = 'quick-add-card-form';
            const imageWrapper = document.createElement('div');
            imageWrapper.className = 'quick-add-cover image-dropzone';
            imageWrapper.setAttribute('role', 'button');
            imageWrapper.tabIndex = 0;
            imageWrapper.setAttribute('aria-label', `Seleccionar o arrastrar una portada para ${suggestion.name || 'la canción'}`);
            const imagePreview = document.createElement('img');
            imagePreview.className = 'quick-add-cover-preview';
            imagePreview.alt = '';
            imagePreview.hidden = true;
            const imagePlaceholder = document.createElement('span');
            imagePlaceholder.className = 'quick-add-cover-placeholder';
            imagePlaceholder.innerHTML = '<strong>+</strong><span>Seleccionar o arrastrar foto</span>';
            const imageStatus = document.createElement('span');
            imageStatus.className = 'image-drop-hint';
            imageStatus.setAttribute('aria-live', 'polite');
            imageStatus.textContent = 'Portada';
            const imageInput = document.createElement('input');
            imageInput.type = 'file';
            imageInput.accept = 'image/*';
            imageInput.hidden = true;
            imageWrapper.append(imagePreview, imagePlaceholder);
            if (Number(suggestion.duration) > 0) {
                const durationBadge = document.createElement('span');
                durationBadge.className = 'quick-add-duration-badge';
                durationBadge.textContent = `${formatTrackTime(Number(suggestion.duration))}`;
                imageWrapper.appendChild(durationBadge);
            }
            imageWrapper.append(imageStatus, imageInput);
            const details = document.createElement('div');
            details.className = 'quick-add-details';
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.maxLength = 200;
            nameInput.value = suggestion.name || '';
            nameInput.required = true;
            nameInput.setAttribute('aria-label', 'Nombre de la canción');
            const artistInput = document.createElement('input');
            artistInput.type = 'text';
            artistInput.maxLength = 200;
            artistInput.value = suggestion.artist || '';
            artistInput.required = true;
            artistInput.setAttribute('aria-label', 'Artista');
            details.append(
                createQuickAddField('NOMBRE', nameInput),
                createQuickAddField('ARTISTA', artistInput)
            );

            const mediaRow = document.createElement('div');
            mediaRow.className = 'quick-add-media-row';
            const audioInput = document.createElement('input');
            audioInput.type = 'file';
            audioInput.accept = 'audio/*';
            audioInput.setAttribute('aria-label', 'Seleccionar archivo MP3');
            const youtubeInput = document.createElement('input');
            youtubeInput.type = 'url';
            youtubeInput.placeholder = 'O pega un enlace de YouTube...';
            youtubeInput.setAttribute('aria-label', 'Enlace de YouTube');
            mediaRow.append(
                createQuickAddField('ARCHIVO MP3', audioInput),
                createQuickAddField('YOUTUBE', youtubeInput)
            );

            const youtubeSearch = document.createElement('div');
            youtubeSearch.className = 'youtube-search';
            const youtubeSearchControls = document.createElement('div');
            youtubeSearchControls.className = 'quick-add-media-row';
            const youtubeSearchInput = document.createElement('input');
            youtubeSearchInput.type = 'search';
            youtubeSearchInput.value = `${suggestion.name || ''} ${suggestion.artist || ''}`.trim();
            youtubeSearchInput.maxLength = 200;
            youtubeSearchInput.placeholder = 'Buscar título y artista en YouTube...';
            youtubeSearchInput.setAttribute('aria-label', 'Buscar esta sugerencia en YouTube');
            const youtubeSearchButton = document.createElement('button');
            youtubeSearchButton.type = 'button';
            youtubeSearchButton.className = 'main-play-btn';
            youtubeSearchButton.textContent = 'Buscar en YouTube';
            youtubeSearchControls.append(
                createQuickAddField('BÚSQUEDA', youtubeSearchInput),
                youtubeSearchButton
            );
            const youtubeSearchResults = document.createElement('div');
            youtubeSearchResults.className = 'youtube-search-results';
            const youtubeSelectedResult = document.createElement('div');
            youtubeSelectedResult.className = 'youtube-selected-result';
            youtubeSelectedResult.setAttribute('aria-live', 'polite');
            youtubeSearch.append(youtubeSearchControls, youtubeSearchResults, youtubeSelectedResult);

            const optionsRow = document.createElement('div');
            optionsRow.className = 'quick-add-options-row';
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.value = '#ffffff';
            colorInput.setAttribute('aria-label', '');
            const colorField = createQuickAddField('COLOR', colorInput);
            colorField.classList.add('quick-add-color-field');
            const uploadStatus = document.createElement('span');
            uploadStatus.className = 'quick-add-upload-status';
            uploadStatus.setAttribute('aria-live', 'polite');
            const saveButton = document.createElement('button');
            saveButton.type = 'button';
            saveButton.className = 'main-play-btn quick-add-save';
            saveButton.textContent = 'Agregar canción';
            optionsRow.append(colorField, uploadStatus, saveButton);

            form.append(imageWrapper, details, mediaRow, youtubeSearch, optionsRow);
            card.append(heading, form);
            fragment.appendChild(card);

            bindImageDropzone(
                imageWrapper,
                imageInput,
                imagePreview,
                imageStatus,
                colorInput,
                imagePlaceholder
            );
            const spotifyCoverLoadPromise = suggestion.coverUrl
                ? Promise.resolve().then(async () => {
                    if (imageInput.files?.[0]) return true;
                    imagePreview.src = suggestion.coverUrl;
                    imagePreview.hidden = false;
                    imagePlaceholder.hidden = true;
                    imageStatus.textContent = 'Portada de Spotify. Puedes reemplazarla.';
                    try {
                        const response = await fetch(suggestion.coverUrl);
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        const coverColor = await getDominantImageColor(await response.blob());
                        if (!imageInput.files?.[0]) colorInput.value = coverColor;
                    } catch (error) {
                        console.error('No se pudo determinar el color de la portada de Spotify.', error);
                    }
                    return true;
                })
                : Promise.resolve(true);
            bindYoutubeSearch({
                searchInput: youtubeSearchInput,
                searchButton: youtubeSearchButton,
                searchResults: youtubeSearchResults,
                selectedResult: youtubeSelectedResult,
                youtubeInput,
                searchContext: 'la sugerencia'
            });
            youtubeInput.addEventListener('input', () => {
                if (youtubeInput.value.trim()) audioInput.value = '';
            });
            audioInput.addEventListener('change', () => {
                if (audioInput.files?.[0]) {
                    youtubeInput.value = '';
                    youtubeInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });
            saveButton.addEventListener('click', async () => {
                if (saveButton.disabled) return;
                const name = nameInput.value.trim();
                const songArtist = artistInput.value.trim();
                const youtubeLink = youtubeInput.value.trim();
                const audioFile = audioInput.files?.[0];
                if (!name || !songArtist) {
                    showToast('Indica el nombre de la canción y su artista.', true);
                    return;
                }
                if (!audioFile && !youtubeLink) {
                    showToast('Selecciona un archivo MP3 o ingresa un enlace de YouTube.', true);
                    return;
                }
                if (youtubeLink && !isValidYoutubeLink(youtubeLink)) {
                    showToast('El enlace de YouTube no es válido.', true);
                    youtubeInput.focus();
                    return;
                }

                saveButton.disabled = true;
                let ytProgress = null;
                let pendingCatalogSongId = null;
                try {
                    if (suggestion.coverUrl && !imageInput.files?.[0]) {
                        uploadStatus.textContent = 'Preparando carátula de Spotify...';
                        await spotifyCoverLoadPromise;
                    }
                    const coverFile = imageInput.files?.[0];
                    uploadStatus.textContent = 'Agregando canción...';
                    const formData = new FormData();
                    formData.append('name', name);
                    formData.append('artist', songArtist);
                    formData.append('color', colorInput.value);
                    formData.append('lyricsReady', 'false');
                    formData.append('lyrics', '');
                    formData.append('lyricColors', '[]');
                    formData.append('lyricColorAssignments', '{}');
                    formData.append('duration', String(Math.max(0, Number(suggestion.duration) || 0)));
                    const currentUser = getStoredUser();
                    if (currentUser?._id) formData.append('userId', currentUser._id);
                    if (coverFile) formData.append('cover', coverFile);
                    else if (suggestion.coverUrl) formData.append('coverUrl', suggestion.coverUrl);
                    pendingCatalogSongId = registerPendingCatalogSong({
                        name,
                        artist: songArtist,
                        cover: coverFile || suggestion.coverUrl || '',
                        status: youtubeLink ? 'Preparando descarga de audio...' : 'Subiendo canción...'
                    });
                    if (youtubeLink) {
                        uploadStatus.textContent = 'Descargando audio...';
                        updatePendingCatalogSong(pendingCatalogSongId, 'Descargando audio...');
                        ytProgress = startYtDownloadProgress(`Descargando: ${name} - ${songArtist}`);
                    }
                    if (youtubeLink && desktopYoutubeDownloader) {
                        const downloadedAudio = await desktopYoutubeDownloader(youtubeLink);
                        formData.append(
                            'mp3',
                            new File([downloadedAudio.bytes], `${downloadedAudio.title}.mp3`, { type: 'audio/mpeg' })
                        );
                    } else if (youtubeLink) {
                        formData.append('ytLink', youtubeLink);
                    } else if (audioFile) {
                        formData.append('mp3', audioFile);
                    }

                    uploadStatus.textContent = 'Subiendo canción...';
                    updatePendingCatalogSong(pendingCatalogSongId, 'Guardando audio en Drive y actualizando catálogo...');
                    const response = await apiFetch(`${API_URL}/songs`, { method: 'POST', body: formData });
                    const result = await response.json().catch(() => null);
                    if (!response.ok) throw new Error(result?.error || 'No se pudo agregar la canción.');
                    await showSavedCatalogSong(result);
                    removePendingCatalogSong(pendingCatalogSongId);
                    if (!socket.connected) void fetchMusicData();

                    if (youtubeLink) {
                        stopYtDownloadProgress(ytProgress, { success: true, message: `${name} - ${songArtist} descargada y agregada.` });
                    }
                    try {
                        uploadStatus.textContent = 'Completando sugerencia...';
                        const completionResponse = await apiFetch(
                            `${API_URL}/song-suggestions/${encodeURIComponent(suggestionId)}/complete`,
                            { method: 'POST' }
                        );
                        const completionResult = await completionResponse.json().catch(() => null);
                        if (!completionResponse.ok) {
                            throw new Error(completionResult?.error || 'No se pudo cerrar la sugerencia.');
                        }
                        songSuggestions = songSuggestions.filter(item => String(item._id) !== suggestionId);
                        renderAllSongs();
                        renderQuickAddSuggestions();
                        showToast('Canción agregada y sugerencia completada.');
                    } catch (error) {
                        console.error('La canción se guardó, pero la sugerencia no se pudo cerrar.', error);
                        showToast('La canción se guardó, pero no se pudo cerrar la sugerencia.', true);
                    }
                } catch (error) {
                    if (pendingCatalogSongId) removePendingCatalogSong(pendingCatalogSongId);
                    if (youtubeLink) {
                        stopYtDownloadProgress(ytProgress, {
                            success: false,
                            message: error.message || 'No se pudo agregar la canción sugerida.',
                            error: true
                        });
                    }
                    console.error('No se pudo agregar la canción sugerida.', error);
                    showToast(error.message || 'No se pudo agregar la canción.', true);
                } finally {
                    saveButton.disabled = false;
                    saveButton.textContent = 'Agregar canción';
                    uploadStatus.textContent = '';
                }
            });
        });

        quickAddSuggestionsList.replaceChildren(fragment);
    }

    btnCloseQuickAdd?.addEventListener('click', () => {
        isQuickAddMode = false;
        isAllSongsMode = true;
        updateBackgroundAndViews();
    });

    async function loadSongSuggestions(reportError = true) {
        if (!getStoredUser()?._id || !accessToken || offlineOnly || !navigator.onLine) return;
        try {
            const response = await apiFetch(`${API_URL}/song-suggestions`);
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || 'No se pudieron cargar las sugerencias.');
            songSuggestions = Array.isArray(result) ? result : [];
            renderAllSongs();
            renderQuickAddSuggestions();
        } catch (error) {
            console.warn('No se pudieron actualizar las sugerencias de canciones.', error);
            if (reportError) showToast(error.message || 'No se pudieron cargar las sugerencias.', true);
        }
    }

    async function deleteSongSuggestion(suggestion) {
        if (!canCurrentUser('delete_songs')) {
            showToast('No tienes permiso para eliminar sugerencias.', true);
            return;
        }
        try {
            const response = await apiFetch(`${API_URL}/song-suggestions/${encodeURIComponent(suggestion._id)}`, {
                method: 'DELETE'
            });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || 'No se pudo eliminar la sugerencia.');
            songSuggestions = songSuggestions.filter(item => String(item._id) !== String(suggestion._id));
            renderAllSongs();
        } catch (error) {
            console.error('No se pudo eliminar la sugerencia de canción.', error);
            showToast(error.message || 'No se pudo eliminar la sugerencia.', true);
        }
    }

    songSuggestionForm?.addEventListener('submit', async event => {
        event.preventDefault();
        const suggestionText = songSuggestionInput?.value.trim() || '';
        const match = suggestionText.match(/^(.+)\s+de\s+(.+)$/i);
        const name = match?.[1]?.trim() || '';
        const artist = match?.[2]?.trim() || '';
        const normalizeSongMetadata = value => value
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLocaleLowerCase('es');
        if (name && artist
            && normalizeSongMetadata(name) === 'cancion'
            && normalizeSongMetadata(artist) === 'artista') {
            showToast('Reemplaza “Cancion” y “Artista” por el nombre real de la canción y su artista.', true);
            songSuggestionInput?.focus();
            return;
        }
        if (!name || !artist) {
            showToast('Escribe la sugerencia con el formato “Canción de Artista”.', true);
            songSuggestionInput?.focus();
            return;
        }
        if (!getStoredUser()?._id) {
            showToast('Inicia sesión para sugerir una canción.', true);
            return;
        }
        if (songSuggestionInput) songSuggestionInput.disabled = true;
        try {
            const response = await apiFetch(`${API_URL}/song-suggestions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, artist })
            });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || 'No se pudo enviar la sugerencia.');
            if (songSuggestionInput) songSuggestionInput.value = '';
            songSuggestions = [
                result,
                ...songSuggestions.filter(item => String(item._id) !== String(result?._id))
            ];
            renderAllSongs();
            showToast('Sugerencia enviada.');
        } catch (error) {
            console.error('No se pudo enviar la sugerencia de canción.', error);
            showToast(error.message || 'No se pudo enviar la sugerencia.', true);
        } finally {
            if (songSuggestionInput) songSuggestionInput.disabled = false;
        }
    });

    if (getStoredUser()?._id) void loadSongSuggestions(false);

    if (allSongsSearch) {
        allSongsSearch.addEventListener('input', renderAllSongs);
        allSongsSearch.addEventListener('click', (event) => event.stopPropagation());
    }

    function renderSidebarPlaylists() {
        if(!sidebarPlaylists) return;
        sidebarPlaylists.innerHTML = '';
        const currentUser = getStoredUser();
        const savedPlaylists = Array.isArray(currentUser?.savedPlaylists) ? currentUser.savedPlaylists : [];
        const visiblePlaylists = userPlaylists.filter(pl => {
            const isOwner = String(pl.userId?._id || pl.ownerId || pl.userId) === String(currentUser?._id);
            const isSharedMember = (pl.sharedWith || []).some(member => (
                String(member?._id || member) === String(currentUser?._id)
            ));
            return isOwner || isSharedMember || savedPlaylists.some(savedId => String(savedId) === String(pl.id));
        });
        visiblePlaylists.forEach(pl => {
            const el = document.createElement('div');
            el.className = 'pl-sidebar-item';
            el.innerHTML = createImageMarkup(getPlaylistCover(pl), '', pl.name);
            const playlistId = String(pl.id);
            const isSyncPending = (pl.tracks || []).some(track => track.syncPending)
                || [...pendingPlaylistTrackChanges].some(key => key.startsWith(`${playlistId}:`))
                || pendingPlaylistOrderSaves.has(playlistId);
            if (isSyncPending) {
                const indicator = document.createElement('span');
                indicator.className = 'sync-spinner';
                indicator.setAttribute('role', 'status');
                indicator.setAttribute('aria-label', 'Sincronizando cambios de playlist');
                el.appendChild(indicator);
                el.title = `${pl.name} · Sincronizando cambios`;
            } else {
                el.title = pl.name || 'Playlist';
            }
            
            el.addEventListener('click', () => {
                openPlaylistView(pl.id);
                closeSidebar();
            });
            el.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                if (pl.tracks.length > 0) {
                    activeQueueTracks = pl.tracks.map(t => playlist.find(main => String(main._id) === String(t._id))).filter(Boolean);
                    customQueue = []; 
                    resetPlaybackHistory();
                    renderQueue();
                    loadAndPlayTrack(playlist.indexOf(activeQueueTracks[0]));
                }
            });
            sidebarPlaylists.appendChild(el);
        });
    }

    function generateId() { return 'pl-' + Math.random().toString(36).substring(2, 9); }

    function resetSongDeleteConfirmation() {
        if (deleteSongConfirmation) deleteSongConfirmation.hidden = true;
        if (deleteSongNameStep) deleteSongNameStep.hidden = true;
        if (deleteSongConfirmationTitle) deleteSongConfirmationTitle.textContent = '';
        if (deleteSongNameConfirmation) deleteSongNameConfirmation.value = '';
        if (btnConfirmDeleteSong) {
            btnConfirmDeleteSong.disabled = true;
            btnConfirmDeleteSong.textContent = 'Eliminar';
        }
        if (btnDeleteSong) {
            btnDeleteSong.hidden = false;
            btnDeleteSong.classList.remove('is-delete-confirming');
            btnDeleteSong.dataset.confirmDelete = 'false';
            btnDeleteSong.textContent = 'Eliminar Canción';
        }
    }

    function getSongDeleteConfirmationName(track) {
        return String(track?.name || 'Canción sin nombre').trim();
    }

    async function deleteSong(songId) {
        const track = playlist.find(item => String(item._id) === String(songId));
        const user = getStoredUser();
        if (!track || !user?._id || !canCurrentUser('delete_songs')) {
            showToast('No tienes permiso para eliminar canciones.', true);
            return;
        }
        const trackId = String(track._id);
        const confirmationName = deleteSongNameConfirmation?.value.trim() || '';
        if (pendingSongDeletes.has(trackId)) return;
        if (
            !isEditSongMode
            || editingTrackId !== trackId
            || btnDeleteSong?.dataset.confirmDelete !== 'true'
            || deleteSongConfirmation?.hidden !== false
            || deleteSongNameStep?.hidden !== false
            || !confirmationName
            || confirmationName !== getSongDeleteConfirmationName(track)
        ) {
            showToast('Escribe el nombre exacto de la canción en el editor para confirmar su eliminación.', true);
            return;
        }
        pendingSongDeletes.add(trackId);
        const deletingFromEditor = editingTrackId === trackId && isEditSongMode;
        if (btnConfirmDeleteSong) {
            btnConfirmDeleteSong.disabled = true;
            btnConfirmDeleteSong.textContent = 'Eliminando...';
        }
        try {
            const response = await apiFetch(`${API_URL}/songs/${encodeURIComponent(trackId)}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: user._id, confirmationName })
            });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || 'No se pudo eliminar la canción.');
            if (!socket.connected) await fetchMusicData();
            resetSongDeleteConfirmation();
            isEditSongMode = false;
            editingTrackIndex = null;
            editingTrackId = null;
            isAllSongsMode = true;
            updateBackgroundAndViews();
        } catch (error) {
            console.error('No se pudo eliminar la canción.', error);
            showToast(error.message || 'Error al eliminar la canción.', true);
        } finally {
            pendingSongDeletes.delete(trackId);
            if (deletingFromEditor && isEditSongMode && editingTrackId === trackId && btnConfirmDeleteSong) {
                btnConfirmDeleteSong.disabled = deleteSongNameConfirmation?.value.trim() !== getSongDeleteConfirmationName(track);
                btnConfirmDeleteSong.textContent = 'Eliminar';
            }
        }
    }

    function openEditSongPanel(index = null, suggestion = null) {
        if (!canCurrentUser('edit_songs')) {
            showToast('No tienes permiso para editar canciones.', true);
            return;
        }
        lyricsCancelPromptIndex = 0;
        btnCancelEditedSong.textContent = cancelEditedSongLabel;
        stopEditPreviewAudio();
        editingSuggestionId = suggestion?._id ? String(suggestion._id) : null;
        editingTrackIndex = index;
        editingTrackId = index !== null && playlist[index]?._id ? String(playlist[index]._id) : null;
        resetSongDeleteConfirmation();
        if (btnDeleteSong) btnDeleteSong.disabled = false;
        
        if (index !== null && playlist[index]) {
            const track = playlist[index];
            editingLyricColors = Array.isArray(track.lyricColors)
                ? track.lyricColors.filter(color => /^#[0-9a-f]{6}$/i.test(color))
                : [];
            editingLyricColorAssignments = track.lyricColorAssignments
                && typeof track.lyricColorAssignments === 'object'
                && !Array.isArray(track.lyricColorAssignments)
                ? Object.fromEntries(Object.entries(track.lyricColorAssignments).map(([lineKey, words]) => [
                    lineKey,
                    words && typeof words === 'object' && !Array.isArray(words) ? { ...words } : {}
                ]))
                : {};
            if (getSongCover(track)) {
                editSongDisplayCover.src = getSongCover(track);
                editSongDisplayCover.style.display = 'block';
            } else {
                editSongDisplayCover.removeAttribute('src');
                editSongDisplayCover.style.display = 'none';
            }
            editInputName.value = track.name || '';
            editInputArtist.value = track.artist || '';
            editInputColor.value = isValidSongColor(track.color) ? track.color.slice(0, 7) : "#ffffff";
            editInputLyrics.value = formatTrackLyricsForEditor(track);
            if (editInputLyricsReady) editInputLyricsReady.checked = track.lyricsReady === true;
            if (editSongMetadata) editSongMetadata.hidden = false;
            if (editSongAddedBy) editSongAddedBy.textContent = `Añadida por: ${track.addedBy?.username || 'Desconocido'}`;
            if (editSongEditedBy) editSongEditedBy.textContent = `Editada por: ${track.editedBy?.username || '—'}`;
            if (editSongAddedAt) editSongAddedAt.textContent = `Fecha: ${track.addedAt ? new Date(track.addedAt).toLocaleDateString('es-CL', { timeZone: 'America/Santiago' }) : '—'}`;
            btnSaveEditedSong.textContent = "Guardar Cambios";
            if (btnDeleteSong) btnDeleteSong.style.display = canCurrentUser('delete_songs') ? 'inline-block' : 'none';
        } else {
            editingLyricColors = [];
            editingLyricColorAssignments = {};
            editingTrackIndex = null;
            editSongDisplayCover.removeAttribute('src');
            editSongDisplayCover.style.display = 'none';
            editInputName.value = suggestion?.name || '';
            editInputArtist.value = suggestion?.artist || '';
            editInputColor.value = "#ffffff";
            editInputLyrics.value = '';
            if (editInputLyricsReady) editInputLyricsReady.checked = false;
            if (editSongMetadata) editSongMetadata.hidden = true;
            btnSaveEditedSong.textContent = "Añadir Canción";
            if (btnDeleteSong) btnDeleteSong.style.display = 'none';
        }
        renderLyricColorPalette();
        originalEditLyrics = editInputLyrics.value;
        setEditorStatus(editLyricsStatus, '');

        editInputMp3.value = "";
        if (editInputFileName) editInputFileName.value = "";
        editSongPhoto.value = "";
        editSongPhotoStatus.textContent = 'Haz clic o arrastra una imagen';
        editSongPhotoStatus.classList.remove('error');
        if (editInputYt) editInputYt.value = "";
        if (editYoutubeSearchInput) {
            editYoutubeSearchInput.value = `${editInputName.value} ${editInputArtist.value}`.trim();
        }
        resetEditYoutubeSearch();

        isEditSongMode = true;
        isEditPlaylistMode = false;
        isLyricsMode = false;
        isAllSongsMode = false;
        isPlaylistViewMode = false;
        isSettingsMode = false;
        updateBackgroundAndViews();
        updateEditLyricsPreview();
    }

    function stopEditPreviewAudio(resumePlayback = false) {
        if (editPreviewAudio) {
            editPreviewAudio.pause();
            editPreviewAudio.removeAttribute('src');
            editPreviewAudio.load();
            editPreviewAudio = null;
        }
        if (editPreviewObjectUrl) {
            URL.revokeObjectURL(editPreviewObjectUrl);
            editPreviewObjectUrl = null;
        }
        if (resumePlayback && resumeAudioAfterEditPreview) {
            audio.play().catch(error => console.warn('No se pudo reanudar la reproducción después de la vista previa.', error));
        }
        resumeAudioAfterEditPreview = false;
    }

    function playEditAudioFile(file) {
        stopEditPreviewAudio();
        resumeAudioAfterEditPreview = !audio.paused;
        audio.pause();
        editPreviewObjectUrl = URL.createObjectURL(file);
        editPreviewAudio = new Audio(editPreviewObjectUrl);
        editPreviewAudio.addEventListener('timeupdate', updateEditLyricsPreview);
        editPreviewAudio.addEventListener('seeked', updateEditLyricsPreview);
        editPreviewAudio.addEventListener('ended', updateEditLyricsPreview);
        editPreviewAudio.addEventListener('error', () => {
            setEditorStatus(editLyricsStatus, 'No se pudo reproducir el archivo de audio seleccionado.', true);
        }, { once: true });
        editPreviewAudio.play().then(() => {
            setEditorStatus(editLyricsStatus, 'Reproduciendo una vista previa del archivo seleccionado.');
        }).catch(error => {
            console.error('No se pudo reproducir la vista previa de la canción.', error);
            setEditorStatus(editLyricsStatus, 'No se pudo reproducir el archivo de audio seleccionado.', true);
        });
    }

    if (editInputLyrics) {
        editInputLyrics.addEventListener('input', updateEditLyricsPreview);
    }
    if (btnAddLyricColor && inputNewLyricColor) {
        btnAddLyricColor.addEventListener('click', () => {
            const shouldOpen = lyricColorPicker?.hidden !== false;
            if (lyricColorPicker) lyricColorPicker.hidden = !shouldOpen;
            btnAddLyricColor.setAttribute('aria-expanded', String(shouldOpen));
            if (shouldOpen) {
                inputNewLyricColor.value = editingLyricColors.at(-1) || editInputColor?.value || '#ffffff';
                updateLyricColorSelectionPreview();
            }
        });
        inputNewLyricColor.addEventListener('input', updateLyricColorSelectionPreview);
        inputNewLyricColor.addEventListener('change', updateLyricColorSelectionPreview);
        btnConfirmLyricColor?.addEventListener('click', () => {
            const color = selectedLyricColor;
            if (!/^#[0-9a-f]{6}$/i.test(color)) return;
            if (editingLyricColors.some(existing => existing.toLowerCase() === color)) {
                setEditorStatus(editLyricsStatus, 'Ese color ya está en la paleta.');
                return;
            }
            editingLyricColors.push(color);
            renderLyricColorPalette();
            setEditorStatus(editLyricsStatus, `Color ${editingLyricColors.length} agregado. Guarda los cambios de la canción para compartirlo.`);
            updateEditLyricsPreview(false);
            if (lyricColorPicker) lyricColorPicker.hidden = true;
            btnAddLyricColor.setAttribute('aria-expanded', 'false');
        });
        btnCancelLyricColor?.addEventListener('click', () => {
            if (lyricColorPicker) lyricColorPicker.hidden = true;
            btnAddLyricColor.setAttribute('aria-expanded', 'false');
        });
    }
    editInputColor?.addEventListener('input', renderLyricColorPalette);
    if (editInputMp3) {
        editInputMp3.addEventListener('change', () => {
            stopEditPreviewAudio();
            updateEditLyricsPreview();
            if (editInputMp3.files?.[0]) {
                editInputYt.value = '';
                editInputYt.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
    }
    editInputYt?.addEventListener('input', () => {
        if (editInputYt.value.trim() && editInputMp3.files?.[0]) editInputMp3.value = '';
    });

    if (btnPlayEditedSong) {
        btnPlayEditedSong.addEventListener('click', () => {
            const selectedAudioFile = editInputMp3.files?.[0];
            if (selectedAudioFile) {
                playEditAudioFile(selectedAudioFile);
                return;
            }
            const editedTrack = getEditedTrack();
            const editedTrackIndex = editedTrack
                ? playlist.findIndex(track => String(track._id) === editingTrackId)
                : -1;
            if (editedTrackIndex < 0) {
                setEditorStatus(editLyricsStatus, 'Selecciona un archivo de audio para poder escucharlo y sincronizar la letra.', true);
                return;
            }
            stopEditPreviewAudio();
            loadAndPlayTrack(editedTrackIndex);
            setEditorStatus(editLyricsStatus, 'Reproduciendo la canción editada.');
        });
    }

    if (btnInsertEditLyricTime) {
        btnInsertEditLyricTime.addEventListener('click', () => {
            const editedTrack = getEditedTrack();
            const hasLocalPreview = Boolean(editPreviewAudio);
            if (!hasLocalPreview && (!editedTrack || getTrackStorageId(editedTrack) !== getTrackStorageId(getCurrentTrack()))) {
                setEditorStatus(editLyricsStatus, 'Reproduce esta canción antes de insertar el tiempo actual.', true);
                return;
            }
            const currentTime = hasLocalPreview ? editPreviewAudio.currentTime : audio.currentTime;
            const prefix = editInputLyrics.value && !editInputLyrics.value.endsWith('\n') ? '\n' : '';
            editInputLyrics.value += `${prefix}${formatLyricTimestamp(currentTime)} | `;
            editInputLyrics.focus();
            editInputLyrics.setSelectionRange(editInputLyrics.value.length, editInputLyrics.value.length);
            editInputLyrics.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    if (btnAddSongHeader) {
        btnAddSongHeader.addEventListener('click', () => {
    if (!canCurrentUser('edit_songs')) {
        showToast('No tienes permiso para editar canciones.', true);
        return;
    }
    openEditSongPanel(null);
        });
    }

    async function getDominantImageColor(imageFile) {
        const bitmap = await createImageBitmap(imageFile);
        try {
            const scale = Math.min(1, 64 / Math.max(bitmap.width, bitmap.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) throw new Error('No se pudo analizar la portada.');
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            const colorBuckets = new Map();
            const neutralBuckets = new Map();
            const allBuckets = new Map();
            const addToBucket = (buckets, red, green, blue, weight = 1) => {
                const bucket = `${red >> 4},${green >> 4},${blue >> 4}`;
                const colorBucket = buckets.get(bucket) || {
                    weight: 0,
                    red: 0,
                    green: 0,
                    blue: 0
                };
                colorBucket.weight += weight;
                colorBucket.red += red * weight;
                colorBucket.green += green * weight;
                colorBucket.blue += blue * weight;
                buckets.set(bucket, colorBucket);
            };
            for (let index = 0; index < pixels.length; index += 4) {
                if (pixels[index + 3] < 128) continue;
                const red = pixels[index];
                const green = pixels[index + 1];
                const blue = pixels[index + 2];
                const brightness = Math.max(red, green, blue) / 255;
                const saturation = brightness === 0
                    ? 0
                    : (brightness - Math.min(red, green, blue) / 255) / brightness;
                if (brightness >= 0.14 && saturation >= 0.2) {
                    const weight = saturation ** 1.5 * brightness;
                    addToBucket(colorBuckets, red, green, blue, weight);
                }

                addToBucket(allBuckets, red, green, blue);
                const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
                if (luminance >= 12 && luminance <= 243) {
                    addToBucket(neutralBuckets, red, green, blue);
                }
            }
            const buckets = colorBuckets.size
                ? colorBuckets
                : neutralBuckets.size
                    ? neutralBuckets
                    : allBuckets;
            const dominant = Array.from(buckets.values())
                .sort((left, right) => right.weight - left.weight)[0];
            if (!dominant) throw new Error('No se pudo determinar el color predominante de la portada.');
            return `#${[dominant.red, dominant.green, dominant.blue]
                .map(channel => Math.round(channel / dominant.weight).toString(16).padStart(2, '0'))
                .join('')}`;
        } finally {
            bitmap.close();
        }
    }

    function bindImageDropzone(wrapper, input, preview, status, colorInput = null, placeholder = null) {
        if (!wrapper || !input || !preview || !status) {
            throw new Error('No se pudo inicializar el selector de imágenes.');
        }

        const defaultHint = 'Haz clic o arrastra una imagen';
        const clearDragState = () => wrapper.classList.remove('is-drag-over');
        const previewSelectedImage = async () => {
            const imageFile = input.files?.[0];
            if (!imageFile) return;
            if (!imageFile.type.startsWith('image/')) {
                status.textContent = 'El archivo seleccionado no es una imagen.';
                status.classList.add('error');
                input.value = '';
                return;
            }

            preview.hidden = false;
            if (placeholder) placeholder.hidden = true;
            let colorError = null;
            if (colorInput) {
                status.textContent = 'Calculando el color predominante...';
                try {
                    colorInput.value = await getDominantImageColor(imageFile);
                } catch (error) {
                    colorError = error;
                    console.error('No se pudo determinar el color predominante de la portada.', error);
                }
            }

            const reader = new FileReader();
            reader.onload = event => {
                if (typeof event.target?.result !== 'string') {
                    status.textContent = 'No se pudo leer la imagen.';
                    status.classList.add('error');
                    return;
                }
                preview.src = event.target.result;
                preview.style.display = 'block';
                status.textContent = colorError
                    ? 'Imagen lista..'
                    : colorInput
                        ? 'Imagen lista.'
                        : 'Imagen lista.';
                status.classList.toggle('error', Boolean(colorError));
            };
            reader.onerror = () => {
                status.textContent = 'No se pudo leer la imagen.';
                status.classList.add('error');
            };
            reader.readAsDataURL(imageFile);
        };

        wrapper.addEventListener('click', () => input.click());
        wrapper.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                input.click();
            }
        });
        input.addEventListener('change', previewSelectedImage);

        wrapper.addEventListener('dragenter', event => {
            event.preventDefault();
            if (Array.from(event.dataTransfer?.types || []).includes('Files')) {
                wrapper.classList.add('is-drag-over');
                status.textContent = 'Suelta la imagen aquí';
                status.classList.remove('error');
            }
        });
        wrapper.addEventListener('dragover', event => {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            wrapper.classList.add('is-drag-over');
        });
        wrapper.addEventListener('dragleave', event => {
            if (!wrapper.contains(event.relatedTarget)) {
                clearDragState();
                status.textContent = defaultHint;
            }
        });
        wrapper.addEventListener('drop', event => {
            event.preventDefault();
            clearDragState();
            const imageFile = Array.from(event.dataTransfer?.files || [])
                .find(file => file.type.startsWith('image/'));
            if (!imageFile) {
                status.textContent = 'Arrastra un archivo de imagen para continuar.';
                status.classList.add('error');
                return;
            }

            const transfer = new DataTransfer();
            transfer.items.add(imageFile);
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        return previewSelectedImage;
    }

    bindImageDropzone(songImageEditWrapper, editSongPhoto, editSongDisplayCover, editSongPhotoStatus, editInputColor);
    bindImageDropzone(plImageEditWrapper, editPlPhoto, editPlDisplayCover, editPlPhotoStatus);

    btnSaveEditedSong.addEventListener('click', async () => {
        if (songSaveInProgress) return;
        if (!canCurrentUser('edit_songs')) {
            showToast('No tienes permiso para editar canciones.', true);
            return;
        }
        const trackBeingEdited = editingTrackId
            ? playlist.find(track => String(track._id) === editingTrackId)
            : null;
        if (editingTrackId && !trackBeingEdited) {
            setEditorStatus(editLyricsStatus, 'Esta canción ya no está en el catálogo. Cancela la edición para continuar.', true);
            return;
        }
        songSaveInProgress = true;
        btnSaveEditedSong.textContent = "Guardando...";
        btnSaveEditedSong.disabled = true;
        if (btnDeleteSong) btnDeleteSong.disabled = true;

        const lyricsWereEdited = editInputLyrics.value !== originalEditLyrics;
        const formData = new FormData();
        if (trackBeingEdited) {
            formData.append('id', trackBeingEdited._id);
            formData.append('existingPath', trackBeingEdited.path || '');
            formData.append('existingCover', trackBeingEdited.cover || '');
        }

        formData.append('name', editInputName.value.trim() || 'Canción Sin Título');
        formData.append('artist', editInputArtist.value.trim() || 'Artista Desconocido');
        const selectedSongColor = editInputColor.value;
        const existingSongColor = trackBeingEdited?.color;
        const colorWasUnchanged = isValidSongColor(existingSongColor)
            && existingSongColor.slice(0, 7).toLowerCase() === selectedSongColor.toLowerCase();
        formData.append('color', colorWasUnchanged ? existingSongColor : selectedSongColor);
        formData.append('lyricsReady', String(editInputLyricsReady?.checked === true));
        let lyricsForSave = editInputLyrics.value;
        if (lyricsForSave !== originalEditLyrics) {
            try {
                lyricsForSave = prepareLyricsForSongSave(lyricsForSave);
                setEditorStatus(editLyricsStatus, '');
            } catch (error) {
                songSaveInProgress = false;
                btnSaveEditedSong.textContent = editingTrackId !== null ? "Guardar Cambios" : "Añadir Canción";
                btnSaveEditedSong.disabled = false;
                if (btnDeleteSong) btnDeleteSong.disabled = false;
                setEditorStatus(editLyricsStatus, error.message, true);
                editInputLyrics.focus();
                return;
            }
        } else if (trackBeingEdited?.lyrics) {
            lyricsForSave = trackBeingEdited.lyrics;
        }
        formData.append('lyrics', lyricsForSave);
        formData.append('lyricColors', JSON.stringify(editingLyricColors));
        formData.append('lyricColorAssignments', JSON.stringify(editingLyricColorAssignments));
        formData.append('duration', String(
            trackBeingEdited
                ? Number(trackBeingEdited.duration) || 0
                : 0
        ));
        const editingUser = getStoredUser();
        if (editingUser?._id) formData.append('userId', editingUser._id);
        if (editInputFileName?.value.trim()) {
            formData.append('fileName', editInputFileName.value.trim());
        }

        if ((!editInputYt?.value.trim() || !desktopYoutubeDownloader)
            && editInputMp3.files && editInputMp3.files[0]) {
            formData.append('mp3', editInputMp3.files[0]);
        }
        
        const ytLinkVal = editInputYt ? editInputYt.value.trim() : "";
        let ytProgress = null;
        if (ytLinkVal) {
            if (!isValidYoutubeLink(ytLinkVal)) {
                showYoutubeLinkStatus("El enlace de YouTube no es válido.", true);
                songSaveInProgress = false;
                btnSaveEditedSong.textContent = editingTrackId !== null ? "Guardar Cambios" : "Añadir Canción";
                btnSaveEditedSong.disabled = false;
                if (btnDeleteSong) btnDeleteSong.disabled = false;
                return;
            }
            ytProgress = startYtDownloadProgress(editingTrackId !== null ? 'Actualizando canción' : 'Añadiendo canción');
            if (desktopYoutubeDownloader) {
                showYoutubeLinkStatus('Descargando el audio en este equipo antes de subirlo...', false);
            } else {
                formData.append('ytLink', ytLinkVal);
                showYoutubeLinkStatus('Descargando y convirtiendo el audio antes de subirlo...', false);
            }
        }

        if (editSongPhoto.files && editSongPhoto.files[0]) {
            formData.append('cover', editSongPhoto.files[0]);
        }

        const pendingCatalogSongId = trackBeingEdited ? null : registerPendingCatalogSong({
            name: editInputName.value.trim() || 'Canción Sin Título',
            artist: editInputArtist.value.trim() || 'Artista Desconocido',
            cover: editSongPhoto.files?.[0] || '',
            status: ytLinkVal
                ? 'Preparando descarga de audio...'
                : editInputMp3.files?.[0]
                    ? 'Subiendo canción...'
                    : 'Guardando en el catálogo...'
        });
        if (pendingCatalogSongId) {
            isEditSongMode = false;
            isAllSongsMode = true;
            updateBackgroundAndViews();
        }

        try {
            if (ytLinkVal && desktopYoutubeDownloader) {
                if (pendingCatalogSongId) updatePendingCatalogSong(pendingCatalogSongId, 'Descargando audio en este equipo...');
                showYoutubeLinkStatus('Descargando el audio desde este equipo...', false);
                const downloadedAudio = await desktopYoutubeDownloader(ytLinkVal);
                const requestedFileName = editInputFileName?.value.trim();
                const audioFileName = requestedFileName || `${downloadedAudio.title}.mp3`;
                const audioFile = new File([downloadedAudio.bytes], audioFileName, { type: 'audio/mpeg' });
                formData.append('mp3', audioFile);
                if (pendingCatalogSongId) updatePendingCatalogSong(pendingCatalogSongId, 'Audio descargado. Subiendo a Drive y catálogo...');
                showYoutubeLinkStatus('Audio descargado. Subiéndolo a tu biblioteca...', false);
            }
            if (pendingCatalogSongId && !ytLinkVal) {
                updatePendingCatalogSong(pendingCatalogSongId, 'Guardando audio en Drive y actualizando catálogo...');
            }
            const response = await apiFetch(`${API_URL}/songs`, {
                method: 'POST',
                body: formData
            });
            const result = await response.json().catch(() => null);
            if (!response.ok) {
                const message = result?.error || 'No se pudo procesar el enlace de YouTube.';
                throw new Error(message);
            }
            await showSavedCatalogSong(result);
            if (pendingCatalogSongId) removePendingCatalogSong(pendingCatalogSongId);
            stopEditPreviewAudio(true);
            const savedTrackId = String(result?._id || trackBeingEdited?._id || '');
            if (savedTrackId && lyricsWereEdited) {
                const nextTimedLyrics = { ...timedLyricsByTrack };
                delete nextTimedLyrics[savedTrackId];
                timedLyricsByTrack = nextTimedLyrics;
                try {
                    localStorage.setItem(timedLyricsStorageKey, JSON.stringify(nextTimedLyrics));
                } catch (error) {
                    console.warn('No se pudo actualizar la copia local de las lyrics; se usará la versión del servidor.', error);
                }
            }
            if (!socket.connected) void fetchMusicData();

            if (editingSuggestionId) {
                const completedSuggestionId = editingSuggestionId;
                try {
                    const completionResponse = await apiFetch(
                        `${API_URL}/song-suggestions/${encodeURIComponent(completedSuggestionId)}/complete`,
                        { method: 'POST' }
                    );
                    const completionResult = await completionResponse.json().catch(() => null);
                    if (!completionResponse.ok) {
                        throw new Error(completionResult?.error || 'No se pudo cerrar la sugerencia.');
                    }
                    songSuggestions = songSuggestions.filter(
                        suggestion => String(suggestion._id) !== completedSuggestionId
                    );
                    renderAllSongs();
                } catch (error) {
                    console.error('La canción se guardó, pero la sugerencia no se pudo cerrar.', error);
                    showToast('La canción se guardó, pero no se pudo cerrar la sugerencia.', true);
                }
            }

            if (ytLinkVal) {
                stopYtDownloadProgress(ytProgress, { success: true, message: 'MP3 convertido, subido a Drive y guardado en MongoDB' });
            }
            
            isEditSongMode = false;
            editingTrackIndex = null;
            editingTrackId = null;
            editingSuggestionId = null;
            isAllSongsMode = true;
            updateBackgroundAndViews();
            
        } catch (e) {
            if (pendingCatalogSongId) removePendingCatalogSong(pendingCatalogSongId);
            console.error(e);
            const message = e?.message || 'Error al guardar la canción.';
            const youtubeErrorMessage = 'El enlace de YouTube no es válido o fue rechazado por YouTube.';
            const isYoutubeFailure = !!ytLinkVal;
            const visibleMessage = isYoutubeFailure
                ? (message.includes('YouTube') || /youtube/i.test(message) ? message : youtubeErrorMessage)
                : message;

            if (isYoutubeFailure) {
                stopYtDownloadProgress(ytProgress, { success: false, message, error: true });
            }

            showYoutubeLinkStatus(visibleMessage, true);
            if (!isYoutubeFailure || !/tardó demasiado|demora|sigue en curso/i.test(message)) {
                showToast(visibleMessage, true);
            }
        } finally {
            songSaveInProgress = false;
            const trackStillExists = !editingTrackId
                || playlist.some(track => String(track._id) === editingTrackId);
            btnSaveEditedSong.textContent = editingTrackId !== null ? "Guardar Cambios" : "Añadir Canción";
            btnSaveEditedSong.disabled = !trackStillExists;
            if (btnDeleteSong) btnDeleteSong.disabled = !trackStillExists;
        }
    });

    if (btnDeleteSong) {
        btnDeleteSong.addEventListener('click', () => {
            if (!canCurrentUser('delete_songs')) {
                showToast('No tienes permiso para eliminar canciones.', true);
                return;
            }
            const track = editingTrackId
                ? playlist.find(item => String(item._id) === editingTrackId)
                : null;
            if (!track) {
                showToast('La canción ya no está disponible para eliminar.', true);
                return;
            }
            if (btnDeleteSong.dataset.confirmDelete !== 'true') {
                btnDeleteSong.dataset.confirmDelete = 'true';
                btnDeleteSong.textContent = '¿Confirmar?';
                return;
            }
            deleteSongConfirmationTitle.textContent = getSongDeleteConfirmationName(track);
            deleteSongConfirmation.hidden = false;
            deleteSongNameStep.hidden = false;
            btnDeleteSong.hidden = true;
            btnDeleteSong.classList.add('is-delete-confirming');
            deleteSongNameConfirmation.focus();
        });
    }

    if (deleteSongNameConfirmation) {
        const updateDeleteConfirmationState = () => {
            const track = playlist.find(item => String(item._id) === editingTrackId);
            btnConfirmDeleteSong.disabled = !track
                || pendingSongDeletes.has(String(track._id))
                || deleteSongNameConfirmation.value.trim() !== getSongDeleteConfirmationName(track);
        };
        deleteSongNameConfirmation.addEventListener('input', updateDeleteConfirmationState);
    }

    if (btnConfirmDeleteSong) {
        btnConfirmDeleteSong.addEventListener('click', () => {
            if (btnConfirmDeleteSong.disabled) return;
            deleteSong(editingTrackId);
        });
    }

    btnCancelEditedSong.addEventListener('click', () => {
        if (editInputLyrics.value !== originalEditLyrics && lyricsCancelPromptIndex < 3) {
            const prompts = [
                'SEGURO BRO',
                'QUIERES CANCELAR BRO HAY CAMBIOS AHI',
                'ESTAS MUY SEGURO DE QUE QUIERES CANCELAR'
            ];
            btnCancelEditedSong.textContent = prompts[lyricsCancelPromptIndex];
            lyricsCancelPromptIndex += 1;
            return;
        }
        lyricsCancelPromptIndex = 0;
        btnCancelEditedSong.textContent = cancelEditedSongLabel;
        resetSongDeleteConfirmation();
        stopEditPreviewAudio(true);
        isEditSongMode = false;
        editingTrackIndex = null;
        editingTrackId = null;
        editingSuggestionId = null;
        isAllSongsMode = true;
        updateBackgroundAndViews();
    });

    function openEditPlaylistPanel(id = null) {
        playlistEditorPreviousView = {
            isLyricsMode,
            isAllSongsMode,
            isPlaylistViewMode,
            isEditSongMode,
            isSettingsMode,
            isProfileMode,
            activePlaylistId
        };
        editingPlaylistId = id;
        if (btnDeletePl) {
            btnDeletePl.dataset.confirmDelete = 'false';
            btnDeletePl.textContent = 'Eliminar Playlist';
        }
        editPlPhoto.value = '';
        if (editingPlaylistId) {
            const pl = userPlaylists.find(p => p.id === editingPlaylistId);
            if (pl) {
                editPlName.value = pl.name;
                editPlDesc.value = pl.desc || '';
                const cover = getPlaylistCover(pl);
                if (cover) {
                    editPlDisplayCover.src = cover;
                    editPlDisplayCover.style.display = 'block';
                } else {
                    editPlDisplayCover.removeAttribute('src');
                    editPlDisplayCover.style.display = 'none';
                }
                const spotifyImportPanel = document.getElementById('spotify-playlist-import');
                if (spotifyImportPanel) spotifyImportPanel.hidden = Boolean(editingPlaylistId);
                updateSpotifyPlaylistImportForm();
            }
        } else {
            editPlName.value = '';
            editPlDesc.value = '';
            editPlDisplayCover.removeAttribute('src');
            editPlDisplayCover.style.display = 'none';
        }
        editPlPhotoStatus.textContent = 'Haz clic o arrastra una imagen';
        editPlPhotoStatus.classList.remove('error');
        
        if (btnDeletePl) {
            const currentUser = getStoredUser();
            const targetPlaylist = editingPlaylistId
                ? userPlaylists.find(playlistItem => playlistItem.id === editingPlaylistId)
                : null;
            const isOwner = Boolean(
                currentUser?._id
                && targetPlaylist
                && String(targetPlaylist.ownerId) === String(currentUser._id)
            );
            btnDeletePl.style.display = isOwner ? 'inline-block' : 'none';
        }
        
        isEditPlaylistMode = true;
        isEditSongMode = false;
        isLyricsMode = false;
        isAllSongsMode = false;
        isPlaylistViewMode = false;
        isSettingsMode = false;
        isAdminMode = false;
        isProfileMode = false;
        updateBackgroundAndViews();
    }

    btnCreatePlaylist.addEventListener('click', () => {
        openEditPlaylistPanel();
        closeSidebar();
    });

    btnEditPlaylist.addEventListener('click', () => {
        openEditPlaylistPanel(activePlaylistId);
    });

    btnSaveEditedPl.addEventListener('click', async () => {
        const name = editPlName.value.trim() || 'Nueva Playlist';
        const desc = editPlDesc.value.trim();

        if (loadingSpinner) loadingSpinner.style.display = 'flex';

        let targetPl = userPlaylists.find(p => p.id === editingPlaylistId);
        const plId = editingPlaylistId || generateId();
        
        const currentUserForPl = getStoredUser();
        const formData = new FormData();
        formData.append('id', plId);
        formData.append('name', name);
        formData.append('desc', desc);
        formData.append('userId', currentUserForPl?._id || '');
        
        if (targetPl && targetPl.photo) {
            formData.append('existingPhoto', targetPl.photo);
        }
        if (targetPl && targetPl.tracks) {
            formData.append('tracks', JSON.stringify(targetPl.tracks));
        } else {
            formData.append('tracks', JSON.stringify([]));
        }

        if (editPlPhoto.files && editPlPhoto.files[0]) {
            formData.append('photo', editPlPhoto.files[0]);
        }

        try {
            const res = await apiFetch(`${API_URL}/playlists`, {
                method: 'POST',
                body: formData
            });
            const updatedPl = await res.json();
            
            await loadPlaylists(); 
            openPlaylistView(updatedPl.id || plId);
        } catch (e) {
            console.error(e);
            showToast("Error al guardar la playlist", true);
        } finally {
            if (loadingSpinner) loadingSpinner.style.display = 'none';
        }
    });

    if (btnDeletePl) {
        btnDeletePl.addEventListener('click', async () => {
            if (!editingPlaylistId) return;
            if (btnDeletePl.dataset.confirmDelete !== 'true') {
                btnDeletePl.dataset.confirmDelete = 'true';
                btnDeletePl.textContent = '¿Confirmar?';
                return;
            }
            btnDeletePl.dataset.confirmDelete = 'false';
            btnDeletePl.textContent = 'Eliminar Playlist';
            {
                if (loadingSpinner) loadingSpinner.style.display = 'flex';
                try {
                    const currentUser = getStoredUser();
                    const response = await apiFetch(`${API_URL}/playlists/${editingPlaylistId}`, {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: currentUser?._id })
                    });
                    const result = await response.json().catch(() => null);
                    if (!response.ok) throw new Error(result?.error || 'No se pudo eliminar la playlist');
                    await loadPlaylists();
                    isEditPlaylistMode = false;
                    isAllSongsMode = true;
                    updateBackgroundAndViews();
                } catch (e) {
                    console.error(e);
                    showToast(e.message || "Error al eliminar la playlist.", true);
                } finally {
                    if (loadingSpinner) loadingSpinner.style.display = 'none';
                }
            }
        });
    }

    btnCancelEditedPl.addEventListener('click', () => {
        const previousView = playlistEditorPreviousView;
        playlistEditorPreviousView = null;
        isEditPlaylistMode = false;

        if (!previousView) {
            isAllSongsMode = true;
            updateBackgroundAndViews();
            return;
        }

        activePlaylistId = previousView.activePlaylistId;
        isLyricsMode = previousView.isLyricsMode;
        isAllSongsMode = previousView.isAllSongsMode;
        isPlaylistViewMode = previousView.isPlaylistViewMode;
        isEditSongMode = previousView.isEditSongMode;
        isSettingsMode = previousView.isSettingsMode;
        isAdminMode = false;
        isProfileMode = previousView.isProfileMode;

        if (isPlaylistViewMode && activePlaylistId) {
            openPlaylistView(activePlaylistId);
        } else {
            updateBackgroundAndViews();
        }
    });

    function openAddToPlaylistModal(trackIndex) {
        trackToAddIndex = trackIndex;
        addToPlList.innerHTML = '';
        const songId = playlist[trackToAddIndex]._id; 

        const currentUser = getStoredUser();
        const visiblePlaylists = userPlaylists.filter(pl => (
            String(pl.ownerId || pl.userId?._id || pl.userId) === String(currentUser?._id)
            || (pl.sharedWith || []).some(member => String(member?._id || member.userId || member) === String(currentUser?._id))
        ));

        visiblePlaylists.forEach(pl => {
            const alreadyAdded = pl.tracks.some(track => String(track._id) === String(songId));
            const song = playlist[trackToAddIndex];
            const li = document.createElement('li');
            li.className = 'add-pl-item';
            li.innerHTML = `
                ${createImageMarkup(getPlaylistCover(pl))}
                <span>${escapeHtml(pl.name)}</span>
                ${alreadyAdded ? '<small class="playlist-membership-status">Ya está añadida</small>' : ''}
            `;
            li.addEventListener('click', () => {
                if (li.dataset.saving === 'true') return;
                const isDuplicate = pl.tracks.some(track => String(track._id) === String(songId));
                if (isDuplicate) {
                    const status = li.querySelector('.playlist-membership-status');
                    if (status) status.textContent = 'Ya está añadida';
                    return;
                }
                const currentUser = getStoredUser();
                if (!currentUser?._id) {
                    showToast('Inicia sesión para añadir canciones a una playlist.', true);
                    return;
                }
                li.dataset.saving = 'true';
                li.setAttribute('aria-disabled', 'true');
                li.querySelector('.playlist-membership-status')?.remove();
                const loadingStatus = document.createElement('small');
                loadingStatus.className = 'playlist-membership-status';
                loadingStatus.textContent = 'Añadiendo…';
                li.appendChild(loadingStatus);
                li.classList.add('is-loading');
                const previousDuration = Number(pl.duration) || 0;
                const optimisticAddedAt = new Date().toISOString();
                const optimisticTrack = {
                    ...song,
                    syncPending: true,
                    addedBy: { _id: currentUser._id, username: currentUser.username },
                    addedAt: optimisticAddedAt
                };
                pl.tracks.push(optimisticTrack);
                pl.duration = previousDuration + Math.max(0, Number(song.duration) || 0);
                pl.updatedAt = optimisticAddedAt;
                hideAllModals();
                renderSidebarPlaylists();
                if (activePlaylistId === pl.id) openPlaylistView(pl.id);
                void saveOfflinePlaylists(currentUser._id, userPlaylists).catch(error => {
                    console.error('No se pudo guardar la playlist optimista en la caché local.', error);
                });
                showToast(`“${song?.name || 'La canción'}” añadida localmente; sincronizando…`);
                apiFetch(`${API_URL}/playlists/${encodeURIComponent(pl.id)}/tracks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: currentUser._id,
                        songId
                    })
                })
                    .then(async response => {
                        const result = await response.json().catch(() => null);
                        if (!response.ok) throw new Error(result?.error || 'No se pudo añadir la canción');
                        if (Number.isFinite(Number(result?.duration))) pl.duration = Number(result.duration);
                        delete optimisticTrack.syncPending;
                        void saveOfflinePlaylists(currentUser._id, userPlaylists).catch(error => {
                            console.error('No se pudo actualizar la caché local de playlists.', error);
                        });
                        if (activePlaylistId === pl.id) openPlaylistView(pl.id);
                        showToast(`“${song?.name || 'La canción'}” se añadió a “${pl.name}”.`);
                    })
                    .catch(error => {
                        const canRetryLater = error.name === 'OfflineModeError'
                            || !navigator.onLine
                            || error instanceof TypeError;
                        if (!canRetryLater) {
                            pl.tracks = pl.tracks.filter(track => track !== optimisticTrack);
                            pl.duration = previousDuration;
                        } else {
                            optimisticTrack.syncPending = true;
                            void saveOfflinePlaylists(currentUser._id, userPlaylists).catch(saveError => {
                                console.error('No se pudo guardar la canción pendiente de sincronización.', saveError);
                            });
                            showToast(`“${song?.name || 'La canción'}” quedó guardada localmente y se sincronizará al reconectar.`);
                        }
                        if (activePlaylistId === pl.id) openPlaylistView(pl.id);
                        if (!canRetryLater) showToast(error.message || 'No se pudo añadir la canción.', true);
                    })
                    .finally(() => renderSidebarPlaylists());
            });
            addToPlList.appendChild(li);
        });
        
        hideAllModals();
        modalOverlay.classList.add('active');
        addToPlModal.classList.add('active');
    }

    btnCloseAddPl.addEventListener('click', hideAllModals);

    function createSpotifyAttributionMarkup(track) {
        const name = track.spotifyAddedByName
            || (track.spotifyAddedById ? 'Usuario de Spotify' : 'No informado por Spotify');
        const profile = track.spotifyAddedByProfile || {};
        const avatar = profile.photoUrl
            ? `<img src="${escapeHtml(profile.photoUrl)}" alt="" class="playlist-meta-avatar" />`
            : '<span class="playlist-meta-avatar-placeholder" aria-hidden="true">♫</span>';
        const label = `<span>${escapeHtml(name)}</span>`;
        const ownerTitle = profile.ownerFallback
            ? 'Atribución predeterminada al dueño de la playlist de Spotify'
            : '';
        if (profile.userId) {
            return `<button type="button" class="playlist-user-link spotify-contributor-link" data-user-id="${escapeHtml(profile.userId)}" aria-label="Ver perfil de ${escapeHtml(profile.username || name)}"${ownerTitle ? ` title="${ownerTitle}"` : ''}>${avatar}${label}</button>`;
        }
        if (profile.url) {
            return `<a class="spotify-contributor-link" href="${escapeHtml(profile.url)}" target="_blank" rel="noopener noreferrer" aria-label="Abrir perfil de Spotify de ${escapeHtml(name)}"${ownerTitle ? ` title="${ownerTitle}"` : ''}>${avatar}${label}</a>`;
        }
        return `${avatar}${label}`;
    }

    function openPlaylistView(id) {
        const pl = [...userPlaylists, ...(publicProfilePlaylists || [])].find(p => p.id === id);
        if (!pl) return;
        const currentUser = getStoredUser();
        const isOwner = Boolean(currentUser?._id && String(pl.ownerId) === String(currentUser._id));
        const isSharedPlaylist = !isOwner && (pl.sharedWith || []).some(user => String(user?._id || user) === String(currentUser?._id));
        const isSavedPlaylist = !isOwner && (currentUser?.savedPlaylists || []).some(savedId => String(savedId) === String(pl.id));
        const isSpotifyLinked = Boolean(pl.spotifyPlaylistId);
        const canEditPlaylist = (isOwner || isSharedPlaylist) && !isSpotifyLinked;
        const canDeletePlaylistTracks = canEditPlaylist;
        
        const coverUrl = getPlaylistCover(pl);

        activePlaylistId = id;
        if (btnEditPlaylist) {
            btnEditPlaylist.hidden = !canEditPlaylist;
            btnEditPlaylist.style.display = canEditPlaylist ? '' : 'none';
        }
        if (btnSharePlaylist) {
            btnSharePlaylist.hidden = !isOwner || isSpotifyLinked;
            btnSharePlaylist.style.display = isOwner && !isSpotifyLinked ? '' : 'none';
        }
        if (btnDeletePlaylist) {
            btnDeletePlaylist.hidden = !isOwner || !isSpotifyLinked;
            btnDeletePlaylist.style.display = isOwner && isSpotifyLinked ? '' : 'none';
        }
        if (btnSavePlaylist) {
            const canManageMembers = isOwner && !isSpotifyLinked;
            btnSavePlaylist.hidden = isOwner && isSpotifyLinked;
            btnSavePlaylist.style.display = btnSavePlaylist.hidden ? 'none' : '';
            btnSavePlaylist.dataset.action = canManageMembers ? 'manage-members' : (isSharedPlaylist ? 'leave-playlist' : '');
            btnSavePlaylist.dataset.saved = String(isSavedPlaylist);
            btnSavePlaylist.title = canManageMembers ? 'Gestionar integrantes' : (isSharedPlaylist ? 'Salir de la playlist' : 'Guardar Playlist');
            if (btnSavePlaylistIcon) {
                btnSavePlaylistIcon.src = canManageMembers || isSharedPlaylist
                    ? '/img/cancel.png'
                    : (isSavedPlaylist ? '/img/save.png' : '/img/add.png');
                btnSavePlaylistIcon.alt = canManageMembers
                    ? 'Gestionar integrantes'
                    : (isSharedPlaylist ? 'Salir de la playlist' : (isSavedPlaylist ? 'Playlist guardada' : 'Guardar playlist'));
            }
        }
        isPlaylistViewMode = true;
        isLyricsMode = false;
        isAllSongsMode = false;
        isEditSongMode = false;
        isEditPlaylistMode = false;
        isSettingsMode = false;
        isAdminMode = false;
        isProfileMode = false;
        
        if (coverUrl) {
            if (plViewPhoto.getAttribute('src') !== coverUrl) plViewPhoto.src = coverUrl;
            plViewPhoto.classList.remove('no-image');
        } else {
            plViewPhoto.removeAttribute('src');
            plViewPhoto.classList.add('no-image');
        }
        plViewName.textContent = pl.name;
        plViewDesc.textContent = pl.desc || 'Sin descripción';
        const playlistTracks = Array.isArray(pl.tracks) ? pl.tracks : [];
        const playlistDisplayTracks = isSpotifyLinked && Array.isArray(pl.playlistItems)
            ? pl.playlistItems
            : playlistTracks;
        const playlistDuration = Number(pl.duration) || playlistTracks.reduce((total, track) => (
            total + Math.max(0, Number(track.duration) || 0)
        ), 0);
        const savedCount = Math.max(0, Number(pl.savedCount) || 0);
        if (plViewOwner) {
            const currentUser = getStoredUser();
            const localCreators = [currentUser, ...currentFriends].filter(Boolean);
            const getCreatorPhoto = (creator) => {
                const localCreator = localCreators.find(item => String(item._id) === String(creator._id));
                return localCreator?.profilePhoto || creator.profilePhoto || '';
            };
            const creators = [
                {
                    _id: pl.ownerId,
                    username: pl.ownerName || 'Desconocido',
                    profilePhoto: getCreatorPhoto({ ...pl, profilePhoto: pl.ownerPhoto })
                },
                ...(Array.isArray(pl.sharedWith) ? pl.sharedWith : [])
            ].map(creator => ({ ...creator, profilePhoto: getCreatorPhoto(creator) }))
            .filter((creator, index, all) => (
                creator._id &&
                all.findIndex(item => String(item._id) === String(creator._id)) === index
            ));
            const spotifyParticipants = isSpotifyLinked && Array.isArray(pl.spotifyParticipants)
                ? pl.spotifyParticipants
                : [];
            const displayCreators = spotifyParticipants.length
                ? spotifyParticipants.map(participant => ({
                    userId: participant.userId || '',
                    username: participant.name || 'Usuario de Spotify',
                    profilePhoto: participant.photoUrl || '',
                    url: participant.url || ''
                }))
                : creators.map(creator => ({
                    userId: creator._id,
                    username: creator.username,
                    profilePhoto: creator.profilePhoto || '',
                    url: ''
                }));
            const renderCreatorAvatar = creator => {
                const avatar = creator.profilePhoto
                    ? `<img src="${escapeHtml(creator.profilePhoto)}" alt="" class="pl-creator-avatar" />`
                    : '<span class="pl-creator-avatar-placeholder">♫</span>';
                if (creator.userId) {
                    return `<button type="button" class="pl-creator-avatar-link" data-user-id="${escapeHtml(creator.userId)}" data-username="${escapeHtml(creator.username)}" data-profile-photo="${escapeHtml(creator.profilePhoto)}">${avatar}</button>`;
                }
                if (creator.url) {
                    return `<a class="pl-creator-avatar-link spotify-participant-link" href="${escapeHtml(creator.url)}" target="_blank" rel="noopener noreferrer" aria-label="Abrir perfil de Spotify de ${escapeHtml(creator.username)}">${avatar}</a>`;
                }
                return `<span class="pl-creator-avatar-link" aria-hidden="true">${avatar}</span>`;
            };
            const renderCreatorName = creator => {
                if (creator.userId) {
                    return `<button type="button" class="pl-creator-link" data-user-id="${escapeHtml(creator.userId)}" data-username="${escapeHtml(creator.username)}" data-profile-photo="${escapeHtml(creator.profilePhoto)}">${escapeHtml(creator.username)}</button>`;
                }
                if (creator.url) {
                    return `<a class="pl-creator-link spotify-participant-link" href="${escapeHtml(creator.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(creator.username)}</a>`;
                }
                return `<span class="pl-creator-link">${escapeHtml(creator.username)}</span>`;
            };

            plViewOwner.innerHTML = `
                <span id="pl-view-stats" class="pl-view-stats">
                    ${playlistDisplayTracks.length} canciones, ${formatPlaylistDuration(playlistDuration)}
                    <button id="pl-view-saved-count" class="pl-view-saved-count" type="button" data-playlist-id="${escapeHtml(pl.id)}" aria-label="Ver quién guardó esta playlist">
                        guardada ${savedCount} ${savedCount === 1 ? 'vez' : 'veces'}
                    </button>
                </span>
                <span class="pl-view-creators">
                    <span class="pl-creator-avatars">
                        ${displayCreators.map(creator => `
                            <span class="pl-creator-avatar-wrap">
                                ${renderCreatorAvatar(creator)}
                            </span>
                        `).join('')}
                    </span>
                    <span class="pl-creator-names">
                        ${displayCreators.map((creator, index) => `
                            ${index > 0 && index === displayCreators.length - 1 ? '<span class="pl-creator-separator">&nbsp;y&nbsp;</span>' : ''}
                            ${index > 0 && index < displayCreators.length - 1 ? '<span class="pl-creator-separator">, </span>' : ''}
                            ${renderCreatorName(creator)}
                        `).join('')}
                    </span>
                </span>
            `;

            const savedCountButton = plViewOwner.querySelector('#pl-view-saved-count');
            if (savedCountButton) {
                savedCountButton.hidden = savedCount === 0;
                savedCountButton.textContent = savedCount
                    ? `guardada ${savedCount} ${savedCount === 1 ? 'vez' : 'veces'}`
                    : '';
            }
            savedCountButton?.addEventListener('click', async () => {
                if (!playlistSaversModal || !playlistSaversList || !playlistSaversTitle) return;
                savedCountButton.disabled = true;
                playlistSaversTitle.textContent = `Personas que guardaron “${pl.name || 'Playlist'}”`;
                modalOverlay.classList.add('active');
                playlistSaversModal.classList.add('active');
                try {
                    const viewerId = String(getStoredUser()?._id || '');
                    let cachedSavers = playlistSaversCache.get(String(pl.id)) || null;
                    if (!cachedSavers && viewerId) {
                        try {
                            const storedSavers = await getOfflinePlaylistSavers(viewerId, pl.id);
                            if (storedSavers && Array.isArray(storedSavers.users)) {
                                cachedSavers = storedSavers.users;
                                playlistSaversCache.set(String(pl.id), cachedSavers);
                                pl.savedCount = Math.max(0, Number(storedSavers.count) || 0);
                                savedCountButton.textContent = pl.savedCount
                                    ? `guardada ${pl.savedCount} ${pl.savedCount === 1 ? 'vez' : 'veces'}`
                                    : '';
                                savedCountButton.hidden = pl.savedCount === 0;
                            }
                        } catch (error) {
                            console.warn('No se pudo leer la lista offline de personas que guardaron la playlist.', error);
                        }
                    }
                    if (cachedSavers) await renderPlaylistSavers(cachedSavers);
                    else playlistSaversList.textContent = 'Cargando…';
                    if (offlineOnly || !navigator.onLine) {
                        if (!cachedSavers) showToast('No disponible para modo offline', true);
                        return;
                    }
                    const response = await apiFetch(`${API_URL}/playlists/${encodeURIComponent(pl.id)}/saves`);
                    const result = await response.json().catch(() => null);
                    if (!response.ok) throw new Error(result?.error || 'No se pudo cargar quién guardó esta playlist.');
                    if (!Array.isArray(result?.users) || !Number.isFinite(Number(result?.count))) {
                        throw new Error('La respuesta de personas que guardaron esta playlist no es válida.');
                    }
                    if (!savedCountButton.isConnected || activePlaylistId !== pl.id) return;
                    pl.savedCount = Number(result.count);
                    savedCountButton.textContent = pl.savedCount
                        ? `guardada ${pl.savedCount} ${pl.savedCount === 1 ? 'vez' : 'veces'}`
                        : '';
                    savedCountButton.hidden = pl.savedCount === 0;
                    playlistSaversCache.set(String(pl.id), result.users);
                    await renderPlaylistSavers(result.users);
                    if (viewerId) {
                        try {
                            await saveOfflinePlaylistSavers(viewerId, pl.id, result);
                        } catch (error) {
                            console.warn('No se pudo guardar la lista offline de personas que guardaron la playlist.', error);
                        }
                    }
                    if (offlineModeEnabled) syncOfflineResources();
                } catch (error) {
                    showToast(error.message || 'No se pudo cargar quién guardó esta playlist.', true);
                } finally {
                    savedCountButton.disabled = false;
                }
            });

            plViewOwner.querySelectorAll('button.pl-creator-link, button.pl-creator-avatar-link').forEach(button => {
                button.addEventListener('click', (event) => {
                    event.stopPropagation();
                    const current = getStoredUser();
                    const userId = button.dataset.userId;
                    if (current?._id && String(current._id) === String(userId)) {
                        openProfile();
                    } else {
                        const friend = currentFriends.find(item => String(item._id) === String(userId));
                        if (friend) {
                            openFriendProfile(friend._id);
                        } else {
                            selectedProfileUser = {
                                _id: userId,
                                username: button.dataset.username || '',
                                profilePhoto: button.dataset.profilePhoto || '',
                                friends: currentFriends
                            };
                            publicProfilePlaylists = null;
                            isPlaylistViewMode = false;
                            isProfileMode = true;
                            renderProfile();
                            updateBackgroundAndViews();
                        }
                        return;
                    }
                    isPlaylistViewMode = false;
                    isProfileMode = true;
                    renderProfile();
                    updateBackgroundAndViews();
                });
            });
            plViewOwner.querySelectorAll('a.spotify-participant-link').forEach(link => {
                link.addEventListener('click', event => event.stopPropagation());
            });

        }
        
        plViewTracks.innerHTML = '';
        playlistDisplayTracks.forEach((trackItem, arrayIndex) => {
            const isSpotifyUnavailable = trackItem.spotifyUnavailable === true;
            if (isSpotifyUnavailable) {
                const li = document.createElement('li');
                li.className = 'playlist-track-row spotify-unavailable-track';
                const canAddSpotifyTrack = isOwner
                    && canCurrentUser('edit_songs')
                    && trackItem.spotifyTrackId;
                if (canAddSpotifyTrack) {
                    li.tabIndex = 0;
                    li.setAttribute('aria-label', `Abrir todas las canciones faltantes de ${pl.name || 'la playlist'}`);
                }
                const addedAtLabel = trackItem.spotifyAddedAt
                    ? new Date(trackItem.spotifyAddedAt).toLocaleDateString('es-CL', { timeZone: 'America/Santiago' })
                    : '--';
                li.innerHTML = `
                    <span class="song-cover-loading spotify-missing-cover">
                        ${createImageMarkup(trackItem.cover || '', 'item-cover')}
                        <span class="spotify-missing-symbol" title="Canción fuera del catálogo">＋</span>
                    </span>
                    <div class="all-songs-item-info">
                        <span class="all-songs-item-name">${escapeHtml(trackItem.name)}</span>
                        <span class="all-songs-item-artist">${escapeHtml(trackItem.artist)}</span>
                    </div>
                    <small class="playlist-track-meta">
                        <span class="playlist-added-by">${createSpotifyAttributionMarkup(trackItem)}</span>
                        <span class="playlist-track-added-date">${addedAtLabel}</span>
                        <span class="playlist-track-duration">${formatTrackTime(Number(trackItem.duration) || 0)}</span>
                    </small>
                `;
                li.querySelectorAll('.playlist-user-link').forEach(link => {
                    link.addEventListener('click', event => {
                        event.stopPropagation();
                        openProfile(link.dataset.userId);
                    });
                });
                li.querySelectorAll('a.spotify-contributor-link').forEach(link => {
                    link.addEventListener('click', event => event.stopPropagation());
                });
                li.addEventListener('click', event => {
                    event.stopPropagation();
                    if (canAddSpotifyTrack && !event.target.closest('a, button')) {
                        openDirectSpotifyTrackAdd(pl);
                    }
                });
                li.addEventListener('keydown', event => {
                    if (!canAddSpotifyTrack || event.target !== li || !['Enter', ' '].includes(event.key)) return;
                    event.preventDefault();
                    openDirectSpotifyTrackAdd(pl);
                });
                plViewTracks.appendChild(li);
                return;
            }
            const detail = pl.trackDetails?.find(item => String(item.songId) === String(trackItem._id)) || {};
            const track = {
                ...(playlist.find(t => String(t._id || t.id) === String(trackItem._id || trackItem.id)) || {}),
                ...trackItem,
                ...detail
            };
            const playlistTrackId = String(trackItem._id || trackItem.id || track._id || track.id || '');
            const playlistIndex = playlist.findIndex(t => String(t._id || t.id) === playlistTrackId);

            const li = document.createElement('li');
            li.className = 'playlist-track-row';
            li.dataset.songId = playlistTrackId;
            if (track.syncPending) li.classList.add('is-syncing');
            li.dataset.trackIndex = String(playlistIndex);
            li.dataset.playlistTrackId = playlistTrackId;
            const addedBy = typeof track.addedBy === 'object' ? track.addedBy : null;
            const addedByName = isSpotifyLinked
                ? (track.spotifyAddedByName || (track.spotifyAddedById ? 'Usuario de Spotify' : 'No informado por Spotify'))
                : addedBy?.username || track.addedByName || 'Desconocido';
            const addedByPhoto = isSpotifyLinked ? '' : (
                [getStoredUser(), ...currentFriends]
                    .find(user => String(user?._id) === String(addedBy?._id))?.profilePhoto
                    || addedBy?.profilePhoto
                    || ''
            );
            const addedAt = isSpotifyLinked ? track.spotifyAddedAt : track.addedAt;
            const addedAtLabel = addedAt
                ? new Date(addedAt).toLocaleDateString('es-CL', { timeZone: 'America/Santiago' })
                : '--';
            li.innerHTML = `
                <span class="song-cover-loading">${createImageMarkup(getSongCover(track), 'item-cover')}${track.syncPending ? '<span class="song-loading-spinner syncing" role="status" aria-label="Sincronizando canción"></span>' : ''}</span>
                <div class="all-songs-item-info">
                    <span class="all-songs-item-name">${escapeHtml(track.name)}</span>
                    <span class="all-songs-item-artist">${escapeHtml(track.artist)}</span>
                </div>
                <small class="playlist-track-meta">
                    <span class="playlist-added-by">
                        ${isSpotifyLinked
                            ? createSpotifyAttributionMarkup(track)
                            : `${addedByPhoto ? `<img src="${escapeHtml(addedByPhoto)}" alt="" class="playlist-meta-avatar" />` : ''}${addedBy?._id ? `<button type="button" class="playlist-user-link" data-user-id="${escapeHtml(addedBy._id)}" style="background:transparent; border:none; cursor:pointer;">${escapeHtml(addedByName)}</button>` : escapeHtml(addedByName)}`}
                    </span>
                    <span class="playlist-track-added-date">${addedAtLabel}</span>
                    <span class="playlist-track-duration">${formatTrackTime(Number(track.duration) || 0)}</span>
                </small>
                ${canDeletePlaylistTracks ? `
                    <button class="remove-from-pl-btn" style="background:transparent; border:none; cursor:pointer; justify-self:end;" type="button">
                        <img src="/img/cancel.png" draggable="false" class="no-drag" alt="Remove" style="width:20px;">
                    </button>
                ` : ''}
            `;
            li.querySelectorAll('.playlist-user-link').forEach(link => {
                link.addEventListener('click', (event) => {
                    event.stopPropagation();
                    if (plViewPanel) plViewPanel.hidden = true;
                    openProfile(link.dataset.userId);
                });
            });
            li.querySelectorAll('a.spotify-contributor-link').forEach(link => {
                link.addEventListener('click', event => event.stopPropagation());
            });
            li.addEventListener('click', (e) => {
                if (li.dataset.wasDragged === 'true') {
                    delete li.dataset.wasDragged;
                    return;
                }
                if(e.target.closest('.remove-from-pl-btn') && canDeletePlaylistTracks) {
                    e.stopPropagation();
                    const currentUser = getStoredUser();
                    const songId = trackItem?._id || trackItem?.id || track?._id || track?.id;
                    if (!songId) {
                        showToast('No se pudo identificar la canción.', true);
                        return;
                    }
                    const changeKey = `${id}:${songId}`;
                    if (pendingPlaylistTrackChanges.has(changeKey)) return;
                    const trackPosition = pl.tracks.findIndex(item => String(item._id || item.id) === String(songId));
                    if (trackPosition < 0) return;
                    pendingPlaylistTrackChanges.add(changeKey);
                    renderSidebarPlaylists();
                    const previousTracks = pl.tracks;
                    const previousDuration = Number(pl.duration) || 0;
                    const removedTrack = previousTracks[trackPosition];
                    pl.tracks = previousTracks.filter((item, index) => index !== trackPosition);
                    pl.duration = Math.max(0, previousDuration - Math.max(0, Number(removedTrack.duration) || 0));
                    pl.updatedAt = new Date().toISOString();
                    openPlaylistView(id);
                    showToast(`Eliminando “${removedTrack.name || 'la canción'}” de “${pl.name}”…`);
                    apiFetch(`${API_URL}/playlists/${encodeURIComponent(id)}/tracks/${encodeURIComponent(String(songId))}`, {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: currentUser?._id })
                    })
                        .then(async response => {
                            const result = await response.json().catch(() => null);
                            if (!response.ok) throw new Error(result?.error || 'No se pudo eliminar la canción');
                            const serverDuration = Number(result?.playlist?.duration);
                            if (Number.isFinite(serverDuration)) pl.duration = serverDuration;
                            if (offlineModeEnabled && currentUser?._id) {
                                void saveOfflinePlaylists(currentUser._id, userPlaylists).catch(error => {
                                    console.error('No se pudo actualizar la caché offline de playlists.', error);
                                });
                            }
                            if (activePlaylistId === id) openPlaylistView(id);
                            showToast(`“${removedTrack.name || 'La canción'}” se eliminó de “${pl.name}”.`);
                        })
                        .catch(error => {
                            pl.tracks = previousTracks;
                            pl.duration = previousDuration;
                            if (activePlaylistId === id) openPlaylistView(id);
                            showToast(error.message || 'No se pudo eliminar la canción.', true);
                        })
                        .finally(() => {
                            pendingPlaylistTrackChanges.delete(changeKey);
                            renderSidebarPlaylists();
                        });
                    return;
                }
                const playableDisplayTracks = isSpotifyLinked
                    ? playlistDisplayTracks.filter(item => !item.spotifyUnavailable)
                    : pl.tracks;
                const playableIndex = isSpotifyLinked
                    ? playlistDisplayTracks.slice(0, arrayIndex)
                        .filter(item => !item.spotifyUnavailable).length
                    : pl.tracks.findIndex(item => (
                        String(item._id || item.id || '') === playlistTrackId
                    ));
                if (playableIndex !== -1) {
                    activeQueueTracks = playableDisplayTracks
                        .map(item => {
                            const songId = String(item._id || item.id || '');
                            return playlist.find(main => String(main._id || main.id) === songId) || item;
                        })
                        .filter(Boolean);
                    queueName = pl.name || 'GENERAL';
                    resetPlaybackHistory();
                    if (isShuffle) unplayedIndices = buildShuffleQueue();
                    renderQueue();
                    loadAndPlayTrack(playableIndex, 'regular');
                }
            });
            let queueGesture;
            if (canEditPlaylist) {
                setupPlaylistDrag(li, pl, arrayIndex, () => Boolean(queueGesture?.horizontalIntent));
            }
            queueGesture = setupQueueAddSwipe(li, track);
            plViewTracks.appendChild(li);
        });

        if (
            isOwner
            && isSpotifyLinked
            && spotifyIsConnected
            && spotifyPlaylistScopesGranted
            && navigator.onLine
            && !spotifyPlaylistSyncs.has(String(pl.id))
        ) {
            const syncId = String(pl.id);
            spotifyPlaylistSyncs.add(syncId);
            apiFetch(`${API_URL}/spotify/playlists/${encodeURIComponent(pl.spotifyPlaylistId)}/import`, { method: 'POST' })
                .then(async response => {
                    const result = await response.json().catch(() => null);
                    if (!response.ok) throw new Error(result?.error || 'No se pudo sincronizar la playlist de Spotify.');
                    if (result.changed) {
                        await loadPlaylists();
                        if (activePlaylistId === pl.id) openPlaylistView(pl.id);
                    }
                })
                .catch(error => {
                    console.error('No se pudo comprobar la sincronización de Spotify.', error);
                    showToast(error.message || 'No se pudo sincronizar la playlist de Spotify.', true);
                })
                .finally(() => spotifyPlaylistSyncs.delete(syncId));
        }
        
        updateBackgroundAndViews();
    }

    btnPlayPlaylist.addEventListener('click', () => {
        if (!activePlaylistId) return;
        const pl = userPlaylists.find(p => p.id === activePlaylistId);
        if (pl && pl.tracks.length > 0) {
            queueName = pl.name || 'GENERAL';
            activeQueueTracks = pl.tracks.map(t => playlist.find(main => main._id === t._id)).filter(Boolean);
            customQueue = []; 
            resetPlaybackHistory();
            renderQueue();
            loadAndPlayTrack(playlist.indexOf(activeQueueTracks[0]));
        }
    });

    btnPlayAllSongs.addEventListener('click', () => {
        activePlaylistId = null;
        queueName = 'GENERAL';
        activeQueueTracks = [...playlist];
        customQueue = [];
        resetPlaybackHistory();
        renderQueue();
        loadAndPlayTrack(0);
    });

    function updateLyricsView() {
        if (!lyricsPanel) return;
        const track = getLyricsTrack();
        lyricsPanel.style.backgroundColor = '#000';
        lyricsPanel.replaceChildren();

        const container = document.createElement('div');
        container.className = 'lyrics-container';
        const lyricsBackgroundColor = safeColor(track?.color, '#151515');
        container.style.setProperty('--lyrics-color', lyricsBackgroundColor);
        const lyricsTextColor = getContrastingTextColor(lyricsBackgroundColor);
        container.style.setProperty('--lyrics-text-color', lyricsTextColor);
        const list = document.createElement('ol');
        list.className = 'timed-lyrics-list full-lyrics-list';
        list.addEventListener('click', event => {
            const lyricText = event.target.closest('.timed-lyric-content');
            const seekButton = lyricText?.closest('[data-lyric-time]');
            const time = Number(seekButton?.dataset.lyricTime);
            if (!lyricText || !track || getTrackStorageId(getLyricsTrack()) !== getTrackStorageId(track) || !Number.isFinite(time)) return;
            const selection = window.getSelection();
            if (
                selection
                && !selection.isCollapsed
                && list.contains(selection.anchorNode)
                && list.contains(selection.focusNode)
            ) return;
            let caretRange = document.caretRangeFromPoint?.(event.clientX, event.clientY);
            if (!caretRange) {
                const caretPosition = document.caretPositionFromPoint?.(event.clientX, event.clientY);
                if (caretPosition) {
                    caretRange = document.createRange();
                    caretRange.setStart(caretPosition.offsetNode, caretPosition.offset);
                    caretRange.collapse(true);
                }
            }
            const textNode = caretRange?.startContainer;
            if (!textNode || textNode.nodeType !== Node.TEXT_NODE || !lyricText.contains(textNode)) return;
            const text = textNode.textContent || '';
            const candidateOffsets = [caretRange.startOffset, caretRange.startOffset - 1]
                .filter(offset => offset >= 0 && offset < text.length);
            const hitLyricGlyph = candidateOffsets.some(offset => {
                if (/\s/.test(text[offset])) return false;
                const characterRange = document.createRange();
                characterRange.setStart(textNode, offset);
                characterRange.setEnd(textNode, offset + 1);
                return Array.from(characterRange.getClientRects()).some(rect => (
                    event.clientX >= rect.left
                    && event.clientX <= rect.right
                    && event.clientY >= rect.top
                    && event.clientY <= rect.bottom
                ));
            });
            if (!hitLyricGlyph) return;
            if (getRemotePlaybackSession()) {
                void requestRemotePlaybackControl('seek', { position: time });
                return;
            }
            seekAudioToTime(audio, time, () => {
                updateCurrentLyric(track, audio.currentTime);
                renderSyncedLyrics(track, audio.currentTime, list);
            });
        });
        container.appendChild(list);
        lyricsPanel.appendChild(container);
        updateLyricsPlaybackProgress(list);
    }

    function updateLyricsPlaybackProgress(list = lyricsPanel?.querySelector('.full-lyrics-list')) {
        const playback = getRemotePlaybackSession();
        const track = getLyricsTrack();
        const time = playback
            ? getSharedPlaybackTime(playback)
            : Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        renderSyncedLyrics(track, time, list);
    }

    function updateBackgroundAndViews() {
        if (isQuickAddMode && (
            isLyricsMode || isAllSongsMode || isPlaylistViewMode || isEditSongMode
            || isEditPlaylistMode || isSettingsMode || isAdminMode || isProfileMode
        )) {
            isQuickAddMode = false;
        }
        const anyViewOpen = isLyricsMode || isAllSongsMode || isQuickAddMode || isPlaylistViewMode || isEditSongMode || isEditPlaylistMode || isSettingsMode || isAdminMode || isProfileMode;
        nowPlayingLyric?.classList.toggle('is-view-open', anyViewOpen);
        secretText?.classList.toggle('is-view-open', anyViewOpen);
        
        if (isLyricsMode) {
            mainContent.style.backgroundColor = '#000';
            merged.style.opacity = '0';
        } else if (anyViewOpen) {
            mainContent.style.backgroundColor = 'transparent';
            merged.style.opacity = '0';
        } else {
            mainContent.style.backgroundColor = 'transparent';
            merged.style.opacity = '1';
        }

        if (lyricsPanel && !isLyricsMode) {
            lyricsPanel.style.backgroundColor = 'transparent';
            lyricsPanel.style.removeProperty('--lyrics-color');
        }

        if (sidebarShell) {
            sidebarShell.classList.toggle('lyrics-open', isLyricsMode);
        }
        
        if(lyricsPanel) lyricsPanel.classList.toggle('active', isLyricsMode);
        if(allSongsPanel) allSongsPanel.classList.toggle('active', isAllSongsMode);
        if(quickAddPanel) quickAddPanel.classList.toggle('active', isQuickAddMode);
        if(plViewPanel) plViewPanel.classList.toggle('active', isPlaylistViewMode);
        if(editSongPanel) editSongPanel.classList.toggle('active', isEditSongMode);
        if(editPlaylistPanel) editPlaylistPanel.classList.toggle('active', isEditPlaylistMode);
        if(settingsPanel) settingsPanel.classList.toggle('active', isSettingsMode);
        if(adminPanel) adminPanel.classList.toggle('active', isAdminMode);
        if(profilePanel) profilePanel.classList.toggle('active', isProfileMode);
        if(btnLyrics) btnLyrics.classList.toggle('active', isLyricsMode);
        
        if (isLyricsMode) updateLyricsView();
    }

    if (btnLyrics) {
        btnLyrics.addEventListener('click', () => {
            isLyricsMode = !isLyricsMode;
            if (isLyricsMode) {
                isAllSongsMode = false; 
                isPlaylistViewMode = false;
                isEditSongMode = false;
                isEditPlaylistMode = false;
                isSettingsMode = false;
                isProfileMode = false;
            }
            updateBackgroundAndViews();
        });
    }

    audio.addEventListener('play', () => { 
        if (getRemotePlaybackSession()) {
            pauseForRemotePlayback();
            return;
        }
        sharedDevicePlayback = null;
        if (sharedPlaybackClockTimer) clearInterval(sharedPlaybackClockTimer);
        sharedPlaybackClockTimer = null;
        renderSharedPlaybackStatus();
        desktopSetTaskbarPlaybackState?.(true);
        updateDiscordPresence();
        suppressStartupPlaybackUpdates = false;
        const activeUser = getStoredUser();
        if (currentTrackSource === 'together') {
            listeningTogetherNeedsUserGesture = false;
            updateListeningTogetherStatus();
            playbackActivityUserId = null;
        } else if (activeUser?._id && !isRestoringInitialPlayback) {
            playbackActivityUserId = String(activeUser._id);
        }
        sharedPlaybackPlaying = true;
        startPlaybackStatusSync();
        updateUserStatus(true);
        offlineListeningLastSample = offlineOnly || !navigator.onLine
            ? {
                trackId: String(getCurrentTrack()?._id || ''),
                currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
                sampledAt: performance.now()
            }
            : null;
        if (!isRestoringInitialPlayback) broadcastPlaybackState(true);
        btnPlayPause.querySelector('img').src = '/img/pause.png'; 
        resetAutoSpin(); 
        if (isProfileMode) renderProfile();
    });
    audio.addEventListener('pause', () => { 
        if (suppressRemotePlaybackPause) {
            suppressRemotePlaybackPause = false;
            desktopSetTaskbarPlaybackState?.(false);
            sharedPlaybackPlaying = false;
            stopPlaybackStatusSync();
            updatePlaybackControlLock();
            btnPlayPause.querySelector('img').src = '/img/play.png';
            stopSpin();
            if (isProfileMode) renderProfile();
            return;
        }
        if (getRemotePlaybackSession()) {
            updatePlaybackControlLock();
            return;
        }
        desktopSetTaskbarPlaybackState?.(false);
        updateDiscordPresence();
        recordOfflineListeningProgress(
            getCurrentTrack(),
            Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
            true
        );
        offlineListeningLastSample = null;
        persistOfflineListeningBuffer(true);
        sharedPlaybackPlaying = false;
        stopPlaybackStatusSync();
        updateListeningTogetherControls();
        persistPlaybackPosition(true);
        broadcastPlaybackState(true);
        if (playbackUiFrame) {
            cancelAnimationFrame(playbackUiFrame);
            playbackUiFrame = null;
        }
        btnPlayPause.querySelector('img').src = '/img/play.png'; 
        stopSpin(); 
        if (!isLoggingOut) updateUserStatus(true);
        if (isProfileMode) renderProfile();
    });

    audio.addEventListener('loadstart', () => {
        audioLoading = true;
        renderPlaybackLoading();
    });

    audio.addEventListener('error', () => {
        audioLoading = false;
        loadingTrackId = '';
        renderPlaybackLoading();
        const currentTrack = getCurrentTrack();
        if (!isCurrentAudioSource(currentTrack)) return;
        if (currentTrackSource === 'together') {
            stopFollowingUnavailablePlayback('No se pudo cargar la canción que estás siguiendo.');
            return;
        }
        console.error('No se pudo cargar la canción actual.', {
            trackId: getTrackStorageId(currentTrack),
            source: audio.currentSrc,
            code: audio.error?.code,
            message: audio.error?.message
        });
        const audioErrorMessages = {
            1: 'La carga de la canción fue cancelada.',
            2: 'Error de red al cargar la canción. Comprueba tu conexión.',
            3: 'El formato de audio no se pudo decodificar.',
            4: 'El servidor no ofrece un formato de audio compatible.'
        };
        showToast(audioErrorMessages[audio.error?.code] || 'No se pudo cargar la canción.', true);
    });

    audio.addEventListener('waiting', () => {
        audioLoading = true;
        renderPlaybackLoading();
    });

    audio.addEventListener('canplay', () => {
        audioLoading = false;
        loadingTrackId = '';
        renderPlaybackLoading();
    });

    audio.addEventListener('playing', () => {
        audioLoading = false;
        loadingTrackId = '';
        renderPlaybackLoading();
    });

    btnVolume.addEventListener('click', () => {
        if (gainNode.gain.value > 0) {
            gainNode.gain.value = 0;
            volumeSlider.value = '0';
            btnVolume.querySelector('img').src = '/img/mute.png';
            updateVolumeSliderUI(0);
        } else {
            currentVolume = currentVolume > 0 ? currentVolume : 1;
            gainNode.gain.value = currentVolume;
            volumeSlider.value = String(currentVolume * 100);
            btnVolume.querySelector('img').src = '/img/volume.png';
            updateVolumeSliderUI(gainNode.gain.value);
        }
    });

    const updateVolumeSliderUI = (val) => {
        const isMuted = gainNode.gain.value <= 0;
        const displayValue = isMuted ? 0 : val;
        const percent = displayValue * 100;
        if (document.activeElement !== volumeTooltip) {
            volumeTooltip.value = String(Number(percent.toFixed(2)));
        }
        const sliderPercent = (displayValue / maxVolume) * 100;
        const trackColor = safeColor(getRemotePlaybackSession()?.color || getCurrentTrack()?.color || '#ffffff');

        if (percent <= 100) {
            volumeSlider.style.background = `linear-gradient(to right, ${trackColor} ${sliderPercent}%, #333 ${sliderPercent}%)`;
            volumeTooltip.parentElement.style.color = '#fff';
        } else {
            const normalPercent = (1 / maxVolume) * 100;
            volumeSlider.style.background = `linear-gradient(to right, ${trackColor} ${normalPercent}%, red ${normalPercent}%, red ${sliderPercent}%, #333 ${sliderPercent}%)`;
            volumeTooltip.parentElement.style.color = 'red';
        }
    };

    volumeSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value) / 100;
        gainNode.gain.value = val;
        currentVolume = val;
        btnVolume.querySelector('img').src = '/img/volume.png';
        updateVolumeSliderUI(val);
    });

    volumeTooltip.addEventListener('change', () => {
        const inputValue = volumeTooltip.value.trim();
        const numericInput = inputValue.endsWith('%') ? inputValue.slice(0, -1).trim() : inputValue;
        const percent = Number(numericInput.replace(',', '.'));
        const maxPercent = maxVolume * 100;
        if (!numericInput || !Number.isFinite(percent)) {
            volumeTooltip.value = String(Number((currentVolume * 100).toFixed(2)));
            showToast('Ingresa un porcentaje de volumen válido.', true);
            return;
        }
        const clampedPercent = Math.min(maxPercent, Math.max(0, percent));
        const val = clampedPercent / 100;
        gainNode.gain.value = val;
        currentVolume = val;
        volumeSlider.value = String(clampedPercent);
        btnVolume.querySelector('img').src = val === 0 ? '/img/mute.png' : '/img/volume.png';
        volumeTooltip.value = String(Number(clampedPercent.toFixed(2)));
        updateVolumeSliderUI(val);
    });
    volumeTooltip.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            volumeTooltip.blur();
        }
    });

    if (inputMaxVolume) {
        inputMaxVolume.addEventListener('change', (event) => {
            const requestedPercent = Number(event.target.value);
            const clampedPercent = Math.min(1000, Math.max(100, Number.isFinite(requestedPercent) ? requestedPercent : 200));
            maxVolume = clampedPercent / 100;
            event.target.value = String(clampedPercent);
            localStorage.setItem('maxVolume', String(maxVolume));
            volumeSlider.max = String(clampedPercent);
            if (currentVolume > maxVolume) {
                currentVolume = maxVolume;
                gainNode.gain.value = maxVolume;
                volumeSlider.value = String(clampedPercent);
            }
            updateVolumeSliderUI(currentVolume);
        });
    }

    function updateQueueSyncIndicator() {
        const indicator = document.getElementById('queue-sync-indicator');
        const isSyncPending = Boolean(
            accountQueuePendingIds
            || accountQueueSyncInFlight
            || sharedQueueJamUpdateInFlight
        );
        if (indicator) indicator.hidden = !isSyncPending;
        if (btnQueue) btnQueue.setAttribute('aria-label', isSyncPending
            ? 'Cola; sincronizando cambios'
            : 'Abrir cola');
    }

    function renderQueue({ syncAccount = true, syncShared = true } = {}) {
        updateQueueSyncIndicator();
        renderJamControls();
        queueList.innerHTML = '';
        const remotePlayback = getRemotePlaybackSession();
        const isLocalQueue = !remotePlayback && !listeningTogetherUserId && sharedQueueRole !== 'follower';
        const hasAccountQueue = Boolean(remotePlayback);
        const currentTrack = remotePlayback ? getLyricsTrack() : getCurrentTrack();
        const displayedQueue = remotePlayback
            ? getDisplayedAccountQueueIds()
                .map((songId, position) => ({
                    track: playlist.find(track => String(track._id || track.id) === songId),
                    position
                }))
                .filter(item => item.track)
            : sharedQueueRole === 'follower'
                ? sharedQueueJamActive
                    ? (sharedQueueJamPendingUpcomingIds || sharedQueueUpcomingIds)
                        .map((songId, position) => ({
                            track: playlist.find(track => String(track._id || track.id) === String(songId)),
                            position
                        }))
                        .filter(item => item.track)
                    : []
                : [
                ...customQueue.map((track, position) => ({ track, position }))
            ];
        const activeQueuePlaylist = activePlaylistId
            ? userPlaylists.find(playlistItem => playlistItem.id === activePlaylistId)
            : null;
        const sourceTracks = isLocalQueue
            ? sharedQueueJamActive
                ? activeQueueTracks
                : activeQueuePlaylist
                    ? activeQueuePlaylist.tracks
                        .map(track => playlist.find(main => String(main._id || main.id) === String(track._id || track.id)))
                        .filter(Boolean)
                    : queueName === 'GENERAL'
                        ? playlist
                        : activeQueueTracks
            : [];
        const allSourceIndices = isLocalQueue
            ? sourceTracks
                .map(track => playlist.indexOf(track))
                .filter(index => index !== -1)
            : [];
        const sequentialSourceIndices = isShuffle ? [] : getSequentialQueueIndices();
        const wrappedSourceIndices = activeQueueTracks
            .map(track => playlist.indexOf(track))
            .filter(index => index !== -1 && index !== currentTrackIndex);
        const sourceIndices = !isLocalQueue
            ? []
            : (isShuffle
                ? unplayedIndices
                : sequentialSourceIndices.length
                    ? sequentialSourceIndices
                    : wrappedSourceIndices)
                .filter(index => index !== currentTrackIndex && allSourceIndices.includes(index));
        const sharedSourceTracks = sharedQueueRole === 'follower'
            ? sharedQueueIds
                .map(songId => playlist.find(track => String(track._id || track.id) === String(songId)))
                .filter(Boolean)
            : [];
        const accountSourceTracks = hasAccountQueue
            ? accountQueueSourceIds
                .map(songId => playlist.find(track => String(track._id || track.id) === String(songId)))
                .filter(Boolean)
            : [];

        if (currentTrack) {
            const currentHeader = document.createElement('div');
            currentHeader.className = 'queue-header';
            currentHeader.textContent = 'Reproduciendo ahora';
            queueList.appendChild(currentHeader);

            const currentItem = document.createElement('li');
            currentItem.className = 'queue-item active';
            currentItem.dataset.songId = String(currentTrack._id || currentTrack.id || '');
            if (!remotePlayback) currentItem.dataset.trackIndex = String(currentTrackIndex);
            currentItem.style.setProperty('--track-color', safeColor(currentTrack.color));
            currentItem.innerHTML = `
                ${createImageMarkup(getSongCover(currentTrack), 'queue-item-img')}
                <div class="queue-item-info">
                    <span class="queue-item-name">${escapeHtml(currentTrack.name)}</span>
                    <span class="queue-item-artist">${escapeHtml(currentTrack.artist)}</span>
                </div>
            `;
            queueList.appendChild(currentItem);
        }

        if (displayedQueue.length > 0) {
            const header = document.createElement('div');
            header.className = 'queue-header';
            header.textContent = 'A continuación en la cola';
            queueList.appendChild(header);

            displayedQueue.forEach(({ track, position }) => {
                const canManageQueue = hasAccountQueue
                    || (sharedQueueRole === 'follower' && sharedQueueJamActive)
                    || (!isFollowingPlayback() && sharedQueueRole !== 'follower');
                const li = document.createElement('li');
                li.className = 'queue-item';
                li.dataset.songId = String(track._id || track.id || '');
                li.style.setProperty('--track-color', safeColor(track.color));
                li.innerHTML = `
                    ${createImageMarkup(getSongCover(track), 'queue-item-img')}
                    <div class="queue-item-info">
                        <span class="queue-item-name">${escapeHtml(track.name)}</span>
                        <span class="queue-item-artist">${escapeHtml(track.artist)}</span>
                    </div>
                    ${canManageQueue ? `<button class="remove-queue-btn" type="button">
                        <img src="/img/cancel.png" draggable="false" class="no-drag" alt="">
                    </button>` : ''}
                `;
                li.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (li.dataset.wasDragged === 'true') {
                        delete li.dataset.wasDragged;
                        return;
                    }
                    if (e.target.closest('.remove-queue-btn')) {
                        if (hasAccountQueue) {
                            removeAccountQueueTrack(position);
                        } else if (sharedQueueRole === 'follower' && sharedQueueJamActive) {
                            const upcomingIds = [...(sharedQueueJamPendingUpcomingIds || sharedQueueUpcomingIds)];
                            upcomingIds.splice(position, 1);
                            requestJamQueueUpdate(upcomingIds);
                        } else {
                            customQueue.splice(position, 1);
                            renderQueue();
                        }
                        return;
                    }
                    if (hasAccountQueue) {
                        requestAccountQueuePlay(track, position);
                        return;
                    }
                    if (sharedQueueRole === 'follower') {
                        if (sharedQueueJamActive) {
                            requestJamPlayback('playTrack', String(track._id || track.id), 'upcoming');
                        }
                        return;
                    }
                    if (isFollowingPlayback()) return;
                    const trackIndex = playlist.findIndex(item => (
                        getTrackStorageId(item) === getTrackStorageId(track)
                    ));
                    const queuePosition = customQueue[position] === track
                        ? position
                        : customQueue.findIndex(item => item === track);
                    if (trackIndex !== -1 && queuePosition !== -1) {
                        customQueue.splice(0, queuePosition + 1);
                        playbackHistory.push({ index: currentTrackIndex, source: currentTrackSource });
                        loadAndPlayTrack(trackIndex, 'custom');
                    }
                });
                if (hasAccountQueue) {
                    li.draggable = true;
                    setupNativeReorderDrag(li, 'account-queue', position, reorderAccountQueue);
                } else if (sharedQueueRole === 'follower' && sharedQueueJamActive) {
                    li.draggable = true;
                    setupNativeReorderDrag(li, 'jam-upcoming-queue', position, reorderJamQueue);
                } else if (canManageQueue) {
                    setupCustomQueueDrag(li, position);
                }
                queueList.appendChild(li);
            });
        }

        if (sourceIndices.length > 0 && isLocalQueue) {
            const sourceHeader = document.createElement('div');
            sourceHeader.className = 'queue-header';
            sourceHeader.textContent = sharedQueueJamActive
                ? (sharedQueueHostQueueName === 'GENERAL'
                    ? 'JAM'
                    : sharedQueueHostQueueName || queueName || 'JAM')
                : queueName || 'GENERAL';
            queueList.appendChild(sourceHeader);

            sourceIndices.forEach((origIndex, position) => {
                const track = playlist[origIndex];
                if (!track) return;
                const li = document.createElement('li');
                li.className = `queue-source-item${origIndex === currentTrackIndex ? ' active' : ''}`;
                li.dataset.queueSource = isShuffle ? 'shuffle' : 'regular';
                li.dataset.queuePosition = position;
                li.dataset.trackIndex = String(origIndex);
                li.style.setProperty('--track-color', safeColor(track.color));
                li.innerHTML = `
                    ${createImageMarkup(getSongCover(track), 'queue-item-img')}
                    <div class="queue-item-info">
                        <span class="queue-item-name">${escapeHtml(track.name)}</span>
                        <span class="queue-item-artist">${escapeHtml(track.artist)}</span>
                    </div>
                `;
                setupSongMenuListeners(li, origIndex);
                setupQueueAddSwipe(li, track);
                queueList.appendChild(li);
            });
        } else if (accountSourceTracks.length > 0) {
            const sourceHeader = document.createElement('div');
            sourceHeader.className = 'queue-header';
            sourceHeader.textContent = accountQueueName || 'GENERAL';
            queueList.appendChild(sourceHeader);
            accountSourceTracks.forEach(track => {
                const li = document.createElement('li');
                li.className = 'queue-source-item';
                li.dataset.songId = String(track._id || track.id || '');
                li.style.setProperty('--track-color', safeColor(track.color));
                li.innerHTML = `
                    ${createImageMarkup(getSongCover(track), 'queue-item-img')}
                    <div class="queue-item-info">
                        <span class="queue-item-name">${escapeHtml(track.name)}</span>
                        <span class="queue-item-artist">${escapeHtml(track.artist)}</span>
                    </div>
                `;
                li.tabIndex = 0;
                li.setAttribute('role', 'button');
                const playAccountSourceTrack = () => requestAccountQueuePlay(track, -1);
                li.addEventListener('click', playAccountSourceTrack);
                li.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        playAccountSourceTrack();
                    }
                });
                setupQueueAddSwipe(li, track);
                queueList.appendChild(li);
            });
        } else if (sharedSourceTracks.length > 0) {
            const sourceHeader = document.createElement('div');
            sourceHeader.className = 'queue-header';
            sourceHeader.textContent = sharedQueueJamActive && sharedQueueHostQueueName === 'GENERAL'
                ? 'JAM'
                : sharedQueueHostQueueName || 'GENERAL';
            queueList.appendChild(sourceHeader);
            sharedSourceTracks.forEach(track => {
                const li = document.createElement('li');
                li.className = 'queue-source-item';
                li.dataset.songId = String(track._id || track.id || '');
                li.style.setProperty('--track-color', safeColor(track.color));
                li.innerHTML = `
                    ${createImageMarkup(getSongCover(track), 'queue-item-img')}
                    <div class="queue-item-info">
                        <span class="queue-item-name">${escapeHtml(track.name)}</span>
                        <span class="queue-item-artist">${escapeHtml(track.artist)}</span>
                    </div>
                `;
                if (sharedQueueJamActive) {
                    li.tabIndex = 0;
                    li.setAttribute('role', 'button');
                    const playSharedTrack = () => requestJamPlayback('playTrack', String(track._id || track.id), 'source');
                    li.addEventListener('click', playSharedTrack);
                    li.addEventListener('keydown', event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            playSharedTrack();
                        }
                    });
                    setupQueueAddSwipe(li, track);
                }
                queueList.appendChild(li);
            });
        } else if (displayedQueue.length === 0 && (hasAccountQueue || customQueue.length === 0)) {
            const emptyQueue = document.createElement('div');
            emptyQueue.className = 'queue-header';
            emptyQueue.textContent = sharedQueueRole === 'follower' && sharedQueueJamActive
                ? 'NO HAY CANCIONES PENDIENTES'
                : 'NO HAY MÁS CANCIONES EN LA COLA';
            queueList.appendChild(emptyQueue);
        }
        if (syncShared) publishSharedQueueSnapshot();
        if (syncAccount && !remotePlayback && !listeningTogetherUserId && !sharedQueueSessionId && currentTrack) {
            publishAccountQueueSnapshot();
        }
    }

    function loadAndPlayTrack(index, source = 'regular', shouldPlay = true, restoreTime = 0, forceLocal = false) {
        if (shouldPlay && getRemotePlaybackSession() && !forceLocal) {
            const remoteTrack = playlist[index];
            if (remoteTrack) return requestRemotePlaybackControl('playTrack', { songId: String(remoteTrack._id) });
            return Promise.resolve(false);
        }
        if (shouldPlay && isRemotePlaybackLocked() && !forceLocal) return Promise.resolve(false);
        if (isFollowingPlayback() && source !== 'together') return Promise.resolve(false);
        if (index >= playlist.length) index = 0;
        if (index < 0) index = playlist.length - 1;
        const track = playlist[index];
        if (!track) return Promise.resolve(false);
        if (!track.path && !track.audioUrl && !offlineModeEnabled && !offlineOnly) {
            showToast('Esta canción no tiene un archivo de audio disponible.', true);
            return Promise.resolve(false);
        }

        listeningTogetherMetadataWaitToken += 1;
        listeningTogetherMetadataWaitTrackId = null;
        playbackActivityUserId = null;
        currentTrackIndex = index;
        currentTrackSource = source;
        resetSynchronizedPlaybackRate();
        updateListeningTogetherControls();
        currentTrackId = track._id;
        loadingTrackId = String(track._id || '');
        renderSongLoadingState();
        if (sharedQueueRole === 'host' && sharedQueueJamActive && source !== 'custom') {
            sharedQueueHostQueueName = queueName || 'GENERAL';
        }
        const trackStorageId = getTrackStorageId(track);
        if (source !== 'custom') {
            generalQueueAnchorTrackId = trackStorageId;
        } else if (activeQueueTracks.some(queueTrack => getTrackStorageId(queueTrack) === trackStorageId)) {
            if (isShuffle) {
                unplayedIndices = unplayedIndices.filter(queueIndex => (
                    getTrackStorageId(playlist[queueIndex]) !== trackStorageId
                ));
            } else {
                generalQueueAnchorTrackId = trackStorageId;
            }
        }
        const currentUser = getStoredUser();
        playbackUiTrackId = track._id;
        playbackUiTime = 0;
        sharedPlaybackTime = 0;
        sharedPlaybackDuration = 0;
        if (progressBar) progressBar.style.width = '0%';
        updateTrackDurationLabel(0, Number(track.duration) || 0);
        audio.pause();
        const sourceLoadToken = ++audioSourceLoadToken;
        let playbackPromise = Promise.resolve(true);
        let audioSourceAssigned = false;
        const setAudioSource = async () => {
            const mediaKey = `song:${track._id}:audio`;
            let localUrl = null;
            if (offlineModeEnabled || offlineOnly) {
                try {
                    localUrl = await getOfflineObjectUrl(mediaKey, track.path || track.audioUrl);
                } catch (error) {
                    console.warn('No se pudo abrir el audio guardado.', error);
                }
            }
            if (sourceLoadToken !== audioSourceLoadToken) {
                if (localUrl && localUrl !== activeAudioObjectUrl) {
                    URL.revokeObjectURL(localUrl);
                    offlineMediaManager.forgetObjectUrl(mediaKey);
                }
                return;
            }
            if (offlineOnly && !localUrl) {
                throw new Error(`"${track.name}" no está descargada para reproducirse sin conexión.`);
            }
            const source = localUrl || track.path || track.audioUrl;
            if (!source) throw new Error(`"${track.name}" no tiene un archivo de audio disponible.`);
            if (activeAudioObjectUrl && activeAudioObjectUrl !== source) {
                URL.revokeObjectURL(activeAudioObjectUrl);
                if (activeAudioObjectUrlKey) offlineMediaManager.forgetObjectUrl(activeAudioObjectUrlKey);
                activeAudioObjectUrl = null;
                activeAudioObjectUrlKey = null;
            }
            if (source?.startsWith('blob:')) {
                activeAudioObjectUrl = source;
                activeAudioObjectUrlKey = mediaKey;
            }
            if (Number.isFinite(restoreTime) && restoreTime > 0) {
                audio.addEventListener('loadedmetadata', () => {
                    if (sourceLoadToken !== audioSourceLoadToken) return;
                    audio.currentTime = Math.min(restoreTime, audio.duration || restoreTime);
                }, { once: true });
            }
            audio.src = source || '';
            audioSourceAssigned = true;
            audio.currentTime = 0;
            if (shouldPlay) {
                await audio.play();
            } else {
                audio.pause();
            }
        };
        if (offlineModeEnabled || offlineOnly) {
            playbackPromise = setAudioSource().then(() => sourceLoadToken === audioSourceLoadToken).catch(error => {
                if (sourceLoadToken !== audioSourceLoadToken) return false;
                if (source === 'together') {
                    stopFollowingUnavailablePlayback(error.message || 'No se pudo cargar la canción de tu amigo.');
                    return false;
                }
                if (isExpectedAudioPlayInterruption(error)) return false;
                if (audioSourceAssigned && audio.error && isCurrentAudioSource(track)) return false;
                showToast(error.message || 'No se pudo abrir la canción guardada.', true);
                return false;
            });
        } else {
            if (Number.isFinite(restoreTime) && restoreTime > 0) {
                audio.addEventListener('loadedmetadata', () => {
                    if (sourceLoadToken !== audioSourceLoadToken) return;
                    audio.currentTime = Math.min(restoreTime, audio.duration || restoreTime);
                }, { once: true });
            }
            audio.src = track.path || track.audioUrl;
            audioSourceAssigned = true;
            audio.currentTime = 0;
            if (shouldPlay) {
                playbackPromise = audio.play().then(() => sourceLoadToken === audioSourceLoadToken).catch(error => {
                    if (sourceLoadToken !== audioSourceLoadToken || isExpectedAudioPlayInterruption(error)) return false;
                    console.warn('No se pudo iniciar la reproducción.', error);
                    return false;
                });
            }
        }
        if (currentUser?._id && (shouldPlay || source === 'together')) {
            localStorage.setItem(`amgc-last-playback-${currentUser._id}`, JSON.stringify({
                songId: track._id,
                currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0
            }));
        }

        trackNameEl.textContent = track.name;
        trackArtistEl.textContent = track.artist;
        updateDiscordPresence();
        bottomBar.style.setProperty('--track-color', safeColor(track.color));
        const trackCover = getSongCover(track);
        bottomBarCover.src = trackCover;
        bottomBarCover.alt = trackCover ? '' : 'SIN IMG';
        bottomBarCover.classList.toggle('no-image', !trackCover);
        updateVolumeSliderUI(currentVolume); 
        renderQueue(); 
        showPlayerPopup(track);
        updateCurrentLyric(track, 0);
        if (isLyricsMode) updateLyricsView();
        if (isProfileMode) renderProfile();

        updateBackgroundAndViews();
        return playbackPromise;
    }

    function showPlayerPopup(track) {
        const trackCover = getSongCover(track);
        popupCover.src = trackCover;
        popupCover.alt = trackCover ? '' : 'SIN IMG';
        popupCover.classList.toggle('no-image', !trackCover);
        popupSongName.replaceChildren();
        const songName = document.createElement('span');
        songName.textContent = track.name || '';
        const artistName = document.createElement('span');
        artistName.className = 'popup-artist';
        artistName.textContent = track.artist || '';
        popupSongName.append(songName, artistName);
        playerPopup.style.setProperty('--track-color', safeColor(track.color));
        playerPopup.classList.add('active');

        if (popupTimeout) clearTimeout(popupTimeout);
        popupTimeout = setTimeout(() => playerPopup.classList.remove('active'), 4000);
    }

    function playNextTrack() {
        if (getRemotePlaybackSession()) {
            void requestRemotePlaybackControl('next');
            return;
        }
        if (isFollowingPlayback()) {
            if (sharedQueueJamActive) requestJamPlayback('next');
            return;
        }
        if (isRemotePlaybackLocked()) return;
        const hasPlayableSource = track => (
            offlineModeEnabled
            || offlineOnly
            || Boolean(track?.path || track?.audioUrl)
        );
        if (customQueue.length > 0) {
            while (customQueue.length > 0) {
                const nextTrack = customQueue.shift();
                const nextTrackId = getTrackStorageId(nextTrack);
                const idx = playlist.findIndex(track => getTrackStorageId(track) === nextTrackId);
                if (idx === -1) continue;
                if (!hasPlayableSource(playlist[idx])) continue;
                if (playlist[currentTrackIndex]) playbackHistory.push({ index: currentTrackIndex, source: currentTrackSource });
                loadAndPlayTrack(idx, 'custom');
                return;
            }
        }

        if (isShuffle) {
            if (unplayedIndices.length === 0) unplayedIndices = buildShuffleQueue();
            while (unplayedIndices.length > 0) {
                const nextRandom = unplayedIndices.shift();
                if (!hasPlayableSource(playlist[nextRandom])) continue;
                if (playlist[currentTrackIndex]) playbackHistory.push({ index: currentTrackIndex, source: currentTrackSource });
                loadAndPlayTrack(nextRandom, 'shuffle');
                return;
            }
            showToast('No hay canciones disponibles para reproducir en la cola.', true);
        } else {
            const nextIndex = getSequentialQueueIndices().find(index => hasPlayableSource(playlist[index]));
            if (nextIndex !== undefined) {
                if (playlist[currentTrackIndex]) playbackHistory.push({ index: currentTrackIndex, source: currentTrackSource });
                loadAndPlayTrack(nextIndex, 'regular');
            } else {
                const firstQueueIndex = activeQueueTracks
                    .map(track => playlist.findIndex(item => getTrackStorageId(item) === getTrackStorageId(track)))
                    .find(index => index !== -1 && hasPlayableSource(playlist[index]))
                    ?? (queueName === 'GENERAL'
                        ? playlist.findIndex(hasPlayableSource)
                        : -1);
                if (firstQueueIndex !== -1) {
                    if (playlist[currentTrackIndex]) {
                        playbackHistory.push({ index: currentTrackIndex, source: currentTrackSource });
                    }
                    loadAndPlayTrack(firstQueueIndex, 'regular');
                } else {
                    showToast('No hay canciones disponibles para reproducir en la cola.', true);
                }
            }
        }
    }

    function rewindTrack() {
        const remotePlayback = getRemotePlaybackSession();
        if (remotePlayback) {
            const duration = Math.max(0, Number(remotePlayback.duration) || 0);
            const currentPosition = remoteSeekTimer ? queuedRemoteSeekPosition : getSharedPlaybackTime(remotePlayback);
            const position = Math.max(0, currentPosition - seekSeconds);
            queueRemotePlaybackSeek(duration ? Math.min(duration, position) : position);
            return;
        }
        if (!isFollowingPlayback() && !isRemotePlaybackLocked() && audio.duration) {
            if (playbackUiFrame) {
                cancelAnimationFrame(playbackUiFrame);
                playbackUiFrame = null;
            }
            audio.currentTime = Math.max(0, audio.currentTime - seekSeconds);
            playbackUiTime = audio.currentTime;
            updateTrackDurationLabel(playbackUiTime, audio.duration);
            updatePlaybackProgressFrame();
        }
    }

    function forwardTrack() {
        const remotePlayback = getRemotePlaybackSession();
        if (remotePlayback) {
            const duration = Math.max(0, Number(remotePlayback.duration) || 0);
            const currentPosition = remoteSeekTimer ? queuedRemoteSeekPosition : getSharedPlaybackTime(remotePlayback);
            const position = currentPosition + seekSeconds;
            queueRemotePlaybackSeek(duration ? Math.min(duration, position) : position);
            return;
        }
        if (!isFollowingPlayback() && !isRemotePlaybackLocked() && audio.duration) {
            if (playbackUiFrame) {
                cancelAnimationFrame(playbackUiFrame);
                playbackUiFrame = null;
            }
            audio.currentTime = Math.min(audio.duration, audio.currentTime + seekSeconds);
            playbackUiTime = audio.currentTime;
            updateTrackDurationLabel(playbackUiTime, audio.duration);
            updatePlaybackProgressFrame();
        }
    }

    if (btnRewind) btnRewind.addEventListener("click", rewindTrack);
    if (btnForward) btnForward.addEventListener("click", forwardTrack);

    if (inputSeekSeconds) {
        inputSeekSeconds.addEventListener("change", (e) => {
            const val = parseInt(e.target.value, 10);
            if (!isNaN(val) && val > 0) {
                seekSeconds = val;
            }
        });
    }

    const shortcutStorageKey = 'amgc-desktop-keyboard-shortcuts';
    const defaultKeyboardShortcuts = {
        search: { code: 'KeyK', ctrlKey: true, altKey: true, shiftKey: false },
        toggle: { code: 'Space', ctrlKey: false, altKey: false, shiftKey: false },
        previous: { code: 'ArrowLeft', ctrlKey: false, altKey: false, shiftKey: true },
        next: { code: 'ArrowRight', ctrlKey: false, altKey: false, shiftKey: true }
    };
    const shortcutActions = Object.keys(defaultKeyboardShortcuts);
    const isValidShortcut = shortcut => (
        shortcut
        && typeof shortcut.code === 'string'
        && ['ctrlKey', 'altKey', 'shiftKey'].every(key => typeof shortcut[key] === 'boolean')
        && (shortcut.ctrlKey || shortcut.altKey || shortcut.shiftKey
            || ['Space', 'ArrowLeft', 'ArrowRight'].includes(shortcut.code))
    );
    let keyboardShortcuts = (() => {
        try {
            const saved = JSON.parse(localStorage.getItem(shortcutStorageKey) || 'null');
            if (saved && shortcutActions.every(action => isValidShortcut(saved[action]))) return saved;
        } catch (error) {
            console.warn('No se pudieron leer los atajos de teclado guardados.', error);
        }
        return Object.fromEntries(shortcutActions.map(action => [
            action,
            { ...defaultKeyboardShortcuts[action] }
        ]));
    })();
    let shortcutCaptureAction = null;
    const keyboardShortcutStatus = document.getElementById('keyboard-shortcuts-status');
    const keyboardShortcutButtons = settingsPanel?.querySelectorAll('[data-shortcut-action]') || [];
    const formatShortcut = shortcut => {
        const parts = [];
        if (shortcut.ctrlKey) parts.push('Ctrl');
        if (shortcut.altKey) parts.push('Alt');
        if (shortcut.shiftKey) parts.push('Mayús');
        const keyLabel = shortcut.code === 'Space'
            ? 'Espacio'
            : shortcut.code === 'ArrowLeft'
                ? '←'
                : shortcut.code === 'ArrowRight'
                    ? '→'
                    : shortcut.code.startsWith('Key')
                        ? shortcut.code.slice(3)
                        : shortcut.code.startsWith('Digit')
                            ? shortcut.code.slice(5)
                            : shortcut.code;
        parts.push(keyLabel);
        return parts.join(' + ');
    };
    const updateKeyboardShortcutButtons = () => {
        keyboardShortcutButtons.forEach(button => {
            const action = button.dataset.shortcutAction;
            if (keyboardShortcuts[action]) button.textContent = formatShortcut(keyboardShortcuts[action]);
            button.dataset.capturing = String(shortcutCaptureAction === action);
            button.setAttribute('aria-pressed', String(shortcutCaptureAction === action));
        });
    };
    const setKeyboardShortcutStatus = (message, isError = false) => {
        if (!keyboardShortcutStatus) return;
        keyboardShortcutStatus.textContent = message;
        keyboardShortcutStatus.classList.toggle('error', isError);
    };
    const saveKeyboardShortcuts = nextShortcuts => {
        try {
            localStorage.setItem(shortcutStorageKey, JSON.stringify(nextShortcuts));
            keyboardShortcuts = nextShortcuts;
            updateKeyboardShortcutButtons();
            return true;
        } catch (error) {
            console.error('No se pudieron guardar los atajos de teclado.', error);
            setKeyboardShortcutStatus('No se pudieron guardar los cambios.', true);
            return false;
        }
    };
    const isReservedShortcut = shortcut => {
        if (shortcut.metaKey) return true;
        if (['Tab', 'F5', 'F11', 'F12'].includes(shortcut.code)) return true;
        if (shortcut.altKey && ['ArrowLeft', 'ArrowRight', 'F4', 'F6'].includes(shortcut.code)) return true;
        if (shortcut.ctrlKey && [
            'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyL', 'KeyN', 'KeyO',
            'KeyP', 'KeyR', 'KeyS', 'KeyT', 'KeyU', 'KeyW'
        ].includes(shortcut.code)) return true;
        if (shortcut.ctrlKey && shortcut.shiftKey
            && ['KeyC', 'KeyI', 'KeyJ', 'KeyK'].includes(shortcut.code)) return true;
        return false;
    };
    const shortcutSignature = shortcut => [
        shortcut.code,
        shortcut.ctrlKey,
        shortcut.altKey,
        shortcut.shiftKey
    ].join(':');
    const isModifierKey = code => [
        'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight',
        'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'
    ].includes(code);
    const captureKeyboardShortcut = event => {
        if (event.code === 'Escape') {
            shortcutCaptureAction = null;
            updateKeyboardShortcutButtons();
            setKeyboardShortcutStatus('Asignación cancelada.');
            event.preventDefault();
            return;
        }
        if (event.code === 'Tab') {
            shortcutCaptureAction = null;
            updateKeyboardShortcutButtons();
            setKeyboardShortcutStatus('Asignación cancelada.');
            return;
        }
        if (isModifierKey(event.code) || !event.code || event.code === 'Unidentified') {
            event.preventDefault();
            return;
        }
        const shortcut = {
            code: event.code,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey
        };
        const hasModifier = shortcut.ctrlKey || shortcut.altKey || shortcut.shiftKey || shortcut.metaKey;
        if ((!hasModifier && !['Space', 'ArrowLeft', 'ArrowRight'].includes(shortcut.code))
            || isReservedShortcut(shortcut)) {
            setKeyboardShortcutStatus('Esa combinación está reservada o no es segura; prueba otra.', true);
            event.preventDefault();
            return;
        }
        const conflictingAction = shortcutActions.find(action => (
            action !== shortcutCaptureAction
            && shortcutSignature(keyboardShortcuts[action]) === shortcutSignature(shortcut)
        ));
        if (conflictingAction) {
            setKeyboardShortcutStatus('Esa combinación ya está asignada a otra acción.', true);
            event.preventDefault();
            return;
        }
        const action = shortcutCaptureAction;
        const nextShortcuts = {
            ...keyboardShortcuts,
            [action]: {
                code: shortcut.code,
                ctrlKey: shortcut.ctrlKey,
                altKey: shortcut.altKey,
                shiftKey: shortcut.shiftKey
            }
        };
        if (saveKeyboardShortcuts(nextShortcuts)) {
            shortcutCaptureAction = null;
            updateKeyboardShortcutButtons();
            setKeyboardShortcutStatus('Atajo guardado.');
        }
        event.preventDefault();
    };
    settingsPanel?.addEventListener('click', event => {
        const button = event.target instanceof Element
            ? event.target.closest('[data-shortcut-action]')
            : null;
        if (!button) return;
        shortcutCaptureAction = button.dataset.shortcutAction;
        updateKeyboardShortcutButtons();
        setKeyboardShortcutStatus('Pulsa la combinación que quieres asignar. Esc cancela.');
    });
    document.addEventListener('click', event => {
        if (!shortcutCaptureAction) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('[data-shortcut-action], #btn-reset-keyboard-shortcuts')) return;
        shortcutCaptureAction = null;
        updateKeyboardShortcutButtons();
        setKeyboardShortcutStatus('Asignación cancelada.');
    });
    document.getElementById('btn-reset-keyboard-shortcuts')?.addEventListener('click', () => {
        const defaults = Object.fromEntries(shortcutActions.map(action => [
            action,
            { ...defaultKeyboardShortcuts[action] }
        ]));
        if (saveKeyboardShortcuts(defaults)) {
            shortcutCaptureAction = null;
            updateKeyboardShortcutButtons();
            setKeyboardShortcutStatus('Atajos restablecidos.');
        }
    });
    updateKeyboardShortcutButtons();

    const handleKeyDown = (e) => {
        if (shortcutCaptureAction) {
            captureKeyboardShortcut(e);
            return;
        }
        const target = e.target instanceof Element ? e.target : null;
        const tag = target?.tagName.toLowerCase() || '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select'
            || target?.isContentEditable
            || target?.closest('button, a, [role="button"]')
            || target?.closest('[role="dialog"], dialog[open]')
            || modalOverlay?.classList.contains('active')
            || friendsPanel?.classList.contains('active')
            || chatModal?.classList.contains('active')
            || (playbackDevicePicker && !playbackDevicePicker.hidden)
            || (authOverlay && getComputedStyle(authOverlay).display !== 'none')
            || (loadingSpinner && getComputedStyle(loadingSpinner).display !== 'none')
            || document.querySelector('.app-song-context-menu:not([hidden])')
            || e.repeat) return;
        const matchingAction = shortcutActions.find(action => {
            const shortcut = keyboardShortcuts[action];
            return shortcut.code === e.code
                && shortcut.ctrlKey === e.ctrlKey
                && shortcut.altKey === e.altKey
                && shortcut.shiftKey === e.shiftKey
                && !e.metaKey;
        });
        if (matchingAction) {
            e.preventDefault();
            if (matchingAction === 'search') {
                setAllSongsView(true, { preserveQueue: true });
                requestAnimationFrame(() => allSongsSearch?.focus({ preventScroll: true }));
            } else if (matchingAction === 'toggle') {
                btnPlayPause?.click();
            } else if (matchingAction === 'previous') {
                btnPrev?.click();
            } else if (matchingAction === 'next') {
                btnNext?.click();
            }
            return;
        }
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            rewindTrack();
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            forwardTrack();
        }
    };
    document.addEventListener("keydown", handleKeyDown);

    btnRequestJam?.addEventListener('click', requestJam);
    btnAcceptJamRequest?.addEventListener('click', () => requestJamResponse(true));
    btnDeclineJamRequest?.addEventListener('click', () => requestJamResponse(false));
    btnNext.addEventListener('click', playNextTrack);
    audio.addEventListener('ended', () => {
        if (!audio.ended) return;
        updateDiscordPresence();
        if (currentTrackSource === 'together' && listeningTogetherUserId) return;
        playNextTrack();
    });
    btnPrev.addEventListener('click', () => {
        if (getRemotePlaybackSession()) {
            void requestRemotePlaybackControl('previous');
            return;
        }
        if (isFollowingPlayback()) {
            if (sharedQueueJamActive) requestJamPlayback('previous');
            return;
        }
        const previous = playbackHistory.pop();
        if (!previous) {
            const currentPosition = activeQueueTracks.findIndex(track => playlist.indexOf(track) === currentTrackIndex);
            const fallbackTrack = activeQueueTracks[currentPosition - 1] || activeQueueTracks[activeQueueTracks.length - 1];
            if (fallbackTrack) loadAndPlayTrack(playlist.indexOf(fallbackTrack), 'regular');
            return;
        }

        if (playlist[currentTrackIndex]) {
            if (currentTrackSource === 'custom') {
                customQueue.unshift(playlist[currentTrackIndex]);
            } else if (isShuffle) {
                unplayedIndices.unshift(currentTrackIndex);
            }
        }

        loadAndPlayTrack(previous.index, previous.source);
        renderQueue();
    });

    btnShuffle.addEventListener('click', () => {
        if (getRemotePlaybackSession()) {
            void requestRemotePlaybackControl('shuffle');
            return;
        }
        const selectedPlaylist = activePlaylistId
            ? userPlaylists.find(playlistItem => playlistItem.id === activePlaylistId)
            : null;
        const sourceQueue = selectedPlaylist
            ? selectedPlaylist.tracks
                .map(track => playlist.find(main => String(main._id || main.id) === String(track._id || track.id)))
                .filter(Boolean)
            : queueName === 'GENERAL'
                ? playlist
                : activeQueueTracks;
        const queueMatchesSource = sourceQueue.length === activeQueueTracks.length
            && sourceQueue.every((track, index) => (
                String(track._id || track.id) === String(activeQueueTracks[index]?._id || activeQueueTracks[index]?.id)
            ));
        if (sourceQueue.length && !queueMatchesSource) {
            activeQueueTracks = [...sourceQueue];
            const anchorTrackId = generalQueueAnchorTrackId || String(getCurrentTrack()?._id || getCurrentTrack()?.id || '');
            if (sourceQueue.some(track => String(track._id || track.id) === anchorTrackId)) {
                generalQueueAnchorTrackId = anchorTrackId;
            }
        }
        isShuffle = !isShuffle;
        btnShuffle.classList.toggle('active', isShuffle);
        if (isShuffle) {
            unplayedIndices = buildShuffleQueue();
        } else {
            unplayedIndices = [];
        }
        playbackHistory = [];
        renderQueue();
        broadcastPlaybackState(true);
        void updateUserStatus(true);
    });
    playbackDeviceTriggers.forEach(trigger => {
        trigger.addEventListener('click', event => {
            event.stopPropagation();
            setPlaybackDevicePickerOpen(playbackDevicePicker.hidden);
        });
    });
    playbackDevicePicker?.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', () => setPlaybackDevicePickerOpen(false));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') setPlaybackDevicePickerOpen(false);
    });
    updatePlaybackDevicePickerIcons();
    renderPlaybackDevicePicker();

    function setAllSongsView(forceOpen = false, { preserveQueue = false } = {}) {
        isAllSongsMode = forceOpen ? true : !isAllSongsMode;
        isAdminMode = false;
        isSettingsMode = false;
        isLyricsMode = false;
        isPlaylistViewMode = false;
        isProfileMode = false;
        isEditSongMode = false;
        isEditPlaylistMode = false;

        if (isAllSongsMode) {
            activePlaylistId = null;
            if (!preserveQueue) {
                activeQueueTracks = [...playlist];
                playbackHistory = [];
                unplayedIndices = [];
            }
        }
        updateBackgroundAndViews();
        closeSidebar();
    }

    if (btnAllSongs) {
        btnAllSongs.addEventListener('click', event => {
            event.preventDefault();
            setAllSongsView();
        });
    }

    if (btnSettings) {
        btnSettings.addEventListener('click', (e) => {
            e.preventDefault();
            isSettingsMode = !isSettingsMode;
            if (isSettingsMode) {
                isAllSongsMode = false;
                isLyricsMode = false;
                isPlaylistViewMode = false;
                isEditSongMode = false;
                isEditPlaylistMode = false;
                isAdminMode = false;
                isProfileMode = false;
            }
            updateBackgroundAndViews();
            closeSidebar();
        });
    }

    if (btnAdmin) {
        btnAdmin.addEventListener('click', async (e) => {
            e.preventDefault();
            if (!canCurrentUser('manage_users')) {
                showToast('No tienes permiso para gestionar usuarios.', true);
                return;
            }
            const nextState = !isAdminMode;
            isAdminMode = nextState;
            isSettingsMode = false;
            isAllSongsMode = false;
            isLyricsMode = false;
            isPlaylistViewMode = false;
            isEditSongMode = false;
            isEditPlaylistMode = false;
            isProfileMode = false;
            updateBackgroundAndViews();
            closeSidebar();

            if (isAdminMode) {
                await loadAdminUsers();
            }
        });
    }

    if (btnSettingsYt && desktopYoutubeLocalSaver) {
        if (btnOpenLocalMp3Folder && desktopOpenLocalMp3Folder) {
            btnOpenLocalMp3Folder.hidden = false;
            btnOpenLocalMp3Folder.addEventListener('click', async () => {
                btnOpenLocalMp3Folder.disabled = true;
                try {
                    const directory = await desktopOpenLocalMp3Folder();
                    showYoutubeLinkStatus(`Carpeta de MP3: ${directory}`, false);
                } catch (error) {
                    console.error(error);
                    showYoutubeLinkStatus(error?.message || 'No se pudo abrir la carpeta de MP3.', true);
                } finally {
                    btnOpenLocalMp3Folder.disabled = false;
                }
            });
        }

        btnSettingsYt.addEventListener('click', async () => {
            const link = inputSettingsYt.value.trim();
            if (!link || !isValidYoutubeLink(link)) {
                showYoutubeLinkStatus('El enlace de YouTube no es válido.', true);
                return;
            }

            btnSettingsYt.textContent = "Descargando...";
            btnSettingsYt.disabled = true;
            const ytProgress = startYtDownloadProgress('Descargando canción');
            showYoutubeLinkStatus('Descargando el audio en este equipo...', false);

            const requestedFileName = inputSettingsYtName?.value.trim() || '';

            try {
                const result = await desktopYoutubeLocalSaver(link, requestedFileName);
                stopYtDownloadProgress(ytProgress, {
                    success: true,
                    message: `MP3 guardado en este equipo: ${result.fileName}`
                });
                showYoutubeLinkStatus(`¡MP3 guardado en ${result.path}!`, false);
                inputSettingsYt.value = '';
                if (inputSettingsYtName) inputSettingsYtName.value = '';
            } catch (e) {
                console.error(e);
                const message = e?.message || 'El enlace de YouTube fue rechazado o no es válido.';
                stopYtDownloadProgress(ytProgress, { success: false, message, error: true });
                showYoutubeLinkStatus(message, true);
            } finally {
                btnSettingsYt.textContent = "Descargar Audio";
                btnSettingsYt.disabled = false;
                setTimeout(() => { if (statusSettingsYt) statusSettingsYt.style.display = 'none'; }, 5000);
            }
        });
    }

    btnQueue.addEventListener('click', () => {
        isQueueOpen = !isQueueOpen;
        if (isQueueOpen) {
            queueContainer.classList.add('show');
            bottomBarWrapper.classList.add('queue-open');
            setTimeout(() => {
                const activeItem = queueList.querySelector('.queue-item.active');
                if(activeItem) activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
        } else {
            queueContainer.classList.remove('show');
            bottomBarWrapper.classList.remove('queue-open');
        }
    });

    btnPlayPause.addEventListener('click', () => {
        if (getRemotePlaybackSession()) {
            void requestRemotePlaybackControl('toggle');
            return;
        }
        if (isRemotePlaybackLocked()) return;
        if (isFollowingPlayback()) {
            if (sharedQueueJamActive) {
                requestJamPlayback(audio.paused ? 'play' : 'pause');
                return;
            }
            if (listeningTogetherNeedsUserGesture) {
                audio.play().catch(error => {
                    if (error?.name === 'NotAllowedError') {
                        updateListeningTogetherStatus();
                        showToast('El navegador sigue bloqueando la reproducción. Comprueba los permisos de audio e inténtalo de nuevo.', true);
                    } else if (!isExpectedAudioPlayInterruption(error)) {
                        console.warn('No se pudo reanudar la reproducción sincronizada.', error);
                    }
                });
            }
            return;
        }
        if (audio.paused) {
            audio.play().catch(error => {
                if (!isExpectedAudioPlayInterruption(error)) {
                    console.warn('No se pudo reanudar la reproducción.', error);
                }
            });
        }
        else { audio.pause(); }
    });

    desktopSubscribeTaskbarControls?.(action => {
        if (action === 'previous') btnPrev.click();
        else if (action === 'play-pause') btnPlayPause.click();
        else if (action === 'next') btnNext.click();
    });
    desktopSetTaskbarPlaybackState?.(!audio.paused);

    progressContainer.addEventListener('click', (e) => {
        const remotePlayback = getRemotePlaybackSession();
        if (remotePlayback) {
            const duration = Math.max(0, Number(remotePlayback.duration) || 0);
            if (!duration) return;
            const bounds = progressContainer.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (e.clientX - bounds.left) / bounds.width));
            queueRemotePlaybackSeek(ratio * duration);
            return;
        }
        if (isFollowingPlayback() || isRemotePlaybackLocked()) return;
        const width = progressContainer.clientWidth;
        const clickX = e.offsetX;
        const duration = audio.duration;
        if (duration) audio.currentTime = (clickX / width) * duration;
    });

    audio.addEventListener('timeupdate', () => {
        if (getRemotePlaybackSession()) {
            renderSharedPlaybackStatus();
            return;
        }
        const currentTrack = getCurrentTrack();
        if (!isCurrentAudioSource(currentTrack)) return;
        const nextTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        if (playbackUiTrackId !== currentTrack?._id) {
            playbackUiTrackId = currentTrack?._id || null;
            playbackUiTime = nextTime;
        } else {
            playbackUiTime = nextTime;
        }
        sharedPlaybackTime = playbackUiTime;
        sharedPlaybackDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
        const currentUser = getStoredUser();
        recordOfflineListeningProgress(currentTrack, nextTime);
        if (currentTrack) {
            updateCurrentLyric(currentTrack, playbackUiTime);
            if (isLyricsMode) {
                renderSyncedLyrics(currentTrack, playbackUiTime, lyricsPanel?.querySelector('.full-lyrics-list'));
            }
        }
        updateTrackDurationLabel(playbackUiTime, sharedPlaybackDuration || Number(currentTrack?.duration) || 0);
        if (currentUser?._id && currentTrack) persistPlaybackPosition();
        if (audio.duration && progressBar) {
            const percent = Math.min(100, (playbackUiTime / audio.duration) * 100);
            progressBar.style.width = percent + '%';
        }
        broadcastPlaybackState();
        updateProfileActivityProgress();
        if (isEditSongMode && getTrackStorageId(currentTrack) === getTrackStorageId(getEditedTrack())) {
            updateEditLyricsPreview();
        }
    });

    audio.addEventListener('seeked', () => {
        if (!isCurrentAudioSource(getCurrentTrack())) return;
        updateDiscordPresence();
        persistPlaybackPosition(true);
        broadcastPlaybackState(true);
        if (isEditSongMode) updateEditLyricsPreview();
    });

    audio.addEventListener('loadedmetadata', () => {
        const currentTrack = getCurrentTrack();
        if (!isCurrentAudioSource(currentTrack)) return;
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        if (currentTrack && duration > 0) {
            currentTrack.duration = duration;
            apiFetch(`${API_URL}/songs/${currentTrack._id}/duration`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ duration })
            }).then(response => {
                if (!response.ok) throw new Error('No se pudo guardar la duración');
                userPlaylists.forEach(playlistItem => {
                    let changed = false;
                    playlistItem.tracks?.forEach(track => {
                        if (String(track._id) === String(currentTrack._id)) {
                            track.duration = duration;
                            changed = true;
                        }
                    });
                    if (changed) {
                        playlistItem.duration = playlistItem.tracks.reduce((total, track) => (
                            total + Math.max(0, Number(track.duration) || 0)
                        ), 0);
                    }
                });
                if (isPlaylistViewMode && activePlaylistId) openPlaylistView(activePlaylistId);
            }).catch(error => console.warn('No se pudo actualizar la duración', error));
        }
        updateTrackDurationLabel(playbackUiTime, duration);
        if (progressBar && duration > 0) {
            progressBar.style.width = `${Math.min(100, (playbackUiTime / duration) * 100)}%`;
        }
    });

    resetAutoSpin();

    const handleUnload = () => {
        recordOfflineListeningProgress(
            getCurrentTrack(),
            Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
            true
        );
        offlineListeningLastSample = null;
        persistOfflineListeningBuffer(true);
        const user = getStoredUser();
        if (!user || offlineOnly || !navigator.onLine) return;
        apiFetch(`${API_URL}/users/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user._id, isOnline: false }),
            keepalive: true
        }).catch(error => console.warn('No se pudo cerrar la sesión en el servidor:', error));
    };
    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);
    const handleVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
            if (spinAf !== null) cancelAnimationFrame(spinAf);
            spinAf = null;
            if (perroGif) perroGif.style.display = 'none';
            recordOfflineListeningProgress(
                getCurrentTrack(),
                Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
                true
            );
            persistOfflineListeningBuffer(true);
            return;
        }
        if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && perroGif) {
            perroGif.style.display = 'block';
        }
        if (isAutoSpinning && spinAf === null) {
            lastSpinFrameAt = 0;
            spinAf = requestAnimationFrame(doSpin);
        }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
        audio.pause();
        if (profileActivityTimer) clearInterval(profileActivityTimer);
        if (offlineRecoveryTimer) clearInterval(offlineRecoveryTimer);
        if (offlineDownloadPopupTimer) clearTimeout(offlineDownloadPopupTimer);
        if (friendCacheSaveTimer) clearTimeout(friendCacheSaveTimer);
        offlineMediaManager.dispose();
        cancelAnimationFrame(spinAf);
        clearTimeout(autoSpinTimer);
        if (nowPlayingLyricAnimationTimeout) clearTimeout(nowPlayingLyricAnimationTimeout);
        document.removeEventListener('click', unlockAudio);
        document.removeEventListener('pointerdown', unlockAudio);
        document.removeEventListener('keydown', unlockAudio);
        document.removeEventListener("keydown", handleKeyDown);
        window.removeEventListener('beforeunload', handleUnload);
        window.removeEventListener('pagehide', handleUnload);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        document.removeEventListener('error', handleImageFallback, true);
        window.removeEventListener('storage', handleOfflineStorageChange);
        window.removeEventListener('offline', handleOffline);
        window.removeEventListener('online', handleOnline);
        stopRealtime();
        desktopUpdates?.unsubscribeUpdateState?.();
        desktopUnsubscribeTaskbarControls?.();
    };
}