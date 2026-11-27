import {
  getOfflineFriends,
  getOfflineAudioSongIds,
  getOfflineLibrary,
  getOfflineMedia,
  getOfflineMediaIndex,
  getOfflinePlaylistSavers,
  getOfflineProfilePlaylists,
  getOfflinePlaylists,
  saveOfflineFriends,
  saveOfflineLibrary,
  saveOfflineMedia,
  saveOfflineMediaFile,
  saveOfflineProfilePlaylists,
  saveOfflinePlaylistSavers,
  saveOfflinePlaylists
} from '../src/offlineStore.js';
import { io } from 'socket.io-client';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { fetchSpotifyLikedTracksPage } from '../src/spotifyClient.js';
import {
  formatPlaybackRelativeTime,
  getPlaybackElapsedSeconds,
  getPlaybackLastHeardAt,
  getPlaybackLastHeardLabel
} from '../src/playbackActivity.js';

const isAndroidNative = Capacitor.getPlatform() === 'android';
document.documentElement.classList.toggle('android-native', isAndroidNative);
const nativeMedia = registerPlugin('AMGCMedia');
const STORAGE_KEYS = {
  token: 'amgc-mobile-access-token',
  user: 'amgc-mobile-user'
};
const PLAYBACK_DEVICE_STORAGE_KEY = 'amgc-playback-device-id';
const OFFLINE_RESOURCE_TIMEOUT_MS = 60000;
let playbackDeviceId = localStorage.getItem(PLAYBACK_DEVICE_STORAGE_KEY);
if (!playbackDeviceId) {
  playbackDeviceId = window.crypto && typeof window.crypto.randomUUID === 'function'
    ? window.crypto.randomUUID()
    : `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(PLAYBACK_DEVICE_STORAGE_KEY, playbackDeviceId);
}
const playbackDeviceType = 'mobile';
const API_BASE_URL = 'https://mmamgc.onrender.com/api';
const state = {
  token: localStorage.getItem(STORAGE_KEYS.token) || '',
  user: null,
  songs: [],
  playlists: [],
  suggestions: [],
  spotifyConnected: false,
  spotifyConfigured: false,
  spotifyPlaylistScopesGranted: false,
  spotifyTracks: [],
  spotifyTracksLoaded: false,
  spotifyNextOffset: 0,
  spotifyTotal: 0,
  spotifyHasMore: false,
  spotifyPlaylists: [],
  spotifyPlaylistsLoaded: false,
  spotifyPlaylistsNextOffset: 0,
  spotifyPlaylistsHasMore: false,
  spotifySelectedTrackIds: new Set(),
  spotifySearch: '',
  spotifySectionOpen: false,
  spotifyStatusMessage: 'Consulta la conexión de Spotify.',
  friends: [],
  unreadMessageCounts: new Map(),
  secretPhrases: [],
  secretPhrasesPersonal: false,
  currentTab: 'home',
  catalogLoading: false,
  catalogLoadError: '',
  songSearchQuery: '',
  songSearchScrollTop: 0,
  currentPlaylistId: null,
  profileUser: null,
  profilePlaylists: [],
  profileStats: null,
  profileLoadingId: null,
  seekSeconds: 5,
  maxVolume: 2,
  volume: 1,
  offlineEnabled: false,
  offlineStatus: 'Descargas offline desactivadas.',
  offlineProgress: null,
  offlineAudioSongIds: new Set(),
  queue: [],
  queueIndex: -1,
  currentTrack: null,
  loadingTrackId: '',
  remotePlayback: null,
  ownPlayback: null,
  playbackOwnerConfirmed: false,
  queueTitle: 'GENERAL',
  upcomingQueue: [],
  shuffleQueue: [],
  playbackHistory: [],
  restoredPlaybackForUser: null,
  lastLocalPlaybackSave: 0,
  socket: null,
  followingUserId: null,
  followNeedsUserGesture: false,
  sharedQueueSessionId: null,
  sharedQueueRole: null,
  sharedQueueRevision: 0,
  sharedQueueIds: [],
  sharedQueueUpcomingIds: [],
  sharedQueueHostQueueName: 'GENERAL',
  sharedQueueJamActive: false,
  sharedQueueJamRequestPending: false,
  sharedQueueJamRequestId: '',
  sharedQueueJamUpdateInFlight: false,
  sharedQueueJamPendingUpcomingIds: null,
  hostJamRequestId: '',
  sharedQueueSnapshotSignature: '',
  accountQueueIds: [],
  accountQueueSourceIds: [],
  accountQueueName: 'GENERAL',
  accountQueueSnapshotCached: false,
  accountQueuePendingIds: null,
  accountQueueRevision: 0,
  accountQueueSnapshotSignature: null,
  accountQueueDeviceId: null,
  accountQueueSyncInFlight: false,
  lastUnavailableFollowSongId: null,
  activeChatFriend: null,
  chatPollTimer: null,
  editingPlaylistId: null,
  selectedSongId: null,
  pendingSongId: null,
  shuffle: false,
  activeLyricIndex: -1,
  previousSecretPhrase: '',
  homeLyricAnimationTimeout: null,
  pendingHomeLyricIndex: null,
  customNotificationEnabled: localStorage.getItem('amgc-mobile-custom-notification') === 'true',
  notificationPermissionGranted: false
};
const spotifyPlaylistSyncs = new Set();
let accountQueuePublishChain = Promise.resolve();
let pendingPlaybackTakeoverPromise = null;
let pendingPlaybackTakeoverRetryTimer = null;
let pendingPlaybackTakeoverRetryDelay = 30000;
let pendingPlaybackTakeoverLastNotifiedSongId = '';
let accountQueueRetryTimer = null;
let accountQueueRetryDelay = 15000;
let accountQueueLastNotifiedSignature = '';
let playbackRequestLoadingCount = 0;
const pendingPlaylistAdds = new Set();

const elements = {
  loginScreen: document.getElementById('login-screen'),
  loginForm: document.getElementById('login-form'),
  loginError: document.getElementById('login-error'),
  appShell: document.getElementById('app-shell'),
  mainView: document.getElementById('main-view'),
  playerScreen: document.getElementById('player-screen'),
  playerSource: document.getElementById('player-source'),
  miniPlayer: document.getElementById('mini-player'),
  audio: document.getElementById('audio-element'),
  dialog: document.getElementById('sheet-dialog'),
  playlistForm: document.getElementById('playlist-form'),
  addSheet: document.getElementById('add-to-playlist-sheet'),
  shareSheet: document.getElementById('share-playlist-sheet'),
  membersSheet: document.getElementById('manage-playlist-members-sheet'),
  suggestionForm: document.getElementById('suggestion-form'),
  lyricsScreen: document.getElementById('lyrics-screen'),
  playerQueue: document.getElementById('player-queue'),
  queueJamControls: document.getElementById('queue-jam-controls'),
  requestJamButton: document.getElementById('btn-request-jam'),
  jamRequestNotification: document.getElementById('jam-request-notification'),
  jamRequestMessage: document.getElementById('jam-request-message'),
  acceptJamRequest: document.getElementById('jam-request-accept'),
  declineJamRequest: document.getElementById('jam-request-decline'),
  queueScrim: document.getElementById('queue-scrim'),
  homeLyrics: document.getElementById('home-lyrics'),
  chatScreen: document.getElementById('chat-screen'),
  toast: document.getElementById('toast'),
  playbackWaitIndicator: document.getElementById('playback-wait-indicator'),
  playbackWaitLabel: document.getElementById('playback-wait-label')
};

let toastTimer;
let playlistPreviewObjectUrl = null;
let lastPlaybackStatusUpdate = 0;
let lastRealtimePlaybackBroadcast = 0;
let realtimeBaseUrl = '';
let audioContext = null;
let audioGain = null;
let audioSourceNode = null;
let annoyAudioBufferPromise = null;
let trackLoadSequence = 0;
let activeOfflineAudioUrl = null;
let activeTrackUsingOfflineCache = false;
let activeTrackFallbackState = { cache: false };
let currentTrackShouldAutoplay = false;
let handledEndedTrackSequence = 0;
const playlistOrderSaves = new Map();
let libraryRevision = 0;
let homeSpinActive = false;
let homeSpinRotation = 0;
let homeSpinFrame = null;
let homeSpinTimer = null;
let homeSpinLastFrameAt = 0;
let lastNativeNotificationUpdate = 0;
let nativeNotificationUpdateTimer = null;
let nativeNotificationRevision = 0;
let nativeNotificationRunning = false;
let nativeNotificationStopSent = false;
let nativeNotificationDesired = false;
let lastNativeNotificationKey = '';
let lastNativeNotificationCoverKey = '';
let cachedNativeNotificationCoverPath = '';
let sharedPlaybackClockTimer = null;
let suppressRemotePlaybackPause = false;
let playbackTransferPending = false;
let deferredPlaybackOwnerUpdate = null;
let playbackDeviceRemovalPending = false;
let activePlaybackTransferId = null;
let activePlaybackTransferUserId = null;
let isActivatingPlaybackTransfer = false;
let connectedPlaybackDevices = [];
let remoteSeekTimer = null;
let queuedRemoteSeekPosition = 0;
let profileProgressTimer = null;
let songSearchTimer = null;
window.addEventListener('scroll', () => {
  if (state.currentTab === 'songs' && !state.currentPlaylistId) {
    state.songSearchScrollTop = window.scrollY;
  }
}, { passive: true });
let offlineSyncPromise = null;
let offlineSyncRequested = false;
let libraryRequestSequence = 0;
let friendsRequestSequence = 0;
let spotifyStatusRequest = null;
let spotifyTracksRequest = null;
let spotifyApiAccessToken = '';
let spotifyApiAccessTokenExpiresAt = 0;
let spotifyApiAccessTokenUserId = '';
let spotifyApiAccessTokenRequest = null;
let unreadMessagesRequest = null;
let realtimeLibraryRefreshTimer = null;
let realtimeFriendsRefreshTimer = null;
const playlistSaversCache = new Map();
const friendRealtimeUpdates = new Map();
const offlineMediaUrls = new Map();
const offlineImageUrlsById = new Map();
const nativeDriveDownloads = new Map();
const nativeImageDownloadQueue = [];
const nativeImageDownloads = new Map();
const deferredNativeImages = new Set();
let activeNativeImageDownloads = 0;
let nativeImageObserver = null;

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('No se pudo conectar con el servidor AMGC. Comprueba la conexión e inténtalo de nuevo.');
    }
    throw error;
  }
  const contentType = response.headers.get('content-type') || '';
  const result = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    if (response.status === 401 && state.token) {
      logout(false);
      elements.loginError.textContent = 'La sesión no fue aceptada por el servidor. Inicia sesión nuevamente.';
    }
    const error = new Error(result?.error || `Error del servidor (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function getSongId(song) {
  return String(song?._id || song?.id || '');
}

function getCurrentSong() {
  return state.currentTrack || state.queue[state.queueIndex] || null;
}

function getLyricsSong() {
  const playback = getRemotePlaybackSession();
  if (!playback) return getCurrentSong();
  const songId = String(playback.songId || '');
  let song = state.songs.find(item => getSongId(item) === songId)
    || state.queue.find(item => getSongId(item) === songId)
    || null;
  if (!song) {
    for (const playlist of state.playlists) {
      song = (playlist.tracks || []).find(item => getSongId(item) === songId) || null;
      if (song) break;
    }
  }
  const playbackColor = typeof playback.color === 'string' && CSS.supports('color', playback.color)
    ? playback.color
    : song?.color;
  return {
    ...(song || {}),
    _id: songId || song?._id,
    name: playback.songName || song?.name || 'Canción',
    artist: playback.artist || song?.artist || 'Artista desconocido',
    cover: getPlaybackCover(playback, song),
    color: playbackColor || '#151515'
  };
}

function getImageVariantCacheId(fileId, size = 'small') {
  return `${fileId}:${size}`;
}

function getImageCacheKey(source, size = 'small') {
  const fileId = getDriveFileId(resolveMediaUrl(source));
  if (!fileId) return '';
  return size === 'large' ? `image:${fileId}:large` : `image:${fileId}`;
}

function getCachedImageUrl(source, legacyKey = '', size = 'small') {
  const fileId = getDriveFileId(resolveMediaUrl(source));
  const cachedUrl = fileId
    ? offlineImageUrlsById.get(getImageVariantCacheId(fileId, size))
      || (size === 'small' && offlineImageUrlsById.get(getImageVariantCacheId(fileId, 'large')))
    : '';
  return cachedUrl
    || offlineMediaUrls.get(getImageCacheKey(source, size))
    || (legacyKey && offlineMediaUrls.get(legacyKey))
    || '';
}

function getSongCover(song, size = 'small') {
  const cached = getCachedImageUrl(song?.cover, `song:${getSongId(song)}:cover`, size);
  if (cached) return cached;
  return song?.cover || '';
}

function getPlaybackCover(playback, fallbackSong = null, size = 'small') {
  const songId = String(playback?.songId || getSongId(fallbackSong));
  const cover = typeof playback?.cover === 'string' ? playback.cover.trim() : '';
  const cachedCover = getCachedImageUrl(
    cover || fallbackSong?.cover,
    `song:${songId}:cover`,
    size
  );
  if (cachedCover) return cachedCover;
  if (cover && cover !== '/img/vinculo.png' && !/^(?:blob|file|filesystem|capacitor|content):/i.test(cover)) {
    return cover;
  }
  let song = fallbackSong || state.songs.find(item => getSongId(item) === songId)
    || state.queue.find(item => getSongId(item) === songId)
    || null;
  if (!song) {
    for (const playlist of state.playlists) {
      song = (playlist.tracks || []).find(item => getSongId(item) === songId) || null;
      if (song) break;
    }
  }
  return getSongCover(song, size) || song?.cover || './icon.svg';
}

function getPlaylistCover(playlist, size = 'small') {
  const cached = getCachedImageUrl(
    playlist?.photo,
    `playlist:${playlist?.id}:photo`,
    size
  );
  if (cached) return cached;
  return playlist?.photo || '';
}

function getUserPhoto(user) {
  const cached = getCachedImageUrl(
    user?.profilePhoto,
    `friend:${user?._id}:photo`
  );
  if (cached) return cached;
  return user?.profilePhoto || '';
}

async function getOfflineObjectUrl(key) {
  if (offlineMediaUrls.has(key)) return offlineMediaUrls.get(key);
  const cached = await getOfflineMedia(key);
  if (cached?.localPath && isAndroidNative) {
    const url = Capacitor.convertFileSrc(cached.localPath);
    offlineMediaUrls.set(key, url);
    return url;
  }
  if (!cached?.blob) return '';
  const url = URL.createObjectURL(cached.blob);
  offlineMediaUrls.set(key, url);
  return url;
}

async function hydrateOfflineMedia(resources) {
  let hydratedAny = false;
  await Promise.all(resources.map(async resource => {
    const { key, source, aliases = [] } = resource;
    const size = resource.size || getImageSizeFromCacheKey(key);
    const fileId = getDriveFileId(resolveMediaUrl(source));
    const variantCacheId = fileId ? getImageVariantCacheId(fileId, size) : '';
    if (!source || (variantCacheId && offlineImageUrlsById.has(variantCacheId))) return;
    const cacheKey = getImageCacheKey(source, size) || key;
    const candidates = [cacheKey, ...aliases, key].filter((candidate, index, list) => (
      candidate && list.indexOf(candidate) === index
    ));
    for (const candidate of candidates) {
      const cached = await getOfflineMedia(candidate);
      if (!cached || (cached.sourceUrl && !sameMediaSource(
        cached.sourceUrl,
        resolveOfflineResourceUrl(source, size === 'large' ? 'image-large' : 'image')
      ))) continue;
      const alreadyHydrated = offlineMediaUrls.has(candidate);
      const cachedUrl = await getOfflineObjectUrl(candidate);
      if (!cachedUrl) continue;
      offlineMediaUrls.set(cacheKey, cachedUrl);
      if (variantCacheId) offlineImageUrlsById.set(variantCacheId, cachedUrl);
      if (!alreadyHydrated) hydratedAny = true;
      return;
    }
  }));
  return hydratedAny;
}

async function hydrateCurrentOfflineImages() {
  const resources = new Map();
  const add = (legacyKey, source, size = 'small') => {
    const key = getImageCacheKey(source, size);
    if (!key || !source) return;
    const resource = resources.get(key) || { key, source, aliases: [], size };
    if (legacyKey && legacyKey !== key) resource.aliases.push(legacyKey);
    resources.set(key, resource);
  };
  const songs = new Map();
  [...state.songs, ...state.playlists.flatMap(playlist => playlist.tracks || []),
    ...state.profilePlaylists.flatMap(playlist => playlist.tracks || []),
    ...state.queue, ...state.upcomingQueue].forEach(song => {
    const id = getSongId(song);
    if (id) songs.set(id, song);
  });
  songs.forEach((song, id) => {
    add(`song:${id}:cover`, song.cover, 'small');
    add(`song:${id}:cover`, song.cover, 'large');
  });
  const playlists = new Map();
  [...state.playlists, ...state.profilePlaylists].forEach(playlist => {
    if (playlist?.id) playlists.set(String(playlist.id), playlist);
  });
  playlists.forEach((playlist, id) => {
    add(`playlist:${id}:photo`, playlist.photo, 'small');
    add(`playlist:${id}:photo`, playlist.photo, 'large');
    add(`friend:${playlist.ownerId}:photo`, playlist.ownerPhoto);
    (playlist.sharedWith || []).forEach(member => {
      add(`friend:${member?._id || member}:photo`, member?.profilePhoto);
    });
  });
  const users = new Map([
    ...state.friends,
    ...state.friends.flatMap(friend => friend.friends || []),
    ...[...playlistSaversCache.values()].flat(),
    ...(state.user ? [state.user] : []),
    ...(state.profileUser ? [state.profileUser] : [])
  ].filter(user => user?._id).map(user => [String(user._id), user]));
  users.forEach((user, id) => add(`friend:${id}:photo`, user.profilePhoto));
  await hydrateOfflineMedia([...resources.values()]);
}

function resolveMediaUrl(path) {
  if (!path) return '';
  try {
    const rawPath = String(path).trim();
    const apiBase = new URL(API_BASE_URL);
    const apiOrigin = apiBase.origin;
    const resolved = /^(?:https?:|blob:|data:)/i.test(rawPath)
      ? new URL(rawPath)
      : new URL(`/${rawPath.replace(/^\/+/, '')}`, apiOrigin);
    if (resolved.protocol === 'http:' && resolved.host === apiBase.host) {
      resolved.protocol = 'https:';
    }
    const driveFileId = getDriveFileId(resolved);
    if (driveFileId) {
      return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveFileId)}`;
    }
    if (resolved.pathname.startsWith('/mp3/')) return `${apiOrigin}${resolved.pathname}${resolved.search}`;
    return resolved.href;
  } catch {
    return path;
  }
}

function getDriveFileId(value) {
  try {
    const url = value instanceof URL ? value : new URL(String(value), API_BASE_URL);
    const isDriveHost = /(^|\.)drive\.google\.com$/i.test(url.hostname)
      || /(^|\.)drive\.usercontent\.google\.com$/i.test(url.hostname);
    if (isDriveHost) {
      const fileId = url.searchParams.get('id')
        || url.pathname.match(/\/file\/d\/([\w-]+)/)?.[1];
      return fileId && /^[\w-]{25,}$/.test(fileId) ? fileId : null;
    }
    const driveProxyMatch = url.pathname.match(/^\/(?:api\/)?media\/([\w-]{25,})$/);
    return driveProxyMatch?.[1] || null;
  } catch {
    return null;
  }
}

function resolveImageUrl(path, size = 'small') {
  if (!path) return '';
  const rawPath = String(path).trim();
  if (/^(?:\.{1,2}\/|blob:|data:|file:|content:)/i.test(rawPath)) return rawPath;
  const resolvedUrl = resolveMediaUrl(rawPath);
  const driveFileId = getDriveFileId(resolvedUrl);
  return driveFileId
    ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(driveFileId)}&sz=${size === 'large' ? 'w1000' : 'w160'}`
    : resolvedUrl;
}

function resolveOriginalDriveImageUrl(source) {
  const fileId = getDriveFileId(resolveMediaUrl(source));
  return fileId
    ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`
    : resolveImageUrl(source);
}

function resolveOfflineResourceUrl(source, mediaType) {
  const resolvedUrl = resolveMediaUrl(source);
  const fileId = getDriveFileId(resolvedUrl);
  if (fileId && mediaType.startsWith('image')) {
    const size = mediaType === 'image-large' ? 'w1000' : 'w160';
    return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=${size}`;
  }
  return resolvedUrl;
}

function getImageSizeFromCacheKey(key) {
  return key.endsWith(':large') ? 'large' : 'small';
}

function getOfflineResourceMediaType(key) {
  if (key.endsWith(':audio')) return 'audio';
  return key.endsWith(':large') ? 'image-large' : 'image';
}

function sameMediaSource(left, right) {
  if (left === right) return true;
  const leftDriveId = getDriveFileId(left);
  return Boolean(leftDriveId && leftDriveId === getDriveFileId(right));
}

async function downloadNativeDriveFile(fileId, mediaType) {
  const downloadKey = `${fileId}:${mediaType}`;
  let downloadPromise = nativeDriveDownloads.get(downloadKey);
  if (!downloadPromise) {
    downloadPromise = (async () => {
      let lastError;
      const maxAttempts = mediaType.startsWith('image') ? 2 : 3;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          return await nativeMedia.downloadDriveFile({ fileId, mediaType });
        } catch (error) {
          lastError = error;
          if (attempt < maxAttempts - 1) {
            const retryDelay = mediaType.startsWith('image') ? 500 * (2 ** attempt) : 1000 * (2 ** attempt);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
        }
      }
      throw new Error(lastError?.message || 'No se pudo descargar desde Google Drive.');
    })();
    nativeDriveDownloads.set(downloadKey, downloadPromise);
  }
  try {
    return await downloadPromise;
  } finally {
    if (nativeDriveDownloads.get(downloadKey) === downloadPromise) {
      nativeDriveDownloads.delete(downloadKey);
    }
  }
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

function createPlaybackDeviceIcon(deviceType) {
  if (deviceType !== 'mobile' && deviceType !== 'desktop') return null;
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('class', 'playback-device-inline');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const shape = deviceType === 'mobile'
    ? [['rect', { x: '6.5', y: '2.5', width: '11', height: '19', rx: '2.2' }], ['path', { d: 'M10 5.5h4M11 18.5h2' }]]
    : [['rect', { x: '3', y: '3', width: '18', height: '13', rx: '1.5' }], ['path', { d: 'M8 21h8M12 16v5M5 21h14' }]];
  shape.forEach(([tagName, attributes]) => {
    const element = document.createElementNS(namespace, tagName);
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
    svg.append(element);
  });
  return svg;
}

function updatePlaybackDevicePickerIcons() {
  const playback = getRemotePlaybackSession() || {
    deviceId: playbackDeviceId,
    deviceType: playbackDeviceType
  };
  const deviceType = getPlaybackDeviceType(playback);
  document.querySelectorAll('#playback-device-picker-trigger, [data-playback-device-trigger]').forEach(trigger => {
    const icon = createPlaybackDeviceIcon(deviceType);
    icon.classList.replace('playback-device-inline', 'playback-device-trigger-icon');
    trigger.replaceChildren(icon);
  });
  if (elements.miniPlaybackDeviceTrigger) {
    const icon = createPlaybackDeviceIcon(deviceType);
    icon.classList.replace('playback-device-inline', 'mini-playback-device-icon');
    elements.miniPlaybackDeviceTrigger.replaceChildren(icon);
    elements.miniPlaybackDeviceTrigger.hidden = false;
  }
}

function getPlaybackDeviceType(playback) {
  if (['mobile', 'desktop'].includes(playback?.deviceType)) return playback.deviceType;
  const registeredDevice = connectedPlaybackDevices.find(device => device.deviceId === playback?.deviceId);
  if (['mobile', 'desktop'].includes(registeredDevice?.deviceType)) return registeredDevice.deviceType;
  const deviceName = `${playback?.deviceName || registeredDevice?.deviceName || ''}`;
  if (/android|iphone|ipad|móvil/i.test(deviceName)) return 'mobile';
  if (/windows|macos|linux|escritorio/i.test(deviceName)) return 'desktop';
  return playback?.deviceId === playbackDeviceId ? playbackDeviceType : 'desktop';
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

function renderPlaybackDevicePicker() {
  if (!elements.playbackDeviceList) return;
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
      deviceName: 'Este teléfono',
      deviceType: playbackDeviceType,
      isConnected: true
    });
  }
  const activeDeviceId = state.remotePlayback?.deviceId
    || (getCurrentSong() ? playbackDeviceId : '');
  elements.playbackDeviceList.replaceChildren();
  devices.sort((first, second) => Number(second.deviceId === playbackDeviceId) - Number(first.deviceId === playbackDeviceId));
  devices.forEach(device => {
    const isCurrentDevice = device.deviceId === playbackDeviceId;
    const isCurrentPlaybackDevice = device.deviceId === activeDeviceId;
    const label = isCurrentDevice ? 'Este teléfono' : device.deviceName || 'Dispositivo';
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'playback-device-option';
    option.classList.toggle('is-current-playback', isCurrentPlaybackDevice);
    option.setAttribute('aria-current', String(isCurrentPlaybackDevice));
    option.setAttribute('aria-label', isCurrentDevice ? label : `Transferir reproducción a ${label}`);
    option.disabled = playbackTransferPending || isCurrentPlaybackDevice || device.isConnected === false;
    const icon = document.createElement('span');
    icon.className = 'playback-device-option-icon';
    const deviceIcon = createPlaybackDeviceIcon(getPlaybackDeviceType(device) || device.deviceType);
    if (deviceIcon) icon.append(deviceIcon);
    const name = makeElement('span', 'playback-device-option-name', label);
    const status = makeElement('small', 'playback-device-option-status',
      device.isConnected === false ? 'Desconectado' : isCurrentDevice ? '' : 'Conectado');
    option.append(icon, name, status);
    option.addEventListener('click', () => void transferPlaybackToDevice(device.deviceId));
    const row = makeElement('div', 'playback-device-row');
    row.append(option);
    if (!isCurrentDevice) {
      const removeButton = makeButton(
        'playback-device-remove',
        `Eliminar dispositivo ${label}`,
        () => void removePlaybackDevice(device),
        '×'
      );
      removeButton.disabled = playbackDeviceRemovalPending || device.isConnected !== false;
      removeButton.title = device.isConnected === false
        ? `Eliminar ${label}`
        : `Desconecta ${label} para poder eliminarlo`;
      row.append(removeButton);
    }
    elements.playbackDeviceList.append(row);
  });
}

function setPlaybackDevicePickerOpen(open) {
  if (!elements.playbackDevicePicker) return;
  elements.playbackDevicePicker.hidden = !open;
  elements.playbackDevicePickerTrigger.setAttribute('aria-expanded', String(open));
  elements.miniPlaybackDeviceTrigger?.setAttribute('aria-expanded', String(open));
  if (open) renderPlaybackDevicePicker();
}

async function transferPlaybackToDevice(targetDeviceId) {
  if (playbackTransferPending) return;
  setPlaybackDevicePickerOpen(false);
  playbackTransferPending = true;
  const endLoading = beginPlaybackRequestLoading('Transfiriendo reproducción…');
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
  const transferId = request.transferId || playback.transferId || null;
  const requestedSongId = String(request.requestedSongId || playback.songId);
  const pendingRequestedSongId = getPendingPlaybackTakeoverSongId();
  if (pendingRequestedSongId && pendingRequestedSongId !== requestedSongId) {
    acknowledgeResult({ success: false, error: 'La transferencia fue reemplazada por una selección más reciente.' });
    return;
  }
  if (
    isActivatingPlaybackTransfer
    && transferId === activePlaybackTransferId
    && activePlaybackTransferUserId === String(state.user?._id || '')
    && requestedSongId === getSongId(getCurrentSong())
  ) {
    acknowledgeResult({ success: true });
    return;
  }
  const endLoading = beginPlaybackRequestLoading('Iniciando reproducción en este dispositivo…');
  if (transferId) {
    activePlaybackTransferId = transferId;
    activePlaybackTransferUserId = String(state.user?._id || '');
  }
  state.playbackOwnerConfirmed = false;
  isActivatingPlaybackTransfer = true;
  playbackTransferPending = true;
  renderPlaybackDevicePicker();
  try {
    let queue = state.songs;
    let index = queue.findIndex(song => getSongId(song) === requestedSongId);
    if (index < 0) {
      const sourcePlaylist = state.playlists.find(playlist => (
        (playlist.tracks || []).some(song => getSongId(song) === requestedSongId)
      ));
      if (sourcePlaylist) queue = sourcePlaylist.tracks || [];
      index = queue.findIndex(song => getSongId(song) === requestedSongId);
    }
    if (index < 0 && navigator.onLine) {
      const refreshedLibrary = await request('/songs');
      state.songs = Array.isArray(refreshedLibrary?.songs) ? refreshedLibrary.songs : [];
      if (state.user?._id) {
        void saveOfflineLibrary(state.user._id, state.songs).catch(error => {
          console.warn('No se pudo actualizar la biblioteca para transferir la canción.', error);
        });
      }
      queue = state.songs;
      index = queue.findIndex(song => getSongId(song) === requestedSongId);
      if (index < 0) {
        const sourcePlaylist = state.playlists.find(playlist => (
          (playlist.tracks || []).some(song => getSongId(song) === requestedSongId)
        ));
        if (sourcePlaylist) {
          queue = sourcePlaylist.tracks || [];
          index = queue.findIndex(song => getSongId(song) === requestedSongId);
        }
      }
    }
    if (index < 0) {
      throw new Error('La canción transferida no está disponible en la biblioteca de este dispositivo.');
    }
    const song = queue[index];
    const duration = Math.max(0, Number(playback.duration) || 0);
    let restoreTime = requestedSongId === String(playback.songId)
      ? getSharedPlaybackTime(playback)
      : 0;
    if (duration > 0 && restoreTime >= duration - 1) restoreTime = 0;
    const shouldResume = request.resumeAfterTransfer === true;
    state.remotePlayback = null;
    state.ownPlayback = null;
    state.playbackOwnerConfirmed = false;
    const alreadyPlayingRequestedSong = shouldResume
      && !elements.audio.paused
      && getSongId(getCurrentSong()) === requestedSongId;
    let loaded = alreadyPlayingRequestedSong;
    if (alreadyPlayingRequestedSong) {
      state.queue = queue;
      state.queueIndex = index;
      state.currentTrack = song;
      state.currentQueueKind = 'source';
      state.queueTitle = 'GENERAL';
      state.playbackHistory = [];
    } else {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        loaded = await playTrack(queue, index, {
          queueTitle: 'GENERAL',
          autoplay: shouldResume,
          restoreTime,
          showError: false,
          awaitPlaybackStart: shouldResume
        });
        if (loaded || attempt > 0) break;
        await new Promise(resolve => window.setTimeout(resolve, 300));
      }
    }
    if (!loaded && navigator.onLine) {
      try {
        const refreshedLibrary = await request('/songs');
        const refreshedSongs = Array.isArray(refreshedLibrary?.songs) ? refreshedLibrary.songs : [];
        const refreshedSong = refreshedSongs.find(track => getSongId(track) === requestedSongId);
        const currentSource = song.path || song.audioUrl || '';
        const refreshedSource = refreshedSong?.path || refreshedSong?.audioUrl || '';
        if (refreshedSong && refreshedSource && refreshedSource !== currentSource) {
          state.songs = refreshedSongs;
          if (state.user?._id) {
            void saveOfflineLibrary(state.user._id, state.songs).catch(error => {
              console.warn('No se pudo actualizar la biblioteca para transferir la canción.', error);
            });
          }
          loaded = await playTrack([refreshedSong], 0, {
            queueTitle: 'GENERAL',
            autoplay: shouldResume,
            restoreTime,
            showError: false,
            awaitPlaybackStart: shouldResume
          });
        }
      } catch (error) {
        console.warn('No se pudo actualizar la canción durante la transferencia.', error);
      }
    }
    if (!loaded) {
      throw new Error(elements.audio.error ? getAudioErrorMessage() : 'No se pudo iniciar la canción en este dispositivo.');
    }
    await waitForAudioMetadata();
    if (!alreadyPlayingRequestedSong) {
      elements.audio.currentTime = Math.min(restoreTime, elements.audio.duration || restoreTime);
    }
    if (shouldResume && elements.audio.paused) await elements.audio.play();
    state.upcomingQueue = [];
    persistUpcomingQueue();
    savePendingAccountQueueIds([]);
    renderPlayerQueue({ syncAccount: false });
    isActivatingPlaybackTransfer = false;
    state.ownPlayback = {
      ...playback,
      deviceId: playbackDeviceId,
      transferPending: false,
      isPlaying: shouldResume
    };
    syncPlaybackStatus(true);
    acknowledgeResult({ success: true });
  } catch (error) {
    currentTrackShouldAutoplay = false;
    if (!elements.audio.paused) elements.audio.pause();
    isActivatingPlaybackTransfer = false;
    if (activePlaybackTransferId === transferId) {
      activePlaybackTransferId = null;
      activePlaybackTransferUserId = null;
    }
    if (transferId && state.socket?.connected) {
      state.socket.emit('playbackTransferRepairFailed', { transferId });
    }
    state.ownPlayback = null;
    state.remotePlayback = { ...playback, isPlaying: false };
    updatePlayerUI();
    acknowledgeResult({ success: false, error: error.message || 'No se pudo iniciar la reproducción en este dispositivo.' });
  } finally {
    endLoading();
    isActivatingPlaybackTransfer = false;
    playbackTransferPending = false;
    renderPlaybackDevicePicker();
    updatePlayerUI();
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
    state.remotePlayback?.deviceId
    && state.remotePlayback.deviceId !== playbackDeviceId
    && state.remotePlayback.isPlaying !== false
  );
}

function getRemotePlaybackSession() {
  return state.remotePlayback?.deviceId && state.remotePlayback.deviceId !== playbackDeviceId
    ? state.remotePlayback
    : null;
}

function requestPlaybackSocket(eventName, payload, timeout = 8000) {
  return new Promise(resolve => {
    if (!state.socket?.connected) {
      resolve({ success: false, error: 'No hay conexión en tiempo real.' });
      return;
    }
    state.socket.timeout(timeout).emit(eventName, payload, (timeoutError, response) => {
      resolve(timeoutError
        ? { success: false, error: 'El servidor no confirmó la acción a tiempo.' }
        : response || { success: false, error: 'El servidor devolvió una respuesta vacía.' });
    });
  });
}

function requestPlaybackTakeover(requestedSongId = '') {
  return requestPlaybackSocket('playbackTransferRequest', {
    targetDeviceId: playbackDeviceId,
    ...(requestedSongId && { requestedSongId }),
    authoritative: true
  }, 55000);
}

function beginPlaybackRequestLoading(label = 'Comunicando con el anfitrión…') {
  playbackRequestLoadingCount += 1;
  elements.playbackWaitLabel.textContent = label;
  elements.playbackWaitIndicator.hidden = false;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    playbackRequestLoadingCount = Math.max(0, playbackRequestLoadingCount - 1);
    elements.playbackWaitIndicator.hidden = playbackRequestLoadingCount === 0;
  };
}

async function requestRemotePlaybackControl(action, details = {}, notifyError = true) {
  if (!getRemotePlaybackSession()) return false;
  const requestedSongId = String(details.songId || '');
  const requestedSong = action === 'playTrack'
    ? state.songs.find(song => getSongId(song) === requestedSongId)
      || state.playlists.flatMap(playlist => playlist.tracks || [])
        .find(song => getSongId(song) === requestedSongId)
    : null;
  if (action === 'playTrack' && !state.socket?.connected) {
    return playLibrarySongLocallyForTakeover(requestedSongId, requestedSong);
  }
  const endLoading = beginPlaybackRequestLoading(
    action === 'playTrack' ? 'Cambiando canción…' : 'Enviando control…'
  );
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
        || !state.socket?.connected
        || (action === 'playTrack' && response.error === 'El servidor no confirmó la acción a tiempo.')
      )
    ) {
      const remotePlayback = getRemotePlaybackSession();
      const requestedSongId = action === 'playTrack'
        ? String(details.songId || '')
        : action === 'next'
          ? getDisplayedAccountQueueIds()[0]
            || getSongId(state.queue[state.queueIndex + 1])
            || String(remotePlayback?.songId || '')
          : action === 'previous'
            ? getSongId(state.playbackHistory.at(-1)?.track) || String(remotePlayback?.songId || '')
            : String(remotePlayback?.songId || '');
      const localSong = state.songs.find(song => getSongId(song) === requestedSongId)
        || state.playlists.flatMap(playlist => playlist.tracks || [])
          .find(song => getSongId(song) === requestedSongId)
        || (action === 'previous' ? state.playbackHistory.at(-1)?.track : null);
      if (action === 'next') {
        const queuePosition = getDisplayedAccountQueueIds().indexOf(requestedSongId);
        if (queuePosition >= 0) {
          return await playAccountQueueTrackLocally(
            requestedSongId,
            queuePosition,
            localSong,
            { pendingTakeover: true }
          );
        }
      }
      return await playLibrarySongLocallyForTakeover(requestedSongId, localSong);
    }
    if (!response.success && notifyError) showToast(response.error || 'No se pudo controlar la reproducción remota.', true);
    return Boolean(response.success);
  } finally {
    endLoading();
  }
}

function queueRemoteSeek(position) {
  queuedRemoteSeekPosition = Math.max(0, Number(position) || 0);
  if (remoteSeekTimer) clearTimeout(remoteSeekTimer);
  remoteSeekTimer = window.setTimeout(() => {
    remoteSeekTimer = null;
    void requestRemotePlaybackControl('seek', { position: queuedRemoteSeekPosition });
  }, 120);
}

function getRemoteSeekPosition(playback) {
  return remoteSeekTimer ? queuedRemoteSeekPosition : getSharedPlaybackTime(playback);
}

function pauseForRemotePlayback() {
  if (elements.audio.paused) return;
  currentTrackShouldAutoplay = false;
  suppressRemotePlaybackPause = true;
  elements.audio.pause();
}

function handleOwnPlaybackUpdate({ userId, playback } = {}) {
  const ownUserId = String(state.user?._id || '');
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
  if (
    playback.deviceId
    && playback.deviceId !== playbackDeviceId
    && pendingPlaybackSongId
    && pendingPlaybackSongId === getSongId(getCurrentSong())
  ) return;
  if (
    !playback.deviceId
    || playback.deviceId === playbackDeviceId
  ) {
    state.ownPlayback = playback;
    state.playbackOwnerConfirmed = playback.transferPending !== true;
    const localSong = getCurrentSong();
    const expectedTime = getSharedPlaybackTime(playback);
    if (playback.transferPending === true && playback.isPlaying === false) {
      trackLoadSequence += 1;
      pauseForRemotePlayback();
    }
    if (
      playback.transferId
      && playback.isPlaying !== false
      && !playbackTransferPending
      && (
        !localSong
        || getSongId(localSong) !== String(playback.songId || '')
        || elements.audio.paused
        || Math.abs((Number(elements.audio.currentTime) || 0) - expectedTime) > 3
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
    state.remotePlayback = null;
    syncAccountQueue();
    if (sharedPlaybackClockTimer) clearInterval(sharedPlaybackClockTimer);
    sharedPlaybackClockTimer = null;
    updatePlayerUI();
    renderPlayerQueue();
    return;
  }
  const previousSongId = state.remotePlayback?.songId;
  state.ownPlayback = null;
  state.playbackOwnerConfirmed = false;
  state.remotePlayback = playback;
  syncAccountQueue();
  pauseForRemotePlayback();
  updatePlayerUI();
  renderPlayerQueue();
  if (sharedPlaybackClockTimer) clearInterval(sharedPlaybackClockTimer);
  sharedPlaybackClockTimer = playback.isPlaying !== false
    ? setInterval(() => {
      updatePlayerUI();
      if (state.currentTab === 'profile') updateProfileListeningProgress();
    }, 1000)
    : null;
  if (state.currentTab === 'profile' && String(previousSongId || '') !== String(playback.songId || '')) {
    renderProfile();
  }
}

function formatPlaylistDuration(seconds = 0) {
  const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

function getContrastingTextColor(backgroundColor) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(backgroundColor || '').trim());
  if (!match) return '#fff';
  const hex = match[1].length === 3
    ? [...match[1]].map(channel => channel + channel).join('')
    : match[1];
  const channels = [0, 2, 4].map(offset => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.179 ? '#000' : '#fff';
}

function generatePlaylistId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function showToast(message, isError = false) {
  if (!isError) return;
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.classList.add('visible');
  toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 3000);
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function makeButton(className, label, action, text) {
  const button = makeElement('button', className, text);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.addEventListener('click', action);
  return button;
}

function installImageFallback(image) {
  if (image.dataset.imageFallbackInstalled === 'true') return;
  image.dataset.imageFallbackInstalled = 'true';
  image.addEventListener('error', () => {
    const source = image.dataset.nativeDriveImage;
    const fallbackStep = Number(image.dataset.nativeImageFallback || 0);
    if (source && fallbackStep < 2) {
      image.dataset.nativeImageFallback = String(fallbackStep + 1);
      image.src = fallbackStep === 0
        ? resolveImageUrl(source, image.dataset.nativeImageSize)
        : resolveOriginalDriveImageUrl(source);
      return;
    }
    image.removeAttribute('src');
  });
}

function enqueueNativeImageDownload(image, source, priority = false, size = 'small') {
  const fileId = getDriveFileId(resolveMediaUrl(source));
  if (!fileId || !image.isConnected) return;
  const cachedUrl = getCachedImageUrl(source, '', size);
  if (cachedUrl) {
    deferredNativeImages.delete(image);
    image.src = cachedUrl;
    return;
  }
  if (!navigator.onLine) {
    deferredNativeImages.add(image);
    return;
  }

  const key = getImageCacheKey(source, size);
  let download = nativeImageDownloads.get(key);
  if (!download) {
    let resolveDownload;
    let rejectDownload;
    const promise = new Promise((resolve, reject) => {
      resolveDownload = resolve;
      rejectDownload = reject;
    });
    download = {
      key,
      source,
      size,
      promise,
      resolve: resolveDownload,
      reject: rejectDownload
    };
    nativeImageDownloads.set(key, download);
    if (priority) nativeImageDownloadQueue.unshift(download);
    else nativeImageDownloadQueue.push(download);
    processNativeImageDownloadQueue();
  } else if (priority) {
    const queuedIndex = nativeImageDownloadQueue.indexOf(download);
    if (queuedIndex > 0) {
      nativeImageDownloadQueue.splice(queuedIndex, 1);
      nativeImageDownloadQueue.unshift(download);
    }
  }

  download.promise.then(url => {
    deferredNativeImages.delete(image);
    if (image.isConnected
      && image.dataset.nativeDriveImage === source
      && image.dataset.nativeImageSize === size) image.src = url;
  }).catch(() => {
    if (!image.isConnected
      || image.dataset.nativeDriveImage !== source
      || image.dataset.nativeImageSize !== size) return;
    if (navigator.onLine) {
      image.dataset.nativeImageFallback = '1';
      image.src = resolveImageUrl(source, size);
    } else {
      deferredNativeImages.add(image);
    }
  });
}

function processNativeImageDownloadQueue() {
  while (activeNativeImageDownloads < 2 && nativeImageDownloadQueue.length) {
    const download = nativeImageDownloadQueue.shift();
    activeNativeImageDownloads += 1;
    cacheOfflineResource(download.key, download.source)
      .then(async () => {
        const url = await getOfflineObjectUrl(download.key);
        if (!url) throw new Error('No se pudo abrir la miniatura guardada.');
        const fileId = getDriveFileId(resolveMediaUrl(download.source));
        if (fileId) {
          offlineImageUrlsById.set(getImageVariantCacheId(fileId, download.size), url);
        }
        download.resolve(url);
      })
      .catch(error => {
        console.warn(`No se pudo preparar la miniatura ${download.key}.`, error);
        download.reject(error);
      })
      .finally(() => {
        if (nativeImageDownloads.get(download.key) === download) {
          nativeImageDownloads.delete(download.key);
        }
        activeNativeImageDownloads -= 1;
        processNativeImageDownloadQueue();
      });
  }
}

function observeNativeImage(image, source) {
  if (!nativeImageObserver && 'IntersectionObserver' in window) {
    nativeImageObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.target.isConnected) {
          nativeImageObserver.unobserve(entry.target);
          return;
        }
        if (!entry.isIntersecting) return;
        nativeImageObserver.unobserve(entry.target);
        enqueueNativeImageDownload(
          entry.target,
          entry.target.dataset.nativeDriveImage,
          false,
          entry.target.dataset.nativeImageSize
        );
      });
    }, { rootMargin: '240px 0px' });
  }
  if (nativeImageObserver) nativeImageObserver.observe(image);
  else window.requestAnimationFrame(() => enqueueNativeImageDownload(
    image,
    source,
    false,
    image.dataset.nativeImageSize
  ));
}

function setArtworkLoading(image, loading) {
  const frame = image.closest('.artwork-frame');
  if (!frame) return;
  frame.classList.toggle('is-loading', loading);
  frame.setAttribute('aria-busy', String(loading));
}

function watchArtworkLoading(image) {
  if (image.dataset.artworkLoadingInstalled === 'true') return;
  image.dataset.artworkLoadingInstalled = 'true';
  image.addEventListener('load', () => setArtworkLoading(image, false));
  image.addEventListener('error', () => {
    if (!image.hasAttribute('src')) setArtworkLoading(image, false);
  });
}

function setImageSource(image, source, { lazy = false, size = 'small' } = {}) {
  deferredNativeImages.delete(image);
  nativeImageObserver?.unobserve(image);
  if (!source) {
    setArtworkLoading(image, false);
    delete image.dataset.nativeDriveImage;
    image.removeAttribute('src');
    return;
  }
  installImageFallback(image);
  watchArtworkLoading(image);
  setArtworkLoading(image, true);
  image.dataset.nativeImageFallback = '0';
  image.dataset.nativeImageSize = size;
  const fileId = isAndroidNative
    ? getDriveFileId(resolveMediaUrl(source))
    : null;
  if (!fileId) {
    delete image.dataset.nativeDriveImage;
    image.src = resolveImageUrl(source, size);
    if (image.complete && image.naturalWidth > 0) setArtworkLoading(image, false);
    return;
  }

  image.dataset.nativeDriveImage = source;
  const cachedUrl = getCachedImageUrl(source, '', size);
  if (cachedUrl) {
    image.src = cachedUrl;
    if (image.complete && image.naturalWidth > 0) setArtworkLoading(image, false);
  } else {
    image.removeAttribute('src');
    if (lazy) observeNativeImage(image, source);
    else enqueueNativeImageDownload(image, source, true, size);
  }
}

function imageElement(src, className, alt = '', size = 'small') {
  const image = makeElement('img', className);
  image.alt = alt;
  image.loading = 'lazy';
  image.decoding = 'async';
  if (src) setImageSource(image, src, { lazy: true, size });
  else installImageFallback(image);
  return image;
}

function setTab(tab) {
  if (tab === state.currentTab && !state.currentPlaylistId) return;
  if (state.currentTab === 'songs' && !state.currentPlaylistId) {
    state.songSearchScrollTop = window.scrollY;
  }
  clearTimeout(songSearchTimer);
  songSearchTimer = null;
  const returningHome = tab === 'home' && state.currentTab !== 'home';
  state.currentTab = tab;
  state.currentPlaylistId = null;
  state.profileUser = null;
  state.profileStats = null;
  state.profilePlaylists = [];
  updateNavigationState();
  renderCurrentView();
  updateHomeLyrics();
  if (returningHome) showRandomSecretPhrase();
  updateHomeSecretPhrase();
  setDrawerOpen(false);
}

function setHeading(kicker, title, actionLabel, action) {
  const heading = makeElement('div', 'page-heading');
  const copy = document.createElement('div');
  copy.append(makeElement('p', 'eyebrow', kicker), makeElement('h1', '', title));
  heading.append(copy);
  if (action) heading.append(makeButton('text-button', actionLabel, action, actionLabel));
  return heading;
}

function renderPlaylistCard(playlist) {
  const card = makeButton('playlist-card', `Abrir playlist ${playlist.name}`, () => openPlaylist(playlist.id));
  const art = makeElement('span', 'playlist-art');
  const cover = getPlaylistCover(playlist);
  if (cover) art.append(imageElement(cover, '', ''));
  else art.textContent = '♫';
  const copy = makeElement('span', 'playlist-copy');
  copy.append(
    makeElement('strong', '', playlist.name || 'Playlist'),
    makeElement('small', '', `${playlist.spotifyPlaylistId
      ? playlist.playlistItems?.length || 0
      : playlist.tracks?.length || 0} canciones`)
  );
  card.append(art, copy);
  return card;
}

function renderPlaylistGrid(playlists, emptyMessage) {
  if (!playlists.length) {
    const empty = makeElement('div', 'empty-state', emptyMessage);
    return empty;
  }
  const grid = makeElement('div', 'playlist-grid');
  playlists.forEach(playlist => grid.append(renderPlaylistCard(playlist)));
  return grid;
}

function makeProfileUserLink(user) {
  const userId = String(user?._id || '');
  const username = user?.username || 'Usuario';
  if (userId && userId === String(state.user?._id || '')) {
    return makeButton('playlist-user-link', `Ver perfil de ${username}`, () => {
      closeDialog();
      openProfile();
    }, username);
  }
  const friend = state.friends.find(item => String(item._id) === userId);
  if (friend) {
    return makeButton('playlist-user-link', `Ver perfil de ${username}`, () => {
      closeDialog();
      void openFriendProfile(friend);
    }, username);
  }
  return makeElement('span', 'playlist-user-name', username);
}

function updateSongLoadingIndicator(row) {
  const isLoading = row.dataset.songId === state.loadingTrackId;
  const isSyncing = row.classList.contains('is-syncing');
  const isCoverLoading = row.dataset.coverLoading === 'true';
  const isBusy = isLoading || isSyncing || isCoverLoading;
  row.classList.toggle('is-loading', isLoading);
  row.setAttribute('aria-busy', String(isBusy));
  const cover = row.querySelector('.song-cover-loading');
  if (!cover) return;
  let spinner = cover.querySelector('.song-loading-spinner');
  if (isBusy) {
    if (!spinner) {
      spinner = makeElement('span', 'song-loading-spinner');
      spinner.setAttribute('role', 'status');
      cover.append(spinner);
    }
    spinner.classList.toggle('syncing', isSyncing);
    spinner.setAttribute('aria-label', isCoverLoading ? 'Cargando portada' : 'Cargando canción');
  } else {
    spinner?.remove();
  }
}

function watchSongCoverLoading(row, cover, image) {
  if (!image) return;
  const hasSource = Boolean(image.dataset.nativeDriveImage || image.hasAttribute('src'));
  cover.classList.toggle('is-cover-loading', hasSource);
  row.dataset.coverLoading = String(hasSource);
  updateSongLoadingIndicator(row);
  if (!hasSource) return;

  let finished = false;
  const finishLoading = () => {
    if (finished) return;
    finished = true;
    cover.classList.remove('is-cover-loading');
    row.dataset.coverLoading = 'false';
    image.removeEventListener('load', finishLoading);
    image.removeEventListener('error', finishFailedLoad);
    updateSongLoadingIndicator(row);
  };
  const finishFailedLoad = () => {
    if (image.hasAttribute('src')) return;
    finishLoading();
  };
  image.addEventListener('load', finishLoading);
  image.addEventListener('error', finishFailedLoad);
  if (image.complete && image.naturalWidth > 0) finishLoading();
  else if (image.complete && !image.hasAttribute('src') && !image.dataset.nativeDriveImage) {
    finishLoading();
  }
}

function renderSongRow(song, options = {}) {
  if (song.spotifyUnavailable) {
    const row = makeElement('article', `song-row detail-song-row spotify-unavailable-song-row`);
    const coverWrap = makeElement('span', 'song-cover-loading');
    const coverImage = imageElement(song.cover || '', 'song-cover', '');
    coverWrap.append(coverImage);
    const canSuggestSpotifyTrack = options.playlist?.spotifyPlaylistId
      && String(options.playlist.ownerId) === String(state.user?._id)
      && song.spotifyTrackId
      && String(song.artist || '').toLocaleLowerCase() !== 'artista desconocido';
    const spotifyDuration = Math.max(0, Number(song.duration) || 0);
    if (canSuggestSpotifyTrack && spotifyDuration > 0) {
      coverWrap.append(makeElement(
        'span',
        'spotify-import-duration-badge',
        `${formatTime(spotifyDuration)}`
      ));
    }
    row.append(coverWrap);
    const copy = makeElement('span', 'song-copy');
    copy.append(
      makeElement('strong', '', song.name || 'Contenido no disponible'),
      makeElement('small', '', song.artist || 'Artista desconocido'),
      makeElement('small', 'spotify-unavailable-label', 'No disponible en AMGC')
    );
    row.append(copy);
    if (song.externalUrl) {
      const spotifyLink = makeElement('a', 'spotify-track-open', 'Spotify');
      spotifyLink.href = song.externalUrl;
      spotifyLink.target = '_blank';
      spotifyLink.rel = 'noopener noreferrer';
      row.append(spotifyLink);
    }
    if (canSuggestSpotifyTrack) {
      row.append(makeButton('song-action', 'Sugerir para el catálogo', button => {
        void suggestSpotifyPlaylistTrack(options.playlist, song, button);
      }, '＋'));
    }
    return row;
  }
  const songId = getSongId(song);
  const row = makeElement('article', `song-row${options.detail ? ' detail-song-row' : ''}`);
  row.dataset.songId = songId;
  const isSyncing = Boolean(options.playlist && (
    song.syncPending || pendingPlaylistAdds.has(`${options.playlist.id}:${songId}`)
  ));
  const isLoading = state.loadingTrackId === songId;
  if (isLoading || isSyncing) row.classList.add(isSyncing ? 'is-syncing' : 'is-loading');
  const play = makeButton('song-play', `Reproducir ${song.name || 'canción'}`, () => {
    const sourceQueue = options.queue || state.songs;
    const index = options.playlist?.spotifyPlaylistId
      ? sourceQueue.findIndex(entry => entry.spotifyPosition === song.spotifyPosition)
      : sourceQueue.findIndex(entry => getSongId(entry) === songId);
    if (index >= 0) void playTrack(sourceQueue, index, { queueTitle: options.queueTitle || 'GENERAL' });
  });
  const coverWrap = makeElement('span', 'song-cover-loading');
  const coverImage = imageElement(getSongCover(song), 'song-cover', '');
  coverWrap.append(coverImage);
  if (state.offlineAudioSongIds.has(songId)) {
    const offlineBadge = makeElement('span', 'offline-ready-badge');
    offlineBadge.setAttribute('role', 'img');
    offlineBadge.setAttribute('aria-label', 'Audio disponible sin conexión');
    offlineBadge.title = 'Audio guardado en este dispositivo';
    coverWrap.append(offlineBadge);
  }
  if (isLoading || isSyncing) {
    coverWrap.append(makeElement('span', `song-loading-spinner${isSyncing ? ' syncing' : ''}`));
  }
  watchSongCoverLoading(row, coverWrap, coverImage);
  const copy = makeElement('span', 'song-copy');
  copy.append(
    makeElement('strong', '', song.name || 'Canción sin título'),
    makeElement('small', '', song.artist || 'Artista desconocido')
  );
  if (song.lyricsReady) {
    const lyricsLabel = makeElement('span', 'lyrics-ready');
    const lyricsIcon = makeElement('img');
    lyricsIcon.src = './img/lyrics.png';
    lyricsIcon.alt = '';
    lyricsLabel.append(lyricsIcon, makeElement('span', '', 'LETRA'));
    copy.append(lyricsLabel);
  }
  play.append(coverWrap, copy);
  row.append(play);
  if (options.detail) {
    const addedBy = song.addedBy && typeof song.addedBy === 'object' ? song.addedBy : null;
    const meta = makeElement('div', 'playlist-track-meta');
    if (addedBy?._id) {
      meta.append(
        imageElement(getUserPhoto(addedBy), 'playlist-meta-avatar', ''),
        makeProfileUserLink(addedBy)
      );
    } else {
      meta.append(makeElement('span', '', song.addedByName || 'Desconocido'));
    }
    const addedAt = song.addedAt
      ? new Date(song.addedAt).toLocaleDateString('es-CL', { timeZone: 'America/Santiago' })
      : '--';
    meta.append(
      makeElement('span', '', addedAt),
      makeElement('span', '', formatTime(Number(song.duration) || 0))
    );
    row.append(meta);
  }
  if (options.onRemove) {
    row.append(makeButton('song-action', 'Quitar de playlist', options.onRemove, '−'));
  } else if (state.sharedQueueRole !== 'follower') {
    row.append(makeButton('song-action', 'Agregar a playlist', () => openAddToPlaylist(songId), '＋'));
  }
  if (options.playlist && options.canReorder) {
    row.dataset.playlistPosition = String(options.position);
    row.append(makeButton('drag-handle', 'Arrastrar para cambiar posición', () => {}, '⠿'));
    setupTouchReorder(row, '[data-playlist-position]', (from, to) => {
      void reorderPlaylistTracks(options.playlist, from, to);
    });
  }
  setupQueueAddSwipe(row, song);
  return row;
}

function renderSongList(songs, emptyMessage, options = {}) {
  if (!songs.length) return makeElement('div', 'empty-state', emptyMessage);
  const list = makeElement('div', 'song-list');
  const fragment = document.createDocumentFragment();
  songs.forEach((song, position) => {
    fragment.append(renderSongRow(song, { ...options, position }));
  });
  list.append(fragment);
  return list;
}

function addSectionHeading(container, label, actionLabel, action) {
  const heading = makeElement('div', 'section-heading');
  heading.append(makeElement('h2', '', label));
  if (action) heading.append(makeButton('text-button', actionLabel, action, actionLabel));
  container.append(heading);
}

function renderHome() {
  const view = elements.mainView;
  view.replaceChildren();
  view.classList.add('home-view');
  const symbol = makeElement('div', 'home-symbol');
  symbol.setAttribute('aria-label', 'AMGC');
  symbol.style.transform = `rotate(${homeSpinRotation}deg)`;
  symbol.innerHTML = '<svg viewBox="0 0 120 120" aria-hidden="true"><g stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M60 7v106M7 60h106M22 22l76 76M22 98l76-76" /></g></svg>';
  view.append(symbol);
  resumeHomeSpin();
  updateHomeLyrics();
}

function renderSongs() {
  clearTimeout(songSearchTimer);
  songSearchTimer = null;
  const view = elements.mainView;
  view.classList.remove('home-view');
  view.replaceChildren();
  view.append(setHeading('GENERAL', 'Canciones', '▶ Reproducir todo', () => {
    if (state.songs.length) void playTrack(state.songs, 0);
    else showToast('No hay canciones disponibles para reproducir.', true);
  }));
  if (state.catalogLoading || (state.catalogLoadError && state.songs.length)) {
    let loadingMessage = state.catalogLoadError;
    if (state.catalogLoading) {
      loadingMessage = state.songs.length
        ? 'Actualizando el catálogo…'
        : 'Conectando con el catálogo…';
    }
    const loadingStatus = makeElement(
      'p',
      'catalog-loading-status',
      loadingMessage
    );
    loadingStatus.setAttribute('role', 'status');
    loadingStatus.setAttribute('aria-live', 'polite');
    if (state.catalogLoading) {
      const loadingSpinner = makeElement('span', 'sync-spinner');
      loadingSpinner.setAttribute('aria-hidden', 'true');
      loadingStatus.prepend(loadingSpinner);
    }
    view.append(loadingStatus);
  }
  const search = makeElement('label', 'search-box');
  search.append(makeElement('span', '', '⌕'));
  const input = makeElement('input');
  input.type = 'search';
  input.placeholder = 'Buscar canción o artista';
  input.setAttribute('aria-label', 'Buscar canción o artista');
  input.value = state.songSearchQuery;
  search.append(input);
  const results = makeElement('div');
  const searchableSongs = state.songs.map(song => ({
    song,
    text: `${song.name || ''} ${song.artist || ''}`.toLocaleLowerCase()
  }));
  const renderResults = () => {
    if (!input.isConnected) return;
    const query = state.songSearchQuery.trim().toLocaleLowerCase();
    const filtered = query
      ? searchableSongs.filter(entry => entry.text.includes(query)).map(entry => entry.song)
      : state.songs;
    const emptyMessage = state.catalogLoading
      ? 'Esperando el catálogo…'
      : state.catalogLoadError || (query ? 'No se encontraron canciones.' : 'No hay canciones disponibles.');
    results.replaceChildren(renderSongList(filtered, emptyMessage));
  };
  input.addEventListener('input', () => {
    state.songSearchQuery = input.value;
    clearTimeout(songSearchTimer);
    songSearchTimer = window.setTimeout(renderResults, 100);
  });
  view.append(search, results);
  renderResults();

  const suggestionCard = makeElement('section', 'suggestion-card');
  suggestionCard.append(
    makeElement('h2', '', '¿Qué canción falta?'),
    makeElement('p', '', 'Envía una sugerencia al catálogo.')
  );
  suggestionCard.append(makeButton('text-button suggestion-open', 'Sugerir canción', () => openDialog(elements.suggestionForm), '＋ SUGERIR CANCIÓN'));
  view.append(suggestionCard);

  view.append(renderSpotifyLikesSection());

  if (state.suggestions.length) {
    addSectionHeading(view, 'Sugerencias recientes', `${state.suggestions.length}`, null);
    const suggestionList = makeElement('div', 'song-list');
    state.suggestions.forEach(suggestion => {
      const row = makeElement('div', 'song-row suggestion-row');
      row.append(
        makeElement('span', 'suggestion-note-icon', '＋'),
        makeElement('span', 'song-copy'),
      );
      const copy = row.lastElementChild;
      copy.append(
        makeElement('strong', '', suggestion.name),
        makeElement('small', '', `${suggestion.artist} · ${suggestion.suggestedByName || 'AMGC'}`)
      );
      suggestionList.append(row);
    });
    view.append(suggestionList);
  }
}

function renderSpotifyLikesSection() {
  const section = makeElement('details', 'spotify-likes-section');
  section.id = 'spotify-likes-section';
  section.open = state.spotifySectionOpen;
  section.append(makeElement('summary', '', 'Mis Me gusta de Spotify'));

  const status = makeElement('p', 'spotify-likes-status', state.spotifyStatusMessage);
  status.id = 'spotify-likes-status';
  status.setAttribute('aria-live', 'polite');
  section.append(status);

  const toolbar = makeElement('div', 'spotify-likes-toolbar');
  const connectButton = makeButton('secondary-button', 'Conectar Spotify', () => {
    void connectSpotify(connectButton);
  }, 'Conectar Spotify');
  connectButton.dataset.spotifyConnect = 'true';
  connectButton.textContent = state.spotifyConnected
    ? 'Actualizar permisos de Spotify'
    : 'Conectar Spotify';
  connectButton.hidden = state.spotifyConnected && state.spotifyPlaylistScopesGranted;
  connectButton.disabled = !state.spotifyConfigured;
  const refreshButton = makeButton('text-button', 'Actualizar lista', () => {
    void loadSpotifyLikedTracks({ refresh: true });
  }, 'Actualizar');
  refreshButton.hidden = !state.spotifyConnected;
  const disconnectButton = makeButton('text-button', 'Desconectar', () => {
    void disconnectSpotify(disconnectButton);
  }, 'Desconectar');
  disconnectButton.hidden = !state.spotifyConnected;
  const importButton = makeButton('primary-button', 'Importar seleccionadas como sugerencias', () => {
    void importSpotifySelections(importButton);
  }, '＋ Importar seleccionadas como sugerencias');
  importButton.hidden = !state.spotifySelectedTrackIds.size;
  const loadMoreButton = makeButton('text-button', 'Cargar más canciones', () => {
    void loadSpotifyLikedTracks({ append: true });
  }, 'Cargar más canciones');
  loadMoreButton.hidden = !state.spotifyHasMore;
  toolbar.append(connectButton, refreshButton, disconnectButton, importButton, loadMoreButton);
  section.append(toolbar);

  if (state.spotifyConnected) {
    const search = makeElement('input', 'settings-input spotify-likes-search');
    search.type = 'search';
    search.placeholder = 'Buscar entre las canciones cargadas...';
    search.value = state.spotifySearch;
    search.setAttribute('aria-label', 'Buscar entre los Me gusta de Spotify');
    search.addEventListener('input', () => {
      state.spotifySearch = search.value;
      renderSpotifyLikedTracks(list);
    });
    section.append(search);
  }
  const list = makeElement('div', 'spotify-likes-list');
  section.append(list);
  renderSpotifyLikedTracks(list);
  section.addEventListener('toggle', () => {
    state.spotifySectionOpen = section.open;
    if (section.open && state.spotifyConnected && !state.spotifyTracksLoaded) {
      void loadSpotifyLikedTracks();
    }
  });
  if (state.spotifySectionOpen && state.spotifyConnected && !state.spotifyTracksLoaded) {
    void loadSpotifyLikedTracks();
  }
  return section;
}

function updateSpotifyPlaylistImportForm() {
  const status = document.getElementById('spotify-playlist-import-status');
  const connectButton = document.getElementById('spotify-playlist-connect-button');
  const loadButton = document.getElementById('spotify-playlist-load-button');
  const moreButton = document.getElementById('spotify-playlist-more-button');
  if (!status || !connectButton || !loadButton || !moreButton) return;
  connectButton.textContent = state.spotifyConnected
    ? 'Actualizar permisos de Spotify'
    : 'Conectar Spotify';
  connectButton.hidden = state.spotifyConnected && state.spotifyPlaylistScopesGranted;
  connectButton.disabled = !state.spotifyConfigured;
  loadButton.textContent = state.spotifyPlaylistsLoaded ? 'Actualizar playlists' : 'Cargar playlists';
  loadButton.hidden = !state.spotifyConnected || !state.spotifyPlaylistScopesGranted;
  moreButton.hidden = !state.spotifyPlaylistsHasMore;
  status.textContent = !state.spotifyConnected
    ? 'Conecta Spotify para importar una playlist vinculada.'
    : !state.spotifyPlaylistScopesGranted
      ? 'Actualiza los permisos de Spotify para permitir la lectura de playlists.'
      : state.spotifyPlaylistsLoaded
        ? `${state.spotifyPlaylists.length} playlists cargadas.`
        : 'Carga las playlists de tu cuenta de Spotify.';
  renderSpotifyPlaylistRows(document.getElementById('spotify-playlist-list'));
}

function renderSpotifyPlaylistRows(list) {
  if (!list) return;
  list.replaceChildren();
  for (const spotifyPlaylist of state.spotifyPlaylists) {
    const row = makeElement('article', 'spotify-playlist-row');
    const artwork = makeSpotifyPlaylistArtwork(spotifyPlaylist.image, spotifyPlaylist.name);
    const info = makeElement('span', 'spotify-like-info');
    info.append(
      makeElement('strong', '', spotifyPlaylist.name),
      makeElement('small', '', `${spotifyPlaylist.ownerName} · ${spotifyPlaylist.totalTracks} canciones`)
    );
    const action = makeButton(
      'secondary-button',
      spotifyPlaylist.linkedPlaylistId ? 'Sincronizar' : 'Importar',
      button => void importSpotifyPlaylist(spotifyPlaylist, button)
    );
    action.disabled = !state.spotifyConnected || !state.spotifyPlaylistScopesGranted;
    row.append(artwork, info, action);
    list.append(row);
  }
}

function makeSpotifyPlaylistArtwork(imageUrl, playlistName) {
  const frame = makeElement('span', 'spotify-playlist-cover-frame');
  frame.setAttribute('role', 'img');
  frame.setAttribute('aria-label', `Portada de ${playlistName || 'playlist'}`);
  const placeholder = makeElement('span', 'spotify-playlist-cover-placeholder', '♫');
  placeholder.setAttribute('aria-hidden', 'true');
  frame.append(placeholder);

  if (typeof imageUrl !== 'string' || !imageUrl) return frame;

  const image = makeElement('img', 'spotify-playlist-cover');
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  const spinner = makeElement('span', 'spotify-playlist-cover-spinner');
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

async function loadSpotifyPlaylists({ append = false } = {}) {
  if (!state.spotifyConnected || !state.spotifyPlaylistScopesGranted) return;
  const offset = append ? state.spotifyPlaylistsNextOffset : 0;
  const loadButton = document.getElementById('spotify-playlist-load-button');
  const moreButton = document.getElementById('spotify-playlist-more-button');
  const status = document.getElementById('spotify-playlist-import-status');
  if (loadButton) loadButton.disabled = true;
  if (moreButton) moreButton.disabled = true;
  if (status) status.textContent = append ? 'Cargando más playlists...' : 'Cargando playlists de Spotify...';
  try {
    const result = await request(`/spotify/playlists?offset=${offset}`);
    const rows = Array.isArray(result.playlists) ? result.playlists : [];
    state.spotifyPlaylists = append ? [...state.spotifyPlaylists, ...rows] : rows;
    state.spotifyPlaylistsNextOffset = Number(result.nextOffset) || offset;
    state.spotifyPlaylistsHasMore = result.hasMore === true;
    state.spotifyPlaylistsLoaded = true;
    updateSpotifyPlaylistImportForm();
    if (status) status.textContent = `${state.spotifyPlaylists.length} de ${Number(result.total) || 0} playlists cargadas.`;
  } catch (error) {
    console.error('No se pudieron cargar las playlists de Spotify.', error);
    if (status) status.textContent = error.message || 'No se pudieron cargar las playlists de Spotify.';
    showToast(error.message || 'No se pudieron cargar las playlists de Spotify.', true);
  } finally {
    if (loadButton) loadButton.disabled = false;
    if (moreButton) moreButton.disabled = false;
  }
}

async function importSpotifyPlaylist(spotifyPlaylist, button) {
  button.disabled = true;
  try {
    const result = await request(
      `/spotify/playlists/${encodeURIComponent(spotifyPlaylist.id)}/import`,
      { method: 'POST' }
    );
    closeDialog();
    state.pendingSongId = null;
    state.selectedSongId = null;
    await loadLibrary();
    spotifyPlaylistSyncs.add(String(result.playlistId));
    openPlaylist(result.playlistId);
    spotifyPlaylistSyncs.delete(String(result.playlistId));
    showToast(result.changed ? `Playlist “${spotifyPlaylist.name}” importada o sincronizada.` : `“${spotifyPlaylist.name}” ya está sincronizada.`);
    spotifyPlaylist.linkedPlaylistId = result.playlistId;
  } catch (error) {
    console.error('No se pudo importar o sincronizar la playlist de Spotify.', error);
    showToast(error.message || 'No se pudo importar la playlist de Spotify.', true);
    button.disabled = false;
  }
}

async function syncSpotifyPlaylist(playlist) {
  const playlistId = String(playlist?.id || '');
  if (
    !playlistId
    || !playlist.spotifyPlaylistId
    || !state.spotifyConnected
    || !state.spotifyPlaylistScopesGranted
    || !navigator.onLine
    || spotifyPlaylistSyncs.has(playlistId)
  ) return;
  spotifyPlaylistSyncs.add(playlistId);
  try {
    const result = await request(
      `/spotify/playlists/${encodeURIComponent(playlist.spotifyPlaylistId)}/import`,
      { method: 'POST' }
    );
    if (result.changed) await loadLibrary();
  } catch (error) {
    console.error('No se pudo comprobar la sincronización de Spotify.', error);
    showToast(error.message || 'No se pudo sincronizar la playlist de Spotify.', true);
  } finally {
    spotifyPlaylistSyncs.delete(playlistId);
  }
}

async function suggestSpotifyPlaylistTrack(playlist, track, button) {
  button.disabled = true;
  try {
    const result = await request('/spotify/import', {
      method: 'POST',
      body: JSON.stringify({
        spotifyPlaylistId: playlist.id,
        trackIds: [track.spotifyTrackId]
      })
    });
    showToast(result.imported
      ? `“${track.name}” se añadió a sugerencias para el catálogo.`
      : `“${track.name}” ya está en el catálogo o en sugerencias.`);
  } catch (error) {
    console.error('No se pudo sugerir la canción de Spotify.', error);
    showToast(error.message || 'No se pudo enviar la canción a sugerencias.', true);
  } finally {
    button.disabled = false;
  }
}

function renderSpotifyLikedTracks(list) {
  const query = state.spotifySearch.trim().toLocaleLowerCase();
  const tracks = state.spotifyTracks.filter(track =>
    !query || `${track.name} ${track.artist}`.toLocaleLowerCase().includes(query)
  );
  const scrollTop = list.scrollTop;
  const fragment = document.createDocumentFragment();
  if (!tracks.length) {
    list.replaceChildren();
    list.append(makeElement('p', 'empty-state',
      state.spotifyTracks.length ? 'No hay canciones que coincidan con la búsqueda.' : 'No se encontraron canciones guardadas.'));
    return;
  }
  tracks.forEach(track => {
    const row = makeElement('div', 'spotify-like-row');
    const checkbox = makeElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.spotifySelectedTrackIds.has(track.id);
    checkbox.disabled = Boolean(track.isInProgram || track.isSuggested);
    checkbox.setAttribute('aria-label', `Seleccionar ${track.name} de ${track.artist}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked && state.spotifySelectedTrackIds.size >= 100) {
        checkbox.checked = false;
        showToast('Puedes importar hasta 100 canciones por vez.', true);
        return;
      }
      if (checkbox.checked) state.spotifySelectedTrackIds.add(track.id);
      else state.spotifySelectedTrackIds.delete(track.id);
      const importButton = list.closest('.spotify-likes-section')
        ?.querySelector('[aria-label="Importar seleccionadas como sugerencias"]');
      if (importButton) importButton.hidden = !state.spotifySelectedTrackIds.size;
    });
    row.append(checkbox);
    if (track.coverUrl) row.append(imageElement(track.coverUrl, 'spotify-like-cover', ''));
    const copy = makeElement('span', 'spotify-like-copy');
    copy.append(
      makeElement('strong', '', track.name),
      makeElement('small', '', track.artist)
    );
    if (track.isInProgram || track.isSuggested) {
      copy.append(makeElement('small', 'spotify-like-badge',
        track.isInProgram ? 'Ya está en AMGC' : 'Ya sugerida'));
    }
    row.append(copy);
    fragment.append(row);
  });
  list.replaceChildren(fragment);
  list.scrollTop = Math.min(scrollTop, Math.max(0, list.scrollHeight - list.clientHeight));
}

function updateSpotifyLikesSection() {
  const section = document.getElementById('spotify-likes-section');
  if (!section) return;
  const status = section.querySelector('#spotify-likes-status');
  if (status) status.textContent = state.spotifyStatusMessage;
  const button = label => section.querySelector(`[aria-label="${label}"]`);
  const connectButton = section.querySelector('[data-spotify-connect]');
  if (connectButton) {
    connectButton.textContent = state.spotifyConnected
      ? 'Actualizar permisos de Spotify'
      : 'Conectar Spotify';
    connectButton.hidden = state.spotifyConnected && state.spotifyPlaylistScopesGranted;
    connectButton.disabled = !state.spotifyConfigured;
  }
  const refreshButton = button('Actualizar');
  if (refreshButton) refreshButton.hidden = !state.spotifyConnected;
  const disconnectButton = button('Desconectar');
  if (disconnectButton) disconnectButton.hidden = !state.spotifyConnected;
  const importButton = button('Importar seleccionadas como sugerencias');
  if (importButton) importButton.hidden = !state.spotifySelectedTrackIds.size;
  const loadMoreButton = button('Cargar más canciones');
  if (loadMoreButton) loadMoreButton.hidden = !state.spotifyHasMore;
  const list = section.querySelector('.spotify-likes-list');
  if (list) renderSpotifyLikedTracks(list);
  updateSpotifyPlaylistImportForm();
}

async function loadSpotifyStatus(loadTracks = false) {
  if (!state.user?._id || !state.token || !navigator.onLine) return;
  if (spotifyStatusRequest) return spotifyStatusRequest;
  const userId = String(state.user._id);
  const statusRequest = (async () => {
    try {
      const result = await request('/spotify/status');
      if (String(state.user?._id || '') !== userId) return;
      const wasConnected = state.spotifyConnected;
      const wasConfigured = state.spotifyConfigured;
      const hadPlaylistScopes = state.spotifyPlaylistScopesGranted;
      state.spotifyConfigured = result.configured === true;
      state.spotifyConnected = result.connected === true;
      state.spotifyPlaylistScopesGranted = result.playlistScopesGranted === true;
      if (!state.spotifyConnected) {
        spotifyApiAccessToken = '';
        spotifyApiAccessTokenExpiresAt = 0;
        spotifyApiAccessTokenUserId = '';
        spotifyApiAccessTokenRequest = null;
      }
      if (!state.spotifyConnected && wasConnected) {
        state.spotifyTracks = [];
        state.spotifyTracksLoaded = false;
        state.spotifySelectedTrackIds.clear();
        state.spotifyNextOffset = 0;
        state.spotifyTotal = 0;
        state.spotifyHasMore = false;
        state.spotifyPlaylists = [];
        state.spotifyPlaylistsLoaded = false;
        state.spotifyPlaylistsNextOffset = 0;
        state.spotifyPlaylistsHasMore = false;
      }
      state.spotifyStatusMessage = state.spotifyConnected
        ? state.spotifyTracksLoaded
          ? `${state.spotifyTracks.length} de ${state.spotifyTotal} canciones cargadas.${state.spotifyPlaylistScopesGranted ? '' : ' Actualiza permisos para importar playlists.'}`
          : `Spotify conectado.${state.spotifyPlaylistScopesGranted ? ' Abre esta sección para cargar tus Me gusta.' : ' Actualiza permisos para importar playlists.'}`
        : state.spotifyConfigured
          ? 'Conecta Spotify para cargar tus canciones guardadas.'
          : 'Spotify requiere configuración del servidor.';
      if (state.currentTab === 'songs' && !state.currentPlaylistId) {
        if (
          wasConnected !== state.spotifyConnected
          || wasConfigured !== state.spotifyConfigured
          || hadPlaylistScopes !== state.spotifyPlaylistScopesGranted
        ) {
          renderCurrentView();
        } else {
          updateSpotifyLikesSection();
        }
      }
      updateSpotifyPlaylistImportForm();
      if (
        state.spotifyConnected
        && state.spotifyPlaylistScopesGranted
        && (wasConnected !== state.spotifyConnected || hadPlaylistScopes !== state.spotifyPlaylistScopesGranted)
        && state.currentPlaylistId
      ) {
        const activePlaylist = [...state.playlists, ...state.profilePlaylists]
          .find(playlist => String(playlist.id) === String(state.currentPlaylistId));
        if (activePlaylist?.spotifyPlaylistId) void syncSpotifyPlaylist(activePlaylist);
      }
      if (state.spotifyConnected && (loadTracks || state.spotifySectionOpen)) {
        await loadSpotifyLikedTracks();
      }
    } catch (error) {
      if (String(state.user?._id || '') !== userId) return;
      console.error('No se pudo consultar el estado de Spotify.', error);
      state.spotifyStatusMessage = error.message || 'No se pudo consultar Spotify.';
      updateSpotifyLikesSection();
    }
  })();
  spotifyStatusRequest = statusRequest;
  try {
    await statusRequest;
  } finally {
    if (spotifyStatusRequest === statusRequest) spotifyStatusRequest = null;
  }
}

async function loadSpotifyLikedTracks({ refresh = false, append = false } = {}) {
  if (!state.spotifyConnected) return;
  if (spotifyTracksRequest) return spotifyTracksRequest;
  const userId = String(state.user?._id || '');
  const offset = append ? state.spotifyNextOffset : 0;
  const status = document.getElementById('spotify-likes-status');
  const loadMoreButton = document.querySelector('#spotify-likes-section [aria-label="Cargar más canciones"]');
  const refreshButton = document.querySelector('#spotify-likes-section [aria-label="Actualizar"]');
  if (append && loadMoreButton) loadMoreButton.disabled = true;
  else if (refreshButton) refreshButton.disabled = true;
  state.spotifyStatusMessage = append
    ? 'Cargando más canciones guardadas de Spotify...'
    : 'Cargando canciones guardadas de Spotify...';
  if (status) status.textContent = state.spotifyStatusMessage;
  const tracksRequest = (async () => {
    try {
      const page = await fetchSpotifyLikedTracksPage(offset, getSpotifyApiAccessToken);
      if (String(state.user?._id || '') !== userId) return;
      const statusResult = await request('/spotify/track-status', {
        method: 'POST',
        body: JSON.stringify({
          tracks: page.tracks.map(({ id, name, artist, primaryArtist }) => ({
            id,
            name,
            artist,
            primaryArtist
          }))
        })
      });
      if (String(state.user?._id || '') !== userId) return;
      if (!Array.isArray(statusResult?.statuses)) {
        throw new Error('El servidor devolvió un estado de catálogo inválido.');
      }
      const statuses = new Map(statusResult.statuses.map(status => [status.id, status]));
      const tracks = page.tracks.map(track => ({ ...track, ...statuses.get(track.id) }));
      state.spotifyTracks = append ? [...state.spotifyTracks, ...tracks] : tracks;
      state.spotifyNextOffset = Number(page.nextOffset) || offset;
      state.spotifyTotal = Number(page.total) || 0;
      state.spotifyHasMore = Boolean(page.hasMore);
      state.spotifyTracksLoaded = true;
      if (refresh) state.spotifySelectedTrackIds.clear();
      state.spotifySelectedTrackIds = new Set(
        [...state.spotifySelectedTrackIds].filter(id => state.spotifyTracks.some(track =>
          track.id === id && !track.isInProgram && !track.isSuggested
        ))
      );
      state.spotifyStatusMessage = `${state.spotifyTracks.length} de ${state.spotifyTotal} canciones cargadas.`;
      updateSpotifyLikesSection();
    } catch (error) {
      if (String(state.user?._id || '') !== userId) return;
      console.error('No se pudieron cargar los Me gusta de Spotify.', error);
      state.spotifyStatusMessage = error.message || 'No se pudieron cargar tus Me gusta.';
      updateSpotifyLikesSection();
      showToast(state.spotifyStatusMessage, true);
    } finally {
      const currentLoadMoreButton = document.querySelector('#spotify-likes-section [aria-label="Cargar más canciones"]');
      const currentRefreshButton = document.querySelector('#spotify-likes-section [aria-label="Actualizar"]');
      if (currentLoadMoreButton) currentLoadMoreButton.disabled = false;
      if (currentRefreshButton) currentRefreshButton.disabled = false;
      if (spotifyTracksRequest === tracksRequest) spotifyTracksRequest = null;
    }
  })();
  spotifyTracksRequest = tracksRequest;
  return tracksRequest;
}

async function connectSpotify(button) {
  button.disabled = true;
  try {
    const result = await request('/spotify/connect', { method: 'POST' });
    if (typeof result?.authorizationUrl !== 'string') {
      throw new Error('El servidor no devolvió el enlace de autorización de Spotify.');
    }
    if (isAndroidNative) await nativeMedia.openSpotifyAuthorization({ url: result.authorizationUrl });
    else window.location.assign(result.authorizationUrl);
  } catch (error) {
    console.error('No se pudo iniciar la conexión con Spotify.', error);
    showToast(error.message || 'No se pudo conectar Spotify.', true);
    button.disabled = false;
  }
}

async function getSpotifyApiAccessToken(forceRefresh = false) {
  const userId = String(state.user?._id || '');
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
    const result = await request(`/spotify/access-token${forceRefresh ? '?refresh=true' : ''}`);
    if (typeof result?.accessToken !== 'string' || !result.accessToken) {
      throw new Error('El servidor no devolvió un token válido para Spotify.');
    }
    if (String(state.user?._id || '') !== userId || !state.spotifyConnected) {
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

async function disconnectSpotify(button) {
  button.disabled = true;
  try {
    await request('/spotify/disconnect', { method: 'POST' });
    state.spotifyConnected = false;
    state.spotifyPlaylistScopesGranted = false;
    spotifyApiAccessToken = '';
    spotifyApiAccessTokenExpiresAt = 0;
    spotifyApiAccessTokenUserId = '';
    spotifyApiAccessTokenRequest = null;
    state.spotifyTracks = [];
    state.spotifyTracksLoaded = false;
    state.spotifySelectedTrackIds.clear();
    state.spotifyNextOffset = 0;
    state.spotifyTotal = 0;
    state.spotifyHasMore = false;
    state.spotifyPlaylists = [];
    state.spotifyPlaylistsLoaded = false;
    state.spotifyPlaylistsNextOffset = 0;
    state.spotifyPlaylistsHasMore = false;
    state.spotifySearch = '';
    state.spotifyStatusMessage = 'Spotify desconectado.';
    updateSpotifyPlaylistImportForm();
    renderCurrentView();
    showToast('Spotify desconectado.');
  } catch (error) {
    console.error('No se pudo desconectar Spotify.', error);
    showToast(error.message || 'No se pudo desconectar Spotify.', true);
    button.disabled = false;
  }
}

async function importSpotifySelections(button) {
  const trackIds = [...state.spotifySelectedTrackIds];
  if (!trackIds.length) return;
  const tracks = state.spotifyTracks
    .filter(track => state.spotifySelectedTrackIds.has(track.id))
    .map(({ id, name, artist, coverUrl, duration }) => ({ id, name, artist, coverUrl, duration }));
  button.disabled = true;
  state.spotifyStatusMessage = 'Importando canciones como sugerencias...';
  const status = document.getElementById('spotify-likes-status');
  if (status) status.textContent = state.spotifyStatusMessage;
  try {
    const result = await request('/spotify/import', {
      method: 'POST',
      body: JSON.stringify({ tracks })
    });
    state.spotifySelectedTrackIds.clear();
    await loadSecondaryLibraryData();
    await loadSpotifyLikedTracks({ refresh: true });
    state.spotifyStatusMessage = `Se importaron ${result.imported} sugerencias; ${result.duplicates} ya existían.`;
    if (state.currentTab === 'songs' && !state.currentPlaylistId) renderCurrentView();
    showToast(state.spotifyStatusMessage);
  } catch (error) {
    console.error('No se pudieron importar las canciones de Spotify.', error);
    state.spotifyStatusMessage = error.message || 'No se pudieron importar las canciones.';
    if (state.currentTab === 'songs' && !state.currentPlaylistId) renderCurrentView();
    showToast(state.spotifyStatusMessage, true);
  }
}

function renderPlaylistDetail() {
  const playlist = [...state.playlists, ...state.profilePlaylists]
    .find(item => String(item.id) === String(state.currentPlaylistId));
  if (!playlist) {
    state.currentPlaylistId = null;
    state.currentTab = 'home';
    renderHome();
    return;
  }
  const view = elements.mainView;
  view.classList.remove('home-view');
  view.replaceChildren();
  view.append(imageElement(
    getPlaylistCover(playlist, 'large'),
    'playlist-detail-cover',
    'Portada de playlist',
    'large'
  ));
  const copy = makeElement('div', 'playlist-detail-copy');
  const isOwner = String(playlist.ownerId || '') === String(state.user?._id || '');
  const isShared = (playlist.sharedWith || []).some(member => String(member?._id || member) === String(state.user?._id || ''));
  const isSpotifyLinked = Boolean(playlist.spotifyPlaylistId);
  const displayTracks = isSpotifyLinked && Array.isArray(playlist.playlistItems)
    ? playlist.playlistItems
    : playlist.tracks || [];
  const creator = { _id: playlist.ownerId, username: playlist.ownerName || 'Desconocido', profilePhoto: playlist.ownerPhoto || '' };
  copy.append(
    makeElement('p', 'eyebrow', 'PLAYLIST'),
    makeElement('h1', '', playlist.name || 'Playlist'),
    makeElement('p', '', playlist.desc || ''),
    makeElement('p', 'playlist-track-count', `${displayTracks.length} canciones · ${formatPlaylistDuration(
      playlist.duration || (playlist.tracks || []).reduce((total, song) => total + (Number(song.duration) || 0), 0)
    )}`),
    makeElement('p', 'playlist-owner', 'De ')
  );
  const ownerLine = copy.querySelector('.playlist-owner');
  ownerLine.append(makeProfileUserLink(creator));
  if (Number(playlist.savedCount) > 0) {
    copy.append(makeButton('playlist-saved-count', `${playlist.savedCount} personas guardaron esta playlist`,
      () => void openPlaylistSaversSheet(playlist), `♡ ${playlist.savedCount} guardados`));
  }
  const contributors = makeElement('p', 'playlist-contributors');
  const sharedMembers = Array.isArray(playlist.sharedWith) ? playlist.sharedWith : [];
  if (sharedMembers.length) {
    contributors.append(document.createTextNode('Integrantes: '));
    sharedMembers.forEach((member, index) => {
      if (index) contributors.append(document.createTextNode(' · '));
      contributors.append(makeProfileUserLink(member));
    });
  }
  copy.append(contributors);
  view.append(copy);
  const actions = makeElement('div', 'detail-actions');
  actions.append(makeButton('round-action play', 'Reproducir playlist', () => {
    const tracks = playlist.tracks || [];
    if (tracks.length) void playTrack(tracks, 0, { queueTitle: playlist.name || 'PLAYLIST' });
    else showToast('Esta playlist aún no tiene canciones.');
  }, '▶'));
  const canEdit = (isOwner || isShared) && !isSpotifyLinked;
  if (isSpotifyLinked && isOwner) {
    actions.append(makeButton('round-action', 'Sincronizar desde Spotify', () => void syncSpotifyPlaylist(playlist), '⟳'));
    actions.append(makeButton('round-action', 'Eliminar playlist', () => void deletePlaylist(playlist), '⌫'));
  } else if (isSpotifyLinked && isShared) {
    actions.append(makeButton('round-action', 'Salir de la playlist', () => void leavePlaylist(playlist), '↩'));
  } else if (canEdit) {
    actions.append(makeButton('round-action', 'Editar playlist', () => openPlaylistForm(playlist), '✎'));
    actions.append(makeButton('round-action', 'Agregar canciones', () => openAddToPlaylist(null, playlist.id), '＋'));
    if (isOwner) {
      actions.append(makeButton('round-action', 'Compartir playlist', () => openSharePlaylistSheet(playlist), '↗'));
      actions.append(makeButton('round-action', 'Gestionar integrantes', () => openPlaylistMembersSheet(playlist), '♙'));
      actions.append(makeButton('round-action', 'Eliminar playlist', () => void deletePlaylist(playlist), '⌫'));
    } else {
      actions.append(makeButton('round-action', 'Salir de la playlist', () => void leavePlaylist(playlist), '↩'));
    }
  } else {
    const isSaved = (state.user?.savedPlaylists || []).some(id => String(id) === String(playlist.id));
    actions.append(makeButton('round-action', isSaved ? 'Quitar de guardadas' : 'Guardar playlist', () => {
      void savePlaylistToLibrary(playlist, isSaved);
    }, isSaved ? '✓' : '＋'));
  }
  view.append(actions);
  view.append(renderSongList(displayTracks, 'Esta playlist todavía no tiene canciones.', {
    queue: isSpotifyLinked
      ? displayTracks.filter(track => !track.spotifyUnavailable)
      : playlist.tracks || [],
    queueTitle: playlist.name || 'PLAYLIST',
    detail: true,
    onRemove: canEdit ? song => void removeSongFromPlaylist(playlist, song) : null,
    playlist,
    canReorder: canEdit
  }));
  if (isOwner && isSpotifyLinked) void syncSpotifyPlaylist(playlist);
}

function renderSettings() {
  const view = elements.mainView;
  view.classList.remove('home-view');
  view.replaceChildren();
  view.append(setHeading('PREFERENCIAS', 'Ajustes'));

  const playbackCard = makeElement('section', 'settings-card');
  playbackCard.append(
    makeElement('h2', '', 'Reproducción'),
    makeElement('p', '', 'Configura los controles y preferencias de reproducción de tu cuenta.')
  );
  const seekLabel = makeElement('label', '', 'Tiempo de salto en segundos');
  const seekInput = makeElement('input', 'settings-input');
  seekInput.type = 'number';
  seekInput.min = '1';
  seekInput.max = '120';
  seekInput.step = '1';
  seekInput.value = String(state.seekSeconds);
  seekInput.id = 'settings-seek-seconds';
  seekLabel.htmlFor = seekInput.id;
  playbackCard.append(seekLabel, seekInput);

  const maxVolumeLabel = makeElement('label', '', 'Volumen máximo (%)');
  const maxVolumeInput = makeElement('input', 'settings-input');
  maxVolumeInput.type = 'number';
  maxVolumeInput.min = '100';
  maxVolumeInput.max = '1000';
  maxVolumeInput.step = '1';
  maxVolumeInput.value = String(Math.round(state.maxVolume * 100));
  maxVolumeInput.id = 'settings-max-volume';
  maxVolumeLabel.htmlFor = maxVolumeInput.id;
  playbackCard.append(
    maxVolumeLabel,
    makeElement('p', '', 'Aumentar sobre 100% puede distorsionar el audio y depende del navegador/dispositivo.'),
    maxVolumeInput,
    makeButton('secondary-button', 'Guardar reproducción', () => void savePlaybackSettings(seekInput, maxVolumeInput), 'Guardar ajustes')
  );
  view.append(playbackCard);

  const offlineCard = makeElement('section', 'settings-card');
  offlineCard.append(
    makeElement('h2', '', 'Modo offline'),
    makeElement('p', '', 'Escucha tu música sin conexión.')
  );
  const offlineLabel = makeElement('label', 'offline-setting-toggle', 'Descargar biblioteca para uso offline');
  const offlineToggle = makeElement('input');
  offlineToggle.type = 'checkbox';
  offlineToggle.checked = state.offlineEnabled;
  offlineToggle.id = 'settings-offline-mode';
  offlineLabel.htmlFor = offlineToggle.id;
  offlineLabel.prepend(offlineToggle);
  const offlineStatus = makeElement('p', 'offline-status', state.offlineStatus);
  offlineStatus.id = 'offline-status';
  offlineCard.append(offlineLabel, offlineStatus);
  view.append(offlineCard);
  offlineToggle.addEventListener('change', () => void setOfflineMode(offlineToggle.checked));
  const notificationCard = makeElement('section', 'settings-card');
  notificationCard.append(
    makeElement('h2', '', 'Notificación de reproducción'),
    makeElement('p', '', isAndroidNative
      ? 'Autoriza la aplicación para mostrar la notificación personalizada.'
      : 'Las notificaciones de reproducción dependen de los permisos del navegador.')
  );
  const notificationLabel = makeElement('label', 'offline-setting-toggle', 'Mostrar controles de reproducción en una notificación');
  const notificationToggle = makeElement('input');
  notificationToggle.type = 'checkbox';
  notificationToggle.checked = state.customNotificationEnabled;
  notificationToggle.id = 'settings-playback-notification';
  notificationLabel.htmlFor = notificationToggle.id;
  notificationLabel.prepend(notificationToggle);
  notificationCard.append(notificationLabel);
  notificationToggle.addEventListener('change', () => {
    void setPlaybackNotificationsEnabled(notificationToggle.checked, notificationToggle);
  });
  if (!isAndroidNative && (!('Notification' in window) || !('serviceWorker' in navigator) || !window.isSecureContext)) {
    notificationCard.append(makeElement('p', 'muted', 'Este navegador no admite notificaciones persistentes de AMGC.'));
  } else if (!isAndroidNative && Notification.permission === 'denied') {
    notificationCard.append(makeElement('p', 'muted', 'El permiso está bloqueado. Habilítalo desde los ajustes del navegador.'));
  }
  notificationToggle.disabled = !isAndroidNative && (
    !('Notification' in window)
    || !('serviceWorker' in navigator)
    || !window.isSecureContext
    || Notification.permission === 'denied'
  );
  view.append(notificationCard);

  const phrasesCard = makeElement('section', 'settings-card');
  phrasesCard.append(
    makeElement('h2', '', 'Frases de inicio'),
    makeElement('p', '', 'Se comparten globalmente salvo que las marques como personales.')
  );
  const phrasesInput = makeElement('textarea', 'settings-input');
  phrasesInput.rows = 5;
  phrasesInput.value = state.secretPhrases.join('\n');
  phrasesInput.placeholder = 'Una frase por línea';
  phrasesInput.setAttribute('aria-label', 'Una frase por línea');
  const personalLabel = makeElement('label', 'offline-setting-toggle', 'Hacer mis frases personales');
  const personalToggle = makeElement('input');
  personalToggle.type = 'checkbox';
  personalToggle.checked = state.secretPhrasesPersonal;
  personalLabel.prepend(personalToggle);
  const savePhrasesButton = makeButton('secondary-button', 'Guardar frases', () => {
    void saveSecretPhrases(phrasesInput, personalToggle);
  }, 'Guardar frases');
  phrasesCard.append(phrasesInput, personalLabel, savePhrasesButton);
  view.append(phrasesCard);

  const installCard = makeElement('section', 'settings-card');
  installCard.append(
    makeElement('h2', '', 'Instalar en el celular'),
    makeElement('p', '', isAndroidNative
      ? 'AMGC está instalada como aplicación Android.'
      : 'Usa el menú del navegador y elige “Agregar a pantalla de inicio”. Requiere HTTPS.')
  );
  if (!isAndroidNative) view.append(installCard);
  view.append(makeButton('secondary-button danger-button', 'Cerrar sesión', () => logout(true), 'Cerrar sesión'));
}

function getProfileUser() {
  return state.profileUser || state.user;
}

function renderProfile() {
  const view = elements.mainView;
  view.classList.remove('home-view');
  view.replaceChildren();
  const user = getProfileUser();
  const isOwnProfile = String(user?._id || '') === String(state.user?._id || '');
  const isAdmin = Boolean(user?.isAdmin)
    || (Array.isArray(user?.permissions) && user.permissions.includes('admin'));
  if (!user) {
    view.append(makeElement('p', 'empty-state', 'No se encontró el perfil.'));
    return;
  }
  view.append(setHeading(
    isOwnProfile ? 'TU CUENTA' : 'PERFIL',
  ));
  const profileCard = makeElement('section', 'profile-card');
  const avatar = imageElement(getUserPhoto(user) || './img/perrocorasongif.gif', 'profile-avatar', '');
  if (isOwnProfile) {
    const profilePhotoInput = makeElement('input', 'profile-photo-input');
    profilePhotoInput.type = 'file';
    profilePhotoInput.accept = 'image/*';
    profilePhotoInput.hidden = true;
    profilePhotoInput.addEventListener('change', () => void uploadProfilePhoto(profilePhotoInput));
    const avatarButton = makeButton('profile-avatar-button', 'Cambiar foto de perfil', () => profilePhotoInput.click());
    avatarButton.append(avatar);
    profileCard.append(avatarButton, profilePhotoInput);
  } else {
    profileCard.append(avatar);
  }
  const details = makeElement('div', 'profile-identity');
  const presence = makeElement('p', 'profile-presence');
  const presenceDot = makeElement('span', `profile-presence-dot ${user.isOnline ? 'online' : 'offline'}`);
  presenceDot.setAttribute('aria-hidden', 'true');
  presence.append(
    presenceDot,
    makeElement('span', '', user.isOnline ? 'En línea' : `Desconectado · ${timeAgo(user.lastActive)}`)
  );
  details.append(
    makeElement('p', 'eyebrow', isAdmin ? 'ADMINISTRADOR' : 'USUARIO'),
    makeElement('h2', '', user.username || 'Usuario'),
    presence
  );
  profileCard.append(details);
  if (!isOwnProfile) {
    const actions = makeElement('div', 'profile-social-actions');
    actions.append(makeButton('secondary-button', `Chatear con ${user.username}`, () => openChat(user), 'Chat'));
    actions.append(makeButton('text-button', 'Volver a mi perfil', () => openProfile(null), '‹ Mi perfil'));
    profileCard.append(actions);
  }
  view.append(profileCard);

  const ownRemotePlayback = isOwnProfile
    && state.remotePlayback?.deviceId !== playbackDeviceId
    ? state.remotePlayback
    : null;
  const localPlayback = isOwnProfile && getCurrentSong()
    ? {
      ...user.lastPlayed,
      songName: getCurrentSong().name,
      artist: getCurrentSong().artist,
      cover: getSongCover(getCurrentSong()),
      color: getCurrentSong().color,
      isPlaying: !elements.audio.paused,
      currentTime: elements.audio.currentTime,
      duration: elements.audio.duration || getCurrentSong().duration,
      updatedAt: new Date().toISOString(),
      deviceId: playbackDeviceId,
      deviceType: playbackDeviceType
    }
    : null;
  const playback = ownRemotePlayback || localPlayback || user.lastPlayed;
  const activityCard = makeElement('section', 'settings-card profile-activity');
  const isFriendListening = !isOwnProfile && user.isOnline && playback?.isPlaying !== false && Boolean(playback?.songName);
  const isOwnRemoteListening = Boolean(ownRemotePlayback?.isPlaying !== false && ownRemotePlayback);
  const isOwnListening = isOwnRemoteListening || Boolean(isOwnProfile && localPlayback?.isPlaying);
  const activityTitle = isOwnProfile
    ? (isOwnListening && playback?.songName ? 'Escuchando ahora' : 'Última canción escuchada')
    : isFriendListening ? 'Escuchando ahora' : 'Última canción escuchada';
  activityCard.append(makeElement('h2', '', activityTitle));
  if (playback?.songName) {
    const activity = makeElement('div', `profile-now-playing${isFriendListening ? ' can-listen-together' : ''}`);
    if (isFriendListening) {
      activity.tabIndex = 0;
      activity.setAttribute('role', 'button');
      activity.setAttribute('aria-label', `Escuchar junto a ${user.username}: ${playback.songName}`);
      const startListening = () => startListeningTogether(user);
      activity.addEventListener('click', startListening);
      activity.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        startListening();
      });
    }
    const trackCopy = makeElement('span', 'profile-now-playing-copy');
    trackCopy.append(
      makeElement('strong', 'profile-now-playing-title', playback.songName),
      makeElement('small', 'profile-now-playing-artist', playback.artist || 'Artista desconocido')
    );
    if (playback.deviceType || playback.deviceId) {
      const isListening = isOwnListening || isFriendListening;
      const listeningLabel = isListening ? 'Escuchando' : 'Estaba escuchando';
      const lastHeardAt = getPlaybackLastHeardAt(playback, user.lastPlayed);
      const lastHeard = getPlaybackLastHeardLabel(playback, isListening, user.lastPlayed);
      const deviceStatus = makeElement('small', 'profile-now-playing-device');
      const statusText = makeElement('span', '', `${listeningLabel}${lastHeard ? ` · ${lastHeard}` : ''}`);
      statusText.dataset.playbackStatus = '';
      statusText.dataset.isListening = String(isListening);
      statusText.dataset.lastHeardAt = String(lastHeardAt || '');
      deviceStatus.append(statusText);
      const deviceIcon = createPlaybackDeviceIcon(getPlaybackDeviceType(playback));
      if (deviceIcon) deviceStatus.append(deviceIcon);
      trackCopy.append(deviceStatus);
    }
    activity.append(imageElement(getPlaybackCover(playback), 'profile-now-playing-cover', ''), trackCopy);
    activityCard.append(activity);
    const progress = makeElement('div', 'profile-listening-progress');
    progress.append(makeElement('span'));
    progress.dataset.duration = String(Number(playback.duration) || 0);
    progress.dataset.currentTime = String(Number(playback.currentTime) || 0);
    progress.dataset.updatedAt = String(playback.updatedAt || '');
    progress.dataset.playing = String(playback.isPlaying !== false);
    progress.dataset.online = String(isOwnProfile ? isOwnListening : user.isOnline);
    activityCard.style.setProperty('--track-color', isOwnProfile ? playback.color || '#fff' : '#85898f');
    progress.style.setProperty('--track-color', playback.color || '#fff');
    activityCard.append(progress, makeElement('small', 'profile-listening-time', ''));
  } else {
    activityCard.append(makeElement('p', 'muted', 'Todavía no hay actividad de reproducción.'));
  }
  view.append(activityCard);
  updateProfileListeningProgress();

  const statsCard = makeElement('section', 'settings-card');
  statsCard.append(makeElement('h2', '', 'Estadísticas'));
  const stats = user._id === state.user?._id ? user.stats || {} : state.profileStats || {};
  const listeningSeconds = Number(stats.listeningSeconds) || 0;
  const statGrid = makeElement('div', 'profile-stats');
  [
    ['ESCUCHA', `${Math.floor(listeningSeconds / 3600)} h ${Math.floor(listeningSeconds % 3600 / 60)} min`],
    ['CANCIONES', stats.songsPlayed || 0],
    ['AGREGADAS', stats.songsAdded || 0],
    ['EDITADAS', stats.songsEdited || 0],
    ['AMIGOS', stats.friendsAdded ?? user.friends?.length ?? 0]
  ].forEach(([label, value]) => {
    const stat = makeElement('div', 'profile-stat');
    stat.append(makeElement('small', '', label), makeElement('strong', '', String(value)));
    statGrid.append(stat);
  });
  statsCard.append(statGrid);
  view.append(statsCard);

  const playlists = isOwnProfile
    ? state.playlists.filter(playlist => String(playlist.ownerId || '') === String(user._id)
      || (playlist.sharedWith || []).some(member => String(member?._id || member) === String(user._id)))
    : state.profilePlaylists;
  const playlistsCard = makeElement('section', 'settings-card');
  playlistsCard.append(makeElement('h2', '', 'Playlists'));
  playlistsCard.append(renderPlaylistGrid(playlists, 'Todavía no hay playlists personales.'));
  view.append(playlistsCard);

  if (isOwnProfile) {
    const friendsCard = makeElement('section', 'settings-card');
    friendsCard.append(makeElement('h2', '', 'Amigos'));
    const addFriendForm = makeElement('form', 'profile-add-friend-form');
    const friendUsernameInput = makeElement('input', 'settings-input');
    friendUsernameInput.type = 'text';
    friendUsernameInput.name = 'friendUsername';
    friendUsernameInput.placeholder = 'Nombre de usuario';
    friendUsernameInput.autocomplete = 'off';
    friendUsernameInput.setAttribute('aria-label', 'Nombre del usuario para agregar');
    const addFriendButton = makeElement('button', 'secondary-button', '＋ Agregar');
    addFriendButton.type = 'submit';
    addFriendForm.append(friendUsernameInput, addFriendButton);
    addFriendForm.addEventListener('submit', event => {
      event.preventDefault();
      void addFriend(friendUsernameInput);
    });
    friendsCard.append(addFriendForm);
    if (!state.friends.length) {
      friendsCard.append(makeElement('p', 'muted', 'No hay amigos para mostrar.'));
    } else {
      const friendList = makeElement('div', 'profile-friends');
      state.friends.forEach(friend => {
        const friendRow = makeElement('div', 'profile-friend-row');
        const friendButton = makeButton('profile-friend', `Ver perfil de ${friend.username}`, () => {
          void openFriendProfile(friend);
        });
        friendButton.append(
          imageElement(getUserPhoto(friend) || './img/perrocorasongif.gif', '', ''),
          makeElement('span', 'profile-friend-name', friend.username)
        );
        const statusDot = makeElement('span', `profile-presence-dot ${friend.isOnline ? 'online' : 'offline'}`);
        statusDot.setAttribute('aria-label', friend.isOnline ? 'En línea' : 'Desconectado');
        friendButton.append(statusDot);
        const removeButton = makeButton(
          'friend-remove-button',
          `Eliminar a ${friend.username} de tus amigos`,
          () => void removeFriend(friend._id, friend.username),
          '×'
        );
        friendRow.append(friendButton, removeButton);
        friendList.append(friendRow);
      });
      friendsCard.append(friendList);
    }
    view.append(friendsCard);
  } else if (Array.isArray(user.lastPlayedHistory) && user.lastPlayedHistory.length) {
    const historyCard = makeElement('section', 'settings-card');
    historyCard.append(makeElement('h2', '', 'Reproducciones recientes'));
    user.lastPlayedHistory.slice().reverse().slice(0, 10).forEach(item => {
      const historyItem = makeElement('div', 'profile-history-item');
      historyItem.append(
        makeElement('span', '', `${item.songName} · ${item.artist || 'Artista desconocido'}`),
        makeElement('small', '', timeAgo(item.playedAt))
      );
      historyCard.append(historyItem);
    });
    view.append(historyCard);
  }

  if (!state.profileStats && user._id && state.profileLoadingId !== String(user._id)) {
    void loadProfileDetails(user, isOwnProfile);
  }
  syncProfileProgressTimer();
}

function timeAgo(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return 'actividad reciente';
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'hace unos segundos';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

function updateProfileListeningProgress() {
  updateProfileActivityStatusLabel();
  const progress = document.querySelector('.profile-listening-progress');
  const label = document.querySelector('.profile-listening-time');
  if (!progress || !label) return;
  const duration = Number(progress.dataset.duration) || 0;
  const online = progress.dataset.online === 'true';
  const isPlaying = progress.dataset.playing === 'true';
  const elapsed = getPlaybackElapsedSeconds({
    duration,
    currentTime: progress.dataset.currentTime,
    updatedAt: progress.dataset.updatedAt,
    isPlaying
  }, online);
  const fill = progress.firstElementChild;
  if (fill) fill.style.width = `${duration ? Math.min(100, elapsed / duration * 100) : 0}%`;
  label.textContent = `${formatTime(elapsed)} / ${formatTime(duration)}`;
}

function updateProfileActivityStatusLabel() {
  const status = document.querySelector('[data-playback-status]');
  if (!status) return;
  const isListening = status.dataset.isListening === 'true';
  const lastHeard = formatPlaybackRelativeTime(status.dataset.lastHeardAt);
  const label = isListening
    ? 'Escuchando'
    : `Estaba escuchando${lastHeard ? ` · ${lastHeard}` : ''}`;
  if (status.textContent !== label) status.textContent = label;
}

function syncProfileProgressTimer() {
  const shouldRun = !document.hidden
    && state.currentTab === 'profile'
    && !state.currentPlaylistId
    && Boolean(document.querySelector('.profile-listening-progress'));
  if (!shouldRun) {
    if (profileProgressTimer) clearInterval(profileProgressTimer);
    profileProgressTimer = null;
    return;
  }
  if (!profileProgressTimer) {
    updateProfileListeningProgress();
    profileProgressTimer = window.setInterval(updateProfileListeningProgress, 1000);
  }
}

async function closePlaybackNotification() {
  if (isAndroidNative) {
    if (nativeNotificationUpdateTimer) {
      clearTimeout(nativeNotificationUpdateTimer);
      nativeNotificationUpdateTimer = null;
    }
    lastNativeNotificationUpdate = 0;
    lastNativeNotificationKey = '';
    nativeNotificationDesired = false;
    nativeNotificationRevision += 1;
    if (!nativeNotificationRunning && nativeNotificationStopSent) return;
    nativeNotificationRunning = false;
    nativeNotificationStopSent = true;
    try {
      await nativeMedia.stop();
    } catch (error) {
      console.error('No se pudo detener la notificación multimedia nativa.', error);
    }
    return;
  }
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const notifications = await registration.getNotifications({ tag: 'amgc-mobile-playback' });
    notifications.forEach(notification => notification.close());
  } catch (error) {
    console.warn('No se pudo cerrar la notificación de reproducción.', error);
  }
}

async function updatePlaybackNotification() {
  if (state.remotePlayback?.deviceId && state.remotePlayback.deviceId !== playbackDeviceId) {
    await closePlaybackNotification();
    return;
  }
  if (isAndroidNative) {
    if (!state.customNotificationEnabled || !state.notificationPermissionGranted) return;
    const song = getCurrentSong();
    if (!song) {
      await closePlaybackNotification();
      return;
    }
    const now = Date.now();
    const coverSource = song.cover || getSongCover(song);
    const coverUrl = resolveImageUrl(coverSource, 'large');
    const coverCacheKey = getImageCacheKey(coverSource, 'large')
      || `song:${getSongId(song)}:cover`;
    const notificationKey = [
      getSongId(song),
      song.name || '',
      song.artist || '',
      coverUrl,
      elements.audio.paused ? 'paused' : 'playing',
      state.shuffle ? 'shuffle' : 'ordered'
    ].join('|');
    const metadataChanged = notificationKey !== lastNativeNotificationKey;
    if (!metadataChanged && now - lastNativeNotificationUpdate < 5000) {
      if (!nativeNotificationUpdateTimer) {
        nativeNotificationUpdateTimer = window.setTimeout(() => {
          nativeNotificationUpdateTimer = null;
          void updatePlaybackNotification();
        }, 5000 - (now - lastNativeNotificationUpdate));
      }
      return;
    }
    if (nativeNotificationUpdateTimer) {
      clearTimeout(nativeNotificationUpdateTimer);
      nativeNotificationUpdateTimer = null;
    }
    lastNativeNotificationUpdate = now;
    lastNativeNotificationKey = notificationKey;
    nativeNotificationDesired = true;
    const revision = ++nativeNotificationRevision;
    if (lastNativeNotificationCoverKey !== coverCacheKey) {
      lastNativeNotificationCoverKey = coverCacheKey;
      cachedNativeNotificationCoverPath = '';
    }
    try {
      if (!cachedNativeNotificationCoverPath && coverCacheKey) {
        let cachedCover = await getOfflineMedia(coverCacheKey);
        if (revision !== nativeNotificationRevision) return;
        cachedNativeNotificationCoverPath = cachedCover?.localPath || '';
      }
      await nativeMedia.update({
        title: song.name || 'Canción',
        artist: song.artist || 'Artista desconocido',
        coverUrl,
        coverPath: cachedNativeNotificationCoverPath,
        isPlaying: !elements.audio.paused,
        shuffle: state.shuffle,
        position: Number(elements.audio.currentTime) || 0,
        duration: Number(elements.audio.duration) || Number(song.duration) || 0
      });
      if (revision !== nativeNotificationRevision) {
        if (!nativeNotificationDesired) await nativeMedia.stop();
        return;
      }
      nativeNotificationRunning = true;
      nativeNotificationStopSent = false;
    } catch (error) {
      if (revision === nativeNotificationRevision) lastNativeNotificationKey = '';
      console.error('No se pudo actualizar la notificación multimedia nativa.', error);
    }
    return;
  }
  if (!state.customNotificationEnabled || !('Notification' in window)
    || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return;
  const song = getCurrentSong();
  if (!song) {
    await closePlaybackNotification();
    return;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const appIcon = new URL('./icon.svg', document.baseURI).href;
    await registration.showNotification(`AMGC · ${elements.audio.paused ? 'En pausa' : 'Reproduciendo'}`, {
      body: `${song.name || 'Canción'}  ·  ${song.artist || 'Artista desconocido'}`,
      icon: appIcon,
      badge: appIcon,
      image: getSongCover(song) ? resolveImageUrl(getSongCover(song), 'large') : undefined,
      tag: 'amgc-mobile-playback',
      renotify: false,
      silent: true,
      requireInteraction: true,
      actions: [
        {
          action: 'shuffle',
          title: state.shuffle ? 'Aleatorio activado' : 'Aleatorio',
          icon: new URL('./img/aleatorio.png', document.baseURI).href
        },
        {
          action: 'toggle',
          title: elements.audio.paused ? 'Reproducir' : 'Pausar',
          icon: new URL(elements.audio.paused ? './img/play.png' : './img/pause.png', document.baseURI).href
        }
      ]
    });
  } catch (error) {
    console.error('No se pudo actualizar la notificación de reproducción.', error);
  }
}

async function setPlaybackNotificationsEnabled(enabled, toggle) {
  try {
    if (enabled) {
      if (isAndroidNative) {
        const permission = await nativeMedia.requestNotificationPermission();
        state.notificationPermissionGranted = permission?.granted === true;
      } else {
        if (!('Notification' in window) || !('serviceWorker' in navigator) || !window.isSecureContext) {
          throw new Error('Este navegador no admite notificaciones persistentes de AMGC.');
        }
        if (Notification.permission !== 'granted') {
          state.notificationPermissionGranted = await Notification.requestPermission() === 'granted';
        } else {
          state.notificationPermissionGranted = true;
        }
      }
      if (!state.notificationPermissionGranted) {
        throw new Error('No se concedió el permiso para mostrar notificaciones.');
      }
    }

    state.customNotificationEnabled = enabled;
    localStorage.setItem('amgc-mobile-custom-notification', String(enabled));
    if (enabled) await updatePlaybackNotification();
    else await closePlaybackNotification();
    showToast(enabled ? 'Notificación de reproducción activada.' : 'Notificación de reproducción desactivada.');
  } catch (error) {
    console.error('No se pudo actualizar la preferencia de notificaciones.', error);
    if (toggle) toggle.checked = state.customNotificationEnabled;
    showToast(error.message || 'No se pudo actualizar la preferencia de notificaciones.', true);
  }
}

async function loadFriends() {
  if (!state.user?._id) return;
  const userId = String(state.user._id);
  const requestSequence = ++friendsRequestSequence;
  let friends;
  try {
    friends = await request(`/users/friends/${encodeURIComponent(userId)}`);
  } catch (error) {
    console.warn('No se pudo cargar la lista de amigos.', error);
    try {
      const cachedFriends = await getOfflineFriends(userId);
      friends = cachedFriends?.friends || [];
    } catch (cacheError) {
      console.error('No se pudo restaurar la lista de amigos offline.', cacheError);
      updateOfflineStatus(`No se pudo leer la lista de amigos guardada: ${cacheError.message}`);
      return;
    }
  }
  if (requestSequence !== friendsRequestSequence || String(state.user?._id || '') !== userId) return;
  state.friends = (Array.isArray(friends) ? friends : []).map(friend => {
    const update = friendRealtimeUpdates.get(String(friend._id));
    if (!update) return friend;
    return {
      ...friend,
      ...(typeof update.isOnline === 'boolean' && { isOnline: update.isOnline }),
      ...(update.lastPlayed && { lastPlayed: update.lastPlayed }),
      ...(update.updatedAt && { lastActive: update.updatedAt })
    };
  });
  if (
    state.followingUserId
    && !state.friends.some(friend => String(friend._id) === String(state.followingUserId))
  ) {
    stopFollowingFriend();
    showToast('Se detuvo la escucha compartida porque ya no está en tu lista de amigos.', true);
  }
  if (state.offlineEnabled && navigator.onLine) {
    try {
      await saveOfflineFriends(userId, state.friends);
    } catch (error) {
      console.error('No se pudo guardar la lista de amigos para uso offline.', error);
      updateOfflineStatus(`No se pudo guardar la lista de amigos: ${error.message}`);
    }
  }
  try {
    await hydrateCurrentOfflineImages();
  } catch (error) {
    console.error('No se pudieron preparar las imágenes guardadas de amigos.', error);
    updateOfflineStatus(`No se pudieron restaurar algunas imágenes offline: ${error.message}`);
  }
  if (requestSequence !== friendsRequestSequence) return;
  renderDrawerFriends();
  if (state.currentTab === 'profile' && !state.profileUser) renderProfile();
  if (state.offlineEnabled && navigator.onLine) void downloadOfflineLibrary();
}

async function loadUnreadMessages(force = false) {
  if (!state.user?._id || !state.token || !navigator.onLine) return;
  if (unreadMessagesRequest) {
    if (!force) return unreadMessagesRequest;
    await unreadMessagesRequest;
    return loadUnreadMessages();
  }
  const userId = String(state.user._id);
  unreadMessagesRequest = (async () => {
    try {
      const messages = await request(`/notifications/${encodeURIComponent(userId)}`);
      if (!Array.isArray(messages)) throw new Error('El servidor devolvió notificaciones no válidas.');
      if (String(state.user?._id || '') !== userId) return;
      const counts = new Map();
      messages.forEach(message => {
        const senderId = String(message.sender?._id || message.sender || '');
        if (senderId) counts.set(senderId, (counts.get(senderId) || 0) + 1);
      });
      if (state.activeChatFriend?._id) counts.delete(String(state.activeChatFriend._id));
      state.unreadMessageCounts = counts;
      renderDrawerFriends();
    } catch (error) {
      console.warn('No se pudieron cargar los mensajes no leídos.', error);
    } finally {
      unreadMessagesRequest = null;
    }
  })();
  return unreadMessagesRequest;
}

async function addFriend(input) {
  const friendUsername = input.value.trim();
  if (!friendUsername || !state.user?._id) return;
  const submitButton = input.form?.querySelector('button[type="submit"]');
  if (submitButton) submitButton.disabled = true;
  try {
    await request('/users/friends/add', {
      method: 'POST',
      body: JSON.stringify({ userId: state.user._id, friendUsername })
    });
    input.value = '';
    await loadFriends();
    showToast(`${friendUsername} se agregó a tus amigos.`);
  } catch (error) {
    showToast(error.message || 'No se pudo agregar al amigo.', true);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

async function removeFriend(friendId, friendName = 'este amigo') {
  if (!friendId || !window.confirm(`¿Eliminar a ${friendName} de tus amigos?`)) return;
  try {
    await request(`/users/friends/${encodeURIComponent(friendId)}`, { method: 'DELETE' });
    if (String(state.activeChatFriend?._id || '') === String(friendId)) closeChat();
    await loadFriends();
    showToast(`${friendName} se eliminó de tus amigos.`);
  } catch (error) {
    showToast(error.message || 'No se pudo eliminar al amigo.', true);
  }
}

async function uploadProfilePhoto(input) {
  const photo = input.files?.[0];
  if (!photo || !state.user?._id) return;
  const data = new FormData();
  data.append('photo', photo);
  try {
    const updatedUser = await request(`/users/${encodeURIComponent(state.user._id)}/profile-photo`, {
      method: 'POST',
      body: data
    });
    state.user = { ...state.user, profilePhoto: updatedUser.profilePhoto || '' };
    localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(state.user));
    updateNavigationState();
    if (state.currentTab === 'profile' && !state.profileUser) renderProfile();
    await loadFriends();
    showToast('Foto de perfil actualizada.');
  } catch (error) {
    showToast(error.message || 'No se pudo guardar la foto de perfil.', true);
  } finally {
    input.value = '';
  }
}

function setCurrentUserOnline(isOnline) {
  if (!state.user || state.user.isOnline === isOnline) return;
  state.user = { ...state.user, isOnline, ...(isOnline ? {} : { lastActive: new Date().toISOString() }) };
  localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(state.user));
  if (state.currentTab === 'profile' && !state.profileUser) renderProfile();
}

function rememberFriendRealtimeUpdate(userId, update) {
  const friendId = String(userId || '');
  if (!friendId) return;
  friendRealtimeUpdates.set(friendId, {
    ...friendRealtimeUpdates.get(friendId),
    ...update,
    receivedAt: Date.now()
  });
}

async function loadProfileDetails(user, isOwnProfile) {
  const profileId = String(user._id);
  state.profileLoadingId = profileId;
  try {
    if (!navigator.onLine) {
      const cachedPlaylists = await getOfflineProfilePlaylists(state.user?._id, profileId);
      state.profileStats = user.stats || {};
      state.profilePlaylists = Array.isArray(cachedPlaylists) ? cachedPlaylists : [];
      await hydrateCurrentOfflineImages();
      renderProfile();
      return;
    }
    const [stats, playlists] = await Promise.all([
      request(`/users/${encodeURIComponent(profileId)}/stats`),
      isOwnProfile
        ? Promise.resolve(state.playlists)
        : request(`/playlists?profileUserId=${encodeURIComponent(profileId)}`)
    ]);
    if (String(getProfileUser()?._id) !== profileId) return;
    state.profileStats = stats;
    state.profilePlaylists = Array.isArray(playlists) ? playlists : [];
    if (isOwnProfile && state.user) state.user.stats = { ...state.user.stats, ...stats };
    renderProfile();
    if (!isOwnProfile && state.user?._id) {
      void saveOfflineProfilePlaylists(state.user._id, profileId, state.profilePlaylists)
        .then(() => hydrateCurrentOfflineImages())
        .then(() => {
          if (state.offlineEnabled && navigator.onLine) void downloadOfflineLibrary();
        })
        .catch(error => {
          console.error('No se pudieron guardar las playlists del perfil para uso offline.', error);
          updateOfflineStatus(`No se pudieron guardar las playlists del perfil: ${error.message}`);
        });
    }
  } catch (error) {
    console.warn('No se pudo cargar el perfil completo.', error);
    if (String(getProfileUser()?._id) === profileId) {
      try {
        const cachedPlaylists = await getOfflineProfilePlaylists(state.user?._id, profileId);
        if (cachedPlaylists) {
          state.profileStats = user.stats || {};
          state.profilePlaylists = cachedPlaylists;
          await hydrateCurrentOfflineImages();
          renderProfile();
          return;
        }
      } catch (cacheError) {
        console.error('No se pudieron restaurar las playlists del perfil offline.', cacheError);
      }
      showToast(error.message || 'No se pudieron cargar las estadísticas del perfil.', true);
    }
  } finally {
    if (state.profileLoadingId === profileId) state.profileLoadingId = null;
  }
}

async function openFriendProfile(friend) {
  if (!friend?._id) return;
  state.profileUser = friend;
  state.profileStats = null;
  state.profileLoadingId = null;
  state.profilePlaylists = [];
  state.currentPlaylistId = null;
  state.currentTab = 'profile';
  updateNavigationState();
  setDrawerOpen(false);
  renderCurrentView();
}

function openProfile() {
  state.profileUser = null;
  state.profileStats = null;
  state.profileLoadingId = null;
  state.profilePlaylists = [];
  state.currentPlaylistId = null;
  state.currentTab = 'profile';
  updateNavigationState();
  setDrawerOpen(false);
  renderCurrentView();
}

async function savePlaybackSettings(seekInput, maxVolumeInput) {
  const seekSeconds = Number(seekInput.value);
  const maxVolumePercent = Number(maxVolumeInput.value);
  if (!Number.isInteger(seekSeconds) || seekSeconds < 1 || seekSeconds > 120) {
    showToast('El tiempo de salto debe ser de 1 a 120 segundos.', true);
    return;
  }
  if (!Number.isFinite(maxVolumePercent) || maxVolumePercent < 100 || maxVolumePercent > 1000) {
    showToast('El volumen máximo debe estar entre 100% y 1000%.', true);
    return;
  }
  try {
    const settings = await request('/users/settings', {
      method: 'POST',
      body: JSON.stringify({
        userId: state.user?._id,
        settings: { seekSeconds, maxVolume: maxVolumePercent }
      })
    });
    state.seekSeconds = seekSeconds;
    state.maxVolume = maxVolumePercent / 100;
    if (state.user) state.user.settings = { ...state.user.settings, ...settings };
    elements.playerVolume.max = String(state.maxVolume);
    setPlayerVolume(state.volume);
    localStorage.setItem('maxVolume', String(state.maxVolume));
    updatePlayerUI();
    showToast('Ajustes de reproducción guardados.');
  } catch (error) {
    showToast(error.message || 'No se pudieron guardar los ajustes.', true);
  }
}

async function saveSecretPhrases(input, personalToggle) {
  try {
    const result = await request('/secret-phrases', {
      method: 'POST',
      body: JSON.stringify({
        phrases: input.value.split(/\r?\n/),
        personal: personalToggle.checked
      })
    });
    state.secretPhrases = Array.isArray(result.phrases) ? result.phrases : [];
    state.secretPhrasesPersonal = result.personal === true;
    state.previousSecretPhrase = '';
    showRandomSecretPhrase();
    showToast('Frases guardadas.');
  } catch (error) {
    showToast(error.message || 'No se pudieron guardar las frases.', true);
  }
}

function updateOfflineStatus(message, progress = null) {
  state.offlineStatus = message;
  state.offlineProgress = progress;
  const status = document.getElementById('offline-status');
  if (status) status.textContent = message;
}

async function refreshOfflineAudioAvailability(render = true) {
  try {
    const songsById = new Map();
    [...state.songs, ...state.playlists.flatMap(playlist => playlist.tracks || []),
      ...state.profilePlaylists.flatMap(playlist => playlist.tracks || []),
      ...state.queue, ...state.upcomingQueue].forEach(song => {
      const songId = String(getSongId(song) || '');
      if (songId && !songsById.has(songId)) songsById.set(songId, song);
    });
    state.offlineAudioSongIds = await getOfflineAudioSongIds((songId, cachedSource) => {
      const song = songsById.get(songId);
      const source = song?.path || song?.audioUrl;
      return Boolean(source
        && sameMediaSource(cachedSource, resolveOfflineResourceUrl(source, 'audio')));
    });
    if (render && state.user?._id && !elements.appShell.hidden) renderCurrentView();
  } catch (error) {
    console.warn('No se pudo actualizar qué canciones están disponibles offline.', error);
  }
}

function setOfflineAudioAvailability(songId, available) {
  const normalizedSongId = String(songId || '');
  if (!normalizedSongId) return;
  if (available) state.offlineAudioSongIds.add(normalizedSongId);
  else state.offlineAudioSongIds.delete(normalizedSongId);

  document.querySelectorAll('.song-row[data-song-id]').forEach(row => {
    if (row.dataset.songId !== normalizedSongId) return;
    const cover = row.querySelector('.song-cover-loading');
    if (!cover) return;
    const badge = cover.querySelector('.offline-ready-badge');
    if (available && !badge) {
      const offlineBadge = makeElement('span', 'offline-ready-badge');
      offlineBadge.setAttribute('role', 'img');
      offlineBadge.setAttribute('aria-label', 'Audio disponible sin conexión');
      offlineBadge.title = 'Audio guardado en este dispositivo';
      cover.append(offlineBadge);
    } else if (!available) {
      badge?.remove();
    }
  });
}

async function recoverDriveAudioLocally(song, {
  loadSequence,
  autoplay,
  sync,
  restoreTime,
  showError,
  awaitPlaybackStart,
  fallbackState
}) {
  const songId = getSongId(song);
  const source = song.path || song.audioUrl || '';
  const sourceUrl = source ? resolveMediaUrl(source) : '';
  const fileId = getDriveFileId(sourceUrl);
  if (!isAndroidNative || !navigator.onLine || !fileId || !songId) return false;

  const mediaKey = `song:${songId}:audio`;
  state.loadingTrackId = songId;
  updateSongLoadingIndicators();
  try {
    const download = await downloadNativeDriveFile(fileId, 'audio');
    if (!download?.path) throw new Error('Google Drive no devolvió una ruta local válida.');
    if (loadSequence !== trackLoadSequence) return false;
    await saveOfflineMediaFile(mediaKey, download.path, download.contentType, sourceUrl);
    if (loadSequence !== trackLoadSequence) return false;
    const previousUrl = offlineMediaUrls.get(mediaKey);
    if (previousUrl?.startsWith('blob:')) URL.revokeObjectURL(previousUrl);
    offlineMediaUrls.set(mediaKey, Capacitor.convertFileSrc(download.path));
    setOfflineAudioAvailability(songId, true);
    return loadTrack(song, {
      autoplay,
      sync,
      restoreTime,
      showError,
      awaitPlaybackStart,
      fallbackState
    });
  } finally {
    if (loadSequence === trackLoadSequence && state.loadingTrackId === songId) {
      state.loadingTrackId = '';
      updateSongLoadingIndicators();
    }
  }
}

async function cacheOfflineResource(key, source) {
  const mediaType = getOfflineResourceMediaType(key);
  const imageSize = getImageSizeFromCacheKey(key);
  const isImage = mediaType.startsWith('image');
  const url = resolveOfflineResourceUrl(source, mediaType);
  const driveFileId = getDriveFileId(url);
  const cached = await getOfflineMedia(key);
  if ((cached?.blob || cached?.localPath) && sameMediaSource(cached.sourceUrl, url)) {
    const alreadyHydrated = offlineMediaUrls.has(key);
    const cachedUrl = await getOfflineObjectUrl(key);
    if (isImage && driveFileId && cachedUrl) {
      offlineImageUrlsById.set(getImageVariantCacheId(driveFileId, imageSize), cachedUrl);
    }
    return !alreadyHydrated && offlineMediaUrls.has(key);
  }
  if (isAndroidNative && driveFileId) {
    const download = await downloadNativeDriveFile(driveFileId, mediaType);
    if (!download?.path) throw new Error('Google Drive no devolvió una ruta local válida.');
    await saveOfflineMediaFile(key, download.path, download.contentType, url);
    const previousUrl = offlineMediaUrls.get(key);
    if (previousUrl?.startsWith('blob:')) URL.revokeObjectURL(previousUrl);
    offlineMediaUrls.set(key, Capacitor.convertFileSrc(download.path));
    if (isImage) {
      offlineImageUrlsById.set(
        getImageVariantCacheId(driveFileId, imageSize),
        Capacitor.convertFileSrc(download.path)
      );
      if (getDriveFileId(resolveMediaUrl(getCurrentSong()?.cover)) === driveFileId) {
        void updatePlaybackNotification();
      }
    }
    return true;
  }
  let blob;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), OFFLINE_RESOURCE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        mode: 'cors',
        credentials: 'omit',
        signal: controller.signal
      });
      if (!response.ok) {
        if (response.status < 500 && response.status !== 429) {
          throw new Error(`El servidor respondió ${response.status}.`);
        }
        lastError = new Error(`El servidor respondió ${response.status}.`);
      } else {
        const contentType = response.headers.get('content-type')?.toLowerCase() || '';
        if (contentType.includes('text/html') || contentType.includes('application/json')) {
          throw new Error('El servidor devolvió una página en lugar del recurso multimedia.');
        }
        blob = await response.blob();
        if (!blob.size) throw new Error('El archivo descargado está vacío.');
        break;
      }
    } catch (error) {
      if (!(error instanceof TypeError) && error.name !== 'AbortError') throw error;
      lastError = error;
    } finally {
      window.clearTimeout(timeoutId);
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt)));
  }
  if (!blob) throw new Error(`No se pudo descargar después de 3 intentos: ${lastError?.message || 'respuesta vacía del servidor'}`);
  await saveOfflineMedia(key, blob, blob.type, url);
  const previousUrl = offlineMediaUrls.get(key);
  if (previousUrl?.startsWith('blob:')) URL.revokeObjectURL(previousUrl);
  offlineMediaUrls.set(key, URL.createObjectURL(blob));
  return true;
}

async function downloadOfflineLibrary() {
  if (!state.offlineEnabled) return;
  if (!navigator.onLine) {
    await hydrateCurrentOfflineImages();
    return;
  }
  if (offlineSyncPromise) {
    offlineSyncRequested = true;
    return offlineSyncPromise;
  }
  offlineSyncPromise = (async () => {
    let completed = 0;
    let failed = 0;
    let firstFailure = '';
    let total = 0;
    let visualCacheChanged = false;
    do {
      offlineSyncRequested = false;
      failed = 0;
      firstFailure = '';
      const resources = new Map();
      const addResource = (key, source) => {
        if (typeof source !== 'string' || !source.trim() || /^(?:data|blob):/i.test(source)) return;
        resources.set(key, source);
      };
      const addImageResource = (source, size = 'small') => {
        const key = getImageCacheKey(source, size);
        if (state.offlineEnabled && key) addResource(key, source);
      };
      const songs = new Map();
      [...state.songs, ...state.playlists.flatMap(playlist => playlist.tracks || []),
        ...state.profilePlaylists.flatMap(playlist => playlist.tracks || []),
        ...state.queue, ...state.upcomingQueue].forEach(song => {
        const id = getSongId(song);
        if (id) songs.set(id, song);
      });
      songs.forEach((song, id) => {
        addImageResource(song.cover, 'large');
        if (state.offlineEnabled) addResource(`song:${id}:audio`, song.path || song.audioUrl);
      });
      const playlists = new Map();
      [...state.playlists, ...state.profilePlaylists].forEach(playlist => {
        if (playlist?.id) playlists.set(String(playlist.id), playlist);
      });
      playlists.forEach(playlist => {
        addImageResource(playlist.photo, 'large');
        if (playlist.ownerId) addImageResource(playlist.ownerPhoto);
        (playlist.sharedWith || []).forEach(member => {
          if (member?._id) addImageResource(member.profilePhoto);
        });
      });
      const friends = new Map();
      [...state.friends, ...state.friends.flatMap(friend => friend.friends || []),
        ...[...playlistSaversCache.values()].flat(),
        ...(state.user ? [state.user] : []),
        ...(state.profileUser ? [state.profileUser] : [])].forEach(friend => {
        if (friend?._id) friends.set(String(friend._id), friend);
      });
      friends.forEach(friend => addImageResource(friend.profilePhoto));

      const cachedResources = await getOfflineMediaIndex();
      const missingResources = [...resources].filter(([key, source]) => (
        (key.endsWith(':audio')
          || !getCachedImageUrl(source, '', getImageSizeFromCacheKey(key)))
        && !sameMediaSource(
          cachedResources.get(key),
          resolveOfflineResourceUrl(source, getOfflineResourceMediaType(key))
        )
      ));
      missingResources.sort((left, right) => (
        Number(left[0].endsWith(':audio')) - Number(right[0].endsWith(':audio'))
      ));
      total = completed + missingResources.length;
      if (!missingResources.length) {
        visualCacheChanged = await hydrateOfflineMedia(
          [...resources].map(([key, source]) => ({ key, source }))
        ) || visualCacheChanged;
        if (state.offlineEnabled && completed === 0) {
          updateOfflineStatus('La música, las carátulas, las playlists y las fotos están guardadas.');
        }
        break;
      }
      if (state.offlineEnabled) {
        updateOfflineStatus(`Descargando recursos offline: ${completed}/${total}…`, {
          completed,
          total
        });
      }
      let nextIndex = 0;
      const worker = async () => {
        while (
          nextIndex < missingResources.length
          && navigator.onLine
          && state.offlineEnabled
        ) {
          const [key, source] = missingResources[nextIndex++];
          try {
            const changed = await cacheOfflineResource(key, source);
            const audioKey = /^song:(.+):audio$/.exec(key);
            if (audioKey) setOfflineAudioAvailability(audioKey[1], true);
            else if (changed) visualCacheChanged = true;
          } catch (error) {
            failed += 1;
            if (!firstFailure) firstFailure = `${key}: ${error.message || 'Error desconocido.'}`;
            console.warn(`No se pudo guardar ${key} para uso offline.`, error);
          } finally {
            completed += 1;
            if (state.offlineEnabled) {
              updateOfflineStatus(`Descargando recursos offline: ${completed}/${total} (${failed} con error)…`, {
                completed,
                total
              });
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, missingResources.length) }, () => worker()));
      visualCacheChanged = await hydrateOfflineMedia(
        [...resources].map(([key, source]) => ({ key, source }))
      ) || visualCacheChanged;
    } while (offlineSyncRequested && state.offlineEnabled && navigator.onLine);

    if (state.offlineEnabled && !navigator.onLine) {
      updateOfflineStatus(`Descarga pausada sin conexión (${completed}/${total}). Se reanudará al reconectar.`, {
        completed,
        total
      });
    } else if (state.offlineEnabled) {
      const message = failed
        ? `${failed} recursos no se pudieron guardar. ${firstFailure}`
        : 'Descarga offline completada: canciones, carátulas, playlists y fotos disponibles.';
      updateOfflineStatus(message, { completed, total });
      showToast(message, failed > 0);
    }
    await refreshOfflineAudioAvailability(false);
    if (state.offlineEnabled || visualCacheChanged) {
      renderCurrentView();
      updateNavigationState();
      updatePlayerUI();
    }
  })();
  try {
    await offlineSyncPromise;
  } catch (error) {
    console.error('No se pudo completar la descarga offline.', error);
    updateOfflineStatus(`No se pudo completar la descarga offline: ${error.message}`);
    showToast(state.offlineStatus, true);
  } finally {
    offlineSyncPromise = null;
  }
}

async function setOfflineMode(enabled) {
  if (!state.user?._id) return;
  state.offlineEnabled = enabled;
  localStorage.setItem(`amgc-offline-enabled-${state.user._id}`, String(enabled));
  if (!enabled) {
    updateOfflineStatus('Descargas offline desactivadas. Los archivos guardados se conservan en este dispositivo.');
    renderCurrentView();
    updatePlayerUI();
    return;
  }
  try {
    await Promise.all([
      saveOfflineLibrary(state.user._id, state.songs),
      saveOfflinePlaylists(state.user._id, state.playlists),
      saveOfflineFriends(state.user._id, state.friends)
    ]);
    await hydrateCurrentOfflineImages();
    renderCurrentView();
    updatePlayerUI();
    if (!navigator.onLine) {
      updateOfflineStatus('Sin conexión. La descarga de canciones, carátulas, playlists y fotos se reanudará al reconectar.');
      return;
    }
    await downloadOfflineLibrary();
  } catch (error) {
    updateOfflineStatus(error.message || 'No se pudo preparar el almacenamiento offline.');
    showToast(state.offlineStatus, true);
  }
}

function renderCurrentView() {
  const isSongsView = state.currentTab === 'songs' && !state.currentPlaylistId;
  if (state.currentPlaylistId) {
    renderPlaylistDetail();
    updateHomeLyrics();
    syncProfileProgressTimer();
    return;
  }
  const renderers = {
    home: renderHome,
    songs: renderSongs,
    profile: renderProfile,
    settings: renderSettings
  };
  (renderers[state.currentTab] || renderHome)();
  if (isSongsView) {
    const scrollTop = state.songSearchScrollTop;
    window.requestAnimationFrame(() => {
      if (state.currentTab === 'songs' && !state.currentPlaylistId) {
        window.scrollTo(0, scrollTop);
      }
    });
  }
  updateHomeLyrics();
  syncProfileProgressTimer();
}

function renderDrawerPlaylists() {
  const drawerPlaylists = document.getElementById('drawer-playlists');
  drawerPlaylists.replaceChildren();
  if (!state.playlists.length) {
    drawerPlaylists.append(makeElement('p', 'drawer-empty', 'Aún no hay playlists.'));
    return;
  }
  state.playlists.forEach(playlist => {
    const button = makeButton('drawer-playlist', `Abrir playlist ${playlist.name}`, () => openPlaylist(playlist.id));
    const cover = getPlaylistCover(playlist);
    if (cover) button.append(imageElement(cover, '', ''));
    else button.append(makeElement('span', 'drawer-playlist-art', '♫'));
    button.append(makeElement('span', 'drawer-playlist-name', playlist.name || 'Playlist'));
    const playlistId = String(playlist.id);
    const isSyncPending = (playlist.tracks || []).some(track => track.syncPending)
      || [...pendingPlaylistAdds].some(key => key.startsWith(`${playlistId}:`));
    if (isSyncPending) {
      const indicator = makeElement('span', 'sync-spinner');
      indicator.setAttribute('role', 'status');
      indicator.setAttribute('aria-label', 'Sincronizando cambios de playlist');
      button.append(indicator);
    }
    drawerPlaylists.append(button);
  });
}

function renderDrawerFriends() {
  const friendsList = document.getElementById('drawer-friends');
  if (!friendsList) return;
  friendsList.replaceChildren();
  if (!state.friends.length) {
    friendsList.append(makeElement('p', 'drawer-empty', 'Aún no tienes amigos.'));
    return;
  }
  state.friends.forEach(friend => {
    const unreadCount = state.unreadMessageCounts.get(String(friend._id)) || 0;
    const button = makeButton('drawer-friend', `Ver perfil de ${friend.username}`, () => {
      void openFriendProfile(friend);
    });
    const copy = makeElement('span', 'drawer-friend-copy');
    let unreadBadge = null;
    copy.append(makeElement('span', '', friend.username || 'Usuario'));
    const playback = friend.lastPlayed;
    if (playback?.songName) {
      const isListening = Boolean(friend.isOnline && playback.isPlaying !== false);
      const playbackLabel = makeElement('small', 'drawer-friend-playback', playback.songName);
      const deviceIcon = createPlaybackDeviceIcon(getPlaybackDeviceType(playback));
      if (deviceIcon && isListening) playbackLabel.append(deviceIcon);
      copy.append(playbackLabel);
      if (!isListening) {
        const lastHeard = getPlaybackLastHeardLabel(playback, false);
        copy.append(makeElement('small', 'drawer-friend-playback',
          `Estaba escuchando${lastHeard ? ` · ${lastHeard}` : ''}`));
      }
    }
    if (unreadCount) {
      unreadBadge = makeElement('small', 'drawer-friend-unread',
        unreadCount > 99 ? '99+' : String(unreadCount));
    }
    button.append(imageElement(getUserPhoto(friend) || './img/perrocorasongif.gif', '', ''), copy);
    if (unreadBadge) button.append(unreadBadge);
    friendsList.append(button);
  });
}

function setDrawerOpen(open) {
  const drawer = document.getElementById('mobile-drawer');
  document.getElementById('drawer-scrim').hidden = !open;
  drawer.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', String(!open));
  document.getElementById('nav-toggle').setAttribute('aria-expanded', String(open));
  updateOverlayScrollLock();
}

function updateOverlayScrollLock() {
  document.body.classList.toggle('screen-overlay-open', Boolean(
    document.getElementById('mobile-drawer').classList.contains('open')
    || elements.playerQueue.classList.contains('open')
  ));
}

function updateNavigationState() {
  document.querySelectorAll('.drawer-link').forEach(button => {
    button.classList.toggle('active', button.dataset.tab === state.currentTab);
  });
  document.getElementById('drawer-username').textContent = state.user?.username || 'Usuario';
  setImageSource(
    document.getElementById('drawer-avatar'),
    getUserPhoto(state.user) || './img/perrocorasongif.gif'
  );
  renderDrawerPlaylists();
  renderDrawerFriends();
}

function updateMiniProgress(currentTime, duration) {
  const validDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const current = validDuration ? Math.min(Math.max(currentTime, 0), validDuration) : 0;
  const progress = validDuration ? current / validDuration * 100 : 0;
  elements.miniProgress.style.setProperty('--progress', `${progress}%`);
  elements.miniProgress.setAttribute('aria-valuemax', String(validDuration));
  elements.miniProgress.setAttribute('aria-valuenow', String(current));
  elements.miniProgress.setAttribute('aria-valuetext', `${formatTime(current)} de ${formatTime(validDuration)}`);
}

async function notifyIncomingChatMessage(message) {
  const senderId = String(message.sender || '');
  if (!senderId || senderId === String(state.user?._id || '')) return;
  const friend = state.friends.find(item => String(item._id) === senderId);
  const title = friend?.username || message.senderName || 'Un amigo';
  const avatar = friend ? getUserPhoto(friend) : message.senderPhoto || '';
  const avatarUrl = avatar ? resolveImageUrl(avatar) : '';
  const body = String(message.content || '').trim() || 'Te envió un mensaje.';
  const messageId = String(message._id || `${senderId}-${message.timestamp || Date.now()}`);

  if (isAndroidNative) {
    if (!state.notificationPermissionGranted) return;
    try {
      await nativeMedia.showChatNotification({
        id: messageId,
        title,
        body,
        avatarUrl
      });
    } catch (error) {
      console.error('No se pudo mostrar la notificación de chat.', error);
    }
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted'
    || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const appIcon = new URL('./icon.svg', document.baseURI).href;
    await registration.showNotification(title, {
      body,
      icon: avatarUrl || appIcon,
      badge: appIcon,
      tag: `amgc-chat-${messageId}`,
      renotify: true,
      data: { type: 'chat-message', friendId: senderId }
    });
  } catch (error) {
    console.error('No se pudo mostrar la notificación de chat.', error);
  }
}

function updateSeekButton(buttonId, direction, seconds) {
  const button = document.getElementById(buttonId);
  if (!button) {
    console.error(`No se encontró el control de salto "${buttonId}".`);
    return;
  }
  button.setAttribute('aria-label', `${direction === '↶' ? 'Retroceder' : 'Avanzar'} ${seconds} segundos`);
}

function seekBySeconds(seconds) {
  const remotePlayback = getRemotePlaybackSession();
  if (remotePlayback) {
    const duration = Math.max(0, Number(remotePlayback.duration) || 0);
    const position = Math.max(0, getRemoteSeekPosition(remotePlayback) + seconds);
    queueRemoteSeek(duration ? Math.min(duration, position) : position);
    return;
  }
  if (isRemotePlaybackLocked()) return;
  const duration = elements.audio.duration;
  const maximum = Number.isFinite(duration) && duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
  elements.audio.currentTime = Math.min(maximum, Math.max(0, elements.audio.currentTime + seconds));
}

function updatePlayerSource() {
  elements.playerSource.replaceChildren();
  if (!state.followingUserId) return;
  const friend = state.friends.find(item => String(item._id) === String(state.followingUserId));
  elements.playerSource.append(
    document.createTextNode(`Escuchando junto a ${friend?.username || 'un amigo'}`),
    makeButton('player-source-stop', 'Dejar de escuchar junto a este amigo', stopFollowingFriend, 'Dejar')
  );
}

function openPlaylist(playlistId) {
  state.currentPlaylistId = playlistId;
  state.currentTab = 'playlists';
  state.profileUser = null;
  renderPlaylistDetail();
  updateHomeLyrics();
  updateNavigationState();
  setDrawerOpen(false);
  elements.mainView.scrollTop = 0;
}

function updatePlayerUI() {
  const remotePlayback = state.remotePlayback;
  if (remotePlayback?.deviceId && remotePlayback.deviceId !== playbackDeviceId) {
    const duration = Math.max(0, Number(remotePlayback.duration) || 0);
    const currentTime = getSharedPlaybackTime(remotePlayback);
    const progress = duration > 0 ? Math.min(100, currentTime / duration * 100) : 0;
    const title = remotePlayback.songName || 'Canción';
    const artist = remotePlayback.artist || 'Artista desconocido';
    const cover = getPlaybackCover(remotePlayback, null, 'large') || './icon.svg';
    elements.playerSource.replaceChildren();
    const lyricsSong = getLyricsSong();
    const trackColor = typeof remotePlayback.color === 'string' && CSS.supports('color', remotePlayback.color)
      ? remotePlayback.color
      : '#ffffff';
    const lyricsColor = typeof remotePlayback.color === 'string' && CSS.supports('color', remotePlayback.color)
      ? remotePlayback.color
      : '#151515';
    document.documentElement.style.setProperty('--track-color', trackColor);
    elements.lyricsScreen.style.setProperty('--lyrics-color', lyricsColor);
    elements.lyricsScreen.style.setProperty('--lyrics-text-color', getContrastingTextColor(lyricsColor));
    elements.playerScreenStatus.textContent = remotePlayback.isPlaying === false ? 'PAUSADO' : 'REPRODUCIENDO';
    elements.playerTitle.textContent = title;
    updatePlaybackDevicePickerIcons();
    elements.playerArtist.textContent = artist;
    setImageSource(elements.playerCover, cover, { size: 'large' });
    elements.miniTitle.textContent = title;
    elements.miniArtist.textContent = artist;
    elements.miniArtist.setAttribute('aria-label', artist);
    elements.miniArtist.title = artist;
    setImageSource(elements.miniCover, cover, { size: 'large' });
    elements.playerDuration.textContent = formatTime(duration);
    document.getElementById('player-current-time').textContent = formatTime(currentTime);
    elements.playerProgress.value = duration ? String(Math.round(currentTime / duration * 1000)) : '0';
    document.documentElement.style.setProperty('--progress', `${progress}%`);
    updateMiniProgress(currentTime, duration);
    elements.playerScreen.classList.add('remote-playback');
    elements.playerToggle.disabled = false;
    elements.miniToggle.disabled = false;
    elements.playerProgress.disabled = false;
    elements.miniProgress.setAttribute('aria-disabled', 'false');
    elements.playerToggle.querySelector('img').src = remotePlayback.isPlaying === false ? './img/play.png' : './img/pause.png';
    elements.miniToggle.querySelector('img').src = remotePlayback.isPlaying === false ? './img/play.png' : './img/pause.png';
    elements.playerToggle.setAttribute('aria-label', remotePlayback.isPlaying === false ? 'Reproducir' : 'Pausar');
    elements.miniToggle.setAttribute('aria-label', remotePlayback.isPlaying === false ? 'Reproducir' : 'Pausar');
    document.getElementById('player-shuffle').setAttribute('aria-pressed', String(remotePlayback.shuffle === true));
    document.getElementById('player-queue-shuffle').setAttribute('aria-pressed', String(remotePlayback.shuffle === true));
    renderPlaybackDevicePicker();
    [
      'player-previous',
      'player-next',
      'mini-previous',
      'mini-next',
      'player-seek-backward',
      'player-seek-forward',
      'mini-seek-backward',
      'mini-seek-forward',
      'player-shuffle',
      'player-queue-shuffle'
    ].forEach(id => {
      const control = document.getElementById(id);
      if (control) control.disabled = false;
    });
    document.getElementById('player-add-button').hidden = true;
    if (!elements.lyricsScreen.hidden) {
      if (elements.lyricsLines.dataset.songId !== String(getSongId(lyricsSong))) renderLyrics();
      else updateLyrics();
    }
    void closePlaybackNotification();
    syncMiniPlayerVisibility();
    return;
  }
  elements.playerScreen.classList.remove('remote-playback');
  updatePlaybackDevicePickerIcons();
  elements.miniArtist.removeAttribute('aria-label');
  elements.miniArtist.removeAttribute('title');
  const song = getCurrentSong();
  if (!song) {
    if (!elements.lyricsScreen.hidden) renderLyrics();
    void updatePlaybackNotification();
    document.getElementById('player-add-button').hidden = true;
    document.getElementById('player-screen-status').textContent = 'PAUSADO';
    elements.miniTitle.textContent = 'Elige una canción';
    elements.miniArtist.textContent = '-';
    elements.playerTitle.textContent = 'Elige una canción';
    elements.playerArtist.textContent = '-';
    elements.playerSource.replaceChildren();
    setImageSource(elements.miniCover, './icon.svg');
    setImageSource(elements.playerCover, './icon.svg');
    updateMiniProgress(0, 0);
    document.getElementById('player-current-time').textContent = '0:00';
    elements.playerProgress.value = '0';
    elements.miniToggle.disabled = true;
    elements.playerToggle.disabled = true;
    document.getElementById('mini-seek-backward').disabled = true;
    document.getElementById('mini-seek-forward').disabled = true;
    elements.playerProgress.disabled = true;
    elements.miniProgress.setAttribute('aria-disabled', 'true');
    [
      'player-previous',
      'player-next',
      'mini-previous',
      'mini-next',
      'player-seek-backward',
      'player-seek-forward',
      'player-shuffle',
      'player-queue-shuffle'
    ].forEach(id => {
      const control = document.getElementById(id);
      if (control) control.disabled = true;
    });
    updateHomeLyrics();
    syncMiniPlayerVisibility();
    return;
  }

  const title = song.name || 'Canción sin título';
  const artist = song.artist || 'Artista desconocido';
  const cover = getSongCover(song, 'large');
  document.getElementById('player-screen-status').textContent = elements.audio.paused ? 'PAUSADO' : 'REPRODUCIENDO';
  updatePlayerSource();
  const trackColor = typeof song.color === 'string' && CSS.supports('color', song.color)
    ? song.color
    : '#ffffff';
  document.documentElement.style.setProperty('--track-color', trackColor);
  const lyricsColor = typeof song.color === 'string' && CSS.supports('color', song.color)
    ? song.color
    : '#151515';
  const lyricsTextColor = getContrastingTextColor(lyricsColor);
  elements.lyricsScreen.style.setProperty('--lyrics-color', lyricsColor);
  elements.lyricsScreen.style.setProperty('--lyrics-text-color', lyricsTextColor);
  document.getElementById('player-add-button').hidden = false;
  elements.miniToggle.disabled = false;
  elements.playerToggle.disabled = false;
  elements.playerProgress.disabled = false;
  elements.miniProgress.setAttribute('aria-disabled', 'false');
  document.getElementById('mini-seek-backward').disabled = false;
  document.getElementById('mini-seek-forward').disabled = false;
  [
    'player-previous',
    'player-next',
    'mini-previous',
    'mini-next',
    'player-seek-backward',
    'player-seek-forward',
    'player-shuffle',
    'player-queue-shuffle'
  ].forEach(id => {
    const control = document.getElementById(id);
    if (control) control.disabled = false;
  });
  elements.playerTitle.textContent = title;
  elements.playerArtist.textContent = artist;
  setImageSource(elements.playerCover, cover || './icon.svg', { size: 'large' });
  setImageSource(elements.miniCover, cover || './icon.svg', { size: 'large' });
  elements.miniTitle.textContent = title;
  elements.miniArtist.textContent = artist;
  elements.playerDuration.textContent = formatTime(Number(song.duration) || elements.audio.duration || 0);
  const currentTime = Number(elements.audio.currentTime) || 0;
  document.getElementById('player-current-time').textContent = formatTime(currentTime);
  elements.playerProgress.value = elements.audio.duration
    ? String(Math.round(currentTime / elements.audio.duration * 1000))
    : '0';
  const playIcon = elements.audio.paused ? './img/play.png' : './img/pause.png';
  elements.miniToggle.replaceChildren(imageElement(playIcon, '', ''));
  elements.playerToggle.replaceChildren(imageElement(playIcon, '', ''));
  elements.miniToggle.setAttribute('aria-label', elements.audio.paused ? 'Reproducir' : 'Pausar');
  elements.playerToggle.setAttribute('aria-label', elements.audio.paused ? 'Reproducir' : 'Pausar');
  document.getElementById('player-shuffle').setAttribute('aria-pressed', String(state.shuffle));
  document.getElementById('player-queue-shuffle').setAttribute('aria-pressed', String(state.shuffle));
  document.documentElement.style.setProperty('--progress', `${elements.audio.duration ? elements.audio.currentTime / elements.audio.duration * 100 : 0}%`);
  updateMiniProgress(currentTime, elements.audio.duration);
  updateSeekButton('player-seek-backward', '↶', state.seekSeconds);
  updateSeekButton('player-seek-forward', '↷', state.seekSeconds);
  updateSeekButton('mini-seek-backward', '↶', state.seekSeconds);
  updateSeekButton('mini-seek-forward', '↷', state.seekSeconds);
  renderPlayerQueue();
  if (state.sharedQueueRole === 'host') emitSharedQueueSnapshot();
  if (!elements.lyricsScreen.hidden && elements.lyricsLines.dataset.songId !== String(getSongId(song))) {
    renderLyrics();
  } else {
    updateLyrics();
  }
  if (!isAndroidNative && 'mediaSession' in navigator && typeof MediaMetadata === 'function') {
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album: 'AMGC · A Miracle Growing Constantly',
      artwork: cover ? [{ src: resolveImageUrl(cover), sizes: '512x512', type: 'image/jpeg' }] : []
    });
    navigator.mediaSession.playbackState = elements.audio.paused ? 'paused' : 'playing';
    if (Number.isFinite(elements.audio.duration) && elements.audio.duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: elements.audio.duration,
          playbackRate: elements.audio.playbackRate || 1,
          position: Math.min(elements.audio.currentTime, elements.audio.duration)
        });
      } catch (error) {
        console.warn('No se pudo actualizar la posición multimedia.', error);
      }
    }
  }
  void updatePlaybackNotification();
  syncMiniPlayerVisibility();
}

function syncMiniPlayerVisibility() {
  const overlayOpen = !elements.playerScreen.hidden || !elements.lyricsScreen.hidden || !elements.chatScreen.hidden;
  elements.miniPlayer.hidden = overlayOpen || !state.user;
  document.body.classList.toggle('screen-overlay-open', !elements.playerScreen.hidden || !elements.lyricsScreen.hidden);
}

elements.playerTitle = document.getElementById('player-title');
elements.playbackDevicePickerTrigger = document.getElementById('playback-device-picker-trigger');
elements.playbackDevicePicker = document.getElementById('playback-device-picker');
elements.playbackDeviceList = document.getElementById('playback-device-list');
elements.playerArtist = document.getElementById('player-artist');
elements.playerCover = document.getElementById('player-cover');
elements.playerScreenStatus = document.getElementById('player-screen-status');
elements.playerDuration = document.getElementById('player-duration');
elements.playerToggle = document.getElementById('player-toggle');
elements.miniToggle = document.getElementById('mini-toggle');
elements.miniCover = document.getElementById('mini-cover');
elements.miniTitle = document.getElementById('mini-title');
elements.miniArtist = document.getElementById('mini-artist');
elements.miniPlaybackDeviceTrigger = document.getElementById('mini-playback-device-trigger');
elements.miniProgress = document.getElementById('mini-progress');
elements.miniPrevious = document.getElementById('mini-previous');
elements.miniNext = document.getElementById('mini-next');
elements.playerProgress = document.getElementById('player-progress');
elements.playerVolume = document.getElementById('player-volume');
elements.lyricsLines = document.getElementById('lyrics-lines');
elements.lyricsSongTitle = document.getElementById('lyrics-song-title');
elements.lyricsSongArtist = document.getElementById('lyrics-song-artist');
elements.homeLyricTrack = document.getElementById('home-lyric-track');
elements.homeLyricCurrent = document.getElementById('home-lyric-current');
elements.homeLyricNext = document.getElementById('home-lyric-next');
elements.homeLyricIncoming = document.getElementById('home-lyric-incoming');
elements.homeSecretPhrase = document.getElementById('home-secret-phrase');

function getTrackLyrics(song) {
  if (Array.isArray(song?.lyrics)) {
    return song.lyrics.filter(line => Number.isFinite(Number(line?.time)) && typeof line.text === 'string')
      .map(line => ({ time: Number(line.time), text: line.text }))
      .sort((left, right) => left.time - right.time);
  }
  if (typeof song?.lyrics !== 'string' || !song.lyrics.trim()) return [];
  const lines = song.lyrics.split(/\r?\n/).filter(line => line.trim());
  const timedLines = lines.map(line => {
    const match = line.match(/^\s*\[(\d+:\d{1,2}(?:\.\d{1,3})?)\]\s*(.*)$/)
      || line.match(/^\s*(\d+:\d{1,2}(?:\.\d{1,3})?|\d+(?:\.\d+)?)\s*(?:\||-)\s*(.*)$/);
    if (!match) return null;
    const parts = match[1].split(':');
    const time = parts.length === 2
      ? Number(parts[0]) * 60 + Number(parts[1])
      : Number(parts[0]);
    return Number.isFinite(time) ? { time, text: match[2] } : null;
  });
  if (timedLines.every(Boolean)) return timedLines.sort((left, right) => left.time - right.time);
  return lines.map(text => ({ time: 0, text }));
}

function renderLyrics() {
  const song = getLyricsSong();
  if (!song) {
    elements.lyricsSongTitle.textContent = '';
    elements.lyricsSongArtist.textContent = '';
    elements.lyricsLines.replaceChildren(makeElement('li', 'lyrics-empty-state', 'No hay una canción en reproducción.'));
    elements.lyricsLines.dataset.songId = '';
    return;
  }
  elements.lyricsLines.dataset.songId = String(getSongId(song));
  elements.lyricsSongTitle.textContent = song.name || 'Canción sin título';
  elements.lyricsSongArtist.textContent = song.artist || 'Artista desconocido';
  state.activeLyricIndex = -1;
  const lyrics = getTrackLyrics(song);
  elements.lyricsLines.replaceChildren();
  if (!lyrics.length) {
    elements.lyricsLines.append(makeElement('li', 'lyrics-empty-state', 'Aún no hay letra sincronizada para esta canción.'));
    return;
  }
  lyrics.forEach((line, index) => {
    const item = makeElement('li', 'timed-lyric-line');
    item.dataset.lyricIndex = String(index);
    item.dataset.time = String(line.time);
    const seek = makeElement('button', 'timed-lyric-seek');
    seek.type = 'button';
    seek.setAttribute('aria-label', `Ir a ${formatTime(line.time)}: ${line.text}`);
    seek.addEventListener('click', () => {
      if (line.time <= 0) return;
      if (getRemotePlaybackSession()) {
        void requestRemotePlaybackControl('seek', { position: line.time });
      } else {
        elements.audio.currentTime = line.time;
      }
    });
    const timestamp = makeElement('span', 'timed-lyric-timestamp', formatTime(line.time));
    const content = makeElement('span', 'timed-lyric-content');
    renderLyricText(content, line.text, song, index, line.time, false);
    seek.append(timestamp, content);
    item.append(seek);
    elements.lyricsLines.append(item);
  });
  updateLyrics();
}

function getLyricLineKey(index, time) {
  return `${index}:${Number(time).toFixed(3)}`;
}

function renderLyricText(target, text, song, lineIndex, lineTime, active) {
  target.replaceChildren();
  const assignments = song?.lyricColorAssignments?.[getLyricLineKey(lineIndex, lineTime)] || {};
  const wordPattern = /[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*/gu;
  const markedPattern = /(?<!\*)\*([^*]+?)\*(?!\*)/g;
  let wordIndex = 0;
  const appendWords = (parent, segment, marked) => {
    let offset = 0;
    for (const match of segment.matchAll(wordPattern)) {
      const position = match.index ?? 0;
      parent.append(document.createTextNode(segment.slice(offset, position)));
      const word = makeElement('span', 'lyric-word', match[0]);
      word.dataset.lyricWordIndex = String(wordIndex);
      const assigned = marked ? assignments[String(wordIndex)] : null;
      if (marked && assigned) {
        const color = assigned === 'default' ? (song?.color || '#ffffff') : assigned;
        word.dataset.lyricAssignedColor = assigned;
        word.style.color = active ? color : '#929292';
        if (assigned !== 'default') word.style.textShadow = active ? `0 0 8px ${color}` : 'none';
      }
      parent.append(word);
      wordIndex += 1;
      offset = position + match[0].length;
    }
    parent.append(document.createTextNode(segment.slice(offset)));
  };
  let offset = 0;
  for (const match of text.matchAll(markedPattern)) {
    const position = match.index ?? 0;
    appendWords(target, text.slice(offset, position), false);
    const highlighted = makeElement('span', 'lyric-highlight', '');
    highlighted.style.color = active ? (song?.color || '#ff8a00') : '#929292';
    highlighted.style.textShadow = active ? `0 0 8px ${song?.color || '#ff8a00'}` : 'none';
    appendWords(highlighted, match[1], true);
    target.append(highlighted);
    offset = position + match[0].length;
  }
  appendWords(target, text.slice(offset), false);
}

function updateLyrics() {
  const currentSong = getLyricsSong();
  const remotePlayback = getRemotePlaybackSession();
  const playbackTime = remotePlayback
    ? getSharedPlaybackTime(remotePlayback)
    : elements.audio.currentTime;
  const lyrics = getTrackLyrics(currentSong);
  const hasTimestamps = !(lyrics.length > 1 && lyrics.every(line => line.time === 0));
  const activeIndex = !hasTimestamps
    ? -1
    : lyrics.reduce((active, line, index) => (
    line.time <= playbackTime ? index : active
    ), -1);
  if (!elements.lyricsScreen.hidden) {
    elements.lyricsLines.querySelectorAll('.timed-lyric-line').forEach((line, index) => {
      line.classList.toggle('active', index === activeIndex);
      line.classList.toggle('previous', hasTimestamps && index === activeIndex - 1);
      line.classList.toggle('next', hasTimestamps && index === activeIndex + 1);
      const lyric = lyrics[index];
      const content = line.querySelector('.timed-lyric-content');
      if (lyric && content) renderLyricText(content, lyric.text, currentSong, index, lyric.time, index === activeIndex);
    });
    if (activeIndex !== state.activeLyricIndex && activeIndex >= 0) {
      elements.lyricsLines.querySelector(`[data-lyric-index="${activeIndex}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  state.activeLyricIndex = activeIndex;
  updateHomeLyrics(lyrics, activeIndex, currentSong);
}

function finishHomeLyricTransition() {
  if (!state.homeLyricAnimationTimeout) return;
  clearTimeout(state.homeLyricAnimationTimeout);
  state.homeLyricAnimationTimeout = null;
  elements.homeLyricCurrent.replaceChildren(...elements.homeLyricNext.childNodes);
  elements.homeLyricNext.replaceChildren(...elements.homeLyricIncoming.childNodes);
  elements.homeLyricIncoming.replaceChildren();
  elements.homeLyrics.classList.remove('is-advancing');
  elements.homeLyrics.classList.add('is-repositioning');
  void elements.homeLyricTrack.offsetHeight;
  elements.homeLyrics.classList.remove('is-repositioning');
  elements.homeLyrics.scrollTop = 0;
  updateHomeLyricLayout();
  if (state.pendingHomeLyricIndex !== null) {
    elements.homeLyrics.dataset.activeIndex = String(state.pendingHomeLyricIndex);
    state.pendingHomeLyricIndex = null;
  }
}

elements.homeLyricTrack?.addEventListener('transitionend', event => {
  if (
    event.target === elements.homeLyricNext
    && event.propertyName === 'transform'
    && state.homeLyricAnimationTimeout
  ) {
    finishHomeLyricTransition();
  }
});

function setHomeLyricAppearance(target, song, active) {
  target.querySelectorAll('.lyric-highlight').forEach(highlight => {
    highlight.style.color = active ? (song?.color || '#ff8a00') : '#929292';
    highlight.style.textShadow = active ? `0 0 8px ${song?.color || '#ff8a00'}` : 'none';
  });
  target.querySelectorAll('[data-lyric-assigned-color]').forEach(word => {
    const assigned = word.dataset.lyricAssignedColor;
    const color = assigned === 'default' ? (song?.color || '#ffffff') : assigned;
    word.style.color = active ? color : '#929292';
    word.style.textShadow = active && assigned !== 'default' ? `0 0 8px ${color}` : 'none';
  });
}

function measureHomeLyricHeight(text, song, index, time, slot = 'current') {
  const measurement = elements.homeLyricCurrent.cloneNode(false);
  measurement.removeAttribute('id');
  measurement.className = `home-lyric-slot ${slot}`;
  Object.assign(measurement.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    transform: 'none',
    visibility: 'hidden',
    overflow: 'visible',
    textOverflow: 'clip',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
  });
  renderLyricText(measurement, text, song, index, time, slot === 'current');
  elements.homeLyricTrack.append(measurement);
  const height = measurement.getBoundingClientRect().height;
  measurement.remove();
  return height;
}

function homeLyricNeedsExpansion(text, song, index, time, nextLyric) {
  const currentHeight = measureHomeLyricHeight(text, song, index, time);
  const nextHeight = nextLyric
    ? measureHomeLyricHeight(nextLyric.text, song, index + 1, nextLyric.time, 'next')
    : 0;
  const fontSize = Number.parseFloat(window.getComputedStyle(elements.homeLyricTrack).fontSize) || 16;
  const step = Math.max(fontSize * 1.8, currentHeight / 2 + 8 + nextHeight / 2);
  const trackHeight = Math.max(fontSize * 6.4, step * 2 + nextHeight);
  const top = Number.parseFloat(window.getComputedStyle(elements.homeLyrics).top) || 68;
  const safeBottom = Number.parseFloat(
    window.getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom'),
  ) || 0;
  return trackHeight > window.innerHeight - top - 69 - safeBottom;
}

function updateHomeLyricLayout(forceExpanded = null) {
  const currentHeight = elements.homeLyricCurrent.getBoundingClientRect().height;
  const nextHeight = elements.homeLyricNext.getBoundingClientRect().height;
  const fontSize = Number.parseFloat(window.getComputedStyle(elements.homeLyricTrack).fontSize) || 16;
  const step = Math.max(fontSize * 1.8, currentHeight / 2 + 8 + nextHeight / 2);
  const trackHeight = Math.max(fontSize * 6.4, step * 2 + nextHeight);
  const top = Number.parseFloat(window.getComputedStyle(elements.homeLyrics).top) || 68;
  const safeBottom = Number.parseFloat(
    window.getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom'),
  ) || 0;
  elements.homeLyricTrack.style.setProperty('--lyric-slot-step', `${step}px`);
  elements.homeLyricTrack.style.setProperty('--lyric-track-height', `${trackHeight}px`);
  elements.homeLyrics.classList.toggle(
    'is-expanded',
    forceExpanded ?? trackHeight > window.innerHeight - top - 69 - safeBottom,
  );
}

function updateHomeLyrics(
  lyrics = getTrackLyrics(getCurrentSong()),
  activeIndex = state.activeLyricIndex,
  song = getCurrentSong()
) {
  if (!elements.homeLyrics) return;
  const activeLyric = activeIndex >= 0 ? lyrics[activeIndex] : null;
  const shouldShow = state.currentTab === 'home' && !state.currentPlaylistId
    && Boolean(activeLyric?.text.trim());
  elements.homeLyrics.hidden = !shouldShow;
  updateHomeSecretPhrase();
  if (!shouldShow) {
    finishHomeLyricTransition();
    elements.homeLyrics.classList.remove('is-expanded');
    elements.homeLyricTrack.style.removeProperty('--lyric-slot-step');
    elements.homeLyricTrack.style.removeProperty('--lyric-track-height');
    elements.homeLyrics.dataset.activeKey = '';
    return;
  }

  const activeKey = `${getSongId(song)}:${activeIndex}:${activeLyric.text}:${JSON.stringify(song?.lyricColorAssignments || {})}`;
  if (elements.homeLyrics.dataset.activeKey === activeKey) return;
  const requiresExpansion = homeLyricNeedsExpansion(
    activeLyric.text, song, activeIndex, activeLyric.time, lyrics[activeIndex + 1],
  );
  finishHomeLyricTransition();
  const previousTrackId = elements.homeLyrics.dataset.trackId;
  const previousIndex = Number(elements.homeLyrics.dataset.activeIndex);
  const shouldAdvance = previousTrackId === getSongId(song)
    && Number.isInteger(previousIndex)
    && previousIndex >= 0
    && activeIndex === previousIndex + 1;
  elements.homeLyrics.dataset.activeKey = activeKey;
  elements.homeLyrics.dataset.trackId = getSongId(song);
  if (shouldAdvance) {
    const nextLyric = lyrics[activeIndex + 1];
    setHomeLyricAppearance(elements.homeLyricCurrent, song, false);
    setHomeLyricAppearance(elements.homeLyricNext, song, true);
    elements.homeLyricIncoming.replaceChildren();
    if (nextLyric) {
      renderLyricText(elements.homeLyricIncoming, nextLyric.text, song,
        activeIndex + 1, nextLyric.time, false);
      setHomeLyricAppearance(elements.homeLyricIncoming, song, false);
    }
    updateHomeLyricLayout(requiresExpansion);
    elements.homeLyrics.classList.add('is-advancing');
    state.pendingHomeLyricIndex = activeIndex;
    const transitionDuration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 20 : 900;
    state.homeLyricAnimationTimeout = window.setTimeout(finishHomeLyricTransition, transitionDuration);
    return;
  }

  elements.homeLyrics.classList.remove('is-advancing', 'is-repositioning');
  renderLyricText(elements.homeLyricCurrent, activeLyric.text, song,
    activeIndex, activeLyric.time, true);
  setHomeLyricAppearance(elements.homeLyricCurrent, song, true);
  const nextLyric = lyrics[activeIndex + 1];
  if (nextLyric) {
    renderLyricText(elements.homeLyricNext, nextLyric.text, song,
      activeIndex + 1, nextLyric.time, false);
    setHomeLyricAppearance(elements.homeLyricNext, song, false);
  } else {
    elements.homeLyricNext.replaceChildren();
  }
  elements.homeLyricIncoming.replaceChildren();
  elements.homeLyrics.dataset.activeIndex = String(activeIndex);
  updateHomeLyricLayout(requiresExpansion);
}

window.addEventListener('resize', () => {
  if (state.homeLyricAnimationTimeout) finishHomeLyricTransition();
  elements.homeLyrics.dataset.activeKey = '';
  updateHomeLyrics();
});

function showRandomSecretPhrase() {
  if (!state.secretPhrases.length) {
    state.previousSecretPhrase = '';
    updateHomeSecretPhrase();
    return;
  }
  const choices = state.secretPhrases.filter(phrase => phrase !== state.previousSecretPhrase);
  state.previousSecretPhrase = (choices.length ? choices : state.secretPhrases)[
    Math.floor(Math.random() * (choices.length || state.secretPhrases.length))
  ];
  updateHomeSecretPhrase();
}

function updateHomeSecretPhrase() {
  if (!elements.homeSecretPhrase) return;
  const shouldShow = state.currentTab === 'home' && !state.currentPlaylistId
    && Boolean(state.previousSecretPhrase);
  elements.homeSecretPhrase.hidden = !shouldShow;
  if (shouldShow) elements.homeSecretPhrase.textContent = state.previousSecretPhrase;
}

function animateHomeSymbol(timestamp) {
  if (!homeSpinActive || document.hidden || state.currentTab !== 'home' || state.currentPlaylistId) {
    homeSpinFrame = null;
    return;
  }
  if (!homeSpinLastFrameAt || timestamp - homeSpinLastFrameAt >= 1000 / 30) {
    const elapsed = homeSpinLastFrameAt ? Math.min(timestamp - homeSpinLastFrameAt, 100) : 1000 / 30;
    homeSpinRotation += 9 * elapsed / 1000;
    const symbol = document.querySelector('.home-symbol');
    if (symbol) symbol.style.transform = `rotate(${homeSpinRotation}deg)`;
    homeSpinLastFrameAt = timestamp;
  }
  homeSpinFrame = requestAnimationFrame(animateHomeSymbol);
}

function resumeHomeSpin() {
  if (
    !homeSpinActive
    || document.hidden
    || state.currentTab !== 'home'
    || state.currentPlaylistId
    || homeSpinFrame
  ) return;
  homeSpinLastFrameAt = 0;
  homeSpinFrame = requestAnimationFrame(animateHomeSymbol);
}

function startHomeSpin() {
  if (homeSpinActive) return;
  homeSpinActive = true;
  homeSpinLastFrameAt = 0;
  const symbol = document.querySelector('.home-symbol');
  if (symbol) symbol.style.transition = 'none';
  resumeHomeSpin();
}

function stopHomeSpin() {
  if (homeSpinTimer) {
    clearTimeout(homeSpinTimer);
    homeSpinTimer = null;
  }
  if (!homeSpinActive) return;
  homeSpinActive = false;
  cancelAnimationFrame(homeSpinFrame);
  homeSpinFrame = null;
  homeSpinLastFrameAt = 0;
  const remainder = homeSpinRotation % 360;
  let targetRotation = homeSpinRotation - remainder;
  if (remainder > 180) targetRotation += 360;
  const symbol = document.querySelector('.home-symbol');
  if (symbol) {
    symbol.style.transition = 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)';
    symbol.style.transform = `rotate(${targetRotation}deg)`;
  }
  window.setTimeout(() => {
    if (homeSpinActive) return;
    homeSpinRotation = 0;
    const currentSymbol = document.querySelector('.home-symbol');
    if (currentSymbol) {
      currentSymbol.style.transition = 'none';
      currentSymbol.style.transform = 'rotate(0deg)';
    }
  }, 450);
}

function resetHomeSpin() {
  if (homeSpinTimer) clearTimeout(homeSpinTimer);
  stopHomeSpin();
  homeSpinTimer = window.setTimeout(startHomeSpin, 10000);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(homeSpinFrame);
    homeSpinFrame = null;
  } else resumeHomeSpin();
  syncProfileProgressTimer();
  if (isAndroidNative && state.customNotificationEnabled) {
    void updatePlaybackNotification();
  }
  if (!document.hidden && state.token) {
    void loadSpotifyStatus(state.spotifySectionOpen && !state.spotifyTracksLoaded);
  }
});

function renderPlayerQueue({ syncAccount = true, syncShared = true } = {}) {
  const queueList = document.getElementById('player-queue-list');
  if (!elements.playerQueue || !queueList) return;
  updateJamControls();
  const queueSyncIndicator = document.getElementById('player-queue-sync-indicator');
  if (queueSyncIndicator) {
    queueSyncIndicator.hidden = !(
      Array.isArray(state.accountQueuePendingIds)
      || state.accountQueueSyncInFlight
      || state.sharedQueueJamUpdateInFlight
    );
  }
  queueList.replaceChildren();
  const remotePlayback = getRemotePlaybackSession();
  const isLocalQueue = !remotePlayback
    && !state.followingUserId
    && state.sharedQueueRole !== 'follower';
  const showAccountQueue = Boolean(remotePlayback);
  const currentSong = remotePlayback ? getLyricsSong() : getCurrentSong();
  const upcoming = showAccountQueue
    ? getDisplayedAccountQueueIds().map((id, position) => ({
      song: state.songs.find(song => getSongId(song) === id),
      position
    })).filter(item => item.song)
    : state.sharedQueueRole === 'follower'
    ? state.sharedQueueJamActive
      ? getDisplayedSharedUpcomingIds().map((id, position) => ({
        song: state.songs.find(song => getSongId(song) === id),
        position
      })).filter(item => item.song)
      : []
    : state.upcomingQueue.map((song, position) => ({ song, position }));
  const activePlaylist = state.queueTitle === 'GENERAL'
    ? null
    : state.playlists.find(playlist => playlist.name === state.queueTitle);
  const sourceQueue = isLocalQueue
    ? state.queueTitle === 'GENERAL'
      ? state.sharedQueueJamActive ? state.queue : state.songs
      : state.sharedQueueJamActive ? state.queue : activePlaylist?.tracks || state.queue
    : [];
  const sourceQueueIndices = state.shuffle
    ? state.shuffleQueue
    : state.queueIndex < 0
      ? []
      : Array.from(
        { length: Math.max(0, state.queue.length - 1) },
        (_, offset) => (state.queueIndex + offset + 1) % state.queue.length
      );
  const displayedSourceItems = sourceQueueIndices
    .map(index => {
      const queuedSong = state.queue[index];
      if (!queuedSong) return null;
      const sourceIndex = sourceQueue.findIndex(song => getSongId(song) === getSongId(queuedSong));
      return sourceIndex >= 0 ? { song: sourceQueue[sourceIndex], index: sourceIndex } : null;
    })
    .filter(Boolean);
  const sharedSourceItems = state.sharedQueueRole === 'follower'
    ? state.sharedQueueIds
      .map(id => state.songs.find(song => getSongId(song) === id))
      .filter(Boolean)
    : [];

  if (currentSong) {
    queueList.append(makeElement('p', 'queue-section-label', 'REPRODUCIENDO AHORA'));
    queueList.append(renderQueueTrack(currentSong, true));
  }

  if (upcoming.length) {
    queueList.append(makeElement('p', 'queue-section-label',
      'A CONTINUACIÓN EN LA COLA'));
    upcoming.forEach(({ song, position }) => {
      queueList.append(renderQueueTrack(song, false, {
        position,
        removable: Boolean(remotePlayback)
          || state.sharedQueueRole !== 'follower'
          || state.sharedQueueJamActive,
        draggable: Boolean(remotePlayback)
          || state.sharedQueueRole !== 'follower'
          || state.sharedQueueJamActive
      }));
    });
  }

  if (displayedSourceItems.length) {
    queueList.append(makeElement(
      'p',
      'queue-section-label',
      state.sharedQueueJamActive && state.queueTitle === 'GENERAL' ? 'JAM' : state.queueTitle || 'GENERAL'
    ));
    displayedSourceItems.forEach(({ song, index }) => {
      if (song) queueList.append(renderQueueTrack(
        song,
        getSongId(song) === getSongId(currentSong),
        { sourceIndex: index, source: true, sourceQueue, queueTitle: state.queueTitle }
      ));
    });
  } else if (showAccountQueue && state.accountQueueSourceIds.length) {
    const accountSourceItems = state.accountQueueSourceIds
      .map(id => state.songs.find(song => getSongId(song) === String(id)))
      .filter(Boolean);
    if (accountSourceItems.length) {
      queueList.append(makeElement(
        'p',
        'queue-section-label',
        state.accountQueueName || 'GENERAL'
      ));
      accountSourceItems.forEach(song => queueList.append(renderQueueTrack(song, false, {
        position: -1,
        source: true,
        sharedSource: true
      })));
    }
  } else if (sharedSourceItems.length) {
    queueList.append(makeElement(
      'p',
      'queue-section-label',
      state.sharedQueueJamActive && state.sharedQueueHostQueueName === 'GENERAL'
        ? 'JAM'
        : state.sharedQueueHostQueueName || 'GENERAL'
    ));
    sharedSourceItems.forEach(song => {
      queueList.append(renderQueueTrack(song, false, {
        sharedSource: true,
        source: state.sharedQueueJamActive
      }));
    });
  } else if (!upcoming.length && !currentSong) {
    queueList.append(makeElement('p', 'empty-state', 'Reproduce una canción para llenar la cola.'));
  }
  if (syncShared && state.sharedQueueRole === 'host') emitSharedQueueSnapshot();
  if (syncAccount && !remotePlayback && !state.followingUserId && !state.sharedQueueSessionId && currentSong) {
    void publishAccountQueueSnapshot();
  }
}

function renderQueueTrack(song, current, options = {}) {
  const row = makeElement('div', `queue-row${current ? ' current' : ''}`);
  row.dataset.songId = getSongId(song);
  const track = makeElement('div', 'queue-track');
  const copy = makeElement('span', 'queue-track-copy');
  copy.append(
    makeElement('strong', 'queue-track-title', `${current ? '▶ ' : ''}${song.name || 'Canción'}`),
    makeElement('small', 'queue-track-artist', song.artist || 'Artista desconocido')
  );
  const cover = makeElement('span', 'song-cover-loading queue-cover-loading');
  const coverImage = imageElement(getSongCover(song), '', '');
  cover.append(coverImage);
  watchSongCoverLoading(row, cover, coverImage);
  track.append(cover, copy);
  const canPlayAccountQueueTrack = Boolean(getRemotePlaybackSession());
  const canPlayJamQueueTrack = state.sharedQueueRole === 'follower' && state.sharedQueueJamActive;
  if (!current && (
    state.sharedQueueRole !== 'follower'
    || canPlayAccountQueueTrack
    || canPlayJamQueueTrack
  )) {
    track.setAttribute('role', 'button');
    track.tabIndex = 0;
    track.addEventListener('click', () => {
      if (canPlayAccountQueueTrack) requestAccountQueuePlay(song, options.position);
      else if (canPlayJamQueueTrack) requestSharedJamPlayback(
        'playTrack',
        getSongId(song),
        options.sharedSource ? 'source' : 'upcoming'
      );
      else if (options.source) {
        playSourceQueueTrack(options.sourceIndex, options.sourceQueue, options.queueTitle);
      }
      else playUpcomingTrack(options.position);
    });
    track.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (canPlayAccountQueueTrack) requestAccountQueuePlay(song, options.position);
        else if (canPlayJamQueueTrack) requestSharedJamPlayback(
          'playTrack',
          getSongId(song),
          options.sharedSource ? 'source' : 'upcoming'
        );
        else if (options.source) {
          void playSourceQueueTrack(options.sourceIndex, options.sourceQueue, options.queueTitle);
        }
        else playUpcomingTrack(options.position);
      }
    });
  }
  row.append(track);
  if (options.position !== undefined) row.dataset.upcomingPosition = String(options.position);
  if (options.draggable) {
    row.draggable = true;
    row.append(makeButton('drag-handle', 'Arrastrar para cambiar posición', () => {}, '⠿'));
    const reorderQueue = canPlayAccountQueueTrack ? reorderAccountQueue : reorderUpcomingQueue;
    setupTouchReorder(row, '[data-upcoming-position]', reorderQueue);
    row.addEventListener('dragstart', event => {
      event.dataTransfer?.setData('text/plain', String(options.position));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', event => event.preventDefault());
    row.addEventListener('drop', event => {
      event.preventDefault();
      const sourceIndex = Number(event.dataTransfer?.getData('text/plain'));
      if (Number.isInteger(sourceIndex)) reorderQueue(sourceIndex, options.position);
    });
  }
  if (options.removable && !current) {
    row.append(makeButton('queue-remove', 'Quitar de la cola', () => {
      removeUpcomingTrack(options.position);
    }, '×'));
  } else   if ((state.sharedQueueRole === 'follower' || canPlayAccountQueueTrack) && !current && !options.sharedSource) {
    row.append(makeElement(
      'small',
      'queue-shared-label',
      canPlayAccountQueueTrack ? 'Heredada' : state.sharedQueueJamActive ? 'Jam' : 'Compartida'
    ));
  }
  if (options.source) setupQueueAddSwipe(row, song);
  return row;
}

function setupQueueAddSwipe(row, song) {
  let gesture = null;
  let suppressClick = false;
  let clickResetTimer;
  row.classList.add('queue-swipe-target');
  row.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    if (event.target.closest('button:not(.song-play), a, input, .drag-handle')) return;
    gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      horizontalIntent: false,
      moved: false
    };
    row.classList.remove('queue-add-dragging', 'queue-add-ready');
    row.style.transform = '';
  });
  row.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (Math.abs(deltaX) < 5 && Math.abs(deltaY) < 5) return;
    gesture.moved = true;
    if (deltaX < 0 || deltaX < Math.abs(deltaY) * 0.85) return;
    gesture.horizontalIntent = true;
    event.preventDefault();
    if (!row.hasPointerCapture(event.pointerId)) row.setPointerCapture(event.pointerId);
    row.classList.add('queue-add-dragging');
    row.style.transform = `translateX(${Math.min(deltaX, 60)}px)`;
    row.classList.toggle('queue-add-ready', deltaX >= 32);
  });
  const finishGesture = (event, cancelled = false) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const deltaX = event.clientX - gesture.startX;
    const shouldAdd = !cancelled && event.type === 'pointerup'
      && gesture.horizontalIntent && deltaX >= 32;
    if (gesture.horizontalIntent && gesture.moved) {
      suppressClick = true;
      clearTimeout(clickResetTimer);
      clickResetTimer = window.setTimeout(() => { suppressClick = false; }, 800);
    }
    gesture = null;
    row.style.transform = '';
    row.classList.remove('queue-add-dragging', 'queue-add-ready');
    if (shouldAdd) addToUpcomingQueue(song);
  };
  row.addEventListener('pointerup', event => finishGesture(event));
  row.addEventListener('pointercancel', event => finishGesture(event, true));
  row.addEventListener('click', event => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    suppressClick = false;
    clearTimeout(clickResetTimer);
  }, true);
}

function setupTouchReorder(row, itemSelector, reorder) {
  const handle = row.querySelector('.drag-handle');
  if (!handle) return;
  const getPosition = item => Number(item?.dataset.playlistPosition ?? item?.dataset.upcomingPosition);
  let drag = null;
  let suppressClick = false;
  const clearDropTarget = () => {
    row.parentElement?.querySelectorAll(`${itemSelector}.reorder-before, ${itemSelector}.reorder-after`)
      .forEach(item => item.classList.remove('reorder-before', 'reorder-after'));
  };
  const updateDragPosition = (event, activeDrag) => {
    if (activeDrag.preview) {
      activeDrag.preview.style.left = `${event.clientX - activeDrag.grabOffsetX}px`;
      activeDrag.preview.style.top = `${event.clientY - activeDrag.grabOffsetY}px`;
    }

    const items = [...(row.parentElement?.querySelectorAll(itemSelector) || [])];
    if (!items.length) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(itemSelector);
    let targetItem = target && target.parentElement === row.parentElement ? target : null;
    let after = false;
    if (targetItem) {
      after = event.clientY >= targetItem.getBoundingClientRect().top
        + targetItem.getBoundingClientRect().height / 2;
    } else {
      targetItem = items.find(item => event.clientY < item.getBoundingClientRect().top
        + item.getBoundingClientRect().height / 2) || items.at(-1);
      after = targetItem === items.at(-1)
        && event.clientY >= targetItem.getBoundingClientRect().top
        + targetItem.getBoundingClientRect().height / 2;
    }

    clearDropTarget();
    targetItem.classList.add(after ? 'reorder-after' : 'reorder-before');
    const insertionIndex = getPosition(targetItem) + Number(after);
    const finalIndex = insertionIndex > activeDrag.from ? insertionIndex - 1 : insertionIndex;
    const lastPosition = getPosition(items.at(-1));
    activeDrag.to = Math.max(0, Math.min(lastPosition, finalIndex));
  };
  handle.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const from = getPosition(row);
    if (!Number.isInteger(from)) return;
    event.preventDefault();
    const bounds = row.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      from,
      to: from,
      startY: event.clientY,
      grabOffsetX: event.clientX - bounds.left,
      grabOffsetY: event.clientY - bounds.top,
      moved: false,
      preview: null,
    };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.abs(event.clientY - drag.startY) < 7) return;
    drag.moved = true;
    event.preventDefault();
    row.classList.add('reordering');
    if (!drag.preview) {
      const bounds = row.getBoundingClientRect();
      drag.preview = row.cloneNode(true);
      drag.preview.removeAttribute('id');
      drag.preview.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
      drag.preview.classList.remove('reordering', 'reorder-before', 'reorder-after');
      drag.preview.classList.add('touch-drag-preview');
      drag.preview.setAttribute('aria-hidden', 'true');
      Object.assign(drag.preview.style, {
        left: `${event.clientX - drag.grabOffsetX}px`,
        top: `${event.clientY - drag.grabOffsetY}px`,
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
      });
      document.body.append(drag.preview);
    }
    updateDragPosition(event, drag);
  });
  const finishDrag = (event, cancelled = false) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { from, to, moved } = drag;
    drag.preview?.remove();
    drag = null;
    row.classList.remove('reordering');
    clearDropTarget();
    if (moved) {
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 800);
    }
    if (!cancelled && moved && from !== to) reorder(from, to);
  };
  handle.addEventListener('pointerup', event => finishDrag(event));
  handle.addEventListener('pointercancel', event => finishDrag(event, true));
  handle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const from = getPosition(row);
    const target = document.querySelector(`${itemSelector}[data-${itemSelector.includes('playlist') ? 'playlist' : 'upcoming'}-position="${from + (event.key === 'ArrowUp' ? -1 : 1)}"]`);
    const to = getPosition(target);
    if (Number.isInteger(from) && Number.isInteger(to)) reorder(from, to);
  });
  row.addEventListener('click', event => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    suppressClick = false;
  }, true);
}

function pushPlaybackHistory() {
  const current = getCurrentSong();
  if (!current) return;
  state.playbackHistory.push({
    track: current,
    queue: [...state.queue],
    queueIndex: state.queueIndex,
    queueTitle: state.queueTitle,
    queueKind: state.currentQueueKind
  });
  if (state.playbackHistory.length > 100) state.playbackHistory.shift();
}

async function playSourceQueueTrack(index, sourceQueue = state.queue, queueTitle = state.queueTitle) {
  if (state.sharedQueueRole === 'follower' || !sourceQueue[index]) return false;
  const isCurrentQueue = sourceQueue.length === state.queue.length
    && sourceQueue.every((song, queueIndex) => (
      getSongId(song) === getSongId(state.queue[queueIndex])
    ));
  if (!isCurrentQueue) {
    return playTrack(sourceQueue, index, { queueTitle });
  }
  if (!state.queue[index]) return false;
  const upcomingIndices = state.shuffle
    ? [...state.shuffleQueue]
    : state.queue.slice(state.queueIndex + 1).map((_, offset) => state.queueIndex + offset + 1);
  const selectedPosition = upcomingIndices.indexOf(index);
  if (selectedPosition < 0) {
    return playTrack(state.queue, index, { queueTitle: state.queueTitle });
  }
  pushPlaybackHistory();
  for (const skippedIndex of upcomingIndices.slice(0, selectedPosition)) {
    state.playbackHistory.push({
      track: state.queue[skippedIndex],
      queue: [...state.queue],
      queueIndex: skippedIndex,
      queueTitle: state.queueTitle,
      queueKind: 'source'
    });
  }
  if (state.shuffle) state.shuffleQueue.splice(0, selectedPosition + 1);
  state.queueIndex = index;
  state.currentTrack = state.queue[index];
  state.currentQueueKind = 'source';
  persistLastPlayback(0);
  const started = await loadTrack(state.currentTrack);
  renderPlayerQueue();
  return started;
}

function addToUpcomingQueue(song) {
  if (state.sharedQueueRole === 'follower') {
    if (!state.sharedQueueJamActive) {
      showToast('La cola del anfitrión es de solo lectura. Propón una Jam desde la cola para colaborar.', true);
      return;
    }
    const sharedUpcomingIds = getDisplayedSharedUpcomingIds();
    if (sharedUpcomingIds.length >= 5000) {
      showToast('La cola de la Jam alcanzó el máximo de 5000 canciones.', true);
      return;
    }
    requestSharedJamQueueUpdate([
      ...sharedUpcomingIds,
      getSongId(song)
    ]);
    return;
  }
  const isJamHost = state.sharedQueueRole === 'host' && state.sharedQueueJamActive;
  if (
    !isJamHost
    && (
      getRemotePlaybackSession()
      || Array.isArray(state.accountQueuePendingIds)
      || state.accountQueueSnapshotCached
    )
  ) {
    requestAccountQueueAdd(song);
    return;
  }
  const fullTrack = state.songs.find(item => getSongId(item) === getSongId(song)) || song;
  if (state.sharedQueueRole === 'host' && state.sharedQueueJamActive) {
    if (state.upcomingQueue.length >= 5000) {
      showToast('La cola de la Jam alcanzó el máximo de 5000 canciones.', true);
      return;
    }
    state.upcomingQueue.push(fullTrack);
  } else {
    state.upcomingQueue.push(fullTrack);
  }
  persistUpcomingQueue();
  emitSharedQueueSnapshot();
  renderPlayerQueue();
  showToast('Canción añadida a continuación.');
}

function getDisplayedSharedUpcomingIds() {
  return state.sharedQueueJamPendingUpcomingIds || state.sharedQueueUpcomingIds;
}

function updateJamControls() {
  const isFollower = state.sharedQueueRole === 'follower' && Boolean(state.followingUserId);
  const jamActive = state.sharedQueueJamActive;
  elements.queueJamControls.hidden = !isFollower || jamActive;
  if (!isFollower || jamActive) return;
  elements.requestJamButton.disabled = state.sharedQueueJamRequestPending
    || state.sharedQueueRevision < 1
    || !state.socket?.connected;
  elements.requestJamButton.setAttribute(
    'aria-label',
    state.sharedQueueJamRequestPending ? 'Esperando respuesta a la propuesta de Jam' : 'Proponer Jam'
  );
  elements.requestJamButton.title = state.sharedQueueJamRequestPending
    ? 'Esperando respuesta a la propuesta de Jam'
    : 'Proponer Jam';
  elements.requestJamButton.innerHTML = state.sharedQueueJamRequestPending
    ? '<span class="sync-spinner" aria-hidden="true"></span>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17V5l11-2v12M10 17c0 1.7-1.6 3-3.5 3S3 19 3 17.5 4.6 15 6.5 15s3.5.9 3.5 2Zm11-2c0 1.7-1.6 3-3.5 3S14 17 14 15.5s1.6-2.5 3.5-2.5 3.5.9 3.5 2Zm-4-10v5m-2.5-2.5h5"/></svg>';
}

function showJamRequestNotification(requestId, followerId) {
  if (
    state.sharedQueueRole !== 'host'
    || !state.sharedQueueSessionId
    || !requestId
    || !elements.jamRequestNotification
  ) return;
  state.hostJamRequestId = String(requestId);
  const friend = state.friends.find(item => String(item._id) === String(followerId));
  elements.jamRequestMessage.textContent = `${friend?.username || 'Un amigo'} quiere controlar la reproducción contigo.`;
  elements.jamRequestNotification.hidden = false;
  elements.acceptJamRequest.focus();
}

function closeJamRequestNotification(requestId = '') {
  if (requestId && String(requestId) !== state.hostJamRequestId) return;
  state.hostJamRequestId = '';
  elements.jamRequestNotification.hidden = true;
  elements.acceptJamRequest.disabled = false;
  elements.declineJamRequest.disabled = false;
}

function respondToJamRequest(accepted) {
  const socket = state.socket;
  const sessionId = state.sharedQueueSessionId;
  const requestId = state.hostJamRequestId;
  if (!socket?.connected || !sessionId || !requestId) return;
  elements.acceptJamRequest.disabled = true;
  elements.declineJamRequest.disabled = true;
  socket.timeout(7000).emit('listenTogetherJamResponse', {
    sessionId,
    requestId,
    accepted
  }, (timeoutError, response) => {
    if (socket !== state.socket || sessionId !== state.sharedQueueSessionId
      || requestId !== state.hostJamRequestId) return;
    if (!response?.success) {
      elements.acceptJamRequest.disabled = false;
      elements.declineJamRequest.disabled = false;
      showToast(response?.error || (timeoutError
        ? 'No se pudo responder a la solicitud de Jam.'
        : 'La solicitud de Jam ya no está disponible.'), true);
      return;
    }
    closeJamRequestNotification(requestId);
  });
}

function requestJam() {
  const socket = state.socket;
  const sessionId = state.sharedQueueSessionId;
  if (
    !socket?.connected
    || state.sharedQueueRole !== 'follower'
    || !state.followingUserId
    || !sessionId
    || state.sharedQueueRevision < 1
    || state.sharedQueueJamRequestPending
    || state.sharedQueueJamActive
  ) return;
  state.sharedQueueJamRequestPending = true;
  updateJamControls();
  socket.timeout(7000).emit('listenTogetherJamRequest', { sessionId }, (timeoutError, response) => {
    if (socket !== state.socket || sessionId !== state.sharedQueueSessionId) return;
    if (!response?.success) {
      state.sharedQueueJamRequestPending = false;
      state.sharedQueueJamRequestId = '';
      updateJamControls();
      showToast(response?.error || (timeoutError
        ? 'No se pudo enviar la solicitud de Jam.'
        : 'No se pudo proponer la Jam.'), true);
      return;
    }
    state.sharedQueueJamRequestId = String(response.requestId || '');
    updateJamControls();
  });
}

function applyJamQueue(songIds, { hostCommand = false } = {}) {
  if (!Array.isArray(songIds) || songIds.length > 5000) return false;
  const tracks = songIds.map(songId => (
    state.songs.find(song => getSongId(song) === String(songId))
  ));
  if (tracks.some(song => !song)) return false;
  state.sharedQueueIds = songIds.map(String);
  if (hostCommand) {
    const currentSong = getCurrentSong();
    const playedQueue = currentSong && state.currentQueueKind === 'source' && state.queueIndex >= 0
      ? state.queue.slice(0, state.queueIndex + 1)
      : currentSong ? [currentSong] : [];
    state.queue = [...playedQueue, ...tracks];
    state.queueIndex = currentSong ? state.queue.length - tracks.length - 1 : -1;
    state.currentTrack = currentSong;
    state.currentQueueKind = 'source';
    state.queueTitle = state.sharedQueueHostQueueName || state.queueTitle || 'GENERAL';
    state.shuffle = false;
    state.shuffleQueue = [];
    state.sharedQueueSnapshotSignature = '';
    renderPlayerQueue({ syncAccount: false, syncShared: false });
  } else {
    renderPlayerQueue({ syncAccount: false, syncShared: false });
  }
  return true;
}

function applyJamUpcomingQueue(songIds, { hostCommand = false } = {}) {
  if (!Array.isArray(songIds) || songIds.length > 5000) return false;
  const tracks = songIds.map(songId => (
    state.songs.find(song => getSongId(song) === String(songId))
  ));
  if (tracks.some(song => !song)) return false;
  state.sharedQueueUpcomingIds = songIds.map(String);
  if (hostCommand) {
    state.upcomingQueue = tracks;
    persistUpcomingQueue();
  }
  renderPlayerQueue({ syncAccount: false, syncShared: false });
  return true;
}

function requestSharedJamQueueUpdate(songIds) {
  const socket = state.socket;
  const sessionId = state.sharedQueueSessionId;
  if (
    !socket?.connected
    || !sessionId
    || state.sharedQueueRole !== 'follower'
    || !state.sharedQueueJamActive
    || state.sharedQueueJamUpdateInFlight
    || songIds.length > 5000
  ) return;
  const normalizedSongIds = songIds.map(String);
  const tracks = normalizedSongIds.map(songId => (
    state.songs.find(song => getSongId(song) === songId)
  ));
  if (tracks.some(song => !song)) {
    showToast('Una canción de la cola no está disponible en este dispositivo.', true);
    return;
  }
  const revision = state.sharedQueueRevision;
  const signature = normalizedSongIds.join(',');
  state.sharedQueueJamUpdateInFlight = true;
  state.sharedQueueJamPendingUpcomingIds = normalizedSongIds;
  renderPlayerQueue({ syncAccount: false, syncShared: false });
  socket.timeout(9000).emit('listenTogetherJamQueueUpdateRequest', {
    sessionId,
    revision,
    songIds: normalizedSongIds
  }, (timeoutError, response) => {
    if (socket !== state.socket || sessionId !== state.sharedQueueSessionId) return;
    state.sharedQueueJamUpdateInFlight = false;
    if (response?.success) {
      state.sharedQueueRevision = Math.max(state.sharedQueueRevision, Number(response.revision) || 0);
      if (state.sharedQueueJamPendingUpcomingIds?.join(',') === signature) {
        state.sharedQueueUpcomingIds = normalizedSongIds;
        state.sharedQueueJamPendingUpcomingIds = null;
      }
      renderPlayerQueue({ syncAccount: false, syncShared: false });
      return;
    }
    if (Array.isArray(response?.upcomingSongIds)) {
      state.sharedQueueUpcomingIds = response.upcomingSongIds.map(String);
      state.sharedQueueRevision = Number(response.revision) || state.sharedQueueRevision;
    } else {
      socket.emit('listenTogetherQueueSnapshotRequest', { sessionId });
    }
    state.sharedQueueJamPendingUpcomingIds = null;
    renderPlayerQueue({ syncAccount: false, syncShared: false });
    showToast(response?.error || (timeoutError
      ? 'El anfitrión no confirmó el cambio de la cola.'
      : 'No se pudo actualizar la cola de la Jam.'), true);
  });
}

function requestSharedJamPlayback(action, songId = '', queueKind = 'source') {
  const socket = state.socket;
  const sessionId = state.sharedQueueSessionId;
  if (
    !socket?.connected
    || !sessionId
    || state.sharedQueueRole !== 'follower'
    || !state.sharedQueueJamActive
  ) return;
  if (state.sharedQueueJamUpdateInFlight) {
    showToast('Espera a que se sincronice el cambio de la cola.', true);
    return;
  }
  socket.timeout(8000).emit('listenTogetherJamPlaybackRequest', {
    sessionId,
    action,
    songId,
    queueKind
  }, (timeoutError, response) => {
    if (socket !== state.socket || sessionId !== state.sharedQueueSessionId) return;
    if (!response?.success) {
      showToast(response?.error || (timeoutError
        ? 'El anfitrión no respondió al control.'
        : 'No se pudo controlar la reproducción.'), true);
    }
  });
}

function getAccountQueueTracks() {
  return state.upcomingQueue;
}

function getAccountQueueSnapshotSignature(
  songIds = state.accountQueueIds,
  sourceSongIds = state.accountQueueSourceIds,
  queueName = state.accountQueueName
) {
  return JSON.stringify([queueName, sourceSongIds, songIds]);
}

function publishAccountQueueSnapshot(force = false, retried = false, allowPending = false) {
  if (state.accountQueuePendingIds && !allowPending) return Promise.resolve(false);
  const publish = () => {
    if (state.accountQueuePendingIds && !allowPending) return Promise.resolve(false);
    if (
      !state.playbackOwnerConfirmed
      || state.ownPlayback?.deviceId !== playbackDeviceId
      || getRemotePlaybackSession()
      || state.sharedQueueSessionId
      || !state.socket?.connected
    ) return Promise.resolve(false);
    const songIds = getAccountQueueTracks().map(getSongId).filter(Boolean).slice(0, 5000);
    const sourceQueue = state.shuffle
      ? state.shuffleQueue.map(index => state.queue[index])
      : state.queue.slice(state.queueIndex + 1);
    const sourceSongIds = sourceQueue
      .filter(Boolean)
      .map(getSongId)
      .filter(Boolean)
      .slice(0, 5000);
    const queueName = state.queueTitle || 'GENERAL';
    const signature = getAccountQueueSnapshotSignature(songIds, sourceSongIds, queueName);
    if (!force && signature === state.accountQueueSnapshotSignature) return Promise.resolve(true);
    const previousIds = state.accountQueueIds;
    let removedCount = 0;
    const sameSourceQueue = queueName === state.accountQueueName
      && sourceSongIds.length === state.accountQueueSourceIds.length
      && sourceSongIds.every((songId, index) => songId === state.accountQueueSourceIds[index]);
    if (!force && sameSourceQueue && state.accountQueueRevision && previousIds.length >= songIds.length) {
      for (let offset = 1; offset <= previousIds.length; offset += 1) {
        const remainingIds = previousIds.slice(offset);
        if (
          remainingIds.length === songIds.length
          && remainingIds.every((songId, index) => songId === songIds[index])
        ) {
          removedCount = offset;
          break;
        }
      }
    }
    state.accountQueueSnapshotSignature = signature;
    return new Promise(resolve => {
      const eventName = removedCount ? 'accountQueueAdvance' : 'accountQueueSnapshot';
      const payload = removedCount
        ? { revision: state.accountQueueRevision, count: removedCount }
        : { revision: state.accountQueueRevision, songIds, sourceSongIds, queueName };
      const socket = state.socket;
      socket.timeout(7000).emit(eventName, payload, (timeoutError, response) => {
        if (response?.success) {
          if (response.stale) {
            if (Number.isInteger(response.revision)) state.accountQueueRevision = response.revision;
            resolve(true);
            return;
          }
          state.accountQueueIds = songIds;
          state.accountQueueSourceIds = sourceSongIds;
          state.accountQueueName = queueName;
          if (Number.isInteger(response.revision)) state.accountQueueRevision = response.revision;
          persistAccountQueueSnapshot();
          resolve(true);
          return;
        }
        if (state.accountQueueSnapshotSignature === signature) state.accountQueueSnapshotSignature = null;
        if (!retried) {
          window.setTimeout(() => {
            if (
              state.socket?.connected
              && state.playbackOwnerConfirmed
              && state.ownPlayback?.deviceId === playbackDeviceId
              && !getRemotePlaybackSession()
            ) {
              void publishAccountQueueSnapshot(true, true);
            }
          }, 500);
        }
        showToast(response?.error || 'No se pudo sincronizar la cola de la cuenta.', true);
        resolve(false);
      });
    });
  };
  const pending = accountQueuePublishChain.then(publish, publish);
  accountQueuePublishChain = pending;
  return pending;
}

function requestAccountQueueSnapshot() {
  if (!state.socket?.connected) return;
  state.socket.timeout(10000).emit('accountQueueRequest', (timeoutError, response) => {
    if (!response?.success) {
      state.accountQueueDeviceId = null;
      showToast(response?.error || (timeoutError
        ? 'El servidor no respondió al cargar la cola de la cuenta.'
        : 'No se pudo cargar la cola de la cuenta.'), true);
    }
  });
}

function requestAccountQueueAdd(song) {
  const songId = getSongId(song);
  const currentIds = getDisplayedAccountQueueIds();
  if (!songId || currentIds.length >= 5000) {
    showToast('La cola alcanzó el máximo de 5000 canciones.', true);
    return;
  }
  requestAccountQueueUpdate([...currentIds, songId]);
}

async function requestAccountQueuePlay(song, position) {
  const songId = getSongId(song);
  const remotePlayback = getRemotePlaybackSession();
  if (
    state.socket?.connected
    && state.ownPlayback?.deviceId === playbackDeviceId
    && state.ownPlayback.transferPending !== true
  ) {
    return playAccountQueueTrackLocally(songId, position, song, { synchronizeAsOwner: true });
  }
  if (
    state.socket?.connected
    && state.accountQueueSnapshotCached
    && Number.isInteger(state.accountQueueRevision)
    && !Array.isArray(state.accountQueuePendingIds)
  ) {
    const endLoading = beginPlaybackRequestLoading('Cambiando canción en el anfitrión…');
    try {
      const response = await requestPlaybackSocket('accountQueuePlayRequest', {
        songId,
        position,
        revision: state.accountQueueRevision
      }, 7000);
      if (response.success) return true;
      if (response.ownerDisconnected || response.ownerUnresponsive) {
        return await playAccountQueueTrackLocally(songId, position, song, { pendingTakeover: true });
      }
      if (String(response.error || '').toLowerCase().includes('cola cambió')) {
        requestAccountQueueSnapshot();
      }
      showToast(response.error || 'No se pudo cambiar la canción en el anfitrión.', true);
      return false;
    } finally {
      endLoading();
    }
  }
  return playAccountQueueTrackLocally(songId, position, song, { pendingTakeover: Boolean(remotePlayback) });
}

function requestAccountQueueUpdate(songIds) {
  savePendingAccountQueueIds(songIds);
  renderPlayerQueue({ syncAccount: false });
  if (!state.socket?.connected) {
    showToast('Cambio guardado en este dispositivo; se sincronizará al recuperar conexión.');
    return;
  }
  flushPendingAccountQueue();
}

function schedulePendingAccountQueueRetry() {
  if (
    accountQueueRetryTimer
    || !Array.isArray(state.accountQueuePendingIds)
    || !state.socket?.connected
  ) return;
  const delay = accountQueueRetryDelay;
  accountQueueRetryDelay = Math.min(accountQueueRetryDelay * 2, 180000);
  accountQueueRetryTimer = window.setTimeout(() => {
    accountQueueRetryTimer = null;
    flushPendingAccountQueue(true);
  }, delay);
}

function flushPendingAccountQueue(quiet = false) {
  if (accountQueueRetryTimer) {
    window.clearTimeout(accountQueueRetryTimer);
    accountQueueRetryTimer = null;
  }
  if (
    !Array.isArray(state.accountQueuePendingIds)
    || !state.socket?.connected
    || state.accountQueueSyncInFlight
  ) return;
  state.accountQueueSyncInFlight = true;
  const socket = state.socket;
  const finish = (retryNewerIntent = false, attemptedIds = null) => {
    state.accountQueueSyncInFlight = false;
    renderPlayerQueue({ syncAccount: false });
    if (
      retryNewerIntent
      && state.accountQueuePendingIds
      && state.accountQueuePendingIds.join(',') !== attemptedIds?.join(',')
      && socket === state.socket
      && socket.connected
    ) {
      window.setTimeout(() => flushPendingAccountQueue(), 0);
    }
  };
  const submit = () => {
    if (socket !== state.socket || !socket.connected) {
      finish();
      return;
    }
    const songIds = [...state.accountQueuePendingIds];
    socket.timeout(15000).emit('accountQueueUpdateRequest', {
      revision: state.accountQueueRevision,
      songIds
    }, (timeoutError, response) => {
      if (socket !== state.socket) {
        finish();
        return;
      }
      if (response?.success) {
        accountQueueRetryDelay = 15000;
        accountQueueLastNotifiedSignature = '';
        state.accountQueueIds = songIds;
        if (Number.isInteger(response.revision) && response.revision > state.accountQueueRevision) {
          state.accountQueueRevision = response.revision;
        }
        persistAccountQueueSnapshot();
        if (state.accountQueuePendingIds?.join(',') === songIds.join(',')) {
          clearPendingAccountQueueIds();
        }
        renderPlayerQueue({ syncAccount: false });
        finish(true, songIds);
        return;
      }
      if (String(response?.error || '').toLowerCase().includes('cola cambió')) requestAccountQueueSnapshot();
      const signature = songIds.join(',');
      if (!quiet && accountQueueLastNotifiedSignature !== signature) {
        showToast(timeoutError || response?.error
          ? 'El cambio permanece guardado localmente; se reintentará al recuperar la conexión.'
          : 'No se pudo sincronizar la cola; el cambio sigue guardado localmente.', true);
        accountQueueLastNotifiedSignature = signature;
      }
      schedulePendingAccountQueueRetry();
      finish(true, songIds);
    });
  };
  submit();
}

function removeAccountQueueTrack(position) {
  const accountQueueIds = getDisplayedAccountQueueIds();
  if (!Number.isInteger(position) || position < 0 || position >= accountQueueIds.length) return;
  const songIds = [...accountQueueIds];
  songIds.splice(position, 1);
  requestAccountQueueUpdate(songIds);
}

function reorderAccountQueue(from, to) {
  const accountQueueIds = getDisplayedAccountQueueIds();
  if (
    from === to
    || from < 0
    || to < 0
    || from >= accountQueueIds.length
    || to >= accountQueueIds.length
  ) return;
  const songIds = [...accountQueueIds];
  const [songId] = songIds.splice(from, 1);
  songIds.splice(to, 0, songId);
  requestAccountQueueUpdate(songIds);
}

function syncAccountQueue() {
  if (state.accountQueuePendingIds) {
    flushPendingAccountQueue();
    return;
  }
  const remotePlayback = getRemotePlaybackSession();
  if (remotePlayback) {
    if (state.accountQueueDeviceId !== remotePlayback.deviceId) {
      state.accountQueueDeviceId = remotePlayback.deviceId;
      requestAccountQueueSnapshot();
    }
    return;
  }
  state.accountQueueDeviceId = null;
  if (getCurrentSong() && !state.followingUserId) publishAccountQueueSnapshot();
}

function removeUpcomingTrack(position) {
  if (state.sharedQueueRole === 'follower') {
    if (!state.sharedQueueJamActive) return;
    const upcomingIds = [...getDisplayedSharedUpcomingIds()];
    upcomingIds.splice(position, 1);
    requestSharedJamQueueUpdate(upcomingIds);
    return;
  }
  if (
    getRemotePlaybackSession()
    || Array.isArray(state.accountQueuePendingIds)
    || state.accountQueueSnapshotCached
  ) {
    removeAccountQueueTrack(position);
    return;
  }
  state.upcomingQueue.splice(position, 1);
  persistUpcomingQueue();
  emitSharedQueueSnapshot();
  renderPlayerQueue();
}

function reorderUpcomingQueue(from, to) {
  if (state.sharedQueueRole === 'follower') {
    if (!state.sharedQueueJamActive) return;
    const upcomingIds = [...getDisplayedSharedUpcomingIds()];
    if (from === to || from < 0 || from >= upcomingIds.length || to < 0 || to >= upcomingIds.length) return;
    const [songId] = upcomingIds.splice(from, 1);
    upcomingIds.splice(to, 0, songId);
    requestSharedJamQueueUpdate(upcomingIds);
    return;
  }
  if (
    getRemotePlaybackSession()
    || Array.isArray(state.accountQueuePendingIds)
    || state.accountQueueSnapshotCached
  ) {
    reorderAccountQueue(from, to);
    return;
  }
  if (from === to || from < 0 || from >= state.upcomingQueue.length || to < 0 || to >= state.upcomingQueue.length) return;
  const [track] = state.upcomingQueue.splice(from, 1);
  state.upcomingQueue.splice(to, 0, track);
  persistUpcomingQueue();
  emitSharedQueueSnapshot();
  renderPlayerQueue();
}

async function reorderPlaylistTracks(playlist, from, to) {
  const tracks = playlist?.tracks;
  if (!Array.isArray(tracks) || from === to || from < 0 || to < 0 || from >= tracks.length || to >= tracks.length) return;
  const previousTracks = [...tracks];
  const [movedTrack] = tracks.splice(from, 1);
  tracks.splice(to, 0, movedTrack);
  const movedIds = tracks.map(getSongId);
  renderPlaylistDetail();
  const playlistId = String(playlist.id);
  const requestBody = {
    id: playlist.id,
    name: playlist.name,
    desc: playlist.desc || '',
    photo: playlist.photo || '',
    userId: state.user?._id,
    tracks: movedIds
  };
  const previousSave = playlistOrderSaves.get(playlistId) || Promise.resolve();
  const currentSave = previousSave.catch(() => {}).then(() => request('/playlists', {
    method: 'POST',
    body: JSON.stringify(requestBody)
  }));
  playlistOrderSaves.set(playlistId, currentSave);
  try {
    await currentSave;
  } catch (error) {
    const currentIds = tracks.map(getSongId);
    if (currentIds.every((songId, index) => songId === movedIds[index])) {
      playlist.tracks = previousTracks;
      renderPlaylistDetail();
    }
    showToast(error.message || 'No se pudo guardar el nuevo orden de la playlist.', true);
    return;
  } finally {
    if (playlistOrderSaves.get(playlistId) === currentSave) playlistOrderSaves.delete(playlistId);
  }
  try {
    await saveOfflinePlaylists(state.user._id, state.playlists);
  } catch (error) {
    console.warn('No se pudo actualizar la caché offline tras reordenar la playlist.', error);
  }
}

function rebuildShuffleQueue() {
  state.shuffleQueue = state.queue.map((_, index) => index).filter(index => index !== state.queueIndex);
  for (let index = state.shuffleQueue.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [state.shuffleQueue[index], state.shuffleQueue[swapIndex]] = [state.shuffleQueue[swapIndex], state.shuffleQueue[index]];
  }
}

function hasPlayableAudioSource(song) {
  return state.offlineEnabled || Boolean(song?.path || song?.audioUrl);
}

async function playUpcomingTrack(index) {
  if (getRemotePlaybackSession()) {
    const song = state.upcomingQueue[index];
    if (!song) return false;
    const songId = getSongId(song);
    return playAccountQueueTrackLocally(songId, index, song, { pendingTakeover: true });
  }
  if (isRemotePlaybackLocked()) return false;
  if (index < 0 || index >= state.upcomingQueue.length) return false;
  while (
    index < state.upcomingQueue.length
    && !hasPlayableAudioSource(state.upcomingQueue[index])
  ) {
    state.upcomingQueue.splice(index, 1);
  }
  if (index >= state.upcomingQueue.length) {
    persistUpcomingQueue();
    emitSharedQueueSnapshot();
    renderPlayerQueue();
    showToast('No hay canciones disponibles para reproducir en la cola.', true);
    return false;
  }
  const skippedTracks = state.upcomingQueue.splice(0, index + 1);
  const song = skippedTracks[skippedTracks.length - 1];
  persistUpcomingQueue();
  pushPlaybackHistory();
  const sourceQueueIndex = state.queue.findIndex(track => getSongId(track) === getSongId(song));
  if (sourceQueueIndex >= 0) {
    if (state.shuffle) {
      state.shuffleQueue = state.shuffleQueue.filter(index => index !== sourceQueueIndex);
    } else {
      state.queueIndex = sourceQueueIndex;
    }
  }
  state.currentTrack = song;
  state.currentQueueKind = 'upcoming';
  persistLastPlayback(0);
  emitSharedQueueSnapshot();
  return loadTrack(song);
}

async function loadTrack(song, {
  autoplay = true,
  sync = false,
  restoreTime = 0,
  showError = true,
  cacheOnly = false,
  bypassOfflineCache = false,
  fallbackState = null,
  awaitPlaybackStart = false
} = {}) {
  if (autoplay && isRemotePlaybackLocked()) return false;
  const loadSequence = ++trackLoadSequence;
  state.loadingTrackId = getSongId(song);
  updateSongLoadingIndicators();
  currentTrackShouldAutoplay = autoplay;
  activeTrackUsingOfflineCache = false;
  activeTrackFallbackState = fallbackState || {
    cache: cacheOnly || bypassOfflineCache
  };
  const source = song.path || song.audioUrl || '';
  let audioSourceAssigned = false;
  try {
    let mediaUrl = source ? resolveMediaUrl(source) : '';
    const mediaKey = `song:${getSongId(song)}:audio`;
    const cached = bypassOfflineCache ? null : await getOfflineMedia(mediaKey);
    if (loadSequence !== trackLoadSequence) return false;
    if (cached?.localPath && (!source || !cached.sourceUrl || sameMediaSource(cached.sourceUrl, mediaUrl))) {
      if (activeOfflineAudioUrl) URL.revokeObjectURL(activeOfflineAudioUrl);
      activeOfflineAudioUrl = null;
      mediaUrl = Capacitor.convertFileSrc(cached.localPath);
      activeTrackUsingOfflineCache = true;
    } else if (cached?.blob && (!source || !cached.sourceUrl || sameMediaSource(cached.sourceUrl, mediaUrl))) {
      if (activeOfflineAudioUrl) URL.revokeObjectURL(activeOfflineAudioUrl);
      activeOfflineAudioUrl = URL.createObjectURL(cached.blob);
      mediaUrl = activeOfflineAudioUrl;
      activeTrackUsingOfflineCache = true;
    } else if (!source) {
      currentTrackShouldAutoplay = false;
      elements.audio.pause();
      elements.audio.removeAttribute('src');
      elements.audio.load();
      if (activeOfflineAudioUrl) URL.revokeObjectURL(activeOfflineAudioUrl);
      activeOfflineAudioUrl = null;
      updatePlayerUI();
      throw new Error('Esta canción no tiene un archivo de audio disponible.');
    } else if (isAndroidNative && getDriveFileId(mediaUrl)) {
      if (cacheOnly || !navigator.onLine || state.offlineOnly) {
        throw new Error('Esta canción no está descargada para escucharla sin conexión.');
      }
      if (activeOfflineAudioUrl) URL.revokeObjectURL(activeOfflineAudioUrl);
      activeOfflineAudioUrl = null;
    } else if (!navigator.onLine) {
      throw new Error('Esta canción no está descargada para escucharla sin conexión.');
    }
    if (loadSequence !== trackLoadSequence) return false;
    const resolvedUrl = new URL(mediaUrl, location.href);
    const apiOrigin = new URL(API_BASE_URL).origin;
    if (resolvedUrl.origin === apiOrigin) elements.audio.crossOrigin = 'anonymous';
    else elements.audio.removeAttribute('crossorigin');
    if (state.maxVolume > 1) {
      ensureAudioGain();
      if (audioContext) {
        await audioContext.resume();
        if (loadSequence !== trackLoadSequence) return false;
        audioGain.gain.value = Math.min(state.volume, state.maxVolume);
      }
    }
    elements.audio.volume = audioGain ? 1 : Math.min(state.volume, 1);
    if (Number.isFinite(restoreTime) && restoreTime > 0) {
      elements.audio.addEventListener('loadedmetadata', () => {
        if (loadSequence !== trackLoadSequence) return;
        elements.audio.currentTime = Math.min(restoreTime, elements.audio.duration || restoreTime);
        updatePlayerUI();
      }, { once: true });
    }
    elements.audio.src = mediaUrl;
    audioSourceAssigned = true;
    elements.audio.load();
    updatePlayerUI();
    if (autoplay) {
      if (!currentTrackShouldAutoplay) return false;
      const playPromise = elements.audio.play();
      if (awaitPlaybackStart) {
        await waitForAudioPlaybackStart(playPromise);
      } else {
        let timeoutId;
        const started = await Promise.race([
          playPromise.then(() => true),
          new Promise(resolve => {
            timeoutId = window.setTimeout(() => resolve(false), 1500);
          })
        ]);
        if (timeoutId) window.clearTimeout(timeoutId);
        if (!started) {
          playPromise.catch(error => {
            if (loadSequence !== trackLoadSequence || error.name === 'AbortError') return;
            if (error.name === 'NotAllowedError') {
              if (sync) state.followNeedsUserGesture = true;
              if (showError) showToast('El navegador bloqueó la reproducción. Toca reproducir de nuevo.', true);
            } else if (!elements.audio.error) {
              console.warn('La reproducción móvil no llegó a iniciarse.', error);
            }
          });
        }
      }
      if (!currentTrackShouldAutoplay && !elements.audio.paused) elements.audio.pause();
    }
    if (loadSequence !== trackLoadSequence) return false;
    updatePlayerUI();
    return true;
  } catch (error) {
    if (loadSequence !== trackLoadSequence) return false;
    state.loadingTrackId = '';
    updateSongLoadingIndicators();
    if (error.name === 'AbortError' && !currentTrackShouldAutoplay) return false;
    if (
      (
        error.name === 'NotSupportedError'
        || [2, 4].includes(elements.audio.error?.code)
      )
      && activeTrackUsingOfflineCache
      && !activeTrackFallbackState.cache
    ) {
      activeTrackFallbackState.cache = true;
      return loadTrack(song, {
        autoplay,
        sync,
        restoreTime,
        showError,
        bypassOfflineCache: true,
        fallbackState: activeTrackFallbackState,
        awaitPlaybackStart
      });
    }
    if (
      isAndroidNative
      && navigator.onLine
      && !activeTrackFallbackState.nativeDrive
      && (
        error.name === 'NotSupportedError'
        || error.name === 'PlaybackTimeoutError'
        || [2, 4].includes(elements.audio.error?.code)
      )
      && getDriveFileId(resolveMediaUrl(source))
    ) {
      activeTrackFallbackState.nativeDrive = true;
      try {
        return await recoverDriveAudioLocally(song, {
          loadSequence,
          autoplay,
          sync,
          restoreTime,
          showError,
          awaitPlaybackStart,
          fallbackState: activeTrackFallbackState
        });
      } catch (fallbackError) {
        console.warn('Falló la recuperación local del audio de Drive.', fallbackError);
        if (showError) showToast(fallbackError.message || error.message || getAudioErrorMessage(), true);
        return false;
      }
    }

    console.error('No se pudo reproducir la canción.', error);
    if (sync && error.name === 'NotAllowedError') state.followNeedsUserGesture = true;
    const audioErrorWillBeReported = audioSourceAssigned
      && Boolean(elements.audio.error)
      && Boolean(state.queue.length)
      && currentTrackShouldAutoplay
      && !isActivatingPlaybackTransfer;
    if (showError && !audioErrorWillBeReported) {
      showToast(error.name === 'NotAllowedError'
        ? 'El navegador bloqueó la reproducción. Toca reproducir de nuevo.'
        : error.message || getAudioErrorMessage(), true);
    }
    return false;
  }
}

function updateSongLoadingIndicators() {
  document.querySelectorAll('.song-row[data-song-id], .queue-row[data-song-id]').forEach(row => {
    updateSongLoadingIndicator(row);
  });
}

async function playTrack(queue, index, {
  sync = false,
  autoplay = true,
  queueTitle = 'GENERAL',
  restoreTime = 0,
  showError = true,
  awaitPlaybackStart = false
} = {}) {
  if (autoplay && getRemotePlaybackSession()) {
    const remoteSong = queue?.[index];
    if (!remoteSong) return false;
    if (sync) return false;
    return requestRemotePlaybackControl('playTrack', { songId: getSongId(remoteSong) });
  }
  if (autoplay && isRemotePlaybackLocked()) {
    showToast('La reproducción está activa en otro dispositivo.', true);
    return;
  }
  if (!Array.isArray(queue) || !queue[index]) return;
  if (!sync && state.followingUserId) stopFollowingFriend();
  state.queue = [...queue];
  state.queueIndex = index;
  state.currentTrack = state.queue[index];
  state.currentQueueKind = 'source';
  state.queueTitle = queueTitle || 'GENERAL';
  if (state.sharedQueueRole === 'host' && state.sharedQueueJamActive) {
    state.sharedQueueHostQueueName = state.queueTitle;
  }
  state.playbackHistory = [];
  if (state.shuffle) rebuildShuffleQueue();
  else state.shuffleQueue = [];
  persistLastPlayback(0);
  return loadTrack(state.currentTrack, {
    autoplay,
    sync,
    restoreTime,
    showError,
    awaitPlaybackStart
  });
}

function getLastPlaybackStorageKey() {
  return `amgc-mobile-last-playback-${state.user?._id || 'guest'}`;
}

function getAccountQueuePendingStorageKey() {
  return `amgc-mobile-account-queue-pending-${state.user?._id || 'guest'}`;
}

function getAccountQueueSnapshotStorageKey(userId = state.user?._id) {
  return `amgc-mobile-account-queue-snapshot-${userId || 'guest'}`;
}

function persistAccountQueueSnapshot() {
  if (!state.user?._id) return;
  try {
    localStorage.setItem(getAccountQueueSnapshotStorageKey(), JSON.stringify({
      revision: state.accountQueueRevision,
      songIds: state.accountQueueIds,
      sourceSongIds: state.accountQueueSourceIds,
      queueName: state.accountQueueName
    }));
    state.accountQueueSnapshotCached = true;
  } catch (error) {
    console.warn('No se pudo guardar localmente la última cola de la cuenta.', error);
  }
}

function getPendingPlaybackTakeoverStorageKey() {
  return `amgc-mobile-pending-playback-takeover-${state.user?._id || 'guest'}`;
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
  if (pendingPlaybackTakeoverRetryTimer) {
    window.clearTimeout(pendingPlaybackTakeoverRetryTimer);
    pendingPlaybackTakeoverRetryTimer = null;
  }
  pendingPlaybackTakeoverRetryDelay = 30000;
  pendingPlaybackTakeoverLastNotifiedSongId = '';
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
        window.clearTimeout(pendingPlaybackTakeoverRetryTimer);
        pendingPlaybackTakeoverRetryTimer = null;
      }
      pendingPlaybackTakeoverRetryDelay = 30000;
      pendingPlaybackTakeoverLastNotifiedSongId = '';
    }
  } catch (error) {
    console.error('No se pudo limpiar la intención de reproducción pendiente.', error);
  }
}

function getDisplayedAccountQueueIds() {
  return state.accountQueuePendingIds || state.accountQueueIds;
}

function savePendingAccountQueueIds(songIds) {
  const nextIds = [...songIds].map(String).slice(0, 5000);
  if (state.accountQueuePendingIds?.join(',') !== nextIds.join(',')) {
    accountQueueRetryDelay = 15000;
    accountQueueLastNotifiedSignature = '';
  }
  state.accountQueuePendingIds = nextIds;
  if (!getRemotePlaybackSession() && state.songs.length) {
    const tracksById = new Map(state.songs.map(track => [getSongId(track), track]));
    state.upcomingQueue = state.accountQueuePendingIds.map(id => tracksById.get(id)).filter(Boolean);
    persistUpcomingQueue();
  }
  try {
    localStorage.setItem(
      getAccountQueuePendingStorageKey(),
      JSON.stringify(state.accountQueuePendingIds)
    );
  } catch (error) {
    console.error('No se pudo persistir la cola pendiente de la cuenta.', error);
    showToast('No se pudo guardar la cola localmente.', true);
  }
}

function clearPendingAccountQueueIds() {
  state.accountQueuePendingIds = null;
  if (accountQueueRetryTimer) {
    window.clearTimeout(accountQueueRetryTimer);
    accountQueueRetryTimer = null;
  }
  accountQueueRetryDelay = 15000;
  accountQueueLastNotifiedSignature = '';
  try {
    localStorage.removeItem(getAccountQueuePendingStorageKey());
  } catch (error) {
    console.error('No se pudo limpiar la cola pendiente de la cuenta.', error);
  }
}

function restorePendingAccountQueueIds(userId) {
  if (!userId) return;
  try {
    const savedIds = JSON.parse(localStorage.getItem(
      `amgc-mobile-account-queue-pending-${userId}`
    ) || 'null');
    state.accountQueuePendingIds = Array.isArray(savedIds)
      ? savedIds.filter(id => typeof id === 'string').slice(0, 5000)
      : null;
  } catch (error) {
    console.warn('No se pudo restaurar la cola pendiente de la cuenta.', error);
    state.accountQueuePendingIds = null;
  }
  if (!getRemotePlaybackSession() && state.accountQueuePendingIds && state.songs.length) {
    const tracksById = new Map(state.songs.map(track => [getSongId(track), track]));
    state.upcomingQueue = state.accountQueuePendingIds.map(id => tracksById.get(id)).filter(Boolean);
  }
}

function restoreAccountQueueSnapshot(userId) {
  if (!userId) return;
  try {
    const snapshot = JSON.parse(localStorage.getItem(
      getAccountQueueSnapshotStorageKey(userId)
    ) || 'null');
    if (
      !snapshot
      || !Number.isInteger(snapshot.revision)
      || snapshot.revision < 0
      || !Array.isArray(snapshot.songIds)
    ) return;
    state.accountQueueRevision = snapshot.revision;
    state.accountQueueIds = snapshot.songIds
      .filter(id => typeof id === 'string')
      .slice(0, 5000);
    state.accountQueueSourceIds = Array.isArray(snapshot.sourceSongIds)
      ? snapshot.sourceSongIds.filter(id => typeof id === 'string').slice(0, 5000)
      : [];
    state.accountQueueName = typeof snapshot.queueName === 'string' && snapshot.queueName.trim()
      ? snapshot.queueName.trim().slice(0, 100)
      : 'GENERAL';
    state.accountQueueSnapshotSignature = getAccountQueueSnapshotSignature();
    state.accountQueueSnapshotCached = true;
  } catch (error) {
    console.warn('No se pudo restaurar la última cola de la cuenta guardada.', error);
  }
}

async function playAccountQueueTrackLocally(
  songId,
  _position = -1,
  fallbackSong = null,
  { pendingTakeover = false, synchronizeAsOwner = false } = {}
) {
  const accountQueueIds = getDisplayedAccountQueueIds();
  const hadPendingQueueUpdate = Array.isArray(state.accountQueuePendingIds);
  const song = fallbackSong || state.songs.find(item => getSongId(item) === String(songId));
  if (!song) {
    showToast('La canción no está disponible en la biblioteca local.', true);
    return false;
  }
  let sourceQueue = state.songs;
  let sourceIndex = sourceQueue.findIndex(track => getSongId(track) === String(songId));
  if (sourceIndex < 0) {
    sourceQueue = state.playlists.find(playlist => (
      (playlist.tracks || []).some(track => getSongId(track) === String(songId))
    ))?.tracks || [song];
    sourceIndex = sourceQueue.findIndex(track => getSongId(track) === String(songId));
  }
  if (sourceIndex < 0) {
    sourceQueue = [song];
    sourceIndex = 0;
  }
  const queuePosition = accountQueueIds.indexOf(String(songId));
  const remainingIds = pendingTakeover
    ? []
    : queuePosition >= 0
      ? accountQueueIds.slice(queuePosition + 1)
      : accountQueueIds;
  const tracksById = new Map(state.songs.map(track => [getSongId(track), track]));
  const previousUpcomingQueue = [...state.upcomingQueue];
  const previousQueue = [...state.queue];
  const previousQueueIndex = state.queueIndex;
  const previousQueueTitle = state.queueTitle;
  const previousQueueKind = state.currentQueueKind;
  const previousCurrentTrack = getCurrentSong();
  const previousPlaybackHistory = [...state.playbackHistory];
  const previousRemotePlayback = state.remotePlayback;
  const previousPlaybackTime = Number(elements.audio.currentTime) || 0;
  const wasPlaying = !elements.audio.paused;
  state.upcomingQueue = remainingIds.map(id => tracksById.get(id)).filter(Boolean);
  persistUpcomingQueue();
  state.remotePlayback = null;
  state.accountQueueDeviceId = null;
  const shouldPersistTakeover = pendingTakeover || (!state.socket?.connected && !synchronizeAsOwner);
  if (shouldPersistTakeover) {
    savePendingPlaybackTakeover(songId);
  }
  const started = await playTrack(sourceQueue, sourceIndex, { queueTitle: 'GENERAL' });
  if (!started) {
    state.queue = previousQueue;
    state.queueIndex = previousQueueIndex;
    state.queueTitle = previousQueueTitle;
    state.currentQueueKind = previousQueueKind;
    state.currentTrack = previousCurrentTrack;
    state.playbackHistory = previousPlaybackHistory;
    state.remotePlayback = previousRemotePlayback;
    state.upcomingQueue = previousUpcomingQueue;
    persistUpcomingQueue();
    persistLastPlayback(previousPlaybackTime);
    if (shouldPersistTakeover) clearPendingPlaybackTakeover(String(songId));
    if (previousCurrentTrack && !isRemotePlaybackLocked()) {
      await loadTrack(previousCurrentTrack, {
        autoplay: wasPlaying,
        restoreTime: previousPlaybackTime,
        showError: false
      });
    }
    renderPlayerQueue({ syncAccount: false });
    return false;
  }
  if (!synchronizeAsOwner || !state.socket?.connected) {
    savePendingAccountQueueIds(remainingIds);
  }
  if (synchronizeAsOwner && state.socket?.connected) {
    if (hadPendingQueueUpdate) {
      savePendingAccountQueueIds(remainingIds);
      flushPendingAccountQueue();
    } else if (!await publishAccountQueueSnapshot(true)) {
      savePendingAccountQueueIds(remainingIds);
      flushPendingAccountQueue();
    }
  }
  renderPlayerQueue({ syncAccount: false });
  if (shouldPersistTakeover) {
    showToast(started
      ? 'Reproducción y cola guardadas localmente; se sincronizarán al recuperar conexión.'
      : 'La cola quedó guardada localmente, pero esta canción no está disponible offline.',
    !started);
  }
  if (state.socket?.connected) {
    if (shouldPersistTakeover) void resumePendingPlaybackTakeover();
    flushPendingAccountQueue();
  }
  return Boolean(started);
}

async function playLibrarySongLocallyForTakeover(songId, song) {
  if (!song || !songId) {
    showToast('La canción no está disponible en este dispositivo.', true);
    return false;
  }
  savePendingPlaybackTakeover(songId);
  state.remotePlayback = null;
  state.accountQueueDeviceId = null;
  const queueIndex = state.songs.findIndex(track => getSongId(track) === String(songId));
  const queue = queueIndex >= 0 ? state.songs : [song];
  const started = await playTrack(queue, queueIndex >= 0 ? queueIndex : 0, { queueTitle: 'GENERAL' });
  if (!started) {
    clearPendingPlaybackTakeover(songId);
    return false;
  }
  state.upcomingQueue = [];
  persistUpcomingQueue();
  savePendingAccountQueueIds([]);
  renderPlayerQueue({ syncAccount: false });
  showToast('Reproducción local iniciada; se transferirá el control al recuperar conexión.');
  if (state.socket?.connected) void resumePendingPlaybackTakeover();
  return true;
}

function resumePendingPlaybackTakeover() {
  if (pendingPlaybackTakeoverPromise) return pendingPlaybackTakeoverPromise;
  if (!state.socket?.connected || !state.user?._id) return Promise.resolve();
  const requestedSongId = getPendingPlaybackTakeoverSongId();
  if (!requestedSongId) return Promise.resolve();
  const currentSongId = getSongId(getCurrentSong());
  if (currentSongId && currentSongId !== requestedSongId) {
    clearPendingPlaybackTakeover(requestedSongId);
    return Promise.resolve();
  }
  const endLoading = beginPlaybackRequestLoading('Transfiriendo reproducción…');
  const takeover = requestPlaybackTakeover(requestedSongId).then(result => {
    if (!result.success) {
      if (pendingPlaybackTakeoverLastNotifiedSongId !== requestedSongId) {
        showToast(result.error || 'La reproducción local sigue activa; no se pudo sincronizar la transferencia.', true);
        pendingPlaybackTakeoverLastNotifiedSongId = requestedSongId;
      }
      return;
    }
    clearPendingPlaybackTakeover(requestedSongId);
  }).catch(error => {
    if (pendingPlaybackTakeoverLastNotifiedSongId !== requestedSongId) {
      showToast(error.message || 'La reproducción local sigue activa; no se pudo sincronizar la transferencia.', true);
      pendingPlaybackTakeoverLastNotifiedSongId = requestedSongId;
    }
  });
  pendingPlaybackTakeoverPromise = takeover.finally(() => {
    endLoading();
    pendingPlaybackTakeoverPromise = null;
    const pendingSongId = getPendingPlaybackTakeoverSongId();
    if (state.socket?.connected && pendingSongId && pendingSongId !== requestedSongId) {
      window.setTimeout(() => void resumePendingPlaybackTakeover(), 0);
    } else if (state.socket?.connected && pendingSongId === requestedSongId) {
      const delay = pendingPlaybackTakeoverRetryDelay;
      pendingPlaybackTakeoverRetryDelay = Math.min(pendingPlaybackTakeoverRetryDelay * 2, 180000);
      pendingPlaybackTakeoverRetryTimer = window.setTimeout(() => {
        pendingPlaybackTakeoverRetryTimer = null;
        void resumePendingPlaybackTakeover();
      }, delay);
    }
  });
  return pendingPlaybackTakeoverPromise;
}

function persistLastPlayback(currentTime = Number(elements.audio.currentTime) || 0) {
  const song = getCurrentSong();
  if (!song || !state.user?._id) return;
  const now = Date.now();
  if (now - state.lastLocalPlaybackSave < 4000 && currentTime !== 0) return;
  state.lastLocalPlaybackSave = now;
  localStorage.setItem(getLastPlaybackStorageKey(), JSON.stringify({
    songId: getSongId(song),
    currentTime,
    queueTitle: state.queueTitle,
    queueIds: state.queue.map(getSongId).filter(Boolean),
    upcomingQueueIds: state.upcomingQueue.map(getSongId).filter(Boolean),
    updatedAt: new Date().toISOString()
  }));
}

function persistUpcomingQueue() {
  if (!state.user?._id) return;
  try {
    const key = getLastPlaybackStorageKey();
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    localStorage.setItem(key, JSON.stringify({
      ...saved,
      upcomingQueueIds: state.upcomingQueue.map(getSongId).filter(Boolean)
    }));
  } catch (error) {
    console.warn('No se pudo guardar la cola local.', error);
  }
}

async function restoreLastPlayback() {
  const userId = String(state.user?._id || '');
  if (!userId || state.restoredPlaybackForUser === userId) return;
  const sharedPlayback = state.user?.lastPlayed;
  if (sharedPlayback?.deviceId && sharedPlayback.deviceId !== playbackDeviceId) {
    state.restoredPlaybackForUser = userId;
    return;
  }
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(getLastPlaybackStorageKey()) || 'null');
  } catch (error) {
    console.warn('No se pudo leer la última reproducción guardada.', error);
  }
  const songIds = [saved?.songId, state.user?.lastPlayed?.songId]
    .map(songId => String(songId || ''))
    .filter(Boolean);
  if (!songIds.length) return;
  const allTracks = [
    ...state.songs,
    ...state.playlists.flatMap(playlist => playlist.tracks || [])
  ];
  const song = songIds.map(songId => allTracks.find(track => getSongId(track) === songId))
    .find(Boolean);
  if (!song) return;
  const songId = getSongId(song);
  state.restoredPlaybackForUser = userId;
  const queueIds = Array.isArray(saved?.queueIds) ? saved.queueIds.map(String) : [];
  const sourceQueue = queueIds.length
    ? queueIds.map(id => allTracks.find(track => getSongId(track) === id)).filter(Boolean)
    : state.songs;
  const queue = sourceQueue.length ? sourceQueue : [song];
  let index = queue.findIndex(track => getSongId(track) === songId);
  if (index < 0) {
    queue.unshift(song);
    index = 0;
  }
  state.queue = queue;
  state.queueIndex = index;
  state.currentTrack = song;
  state.currentQueueKind = 'source';
  state.queueTitle = saved?.queueTitle || 'GENERAL';
  const upcomingIds = Array.isArray(saved?.upcomingQueueIds)
    ? saved.upcomingQueueIds.map(String)
    : [];
  state.upcomingQueue = upcomingIds
    .map(id => allTracks.find(track => getSongId(track) === id))
    .filter(Boolean);
  const position = Number.isFinite(Number(saved?.currentTime))
    && saved?.currentTime !== null
    ? Number(saved.currentTime)
    : Number(state.user?.lastPlayed?.currentTime) || 0;
  await loadTrack(song, { autoplay: false, restoreTime: position });
}

function getAudioErrorMessage() {
  const errorCode = elements.audio.error?.code;
  const errorMessages = {
    1: 'La carga de la canción fue cancelada.',
    2: 'Error de red al cargar la canción. Comprueba tu conexión.',
    3: 'El formato de audio no se pudo decodificar.',
    4: 'El servidor no ofrece un formato de audio compatible.'
  };
  return errorMessages[errorCode] || 'No se pudo cargar el audio. Comprueba el archivo y la conexión.';
}

function waitForAudioMetadata() {
  if (elements.audio.readyState >= 1) return Promise.resolve();
  if (elements.audio.error) return Promise.reject(new Error(getAudioErrorMessage()));
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('La canción no terminó de cargar en este dispositivo.'));
    }, 12000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      elements.audio.removeEventListener('loadedmetadata', onLoaded);
      elements.audio.removeEventListener('error', onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(getAudioErrorMessage()));
    };
    elements.audio.addEventListener('loadedmetadata', onLoaded, { once: true });
    elements.audio.addEventListener('error', onError, { once: true });
  });
}

function waitForAudioPlaybackStart(playPromise) {
  if (!elements.audio.paused && elements.audio.readyState >= 2) return Promise.resolve();
  if (elements.audio.error) return Promise.reject(new Error(getAudioErrorMessage()));
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      const error = new Error('La canción no comenzó a reproducirse en este dispositivo.');
      error.name = 'PlaybackTimeoutError';
      reject(error);
    }, 8000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      elements.audio.removeEventListener('playing', onPlaying);
      elements.audio.removeEventListener('error', onError);
    };
    const onPlaying = () => {
      if (elements.audio.paused) return;
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(getAudioErrorMessage()));
    };
    elements.audio.addEventListener('playing', onPlaying);
    elements.audio.addEventListener('error', onError, { once: true });
    playPromise.then(() => {
      if (!elements.audio.paused && elements.audio.readyState >= 2) onPlaying();
    }, error => {
      cleanup();
      reject(error);
    });
  });
}

function ensureAudioGain() {
  if (audioGain || !('AudioContext' in window || 'webkitAudioContext' in window)) return;
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  audioContext ||= new AudioContextConstructor();
  audioSourceNode = audioContext.createMediaElementSource(elements.audio);
  audioGain = audioContext.createGain();
  audioSourceNode.connect(audioGain);
  audioGain.connect(audioContext.destination);
}

function setPlayerVolume(value) {
  const requestedVolume = Number(value);
  const currentVolume = Number.isFinite(state.volume) ? state.volume : 0;
  const volume = Number.isFinite(requestedVolume)
    ? Math.min(state.maxVolume, Math.max(0, requestedVolume))
    : currentVolume;
  state.volume = volume;
  elements.playerVolume.value = String(volume);
  if (state.maxVolume > 1) {
    ensureAudioGain();
    if (audioGain) audioGain.gain.value = volume;
  }
  elements.audio.volume = audioGain ? 1 : Math.min(volume, 1);
  document.getElementById('player-volume-label').value = String(Number((volume * 100).toFixed(2)));
  localStorage.setItem('amgc-mobile-volume', String(volume));
  void updatePlaybackNotification();
  return volume;
}

function playNext(direction = 1) {
  if (getRemotePlaybackSession()) {
    void requestRemotePlaybackControl(direction > 0 ? 'next' : 'previous');
    return;
  }
  if (state.followingUserId) {
    if (state.sharedQueueJamActive) {
      requestSharedJamPlayback(direction > 0 ? 'next' : 'previous');
    }
    return;
  }
  if (isRemotePlaybackLocked()) return;
  if (direction > 0 && state.upcomingQueue.length && state.sharedQueueRole !== 'follower') {
    void playUpcomingTrack(0);
    return;
  }
  if (!state.queue.length) return;
  if (direction < 0 && state.playbackHistory.length) {
    const previous = state.playbackHistory.pop();
    const current = getCurrentSong();
    if (current && state.currentQueueKind === 'upcoming') state.upcomingQueue.unshift(current);
    if (current && state.currentQueueKind === 'upcoming') persistUpcomingQueue();
    if (current && state.currentQueueKind === 'source' && state.shuffle) state.shuffleQueue.unshift(state.queueIndex);
    state.queue = previous.queue;
    state.queueIndex = previous.queueIndex;
    state.queueTitle = previous.queueTitle;
    state.currentQueueKind = previous.queueKind;
    state.currentTrack = previous.track;
    void loadTrack(previous.track);
    renderPlayerQueue();
    return;
  }
  if (state.shuffle && direction > 0) {
    if (!state.shuffleQueue.length) rebuildShuffleQueue();
    let nextIndex;
    while (state.shuffleQueue.length && nextIndex === undefined) {
      const candidateIndex = state.shuffleQueue.shift();
      if (hasPlayableAudioSource(state.queue[candidateIndex])) nextIndex = candidateIndex;
    }
    if (nextIndex !== undefined) {
      pushPlaybackHistory();
      state.queueIndex = nextIndex;
      state.currentTrack = state.queue[nextIndex];
      state.currentQueueKind = 'source';
      void loadTrack(state.currentTrack);
      renderPlayerQueue();
    } else {
      showToast('No hay canciones disponibles para reproducir en la cola.', true);
    }
    return;
  }
  let nextIndex;
  for (let offset = 1; offset <= state.queue.length; offset += 1) {
    const candidateIndex = (
      state.queueIndex + direction * offset + state.queue.length * 2
    ) % state.queue.length;
    if (hasPlayableAudioSource(state.queue[candidateIndex])) {
      nextIndex = candidateIndex;
      break;
    }
  }
  if (nextIndex === undefined) {
    showToast('No hay canciones disponibles para reproducir en la cola.', true);
    return;
  }
  pushPlaybackHistory();
  state.queueIndex = nextIndex;
  state.currentTrack = state.queue[nextIndex];
  state.currentQueueKind = 'source';
  void loadTrack(state.currentTrack);
  renderPlayerQueue();
}

function createCurrentPlaybackSnapshot(isPlaying = !elements.audio.paused) {
  const song = getCurrentSong();
  if (!song) return null;
  return {
    songId: getSongId(song),
    songName: song.name || '',
    artist: song.artist || '',
    cover: song.cover || '',
    color: song.color || '#ffffff',
    currentTime: Number(elements.audio.currentTime) || 0,
    duration: Number(elements.audio.duration) || Number(song.duration) || 0,
    isPlaying,
    shuffle: state.shuffle,
    deviceId: playbackDeviceId,
    deviceType: playbackDeviceType,
    transferId: activePlaybackTransferUserId === String(state.user?._id || '')
      ? activePlaybackTransferId || undefined
      : undefined,
    updatedAt: new Date().toISOString()
  };
}

function syncPlaybackStatus(force = false) {
  if (isActivatingPlaybackTransfer) return;
  if (!state.user?._id || !getCurrentSong()) return;
  const now = Date.now();
  broadcastPlaybackState(force);
  if (!force && now - lastPlaybackStatusUpdate < 15000) return;
  lastPlaybackStatusUpdate = now;
  void request('/users/status', {
    method: 'POST',
    body: JSON.stringify({
      userId: state.user._id,
      isOnline: true,
      lastPlayed: {
        ...createCurrentPlaybackSnapshot(),
        ...(state.followingUserId && { countListeningDelta: true })
      }
    })
  }).then(() => {
    if (!state.playbackOwnerConfirmed && state.socket?.connected) {
      state.socket.emit('playbackStateRequest', {
        deviceId: playbackDeviceId,
        deviceType: playbackDeviceType
      });
    }
  }).catch(error => console.warn('No se pudo sincronizar la reproducción móvil.', error));
}

function broadcastPlaybackState(force = false) {
  if (isActivatingPlaybackTransfer) return;
  const song = getCurrentSong();
  const socket = state.socket;
  if (!state.user?._id || !song || !socket?.connected) return;
  const now = Date.now();
  if (!force && now - lastRealtimePlaybackBroadcast < 1000) return;
  lastRealtimePlaybackBroadcast = now;
  socket.emit('songChanged', {
    userId: state.user._id,
    excludeUserId: state.followingUserId,
    playback: createCurrentPlaybackSnapshot()
  });
}

function emitSharedQueueSnapshot() {
  if (state.sharedQueueRole !== 'host' || !state.sharedQueueSessionId || !state.socket?.connected) return;
  const sourceQueue = state.shuffle
    ? state.shuffleQueue.map(index => state.queue[index])
    : state.queue.slice(state.queueIndex + 1);
  const songIds = sourceQueue.map(getSongId).filter(Boolean).slice(0, 5000);
  const upcomingSongIds = state.upcomingQueue.map(getSongId).filter(Boolean).slice(0, 5000);
  const queueName = state.sharedQueueJamActive
    ? state.sharedQueueHostQueueName
    : state.queueTitle;
  const signature = `${state.sharedQueueSessionId}:${queueName}:${songIds.join(',')}:${upcomingSongIds.join(',')}`;
  if (signature === state.sharedQueueSnapshotSignature) return;
  state.sharedQueueSnapshotSignature = signature;
  state.socket.emit('listenTogetherQueueSnapshot', {
    sessionId: state.sharedQueueSessionId,
    songIds,
    upcomingSongIds,
    queueName
  }, response => {
    if (!response?.success) {
      if (state.sharedQueueSnapshotSignature === signature) state.sharedQueueSnapshotSignature = '';
      showToast(response?.error || 'No se pudo sincronizar la cola compartida.', true);
    }
  });
}

function scheduleRealtimeLibraryRefresh() {
  window.clearTimeout(realtimeLibraryRefreshTimer);
  realtimeLibraryRefreshTimer = window.setTimeout(() => {
    void refreshRealtimeLibrary();
  }, 250);
}

async function playAnnoySound() {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) throw new Error('Este dispositivo no admite reproducción de audio avanzada.');
  const context = audioContext || new AudioContextConstructor();
  audioContext = context;
  if (!annoyAudioBufferPromise) {
    annoyAudioBufferPromise = fetch('./airhorn.mp3')
      .then(response => {
        if (!response.ok) throw new Error(`No se pudo cargar airhorn.mp3 (${response.status}).`);
        return response.arrayBuffer();
      })
      .then(buffer => context.decodeAudioData(buffer));
  }
  const buffer = await annoyAudioBufferPromise;
  if (context.state === 'suspended') await context.resume();
  if (context.state !== 'running') {
    throw new Error('El navegador bloqueó el audio. Interactúa con la app y vuelve a intentarlo.');
  }
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = buffer;
  gain.gain.value = 0.8;
  source.connect(gain);
  gain.connect(context.destination);
  source.addEventListener('ended', () => {
    source.disconnect();
    gain.disconnect();
  }, { once: true });
  source.start();
}

async function refreshCurrentUser() {
  const userId = String(state.user?._id || '');
  if (!userId || !navigator.onLine) return;
  try {
    const user = await request('/auth/me');
    if (String(state.user?._id || '') !== userId || String(user?._id || '') !== userId) return;
    state.user = user;
    state.seekSeconds = Math.max(1, Number(user.settings?.seekSeconds) || 5);
    state.maxVolume = Math.min(10, Math.max(1, Number(user.settings?.maxVolume) / 100 || 2));
    elements.playerVolume.max = String(state.maxVolume);
    setPlayerVolume(state.volume);
    localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user));
    updateNavigationState();
    if (state.currentTab === 'profile' && !state.profileUser) renderProfile();
    if (state.offlineEnabled) {
      try {
        await saveOfflineFriends(userId, state.friends);
      } catch (error) {
        console.warn('No se pudo actualizar la caché offline del perfil.', error);
      }
      void downloadOfflineLibrary();
    }
    void loadSecondaryLibraryData();
  } catch (error) {
    console.warn('No se pudo sincronizar el perfil móvil en tiempo real.', error);
  }
}

async function reconcilePlaybackLibrary(previousPlayback) {
  const tracksById = new Map([
    ...state.songs,
    ...state.playlists.flatMap(playlist => playlist.tracks || []),
    ...state.profilePlaylists.flatMap(playlist => playlist.tracks || [])
  ].map(song => [getSongId(song), song]));
  const refreshTrack = song => tracksById.get(getSongId(song)) || song;
  state.queue = previousPlayback.queue.map(refreshTrack);
  state.upcomingQueue = state.upcomingQueue.map(refreshTrack);
  state.currentTrack = previousPlayback.currentTrack
    ? refreshTrack(previousPlayback.currentTrack)
    : null;
  if (previousPlayback.currentTrack && state.currentQueueKind === 'source') {
    const currentIndex = state.queue.findIndex(song => (
      getSongId(song) === getSongId(previousPlayback.currentTrack)
    ));
    if (currentIndex >= 0) state.queueIndex = currentIndex;
  }
  const refreshedAudioSource = state.currentTrack?.path || state.currentTrack?.audioUrl || '';
  if (
    state.currentTrack
    && refreshedAudioSource !== previousPlayback.audioSource
    && !getRemotePlaybackSession()
    && !state.followingUserId
  ) {
    await loadTrack(state.currentTrack, {
      autoplay: previousPlayback.wasPlaying,
      restoreTime: previousPlayback.currentTime
    });
  }
}

async function refreshRealtimeLibrary() {
  if (!state.user?._id || !navigator.onLine) return;
  const requestSequence = ++libraryRequestSequence;
  const userId = String(state.user._id);
  const previousPlayback = {
    queue: [...state.queue],
    currentTrack: getCurrentSong(),
    audioSource: getCurrentSong()?.path || getCurrentSong()?.audioUrl || '',
    currentTime: Number(elements.audio.currentTime) || 0,
    wasPlaying: !elements.audio.paused && !elements.audio.ended
  };
  try {
    const [songResult, playlists, user] = await Promise.all([
      request('/songs'),
      request('/playlists'),
      request('/auth/me')
    ]);
    if (
      requestSequence !== libraryRequestSequence
      || String(state.user?._id || '') !== userId
      || String(user?._id || '') !== userId
    ) return;
    state.songs = Array.isArray(songResult?.songs) ? songResult.songs : [];
    state.playlists = Array.isArray(playlists) ? playlists : [];
    state.user = user;
    libraryRevision += 1;
    state.seekSeconds = Math.max(1, Number(user.settings?.seekSeconds) || 5);
    state.maxVolume = Math.min(10, Math.max(1, Number(user.settings?.maxVolume) / 100 || 2));
    elements.playerVolume.max = String(state.maxVolume);
    setPlayerVolume(state.volume);
    await reconcilePlaybackLibrary(previousPlayback);
    localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user));
    updateNavigationState();
    renderCurrentView();
    renderDrawerFriends();
    updatePlayerUI();
    void Promise.all([
      saveOfflineLibrary(userId, state.songs),
      saveOfflinePlaylists(userId, state.playlists)
    ]).then(() => {
      if (state.offlineEnabled && navigator.onLine) void downloadOfflineLibrary();
    }).catch(error => {
      console.warn('No se pudo actualizar la biblioteca offline tras un cambio en tiempo real.', error);
    });
    if (state.profileUser && String(state.profileUser._id) !== userId) {
      void loadProfileDetails(state.profileUser, false);
    }
  } catch (error) {
    if (requestSequence !== libraryRequestSequence) return;
    console.warn('No se pudo actualizar la biblioteca tras un cambio en tiempo real.', error);
  }
}

function connectRealtime() {
  if (!state.token || !state.user?._id) return;
  const baseUrl = new URL(API_BASE_URL).origin;
  if (state.socket?.connected && realtimeBaseUrl === baseUrl) return;
  state.socket?.disconnect();
  let connectedOnce = false;
  const socket = io(baseUrl, {
    path: '/socket.io',
    auth: callback => callback({ token: state.token }),
    transports: ['websocket', 'polling']
  });
  realtimeBaseUrl = baseUrl;
  state.socket = socket;
  window.clearInterval(realtimeFriendsRefreshTimer);
  realtimeFriendsRefreshTimer = window.setInterval(() => {
    if (
      state.token
      && navigator.onLine
      && document.visibilityState === 'visible'
      && !state.socket?.connected
    ) void loadFriends();
  }, 15000);
  socket.on('disconnect', () => {
    state.playbackOwnerConfirmed = false;
    setCurrentUserOnline(false);
    updatePlayerUI();
    friendRealtimeUpdates.forEach((update, friendId) => {
      friendRealtimeUpdates.set(friendId, { ...update, isOnline: false });
    });
    clearSharedQueueState();
    renderPlayerQueue();
  });
  socket.on('connect', () => {
    setCurrentUserOnline(true);
    state.playbackOwnerConfirmed = false;
    state.accountQueueDeviceId = null;
    socket.emit('playbackStateRequest', { deviceId: playbackDeviceId, deviceType: playbackDeviceType });
    void resumePendingPlaybackTakeover().then(() => flushPendingAccountQueue());
    if (!elements.audio.paused && getCurrentSong() && !getRemotePlaybackSession()) {
      broadcastPlaybackState(true);
    }
    updatePlayerUI();
    socket.emit('friendsChanged');
    if (state.followingUserId) joinSharedQueue(state.followingUserId);
    if (connectedOnce) {
      scheduleRealtimeLibraryRefresh();
      void loadFriends();
    }
    connectedOnce = true;
  });
  socket.on('connect_error', error => {
    console.warn('No se pudo conectar a las funciones sociales en tiempo real.', error.message);
  });
  socket.on('presenceChanged', ({ userId, isOnline, updatedAt } = {}) => {
    rememberFriendRealtimeUpdate(userId, {
      isOnline: Boolean(isOnline),
      ...(updatedAt && { updatedAt })
    });
    const friend = state.friends.find(item => String(item._id) === String(userId));
    if (friend) {
      friend.isOnline = Boolean(isOnline);
      friend.lastActive = updatedAt || friend.lastActive;
    }
    if (state.profileUser && String(state.profileUser._id) === String(userId)) {
      state.profileUser = {
        ...state.profileUser,
        isOnline: Boolean(isOnline),
        lastActive: updatedAt || state.profileUser.lastActive
      };
    }
    renderDrawerFriends();
    if (state.currentTab === 'profile') renderProfile();
  });
  socket.on('friendsChanged', () => {
    socket.emit('friendsChanged');
    void loadFriends();
  });
  socket.on('songCatalogChanged', scheduleRealtimeLibraryRefresh);
  socket.on('playlistChanged', ({ changedBy } = {}) => {
    if (String(changedBy || '') === String(state.user?._id || '')) return;
    scheduleRealtimeLibraryRefresh();
  });
  socket.on('playlistsChanged', scheduleRealtimeLibraryRefresh);
  socket.on('songSuggestionsChanged', () => {
    void loadSecondaryLibraryData();
  });
  socket.on('secretPhrasesChanged', () => {
    void loadSecondaryLibraryData();
  });
  socket.on('userStatsChanged', ({ userId } = {}) => {
    const profile = getProfileUser();
    if (
      state.currentTab === 'profile'
      && String(profile?._id || '') === String(userId || '')
    ) {
      state.profileStats = null;
      void loadProfileDetails(profile, String(profile._id) === String(state.user?._id));
    }
  });
  socket.on('userHistoryChanged', ({ userId, lastPlayedHistory } = {}) => {
    if (!userId || !Array.isArray(lastPlayedHistory)) return;
    const normalizedUserId = String(userId);
    const friend = state.friends.find(item => String(item._id) === normalizedUserId);
    if (friend) friend.lastPlayedHistory = lastPlayedHistory;
    if (String(state.user?._id || '') === normalizedUserId && state.user) {
      state.user = { ...state.user, lastPlayedHistory };
      localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(state.user));
    }
    if (String(state.profileUser?._id || '') === normalizedUserId) {
      state.profileUser = { ...state.profileUser, lastPlayedHistory };
    }
    if (state.currentTab === 'profile' && String(getProfileUser()?._id || '') === normalizedUserId) {
      renderProfile();
    }
    if (friend && state.offlineEnabled) {
      void saveOfflineFriends(state.user?._id, state.friends).catch(error => {
        console.warn('No se pudo actualizar el historial del amigo en la caché offline.', error);
      });
    }
  });
  socket.on('userChanged', ({ userId } = {}) => {
    if (String(userId || '') !== String(state.user?._id || '')) return;
    void refreshCurrentUser();
  });
  socket.on('playlistSavesChanged', payload => {
    if (!payload?.playlistId || !Number.isFinite(Number(payload.savedCount))) return;
    const playlistId = String(payload.playlistId);
    const savedCount = Math.max(0, Number(payload.savedCount));
    [
      ...state.playlists,
      ...state.profilePlaylists
    ].forEach(playlist => {
      if (String(playlist.id) === playlistId) playlist.savedCount = savedCount;
    });
    const cachedSavers = playlistSaversCache.get(playlistId);
    if (cachedSavers && payload.user?._id && typeof payload.saved === 'boolean') {
      const nextSavers = cachedSavers.filter(user => String(user._id) !== String(payload.user._id));
      if (payload.saved) nextSavers.push(payload.user);
      nextSavers.sort((first, second) => String(first.username).localeCompare(String(second.username), 'es'));
      playlistSaversCache.set(playlistId, nextSavers);
      if (
        elements.dialog.open
        && !elements.membersSheet.hidden
        && elements.membersSheet.querySelector('.sheet-heading h2').textContent === 'Personas que la guardaron'
      ) {
        const options = document.getElementById('playlist-members-options');
        options.replaceChildren();
        if (!nextSavers.length) {
          options.append(makeElement('div', 'empty-state', 'Nadie la ha guardado todavía.'));
        } else {
          nextSavers.forEach(user => {
            const option = makeElement('div', 'sheet-option');
            option.append(
              imageElement(getUserPhoto(user) || './img/perrocorasongif.gif', '', ''),
              makeProfileUserLink(user)
            );
            options.append(option);
          });
        }
      }
      if (state.user?._id) {
        void saveOfflinePlaylistSavers(state.user._id, playlistId, {
          count: savedCount,
          users: nextSavers
        }).catch(error => console.warn('No se pudo actualizar la lista offline de personas que guardaron la playlist.', error));
      }
    }
    if (state.currentTab === 'profile' || state.currentPlaylistId) renderCurrentView();
    if (state.user?._id) {
      void saveOfflinePlaylists(state.user._id, state.playlists)
        .catch(error => console.warn('No se pudo actualizar el contador de playlists offline.', error));
    }
  });
  const handleFriendPlayback = ({ userId, playback } = {}) => {
    const friendId = String(userId || '');
    if (!friendId || !playback) return;
    rememberFriendRealtimeUpdate(friendId, {
      isOnline: true,
      lastPlayed: playback,
      updatedAt: playback.updatedAt
    });
    const friend = state.friends.find(item => String(item._id) === friendId)
      || (String(state.profileUser?._id || '') === friendId ? state.profileUser : null);
    if (!friend) {
      if (state.followingUserId === friendId) {
        void applyFriendPlayback({ _id: friendId }, playback);
      }
      return;
    }
    const previous = friend.lastPlayed;
    const trackChanged = String(previous?.songId || '') !== String(playback.songId || '')
      || previous?.songName !== playback.songName
      || previous?.deviceType !== playback.deviceType
      || previous?.isPlaying !== playback.isPlaying;
    friend.lastPlayed = playback;
    friend.isOnline = true;
    if (state.profileUser && String(state.profileUser._id) === friendId) {
      state.profileUser = { ...state.profileUser, lastPlayed: playback, isOnline: true };
    }
    renderDrawerFriends();
    if (state.currentTab === 'profile' && String(getProfileUser()?._id) === friendId) {
      if (trackChanged) {
        renderProfile();
      } else {
        const progress = document.querySelector('.profile-listening-progress');
        if (progress) {
          progress.dataset.currentTime = String(Number(playback.currentTime) || 0);
          progress.dataset.updatedAt = String(playback.updatedAt || '');
          progress.dataset.playing = String(playback.isPlaying !== false);
          progress.dataset.online = 'true';
          updateProfileListeningProgress();
        }
      }
    }
    if (state.followingUserId === friendId) void applyFriendPlayback(friend, playback);
  };
  socket.off('playbackDevicesChanged').on('playbackDevicesChanged', ({ userId, devices } = {}) => {
    if (
      String(userId || '') !== String(state.user?._id || '')
      || !Array.isArray(devices)
    ) return;
    connectedPlaybackDevices = devices.filter(device => (
      typeof device?.deviceId === 'string'
      && ['mobile', 'desktop', 'unknown'].includes(device.deviceType)
    ));
    updatePlaybackDevicePickerIcons();
    renderPlaybackDevicePicker();
    updatePlayerUI();
    syncAccountQueue();
  });
  socket.off('playbackTransferCommand').on('playbackTransferCommand', activateTransferredPlayback);
  socket.off('playbackControlCommand').on('playbackControlCommand', async (command = {}, acknowledge = () => {}) => {
    const acknowledgeResult = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!getCurrentSong()) {
      acknowledgeResult({ success: false, error: 'No hay una canción cargada en este dispositivo.' });
      return;
    }
    try {
      if (command.action === 'toggle') {
        if (elements.audio.paused) await resumeAudioPlayback();
        else {
          currentTrackShouldAutoplay = false;
          elements.audio.pause();
        }
      } else if (command.action === 'next') {
        playNext(1);
      } else if (command.action === 'previous') {
        playNext(-1);
      } else if (command.action === 'seek' && Number.isFinite(Number(command.position))) {
        const duration = Number.isFinite(elements.audio.duration) && elements.audio.duration > 0
          ? elements.audio.duration
          : Number.MAX_SAFE_INTEGER;
        elements.audio.currentTime = Math.min(duration, Math.max(0, Number(command.position)));
        syncPlaybackStatus(true);
      } else if (command.action === 'shuffle') {
        toggleShuffle();
      } else if (command.action === 'playTrack') {
        const queues = [
          state.songs,
          ...state.playlists.map(playlist => playlist.tracks || [])
        ];
        const queue = queues.find(tracks => tracks.some(song => getSongId(song) === String(command.songId)));
        const index = queue?.findIndex(song => getSongId(song) === String(command.songId)) ?? -1;
        if (!queue || index < 0) {
          acknowledgeResult({ success: false, error: 'La canción solicitada no está disponible en esta biblioteca.' });
          return;
        }
        const loaded = await playTrack(queue, index, { queueTitle: 'GENERAL' });
        if (!loaded) {
          acknowledgeResult({ success: false, error: 'No se pudo iniciar la canción solicitada.' });
          return;
        }
      } else {
        acknowledgeResult({ success: false, error: 'El control remoto solicitado no es válido.' });
        return;
      }
      acknowledgeResult({ success: true });
    } catch (error) {
      console.error('No se pudo ejecutar el control de reproducción remoto.', error);
      acknowledgeResult({ success: false, error: error.message || 'No se pudo controlar la reproducción.' });
    }
  });
  socket.off('playbackHandoffRequest').on('playbackHandoffRequest', (requestPayload = {}, acknowledge = () => {}) => {
    const acknowledgeResult = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!getCurrentSong()) {
      acknowledgeResult({ success: false, error: 'No hay una canción cargada para transferir.' });
      return;
    }
    if (!elements.audio.paused) {
      currentTrackShouldAutoplay = false;
      suppressRemotePlaybackPause = true;
      elements.audio.pause();
    }
    const playback = createCurrentPlaybackSnapshot(false);
    syncPlaybackStatus(true);
    acknowledgeResult({ success: true, playback, requesterDeviceId: requestPayload.requesterDeviceId });
  });
  socket.off('playbackOwnerChanged').on('playbackOwnerChanged', handleOwnPlaybackUpdate);
  socket.on('songChanged', handleFriendPlayback);
  socket.on('playbackStatusChanged', handleFriendPlayback);
  socket.on('messageReceived', ({ message } = {}) => {
    if (!message) return;
    void notifyIncomingChatMessage(message);
    void loadUnreadMessages(true);
    if (String(state.activeChatFriend?._id || '') === String(message.sender)) {
      void loadChatMessages();
    } else {
      showToast(`Nuevo mensaje de ${message.senderName || 'un amigo'}.`);
    }
  });
  socket.on('annoy', ({ senderName } = {}, acknowledge = () => {}) => {
    playAnnoySound().then(() => {
      acknowledge({ success: true });
      showToast(senderName ? `${senderName} te ha molestado` : 'Recibiste una molestia');
    }).catch(error => {
      console.warn('No se pudo reproducir el audio de molestia.', error);
      acknowledge({ success: false, error: error.message });
      showToast(error.message || 'No se pudo reproducir el audio de molestia.', true);
    });
  });
  socket.on('messageSent', ({ message } = {}) => {
    if (message && String(state.activeChatFriend?._id || '') === String(message.receiver)) {
      void loadChatMessages();
    }
  });
  socket.on('messageUpdated', () => {
    if (state.activeChatFriend) void loadChatMessages();
  });
  socket.on('messagesRead', () => {
    void loadUnreadMessages(true);
    if (state.activeChatFriend) void loadChatMessages();
  });
  socket.on('listenTogetherQueueSessionStarted', ({
    sessionId,
    peerId,
    jamActive = false,
    songIds = [],
    upcomingSongIds = [],
    revision = 0,
    queueName = 'GENERAL'
  } = {}) => {
    if (!sessionId || !peerId) return;
    state.sharedQueueSessionId = String(sessionId);
    state.sharedQueueRole = 'host';
    state.sharedQueueRevision = Number(revision) || 0;
    state.sharedQueueIds = Array.isArray(songIds) ? songIds.map(String) : [];
    state.sharedQueueUpcomingIds = Array.isArray(upcomingSongIds) ? upcomingSongIds.map(String) : [];
    state.sharedQueueHostQueueName = typeof queueName === 'string' && queueName.trim()
      ? queueName.trim()
      : 'GENERAL';
    state.sharedQueueJamActive = Boolean(jamActive);
    state.hostJamRequestId = '';
    state.sharedQueueSnapshotSignature = '';
    if (state.sharedQueueJamActive) {
      applyJamQueue(state.sharedQueueIds, { hostCommand: true });
      applyJamUpcomingQueue(state.sharedQueueUpcomingIds, { hostCommand: true });
      return;
    }
    emitSharedQueueSnapshot();
    renderPlayerQueue();
  });
  socket.on('listenTogetherQueueSnapshotRequest', ({ sessionId } = {}) => {
    if (state.sharedQueueRole === 'host' && String(sessionId) === String(state.sharedQueueSessionId)) {
      emitSharedQueueSnapshot();
    }
  });
  socket.on('listenTogetherQueueSnapshot', ({
    sessionId,
    revision,
    songIds,
    upcomingSongIds = [],
    queueName = state.sharedQueueHostQueueName
  } = {}) => {
    if (
      String(sessionId) !== String(state.sharedQueueSessionId)
      || !Number.isInteger(revision)
      || revision <= state.sharedQueueRevision
      || !Array.isArray(songIds)
      || !Array.isArray(upcomingSongIds)
    ) return;
    state.sharedQueueRevision = revision;
    state.sharedQueueIds = songIds.map(String);
    state.sharedQueueUpcomingIds = upcomingSongIds.map(String);
    state.sharedQueueHostQueueName = typeof queueName === 'string' && queueName.trim()
      ? queueName.trim()
      : 'GENERAL';
    if (state.sharedQueueRole === 'host') return;
    if (state.sharedQueueRole !== 'follower') return;
    if (state.sharedQueueJamPendingUpcomingIds?.join(',') === state.sharedQueueUpcomingIds.join(',')) {
      state.sharedQueueJamPendingUpcomingIds = null;
      state.sharedQueueJamUpdateInFlight = false;
    }
    renderPlayerQueue();
  });
  socket.on('listenTogetherJamRequestReceived', ({ sessionId, requestId, followerId } = {}) => {
    if (String(sessionId) !== String(state.sharedQueueSessionId)) return;
    showJamRequestNotification(requestId, followerId);
  });
  socket.on('listenTogetherJamRequestClosed', ({ sessionId, requestId, reason } = {}) => {
    if (String(sessionId) !== String(state.sharedQueueSessionId)) return;
    if (
      state.sharedQueueJamRequestPending
      && (!state.sharedQueueJamRequestId || state.sharedQueueJamRequestId === String(requestId || ''))
    ) {
      state.sharedQueueJamRequestPending = false;
      state.sharedQueueJamRequestId = '';
      updateJamControls();
      if (reason === 'expired') showToast('La solicitud de Jam venció sin respuesta.', true);
    }
    closeJamRequestNotification(requestId);
  });
  socket.on('listenTogetherJamState', ({
    sessionId,
    requestId,
    active,
    accepted,
    songIds,
    upcomingSongIds = [],
    revision,
    queueName = state.sharedQueueHostQueueName
  } = {}) => {
    if (String(sessionId) !== String(state.sharedQueueSessionId)) return;
    if (requestId) {
      state.sharedQueueJamRequestPending = false;
      state.sharedQueueJamRequestId = '';
    }
    if (!accepted) {
      state.sharedQueueJamActive = false;
      closeJamRequestNotification(requestId);
      renderPlayerQueue();
      if (state.sharedQueueRole === 'follower') {
        showToast('El anfitrión rechazó la propuesta de Jam.', true);
      }
      return;
    }
    state.sharedQueueJamActive = Boolean(active);
    state.sharedQueueJamUpdateInFlight = false;
    state.sharedQueueJamPendingUpcomingIds = null;
    state.sharedQueueRevision = Number(revision) || state.sharedQueueRevision;
    state.sharedQueueHostQueueName = typeof queueName === 'string' && queueName.trim()
      ? queueName.trim()
      : 'GENERAL';
    state.sharedQueueIds = Array.isArray(songIds) ? songIds.map(String) : [];
    state.sharedQueueUpcomingIds = Array.isArray(upcomingSongIds) ? upcomingSongIds.map(String) : [];
    if (state.sharedQueueJamActive) {
      const applied = applyJamQueue(state.sharedQueueIds, {
        hostCommand: state.sharedQueueRole === 'host'
      });
      const upcomingApplied = applyJamUpcomingQueue(state.sharedQueueUpcomingIds, {
        hostCommand: state.sharedQueueRole === 'host'
      });
      if (!applied || !upcomingApplied) {
        showToast('No se pudo preparar la cola de la Jam; revisa que las canciones estén cargadas.', true);
        return;
      }
      showToast(state.sharedQueueRole === 'host'
        ? 'Jam iniciada; la cola y la reproducción se comparten.'
        : 'Jam aceptada; puedes controlar la reproducción y editar «A continuación».');
    }
    closeJamRequestNotification(requestId);
    updateJamControls();
  });
  socket.on('listenTogetherJamQueueReplaceCommand', ({
    sessionId,
    requestId,
    revision,
    songIds
  } = {}, acknowledge = () => {}) => {
    if (
      state.sharedQueueRole !== 'host'
      || !state.sharedQueueJamActive
      || String(sessionId) !== String(state.sharedQueueSessionId)
      || revision !== state.sharedQueueRevision
    ) {
      acknowledge({ success: false, error: 'La Jam cambió; vuelve a sincronizar la cola.' });
      return;
    }
    const success = applyJamUpcomingQueue(songIds, { hostCommand: true });
    acknowledge(success
      ? { success: true, requestId }
      : { success: false, error: 'La cola contiene canciones no disponibles en el dispositivo anfitrión.' });
  });
  socket.on('listenTogetherJamPlaybackCommand', async ({
    sessionId,
    action,
    songId,
    queueKind = 'source'
  } = {}, acknowledge = () => {}) => {
    if (
      state.sharedQueueRole !== 'host'
      || !state.sharedQueueJamActive
      || String(sessionId) !== String(state.sharedQueueSessionId)
    ) {
      acknowledge({ success: false, error: 'La Jam ya no está activa en el anfitrión.' });
      return;
    }
    try {
      if (action === 'playTrack') {
        const requestedSongId = String(songId || '');
        const targetQueue = queueKind === 'upcoming' ? state.upcomingQueue : state.queue;
        const queuePosition = targetQueue.findIndex(song => getSongId(song) === requestedSongId);
        if (queuePosition < 0) {
          acknowledge({ success: false, error: 'La canción ya no está en la cola de la Jam.' });
          return;
        }
        if (requestedSongId === getSongId(getCurrentSong())) {
          acknowledge({ success: true });
          return;
        }
        const started = queueKind === 'upcoming'
          ? await playUpcomingTrack(queuePosition)
          : await playSourceQueueTrack(queuePosition);
        acknowledge(started === false
          ? { success: false, error: 'No se pudo reproducir la canción en el anfitrión.' }
          : { success: true });
        return;
      }
      if (action === 'next') await playNext(1);
      else if (action === 'previous') await playNext(-1);
      else if (action === 'pause') elements.audio.pause();
      else if (action === 'play') await elements.audio.play();
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
  socket.on('accountQueueSnapshot', ({ revision, songIds, sourceSongIds, queueName } = {}) => {
    if (!Number.isInteger(revision) || revision < state.accountQueueRevision || !Array.isArray(songIds)) return;
    const shouldReconcileLocalQueue = state.playbackOwnerConfirmed
      && state.ownPlayback?.deviceId === playbackDeviceId
      && !getRemotePlaybackSession()
      && !state.followingUserId
      && !state.sharedQueueSessionId
      && !Array.isArray(state.accountQueuePendingIds);
    if (shouldReconcileLocalQueue) {
      const tracksById = new Map(state.songs.map(song => [getSongId(song), song]));
      const tracks = songIds.map(songId => tracksById.get(String(songId)));
      if (tracks.every(Boolean)) {
        state.upcomingQueue = tracks;
        persistUpcomingQueue();
      }
    }
    state.accountQueueRevision = revision;
    state.accountQueueIds = songIds.map(String);
    if (Array.isArray(sourceSongIds)) state.accountQueueSourceIds = sourceSongIds.map(String);
    if (typeof queueName === 'string' && queueName.trim()) state.accountQueueName = queueName.trim().slice(0, 100);
    state.accountQueueSnapshotSignature = getAccountQueueSnapshotSignature();
    state.accountQueueSnapshotCached = true;
    persistAccountQueueSnapshot();
    const pendingMatchesServer = state.accountQueuePendingIds
      && state.accountQueuePendingIds.join(',') === state.accountQueueIds.join(',');
    if (pendingMatchesServer) clearPendingAccountQueueIds();
    state.accountQueueDeviceId = getRemotePlaybackSession()?.deviceId || null;
    renderPlayerQueue();
    if (state.accountQueuePendingIds && !state.accountQueueSyncInFlight) {
      window.setTimeout(() => flushPendingAccountQueue(), 0);
    }
  });
  socket.on('accountQueuePublishRequest', () => {
    if (!getRemotePlaybackSession() && !state.followingUserId && !state.sharedQueueSessionId) {
      publishAccountQueueSnapshot(true);
    }
  });
  socket.on('accountQueueAddCommand', async ({ songId } = {}, acknowledge = () => {}) => {
    if (getRemotePlaybackSession() || state.followingUserId) {
      acknowledge({ success: false, error: 'La reproducción cambió de dispositivo.' });
      return;
    }
    const song = state.songs.find(item => getSongId(item) === String(songId || ''));
    if (!song) {
      acknowledge({ success: false, error: 'La canción no está disponible en esta biblioteca.' });
      return;
    }
    if (state.upcomingQueue.length >= 5000) {
      acknowledge({ success: false, error: 'La cola alcanzó el máximo de 5000 canciones.' });
      return;
    }
    const previousQueue = [...state.upcomingQueue];
    state.upcomingQueue.push(song);
    persistUpcomingQueue();
    renderPlayerQueue({ syncAccount: false });
    const synchronized = await publishAccountQueueSnapshot();
    if (!synchronized) {
      state.upcomingQueue = previousQueue;
      persistUpcomingQueue();
      renderPlayerQueue({ syncAccount: false });
      acknowledge({ success: false, error: 'No se pudo confirmar la actualización de la cola.' });
      return;
    }
    acknowledge({ success: true });
  });
  socket.on('accountQueueReplaceCommand', async ({ revision, songIds } = {}, acknowledge = () => {}) => {
    if (
      getRemotePlaybackSession()
      || state.followingUserId
      || revision !== state.accountQueueRevision
      || !Array.isArray(songIds)
      || songIds.length > 5000
    ) {
      acknowledge({ success: false, error: 'La cola cambió. Vuelve a intentarlo.' });
      return;
    }
    const tracks = songIds.map(songId => state.songs.find(song => getSongId(song) === String(songId)));
    if (tracks.some(song => !song)) {
      acknowledge({ success: false, error: 'La cola contiene canciones que ya no están disponibles.' });
      return;
    }
    const previousQueue = [...state.upcomingQueue];
    state.upcomingQueue = tracks;
    persistUpcomingQueue();
    renderPlayerQueue({ syncAccount: false });
    const synchronized = await publishAccountQueueSnapshot(false, false, true);
    if (!synchronized) {
      state.upcomingQueue = previousQueue;
      persistUpcomingQueue();
      renderPlayerQueue({ syncAccount: false });
      acknowledge({ success: false, error: 'No se pudo confirmar la actualización de la cola.' });
      return;
    }
    acknowledge({ success: true });
  });
  socket.on('accountQueuePlayCommand', async ({ songId } = {}, acknowledge = () => {}) => {
    if (getRemotePlaybackSession() || state.followingUserId) {
      acknowledge({ success: false, error: 'La reproducción cambió de dispositivo.' });
      return;
    }
    if (
      state.ownPlayback?.deviceId === playbackDeviceId
      && state.ownPlayback.transferPending === true
    ) {
      acknowledge({
        success: false,
        ownerUnresponsive: true,
        error: 'La reproducción se está transfiriendo a otro dispositivo.'
      });
      return;
    }
    const requestedSongId = String(songId || '');
    const sourceIndices = state.shuffle
      ? [...state.shuffleQueue]
      : state.queue.slice(state.queueIndex + 1).map((_, offset) => state.queueIndex + offset + 1);
    const sourceQueue = sourceIndices.map(index => state.queue[index]).filter(Boolean);
    const queueTracks = [...state.upcomingQueue, ...sourceQueue];
    const currentPosition = queueTracks.findIndex(track => getSongId(track) === requestedSongId);
    const song = state.songs.find(track => getSongId(track) === requestedSongId)
      || queueTracks[currentPosition];
    if (!song) {
      acknowledge({ success: false, error: 'La canción solicitada ya no está disponible en este dispositivo.' });
      return;
    }
    const sequenceBeforeRequest = trackLoadSequence;
    try {
      let started;
      if (currentPosition >= 0 && currentPosition < state.upcomingQueue.length) {
        state.upcomingQueue[currentPosition] = song;
        started = await playUpcomingTrack(currentPosition);
      } else if (currentPosition >= state.upcomingQueue.length) {
        const sourceIndex = sourceIndices[currentPosition - state.upcomingQueue.length];
        state.queue[sourceIndex] = song;
        started = await playSourceQueueTrack(sourceIndex);
      } else {
        started = await playTrack([song], 0, { queueTitle: 'GENERAL' });
      }
      renderPlayerQueue({ syncAccount: false });
      if (started === false && trackLoadSequence > sequenceBeforeRequest + 1) {
        acknowledge({ success: true, superseded: true });
        return;
      }
      if (started !== false) {
        await publishAccountQueueSnapshot();
      }
      acknowledge(started === false
        ? { success: false, error: 'No se pudo reproducir la canción en este dispositivo.' }
        : { success: true });
    } catch (error) {
      console.error('No se pudo reproducir una canción solicitada desde otro dispositivo.', error);
      acknowledge({ success: false, error: error.message || 'No se pudo reproducir la canción.' });
    }
  });
  socket.on('listenTogetherQueueSessionEnded', ({ sessionId } = {}) => {
    if (String(sessionId) !== String(state.sharedQueueSessionId)) return;
    clearSharedQueueState();
    renderPlayerQueue();
  });
}

function joinSharedQueue(hostId) {
  const socket = state.socket;
  if (!socket?.connected || !hostId || state.sharedQueueRole === 'follower') return;
  socket.emit('listenTogetherQueueSessionJoin', { hostId: String(hostId) }, response => {
    if (!response?.success || !response.sessionId) {
      showToast(response?.error || 'No se pudo conectar la cola compartida.', true);
      return;
    }
    if (String(state.followingUserId) !== String(hostId)) {
      socket.emit('listenTogetherQueueSessionLeave', { sessionId: response.sessionId });
      return;
    }
    state.sharedQueueSessionId = response.sessionId;
    state.sharedQueueRole = 'follower';
    state.sharedQueueRevision = Number(response.revision) || 0;
    state.sharedQueueIds = Array.isArray(response.songIds) ? response.songIds.map(String) : [];
    state.sharedQueueUpcomingIds = Array.isArray(response.upcomingSongIds)
      ? response.upcomingSongIds.map(String)
      : [];
    state.sharedQueueHostQueueName = typeof response.queueName === 'string' && response.queueName.trim()
      ? response.queueName.trim()
      : 'GENERAL';
    state.sharedQueueJamActive = Boolean(response.jamActive);
    state.sharedQueueJamRequestPending = false;
    state.sharedQueueJamRequestId = '';
    state.sharedQueueJamUpdateInFlight = false;
    state.sharedQueueJamPendingUpcomingIds = null;
    renderPlayerQueue();
    if (!Array.isArray(response.songIds) || state.sharedQueueRevision < 1) {
      socket.emit('listenTogetherQueueSnapshotRequest', { sessionId: response.sessionId }, result => {
        if (!result?.success) showToast(result?.error || 'No se pudo cargar la cola compartida.', true);
      });
    }
  });
}

function clearSharedQueueState() {
  state.sharedQueueSessionId = null;
  state.sharedQueueRole = null;
  state.sharedQueueRevision = 0;
  state.sharedQueueIds = [];
  state.sharedQueueUpcomingIds = [];
  state.sharedQueueHostQueueName = 'GENERAL';
  state.sharedQueueJamActive = false;
  state.sharedQueueJamRequestPending = false;
  state.sharedQueueJamRequestId = '';
  state.sharedQueueJamUpdateInFlight = false;
  state.sharedQueueJamPendingUpcomingIds = null;
  state.sharedQueueSnapshotSignature = '';
  closeJamRequestNotification();
  updateJamControls();
}

function leaveSharedQueue() {
  if (state.sharedQueueSessionId && state.socket?.connected) {
    state.socket.emit('listenTogetherQueueSessionLeave', { sessionId: state.sharedQueueSessionId });
  }
  clearSharedQueueState();
}

function startListeningTogether(friend) {
  if (!friend?._id) return;
  if (!state.socket?.connected) {
    showToast('Las funciones sociales requieren conexión en tiempo real.', true);
    return;
  }
  if (state.followingUserId && String(state.followingUserId) !== String(friend._id)) stopFollowingFriend();
  state.followingUserId = String(friend._id);
  state.followNeedsUserGesture = false;
  joinSharedQueue(state.followingUserId);
  updatePlayerSource();
  if (friend.lastPlayed) void applyFriendPlayback(friend, friend.lastPlayed);
  if (state.currentTab === 'profile') renderProfile();
  showToast(`Conectando con la reproducción de ${friend.username || 'tu amigo'}.`);
}

function stopFollowingFriend() {
  leaveSharedQueue();
  state.followingUserId = null;
  state.followNeedsUserGesture = false;
  updatePlayerSource();
  if (state.currentTab === 'profile') renderProfile();
  syncPlaybackStatus(true);
}

async function applyFriendPlayback(friend, playback) {
  if (state.followingUserId !== String(friend._id) || !playback) return;
  const songId = String(playback.songId || '');
  const song = state.songs.find(item => getSongId(item) === songId);
  if (!song) {
    if (state.lastUnavailableFollowSongId !== songId) {
      state.lastUnavailableFollowSongId = songId;
      showToast('La canción que reproduce tu amigo no está disponible.', true);
    }
    return;
  }
  state.lastUnavailableFollowSongId = null;
  const currentSong = getCurrentSong();
  if (getSongId(currentSong) !== songId) {
    const queue = state.sharedQueueRole === 'follower' && state.queue.length
      ? state.queue
      : state.songs;
    let index = queue.findIndex(item => getSongId(item) === songId);
    if (index < 0) {
      queue.unshift(song);
      index = 0;
    }
    const setRemotePosition = () => {
      if (
        state.followingUserId !== String(friend._id)
        || getSongId(getCurrentSong()) !== songId
      ) return;
      if (!Number.isFinite(elements.audio.duration)) return;
      const age = Math.max(0, (Date.now() - Date.parse(playback.updatedAt || '')) / 1000);
      const elapsed = playback.isPlaying === false ? 0 : (Number.isFinite(age) ? age : 0);
      const target = Math.max(0, Number(playback.currentTime) || 0) + elapsed;
      elements.audio.currentTime = Math.min(target, elements.audio.duration);
    };
    elements.audio.addEventListener('loadedmetadata', setRemotePosition, { once: true });
    const started = await playTrack(queue, index, {
      sync: true,
      autoplay: playback.isPlaying !== false
    });
    if (!started) return;
    setRemotePosition();
  }
  if (
    state.followingUserId !== String(friend._id)
    || getSongId(getCurrentSong()) !== songId
  ) return;
  const serverAge = (Date.now() - Date.parse(playback.updatedAt || '')) / 1000;
  const expectedTime = Math.max(0, Number(playback.currentTime) || 0)
    + (playback.isPlaying === false ? 0 : (Number.isFinite(serverAge) ? Math.max(0, serverAge) : 0));
  if (Number.isFinite(elements.audio.duration) && Math.abs(elements.audio.currentTime - expectedTime) > 2) {
    elements.audio.currentTime = Math.min(expectedTime, elements.audio.duration);
  }
  if (playback.isPlaying === false) {
    currentTrackShouldAutoplay = false;
    elements.audio.pause();
  } else if (elements.audio.paused) {
    try {
      currentTrackShouldAutoplay = true;
      await elements.audio.play();
      state.followNeedsUserGesture = false;
    } catch (error) {
      state.followNeedsUserGesture = error.name === 'NotAllowedError';
      if (!state.followNeedsUserGesture) console.warn('No se pudo seguir la reproducción del amigo.', error);
    }
  }
  updatePlayerUI();
}

function openChat(friend) {
  if (!friend?._id) return;
  state.activeChatFriend = friend;
  document.getElementById('chat-title').textContent = friend.username || 'Chat';
  document.getElementById('chat-presence').textContent = friend.isOnline ? 'En línea' : 'Desconectado';
  setImageSource(
    document.getElementById('chat-avatar'),
    getUserPhoto(friend) || './img/perrocorasongif.gif'
  );
  elements.chatScreen.hidden = false;
  syncMiniPlayerVisibility();
  void loadChatMessages();
  clearInterval(state.chatPollTimer);
  state.chatPollTimer = setInterval(() => void loadChatMessages(), 30000);
}

function closeChat() {
  clearInterval(state.chatPollTimer);
  state.chatPollTimer = null;
  state.activeChatFriend = null;
  elements.chatScreen.hidden = true;
  syncMiniPlayerVisibility();
}

async function loadChatMessages() {
  const friend = state.activeChatFriend;
  if (!friend?._id || !state.user?._id) return;
  try {
    const messages = await request(`/messages/${encodeURIComponent(state.user._id)}/${encodeURIComponent(friend._id)}`);
    const container = document.getElementById('chat-messages');
    container.replaceChildren();
    messages.forEach(message => {
      const own = String(message.sender) === String(state.user._id);
      const item = makeElement('article', `chat-message${own ? ' own' : ''}`);
      item.append(makeElement('p', '', message.content || ''));
      if (message.type === 'playlist_invitation'
        && message.invitationStatus === 'pending'
        && String(message.receiver) === String(state.user._id)) {
        const actions = makeElement('div', 'playlist-invitation-actions');
        actions.append(
          makeButton('secondary-button', 'Guardar playlist', event => {
            void respondToPlaylistInvitation(message, true, event.currentTarget);
          }, 'Guardar playlist'),
          makeButton('text-button', 'Rechazar invitación', event => {
            void respondToPlaylistInvitation(message, false, event.currentTarget);
          }, 'Rechazar')
        );
        item.append(actions);
      }
      const timestamp = message.timestamp || message.createdAt;
      item.append(makeElement('small', '', timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''));
      container.append(item);
    });
    container.scrollTop = container.scrollHeight;
    void loadUnreadMessages(true);
  } catch (error) {
    showToast(error.message || 'No se pudo cargar la conversación.', true);
  }
}

async function respondToPlaylistInvitation(message, accept, clickedButton) {
  const actionButtons = clickedButton.closest('.playlist-invitation-actions')?.querySelectorAll('button') || [clickedButton];
  actionButtons.forEach(button => { button.disabled = true; });
  try {
    await request(`/playlists/invitations/${encodeURIComponent(message._id)}/respond`, {
      method: 'POST',
      body: JSON.stringify({ userId: state.user?._id, accept })
    });
    if (accept) await loadLibrary();
    showToast(accept ? 'Playlist guardada.' : 'Invitación rechazada.');
    await loadChatMessages();
  } catch (error) {
    actionButtons.forEach(button => { button.disabled = false; });
    showToast(error.message || 'No se pudo responder la invitación.', true);
  }
}

async function sendChatMessage(event) {
  event.preventDefault();
  const friend = state.activeChatFriend;
  const input = document.getElementById('chat-input');
  const content = input.value.trim();
  if (!friend?._id || !content) return;
  const clientId = `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await request('/messages', {
      method: 'POST',
      body: JSON.stringify({
        sender: state.user?._id,
        receiver: friend._id,
        content,
        clientId
      })
    });
    input.value = '';
    await loadChatMessages();
  } catch (error) {
    showToast(error.message || 'No se pudo enviar el mensaje.', true);
  }
}

async function annoyActiveChatFriend() {
  const button = document.getElementById('chat-annoy');
  const friendId = state.activeChatFriend?._id;
  if (!friendId) {
    showToast('Abre primero el chat del amigo al que quieres molestar.', true);
    return;
  }
  if (!state.socket?.connected) {
    showToast('No se pudo molestar: no hay conexión en tiempo real.', true);
    return;
  }
  button.disabled = true;
  state.socket.timeout(7000).emit('annoy', { friendId }, (timeoutError, result) => {
    button.disabled = false;
    if (timeoutError) {
      showToast('El servidor no confirmó la reproducción. Inténtalo de nuevo.', true);
      return;
    }
    if (!result?.success) showToast(result?.error || 'No se pudo reproducir el audio en el dispositivo del amigo.', true);
  });
}

async function resumeAudioPlayback() {
  if (isRemotePlaybackLocked()) return;
  currentTrackShouldAutoplay = true;
  if (state.maxVolume > 1) {
    ensureAudioGain();
    if (audioContext?.state === 'suspended') await audioContext.resume();
  }
  if (!currentTrackShouldAutoplay) return;
  await elements.audio.play();
  updatePlayerUI();
}

async function togglePlayback() {
  if (getRemotePlaybackSession()) return requestRemotePlaybackControl('toggle');
  if (state.followingUserId) {
    if (state.sharedQueueJamActive) {
      requestSharedJamPlayback(elements.audio.paused ? 'play' : 'pause');
    }
    return false;
  }
  if (isRemotePlaybackLocked()) return false;
  if (!getCurrentSong()) {
    if (state.songs.length) return playTrack(state.songs, 0);
    return false;
  }
  if (elements.audio.paused && currentTrackShouldAutoplay) {
    currentTrackShouldAutoplay = false;
    elements.audio.pause();
    updatePlayerUI();
    return true;
  }
  if (elements.audio.paused) {
    if (state.followingUserId && !state.followNeedsUserGesture) return false;
    try {
      await resumeAudioPlayback();
      return true;
    } catch (error) {
      if (!elements.audio.paused || error?.name === 'AbortError') {
        updatePlayerUI();
        return true;
      }
      console.error('No se pudo reanudar la canción.', error);
      showToast('No se pudo reanudar la reproducción.', true);
      return false;
    }
  } else {
    currentTrackShouldAutoplay = false;
    elements.audio.pause();
    return true;
  }
}

function toggleShuffle() {
  if (getRemotePlaybackSession()) {
    void requestRemotePlaybackControl('shuffle');
    return;
  }
  const activePlaylist = state.queueTitle === 'GENERAL'
    ? null
    : state.playlists.find(playlist => playlist.name === state.queueTitle);
  const sourceQueue = state.queueTitle === 'GENERAL'
    ? state.songs
    : activePlaylist?.tracks;
  const queueAnchor = state.currentQueueKind === 'source'
    ? getCurrentSong()
    : state.queue[state.queueIndex];
  if (sourceQueue?.length && queueAnchor) {
    const queueAnchorIndex = sourceQueue.findIndex(song => (
      getSongId(song) === getSongId(queueAnchor)
    ));
    if (queueAnchorIndex >= 0) {
      state.queue = [...sourceQueue];
      state.queueIndex = queueAnchorIndex;
      if (state.currentQueueKind === 'source') state.currentTrack = state.queue[queueAnchorIndex];
    }
  }
  state.shuffle = !state.shuffle;
  state.playbackHistory = [];
  if (state.shuffle) rebuildShuffleQueue();
  else state.shuffleQueue = [];
  document.getElementById('player-shuffle').setAttribute('aria-pressed', String(state.shuffle));
  document.getElementById('player-queue-shuffle').setAttribute('aria-pressed', String(state.shuffle));
  renderPlayerQueue();
  void updatePlaybackNotification();
  syncPlaybackStatus(true);
  showToast(state.shuffle ? 'Reproducción aleatoria activada.' : 'Reproducción aleatoria desactivada.');
}

function handlePlaybackNotificationAction(action) {
  if (action === 'shuffle') {
    toggleShuffle();
  } else if (action === 'toggle') {
    togglePlayback();
  } else if (action === 'next') {
    playNext(1);
  } else if (action === 'previous') {
    playNext(-1);
  }
}

async function loadLibrary(initialUser = null) {
  const requestSequence = ++libraryRequestSequence;
  libraryRevision += 1;
  state.catalogLoading = true;
  state.catalogLoadError = '';
  if (state.currentTab === 'songs' && !state.currentPlaylistId) renderCurrentView();
  const userId = String(state.user?._id || '');
  let libraryRequest = null;
  const previousPlayback = {
    queue: [...state.queue],
    currentTrack: getCurrentSong(),
    audioSource: getCurrentSong()?.path || getCurrentSong()?.audioUrl || '',
    currentTime: Number(elements.audio.currentTime) || 0,
    wasPlaying: !elements.audio.paused && !elements.audio.ended
  };
  const cachedUser = initialUser || state.user;
  const cachedUserId = String(cachedUser?._id || '');
  if (cachedUserId) {
    state.offlineEnabled = localStorage.getItem(`amgc-offline-enabled-${cachedUserId}`) === 'true';
  }
  if (cachedUserId) {
    try {
      const [offlineLibrary, offlinePlaylists, offlineFriends] = await Promise.all([
        getOfflineLibrary(cachedUserId),
        getOfflinePlaylists(cachedUserId),
        getOfflineFriends(cachedUserId)
      ]);
      if (
        requestSequence === libraryRequestSequence
        && String(state.user?._id || cachedUserId) === cachedUserId
        && (Array.isArray(offlineLibrary?.songs) || Array.isArray(offlinePlaylists?.playlists))
      ) {
        state.user = cachedUser;
        if (Array.isArray(offlineLibrary?.songs)) state.songs = offlineLibrary.songs;
        state.playlists = offlinePlaylists?.playlists || [];
        state.friends = offlineFriends?.friends || state.friends;
        restoreAccountQueueSnapshot(cachedUserId);
        restorePendingAccountQueueIds(cachedUserId);
        updateNavigationState();
        renderCurrentView();
        updatePlayerUI();
        void refreshOfflineAudioAvailability();
        updateOfflineStatus('Biblioteca local lista; comprobando cambios en segundo plano…');
        if (navigator.onLine) {
          libraryRequest = Promise.all([
            request('/songs'),
            request('/playlists'),
            initialUser ? Promise.resolve(initialUser) : request('/auth/me')
          ]);
          libraryRequest.catch(() => {});
        }
        await reconcilePlaybackLibrary(previousPlayback);
        await hydrateCurrentOfflineImages();
        if (requestSequence !== libraryRequestSequence) return;
        updateNavigationState();
        renderCurrentView();
        updatePlayerUI();
        void refreshOfflineAudioAvailability();
        void restoreLastPlayback().catch(error => {
          console.warn('No se pudo restaurar la reproducción guardada localmente.', error);
        });
      }
    } catch (error) {
      console.warn('No se pudo preparar la biblioteca local antes de sincronizar.', error);
    }
  }
  try {
    const [songResult, playlistResult, user] = await (libraryRequest || Promise.all([
      request('/songs'),
      request('/playlists'),
      initialUser ? Promise.resolve(initialUser) : request('/auth/me')
    ]));
    if (requestSequence !== libraryRequestSequence || (userId && String(state.user?._id || '') !== userId)) return;
    if (!Array.isArray(songResult?.songs)) {
      throw new Error('El servidor devolvió un catálogo de canciones inválido.');
    }
    state.songs = songResult.songs;
    const pendingTracksByPlaylist = new Map(state.playlists.map(playlist => [
      String(playlist.id),
      (playlist.tracks || []).filter(track => track.syncPending)
    ]).filter(([, tracks]) => tracks.length));
    state.playlists = Array.isArray(playlistResult) ? playlistResult : [];
    state.playlists.forEach(playlist => {
      const pendingTracks = pendingTracksByPlaylist.get(String(playlist.id)) || [];
      pendingTracks.forEach(track => {
        if (!(playlist.tracks || []).some(item => getSongId(item) === getSongId(track))) {
          playlist.tracks = [...(playlist.tracks || []), track];
        }
      });
    });
    state.user = user;
    state.catalogLoading = false;
    state.catalogLoadError = '';
    restoreAccountQueueSnapshot(String(user?._id || ''));
    restorePendingAccountQueueIds(String(user?._id || ''));
    await reconcilePlaybackLibrary(previousPlayback);
    state.seekSeconds = Math.max(1, Number(user.settings?.seekSeconds) || 5);
    state.maxVolume = Math.min(10, Math.max(1, Number(user.settings?.maxVolume) / 100 || 2));
    state.offlineEnabled = localStorage.getItem(`amgc-offline-enabled-${user._id}`) === 'true';
    updateOfflineStatus(state.offlineEnabled
      ? 'Modo offline activado. Tus canciones descargadas están disponibles.'
      : 'Descargas offline desactivadas.');
    try {
      await hydrateCurrentOfflineImages();
    } catch (error) {
      console.warn('No se pudieron preparar las imágenes guardadas.', error);
    }
    elements.playerVolume.max = String(state.maxVolume);
    setPlayerVolume(state.volume);
    localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user));
    connectRealtime();
    updateNavigationState();
    renderCurrentView();
    updatePlayerUI();
    void restoreLastPlayback().catch(error => {
      console.error('No se pudo restaurar la última reproducción.', error);
    });
    void Promise.all([
      saveOfflineLibrary(user._id, state.songs),
      saveOfflinePlaylists(user._id, state.playlists)
    ]).then(() => {
      if (navigator.onLine) void syncPendingPlaylistAdds();
      if (state.offlineEnabled && navigator.onLine) void downloadOfflineLibrary();
    }).catch(error => console.warn('No se pudo guardar la biblioteca para uso offline.', error));
    void loadSecondaryLibraryData();
    void loadFriends();
    void loadUnreadMessages();
    void loadSpotifyStatus();
  } catch (error) {
    if (requestSequence !== libraryRequestSequence || (userId && String(state.user?._id || '') !== userId)) return;
    console.error('No se pudo cargar la biblioteca móvil.', error);
    if (state.user?._id) {
      try {
        const [offlineLibrary, offlinePlaylists, offlineFriends] = await Promise.all([
          getOfflineLibrary(state.user._id),
          getOfflinePlaylists(state.user._id),
          getOfflineFriends(state.user._id)
        ]);
        if (Array.isArray(offlineLibrary?.songs) || Array.isArray(offlinePlaylists?.playlists)) {
          if (Array.isArray(offlineLibrary?.songs)) state.songs = offlineLibrary.songs;
          state.playlists = offlinePlaylists?.playlists || [];
          state.friends = offlineFriends?.friends || [];
          restorePendingAccountQueueIds(String(state.user._id));
          await reconcilePlaybackLibrary(previousPlayback);
          state.offlineEnabled = localStorage.getItem(`amgc-offline-enabled-${state.user._id}`) === 'true';
          await hydrateCurrentOfflineImages();
          state.catalogLoading = false;
          state.catalogLoadError = Array.isArray(offlineLibrary?.songs)
            ? 'Sin conexión: mostrando el catálogo guardado.'
            : 'No hay un catálogo guardado en este dispositivo.';
          updateNavigationState();
          renderCurrentView();
          updatePlayerUI();
          void refreshOfflineAudioAvailability();
          await restoreLastPlayback();
          updateOfflineStatus('Sin conexión: biblioteca local cargada.');
          return;
        }
      } catch (offlineError) {
        console.error('No se pudo abrir la biblioteca offline.', offlineError);
      }
    }
    state.catalogLoading = false;
    state.catalogLoadError = error.message || 'No se pudo cargar el catálogo. Comprueba la conexión e inténtalo de nuevo.';
    if (state.currentTab === 'songs' && !state.currentPlaylistId) renderCurrentView();
    showToast(error.message || 'No se pudo cargar la biblioteca.', true);
  }
}

async function loadSecondaryLibraryData() {
  const [suggestions, phrases] = await Promise.allSettled([
    request('/song-suggestions'),
    request('/secret-phrases')
  ]);
  if (suggestions.status === 'fulfilled') {
    state.suggestions = Array.isArray(suggestions.value) ? suggestions.value : [];
  } else {
    console.warn('No se pudieron cargar las sugerencias móviles.', suggestions.reason);
  }
  if (phrases.status === 'fulfilled') {
    state.secretPhrases = Array.isArray(phrases.value?.phrases) ? phrases.value.phrases : [];
    state.secretPhrasesPersonal = phrases.value?.personal === true;
    state.previousSecretPhrase = '';
    showRandomSecretPhrase();
  } else {
    console.warn('No se pudieron cargar las frases móviles.', phrases.reason);
  }
  if (state.currentTab === 'settings') renderCurrentView();
}

async function restoreCachedLibrary(userId) {
  const revision = libraryRevision;
  try {
    const [offlineLibrary, offlinePlaylists, offlineFriends] = await Promise.all([
      getOfflineLibrary(userId),
      getOfflinePlaylists(userId),
      getOfflineFriends(userId)
    ]);
    if (
      revision !== libraryRevision
      || String(state.user?._id || '') !== String(userId)
      || (!offlineLibrary?.songs && !offlinePlaylists?.playlists)
    ) return;
    state.songs = offlineLibrary?.songs || [];
    state.playlists = offlinePlaylists?.playlists || [];
    state.friends = offlineFriends?.friends || [];
    state.offlineEnabled = localStorage.getItem(`amgc-offline-enabled-${userId}`) === 'true';
    await hydrateCurrentOfflineImages();
    if (
      revision !== libraryRevision
      || String(state.user?._id || '') !== String(userId)
    ) return;
    updateNavigationState();
    renderDrawerFriends();
    renderCurrentView();
    updatePlayerUI();
    void refreshOfflineAudioAvailability();
    await restoreLastPlayback();
  } catch (error) {
    console.warn('No se pudo restaurar la biblioteca móvil guardada.', error);
  }
}

async function login(username, password) {
  const result = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  if (!result?.token) throw new Error('El servidor no devolvió una sesión válida.');
  state.token = result.token;
  let user;
  try {
    user = await request('/auth/me');
    if (!user?._id || (result._id && String(user._id) !== String(result._id))) {
      throw new Error('El servidor no pudo validar la sesión iniciada.');
    }
  } catch (error) {
    state.token = '';
    state.user = null;
    localStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem(STORAGE_KEYS.user);
    throw error;
  }
  state.user = user;
  localStorage.setItem(STORAGE_KEYS.token, state.token);
  localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user));
  elements.loginScreen.hidden = true;
  elements.appShell.hidden = false;
  await loadLibrary(user);
}

function logout(showMessage) {
  void closePlaybackNotification();
  if (pendingPlaybackTakeoverRetryTimer) window.clearTimeout(pendingPlaybackTakeoverRetryTimer);
  if (accountQueueRetryTimer) window.clearTimeout(accountQueueRetryTimer);
  pendingPlaybackTakeoverRetryTimer = null;
  pendingPlaybackTakeoverRetryDelay = 30000;
  pendingPlaybackTakeoverLastNotifiedSongId = '';
  accountQueueRetryTimer = null;
  accountQueueRetryDelay = 15000;
  accountQueueLastNotifiedSignature = '';
  trackLoadSequence += 1;
  leaveSharedQueue();
  window.clearTimeout(realtimeLibraryRefreshTimer);
  window.clearInterval(realtimeFriendsRefreshTimer);
  realtimeLibraryRefreshTimer = null;
  realtimeFriendsRefreshTimer = null;
  state.socket?.disconnect();
  state.socket = null;
  state.remotePlayback = null;
  state.ownPlayback = null;
  state.playbackOwnerConfirmed = false;
  state.accountQueueIds = [];
  state.accountQueueSourceIds = [];
  state.accountQueueName = 'GENERAL';
  state.accountQueueSnapshotCached = false;
  state.accountQueuePendingIds = null;
  state.accountQueueRevision = 0;
  state.accountQueueSnapshotSignature = null;
  state.accountQueueDeviceId = null;
  state.accountQueueSyncInFlight = false;
  if (sharedPlaybackClockTimer) clearInterval(sharedPlaybackClockTimer);
  sharedPlaybackClockTimer = null;
  suppressRemotePlaybackPause = false;
  realtimeBaseUrl = '';
  playlistSaversCache.clear();
  friendRealtimeUpdates.clear();
  friendsRequestSequence += 1;
  libraryRequestSequence += 1;
  offlineMediaUrls.forEach(url => URL.revokeObjectURL(url));
  offlineMediaUrls.clear();
  offlineImageUrlsById.clear();
  deferredNativeImages.clear();
  clearInterval(state.chatPollTimer);
  state.chatPollTimer = null;
  state.followingUserId = null;
  state.activeChatFriend = null;
  state.token = '';
  state.user = null;
  state.songs = [];
  state.playlists = [];
  state.suggestions = [];
  state.spotifyConnected = false;
  state.spotifyConfigured = false;
  state.spotifyTracks = [];
  state.spotifyTracksLoaded = false;
  state.spotifySelectedTrackIds.clear();
  state.spotifyNextOffset = 0;
  state.spotifyTotal = 0;
  state.spotifyHasMore = false;
  state.spotifySearch = '';
  state.spotifySectionOpen = false;
  state.spotifyStatusMessage = 'Consulta la conexión de Spotify.';
  spotifyStatusRequest = null;
  spotifyTracksRequest = null;
  state.unreadMessageCounts.clear();
  state.friends = [];
  state.secretPhrases = [];
  state.secretPhrasesPersonal = false;
  state.previousSecretPhrase = '';
  state.profileUser = null;
  state.profileStats = null;
  state.profilePlaylists = [];
  state.currentPlaylistId = null;
  state.currentTab = 'home';
  state.offlineEnabled = false;
  state.seekSeconds = 5;
  state.maxVolume = 2;
  state.restoredPlaybackForUser = null;
  state.currentTrack = null;
  state.currentQueueKind = 'source';
  state.queueTitle = 'GENERAL';
  state.upcomingQueue = [];
  state.shuffleQueue = [];
  state.playbackHistory = [];
  state.queue = [];
  state.queueIndex = -1;
  state.shuffle = false;
  libraryRevision += 1;
  state.offlineStatus = 'Descargas offline desactivadas.';
  localStorage.removeItem(STORAGE_KEYS.token);
  localStorage.removeItem(STORAGE_KEYS.user);
  currentTrackShouldAutoplay = false;
  elements.audio.pause();
  elements.audio.removeAttribute('src');
  if (activeOfflineAudioUrl) URL.revokeObjectURL(activeOfflineAudioUrl);
  activeOfflineAudioUrl = null;
  elements.appShell.hidden = true;
  elements.loginScreen.hidden = false;
  elements.miniPlayer.hidden = true;
  elements.playerScreen.hidden = true;
  elements.lyricsScreen.hidden = true;
  updateHomeSecretPhrase();
  setDrawerOpen(false);
  if (showMessage) elements.loginError.textContent = 'Sesión cerrada.';
}

function openDialog(section) {
  elements.playlistForm.hidden = section !== elements.playlistForm;
  elements.addSheet.hidden = section !== elements.addSheet;
  elements.shareSheet.hidden = section !== elements.shareSheet;
  elements.membersSheet.hidden = section !== elements.membersSheet;
  elements.suggestionForm.hidden = section !== elements.suggestionForm;
  if (!elements.dialog.open) elements.dialog.showModal();
}

function closeDialog() {
  if (elements.dialog.open) elements.dialog.close();
}

function openPlaylistForm(playlist = null) {
  state.editingPlaylistId = playlist?.id || null;
  elements.playlistForm.reset();
  document.getElementById('playlist-form-error').textContent = '';
  document.getElementById('playlist-form-title').textContent = playlist ? 'Editar playlist' : 'Nueva playlist';
  document.getElementById('playlist-name').value = playlist?.name || '';
  document.getElementById('playlist-description').value = playlist?.desc || '';
  const spotifyImport = document.getElementById('spotify-playlist-import');
  if (spotifyImport) spotifyImport.hidden = Boolean(playlist?.spotifyPlaylistId);
  const preview = document.getElementById('playlist-photo-preview');
  if (playlistPreviewObjectUrl) {
    URL.revokeObjectURL(playlistPreviewObjectUrl);
    playlistPreviewObjectUrl = null;
  }
  if (playlist?.photo) {
    setImageSource(preview, playlist.photo);
    preview.hidden = false;
  } else {
    preview.removeAttribute('src');
    preview.hidden = true;
  }
  updateSpotifyPlaylistImportForm();
  openDialog(elements.playlistForm);
}

async function savePlaylist(event) {
  event.preventDefault();
  const formError = document.getElementById('playlist-form-error');
  const submitButton = elements.playlistForm.querySelector('button[type="submit"]');
  formError.textContent = '';
  const name = document.getElementById('playlist-name').value.trim();
  if (!name) {
    formError.textContent = 'Escribe un nombre para la playlist.';
    return;
  }
  submitButton.disabled = true;
  const playlist = state.playlists.find(item => String(item.id) === String(state.editingPlaylistId));
  const data = new FormData();
  data.append('id', state.editingPlaylistId || generatePlaylistId());
  data.append('name', name);
  data.append('desc', document.getElementById('playlist-description').value.trim());
  data.append('userId', state.user?._id || '');
  const trackIds = (playlist?.tracks || []).map(getSongId);
  const pendingSongId = state.pendingSongId ? String(state.pendingSongId) : '';
  if (pendingSongId && !trackIds.includes(pendingSongId)) trackIds.push(pendingSongId);
  data.append('tracks', JSON.stringify(trackIds));
  if (playlist?.photo) data.append('existingPhoto', playlist.photo);
  const photo = document.getElementById('playlist-photo').files?.[0];
  if (photo) data.append('photo', photo);
  try {
    const savedPlaylist = await request('/playlists', { method: 'POST', body: data });
    closeDialog();
    await loadLibrary();
    if (pendingSongId && savedPlaylist?.id) {
      state.pendingSongId = null;
      state.selectedSongId = null;
      showToast('Playlist creada y canción agregada.');
    } else {
      state.pendingSongId = null;
      showToast(playlist ? 'Playlist actualizada.' : 'Playlist creada.');
    }
  } catch (error) {
    state.pendingSongId = null;
    if (elements.dialog.open) formError.textContent = error.message || 'No se pudo guardar la playlist.';
    else showToast(error.message || 'No se pudo completar la operación.', true);
  } finally {
    submitButton.disabled = false;
  }
}

function openAddToPlaylist(songId, playlistId = null) {
  state.selectedSongId = songId;
  const options = document.getElementById('add-to-playlist-options');
  options.replaceChildren();
  const heading = elements.addSheet.querySelector('.sheet-heading h2');
  const kicker = elements.addSheet.querySelector('.sheet-heading .eyebrow');
  const createButton = document.getElementById('create-playlist-from-picker');
  if (!songId && playlistId) {
    const playlist = state.playlists.find(item => String(item.id) === String(playlistId));
    heading.textContent = 'Agregar canciones';
    kicker.textContent = playlist?.name || 'PLAYLIST';
    createButton.hidden = true;
    const existingIds = new Set((playlist?.tracks || []).map(getSongId));
    const availableSongs = state.songs.filter(song => !existingIds.has(getSongId(song)));
    if (!availableSongs.length) {
      options.append(makeElement('div', 'empty-state', 'Todas las canciones ya están en esta playlist.'));
    } else {
      availableSongs.forEach(song => {
        const button = makeButton('sheet-option', `Agregar ${song.name}`, () => {
          closeDialog();
          if (playlist) void addSongToPlaylist(playlist, getSongId(song));
        });
        button.append(imageElement(getSongCover(song), '', ''), makeElement('span', '', `${song.name} · ${song.artist}`));
        options.append(button);
      });
    }
    openDialog(elements.addSheet);
    return;
  }
  heading.textContent = 'Agregar a playlist';
  kicker.textContent = 'GUARDAR CANCIÓN';
  createButton.hidden = false;
  const availablePlaylists = state.playlists.filter(playlist => {
    const canEdit = String(playlist.ownerId || '') === String(state.user?._id || '')
      || (playlist.sharedWith || []).some(member => String(member._id) === String(state.user?._id));
    return canEdit && (!playlistId || String(playlist.id) === String(playlistId));
  });
  if (!availablePlaylists.length) {
    options.append(makeElement('div', 'empty-state', 'No tienes playlists editables. Crea una playlist para guardar canciones.'));
  } else {
    availablePlaylists.forEach(playlist => {
      const button = makeButton('sheet-option', `Agregar a ${playlist.name}`, () => {
        closeDialog();
        if (songId) void addSongToPlaylist(playlist, songId);
        else openPlaylist(playlist.id);
      });
      if (playlist.photo) button.append(imageElement(playlist.photo, '', ''));
      else button.append(makeElement('span', 'playlist-art', '♫'));
      button.append(makeElement('span', '', playlist.name || 'Playlist'));
      options.append(button);
    });
  }
  openDialog(elements.addSheet);
}

async function addSongToPlaylist(playlist, songId) {
  const playlistId = String(playlist?.id || '');
  const normalizedSongId = String(songId || '');
  const currentUser = state.user;
  const targetPlaylist = state.playlists.find(item => String(item.id) === playlistId);
  const song = state.songs.find(item => getSongId(item) === normalizedSongId);
  const pendingKey = `${playlistId}:${normalizedSongId}`;
  if (!playlistId || !normalizedSongId || !targetPlaylist || !song || !currentUser?._id) {
    showToast('No se pudo identificar la canción o playlist.', true);
    return;
  }
  if ((targetPlaylist.tracks || []).some(track => getSongId(track) === normalizedSongId)) {
    showToast('La canción ya está en esta playlist.');
    return;
  }
  if (pendingPlaylistAdds.has(pendingKey)) return;
  pendingPlaylistAdds.add(pendingKey);
  renderDrawerPlaylists();
  const songDuration = Math.max(0, Number(song.duration) || 0);
  const optimisticTrack = {
    ...song,
    syncPending: true,
    addedBy: { _id: currentUser._id, username: currentUser.username },
    addedAt: new Date().toISOString()
  };
  targetPlaylist.duration = (Number(targetPlaylist.duration)
    || (targetPlaylist.tracks || []).reduce((total, track) => total + (Number(track.duration) || 0), 0))
    + songDuration;
  targetPlaylist.updatedAt = optimisticTrack.addedAt;
  targetPlaylist.tracks = [...(targetPlaylist.tracks || []), optimisticTrack];
  if (state.currentPlaylistId === playlistId) renderCurrentView();
  void saveOfflinePlaylists(currentUser._id, state.playlists).catch(error => {
    console.error('No se pudo guardar la playlist optimista en la caché offline.', error);
  });
  showToast(`Agregada localmente; sincronizando “${song.name}”…`);
  try {
    const result = await request(`/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ userId: currentUser._id, songId: normalizedSongId })
    });
    const updatedPlaylist = state.playlists.find(item => String(item.id) === playlistId);
    if (updatedPlaylist && Number.isFinite(Number(result?.duration))) {
      updatedPlaylist.duration = Math.max(
        Number(updatedPlaylist.duration) || 0,
        Number(result.duration)
      );
    }
    const confirmedTrack = updatedPlaylist?.tracks.find(track => getSongId(track) === normalizedSongId);
    if (confirmedTrack) delete confirmedTrack.syncPending;
    void saveOfflinePlaylists(currentUser._id, state.playlists).catch(error => {
      console.error('No se pudo actualizar la caché offline de playlists.', error);
    });
    if (state.currentPlaylistId === playlistId) renderCurrentView();
    renderDrawerPlaylists();
    showToast(`“${song.name}” se agregó a “${targetPlaylist.name}”.`);
  } catch (error) {
    const updatedPlaylist = state.playlists.find(item => String(item.id) === playlistId);
    const alreadyAdded = /ya está en la playlist/i.test(error.message || '');
    const shouldQueueForReconnect = !alreadyAdded && (
      !navigator.onLine || /no se pudo conectar con el servidor amgc/i.test(error.message || '')
    );
    if (updatedPlaylist && shouldQueueForReconnect) {
      optimisticTrack.syncPending = true;
      void saveOfflinePlaylists(currentUser._id, state.playlists).catch(saveError => {
        console.error('No se pudo guardar la canción pendiente de sincronización.', saveError);
      });
      showToast(`“${song.name}” quedó guardada localmente y se sincronizará al reconectar.`);
    } else if (updatedPlaylist && !alreadyAdded) {
      const hadOptimisticTrack = (updatedPlaylist.tracks || []).includes(optimisticTrack);
      const hasConfirmedTrack = (updatedPlaylist.tracks || []).some(track => (
        getSongId(track) === normalizedSongId && track !== optimisticTrack
      ));
      if (hadOptimisticTrack && !hasConfirmedTrack) {
        updatedPlaylist.tracks = updatedPlaylist.tracks.filter(track => track !== optimisticTrack);
        updatedPlaylist.duration = Math.max(0, (Number(updatedPlaylist.duration) || 0) - songDuration);
      }
    }
    if (alreadyAdded) {
      delete optimisticTrack.syncPending;
      void loadLibrary();
      showToast('La canción ya estaba en esta playlist.');
    } else if (!shouldQueueForReconnect) {
      showToast(error.message || 'No se pudo agregar la canción.', true);
    }
    if (state.currentPlaylistId === playlistId) renderCurrentView();
    renderDrawerPlaylists();
    void saveOfflinePlaylists(currentUser._id, state.playlists).catch(saveError => {
      console.error('No se pudo actualizar la caché local de playlists.', saveError);
    });
  } finally {
    pendingPlaylistAdds.delete(pendingKey);
    renderDrawerPlaylists();
    if (state.currentPlaylistId === playlistId) renderCurrentView();
  }
}

async function syncPendingPlaylistAdds() {
  if (!navigator.onLine || !state.token || !state.user?._id) return;
  const userId = String(state.user._id);
  const token = state.token;
  const playlistsForSync = state.playlists;
  const isCurrentSync = () => (
    String(state.user?._id || '') === userId
    && state.token === token
    && state.playlists === playlistsForSync
  );
  for (const playlist of playlistsForSync) {
    if (!isCurrentSync()) return;
    for (const track of playlist.tracks || []) {
      if (!track.syncPending) continue;
      const playlistId = String(playlist.id);
      const songId = getSongId(track);
      const pendingKey = `${playlistId}:${songId}`;
      if (pendingPlaylistAdds.has(pendingKey)) continue;
      pendingPlaylistAdds.add(pendingKey);
      try {
        const result = await request(`/playlists/${encodeURIComponent(playlistId)}/tracks`, {
          method: 'POST',
          body: JSON.stringify({ userId, songId })
        });
        if (!isCurrentSync()) return;
        if (Number.isFinite(Number(result?.duration))) playlist.duration = Number(result.duration);
        delete track.syncPending;
      } catch (error) {
        if (!isCurrentSync()) return;
        const status = Number(error?.status);
        if (/ya está en la playlist/i.test(error?.message || '')) {
          delete track.syncPending;
        } else if (status >= 400 && status < 500 && ![408, 429].includes(status)) {
          const trackIndex = (playlist.tracks || []).indexOf(track);
          if (trackIndex >= 0) {
            playlist.tracks.splice(trackIndex, 1);
            playlist.duration = Math.max(0, (Number(playlist.duration) || 0) - (Number(track.duration) || 0));
          }
          delete track.syncPending;
          showToast(`No se pudo sincronizar “${track.name || 'la canción'}” en “${playlist.name}”.`, true);
        } else {
          console.warn(`No se pudo sincronizar la canción pendiente de "${playlist.name}".`, error);
        }
      } finally {
        pendingPlaylistAdds.delete(pendingKey);
        renderDrawerPlaylists();
      }
    }
  }
  if (!isCurrentSync()) return;
  await saveOfflinePlaylists(userId, playlistsForSync);
  if (state.currentPlaylistId) renderCurrentView();
}

function openSharePlaylistSheet(playlist) {
  const options = document.getElementById('share-playlist-options');
  options.replaceChildren();
  const eligibleFriends = state.friends.filter(friend =>
    !(playlist.sharedWith || []).some(member => String(member?._id || member) === String(friend._id))
    && String(playlist.ownerId) !== String(friend._id)
  );
  if (!eligibleFriends.length) {
    options.append(makeElement('div', 'empty-state', 'No hay amigos disponibles para invitar.'));
  } else {
    eligibleFriends.forEach(friend => {
      const option = makeButton('sheet-option', `Invitar a ${friend.username}`, async () => {
        option.disabled = true;
        try {
          await request(`/playlists/${encodeURIComponent(playlist.id)}/share`, {
            method: 'POST',
            body: JSON.stringify({ fromUserId: state.user?._id, friendId: friend._id })
          });
          closeDialog();
          showToast(`Invitación enviada a ${friend.username}.`);
        } catch (error) {
          option.disabled = false;
          showToast(error.message || 'No se pudo compartir la playlist.', true);
        }
      });
      option.append(
        imageElement(getUserPhoto(friend) || './img/perrocorasongif.gif', '', ''),
        makeElement('span', '', friend.username || 'Usuario')
      );
      options.append(option);
    });
  }
  openDialog(elements.shareSheet);
}

function openPlaylistMembersSheet(playlist) {
  elements.membersSheet.querySelector('.sheet-heading .eyebrow').textContent = 'PLAYLIST';
  elements.membersSheet.querySelector('.sheet-heading h2').textContent = 'Integrantes';
  const options = document.getElementById('playlist-members-options');
  options.replaceChildren();
  const members = Array.isArray(playlist.sharedWith) ? playlist.sharedWith : [];
  if (!members.length) {
    options.append(makeElement('div', 'empty-state', 'No hay integrantes unidos.'));
  } else {
    members.forEach(member => {
      const userId = String(member?._id || member);
      const option = makeElement('div', 'sheet-option playlist-member-option');
      option.append(
        imageElement(getUserPhoto(member) || './img/perrocorasongif.gif', '', ''),
        makeElement('span', '', member?.username || 'Usuario'),
        makeButton('member-remove-button', `Quitar a ${member?.username || 'este usuario'}`, async () => {
          const removeButton = option.querySelector('.member-remove-button');
          removeButton.disabled = true;
          try {
            await request(`/playlists/${encodeURIComponent(playlist.id)}/members/remove`, {
              method: 'POST',
              body: JSON.stringify({ userId: state.user?._id, memberId: userId })
            });
            closeDialog();
            await loadLibrary();
            if (state.currentPlaylistId) renderPlaylistDetail();
            showToast(`${member?.username || 'El integrante'} ya no pertenece a la playlist.`);
          } catch (error) {
            removeButton.disabled = false;
            showToast(error.message || 'No se pudo quitar al integrante.', true);
          }
        }, '×')
      );
      options.append(option);
    });
  }
  openDialog(elements.membersSheet);
}

async function openPlaylistSaversSheet(playlist) {
  elements.membersSheet.querySelector('.sheet-heading .eyebrow').textContent = 'PLAYLIST';
  elements.membersSheet.querySelector('.sheet-heading h2').textContent = 'Personas que la guardaron';
  const options = document.getElementById('playlist-members-options');
  options.replaceChildren(makeElement('p', 'muted', 'Cargando…'));
  openDialog(elements.membersSheet);
  const playlistId = String(playlist.id);
  const renderSavers = users => {
    options.replaceChildren();
    if (!users.length) {
      options.append(makeElement('div', 'empty-state', 'Nadie la ha guardado todavía.'));
      return;
    }
    users.forEach(user => {
      const option = makeElement('div', 'sheet-option');
      option.append(
        imageElement(getUserPhoto(user) || './img/perrocorasongif.gif', '', ''),
        makeProfileUserLink(user)
      );
      options.append(option);
    });
  };
  let cachedSavers = playlistSaversCache.get(playlistId) || null;
  try {
    if (!cachedSavers && state.user?._id) {
      try {
        const cached = await getOfflinePlaylistSavers(state.user._id, playlistId);
        if (Array.isArray(cached?.users)) {
          cachedSavers = cached.users;
          playlistSaversCache.set(playlistId, cachedSavers);
          playlist.savedCount = Math.max(0, Number(cached.count) || 0);
        }
      } catch (error) {
        console.warn('No se pudo leer el caché offline de personas que guardaron la playlist.', error);
      }
    }
    if (cachedSavers) {
      try {
        await hydrateCurrentOfflineImages();
      } catch (error) {
        console.warn('No se pudieron preparar las fotos guardadas de personas que guardaron la playlist.', error);
      }
      renderSavers(cachedSavers);
    }
    if (!navigator.onLine) {
      if (!cachedSavers) {
        options.replaceChildren(makeElement('p', 'form-error', 'No hay una lista guardada disponible sin conexión.'));
        showToast('No hay una lista offline de personas que guardaron esta playlist.', true);
      }
      return;
    }
    const result = await request(`/playlists/${encodeURIComponent(playlistId)}/saves`);
    if (!Array.isArray(result?.users) || !Number.isFinite(Number(result.count))) {
      throw new Error('La respuesta de personas que guardaron la playlist no es válida.');
    }
    playlist.savedCount = Number(result.count);
    cachedSavers = result.users;
    playlistSaversCache.set(playlistId, cachedSavers);
    renderSavers(cachedSavers);
    if (state.user?._id) {
      try {
        await saveOfflinePlaylistSavers(state.user._id, playlistId, result);
      } catch (error) {
        console.warn('No se pudo guardar la lista de personas que guardaron para uso offline.', error);
      }
    }
    try {
      await hydrateCurrentOfflineImages();
    } catch (error) {
      console.warn('No se pudieron preparar las fotos de personas que guardaron la playlist.', error);
    }
    if (state.offlineEnabled && navigator.onLine) void downloadOfflineLibrary();
  } catch (error) {
    console.warn('No se pudo actualizar la lista de personas que guardaron la playlist.', error);
    if (cachedSavers) {
      renderSavers(cachedSavers);
    } else {
      options.replaceChildren(makeElement('p', 'form-error', error.message || 'No se pudo cargar quién guardó esta playlist.'));
    }
    showToast(error.message || 'No se pudo cargar quién guardó esta playlist.', true);
  }
}

async function leavePlaylist(playlist) {
  if (!window.confirm(`¿Salir de la playlist “${playlist.name}”?`)) return;
  try {
    await request(`/playlists/${encodeURIComponent(playlist.id)}/members/remove`, {
      method: 'POST',
      body: JSON.stringify({ userId: state.user?._id, memberId: state.user?._id })
    });
    state.currentPlaylistId = null;
    state.currentTab = 'home';
    await loadLibrary();
    showToast('Saliste de la playlist.');
  } catch (error) {
    showToast(error.message || 'No se pudo salir de la playlist.', true);
  }
}

async function removeSongFromPlaylist(playlist, song) {
  if (!window.confirm(`¿Quitar “${song.name}” de “${playlist.name}”?`)) return;
  try {
    await request(`/playlists/${encodeURIComponent(playlist.id)}/tracks/${encodeURIComponent(getSongId(song))}`, {
      method: 'DELETE',
      body: JSON.stringify({ userId: state.user?._id })
    });
    await loadLibrary();
    showToast('Canción quitada de la playlist.');
  } catch (error) {
    showToast(error.message || 'No se pudo quitar la canción.', true);
  }
}

async function deletePlaylist(playlist) {
  if (!window.confirm(`¿Eliminar la playlist “${playlist.name}”?`)) return;
  try {
    await request(`/playlists/${encodeURIComponent(playlist.id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ userId: state.user?._id })
    });
    state.currentPlaylistId = null;
    await loadLibrary();
    showToast('Playlist eliminada.');
  } catch (error) {
    showToast(error.message || 'No se pudo eliminar la playlist.', true);
  }
}

async function savePlaylistToLibrary(playlist, isSaved) {
  try {
    const result = await request(`/playlists/${encodeURIComponent(playlist.id)}/save`, {
      method: isSaved ? 'DELETE' : 'POST',
      body: JSON.stringify({ userId: state.user?._id })
    });
    if (Array.isArray(result?.savedPlaylists) && state.user) {
      state.user.savedPlaylists = result.savedPlaylists;
    }
    await loadLibrary();
    showToast(isSaved ? 'Playlist quitada de guardadas.' : 'Playlist guardada.');
  } catch (error) {
    showToast(error.message || 'No se pudo actualizar la playlist guardada.', true);
  }
}

async function submitSongSuggestion(event) {
  event.preventDefault();
  const formError = document.getElementById('suggestion-error');
  const submitButton = elements.suggestionForm.querySelector('button[type="submit"]');
  const formData = new FormData(elements.suggestionForm);
  const name = String(formData.get('name') || '').trim();
  const artist = String(formData.get('artist') || '').trim();
  formError.textContent = '';
  if (!name || !artist) {
    formError.textContent = 'Completa el nombre de la canción y el artista.';
    return;
  }
  submitButton.disabled = true;
  try {
    await request('/song-suggestions', {
      method: 'POST',
      body: JSON.stringify({ name, artist })
    });
    elements.suggestionForm.reset();
    closeDialog();
    await loadLibrary();
    showToast('Sugerencia agregada al catálogo.');
  } catch (error) {
    formError.textContent = error.message || 'No se pudo enviar la sugerencia.';
  } finally {
    submitButton.disabled = false;
  }
}

document.querySelectorAll('[data-tab]').forEach(button => {
  button.addEventListener('click', event => {
    event.preventDefault();
    if (button.dataset.tab) setTab(button.dataset.tab);
  });
});
document.getElementById('nav-toggle').addEventListener('click', () => setDrawerOpen(true));
document.getElementById('nav-close').addEventListener('click', () => setDrawerOpen(false));
document.getElementById('drawer-scrim').addEventListener('click', () => setDrawerOpen(false));
document.getElementById('drawer-create-playlist').addEventListener('click', () => {
  setDrawerOpen(false);
  openPlaylistForm();
});
document.getElementById('player-back-button').addEventListener('click', closePlayerScreen);
document.getElementById('player-lyrics-button').addEventListener('click', () => {
  renderLyrics();
  elements.lyricsScreen.hidden = false;
  syncMiniPlayerVisibility();
});
document.getElementById('lyrics-back-button').addEventListener('click', closeLyricsScreen);
document.getElementById('mini-track-button').addEventListener('click', openPlayerScreen);
elements.miniPlaybackDeviceTrigger.addEventListener('click', event => {
  event.stopPropagation();
  openPlayerScreen();
  setPlaybackDevicePickerOpen(true);
});
document.getElementById('player-toggle').addEventListener('click', togglePlayback);
document.getElementById('mini-toggle').addEventListener('click', togglePlayback);
elements.requestJamButton.addEventListener('click', requestJam);
elements.acceptJamRequest.addEventListener('click', () => respondToJamRequest(true));
elements.declineJamRequest.addEventListener('click', () => respondToJamRequest(false));
elements.playbackDevicePickerTrigger.addEventListener('click', event => {
  event.stopPropagation();
  setPlaybackDevicePickerOpen(elements.playbackDevicePicker.hidden);
});
elements.playbackDevicePicker.addEventListener('click', event => event.stopPropagation());
document.addEventListener('click', () => setPlaybackDevicePickerOpen(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') setPlaybackDevicePickerOpen(false);
});
updatePlaybackDevicePickerIcons();
renderPlaybackDevicePicker();
document.getElementById('player-next').addEventListener('click', () => playNext(1));
document.getElementById('player-previous').addEventListener('click', () => playNext(-1));
elements.miniNext.addEventListener('click', () => playNext(1));
elements.miniPrevious.addEventListener('click', () => playNext(-1));
document.getElementById('player-shuffle').addEventListener('click', () => {
  toggleShuffle();
});
document.getElementById('player-queue-shuffle').addEventListener('click', () => {
  toggleShuffle();
});
function setQueueOpen(open) {
  elements.playerQueue.classList.toggle('open', open);
  elements.playerQueue.setAttribute('aria-hidden', String(!open));
  elements.queueScrim.hidden = !open;
  queueOpenButtons.forEach(button => button.setAttribute('aria-expanded', String(open)));
  updateOverlayScrollLock();
}
const queueOpenButtons = [
  document.getElementById('queue-open-button'),
  document.getElementById('player-queue-open-button')
];
function openPlayerScreen() {
  elements.playerScreen.classList.remove('closing');
  elements.playerScreen.hidden = false;
  syncMiniPlayerVisibility();
}
function closePlayerScreen() {
  if (elements.playerScreen.hidden) return;
  elements.playerScreen.classList.add('closing');
  window.setTimeout(() => {
    elements.playerScreen.hidden = true;
    elements.playerScreen.classList.remove('closing');
    syncMiniPlayerVisibility();
  }, 280);
}
function closeLyricsScreen() {
  elements.lyricsScreen.hidden = true;
  syncMiniPlayerVisibility();
}
queueOpenButtons.forEach(button => button.addEventListener('click', () => {
  const open = !elements.playerQueue.classList.contains('open');
  setQueueOpen(open);
}));
document.getElementById('player-queue-close').addEventListener('click', () => {
  setQueueOpen(false);
});
elements.queueScrim.addEventListener('click', () => {
  setQueueOpen(false);
});
const volumePercentInput = document.getElementById('player-volume-label');
const savedPlayerVolume = Number(localStorage.getItem('amgc-mobile-volume'));
state.volume = Number.isFinite(savedPlayerVolume) ? Math.min(10, Math.max(0, savedPlayerVolume)) : 1;
elements.playerVolume.value = String(state.volume);
elements.playerVolume.max = '10';
elements.audio.volume = Math.min(state.volume, 1);
volumePercentInput.value = String(Number((state.volume * 100).toFixed(2)));
elements.playerVolume.addEventListener('input', event => {
  setPlayerVolume(event.currentTarget.value);
});
const commitVolumePercent = () => {
  const value = volumePercentInput.value.trim().replace(',', '.');
  if (!value) {
    setPlayerVolume(state.volume);
    return;
  }
  const volumePercent = Number(value);
  if (!Number.isFinite(volumePercent) || volumePercent < 0) {
    setPlayerVolume(state.volume);
    showToast('Ingresa un porcentaje de volumen válido.', true);
    return;
  }
  setPlayerVolume(volumePercent / 100);
};
volumePercentInput.addEventListener('change', commitVolumePercent);
volumePercentInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    commitVolumePercent();
    volumePercentInput.blur();
  }
});
document.getElementById('player-seek-backward').addEventListener('click', () => {
  seekBySeconds(-state.seekSeconds);
});
document.getElementById('player-seek-forward').addEventListener('click', () => {
  seekBySeconds(state.seekSeconds);
});
document.getElementById('mini-seek-backward').addEventListener('click', () => seekBySeconds(-state.seekSeconds));
document.getElementById('mini-seek-forward').addEventListener('click', () => seekBySeconds(state.seekSeconds));
document.getElementById('drawer-profile-open').addEventListener('click', openProfile);
document.getElementById('player-add-button').addEventListener('click', () => {
  const song = getCurrentSong();
  if (song) openAddToPlaylist(getSongId(song));
});
document.getElementById('create-playlist-from-picker').addEventListener('click', () => {
  state.pendingSongId = state.selectedSongId;
  closeDialog();
  openPlaylistForm();
});
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', closeDialog));
elements.dialog.addEventListener('click', event => {
  if (event.target === elements.dialog) closeDialog();
});
elements.playlistForm.addEventListener('submit', event => void savePlaylist(event));
document.getElementById('spotify-playlist-connect-button').addEventListener('click', event => {
  void connectSpotify(event.currentTarget);
});
document.getElementById('spotify-playlist-load-button').addEventListener('click', () => {
  void loadSpotifyPlaylists();
});
document.getElementById('spotify-playlist-more-button').addEventListener('click', () => {
  void loadSpotifyPlaylists({ append: true });
});
elements.suggestionForm.addEventListener('submit', event => void submitSongSuggestion(event));
document.getElementById('playlist-photo').addEventListener('change', event => {
  const file = event.target.files?.[0];
  const preview = document.getElementById('playlist-photo-preview');
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    event.target.value = '';
    showToast('Selecciona un archivo de imagen.', true);
    return;
  }
  if (playlistPreviewObjectUrl) URL.revokeObjectURL(playlistPreviewObjectUrl);
  playlistPreviewObjectUrl = URL.createObjectURL(file);
  preview.src = playlistPreviewObjectUrl;
  preview.hidden = false;
});
document.getElementById('player-progress').addEventListener('input', event => {
  const remotePlayback = getRemotePlaybackSession();
  if (remotePlayback) {
    const duration = Number(remotePlayback.duration);
    if (Number.isFinite(duration) && duration > 0) {
      queueRemoteSeek(Number(event.target.value) / 1000 * duration);
    }
    return;
  }
  if (isRemotePlaybackLocked() || !Number.isFinite(elements.audio.duration)) return;
  elements.audio.currentTime = Number(event.target.value) / 1000 * elements.audio.duration;
});
function seekMiniProgress(clientX) {
  const remotePlayback = getRemotePlaybackSession();
  const duration = remotePlayback ? Number(remotePlayback.duration) : elements.audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const bounds = elements.miniProgress.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
  if (remotePlayback) queueRemoteSeek(ratio * duration);
  else if (!isRemotePlaybackLocked()) elements.audio.currentTime = ratio * duration;
}
elements.miniProgress.addEventListener('pointerdown', event => {
  const remotePlayback = getRemotePlaybackSession();
  const duration = remotePlayback ? Number(remotePlayback.duration) : elements.audio.duration;
  if ((!remotePlayback && isRemotePlaybackLocked()) || event.button !== 0
    || !Number.isFinite(duration) || duration <= 0) return;
  event.preventDefault();
  elements.miniProgress.setPointerCapture(event.pointerId);
  seekMiniProgress(event.clientX);
});
elements.miniProgress.addEventListener('pointermove', event => {
  if (elements.miniProgress.hasPointerCapture(event.pointerId)) seekMiniProgress(event.clientX);
});
elements.miniProgress.addEventListener('keydown', event => {
  const remotePlayback = getRemotePlaybackSession();
  if (!remotePlayback && isRemotePlaybackLocked()) return;
  const duration = remotePlayback ? Number(remotePlayback.duration) : elements.audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const currentTime = remotePlayback ? getRemoteSeekPosition(remotePlayback) : elements.audio.currentTime;
  let targetTime;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
    targetTime = Math.max(0, currentTime - state.seekSeconds);
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
    targetTime = Math.min(duration, currentTime + state.seekSeconds);
  } else if (event.key === 'Home') {
    targetTime = 0;
  } else if (event.key === 'End') {
    targetTime = duration;
  } else {
    return;
  }
  event.preventDefault();
  if (remotePlayback) queueRemoteSeek(targetTime);
  else elements.audio.currentTime = targetTime;
});
elements.audio.addEventListener('loadstart', () => {
  const song = getCurrentSong();
  if (!song) return;
  state.loadingTrackId = getSongId(song);
  updateSongLoadingIndicators();
});
elements.audio.addEventListener('waiting', () => {
  const song = getCurrentSong();
  if (!song) return;
  state.loadingTrackId = getSongId(song);
  updateSongLoadingIndicators();
});
for (const eventName of ['canplay', 'playing', 'error']) {
  elements.audio.addEventListener(eventName, () => {
    state.loadingTrackId = '';
    updateSongLoadingIndicators();
  });
}
elements.audio.addEventListener('timeupdate', () => {
  if (getRemotePlaybackSession()) {
    updatePlayerUI();
    return;
  }
  const current = elements.audio.currentTime;
  const duration = elements.audio.duration;
  document.getElementById('player-current-time').textContent = formatTime(current);
  document.getElementById('player-progress').value = duration ? String(Math.round(current / duration * 1000)) : '0';
  updateMiniProgress(current, duration);
  if (isAndroidNative) void updatePlaybackNotification();
  persistLastPlayback(current);
  const song = getCurrentSong();
  if (!elements.lyricsScreen.hidden && elements.lyricsLines.dataset.songId !== String(getSongId(song) || '')) {
    renderLyrics();
  } else {
    updateLyrics();
  }
  syncPlaybackStatus();
});
elements.audio.addEventListener('loadedmetadata', updatePlayerUI);
elements.audio.addEventListener('play', updatePlayerUI);
elements.audio.addEventListener('play', () => {
  if (getRemotePlaybackSession()) {
    pauseForRemotePlayback();
    return;
  }
  if (!currentTrackShouldAutoplay) {
    elements.audio.pause();
    return;
  }
  state.remotePlayback = null;
  if (sharedPlaybackClockTimer) clearInterval(sharedPlaybackClockTimer);
  sharedPlaybackClockTimer = null;
  resetHomeSpin();
  if (state.followingUserId) state.followNeedsUserGesture = false;
  syncPlaybackStatus(true);
  if (state.currentTab === 'home') updateHomeLyrics();
  if (state.currentTab === 'profile') renderProfile();
});
elements.audio.addEventListener('pause', () => {
  if (suppressRemotePlaybackPause) {
    suppressRemotePlaybackPause = false;
    stopHomeSpin();
    updatePlayerUI();
    if (state.currentTab === 'home') updateHomeLyrics();
    return;
  }
  if (getRemotePlaybackSession()) {
    updatePlayerUI();
    return;
  }
  stopHomeSpin();
  persistLastPlayback(elements.audio.currentTime);
  updatePlayerUI();
  syncPlaybackStatus(true);
  if (state.currentTab === 'home') updateHomeLyrics();
  if (state.currentTab === 'profile') renderProfile();
});
elements.audio.addEventListener('ended', () => {
  const loadSequence = trackLoadSequence;
  if (!elements.audio.ended || handledEndedTrackSequence === loadSequence) return;
  handledEndedTrackSequence = loadSequence;
  currentTrackShouldAutoplay = false;
  playNext(1);
});
elements.audio.addEventListener('error', () => {
  if (!state.queue.length) return;
  if (isActivatingPlaybackTransfer) return;
  const errorCode = elements.audio.error?.code;
  const song = getCurrentSong();
  if (
    song
    && currentTrackShouldAutoplay
    && [2, 4].includes(errorCode)
    && activeTrackUsingOfflineCache
    && !activeTrackFallbackState.cache
  ) {
    activeTrackFallbackState.cache = true;
    void loadTrack(song, {
      autoplay: true,
      bypassOfflineCache: true,
      fallbackState: activeTrackFallbackState
    });
    return;
  }
  if (
    song
    && currentTrackShouldAutoplay
    && [2, 4].includes(errorCode)
    && !activeTrackUsingOfflineCache
    && !activeTrackFallbackState.nativeDrive
    && getDriveFileId(resolveMediaUrl(song.path || song.audioUrl || ''))
  ) {
    const loadSequence = trackLoadSequence;
    activeTrackFallbackState.nativeDrive = true;
    void recoverDriveAudioLocally(song, {
      loadSequence,
      autoplay: true,
      sync: false,
      restoreTime: Number(elements.audio.currentTime) || 0,
      showError: true,
      awaitPlaybackStart: false,
      fallbackState: activeTrackFallbackState
    }).catch(error => {
      console.warn('Falló la recuperación local del audio de Drive.', error);
      if (loadSequence === trackLoadSequence) {
        showToast(error.message || getAudioErrorMessage(), true);
      }
    });
    return;
  }
  if (!currentTrackShouldAutoplay) {
    console.warn('Falló la carga de audio móvil en una reproducción pausada.', {
      source: elements.audio.currentSrc,
      code: errorCode,
      message: elements.audio.error?.message
    });
    return;
  }
  console.error('Falló la carga de audio móvil.', {
    source: elements.audio.currentSrc,
    code: elements.audio.error?.code,
    message: elements.audio.error?.message
  });
  if (state.followingUserId) stopFollowingFriend();
  showToast(getAudioErrorMessage(), true);
});
if (!isAndroidNative && 'mediaSession' in navigator) {
  for (const [action, handler] of [
    ['play', () => {
      const remotePlayback = getRemotePlaybackSession();
      if (remotePlayback) {
        if (remotePlayback.isPlaying === false) void requestRemotePlaybackControl('toggle');
      }
      else resumeAudioPlayback().catch(error => console.warn('No se pudo reanudar desde el control multimedia.', error));
    }],
    ['pause', () => {
      const remotePlayback = getRemotePlaybackSession();
      if (remotePlayback) {
        if (remotePlayback.isPlaying !== false) void requestRemotePlaybackControl('toggle');
      }
      else {
        currentTrackShouldAutoplay = false;
        elements.audio.pause();
      }
    }],
    ['seekbackward', details => seekBySeconds(-(details.seekOffset || state.seekSeconds))],
    ['seekforward', details => seekBySeconds(details.seekOffset || state.seekSeconds)],
    ['previoustrack', () => playNext(-1)],
    ['nexttrack', () => playNext(1)]
  ]) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (error) {
      console.warn(`El navegador no admite el control multimedia "${action}".`, error);
    }
  }
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'AMGC_PLAYBACK_NOTIFICATION_ACTION') {
      handlePlaybackNotificationAction(event.data.action);
    } else if (event.data?.type === 'AMGC_CHAT_NOTIFICATION_CLICK') {
      const friend = state.friends.find(item => String(item._id) === String(event.data.friendId));
      if (friend) openChat(friend);
    }
  });
}
if (isAndroidNative) {
  nativeMedia.addListener('mediaAction', event => {
    handlePlaybackNotificationAction(event.action);
  }).catch(error => {
    console.error('No se pudieron registrar los controles multimedia nativos.', error);
  });
}
elements.loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  elements.loginError.textContent = '';
  const button = elements.loginForm.querySelector('button[type="submit"]');
  const buttonLabel = button.querySelector('.login-submit-text');
  button.disabled = true;
  buttonLabel.textContent = 'Conectando...';
  const form = new FormData(elements.loginForm);
  try {
    await login(String(form.get('username') || '').trim(), String(form.get('password') || ''));
  } catch (error) {
    elements.loginError.textContent = error.message || 'No se pudo iniciar sesión.';
  } finally {
    button.disabled = false;
    buttonLabel.textContent = 'Ingresar';
  }
});
document.getElementById('chat-back').addEventListener('click', closeChat);
document.getElementById('chat-close').addEventListener('click', closeChat);
document.getElementById('chat-annoy').addEventListener('click', () => void annoyActiveChatFriend());
document.getElementById('chat-form').addEventListener('submit', event => void sendChatMessage(event));

async function initialize() {
  if (isAndroidNative) {
    try {
      const permission = await nativeMedia.checkNotificationPermission();
      state.notificationPermissionGranted = permission?.granted === true;
      state.customNotificationEnabled = state.notificationPermissionGranted
        && localStorage.getItem('amgc-mobile-custom-notification') !== 'false';
      if (state.customNotificationEnabled && localStorage.getItem('amgc-mobile-custom-notification') !== 'true') {
        localStorage.setItem('amgc-mobile-custom-notification', 'true');
      }
      if (!state.customNotificationEnabled) await closePlaybackNotification();
    } catch (error) {
      state.notificationPermissionGranted = false;
      state.customNotificationEnabled = false;
      console.error('No se pudo consultar el permiso de notificaciones al iniciar AMGC.', error);
    }
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(error => {
      console.error('No se pudo registrar la caché móvil.', error);
    });
  }
  updateNavigationState();
  renderCurrentView();
  updatePlayerUI();
  if (!state.token) return;
  elements.loginScreen.hidden = true;
  elements.appShell.hidden = false;
  try {
    state.user = JSON.parse(localStorage.getItem(STORAGE_KEYS.user) || 'null');
    if (state.user) state.user = { ...state.user, isOnline: false };
  } catch (error) {
    console.error('No se pudo leer el perfil móvil guardado.', error);
  }
  if (state.user?._id) {
    restoreAccountQueueSnapshot(String(state.user._id));
    restorePendingAccountQueueIds(String(state.user._id));
    state.seekSeconds = Math.max(1, Number(state.user.settings?.seekSeconds) || 5);
    state.maxVolume = Math.min(10, Math.max(1, Number(state.user.settings?.maxVolume) / 100 || 2));
    elements.playerVolume.max = String(state.maxVolume);
    setPlayerVolume(state.volume);
    updateNavigationState();
    renderCurrentView();
    updatePlayerUI();
    void restoreCachedLibrary(String(state.user._id));
  }
  await loadLibrary();
  const query = new URLSearchParams(location.search);
  const spotifyResult = query.get('spotify');
  if (spotifyResult) {
    query.delete('spotify');
    const search = query.toString();
    history.replaceState(null, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
    showToast(spotifyResult === 'connected'
      ? 'Spotify quedó conectado.'
      : 'No se pudo completar la conexión con Spotify.', spotifyResult !== 'connected');
  }
  const chatFriendId = new URLSearchParams(location.search).get('chatFriend');
  if (chatFriendId) {
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
    const friend = state.friends.find(item => String(item._id) === chatFriendId);
    if (friend) openChat(friend);
  }
  const pendingAction = new URLSearchParams(location.search).get('mediaAction');
  if (pendingAction) {
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
    handlePlaybackNotificationAction(pendingAction);
  }
}

resetHomeSpin();
window.addEventListener('offline', () => {
  if (!state.user?._id) return;
  updateOfflineStatus(state.offlineEnabled
    ? 'Sin conexión. Se usarán las canciones, carátulas, playlists y fotos que ya estén guardadas.'
    : 'Sin conexión. Las descargas guardadas siguen disponibles.');
  void restoreCachedLibrary(String(state.user._id));
});
let networkRefreshTimer = null;
window.addEventListener('online', () => {
  deferredNativeImages.forEach(image => {
    if (!image.isConnected) {
      deferredNativeImages.delete(image);
      return;
    }
    enqueueNativeImageDownload(image, image.dataset.nativeDriveImage, true);
  });
  if (!state.token) return;
  window.clearTimeout(networkRefreshTimer);
  networkRefreshTimer = window.setTimeout(() => {
    void loadLibrary().then(() => resumePendingPlaybackTakeover()).then(() => {
      flushPendingAccountQueue();
    });
  }, 400);
});
window.addEventListener('focus', () => {
  if (state.token) void loadSpotifyStatus(state.spotifySectionOpen && !state.spotifyTracksLoaded);
});
void initialize();
