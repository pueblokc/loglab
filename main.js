const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, screen, nativeImage, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const chokidar = require('chokidar');
const { computeStats, updateStats, toCSV } = require('./lib/shared');
const { readLogFile, Tailer } = require('./lib/logfile');

// --- Config ---
// Runtime state lives in the per-user data dir (%APPDATA%\LogLab on Windows).
// The app directory is read-only once packaged (app.asar / Program Files), so
// writing next to the app silently lost every setting and bookmark.
const USER_DIR = app.getPath('userData');
const STATE_FILE = path.join(USER_DIR, 'window-state.json');
const PREFS_FILE = path.join(USER_DIR, 'loglab-prefs.json');
const LEGACY_DIR = __dirname;
const ICON_FILE = path.join(__dirname, 'assets', 'icon.png');

let mainWindow = null;
let tray = null;
let isQuitting = false;
const fileWatchers = new Map(); // tabId -> { watcher, tailer, path }
let pendingOpenFiles = [];      // files passed on the command line / via file association

// One-time copy of settings written by v1.0.0 next to the app (source checkouts).
function migrateLegacyFile(name) {
  const dest = path.join(USER_DIR, name);
  const legacy = path.join(LEGACY_DIR, name);
  try {
    if (!fs.existsSync(dest) && fs.existsSync(legacy)) {
      fs.mkdirSync(USER_DIR, { recursive: true });
      fs.copyFileSync(legacy, dest);
    }
  } catch { /* ignore */ }
}
migrateLegacyFile('loglab-prefs.json');
migrateLegacyFile('window-state.json');

// Write via temp file + rename so a crash mid-write can't corrupt the file
// (a corrupt prefs file would reset settings and wipe all bookmarks).
function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ============================================================
// Preferences
// ============================================================
const DEFAULT_PREFS = {
  fontSize: 12,
  lineWrap: false,
  theme: 'catppuccin-mocha',
  maxLines: 500000,
  autoTailOnOpen: false,
  bookmarks: {},
  recentFiles: [],
};

function loadPrefs() {
  try {
    if (fs.existsSync(PREFS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
      return Object.assign({}, DEFAULT_PREFS, saved);
    }
  } catch { /* ignore */ }
  return Object.assign({}, DEFAULT_PREFS);
}

function savePrefs(prefs) {
  try { writeFileAtomic(PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch { /* ignore */ }
}

// ============================================================
// Icon Generation (Catppuccin Mauve)
// ============================================================
function ensureIcon() {
  if (fs.existsSync(ICON_FILE)) return ICON_FILE;
  try {
    fs.mkdirSync(path.dirname(ICON_FILE), { recursive: true });
    const png = generatePNG(32, 32, { r: 203, g: 166, b: 247 }, 6);
    fs.writeFileSync(ICON_FILE, png);
    return ICON_FILE;
  } catch (e) { return null; }
}

function generatePNG(w, h, color, radius) {
  const raw = Buffer.alloc((1 + w * 4) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 4);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const px = off + 1 + x * 4;
      const dx = Math.min(x, w - 1 - x);
      const dy = Math.min(y, h - 1 - y);
      const inCorner = dx < radius && dy < radius && Math.pow(dx - radius, 2) + Math.pow(dy - radius, 2) > radius * radius;
      raw[px] = color.r; raw[px + 1] = color.g; raw[px + 2] = color.b; raw[px + 3] = inCorner ? 0 : 255;
    }
  }
  const compressed = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0); ihdrData.writeUInt32BE(h, 4); ihdrData[8] = 8; ihdrData[9] = 6;
  return Buffer.concat([sig, pngChunk('IHDR', ihdrData), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32Buf(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
}

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32Buf(buf) { let crc = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8); return (crc ^ 0xFFFFFFFF) >>> 0; }

// ============================================================
// Window State
// ============================================================
function loadWindowState() { try { return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null; } catch { return null; } }
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const b = mainWindow.getBounds();
    writeFileAtomic(STATE_FILE, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: mainWindow.isMaximized() }, null, 2));
  } catch { /* ignore */ }
}

// ============================================================
// Window
// ============================================================
function createWindow() {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const saved = loadWindowState();
  const defaults = { width: Math.min(1400, wa.width - 100), height: Math.min(900, wa.height - 100), x: wa.x + 50, y: wa.y + 50 };
  const s = saved || defaults;

  const displays = screen.getAllDisplays();
  const onScreen = displays.some(d => { const a = d.workArea; return s.x >= a.x - 100 && s.x < a.x + a.width + 100 && s.y >= a.y - 100 && s.y < a.y + a.height + 100; });
  if (!onScreen) Object.assign(s, defaults);

  const iconPath = ensureIcon();
  mainWindow = new BrowserWindow({
    width: s.width, height: s.height, x: s.x, y: s.y,
    minWidth: 800, minHeight: 500,
    frame: false, backgroundColor: '#1e1e2e',
    icon: iconPath || undefined, skipTaskbar: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    show: false,
  });

  const wc = mainWindow.webContents;
  // Never open child windows: they would inherit the preload (and with it
  // file-system access). External http(s) links go to the default browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The UI is a single local page; block any navigation away from it
  // (e.g. a file dropped outside the drop handler, or a link click).
  wc.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  // A renderer reload would orphan watchers keyed by the old tab ids.
  wc.on('did-start-loading', stopAllWatchers);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (s.maximized) mainWindow.maximize();
  });
  mainWindow.on('close', (e) => { if (!isQuitting) { e.preventDefault(); mainWindow.hide(); } else { saveWindowState(); } });
  mainWindow.on('moved', debounce(saveWindowState, 500));
  mainWindow.on('resized', debounce(saveWindowState, 500));
}

