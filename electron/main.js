import { app, BrowserWindow, shell } from 'electron';

const productionUrl = 'https://mmamgc.onrender.com/';
const developmentUrl = 'http://127.0.0.1:5163/';
const isDevelopment = process.argv.includes('--dev');
const appUrl = isDevelopment ? developmentUrl : productionUrl;
const trustedOrigin = new URL(appUrl).origin;

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
        if (new URL(targetUrl).origin === trustedOrigin) return;
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
    createMainWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
