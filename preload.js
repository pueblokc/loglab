const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loglab', {
  // File operations
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  openDirDialog: () => ipcRenderer.invoke('open-dir-dialog'),
  readLogFile: (path, maxLines) => ipcRenderer.invoke('read-log-file', path, maxLines),
  getFileStats: (path) => ipcRenderer.invoke('get-file-stats', path),

  // Tail mode
  startTail: (path, tabId) => ipcRenderer.invoke('start-tail', path, tabId),
  stopTail: (tabId) => ipcRenderer.invoke('stop-tail', tabId),
  onTailData: (cb) => ipcRenderer.on('tail-data', (_e, d) => cb(d)),

  // Stats update (for tail mode - runs in main process)
  updateStats: (existingStats, newEntries) => ipcRenderer.invoke('update-stats', existingStats, newEntries),

  // Directory watching
  watchDirectory: (path) => ipcRenderer.invoke('watch-directory', path),
  onDirFileFound: (cb) => ipcRenderer.on('dir-file-found', (_e, d) => cb(d)),

  // Export
  exportData: (entries, format) => ipcRenderer.invoke('export-data', entries, format),

  // Bookmarks
  getBookmarks: (path) => ipcRenderer.invoke('get-bookmarks', path),
  setBookmarks: (path, bookmarks) => ipcRenderer.invoke('set-bookmarks', path, bookmarks),

  // Recent files
  getRecentFiles: () => ipcRenderer.invoke('get-recent-files'),
  addRecentFile: (path) => ipcRenderer.invoke('add-recent-file', path),

  // Settings / Preferences
  getPrefs: () => ipcRenderer.invoke('get-prefs'),
  savePrefs: (prefs) => ipcRenderer.invoke('save-prefs', prefs),

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  isMaximized: () => ipcRenderer.invoke('is-maximized'),

  // File system
  revealInExplorer: (path) => ipcRenderer.invoke('reveal-in-explorer', path),
});
