import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import DiscordRPC from 'discord-rpc';

const productionUrl = 'https://mmamgc.onrender.com/';
const developmentUrl = 'http://127.0.0.1:5163/';
const isDevelopment = process.argv.includes('--dev');
const appUrl = isDevelopment ? developmentUrl : productionUrl;
const trustedOrigins = new Set([new URL(productionUrl).origin, new URL(developmentUrl).origin]);
const desktopDownloadKey = randomBytes(32).toString('hex');
let downloaderProcess = null;
let downloaderReadyPromise = null;
let discordRpcClient = null;
let discordRpcClientId = '';
let discordRpcReconnectTimer = null;
let discordRpcReady = false;
let pendingDiscordPresence = null;
let isQuitting = false;
let discordRpcLastError = null;
let discordRpcLastActivityAt = null;
let discordRpcAccessToken = null;
let discordRpcAccessTokenExpiresAt = 0;
let discordMissingClientSecretLogged = false;
let discordLastArtworkStatus = null;
const discordExternalAssetCache = new Map();
const discordExternalAssetRequests = new Map();

function logDiscordRpc(message) {
    const line = `${new Date().toISOString()} ${message}\n`;
    console.info(line.trimEnd());
    appendFile(path.join(app.getPath('userData'), 'discord-rpc.log'), line, error => {
        if (error) console.error('[Discord RPC] No se pudo escribir el registro local.', error);
    });
}

function logDiscordArtworkStatus(status, message) {
    if (discordLastArtworkStatus === status) return;
    discordLastArtworkStatus = status;
    logDiscordRpc(message);
}

function readApplicationConfiguration() {
    const configurationDirectory = app.isPackaged ? app.getPath('userData') : app.getAppPath();
    const configurationPath = path.join(configurationDirectory, '.env');
    try {
        return dotenv.parse(readFileSync(configurationPath));
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

function getDiscordClientSecret() {
    const configuration = readApplicationConfiguration();
    return process.env.DISCORD_CLIENT_SECRET || configuration.DISCORD_CLIENT_SECRET || '';
}

async function getDiscordAppAccessToken() {
    if (discordRpcAccessToken && Date.now() < discordRpcAccessTokenExpiresAt) {
        return discordRpcAccessToken;
    }
    const clientSecret = getDiscordClientSecret();
    if (!clientSecret) return null;

    const credentials = Buffer.from(`${discordRpcClientId}:${clientSecret}`).toString('base64');
    const response = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: {
            Authorization: `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            scope: 'applications.commands.update'
        })
    });
    if (!response.ok) {
        throw new Error(`Discord OAuth respondió ${response.status} al solicitar el token de assets.`);
    }
    const result = await response.json();
    if (typeof result.access_token !== 'string' || !Number.isFinite(result.expires_in)) {
        throw new Error('Discord devolvió un token OAuth incompleto.');
    }
    discordRpcAccessToken = result.access_token;
    discordRpcAccessTokenExpiresAt = Date.now() + Math.max(0, result.expires_in - 60) * 1000;
    return discordRpcAccessToken;
}

async function getDiscordExternalAssetKey(imageUrl) {
    if (!imageUrl) return null;
    const cachedAssetKey = discordExternalAssetCache.get(imageUrl);
    if (cachedAssetKey) return cachedAssetKey;
    const pendingRequest = discordExternalAssetRequests.get(imageUrl);
    if (pendingRequest) return pendingRequest;

    const request = (async () => {
        const token = await getDiscordAppAccessToken();
        if (!token) {
            if (!discordMissingClientSecretLogged) {
                discordMissingClientSecretLogged = true;
                logDiscordRpc('No hay DISCORD_CLIENT_SECRET; se publica Rich Presence sin portada.');
            }
            return null;
        }
        const response = await fetch(`https://discord.com/api/v10/applications/${discordRpcClientId}/external-assets`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ urls: [imageUrl] })
        });
        if (!response.ok) {
            throw new Error(`Discord external-assets respondió ${response.status}.`);
        }
        const result = await response.json();
        const assetPath = result?.[0]?.external_asset_path;
        if (typeof assetPath !== 'string' || !assetPath) {
            throw new Error('Discord no devolvió una ruta para la portada externa.');
        }
        const assetKey = assetPath.startsWith('mp:') ? assetPath : `mp:${assetPath}`;
        discordExternalAssetCache.set(imageUrl, assetKey);
        if (discordExternalAssetCache.size > 200) {
            discordExternalAssetCache.delete(discordExternalAssetCache.keys().next().value);
        }
        return assetKey;
    })();
    discordExternalAssetRequests.set(imageUrl, request);
    try {
        return await request;
    } finally {
        discordExternalAssetRequests.delete(imageUrl);
    }
}

