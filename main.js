const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, screen, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const chokidar = require('chokidar');

// --- Config ---
const STATE_FILE = path.join(__dirname, 'window-state.json');
const PREFS_FILE = path.join(__dirname, 'loglab-prefs.json');
const ICON_FILE = path.join(__dirname, 'assets', 'icon.png');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let fileWatchers = new Map(); // path -> { watcher, size }

// ============================================================
// Preferences
// ============================================================
function loadPrefs() {
  try { return fs.existsSync(PREFS_FILE) ? JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) : {}; } catch { return {}; }
}
function savePrefs(prefs) {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch { /* ignore */ }
}

// ============================================================
// Icon Generation (Catppuccin Mauve)
// ============================================================
function ensureIcon() {
  const dir = path.dirname(ICON_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(ICON_FILE)) return ICON_FILE;
  try {
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
    fs.writeFileSync(STATE_FILE, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: mainWindow.isMaximized() }, null, 2));
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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    show: false,
  });

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
// Log File Parser
// ============================================================

// Parse a single log line - detect level, timestamp, source
function parseLogLine(line, lineNum) {
  const entry = { line: lineNum, raw: line, level: 'INFO', timestamp: null, source: '', message: line };

  // Detect log level
  if (/\b(FATAL|CRIT(?:ICAL)?)\b/i.test(line)) entry.level = 'FATAL';
  else if (/\b(ERR(?:OR)?)\b/i.test(line)) entry.level = 'ERROR';
  else if (/\b(WARN(?:ING)?)\b/i.test(line)) entry.level = 'WARN';
  else if (/\b(DEBUG|TRACE|VERBOSE)\b/i.test(line)) entry.level = 'DEBUG';
  else if (/\b(INFO(?:RMATION)?|NOTICE)\b/i.test(line)) entry.level = 'INFO';

  // Extract timestamp - common patterns
  const tsPatterns = [
    // ISO 8601: 2024-01-15T10:30:00.000Z
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/,
    // Common log: 2024-01-15 10:30:00
    /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)/,
    // Syslog: Jan 15 10:30:00
    /([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/,
    // Apache/Nginx: [15/Jan/2024:10:30:00 +0000]
    /\[(\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2}\s+[+-]\d{4})\]/,
    // Epoch seconds
    /^(\d{10}(?:\.\d+)?)\s/,
  ];

  for (const pat of tsPatterns) {
    const m = line.match(pat);
    if (m) {
      entry.timestamp = m[1];
      break;
    }
  }

  // Extract source - syslog format: "hostname process[pid]:"
  const syslogMatch = line.match(/^\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+(\S+)\s+(\S+?)(?:\[\d+\])?:/);
  if (syslogMatch) {
    entry.source = syslogMatch[2];
    entry.message = line.substring(line.indexOf(':', line.indexOf(syslogMatch[2])) + 2);
  }

  return entry;
}

// Read a log file - returns array of parsed entries
async function readLogFile(filePath) {
  return new Promise((resolve, reject) => {
    const entries = [];
    let lineNum = 0;
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      lineNum++;
      if (line.trim()) {
        entries.push(parseLogLine(line, lineNum));
      }
    });
    rl.on('close', () => resolve(entries));
    rl.on('error', (err) => reject(err));
  });
}

// Read file stats
function getFileStats(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { size: stat.size, modified: stat.mtime.toISOString(), created: stat.birthtime.toISOString() };
  } catch { return null; }
}

// Compute statistics from entries
function computeStats(entries) {
  const levelCounts = { FATAL: 0, ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 };
  const hourCounts = {};
  const errorPatterns = {};
  const sources = {};

  for (const e of entries) {
    // Level counts
    if (levelCounts[e.level] !== undefined) levelCounts[e.level]++;

    // Source counts
    if (e.source) {
      sources[e.source] = (sources[e.source] || 0) + 1;
    }

    // Per-hour counts (if timestamp available)
    if (e.timestamp) {
      try {
        const d = new Date(e.timestamp);
        if (!isNaN(d.getTime())) {
          const hourKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
          hourCounts[hourKey] = (hourCounts[hourKey] || 0) + 1;
        }
      } catch { /* skip */ }
    }

    // Error patterns (first 80 chars of error/warn messages)
    if (e.level === 'ERROR' || e.level === 'FATAL') {
      const pattern = e.message.substring(0, 80).replace(/\d+/g, 'N').replace(/0x[0-9a-f]+/gi, '0xN');
      errorPatterns[pattern] = (errorPatterns[pattern] || 0) + 1;
    }
  }

  // Sort error patterns by count
  const topErrors = Object.entries(errorPatterns)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([pattern, count]) => ({ pattern, count }));

  // Sort hours
  const hourlyData = Object.entries(hourCounts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([hour, count]) => ({ hour, count }));

  return { levelCounts, hourlyData, topErrors, sources, totalLines: entries.length };
}

// ============================================================
// Tail Mode
// ============================================================
function startTailing(filePath, tabId) {
  if (fileWatchers.has(tabId)) {
    stopTailing(tabId);
  }

  let lastSize = 0;
  try { lastSize = fs.statSync(filePath).size; } catch { /* start from 0 */ }

  const watcher = chokidar.watch(filePath, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on('change', () => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > lastSize) {
        const stream = fs.createReadStream(filePath, { start: lastSize, encoding: 'utf8' });
        let newData = '';
        stream.on('data', (chunk) => { newData += chunk; });
        stream.on('end', () => {
          const lines = newData.split(/\r?\n/).filter(l => l.trim());
          const entries = lines.map((line, i) => parseLogLine(line, -1)); // -1 = tail line
          if (entries.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('tail-data', { tabId, entries });
          }
          lastSize = stat.size;
        });
      } else if (stat.size < lastSize) {
        // File was truncated/rotated - re-read from beginning
        lastSize = stat.size;
      }
    } catch { /* ignore */ }
  });

  fileWatchers.set(tabId, { watcher, path: filePath });
}

