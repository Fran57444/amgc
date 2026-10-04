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

export function initMusicPlayer() {
    const API_URL = import.meta.env.VITE_API_URL || '/api';
    const realtimeEnabled = import.meta.env.VITE_REALTIME_ENABLED !== 'false';
    const desktopYoutubeDownloader = window.amgcDesktop?.downloadYoutubeAudio;
    const desktopYoutubeLocalSaver = window.amgcDesktop?.saveYoutubeAudioLocally;
    const desktopOpenLocalMp3Folder = window.amgcDesktop?.openLocalMp3Folder;
    const desktopSetDiscordPresence = window.amgcDesktop?.setDiscordPresence;
    const desktopUpdates = window.amgcDesktop;
    const accessTokenStorageKey = 'amgc-access-token';
    let accessToken = localStorage.getItem(accessTokenStorageKey) || '';
    let isLoggingOut = false;
    let offlineOnly = false;
    let offlineModeEnabled = false;
    let offlineDownloadPopupTimer = null;
    let offlineRecoveryTimer = null;
    let offlineListeningBuffer = 0;
    let offlineListeningLastSample = null;
    let offlineListeningLastPersistAt = 0;
    let offlineListeningSyncInProgress = false;
    let suppressNextListeningDelta = false;
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
    const getOfflineObjectUrl = key => offlineMediaManager.getOfflineObjectUrl(key);
    const getOfflineImageUrl = (...args) => offlineMediaManager.getOfflineImageUrl(...args);
    const hydrateOfflineSongCovers = songs => offlineMediaManager.hydrateOfflineSongCovers(songs);
    const hydrateOfflinePlaylistCovers = playlists => offlineMediaManager.hydrateOfflinePlaylistCovers(playlists);
    const syncOfflineResources = () => offlineMediaManager.syncOfflineResources();
    let realtimeConnectedBefore = false;
    let skipNextRealtimeReconciliation = false;
    const profilePlaylistCache = new Map();
    const playlistSaversCache = new Map();
    socket.off('friendsChanged').on('friendsChanged', () => {
        loadFriends();
    });
    socket.off('songCatalogChanged').on('songCatalogChanged', async () => {
        const queueTrackIds = activeQueueTracks.map(track => String(track._id));
        await fetchMusicData();
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
    socket.off('userStatsChanged').on('userStatsChanged', ({ userId } = {}) => {
        const profileUser = selectedProfileUser || getStoredUser();
        if (isProfileMode && profileUser?._id && String(profileUser._id) === String(userId)) {
            renderProfile(true);
        }
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
            if (Number.isFinite(Number(updatedUser.settings?.seekSeconds))) {
                seekSeconds = Number(updatedUser.settings.seekSeconds);
                if (inputSeekSeconds) inputSeekSeconds.value = String(seekSeconds);
            }
            if (Number.isFinite(Number(updatedUser.settings?.maxVolume))) {
                maxVolume = Math.min(10, Math.max(1, Number(updatedUser.settings.maxVolume) / 100));
                localStorage.setItem('maxVolume', String(maxVolume));
                if (inputMaxVolume) inputMaxVolume.value = String(Math.round(maxVolume * 100));
                if (volumeSlider) volumeSlider.max = String(maxVolume);
                if (currentVolume > maxVolume) {
                    currentVolume = maxVolume;
                    gainNode.gain.value = maxVolume;
                    if (volumeSlider) volumeSlider.value = String(maxVolume);
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
        const isReconnect = realtimeConnectedBefore;
        realtimeConnectedBefore = true;
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
                syncAccessControls();
                await syncOfflineListening();
                await Promise.all([fetchMusicData(), loadPlaylists(), loadFriends()]);
                if (isProfileMode) renderProfile();
                if (offlineModeEnabled) await syncOfflineResources();
            } catch (error) {
                console.warn('No se pudo reconciliar el estado tras reconectar.', error);
            }
        }
        if (activeChatFriendId) loadChatMessages(false);
        refreshChatNotifications();
    });
    const refreshFriendsAfterForeground = () => {
        if (!accessToken || offlineOnly || !navigator.onLine) return;
        if (realtimeEnabled && !socket.connected) connectRealtime();
        void loadFriends();
    };
    window.addEventListener('online', refreshFriendsAfterForeground);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshFriendsAfterForeground();
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
        if (!accessToken || !navigator.onLine) return false;
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
            if (!(await syncOfflineListening())) return false;
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
            console.warn('El servidor aún no está disponible para salir del modo offline.', error);
            return false;
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
            <li class="chat-friend-item" data-chat-friend-id="${friend._id}">
                <img src="${friend.profilePhoto || '/img/perrocorasongif.gif'}" alt="" />
                <span class="chat-friend-name">${friend.username}</span>
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
    const bottomBarCover = document.getElementById("bottom-bar-cover");
    const btnShuffle = document.getElementById("btn-shuffle");
    const btnQueue = document.getElementById("btn-queue");
    const queueContainer = document.getElementById("queue-container");
    const queueList = document.getElementById("queue-list");
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
    const btnSaveSecretPhrases = document.getElementById("btn-save-secret-phrases");
    const secretPhrasesStatus = document.getElementById("secret-phrases-status");
    const allSongsPanel = document.getElementById("all-songs-panel");
    const settingsPanel = document.getElementById("settings-panel");
    const adminPanel = document.getElementById("admin-panel");
    const allSongsList = document.getElementById("all-songs-list");
    const allSongsSearch = document.getElementById("all-songs-search");
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
    const btnSettingsYt = document.getElementById("btn-settings-yt-download");
    const btnOpenLocalMp3Folder = document.getElementById("btn-open-local-mp3-folder");
    const inputSettingsYt = document.getElementById("settings-yt-link");
    const inputSettingsYtName = document.getElementById("settings-yt-name");
    const statusSettingsYt = document.getElementById("settings-yt-status");
    const ytDownloadPopup = document.getElementById("yt-download-popup");
    const ytDownloadPopupTitle = document.getElementById("yt-download-popup-title");
    const ytDownloadPopupMessage = document.getElementById("yt-download-popup-message");
    const ytDownloadProgressFill = document.getElementById("yt-download-progress-fill");
    const ytDownloadProgressLabel = document.getElementById("yt-download-progress-label");

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
    const btnPlayEditedSong = document.getElementById("btn-play-edited-song");
    const btnInsertEditLyricTime = document.getElementById("btn-insert-edit-lyric-time");
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

    const editPlaylistPanel = document.getElementById("edit-playlist-panel");
    const editPlDisplayCover = document.getElementById("edit-pl-display-cover");
    const editPlPhoto = document.getElementById("edit-pl-photo");
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
    const authOverlay = document.getElementById("auth-overlay");
    const authTitle = document.getElementById("auth-title");
    const authUsername = document.getElementById("auth-username");
    const authPassword = document.getElementById("auth-password");
    const authSubmit = document.getElementById("auth-btn-submit");
    const authError = document.getElementById("auth-error");
    let currentFriends = [];
    let friendsOwnerId = null;
    const annoyedFriendIds = new Set();
    const friendPresenceUpdatedAt = new Map();
    const friendRealtimeUpdates = new Map();
    let selectedProfileUser = null;
    let listeningTogetherUserId = null;
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
    let localPlaybackActivity = null;
    let lastPlaybackBroadcastAt = 0;
    let lastPlaybackPersistenceAt = 0;
    let publicProfilePlaylists = null;
    let profilePlaylistsRequestToken = 0;
    let profileStatsRequestToken = 0;
    const profileStatsCache = new Map();
    let adminUsersCache = null;
    let adminUsersCacheOwnerId = null;
    let adminUsersRequestToken = 0;
    const timedLyricsStorageKey = 'amgc-timed-lyrics-v1';
    const defaultSecretPhrases = [];
    let timedLyricsByTrack = {};
    let secretPhrases = defaultSecretPhrases;
    let previousSecretPhrase = '';
    let nowPlayingLyricAnimationTimeout = null;
    let nowPlayingLyricPendingIndex = null;

    function getCurrentTrack() {
        if (currentTrackId !== null) {
            return playlist.find(track => String(track._id) === String(currentTrackId)) || null;
        }
        return playlist[currentTrackIndex] || null;
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
        return String(track?._id || track?.path || '');
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

    function getTrackLyrics(track) {
        if (!track) return [];
        const savedLyrics = timedLyricsByTrack[getTrackStorageId(track)];
        if (Array.isArray(savedLyrics)) return savedLyrics;

        if (Array.isArray(track.lyrics)) {
            return track.lyrics.filter(line =>
                line && Number.isFinite(Number(line.time)) && Number(line.time) >= 0 && typeof line.text === 'string'
            ).map(line => ({ time: Number(line.time), text: line.text }));
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
        if (timedLines.length && timedLines.every(Boolean)) return timedLines;
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

    function appendLyricText(target, text, color, interactiveWords = false, flatHighlight = false) {
        let wordIndex = 0;
        const appendWords = (container, segment) => {
            if (!interactiveWords) {
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
                appendWords(highlighted, match[1]);
                target.appendChild(highlighted);
            }
            lastIndex = markedText.lastIndex;
        }
        appendWords(target, text.slice(lastIndex));
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

    function renderSyncedLyrics(track, time, list, lyricsOverride, scrollActiveLyric = true) {
        if (!list) return;
        const lyrics = lyricsOverride || getTrackLyrics(track);
        const renderKey = `${getTrackStorageId(track)}:${JSON.stringify(lyrics)}`;
        if (list.dataset.renderKey !== renderKey) {
            const preservedScrollTop = list === editLyricsPreview && !scrollActiveLyric
                ? list.scrollTop
                : null;
            list.dataset.renderKey = renderKey;
            list.replaceChildren();
            if (!lyrics.length) {
                const empty = document.createElement('li');
                empty.className = 'lyrics-empty-state';
                empty.textContent = 'Aún no hay letra sincronizada para esta canción.';
                list.appendChild(empty);
            } else {
                lyrics.forEach(({ time: lineTime, text }, index) => {
                    const line = document.createElement('li');
                    line.className = 'timed-lyric-line';
                    line.dataset.lyricIndex = String(index);
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
                        isFullLyricsPanel ? '#fff' : (track?.color || '#ff8a00'),
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
        setLyricTextAppearance(nowPlayingLyricNext, '#929292');
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
        const activeKey = `${getTrackStorageId(track)}:${activeIndex}:${activeLyric?.text || ''}`;
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
                if (nextLyric) appendLyricText(nowPlayingLyricIncoming, nextLyric.text, '#929292', false, true);
                setLyricTextAppearance(nowPlayingLyricText, '#929292');
                setLyricTextAppearance(nowPlayingLyricNext, '#fff', track?.color || '#ff8a00', true);
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
            if (activeLyric) appendLyricText(nowPlayingLyricText, activeLyric.text, track?.color || '#ff8a00');
            if (nextLyric) appendLyricText(nowPlayingLyricNext, nextLyric.text, '#929292', false, true);
            setLyricTextAppearance(nowPlayingLyricNext, '#929292');
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

    const syncSecretPhrasesFromUser = (user) => {
        const storedPhrases = user?.settings?.secretPhrases;
        if (storedPhrases !== undefined && (
            !Array.isArray(storedPhrases) || !storedPhrases.every(phrase => typeof phrase === 'string')
        )) {
            console.error('El usuario tiene una lista de frases secretas con formato no válido.');
            secretPhrases = defaultSecretPhrases;
        } else {
            secretPhrases = storedPhrases ?? defaultSecretPhrases;
        }
        if (secretPhrasesInput) secretPhrasesInput.value = secretPhrases.join('\n');
        if (secretText && !previousSecretPhrase && secretPhrases.length > 0) showRandomSecretPhrase();
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
                const creator = isMine ? 'ti' : (playlistItem.ownerName || 'desconocido');
                details.textContent = `${playlistItem.tracks?.length || 0} canciones · Hecho por: ${creator}`;
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
            const requestToken = ++profileStatsRequestToken;
            const profileId = String(user._id);
            const cacheKey = `amgc-profile-stats-${profileId}`;
            const currentProfileId = () => String((selectedProfileUser || getStoredUser())?._id || '');
            const isCurrentProfileRequest = () => (
                isProfileMode
                && requestToken === profileStatsRequestToken
                && currentProfileId() === profileId
            );
            const statElements = [
                'profile-stat-role',
                'profile-stat-hours',
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
        }

        if (profileActivity) {
            const isOwnProfile = !isFriendProfile;
            const track = isOwnProfile && currentTrackId !== null ? getCurrentTrack() : null;
            const recentTrack = hasPlaybackEvidence(user?.lastPlayed) ? user.lastPlayed : null;
            const displayTrack = isOwnProfile ? (track || recentTrack) : recentTrack;
            const currentSourceMatchesTrack = Boolean(track && isCurrentAudioSource(track));
            const isLoadingTrack = Boolean(isOwnProfile && track && !currentSourceMatchesTrack);
            const isListening = isOwnProfile
                ? Boolean(track && !audio.paused)
                : Boolean(user?.isOnline && displayTrack && displayTrack.isPlaying !== false);
            const isOnline = Boolean(user) && (isListening || user.isOnline !== false);
            const isOfflineProfile = isOwnProfile && offlineOnly;
            const currentCover = track ? getSongCover(track) : (displayTrack?.cover || '/img/vinculo.png');
            const activityColor = displayTrack?.color || '#ff8a00';
            const currentProfileTrackId = track?._id ? String(track._id) : null;
            const localPlaybackUpdatedAt = isOwnProfile && currentProfileTrackId
                && localPlaybackActivity?.userId === String(user?._id || '')
                && localPlaybackActivity?.trackId === currentProfileTrackId
                ? localPlaybackActivity.updatedAt
                : null;
            const lastPlayedAt = displayTrack?.updatedAt
                || localPlaybackUpdatedAt
                || recentTrack?.updatedAt
                || user?.lastPlayed?.updatedAt
                || user?.lastActive;
            const lastPlayedLabel = lastPlayedAt ? ` · ${timeAgo(lastPlayedAt)}` : '';
            const listeningLabel = isLoadingTrack
                ? 'Cargando'
                : isListening
                    ? 'Escuchando'
                : displayTrack
                    ? `Estaba escuchando${lastPlayedLabel}`
                    : 'Sin actividad reciente';
            const statusLabel = isOfflineProfile ? 'Modo offline' : isOnline ? 'En línea' : 'Desconectado';
            const statusMeta = !isOfflineProfile && !isOnline && user?.lastActive ? ` · ${timeAgo(user.lastActive)}` : '';
            const friendUpdatedAt = displayTrack?.updatedAt ? Date.parse(displayTrack.updatedAt) : NaN;
            const friendElapsedOffset = !isOwnProfile && isListening && Number.isFinite(friendUpdatedAt)
                ? Math.max(0, (Date.now() - friendUpdatedAt) / 1000)
                : 0;
            const elapsed = isOwnProfile
                ? (currentSourceMatchesTrack && Number.isFinite(audio.currentTime) ? audio.currentTime : 0)
                : Math.min(Number(displayTrack?.duration) || 0, (Number(displayTrack?.currentTime) || 0) + friendElapsedOffset);
            const total = isOwnProfile
                ? (currentSourceMatchesTrack && Number.isFinite(audio.duration) && audio.duration > 0
                    ? audio.duration
                    : Number(track?.duration) || 0)
                : (Number(displayTrack?.duration) || 0);
            const progress = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
            const localTrackIndex = isFriendProfile && displayTrack?.songId
                ? playlist.findIndex(item => String(item._id) === String(displayTrack.songId))
                : currentTrackIndex;
            const canJoin = Boolean(isFriendProfile && displayTrack && localTrackIndex >= 0);

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
                        style="--profile-track-color: ${activityColor}"
                        ${canJoin ? `data-track-index="${localTrackIndex}"` : 'disabled'}
                        aria-label="Escuchar la misma canción"
                    >
                        <img src="${currentCover}" alt="Portada de la canción" class="profile-activity-cover" draggable="false" />
                        <div class="profile-activity-details">
                            <span class="profile-activity-label">${listeningLabel}</span>
                            <strong>${displayTrack?.name || displayTrack?.songName || 'Sin actividad reciente'}</strong>
                            <small>${displayTrack?.artist || 'Sin artista'}</small>
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
                    const trackIndex = Number(joinSongButton.dataset.trackIndex);
                    if (!Number.isInteger(trackIndex) || !playlist[trackIndex]) return;
                    listeningTogetherUserId = isFriendProfile ? String(user._id) : null;
                    updateListeningTogetherStatus();
                    loadAndPlayTrack(trackIndex, isFriendProfile ? 'together' : 'regular');
                    if (isFriendProfile) syncListeningTogether();
                });
            }
        }

        if (profileHistoryCard && profileHistory) {
            const history = Array.isArray(user?.lastPlayedHistory) ? user.lastPlayedHistory : [];
            profileHistoryCard.style.display = isFriendProfile && history.length ? 'block' : 'none';
            profileHistory.innerHTML = history.slice(0, 10).map(item => `
                <li class="profile-history-item">
                    <span>${escapeHtml(item.songName || 'Canción desconocida')}${item.artist ? ` · ${escapeHtml(item.artist)}` : ''}</span>
                    <small>${item.playedAt ? timeAgo(item.playedAt) : ''}</small>
                </li>
            `).join('');
        }

        renderProfileFriendsSection(isFriendProfile ? (user?.friends || []) : currentFriends);

        profilePlaylists?.querySelectorAll('li[data-playlist-id]').forEach((item) => {
            item.addEventListener('click', () => openPlaylistView(item.dataset.playlistId));
        });
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
        if (selectedProfileUser) {
            const playback = selectedProfileUser.lastPlayed;
            const duration = Number(playback?.duration) || 0;
            if (!playback || !playback.songName || duration <= 0) return;
            const isPlaying = Boolean(selectedProfileUser.isOnline && playback.isPlaying !== false);
            const updatedAt = Date.parse(playback.updatedAt);
            const extraElapsed = isPlaying && Number.isFinite(updatedAt)
                ? Math.max(0, (Date.now() - updatedAt) / 1000)
                : 0;
            const elapsed = Math.min(duration, (Number(playback.currentTime) || 0) + extraElapsed);
            const progressFill = profileActivity.querySelector('.profile-activity-progress span');
            const timeLabel = profileActivity.querySelector('[data-profile-time]');
            if (progressFill) progressFill.style.width = `${Math.min(100, (elapsed / duration) * 100)}%`;
            if (timeLabel) timeLabel.textContent = `${formatTrackTime(elapsed)} / ${formatTrackTime(duration)}`;
            return;
        }
        if (String(playbackActivityUserId || '') !== String(getStoredUser()?._id || '')) return;
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

    function formatTrackTime(seconds = 0) {
        const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
        const mins = Math.floor(safeSeconds / 60);
        const secs = safeSeconds % 60;
        return `${mins}:${String(secs).padStart(2, '0')}`;
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
            || String(playbackActivityUserId || '') !== String(user._id)
        ) return;
        const now = Date.now();
        if (!force && now - lastPlaybackPersistenceAt < 5000) return;
        lastPlaybackPersistenceAt = now;
        localStorage.setItem(`amgc-last-playback-${user._id}`, JSON.stringify({
            songId: track._id,
            currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0
        }));
    }

    function rememberLocalPlaybackActivity() {
        const trackId = getCurrentTrack()?._id;
        const userId = getStoredUser()?._id;
        if (!trackId || !userId) return;
        localPlaybackActivity = {
            userId: String(userId),
            trackId: String(trackId),
            updatedAt: new Date().toISOString()
        };
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

    function broadcastPlaybackState(force = false) {
        if (isRestoringInitialPlayback || suppressStartupPlaybackUpdates) return;
        const user = getStoredUser();
        const track = getCurrentTrack();
        if (
            !user?._id
            || !track
            || !socket.connected
            || String(playbackActivityUserId || '') !== String(user._id)
        ) return;
        const now = Date.now();
        if (!force && now - lastPlaybackBroadcastAt < 1000) return;
        lastPlaybackBroadcastAt = now;
        socket.emit('songChanged', {
            userId: user._id,
            excludeUserId: listeningTogetherUserId,
            playback: {
                songId: track._id,
                songName: track.name,
                artist: track.artist || '',
                cover: getSongCover(track) || '',
                color: track.color || '#ff8a00',
                currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
                duration: Number.isFinite(audio.duration) && audio.duration > 0
                    ? audio.duration
                    : Number(track.duration) || 0,
                isPlaying: !audio.paused,
                updatedAt: new Date().toISOString()
            }
        });
    }

    function friendStatusLabel(friend) {
        if (friend.isOnline) {
            const playback = friend.lastPlayed;
            const duration = Number(playback?.duration) || 0;
            if (hasPlaybackEvidence(playback) && playback?.isPlaying !== false && duration > 0) {
                return `En línea · ${formatTrackTime(Number(playback.currentTime) || 0)} / ${formatTrackTime(duration)}`;
            }
            return 'En línea';
        }
        return `${friend.lastActive ? ' · ' + timeAgo(friend.lastActive) : ''}`;
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
                const isPlaying = Boolean(friend.isOnline && hasActivity && playback?.isPlaying !== false);
                const statusText = friend.isOnline
                    ? 'En línea'
                    : `${friend.lastActive ? '  ' + timeAgo(friend.lastActive) : ''}`;
                const lastPlayedAt = playback?.updatedAt || friend.lastActive;
                const lastPlayedLabel = lastPlayedAt ? ` · ${timeAgo(lastPlayedAt)}` : '';
                return `
                    <li class="friend-sidebar-item" data-friend-id="${friend._id}" data-friend-name="${friend.username}">
                        <img class="friend-sidebar-avatar" src="${friend.profilePhoto || '/img/perrocorasongif.gif'}" alt="" loading="lazy" />
                        <div class="friend-sidebar-meta">
                            <span class="friend-sidebar-name">${friend.username}</span>
                            <span class="friend-sidebar-status">
                                <span class="friend-status-dot ${friend.isOnline ? 'online' : ''}"></span>
                                ${statusText}
                            </span>
                        </div>
                        ${hasActivity ? `
                            <div class="friend-sidebar-song" style="--profile-track-color: ${playback.color || '#ff8a00'}">
                                <small>${isPlaying ? 'Escuchando' : `Escuchó por última vez${lastPlayedLabel}`}</small>
                                <strong>${playback.songName}</strong>
                                <small>${playback.artist || ''}</small>
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
                <li class="friend-item" data-friend-id="${friend._id}" data-friend-name="${friend.username}">
                    <button type="button" class="friend-name-button">${friend.username}</button>
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

    function renderProfileFriendsSection(friends = currentFriends) {
        if (profileFriends) {
            profileFriends.innerHTML = friends.length
                ? friends.map(friend => `
                    <li data-friend-id="${friend._id}" data-friend-name="${friend.username}" class="profile-friend-mini-item">
                        <img class="profile-friend-mini-avatar" src="${friend.profilePhoto || '/img/perrocorasongif.gif'}" alt="" loading="lazy" />
                        <span class="friend-status-dot ${friend.isOnline ? 'online' : ''}"></span>
                        <span>${friend.username}</span>
                    </li>
                `).join('')
                : '<li>Todavía no hay amigos.</li>';
            profileFriends.querySelectorAll('li[data-friend-id]').forEach(item => {
                item.addEventListener('click', () => openFriendProfile(item.dataset.friendId));
            });
        }
        if (!profileFriendsGrid) return;
        if (!friends.length) {
            profileFriendsGrid.innerHTML = '<p class="profile-friends-empty">Todavía no hay amigos. Usá el botón "+" para agregar uno.</p>';
            return;
        }
        profileFriendsGrid.innerHTML = friends.map(friend => `
            <div class="profile-friend-card" data-friend-id="${friend._id}" data-friend-name="${friend.username}">
                <div class="profile-friend-avatar">
                    <img src="${friend.profilePhoto || '/img/perrocorasongif.gif'}" alt="" loading="lazy" />
                    <span class="friend-status-dot ${friend.isOnline ? 'online' : ''}"></span>
                </div>
                <span class="profile-friend-name">${friend.username}</span>
                <span class="profile-friend-status">${friendStatusLabel(friend)}</span>
                <button type="button" class="profile-friend-chat-btn">Chatear</button>
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
        });
    }

    function getNewestPlayback(incoming, current) {
        if (!incoming) return current;
        if (!current) return incoming;
        const incomingTime = Date.parse(incoming.updatedAt);
        const currentTime = Date.parse(current.updatedAt);
        if (Number.isFinite(currentTime) && (!Number.isFinite(incomingTime) || currentTime > incomingTime)) {
            return current;
        }
        return incoming;
    }

    function rememberFriendRealtimeUpdate(userId, update = {}) {
        const normalizedId = String(userId || '');
        if (!normalizedId) return;
        const previous = friendRealtimeUpdates.get(normalizedId);
        friendRealtimeUpdates.set(normalizedId, {
            receivedAt: Date.now(),
            updatedAt: update.updatedAt || update.lastPlayed?.updatedAt || previous?.updatedAt || null,
            ...(typeof update.isOnline === 'boolean'
                ? { isOnline: update.isOnline }
                : previous && { isOnline: previous.isOnline }),
            ...(update.lastPlayed
                ? { lastPlayed: getNewestPlayback(update.lastPlayed, previous?.lastPlayed) }
                : previous?.lastPlayed && { lastPlayed: previous.lastPlayed })
        });
    }

    function scheduleFriendsOfflineSave() {
        const user = getStoredUser();
        if (!offlineModeEnabled || !user?._id) return;
        if (friendCacheSaveTimer) clearTimeout(friendCacheSaveTimer);
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
        if (friendsOwnerId !== requestedOwnerId) {
            currentFriends = [];
            friendPresenceUpdatedAt.clear();
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
            if (String(getStoredUser()?._id || '') !== requestedOwnerId) return;
            friendPresenceUpdatedAt.clear();
            currentFriends = await hydrateOfflineFriends(cachedFriends?.friends || []);
            renderFriendsSidebar();
            renderFriendsPanelList();
            if (isProfileMode) renderProfile();
            return;
        }
        const requestStartedAt = Date.now();
        try {
            const refreshedFriends = await fetchJsonWithRetry(`${API_URL}/users/friends/${user._id}`);
            if (String(getStoredUser()?._id || '') !== requestedOwnerId) return;
            currentFriends = refreshedFriends.map(friend => {
                const previousFriend = currentFriends.find(item => String(item._id) === String(friend._id));
                const friendId = String(friend._id);
                const hasRealtimePlayback = friendPresenceUpdatedAt.has(friendId);
                const presenceChangedAfterRequest = (friendPresenceUpdatedAt.get(friendId) || 0) > requestStartedAt;
                const realtimeUpdate = friendRealtimeUpdates.get(friendId);
                const realtimePlaybackIsNewer = realtimeUpdate?.lastPlayed
                    && Date.parse(realtimeUpdate.lastPlayed.updatedAt) > Date.parse(friend.lastPlayed?.updatedAt);
                const realtimePresenceIsNewer = realtimeUpdate?.updatedAt
                    && Date.parse(realtimeUpdate.updatedAt) > Date.parse(friend.lastActive);
                const hasFreshRealtimeUpdate = (realtimeUpdate?.receivedAt || 0) > requestStartedAt
                    || realtimePlaybackIsNewer
                    || realtimePresenceIsNewer;
                return {
                    ...friend,
                    ...(hasFreshRealtimeUpdate && {
                        ...(typeof realtimeUpdate.isOnline === 'boolean' && { isOnline: realtimeUpdate.isOnline }),
                        ...(realtimeUpdate.updatedAt && { lastActive: realtimeUpdate.updatedAt }),
                        ...(realtimeUpdate.lastPlayed && {
                            lastPlayed: getNewestPlayback(friend.lastPlayed, realtimeUpdate.lastPlayed)
                        })
                    }),
                    ...(previousFriend && {
                        ...(hasRealtimePlayback && {
                            lastPlayed: getNewestPlayback(friend.lastPlayed, previousFriend.lastPlayed)
                        }),
                        ...(presenceChangedAfterRequest && {
                            isOnline: previousFriend.isOnline,
                            ...(previousFriend.lastActive && { lastActive: previousFriend.lastActive })
                        })
                    })
                };
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
            if (String(getStoredUser()?._id || '') !== requestedOwnerId) return;
            if (!offlineModeEnabled) return;
            let cachedFriends;
            try {
                cachedFriends = await getOfflineFriends(user._id);
            } catch (cacheError) {
                console.error('No se pudo leer la actividad offline de tus amigos.', cacheError);
                updateOfflineCacheStatus(`No se pudo leer la actividad guardada: ${cacheError.message}`);
                return;
            }
            if (String(getStoredUser()?._id || '') !== requestedOwnerId) return;
            if (!cachedFriends) return;
            offlineOnly = true;
            syncOfflineStatusIndicators();
            socket.disconnect();
            startOfflineRecoveryTimer();
            const cachedUser = getCachedOfflineUser();
            if (cachedUser) setStoredUser(cachedUser);
            currentFriends = await hydrateOfflineFriends(cachedFriends.friends || []);
        }
        if (String(getStoredUser()?._id || '') !== requestedOwnerId) return;
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
                    ? `<img class="chat-message-avatar" src="${isSelf ? (user.profilePhoto || '/img/perrocorasongif.gif') : (friend?.profilePhoto || '/img/perrocorasongif.gif')}" alt="" />`
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

    async function updateUserStatus(isOnline) {
        if (isRestoringInitialPlayback || suppressStartupPlaybackUpdates) return;
        const user = getStoredUser();
        if (!user) return;
        const track = getCurrentTrack();
        const payload = { userId: user._id, isOnline };
        if (
            track
            && isOnline
            && String(playbackActivityUserId || '') === String(user._id)
        ) {
            payload.lastPlayed = {
                songId: track._id,
                songName: track.name,
                artist: track.artist || '',
                cover: getSongCover(track) || '',
                color: track.color || '#ff8a00',
                currentTime: sharedPlaybackTime,
                duration: sharedPlaybackDuration || Number(track.duration) || 0,
                isPlaying: sharedPlaybackPlaying,
                countListeningDelta: !suppressNextListeningDelta
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
        } catch (e) {
            console.warn(e);
        }
    }

    function startRealtime() {
        stopRealtime();
        const user = getStoredUser();
        if (user?._id) connectRealtime();
        socket.off('songChanged').on('songChanged', ({ userId, playback }) => {
            rememberFriendRealtimeUpdate(userId, { isOnline: true, lastPlayed: playback });
            const friend = currentFriends.find(item => String(item._id) === String(userId));
            if (!friend || !playback) return;
            friend.lastPlayed = getNewestPlayback(playback, friend.lastPlayed);
            friend.isOnline = true;
            friendPresenceUpdatedAt.set(String(userId), Date.now());
            scheduleFriendsOfflineSave();
            renderFriendsSidebar();
            renderFriendsPanelList();
            updateFriendsSidebarPlayback();
            if (selectedProfileUser && String(selectedProfileUser._id) === String(userId)) {
                selectedProfileUser = { ...selectedProfileUser, lastPlayed: friend.lastPlayed, isOnline: true };
                renderProfile();
            }
        });
        socket.off('playbackStatusChanged').on('playbackStatusChanged', ({ userId, playback } = {}) => {
            rememberFriendRealtimeUpdate(userId, { isOnline: true, lastPlayed: playback });
            const friend = currentFriends.find(item => String(item._id) === String(userId));
            if (!friend || !playback) return;
            friend.lastPlayed = getNewestPlayback(playback, friend.lastPlayed);
            friend.isOnline = true;
            friendPresenceUpdatedAt.set(String(userId), Date.now());
            scheduleFriendsOfflineSave();
            renderFriendsSidebar();
            renderFriendsPanelList();
            if (selectedProfileUser && String(selectedProfileUser._id) === String(userId)) {
                selectedProfileUser = { ...selectedProfileUser, lastPlayed: friend.lastPlayed };
                renderProfile();
            }
        });
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
        socket.off('presenceChanged').on('presenceChanged', ({ userId, isOnline, lastPlayed, updatedAt } = {}) => {
            rememberFriendRealtimeUpdate(userId, { isOnline, lastPlayed, updatedAt });
            const friend = currentFriends.find(item => String(item._id) === String(userId));
            if (!friend) return;
            friendPresenceUpdatedAt.set(String(userId), Date.now());
            friend.isOnline = Boolean(isOnline);
            if (updatedAt) friend.lastActive = updatedAt;
            if (lastPlayed) friend.lastPlayed = getNewestPlayback(lastPlayed, friend.lastPlayed);
            scheduleFriendsOfflineSave();
            renderFriendsSidebar();
            renderFriendsPanelList();
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
                renderProfile();
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
        socket.disconnect();
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
        friendPresenceUpdatedAt.clear();
        friendRealtimeUpdates.clear();
        friendsOwnerId = null;
        renderFriendsSidebar();
        renderFriendsPanelList();
    }

    function updateFriendsSidebarPlayback() {
        updateProfileActivityProgress();
        syncListeningTogether();
        updateListeningTogetherStatus();
        friendsSidebarList?.querySelectorAll('.friend-sidebar-item[data-friend-id]').forEach(item => {
            const friend = currentFriends.find(entry => String(entry._id) === String(item.dataset.friendId));
            const playback = friend?.lastPlayed;
            const duration = Number(playback?.duration) || 0;
            if (!friend || !playback) return;

            const isPlaying = Boolean(friend.isOnline && playback.songName && playback.isPlaying !== false);
            const savedAt = Date.parse(playback.updatedAt);
            const extraElapsed = isPlaying && Number.isFinite(savedAt)
                ? Math.max(0, (Date.now() - savedAt) / 1000)
                : 0;
            const elapsed = Math.min(duration, (Number(playback.currentTime) || 0) + extraElapsed);
            const progress = Math.min(100, (elapsed / duration) * 100);
            const progressFill = item.querySelector('[data-friend-progress]');
            const timeLabel = item.querySelector('[data-friend-playback-time]');
            if (progressFill) progressFill.style.width = `${progress}%`;
            if (timeLabel && isPlaying) timeLabel.textContent = `${formatTrackTime(elapsed)} / ${formatTrackTime(duration)}`;
        });
    }

    function syncListeningTogether() {
        if (!listeningTogetherUserId) return;
        const friend = currentFriends.find(item => String(item._id) === String(listeningTogetherUserId));
        if (!friend?.lastPlayed?.songId) return;
        const playback = friend.lastPlayed;

        const remoteIndex = playlist.findIndex(item => String(item._id) === String(playback.songId));
        if (remoteIndex < 0) return;

        const remoteTime = Math.max(0, Number(playback.currentTime) || 0);
        const remoteUpdatedAt = Date.parse(playback.updatedAt);
        const playbackAge = Number.isFinite(remoteUpdatedAt) ? Math.max(0, (Date.now() - remoteUpdatedAt) / 1000) : Infinity;
        if (!friend.isOnline || (playback.isPlaying !== false && playbackAge > 3)) {
            if (currentTrackSource === 'together' && !audio.paused) audio.pause();
            return;
        }
        const extraTime = playback.isPlaying !== false && Number.isFinite(remoteUpdatedAt)
            ? playbackAge
            : 0;
        const remoteDuration = Number(playback.duration) || 0;
        const durationLimit = remoteDuration > 0
            ? remoteDuration
            : currentTrackIndex === remoteIndex && Number.isFinite(audio.duration) && audio.duration > 0
                ? audio.duration
                : Number.MAX_SAFE_INTEGER;
        const targetTime = Math.min(
            durationLimit,
            remoteTime + extraTime
        );
        const currentTrackChanged = currentTrackIndex !== remoteIndex || currentTrackSource !== 'together';

        if (currentTrackChanged) {
            const seekToRemoteTime = () => {
                if (currentTrackIndex === remoteIndex && Number.isFinite(targetTime) && audio.readyState >= 1) {
                    audio.currentTime = targetTime;
                }
            };
            audio.addEventListener('loadedmetadata', seekToRemoteTime, { once: true });
            loadAndPlayTrack(remoteIndex, 'together', playback.isPlaying !== false);
            if (audio.readyState >= 1) {
                audio.removeEventListener('loadedmetadata', seekToRemoteTime);
                seekToRemoteTime();
            }
            return;
        }

        const expectedSrc = playlist[remoteIndex]?.path;
        if (audio.src !== expectedSrc && !audio.src.endsWith(expectedSrc || '\0')) return;
        if (Math.abs(audio.currentTime - targetTime) > 0.75) {
            audio.currentTime = targetTime;
        }
        if (playback.isPlaying === false && !audio.paused) audio.pause();
        if (playback.isPlaying !== false && audio.paused) audio.play().catch(() => {});
    }

    function updateListeningTogetherStatus() {
        if (!listeningTogetherStatus) return;
        const friend = listeningTogetherUserId
            ? currentFriends.find(item => String(item._id) === String(listeningTogetherUserId))
            : null;
        listeningTogetherStatus.hidden = !friend;
        if (friend) {
            const label = listeningTogetherStatus.querySelector('span');
            if (label) label.textContent = `ESCUCHANDO JUNTO A: ${friend.username}`;
        }
    }

    if (btnExitListeningTogether) {
        btnExitListeningTogether.addEventListener('click', () => {
            listeningTogetherUserId = null;
            if (currentTrackSource === 'together' && getCurrentTrack()) {
                currentTrackSource = 'regular';
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
                <li class="share-playlist-item" data-friend-id="${friend._id}">
                    ${friend.profilePhoto ? `<img src="${friend.profilePhoto}" alt="" class="share-friend-avatar" />` : '<span class="share-friend-avatar-placeholder">?</span>'}
                    <span>${friend.username}</span>
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
                <li class="share-playlist-item manage-member-item" data-member-id="${member._id}">
                    ${member.profilePhoto ? `<img src="${member.profilePhoto}" alt="" class="share-friend-avatar" />` : '<span class="share-friend-avatar-placeholder">?</span>'}
                    <span>${member.username || 'Usuario'}</span>
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
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            playlist = [];
            currentTrackIndex = 0;
            currentTrackId = null;
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
            if (!(await refreshOfflineSession())) startOfflineRecoveryTimer();
        } else {
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
                    <li class="admin-user-row" data-user-id="${user._id}">
                        <div class="admin-user-main">
                            <span class="admin-user-name">${user.username}</span>
                            <span class="admin-user-role">${user.isAdmin ? 'Administrador' : 'Usuario'}</span>
                            <span class="admin-user-permissions">${permissions.length ? permissions.join(', ') : 'Sin permisos'}</span>
                        </div>
                        <div class="admin-user-controls">
                            <div class="admin-user-actions-inline">
                                <button class="admin-edit-user" data-user-id="${user._id}" type="button" aria-label="Editar usuario" title="Editar usuario">
                                    <img src="/img/edit.png" alt="Editar usuario" draggable="false" />
                                </button>
                                <button class="admin-delete-user" data-user-id="${user._id}" type="button" aria-label="Eliminar usuario" title="Eliminar usuario">
                                    <img src="/img/cancel.png" alt="Eliminar usuario" draggable="false" />
                                </button>
                            </div>
                            <div class="admin-user-bottom">
                                <div class="admin-user-permissions-grid">
                                    ${permissionOptions.map((option) => `
                                        <label class="permission-check">
                                            <input type="checkbox" data-user-id="${user._id}" data-permission="${option.value}" ${permissions.includes(option.value) ? 'checked' : ''} />
                                            <span>${option.label}</span>
                                        </label>
                                    `).join('')}
                                    <label class="admin-role-toggle">
                                        <input type="checkbox" data-user-id="${user._id}" data-role-admin ${user.isAdmin ? 'checked' : ''} />
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
    if (volumeSlider) volumeSlider.max = String(maxVolume);
    let customQueue = []; 
    let activeQueueTracks = [];
    let unplayedIndices = [];
    let playbackHistory = [];
    
    let isLyricsMode = false;
    let isAllSongsMode = false;
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
    let songSaveInProgress = false;
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
    let playlistRealtimeRefresh = Promise.resolve();
    const pendingPlaylistTrackChanges = new Set();
    const pendingPlaylistOrderSaves = new Map();
    const pendingSongDeletes = new Set();
    let statusHeartbeatTimer = null;
    let playlistIdPendingShare = null;

    function getSequentialQueueIndices() {
        const anchorTrackId = generalQueueAnchorTrackId || getCurrentTrack()?._id;
        const currentPosition = activeQueueTracks.findIndex(track => (
            String(track._id) === String(anchorTrackId)
        ));
        if (currentPosition === -1) return [];
        return activeQueueTracks
            .slice(currentPosition + 1)
            .map(track => playlist.indexOf(track))
            .filter(index => index !== -1);
    }

    function buildShuffleQueue() {
        const anchorTrackId = generalQueueAnchorTrackId || getCurrentTrack()?._id;
        const indices = activeQueueTracks
            .map(track => playlist.indexOf(track))
            .filter(index => index !== -1 && String(playlist[index]?._id) !== String(anchorTrackId));

        for (let index = indices.length - 1; index > 0; index -= 1) {
            const randomIndex = Math.floor(Math.random() * (index + 1));
            [indices[index], indices[randomIndex]] = [indices[randomIndex], indices[index]];
        }

        return indices;
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
            if (offlineOnly) return pl.localPhoto || '';
            return pl.photo;
        }
        return '';
    }

    function getSongCover(track) {
        const cover = track?.cover || '';
        if (!cover || cover === '/img/vinculo.png') return '';
        if (offlineOnly) return track.localCover || '';
        return cover;
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
        offlineDownloadPopup.classList.toggle('concurrent', ytDownloadPopup?.classList.contains('active') || false);
        offlineDownloadPopup.classList.add('active');
        if (offlineDownloadPopupTimer) clearTimeout(offlineDownloadPopupTimer);
        if (isComplete || isError) {
            offlineDownloadPopupTimer = setTimeout(() => {
                offlineDownloadPopup.classList.remove('active');
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
        return currentSave.finally(() => {
            if (pendingPlaylistOrderSaves.get(playlistId) === currentSave) {
                pendingPlaylistOrderSaves.delete(playlistId);
            }
        });
    }

    async function loadPlaylists() {
        try {
            const user = getStoredUser();
            if (user?._id && (offlineOnly || !navigator.onLine)) {
                const cachedPlaylists = await getOfflinePlaylists(user._id);
                userPlaylists = cachedPlaylists?.playlists || [];
                await hydrateOfflinePlaylistCovers(userPlaylists);
                renderSidebarPlaylists();
                renderProfile();
                return;
            }
            if (user?._id) {
                const refreshedUser = await fetchJsonWithRetry(`${API_URL}/auth/me`, {}, 2);
                setStoredUser({ ...user, ...refreshedUser });
                saveCachedOfflineUser({ ...user, ...refreshedUser });
                syncAccessControls();
            }
            syncAccessControls();
            const query = user?._id ? `?userId=${encodeURIComponent(user._id)}` : '';
            userPlaylists = await fetchJsonWithRetry(`${API_URL}/playlists${query}`);
            if (user?._id && offlineModeEnabled) {
                try {
                    await saveOfflinePlaylists(user._id, userPlaylists);
                } catch (error) {
                    console.error('No se pudieron guardar las playlists offline.', error);
                    updateOfflineCacheStatus(`No se pudieron guardar las playlists: ${error.message}`);
                }
            }
            renderSidebarPlaylists();
            renderProfile();
            syncOfflineResources();
        } catch (e) {
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
            if (!cachedPlaylists) return;
            offlineOnly = true;
            syncOfflineStatusIndicators();
            socket.disconnect();
            startOfflineRecoveryTimer();
            setStoredUser(cachedUser);
            userPlaylists = cachedPlaylists.playlists || [];
            await hydrateOfflinePlaylistCovers(userPlaylists);
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

    let ytDownloadProgressTimer = null;
    let ytLongWaitTimer = null;

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

    function updateYtDownloadPopup({ title = 'Descargando canción', message = 'Preparando audio...', percent = 0, isError = false, visible = true }) {
        if (!ytDownloadPopup || !ytDownloadPopupTitle || !ytDownloadPopupMessage || !ytDownloadProgressFill || !ytDownloadProgressLabel) return;

        ytDownloadPopupTitle.textContent = title;
        ytDownloadPopupMessage.textContent = message;
        ytDownloadProgressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
        ytDownloadProgressLabel.textContent = `${Math.round(percent)}%`;
        ytDownloadPopup.classList.toggle('error', isError);
        ytDownloadPopup.classList.toggle('active', visible);
        offlineDownloadPopup?.classList.toggle(
            'concurrent',
            visible && offlineDownloadPopup.classList.contains('active')
        );
    }

    function startYtDownloadProgress(title = 'Descargando canción') {
        if (ytDownloadProgressTimer) clearInterval(ytDownloadProgressTimer);
        if (ytLongWaitTimer) clearTimeout(ytLongWaitTimer);

        let current = 8;
        updateYtDownloadPopup({ title, message: 'Conectando con YouTube...', percent: current, visible: true, isError: false });

        ytDownloadProgressTimer = setInterval(() => {
            current = Math.min(current + Math.random() * 8 + 3, 90);
            const progressText = current < 25
                ? 'Solicitando audio a YouTube...'
                : current < 55
                    ? 'Descargando audio...'
                    : current < 85
                        ? 'Convirtiendo a MP3...'
                        : 'Guardando el MP3 localmente...';
            updateYtDownloadPopup({ title, message: progressText, percent: current, visible: true, isError: false });
        }, 800);

        ytLongWaitTimer = setTimeout(() => {
            showYoutubeLinkStatus('La descarga sigue en curso. Esto puede tardar unos segundos más...', false);
        }, 15000);
    }

    function stopYtDownloadProgress({ success = false, message = 'Descarga finalizada', error = false } = {}) {
        if (ytDownloadProgressTimer) {
            clearInterval(ytDownloadProgressTimer);
            ytDownloadProgressTimer = null;
        }
        if (ytLongWaitTimer) {
            clearTimeout(ytLongWaitTimer);
            ytLongWaitTimer = null;
        }

        if (!ytDownloadPopup) return;
        if (success) {
            updateYtDownloadPopup({ title: 'Canción añadida', message, percent: 100, visible: true, isError: false });
            setTimeout(() => updateYtDownloadPopup({ visible: false }), 1200);
        } else {
            updateYtDownloadPopup({ title: error ? 'No se pudo descargar' : 'Descarga detenida', message, percent: 100, visible: true, isError: true });
            setTimeout(() => updateYtDownloadPopup({ visible: false }), 2500);
        }
    }

    let musicDataRequestSequence = 0;
    async function fetchMusicData() {
        const requestSequence = ++musicDataRequestSequence;
        const userAtRequestStart = getStoredUser();
        const ownsCurrentPlayback = Boolean(
            userAtRequestStart?._id
            && String(playbackActivityUserId || '') === String(userAtRequestStart._id)
        );
        const previousTrackId = ownsCurrentPlayback ? getCurrentTrack()?._id : null;
        const previousPlaybackTime = ownsCurrentPlayback && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        const wasPlayingBeforeRefresh = ownsCurrentPlayback && !audio.paused && !audio.ended;
        if (inlineSpinner) inlineSpinner.style.display = 'block';
        if (perroGif) perroGif.style.display = 'none';

        try {
            if (offlineOnly || !navigator.onLine) {
                const cachedLibrary = userAtRequestStart?._id
                    ? await getOfflineLibrary(userAtRequestStart._id)
                    : null;
                if (requestSequence !== musicDataRequestSequence) return;
                playlist = cachedLibrary?.songs || [];
                await hydrateOfflineSongCovers(playlist);
                if (!playlist.length) updateOfflineCacheStatus('No hay canciones guardadas en este dispositivo.');
            } else {
                const data = await fetchJsonWithRetry(`${API_URL}/songs`);
                if (requestSequence !== musicDataRequestSequence) return;
                playlist = data.songs || [];
                if (userAtRequestStart?._id && offlineModeEnabled) {
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
                await hydrateOfflineSongCovers(playlist);
                hideAuthOverlay();
                updateOfflineCacheStatus('Sin conexión: reproduciendo el catálogo guardado en este dispositivo.');
            } else {
                playlist = [];
            }
        } finally {
            if (inlineSpinner) inlineSpinner.style.display = 'none';
            if (perroGif) perroGif.style.display = 'block';
        }

        if (requestSequence !== musicDataRequestSequence) return;
        const selectedTrackId = currentTrackId || previousTrackId;
        if (selectedTrackId) {
            const refreshedTrackIndex = playlist.findIndex(track => String(track._id) === String(selectedTrackId));
            currentTrackIndex = refreshedTrackIndex >= 0
                ? refreshedTrackIndex
                : Math.min(currentTrackIndex, Math.max(0, playlist.length - 1));
            currentTrackId = playlist[currentTrackIndex]?._id ?? null;
        } else {
            currentTrackIndex = Math.min(currentTrackIndex, Math.max(0, playlist.length - 1));
        }
        
        activeQueueTracks = [...playlist];
        resetPlaybackHistory();
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
        renderAllSongs();
        if (playlist.length > 0 && !audio.src && userAtRequestStart?._id) {
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
                    const cachedAudioUrl = await getOfflineObjectUrl(`song:${cachedTrack._id}:audio`);
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
    audio.volume = currentVolume;
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
            if (artworkUrl.protocol !== 'https:' || artworkUrl.origin !== apiOrigin
                || artworkUrl.username || artworkUrl.password) return null;
            return artworkUrl.href;
        } catch (error) {
            console.warn('La URL de portada para Discord no es válida.', error);
            return null;
        }
    };
    const updateDiscordPresence = () => {
        if (!desktopSetDiscordPresence) return;
        const track = getCurrentTrack();
        if (!track) return;
        const discordImageText = getStoredUser()?.settings?.discordImageText;
        const statusPromise = desktopSetDiscordPresence({
            songName: track.name || 'Canción desconocida',
            artist: track.artist || 'Artista desconocido',
            currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
            duration: Number.isFinite(audio.duration) ? audio.duration : Number(track.duration) || 0,
            isPlaying: !audio.paused && !audio.ended,
            largeImageUrl: resolveDiscordArtworkUrl(track),
            discordImageText: typeof discordImageText === 'string'
                ? discordImageText
                : 'amgc'
        });
        void statusPromise.then(status => {
            if (status && (!status.configured || !status.connected || !status.published)) {
                console.warn('Discord Rich Presence no está activa:', status);
            }
        }).catch(error => {
            console.warn('No se pudo actualizar Discord Rich Presence.', error);
        });
    };
    if (editLyricsPreview) {
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
                const response = await apiFetch(`${API_URL}/users/settings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: user._id,
                        settings: { ...user.settings, secretPhrases: phrases }
                    })
                });
                const result = await response.json().catch(() => null);
                if (!response.ok) throw new Error(result?.error || 'No se pudieron guardar las frases secretas.');
                setStoredUser({ ...user, settings: result });
                secretPhrases = phrases;
                if (!phrases.length && secretText) secretText.hidden = true;
                setEditorStatus(secretPhrasesStatus, phrases.length ? `${phrases.length} frases guardadas.` : 'Lista guardada vacía.');
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

    function addTrackToQueue(track, shouldRender = true) {
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
        customQueue.push(queuedTrack);
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
            if (addTrackToQueue(getCurrentTrack(), false)) renderQueue();
        });
        
        bottomBarActionMenu.querySelector('.action-add-pl').addEventListener('click', (e) => {
            e.stopPropagation();
            bottomBarActionMenu.classList.remove('show');
            openAddToPlaylistModal(currentTrackIndex);
        });
    }

    const renderAllSongs = createSongListRenderer({
        listElement: allSongsList,
        searchInput: allSongsSearch,
        getSongs: () => playlist,
        getSongCover,
        createImageMarkup,
        createSongContextMenuHtml,
        setupSongMenuListeners,
        setupQueueAddSwipe,
        openEditSongPanel
    });

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

    function openEditSongPanel(index = null) {
        if (!canCurrentUser('edit_songs')) {
            showToast('No tienes permiso para editar canciones.', true);
            return;
        }
        lyricsCancelPromptIndex = 0;
        btnCancelEditedSong.textContent = cancelEditedSongLabel;
        stopEditPreviewAudio();
        editingTrackIndex = index;
        editingTrackId = index !== null && playlist[index]?._id ? String(playlist[index]._id) : null;
        resetSongDeleteConfirmation();
        if (btnDeleteSong) btnDeleteSong.disabled = false;
        
        if (index !== null && playlist[index]) {
            const track = playlist[index];
            if (getSongCover(track)) {
                editSongDisplayCover.src = getSongCover(track);
                editSongDisplayCover.style.display = 'block';
            } else {
                editSongDisplayCover.removeAttribute('src');
                editSongDisplayCover.style.display = 'none';
            }
            editInputName.value = track.name || '';
            editInputArtist.value = track.artist || '';
            editInputColor.value = track.color || "#ffffff";
            editInputLyrics.value = formatTrackLyricsForEditor(track);
            if (editSongMetadata) editSongMetadata.hidden = false;
            if (editSongAddedBy) editSongAddedBy.textContent = `Añadida por: ${track.addedBy?.username || 'Desconocido'}`;
            if (editSongEditedBy) editSongEditedBy.textContent = `Editada por: ${track.editedBy?.username || '—'}`;
            if (editSongAddedAt) editSongAddedAt.textContent = `Fecha: ${track.addedAt ? new Date(track.addedAt).toLocaleDateString('es-CL', { timeZone: 'America/Santiago' }) : '—'}`;
            btnSaveEditedSong.textContent = "Guardar Cambios";
            if (btnDeleteSong) btnDeleteSong.style.display = canCurrentUser('delete_songs') ? 'inline-block' : 'none';
        } else {
            editingTrackIndex = null;
            editSongDisplayCover.removeAttribute('src');
            editSongDisplayCover.style.display = 'none';
            editInputName.value = '';
            editInputArtist.value = '';
            editInputColor.value = "#ffffff";
            editInputLyrics.value = '';
            if (editSongMetadata) editSongMetadata.hidden = true;
            btnSaveEditedSong.textContent = "Añadir Canción";
            if (btnDeleteSong) btnDeleteSong.style.display = 'none';
        }
        originalEditLyrics = editInputLyrics.value;
        setEditorStatus(editLyricsStatus, '');

        editInputMp3.value = "";
        if (editInputFileName) editInputFileName.value = "";
        editSongPhoto.value = "";
        if (editInputYt) editInputYt.value = "";

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
    if (editInputMp3) {
        editInputMp3.addEventListener('change', () => {
            stopEditPreviewAudio();
            updateEditLyricsPreview();
        });
    }

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

    if (songImageEditWrapper && editSongPhoto) {
        songImageEditWrapper.addEventListener('click', () => {
            editSongPhoto.click();
        });

        editSongPhoto.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    editSongDisplayCover.src = ev.target.result;
                    editSongDisplayCover.style.display = 'block';
                };
                reader.readAsDataURL(e.target.files[0]);
            }
        });
    }

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
        formData.append('color', editInputColor.value);
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
        if (ytLinkVal) {
            if (!isValidYoutubeLink(ytLinkVal)) {
                showYoutubeLinkStatus("El enlace de YouTube no es válido.", true);
                songSaveInProgress = false;
                btnSaveEditedSong.textContent = editingTrackId !== null ? "Guardar Cambios" : "Añadir Canción";
                btnSaveEditedSong.disabled = false;
                if (btnDeleteSong) btnDeleteSong.disabled = false;
                return;
            }
            startYtDownloadProgress(editingTrackId !== null ? 'Actualizando canción' : 'Añadiendo canción');
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

        try {
            if (ytLinkVal && desktopYoutubeDownloader) {
                showYoutubeLinkStatus('Descargando el audio desde este equipo...', false);
                const downloadedAudio = await desktopYoutubeDownloader(ytLinkVal);
                const requestedFileName = editInputFileName?.value.trim();
                const audioFileName = requestedFileName || `${downloadedAudio.title}.mp3`;
                const audioFile = new File([downloadedAudio.bytes], audioFileName, { type: 'audio/mpeg' });
                formData.append('mp3', audioFile);
                showYoutubeLinkStatus('Audio descargado. Subiéndolo a tu biblioteca...', false);
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
            if (!socket.connected) await fetchMusicData();

            if (ytLinkVal) {
                stopYtDownloadProgress({ success: true, message: 'MP3 convertido, subido a Drive y guardado en MongoDB' });
            }
            
            isEditSongMode = false;
            editingTrackIndex = null;
            editingTrackId = null;
            isAllSongsMode = true;
            updateBackgroundAndViews();
            
        } catch (e) {
            console.error(e);
            const message = e?.message || 'Error al guardar la canción.';
            const youtubeErrorMessage = 'El enlace de YouTube no es válido o fue rechazado por YouTube.';
            const isYoutubeFailure = !!ytLinkVal;
            const visibleMessage = isYoutubeFailure
                ? (message.includes('YouTube') || /youtube/i.test(message) ? message : youtubeErrorMessage)
                : message;

            if (isYoutubeFailure) {
                stopYtDownloadProgress({ success: false, message, error: true });
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
            activePlaylistId
        };
        editingPlaylistId = id;
        if (btnDeletePl) {
            btnDeletePl.dataset.confirmDelete = 'false';
            btnDeletePl.textContent = 'Eliminar Playlist';
        }
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
            }
        } else {
            editPlName.value = '';
            editPlDesc.value = '';
            editPlDisplayCover.removeAttribute('src');
            editPlDisplayCover.style.display = 'none';
            editPlPhoto.value = ''; 
        }
        
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
        updateBackgroundAndViews();
    }

    btnCreatePlaylist.addEventListener('click', () => {
        openEditPlaylistPanel();
        closeSidebar();
    });

    btnEditPlaylist.addEventListener('click', () => {
        openEditPlaylistPanel(activePlaylistId);
    });

    plImageEditWrapper.addEventListener('click', () => {
        editPlPhoto.click();
    });

    editPlPhoto.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                editPlDisplayCover.src = ev.target.result;
                editPlDisplayCover.style.display = 'block';
            };
            reader.readAsDataURL(e.target.files[0]);
        }
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
                <span>${pl.name}</span>
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
                pl.tracks.push({
                    ...song,
                    addedBy: { _id: currentUser._id, username: currentUser.username },
                    addedAt: optimisticAddedAt
                });
                pl.duration = previousDuration + Math.max(0, Number(song.duration) || 0);
                pl.updatedAt = optimisticAddedAt;
                hideAllModals();
                if (activePlaylistId === pl.id) openPlaylistView(pl.id);
                showToast(`Añadiendo “${song?.name || 'la canción'}” a “${pl.name}”…`);
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
                        if (offlineModeEnabled) {
                            void saveOfflinePlaylists(currentUser._id, userPlaylists).catch(error => {
                                console.error('No se pudo actualizar la caché offline de playlists.', error);
                            });
                        }
                        if (activePlaylistId === pl.id) openPlaylistView(pl.id);
                        showToast(`“${song?.name || 'La canción'}” se añadió a “${pl.name}”.`);
                    })
                    .catch(error => {
                        pl.tracks = pl.tracks.filter(track => String(track._id) !== String(songId));
                        pl.duration = previousDuration;
                        if (activePlaylistId === pl.id) openPlaylistView(pl.id);
                        showToast(error.message || 'No se pudo añadir la canción.', true);
                    });
            });
            addToPlList.appendChild(li);
        });
        
        hideAllModals();
        modalOverlay.classList.add('active');
        addToPlModal.classList.add('active');
    }

    btnCloseAddPl.addEventListener('click', hideAllModals);

    function openPlaylistView(id) {
        const pl = [...userPlaylists, ...(publicProfilePlaylists || [])].find(p => p.id === id);
        if (!pl) return;
        const currentUser = getStoredUser();
        const isOwner = Boolean(currentUser?._id && String(pl.ownerId) === String(currentUser._id));
        const isSharedPlaylist = !isOwner && (pl.sharedWith || []).some(user => String(user?._id || user) === String(currentUser?._id));
        const isSavedPlaylist = !isOwner && (currentUser?.savedPlaylists || []).some(savedId => String(savedId) === String(pl.id));
        const canEditPlaylist = isOwner || isSharedPlaylist;
        const canDeletePlaylistTracks = canEditPlaylist;
        
        const coverUrl = getPlaylistCover(pl);

        activePlaylistId = id;
        if (btnEditPlaylist) {
            btnEditPlaylist.hidden = !canEditPlaylist;
            btnEditPlaylist.style.display = canEditPlaylist ? '' : 'none';
        }
        if (btnSharePlaylist) {
            btnSharePlaylist.hidden = !isOwner;
            btnSharePlaylist.style.display = isOwner ? '' : 'none';
        }
        if (btnSavePlaylist) {
            btnSavePlaylist.hidden = false;
            btnSavePlaylist.style.display = '';
            btnSavePlaylist.dataset.action = isOwner ? 'manage-members' : (isSharedPlaylist ? 'leave-playlist' : '');
            btnSavePlaylist.dataset.saved = String(isSavedPlaylist);
            btnSavePlaylist.title = isOwner ? 'Gestionar integrantes' : (isSharedPlaylist ? 'Salir de la playlist' : 'Guardar Playlist');
            if (btnSavePlaylistIcon) {
                btnSavePlaylistIcon.src = isOwner || isSharedPlaylist
                    ? '/img/cancel.png'
                    : (isSavedPlaylist ? '/img/save.png' : '/img/add.png');
                btnSavePlaylistIcon.alt = isOwner
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
        const playlistDuration = Number(pl.duration) || playlistTracks.reduce((total, track) => (
            total + Math.max(0, Number(track.duration) || 0)
        ), 0);
        const savedCount = Math.max(0, Number(pl.savedCount) || 0);
        if (plViewOwner) {
            const currentUser = getStoredUser();
            const localCreators = [currentUser, ...currentFriends].filter(Boolean);
            const getCreatorPhoto = (creator) => {
                if (creator.profilePhoto) return creator.profilePhoto;
                const localCreator = localCreators.find(item => String(item._id) === String(creator._id));
                return localCreator?.profilePhoto || '';
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

            plViewOwner.innerHTML = `
                <span id="pl-view-stats" class="pl-view-stats">
                    ${playlistTracks.length} canciones, ${formatPlaylistDuration(playlistDuration)}
                    <button id="pl-view-saved-count" class="pl-view-saved-count" type="button" data-playlist-id="${escapeHtml(pl.id)}" aria-label="Ver quién guardó esta playlist">
                        guardada ${savedCount} ${savedCount === 1 ? 'vez' : 'veces'}
                    </button>
                </span>
                <span class="pl-view-creators">
                    <span class="pl-creator-avatars">
                        ${creators.map(creator => `
                            <span class="pl-creator-avatar-wrap">
                            <button type="button" class="pl-creator-avatar-link" data-user-id="${escapeHtml(creator._id)}" data-username="${escapeHtml(creator.username)}" data-profile-photo="${escapeHtml(creator.profilePhoto || '')}">
                                ${creator.profilePhoto ? `<img src="${escapeHtml(creator.profilePhoto)}" alt="" class="pl-creator-avatar" />` : '<span class="pl-creator-avatar-placeholder">?</span>'}
                            </button>
                            </span>
                        `).join('')}
                    </span>
                    <span class="pl-creator-names">
                        ${creators.map((creator, index) => `
                            ${index > 0 && index === creators.length - 1 ? '<span class="pl-creator-separator">&nbsp;y&nbsp;</span>' : ''}
                            ${index > 0 && index < creators.length - 1 ? '<span class="pl-creator-separator">, </span>' : ''}
                            <button type="button" class="pl-creator-link" data-user-id="${escapeHtml(creator._id)}" data-username="${escapeHtml(creator.username)}" data-profile-photo="${escapeHtml(creator.profilePhoto || '')}">${escapeHtml(creator.username)}</button>
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

            plViewOwner.querySelectorAll('.pl-creator-link, .pl-creator-avatar-link').forEach(button => {
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

        }
        
        plViewTracks.innerHTML = '';
        pl.tracks.forEach((trackItem, arrayIndex) => {
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
            li.dataset.trackIndex = String(playlistIndex);
            li.dataset.playlistTrackId = playlistTrackId;
            const addedBy = typeof track.addedBy === 'object' ? track.addedBy : null;
            const addedByName = addedBy?.username || track.addedByName || 'Desconocido';
            const addedByPhoto = addedBy?.profilePhoto
                || currentFriends.find(friend => String(friend._id) === String(addedBy?._id))?.profilePhoto
                || '';
            const addedAtLabel = track.addedAt
                ? new Date(track.addedAt).toLocaleDateString('es-CL', { timeZone: 'America/Santiago' })
                : '--';
            li.innerHTML = `
                ${createImageMarkup(getSongCover(track), 'item-cover')}
                <div class="all-songs-item-info">
                    <span class="all-songs-item-name">${escapeHtml(track.name)}</span>
                    <span class="all-songs-item-artist">${escapeHtml(track.artist)}</span>
                </div>
                <small class="playlist-track-meta">
                    <span class="playlist-added-by">
                        ${addedByPhoto ? `<img src="${escapeHtml(addedByPhoto)}" alt="" class="playlist-meta-avatar" />` : ''}
                        ${addedBy?._id ? `<button type="button" class="playlist-user-link" data-user-id="${escapeHtml(addedBy._id)}" style="background:transparent; border:none; cursor:pointer;">${escapeHtml(addedByName)}</button>` : escapeHtml(addedByName)}
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
                        .finally(() => pendingPlaylistTrackChanges.delete(changeKey));
                    return;
                }
                if (playlistIndex !== -1) {
                    activeQueueTracks = pl.tracks
                        .map(item => {
                            const songId = String(item._id || item.id || '');
                            return playlist.find(main => String(main._id || main.id) === songId);
                        })
                        .filter(Boolean);
                    queueName = pl.name || 'GENERAL';
                    resetPlaybackHistory();
                    if (isShuffle) unplayedIndices = buildShuffleQueue();
                    renderQueue();
                    loadAndPlayTrack(playlistIndex, 'regular');
                }
            });
            let queueGesture;
            if (canEditPlaylist) {
                setupPlaylistDrag(li, pl, arrayIndex, () => Boolean(queueGesture?.horizontalIntent));
            }
            queueGesture = setupQueueAddSwipe(li, track);
            plViewTracks.appendChild(li);
        });
        
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
        const track = getCurrentTrack();
        lyricsPanel.style.backgroundColor = '#000';
        lyricsPanel.replaceChildren();

        const container = document.createElement('div');
        container.className = 'lyrics-container';
        container.style.setProperty('--lyrics-color', track?.color || '#151515');
        const list = document.createElement('ol');
        list.className = 'timed-lyrics-list full-lyrics-list';
        list.addEventListener('click', event => {
            const lyricText = event.target.closest('.timed-lyric-content');
            const seekButton = lyricText?.closest('[data-lyric-time]');
            const time = Number(seekButton?.dataset.lyricTime);
            if (!lyricText || !track || getTrackStorageId(getCurrentTrack()) !== getTrackStorageId(track) || !Number.isFinite(time)) return;
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
            seekAudioToTime(audio, time, () => {
                updateCurrentLyric(track, audio.currentTime);
                renderSyncedLyrics(track, audio.currentTime, list);
            });
        });
        container.appendChild(list);
        lyricsPanel.appendChild(container);
        renderSyncedLyrics(track, Number.isFinite(audio.currentTime) ? audio.currentTime : 0, list);
    }

    function updateBackgroundAndViews() {
        const anyViewOpen = isLyricsMode || isAllSongsMode || isPlaylistViewMode || isEditSongMode || isEditPlaylistMode || isSettingsMode || isAdminMode || isProfileMode;
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
        updateDiscordPresence();
        rememberLocalPlaybackActivity();
        suppressStartupPlaybackUpdates = false;
        const activeUser = getStoredUser();
        if (activeUser?._id && !isRestoringInitialPlayback) {
            playbackActivityUserId = String(activeUser._id);
        }
        sharedPlaybackPlaying = true;
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
        updateDiscordPresence();
        rememberLocalPlaybackActivity();
        recordOfflineListeningProgress(
            getCurrentTrack(),
            Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
            true
        );
        offlineListeningLastSample = null;
        persistOfflineListeningBuffer(true);
        sharedPlaybackPlaying = false;
        persistPlaybackPosition(true);
        broadcastPlaybackState(true);
        if (playbackUiFrame) {
            cancelAnimationFrame(playbackUiFrame);
            playbackUiFrame = null;
        }
        btnPlayPause.querySelector('img').src = '/img/play.png'; 
        stopSpin(); 
        if (!isLoggingOut) updateUserStatus(true);
        broadcastPlaybackState(true);
        if (isProfileMode) renderProfile();
    });

    audio.addEventListener('loadstart', () => {
        if (inlineSpinner) inlineSpinner.style.display = 'block';
        if (perroGif) perroGif.style.display = 'none';
    });

    audio.addEventListener('waiting', () => {
        if (inlineSpinner) inlineSpinner.style.display = 'block';
        if (perroGif) perroGif.style.display = 'none';
    });

    audio.addEventListener('canplay', () => {
        if (inlineSpinner) inlineSpinner.style.display = 'none';
        if (perroGif) perroGif.style.display = 'block';
    });

    audio.addEventListener('playing', () => {
        if (inlineSpinner) inlineSpinner.style.display = 'none';
        if (perroGif) perroGif.style.display = 'block';
    });

    btnVolume.addEventListener('click', () => {
        if (gainNode.gain.value > 0) {
            gainNode.gain.value = 0;
            volumeSlider.value = 0;
            btnVolume.querySelector('img').src = '/img/mute.png';
            updateVolumeSliderUI(0);
        } else {
            gainNode.gain.value = currentVolume > 0 ? currentVolume : 1;
            volumeSlider.value = gainNode.gain.value;
            btnVolume.querySelector('img').src = '/img/volume.png';
            updateVolumeSliderUI(gainNode.gain.value);
        }
    });

    const updateVolumeSliderUI = (val) => {
        const isMuted = gainNode.gain.value <= 0;
        const displayValue = isMuted ? 0 : val;
        const percent = Math.round(displayValue * 100);
        volumeTooltip.textContent = percent + '%';
        const sliderPercent = (displayValue / maxVolume) * 100;
        const trackColor = getCurrentTrack()?.color || '#ffffff';

        if (percent <= 100) {
            volumeSlider.style.background = `linear-gradient(to right, ${trackColor} ${sliderPercent}%, #333 ${sliderPercent}%)`;
            volumeTooltip.style.color = '#fff';
        } else {
            const normalPercent = (1 / maxVolume) * 100;
            volumeSlider.style.background = `linear-gradient(to right, ${trackColor} ${normalPercent}%, red ${normalPercent}%, red ${sliderPercent}%, #333 ${sliderPercent}%)`;
            volumeTooltip.style.color = 'red';
        }
    };

    volumeSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        gainNode.gain.value = val;
        currentVolume = val;
        btnVolume.querySelector('img').src = val === 0 ? '/img/mute.png' : '/img/volume.png';
        updateVolumeSliderUI(val);
    });

    if (inputMaxVolume) {
        inputMaxVolume.addEventListener('change', (event) => {
            const requestedPercent = Number(event.target.value);
            const clampedPercent = Math.min(1000, Math.max(100, Number.isFinite(requestedPercent) ? requestedPercent : 200));
            maxVolume = clampedPercent / 100;
            event.target.value = String(clampedPercent);
            localStorage.setItem('maxVolume', String(maxVolume));
            volumeSlider.max = String(maxVolume);
            if (currentVolume > maxVolume) {
                currentVolume = maxVolume;
                gainNode.gain.value = maxVolume;
                volumeSlider.value = String(maxVolume);
            }
            updateVolumeSliderUI(currentVolume);
        });
    }

    function renderQueue() {
        queueList.innerHTML = '';
        const upcomingIndices = isShuffle ? [...unplayedIndices] : getSequentialQueueIndices();
        const currentTrack = getCurrentTrack();

        if (currentTrack) {
            const currentHeader = document.createElement('div');
            currentHeader.className = 'queue-header';
            currentHeader.textContent = 'Reproduciendo ahora';
            queueList.appendChild(currentHeader);

            const currentItem = document.createElement('li');
            currentItem.className = 'queue-item active';
            currentItem.dataset.trackIndex = String(currentTrackIndex);
            currentItem.style.setProperty('--track-color', currentTrack.color);
            currentItem.innerHTML = `
                ${createImageMarkup(getSongCover(currentTrack), 'queue-item-img')}
                <div class="queue-item-info">
                    <span class="queue-item-name">${currentTrack.name}</span>
                    <span class="queue-item-artist">${currentTrack.artist}</span>
                </div>
            `;
            queueList.appendChild(currentItem);
        }

        if (customQueue.length > 0) {
            const header = document.createElement('div');
            header.className = 'queue-header';
            header.textContent = 'A continuación en la cola';
            queueList.appendChild(header);

            customQueue.forEach((track, idx) => {
                const li = document.createElement('li');
                li.className = 'queue-item';
                li.dataset.songId = String(track._id || track.id || '');
                li.style.setProperty('--track-color', track.color);
                li.innerHTML = `
                    ${createImageMarkup(getSongCover(track), 'queue-item-img')}
                    <div class="queue-item-info">
                        <span class="queue-item-name">${track.name}</span>
                        <span class="queue-item-artist">${track.artist}</span>
                    </div>
                    <button class="remove-queue-btn" type="button">
                        <img src="/img/cancel.png" draggable="false" class="no-drag" alt="">
                    </button>
                `;
                li.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (li.dataset.wasDragged === 'true') {
                        delete li.dataset.wasDragged;
                        return;
                    }
                    if (e.target.closest('.remove-queue-btn')) {
                        customQueue.splice(idx, 1);
                        renderQueue();
                        return;
                    }
                    const trackIndex = playlist.findIndex(item => (
                        getTrackStorageId(item) === getTrackStorageId(track)
                    ));
                    const queuePosition = customQueue[idx] === track
                        ? idx
                        : customQueue.findIndex(item => item === track);
                    if (trackIndex !== -1 && queuePosition !== -1) {
                        customQueue.splice(0, queuePosition + 1);
                        playbackHistory.push({ index: currentTrackIndex, source: currentTrackSource });
                        loadAndPlayTrack(trackIndex, 'custom');
                    }
                });
                setupCustomQueueDrag(li, idx);
                queueList.appendChild(li);
            });

        }

        if (upcomingIndices.length > 0) {
            const activePlaylist = userPlaylists.find(playlistItem => playlistItem.id === activePlaylistId);
            const sourceHeader = document.createElement('div');
            sourceHeader.className = 'queue-header';
            sourceHeader.textContent = queueName || 'GENERAL';
            queueList.appendChild(sourceHeader);

            upcomingIndices.forEach((origIndex, position) => {
                const track = playlist[origIndex];
                if (!track) return;
                const li = document.createElement('li');
                li.className = 'queue-source-item';
                li.dataset.queueSource = isShuffle ? 'shuffle' : 'regular';
                li.dataset.queuePosition = position;
                li.dataset.trackIndex = String(origIndex);
                li.style.setProperty('--track-color', track.color);
                li.innerHTML = `
                    ${createImageMarkup(getSongCover(track), 'queue-item-img')}
                    <div class="queue-item-info">
                        <span class="queue-item-name">${track.name}</span>
                        <span class="queue-item-artist">${track.artist}</span>
                    </div>
                `;
                setupSongMenuListeners(li, origIndex);
                setupQueueAddSwipe(li, track);
                queueList.appendChild(li);
            });
        } else if (customQueue.length === 0) {
            const emptyQueue = document.createElement('div');
            emptyQueue.className = 'queue-header';
            emptyQueue.textContent = 'NO HAY MÁS CANCIONES EN LA COLA';
            queueList.appendChild(emptyQueue);
        }
    }

    function loadAndPlayTrack(index, source = 'regular', shouldPlay = true) {
        if (index >= playlist.length) index = 0;
        if (index < 0) index = playlist.length - 1;

        playbackActivityUserId = null;
        currentTrackIndex = index;
        currentTrackSource = source;
        const track = playlist[currentTrackIndex];
        if (!track) return;
        currentTrackId = track._id;
        if (source !== 'custom') generalQueueAnchorTrackId = String(track._id);
        const currentUser = getStoredUser();
        playbackUiTrackId = track._id;
        playbackUiTime = 0;
        sharedPlaybackTime = 0;
        sharedPlaybackDuration = 0;
        if (progressBar) progressBar.style.width = '0%';
        updateTrackDurationLabel(0, Number(track.duration) || 0);
        audio.pause();
        const sourceLoadToken = ++audioSourceLoadToken;
        const setAudioSource = async () => {
            const mediaKey = `song:${track._id}:audio`;
            let localUrl = null;
            if (offlineModeEnabled || offlineOnly) {
                try {
                    localUrl = await getOfflineObjectUrl(mediaKey);
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
            const source = localUrl || track.path;
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
            audio.src = source || '';
            audio.currentTime = 0;
            if (shouldPlay) {
                await audio.play();
            } else {
                audio.pause();
            }
        };
        if (offlineModeEnabled || offlineOnly) {
            setAudioSource().catch(error => {
                showToast(error.message || 'No se pudo abrir la canción guardada.', true);
            });
        } else {
            audio.src = track.path;
            audio.currentTime = 0;
            if (shouldPlay) {
                audio.play().catch((err) => console.log('Esperando interacción para reproducción:', err));
            }
        }
        if (currentUser?._id && shouldPlay) {
            localStorage.setItem(`amgc-last-playback-${currentUser._id}`, JSON.stringify({
                songId: track._id,
                currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0
            }));
        }

        trackNameEl.textContent = track.name;
        trackArtistEl.textContent = track.artist;
        updateDiscordPresence();
        bottomBar.style.setProperty('--track-color', track.color);
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
    }

    function showPlayerPopup(track) {
        const trackCover = getSongCover(track);
        popupCover.src = trackCover;
        popupCover.alt = trackCover ? '' : 'SIN IMG';
        popupCover.classList.toggle('no-image', !trackCover);
        popupSongName.innerHTML = `${track.name}<span class="popup-artist">${track.artist}</span>`;
        playerPopup.style.setProperty('--track-color', track.color);
        playerPopup.classList.add('active');

        if (popupTimeout) clearTimeout(popupTimeout);
        popupTimeout = setTimeout(() => playerPopup.classList.remove('active'), 4000);
    }

    function playNextTrack() {
        if (customQueue.length > 0) {
            const nextTrack = customQueue.shift();
            const idx = playlist.findIndex(t => t.path === nextTrack.path);
            if (idx !== -1) {
                if (playlist[currentTrackIndex]) playbackHistory.push({ index: currentTrackIndex, source: currentTrackSource });
                loadAndPlayTrack(idx, 'custom');
            }
            return;
        }

        if (isShuffle) {
            if (unplayedIndices.length === 0) {
                unplayedIndices = buildShuffleQueue();
            }
            if (unplayedIndices.length === 0) return;

            const nextRandom = unplayedIndices.shift();
            if (playlist[currentTrackIndex]) playbackHistory.push({ index: currentTrackIndex, source: currentTrackSource });
            loadAndPlayTrack(nextRandom, 'shuffle');
        } else {
            const nextIndex = getSequentialQueueIndices()[0];
            if (nextIndex !== undefined) {
                if (playlist[currentTrackIndex]) playbackHistory.push({ index: currentTrackIndex, source: currentTrackSource });
                loadAndPlayTrack(nextIndex, 'regular');
            } else if (playlist.length > 0) {
                currentTrackIndex = 0;
                activeQueueTracks = activeQueueTracks.length ? activeQueueTracks : [...playlist];
                loadAndPlayTrack(0, 'regular');
            }
        }
    }

    function rewindTrack() {
        if (audio.duration) {
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
        if (audio.duration) {
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

    const handleKeyDown = (e) => {
        const tag = e.target.tagName ? e.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) {
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

    btnNext.addEventListener('click', playNextTrack);
    audio.addEventListener('ended', () => {
        updateDiscordPresence();
        playNextTrack();
    });
    btnPrev.addEventListener('click', () => {
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
        isShuffle = !isShuffle;
        btnShuffle.classList.toggle('active', isShuffle);
        if (isShuffle) {
            unplayedIndices = buildShuffleQueue();
        } else {
            unplayedIndices = [];
        }
        playbackHistory = [];
        renderQueue();
    });

    if (btnAllSongs) {
        btnAllSongs.addEventListener('click', (e) => {
            e.preventDefault();
            const nextState = !isAllSongsMode;
            isAllSongsMode = nextState;
            isAdminMode = false;
            isSettingsMode = false;
            isLyricsMode = false;
            isPlaylistViewMode = false;
            isProfileMode = false;
            isEditSongMode = false;
            isEditPlaylistMode = false;

            if (isAllSongsMode) {
                activePlaylistId = null;
                activeQueueTracks = [...playlist];
                playbackHistory = [];
                unplayedIndices = [];
            }
            updateBackgroundAndViews();
            closeSidebar();
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
            startYtDownloadProgress('Descargando canción');
            showYoutubeLinkStatus('Descargando el audio en este equipo...', false);

            const requestedFileName = inputSettingsYtName?.value.trim() || '';

            try {
                const result = await desktopYoutubeLocalSaver(link, requestedFileName);
                stopYtDownloadProgress({
                    success: true,
                    message: `MP3 guardado en este equipo: ${result.fileName}`
                });
                showYoutubeLinkStatus(`¡MP3 guardado en ${result.path}!`, false);
                inputSettingsYt.value = '';
                if (inputSettingsYtName) inputSettingsYtName.value = '';
            } catch (e) {
                console.error(e);
                const message = e?.message || 'El enlace de YouTube fue rechazado o no es válido.';
                stopYtDownloadProgress({ success: false, message, error: true });
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
        if (audio.paused) { audio.play(); } 
        else { audio.pause(); }
    });

    progressContainer.addEventListener('click', (e) => {
        const width = progressContainer.clientWidth;
        const clickX = e.offsetX;
        const duration = audio.duration;
        if (duration) audio.currentTime = (clickX / width) * duration;
    });

    audio.addEventListener('timeupdate', () => {
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
        rememberLocalPlaybackActivity();
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
    };
}