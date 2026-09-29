import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

const productionUrl = 'https://mmamgc.onrender.com/';
const developmentUrl = 'http://127.0.0.1:5163/';
const isDevelopment = process.argv.includes('--dev');
const appUrl = isDevelopment ? developmentUrl : productionUrl;
const trustedOrigins = new Set([new URL(productionUrl).origin, new URL(developmentUrl).origin]);
const desktopDownloadKey = randomBytes(32).toString('hex');
let downloaderProcess = null;
let downloaderReadyPromise = null;

function getLocalMp3Directory() {
    return path.join(app.getPath('userData'), 'MP3');
}

function getYoutubeCookiesFile() {
    const configurationDirectory = app.isPackaged ? app.getPath('userData') : app.getAppPath();
    const configurationPath = path.join(configurationDirectory, '.env');
    let configuration = {};

    try {
        configuration = dotenv.parse(readFileSync(configurationPath));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

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
    downloaderProcess?.kill();
});
