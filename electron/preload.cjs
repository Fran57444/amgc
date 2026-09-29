const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mmamgcDesktop', {
    downloadYoutubeAudio: (ytLink, fileName) => ipcRenderer.invoke('mmamgc:download-youtube', ytLink, fileName),
    saveYoutubeAudioLocally: (ytLink, fileName) => ipcRenderer.invoke(
        'mmamgc:download-youtube',
        ytLink,
        fileName,
        true
    ),
    openLocalMp3Folder: () => ipcRenderer.invoke('mmamgc:open-local-mp3-folder')
});
