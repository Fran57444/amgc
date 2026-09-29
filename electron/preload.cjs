const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mmamgcDesktop', {
    downloadYoutubeAudio: ytLink => ipcRenderer.invoke('mmamgc:download-youtube', ytLink)
});
