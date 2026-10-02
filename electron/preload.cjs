const { contextBridge, ipcRenderer } = require('electron');

const updateStateListener = (_event, state) => {
    updateStateCallback?.(state);
};
let updateStateCallback = null;

contextBridge.exposeInMainWorld('amgcDesktop', {
    downloadYoutubeAudio: (ytLink, fileName) => ipcRenderer.invoke('amgc:download-youtube', ytLink, fileName),
    setDiscordPresence: presence => ipcRenderer.invoke('amgc:discord-presence', presence),
    getDiscordPresenceStatus: () => ipcRenderer.invoke('amgc:discord-status'),
    getUpdateState: () => ipcRenderer.invoke('amgc:update:get-state'),
    downloadUpdate: () => ipcRenderer.invoke('amgc:update:download'),
    installUpdate: () => ipcRenderer.invoke('amgc:update:install'),
    subscribeUpdateState: callback => {
        updateStateCallback = callback;
        ipcRenderer.removeListener('amgc:update-state', updateStateListener);
        ipcRenderer.on('amgc:update-state', updateStateListener);
    },
    unsubscribeUpdateState: () => {
        updateStateCallback = null;
        ipcRenderer.removeListener('amgc:update-state', updateStateListener);
    },
    saveYoutubeAudioLocally: (ytLink, fileName) => ipcRenderer.invoke(
        'amgc:download-youtube',
        ytLink,
        fileName,
        true
    ),
    openLocalMp3Folder: () => ipcRenderer.invoke('amgc:open-local-mp3-folder')
});