function getLocalMp3Directory() {
    return path.join(app.getPath('userData'), 'MP3');
}

function getYoutubeCookiesFile() {
    const configurationDirectory = app.isPackaged ? app.getPath('userData') : app.getAppPath();
    const configuration = readApplicationConfiguration();
    const cookiesFile = process.env.YOUTUBE_COOKIES_FILE || configuration.YOUTUBE_COOKIES_FILE;
    if (!cookiesFile) return null;
    return path.isAbsolute(cookiesFile)
        ? cookiesFile
        : path.resolve(configurationDirectory, cookiesFile);
}

function startLocalDownloader() {
    if (downloaderReadyPromise) return downloaderReadyPromise;

    const applicationPath = app.getAppPath();
    const serverPath = app.isPackaged
        ? path.join(path.dirname(applicationPath), 'app.asar.unpacked', 'backend', 'server.js')
        : path.join(applicationPath, 'backend', 'server.js');
    const inheritedEnvironment = {};
    for (const key of [
        'PATH',
        'SystemRoot',
        'WINDIR',
        'TEMP',
        'TMP',
        'HOME',
        'USERPROFILE',
        'APPDATA',
        'LOCALAPPDATA'
    ]) {
        if (process.env[key]) inheritedEnvironment[key] = process.env[key];
    }
    const youtubeCookiesFile = getYoutubeCookiesFile();
    downloaderProcess = spawn(process.execPath, [serverPath], {
        cwd: app.getPath('userData'),
        env: {
            ...inheritedEnvironment,
            ELECTRON_RUN_AS_NODE: '1',
            MMAMGC_DESKTOP_DOWNLOADER: 'true',
            MMAMGC_DESKTOP_DOWNLOAD_KEY: desktopDownloadKey,
            MMAMGC_DESKTOP_DOWNLOAD_DIRECTORY: getLocalMp3Directory(),
            NODE_ENV: 'development',
            PORT: '0',
            ...(youtubeCookiesFile ? { YOUTUBE_COOKIES_FILE: youtubeCookiesFile } : {})
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });

    downloaderReadyPromise = new Promise((resolve, reject) => {
        let settled = false;
        let stdoutBuffer = '';
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            downloaderProcess?.kill();
            downloaderProcess = null;
            downloaderReadyPromise = null;
            reject(new Error('El servicio local de descargas no inició dentro del tiempo esperado.'));
        }, 30000);

        downloaderProcess.stdout.on('data', chunk => {
            stdoutBuffer += chunk.toString();
            const readyMatch = stdoutBuffer.match(/MMAMGC_DESKTOP_DOWNLOADER_READY:(\d+)/);
            if (!readyMatch || settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(`http://127.0.0.1:${readyMatch[1]}`);
        });

        downloaderProcess.stderr.on('data', chunk => {
            console.error('[Descargador local]', chunk.toString().trim());
        });

        downloaderProcess.once('error', error => {
            clearTimeout(timeout);
            if (!settled) {
                settled = true;
                reject(error);
            }
            downloaderReadyPromise = null;
        });

        downloaderProcess.once('exit', (code, signal) => {
            clearTimeout(timeout);
            downloaderProcess = null;
            downloaderReadyPromise = null;
            if (!settled) {
                settled = true;
                reject(new Error(`El servicio local de descargas se cerró (${signal || code}).`));
            }
        });
    });

    return downloaderReadyPromise;
}

function isTrustedSender(event) {
    try {
        return trustedOrigins.has(new URL(event.senderFrame.url).origin);
    } catch {
        return false;
    }
}

function scheduleDiscordRpcReconnect() {
    if (isQuitting || discordRpcReconnectTimer || !discordRpcClientId) return;
    discordRpcReconnectTimer = setTimeout(() => {
        discordRpcReconnectTimer = null;
        connectDiscordRpc();
    }, 15000);
    discordRpcReconnectTimer.unref();
}

