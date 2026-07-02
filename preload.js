'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Узкий безопасный мост между renderer и main.
contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  probe: (args) => ipcRenderer.invoke('probe', args),
  listFolders: (args) => ipcRenderer.invoke('list-folders', args),
  preview: (args) => ipcRenderer.invoke('preview', args),
  cancelPreview: () => ipcRenderer.invoke('cancel-preview'),
  onPreviewProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('preview-progress', listener);
    return () => ipcRenderer.removeListener('preview-progress', listener);
  },
  sync: (args) => ipcRenderer.invoke('sync', args),
  onSyncProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('sync-progress', listener);
    return () => ipcRenderer.removeListener('sync-progress', listener);
  },
  startCrawl: (args) => ipcRenderer.invoke('start-crawl', args),
  stopCrawl: () => ipcRenderer.invoke('stop-crawl'),
  onCrawl: (callbacks) => {
    const cached = (_e, d) => callbacks.onCached && callbacks.onCached(d);
    const progress = (_e, d) => callbacks.onProgress && callbacks.onProgress(d);
    const done = (_e, d) => callbacks.onDone && callbacks.onDone(d);
    ipcRenderer.on('crawl-cached', cached);
    ipcRenderer.on('crawl-progress', progress);
    ipcRenderer.on('crawl-done', done);
    return () => {
      ipcRenderer.removeListener('crawl-cached', cached);
      ipcRenderer.removeListener('crawl-progress', progress);
      ipcRenderer.removeListener('crawl-done', done);
    };
  },
});