function stopTailing(tabId) {
  const entry = fileWatchers.get(tabId);
  if (entry) {
    entry.watcher.close();
    fileWatchers.delete(tabId);
  }
}

// ============================================================
// Directory Watching
// ============================================================
let dirWatcher = null;
function watchDirectory(dirPath) {
  if (dirWatcher) dirWatcher.close();
  dirWatcher = chokidar.watch(dirPath, {
    persistent: true, depth: 2, ignoreInitial: false,
    ignored: [/node_modules/, /\.git/],
  });

  const logExts = ['.log', '.txt', '.syslog', '.err', '.out'];
  const logFiles = [];

  dirWatcher.on('add', (fp) => {
    const ext = path.extname(fp).toLowerCase();
    if (logExts.includes(ext)) {
      logFiles.push(fp);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dir-file-found', { path: fp, name: path.basename(fp) });
      }
    }
  });

  return logFiles;
}

// ============================================================
// File Dialog
// ============================================================
async function openFileDialog() {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Log Files', extensions: ['log', 'txt', 'syslog', 'err', 'out', 'csv'] },
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
  if (result.canceled) return false;

  if (format === 'json') {
    fs.writeFileSync(result.filePath, JSON.stringify(entries, null, 2));
  } else {
    const header = 'Line,Level,Timestamp,Source,Message\n';
    const rows = entries.map(e => {
      const msg = (e.message || e.raw || '').replace(/"/g, '""');
      return `${e.line},"${e.level}","${e.timestamp || ''}","${e.source || ''}","${msg}"`;
    }).join('\n');
    fs.writeFileSync(result.filePath, header + rows);
  }
  return true;
}

// ============================================================
// IPC Handlers
// ============================================================
function setupIPC() {
  // File operations
  ipcMain.handle('open-file-dialog', async () => openFileDialog());
  ipcMain.handle('open-dir-dialog', async () => openDirDialog());

  ipcMain.handle('read-log-file', async (_e, filePath) => {
    try {
      const entries = await readLogFile(filePath);
      const stats = computeStats(entries);
      const fileStats = getFileStats(filePath);
      return { entries, stats, fileStats, name: path.basename(filePath), path: filePath };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('get-file-stats', (_e, filePath) => getFileStats(filePath));

  // Tail mode
  ipcMain.handle('start-tail', (_e, filePath, tabId) => {
    startTailing(filePath, tabId);
    return true;
  });

  ipcMain.handle('stop-tail', (_e, tabId) => {
    stopTailing(tabId);
    return true;
  });

  // Directory watching
  ipcMain.handle('watch-directory', (_e, dirPath) => {
    return watchDirectory(dirPath);
  });

  // Export
  ipcMain.handle('export-data', async (_e, entries, format) => exportData(entries, format));

  // Bookmarks (stored in prefs)
  ipcMain.handle('get-bookmarks', (_e, filePath) => {
    const prefs = loadPrefs();
    return (prefs.bookmarks && prefs.bookmarks[filePath]) || [];
  });

  ipcMain.handle('set-bookmarks', (_e, filePath, bookmarks) => {
    const prefs = loadPrefs();
    if (!prefs.bookmarks) prefs.bookmarks = {};
    prefs.bookmarks[filePath] = bookmarks;
    savePrefs(prefs);
    return true;
  });

  // Recent files
  ipcMain.handle('get-recent-files', () => {
    const prefs = loadPrefs();
    return prefs.recentFiles || [];
  });

  ipcMain.handle('add-recent-file', (_e, filePath) => {
    const prefs = loadPrefs();
    if (!prefs.recentFiles) prefs.recentFiles = [];
    prefs.recentFiles = prefs.recentFiles.filter(f => f !== filePath);
    prefs.recentFiles.unshift(filePath);
    prefs.recentFiles = prefs.recentFiles.slice(0, 20);
    savePrefs(prefs);
    return prefs.recentFiles;
  });

  // Window controls
  ipcMain.handle('minimize-window', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.handle('maximize-window', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  });
  ipcMain.handle('close-window', () => { if (mainWindow) mainWindow.hide(); });
  ipcMain.handle('is-maximized', () => mainWindow ? mainWindow.isMaximized() : false);

  // Reveal in explorer
  ipcMain.handle('reveal-in-explorer', (_e, filePath) => {
    shell.showItemInFolder(filePath);
  });
}

// ============================================================
// Utilities
// ============================================================
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ============================================================
// Lifecycle
// ============================================================
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });

  app.whenReady().then(() => {
    setupIPC();
    createWindow();
    createTray();

    try { globalShortcut.register('Ctrl+Shift+L', toggleWindow); } catch {}
  });

  app.on('before-quit', () => { isQuitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    for (const [tabId] of fileWatchers) stopTailing(tabId);
    if (dirWatcher) dirWatcher.close();
  });
  app.on('window-all-closed', (e) => e.preventDefault());
}