// ============================================================
// Tray
// ============================================================
function createTray() {
  const iconPath = ensureIcon();
  let trayIcon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (trayIcon.isEmpty()) trayIcon = nativeImage.createFromPath(process.execPath);

  tray = new Tray(trayIcon);
  tray.setToolTip('LogLab');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide', click: () => toggleWindow() },
    { type: 'separator' },
    { label: 'Open Log File...', click: () => openFileDialog() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => toggleWindow());
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) { mainWindow.hide(); } else { mainWindow.show(); mainWindow.focus(); }
}

// ============================================================
// Log File Parsing — see lib/shared.js (parsing, stats) and lib/logfile.js
// ============================================================

// Read file stats
function getFileStats(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { size: stat.size, modified: stat.mtime.toISOString(), created: stat.birthtime.toISOString() };
  } catch { return null; }
}

// ============================================================
// Tail Mode
// ============================================================
// opts (optional): { offset, lineNum, encoding } from the initial read, so the
// tail continues exactly where the read stopped. Returns true or { error }.
function startTailing(filePath, tabId, opts) {
  if (fileWatchers.has(tabId)) stopTailing(tabId);
  if (filePath.toLowerCase().endsWith('.gz')) return { error: 'Tail is not supported for gzip files' };

  const o = opts || {};
  const tailer = new Tailer(filePath, {
    offset: o.offset, lineNum: o.lineNum, encoding: o.encoding,
    onEntries: (entries) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tail-data', { tabId, entries });
    },
    onError: (err) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tail-error', { tabId, error: err.message });
    },
  });
  tailer.init();

  // No awaitWriteFinish: a log that is written continuously never becomes
  // "stable", so tail used to stall on busy files. Tailer only consumes
  // complete lines, so reading mid-write is safe.
  const watcher = chokidar.watch(filePath, { persistent: true, ignoreInitial: true });
  watcher.on('change', () => tailer.check());
  watcher.on('add', () => tailer.check());        // re-created after rename rotation
  watcher.on('unlink', () => tailer.markRotated());
  watcher.on('error', () => { /* reported via tailer reads */ });

  fileWatchers.set(tabId, { watcher, tailer, path: filePath });
  // Pick up anything written between the initial read and now.
  tailer.check();
  return true;
}

function stopTailing(tabId) {
  const entry = fileWatchers.get(tabId);
  if (entry) {
    entry.tailer.close();
    entry.watcher.close().catch(() => {});
    fileWatchers.delete(tabId);
  }
}

function stopAllWatchers() {
  for (const tabId of Array.from(fileWatchers.keys())) stopTailing(tabId);
  if (dirWatcher) { dirWatcher.close().catch(() => {}); dirWatcher = null; }
}

// ============================================================
// Directory Watching
// ============================================================
let dirWatcher = null;
function watchDirectory(dirPath) {
  if (dirWatcher) dirWatcher.close().catch(() => {});
  dirWatcher = chokidar.watch(dirPath, {
    persistent: true, depth: 2, ignoreInitial: false,
    ignored: /(^|[\\/])(node_modules|\.git)([\\/]|$)/,
  });

  const logExts = ['.log', '.txt', '.syslog', '.err', '.out', '.gz'];

  dirWatcher.on('add', (fp) => {
    const ext = path.extname(fp).toLowerCase();
    if (logExts.includes(ext) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dir-file-found', { path: fp, name: path.basename(fp) });
    }
  });
  dirWatcher.on('error', () => { /* unreadable subfolder etc. */ });

  return true;
}

// ============================================================
// File Dialog
// ============================================================
async function openFileDialog() {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Log Files', extensions: ['log', 'txt', 'syslog', 'err', 'out', 'csv', 'gz'] },
      { name: 'Gzip Logs', extensions: ['gz'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths;
}

async function openDirDialog() {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
}

// ============================================================
// Export
// ============================================================
async function exportData(entries, format) {
  if (!mainWindow) return false;
  const ext = format === 'json' ? 'json' : 'csv';
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `loglab-export.${ext}`,
    filters: [{ name: format.toUpperCase(), extensions: [ext] }],
  });
  if (result.canceled || !result.filePath) return false;

  try {
    if (format === 'json') {
      fs.writeFileSync(result.filePath, JSON.stringify(entries, null, 2));
    } else {
      fs.writeFileSync(result.filePath, toCSV(entries));
    }
  } catch (err) {
    return { error: err.message };
  }
  return true;
}

