const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  defaultDownloadFolder: () => ipcRenderer.invoke('default-download-folder'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  resolveUrl: (url) => ipcRenderer.invoke('resolve-url', url),
  startDownload: (payload) => ipcRenderer.invoke('start-download', payload),
  pauseDownload: (id) => ipcRenderer.invoke('pause-download', id),
  cancelDownload: (id, knownDestinations) => ipcRenderer.invoke('cancel-download', id, knownDestinations),
  deleteFile: (filepath) => ipcRenderer.invoke('delete-file', filepath),
  ensureFfmpeg: () => ipcRenderer.invoke('ensure-ffmpeg'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (partial) => ipcRenderer.invoke('set-settings', partial),
  getHistory: () => ipcRenderer.invoke('get-history'),
  removeHistoryEntry: (historyId) => ipcRenderer.invoke('remove-history-entry', historyId),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onFfmpegStatus: (callback) => {
    ipcRenderer.on('ffmpeg-status', (_event, data) => callback(data));
  },
  onYtdlpStatus: (callback) => {
    ipcRenderer.on('ytdlp-status', (_event, data) => callback(data));
  },
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (_event, data) => callback(data));
  },
  onProgress: (callback) => {
    ipcRenderer.on('download-progress', (_event, data) => callback(data));
  },
});
