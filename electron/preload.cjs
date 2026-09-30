const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('amgcDesktop', {
    downloadYoutubeAudio: (ytLink, fileName) => ipcRenderer.invoke('amgc:download-youtube', ytLink, fileName),
    setDiscordPresence: presence => ipcRenderer.invoke('amgc:discord-presence', presence),
    getDiscordPresenceStatus: () => ipcRenderer.invoke('amgc:discord-status'),
    saveYoutubeAudioLocally: (ytLink, fileName) => ipcRenderer.invoke(
        'amgc:download-youtube',
        ytLink,
        fileName,
        true
    ),
    openLocalMp3Folder: () => ipcRenderer.invoke('amgc:open-local-mp3-folder')
});