// ============================================================
// IPC Handlers
// ============================================================
// Only the app's own main frame may call into the main process.
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!mainWindow || mainWindow.isDestroyed() || e.sender.id !== mainWindow.webContents.id || !e.senderFrame || e.senderFrame.parent) {
      throw new Error('Untrusted IPC sender');
    }
    return fn(e, ...args);
  });
}

const isStr = (v) => typeof v === 'string' && v.length > 0;

function setupIPC() {
  // File operations
  handle('open-file-dialog', async () => openFileDialog());
  handle('open-dir-dialog', async () => openDirDialog());

  handle('read-log-file', async (_e, filePath, maxLines) => {
    if (!isStr(filePath)) return { error: 'No file path' };
    try {
      const { entries, lineCount, truncated, endOffset, encoding } = await readLogFile(filePath, maxLines);
      const stats = computeStats(entries);
      const fileStats = getFileStats(filePath);
      return { entries, stats, fileStats, name: path.basename(filePath), path: filePath, lineCount, truncated, endOffset, encoding };
    } catch (err) {
      return { error: err.message };
    }
  });

  handle('get-file-stats', (_e, filePath) => getFileStats(filePath));

  // Tail mode
  handle('start-tail', (_e, filePath, tabId, opts) => {
    if (!isStr(filePath) || !isStr(tabId)) return { error: 'Invalid tail request' };
    return startTailing(filePath, tabId, opts);
  });

  handle('stop-tail', (_e, tabId) => {
    stopTailing(tabId);
    return true;
  });

  // Update stats incrementally (called from renderer after tail data arrives)
  handle('update-stats', (_e, existingStats, newEntries) => {
    return updateStats(existingStats, newEntries);
  });

  // Directory watching
  handle('watch-directory', (_e, dirPath) => {
    if (!isStr(dirPath)) return false;
    return watchDirectory(dirPath);
  });

  // Files passed on the command line (file association / "Open with")
  handle('take-pending-files', () => {
    const files = pendingOpenFiles;
    pendingOpenFiles = [];
    return files;
  });

  // Export
  handle('export-data', async (_e, entries, format) => exportData(entries, format));

  // Bookmarks (stored in prefs)
  handle('get-bookmarks', (_e, filePath) => {
    const prefs = loadPrefs();
    return (prefs.bookmarks && prefs.bookmarks[filePath]) || [];
  });

  handle('set-bookmarks', (_e, filePath, bookmarks) => {
    const prefs = loadPrefs();
    if (!prefs.bookmarks) prefs.bookmarks = {};
    prefs.bookmarks[filePath] = bookmarks;
    savePrefs(prefs);
    return true;
  });

  // Recent files
  handle('get-recent-files', () => {
    const prefs = loadPrefs();
    return prefs.recentFiles || [];
  });

  handle('add-recent-file', (_e, filePath) => {
    const prefs = loadPrefs();
    if (!prefs.recentFiles) prefs.recentFiles = [];
    prefs.recentFiles = prefs.recentFiles.filter(f => f !== filePath);
    prefs.recentFiles.unshift(filePath);
    prefs.recentFiles = prefs.recentFiles.slice(0, 20);
    savePrefs(prefs);
    return prefs.recentFiles;
  });

  // Settings / Preferences
  handle('get-prefs', () => {
    return loadPrefs();
  });

  handle('save-prefs', (_e, newPrefs) => {
    const prefs = loadPrefs();
    // Merge (preserve bookmarks and recentFiles from disk, update settings keys)
    const merged = Object.assign({}, prefs, newPrefs);
    savePrefs(merged);
    return merged;
  });

  // Window controls
  handle('minimize-window', () => { if (mainWindow) mainWindow.minimize(); });
  handle('maximize-window', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  });
  handle('close-window', () => { if (mainWindow) mainWindow.hide(); });
  handle('is-maximized', () => mainWindow ? mainWindow.isMaximized() : false);

  // Reveal in explorer
  handle('reveal-in-explorer', (_e, filePath) => {
    if (isStr(filePath)) shell.showItemInFolder(filePath);
  });
}

// ============================================================
// Utilities
// ============================================================
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// Existing regular files among command-line arguments.
function filesFromArgv(argv, cwd) {
  const out = [];
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue;
    const p = path.resolve(cwd || process.cwd(), arg);
    try { if (fs.statSync(p).isFile()) out.push(p); } catch { /* not a file */ }
  }
  return out;
}

function openFilesInWindow(files) {
  if (files.length === 0) return;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('open-files', files);
  } else {
    pendingOpenFiles.push(...files);
  }
}

// ============================================================
// Lifecycle
// ============================================================
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  pendingOpenFiles = filesFromArgv(process.argv);

  app.on('second-instance', (_e, argv, cwd) => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    openFilesInWindow(filesFromArgv(argv, cwd));
  });

  app.whenReady().then(() => {
    // The UI needs no camera, notifications, etc.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    setupIPC();
    createWindow();
    createTray();

    try { globalShortcut.register('Ctrl+Shift+L', toggleWindow); } catch {}
  });

  app.on('before-quit', () => { isQuitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopAllWatchers();
  });
  app.on('window-all-closed', (e) => e.preventDefault());
}