async function publishDiscordPresence() {
    if (!discordRpcReady || !discordRpcClient) return false;
    const presence = pendingDiscordPresence;
    try {
        if (!presence) {
            await discordRpcClient.clearActivity();
            discordRpcLastActivityAt = null;
            logDiscordRpc('Presencia borrada.');
            return true;
        }

        const { songName, artist, currentTime, duration, isPlaying, coverUrl } = presence;
        if (!isPlaying) {
            await discordRpcClient.clearActivity();
            discordRpcLastActivityAt = null;
            logDiscordRpc('Presencia borrada porque la reproduccion esta pausada.');
            return true;
        }

        if (!coverUrl) {
            logDiscordArtworkStatus('no-cover-url', 'La interfaz no envio una URL HTTPS de portada.');
        }
        const activity = {
            type: 2,
            details: songName,
            state: artist,
            instance: false
        };
        if (coverUrl) {
            try {
                const largeImageKey = await getDiscordExternalAssetKey(coverUrl);
                if (largeImageKey) {
                    activity.assets = {
                        large_image: largeImageKey
                    };
                    logDiscordArtworkStatus('attached', 'Discord acepto y adjunto el asset de portada.');
                } else if (!getDiscordClientSecret()) {
                    logDiscordArtworkStatus('missing-secret', 'No hay DISCORD_CLIENT_SECRET; la presencia se publica sin portada.');
                }
            } catch (error) {
                const message = error.message || String(error);
                logDiscordArtworkStatus(`error:${message}`, `No se pudo preparar la portada externa: ${message}`);
            }
        }
        if (pendingDiscordPresence !== presence) return false;
        if (duration > currentTime) {
            const startTimestamp = Date.now() - currentTime * 1000;
            activity.timestamps = {
                start: startTimestamp,
                end: startTimestamp + duration * 1000
            };
        }
        await discordRpcClient.request('SET_ACTIVITY', {
            pid: process.pid,
            activity
        });
        discordRpcLastError = null;
        discordRpcLastActivityAt = new Date().toISOString();
        logDiscordRpc('Presencia actualizada (reproduciendo).');
        return true;
    } catch (error) {
        discordRpcLastError = error.message || String(error);
        logDiscordRpc(`Error al actualizar la presencia: ${discordRpcLastError}`);
        return false;
    }
}

function connectDiscordRpc() {
    if (isQuitting || !discordRpcClientId) return;
    const client = new DiscordRPC.Client({ transport: 'ipc' });
    discordRpcClient = client;
    discordRpcReady = false;

    client.on('ready', () => {
        if (discordRpcClient !== client) return;
        discordRpcReady = true;
        discordRpcLastError = null;
        logDiscordRpc('Conectado a Discord.');
        void publishDiscordPresence();
    });
    client.on('disconnected', () => {
        if (discordRpcClient !== client) return;
        discordRpcReady = false;
        discordRpcClient = null;
        discordRpcLastError = 'Discord cerró la conexión IPC.';
        logDiscordRpc(discordRpcLastError);
        scheduleDiscordRpcReconnect();
    });
    client.on('error', error => {
        discordRpcLastError = error.message || String(error);
        logDiscordRpc(`Error de conexión: ${discordRpcLastError}`);
        if (discordRpcClient !== client) return;
        discordRpcReady = false;
        discordRpcClient = null;
        scheduleDiscordRpcReconnect();
    });
    client.login({ clientId: discordRpcClientId }).catch(error => {
        discordRpcLastError = error.message || String(error);
        logDiscordRpc(`No se pudo conectar; se reintentará: ${discordRpcLastError}`);
        if (discordRpcClient !== client) return;
        discordRpcReady = false;
        discordRpcClient = null;
        scheduleDiscordRpcReconnect();
    });
}

function startDiscordRpc() {
    try {
        const configuration = readApplicationConfiguration();
        const clientId = process.env.DISCORD_CLIENT_ID || configuration.DISCORD_CLIENT_ID || '';
        if (!/^\d{17,20}$/.test(clientId)) {
            discordRpcLastError = 'DISCORD_CLIENT_ID falta o no tiene un formato válido.';
            logDiscordRpc(discordRpcLastError);
            return;
        }
        discordRpcClientId = clientId;
        DiscordRPC.register(clientId);
        logDiscordRpc('Application ID leído desde la configuración.');
        connectDiscordRpc();
    } catch (error) {
        discordRpcLastError = error.message || String(error);
        logDiscordRpc(`No se pudo iniciar la integración: ${discordRpcLastError}`);
    }
}

ipcMain.handle('mmamgc:download-youtube', async (event, ytLink, fileName, saveLocally = false) => {
    if (!isTrustedSender(event)) throw new Error('Origen no autorizado para usar el descargador local.');
    let url;
    try {
        url = new URL(String(ytLink || ''));
    } catch {
        throw new Error('El enlace de YouTube no es válido.');
    }
    const hostname = url.hostname.replace(/^www\./, '').toLowerCase();
    if (!['youtube.com', 'm.youtube.com', 'youtu.be'].includes(hostname)) {
        throw new Error('El enlace de YouTube no es válido.');
    }

    const downloaderOrigin = await startLocalDownloader();
    const response = await fetch(`${downloaderOrigin}/desktop/yt-download`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Desktop-Download-Key': desktopDownloadKey
        },
        body: JSON.stringify({ ytLink: url.href, fileName, saveLocally })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(result?.error || `El descargador local respondió ${response.status}.`);
    }
    if (typeof result?.title !== 'string') {
        throw new Error('El descargador local devolvió una respuesta incompleta.');
    }
    if (saveLocally) {
        if (typeof result.fileName !== 'string' || typeof result.path !== 'string') {
            throw new Error('El descargador local devolvió una respuesta incompleta.');
        }
        return result;
    }
    if (typeof result.audio !== 'string') {
        throw new Error('El descargador local devolvió una respuesta incompleta.');
    }
    return {
        title: result.title,
        bytes: Uint8Array.from(Buffer.from(result.audio, 'base64'))
    };
});

ipcMain.handle('mmamgc:discord-presence', async (event, presence) => {
    if (!isTrustedSender(event)) throw new Error('Origen no autorizado para actualizar Discord.');
    if (!presence || typeof presence !== 'object'
        || typeof presence.songName !== 'string'
        || typeof presence.artist !== 'string'
        || typeof presence.isPlaying !== 'boolean'
        || !Number.isFinite(presence.currentTime)
        || !Number.isFinite(presence.duration)
        || (presence.coverUrl !== undefined && typeof presence.coverUrl !== 'string')) {
        throw new Error('La información de reproducción para Discord no es válida.');
    }

    const songName = presence.songName.trim().slice(0, 128);
    const artist = presence.artist.trim().slice(0, 128) || 'Artista desconocido';
    if (!songName) throw new Error('La canción para Discord no puede estar vacía.');
    const duration = Math.max(0, Math.min(presence.duration, 86400));
    let coverUrl = null;
    if (presence.coverUrl) {
        if (presence.coverUrl.length > 2048) throw new Error('La URL de portada para Discord es demasiado larga.');
        let parsedCoverUrl;
        try {
            parsedCoverUrl = new URL(presence.coverUrl);
        } catch {
            throw new Error('La URL de portada para Discord no es válida.');
        }
        if (parsedCoverUrl.protocol === 'https:' && !parsedCoverUrl.username && !parsedCoverUrl.password) {
            coverUrl = parsedCoverUrl.href;
        }
    }
    pendingDiscordPresence = {
        songName,
        artist,
        currentTime: Math.max(0, Math.min(presence.currentTime, duration)),
        duration,
        isPlaying: presence.isPlaying,
        coverUrl
    };
    const published = await publishDiscordPresence();
    if (!discordRpcReady) logDiscordRpc('La interfaz envió el estado, pero Discord aún no está conectado.');
    return {
        configured: Boolean(discordRpcClientId),
        connected: discordRpcReady,
        published,
        lastError: discordRpcLastError,
        lastActivityAt: discordRpcLastActivityAt
    };
});

ipcMain.handle('mmamgc:discord-status', event => {
    if (!isTrustedSender(event)) throw new Error('Origen no autorizado para consultar Discord.');
    return {
        configured: Boolean(discordRpcClientId),
        connected: discordRpcReady,
        lastError: discordRpcLastError,
        lastActivityAt: discordRpcLastActivityAt
    };
});

ipcMain.handle('mmamgc:open-local-mp3-folder', async event => {
    if (!isTrustedSender(event)) throw new Error('Origen no autorizado para abrir esta carpeta.');
    const directory = getLocalMp3Directory();
    await mkdir(directory, { recursive: true });
    const errorMessage = await shell.openPath(directory);
    if (errorMessage) throw new Error(`No se pudo abrir la carpeta de MP3: ${errorMessage}`);
    return directory;
});

async function openExternalUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' || url.protocol === 'http:') {
            await shell.openExternal(url.href);
        }
    } catch (error) {
        console.error('No se pudo abrir el enlace externo.', error);
    }
}

function createMainWindow() {
    const window = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 800,
        minHeight: 600,
        backgroundColor: '#000000',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(app.getAppPath(), 'electron', 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true
        }
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
        void openExternalUrl(url);
        return { action: 'deny' };
    });

    window.webContents.on('will-navigate', (event, targetUrl) => {
        if (trustedOrigins.has(new URL(targetUrl).origin)) return;
        event.preventDefault();
        void openExternalUrl(targetUrl);
    });

    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (isMainFrame) {
            console.error(`No se pudo cargar ${validatedUrl}: ${errorDescription} (${errorCode}).`);
        }
    });

    void window.loadURL(appUrl);
    return window;
}

app.whenReady().then(() => {
    startDiscordRpc();
    void startLocalDownloader().catch(error => {
        console.error('El descargador local de YouTube no está disponible.', error);
    });
    createMainWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    isQuitting = true;
    if (discordRpcReconnectTimer) clearTimeout(discordRpcReconnectTimer);
    if (discordRpcReady) void discordRpcClient?.clearActivity().catch(error => {
        console.warn('[Discord RPC] No se pudo borrar la presencia al cerrar.', error);
    });
    downloaderProcess?.kill();
});
