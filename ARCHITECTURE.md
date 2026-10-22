# LogLab architecture

LogLab is a single-window Electron desktop app for opening, searching and
live-tailing log files. There is no server or network component: everything
runs locally on files the user chooses.

## How it runs

```
npm start  →  electron .  →  main.js (main process)
                               ├─ creates a frameless BrowserWindow
                               │    preload.js  (contextBridge → window.loglab)
                               │    renderer/index.html
                               │      ├─ lib/shared.js   (window.LogLabShared)
                               │      └─ renderer/app.js (all UI logic)
                               ├─ tray icon + global shortcut Ctrl+Shift+L
                               └─ IPC handlers (ipcMain.handle)
```

The window runs with `contextIsolation: true`, `nodeIntegration: false` and
`sandbox: true`. The renderer has no Node access; everything privileged goes
through the `window.loglab` API in `preload.js`, and the main process only
accepts IPC from the main frame of its own window. Child windows are denied
(http/https links open in the system browser), navigation is blocked, and the
page has a strict Content-Security-Policy.

## Modules

| File | Process | Responsibility |
|---|---|---|
| `main.js` | main | Window/tray lifecycle, single-instance lock, command-line / file-association opening, prefs & window state, file dialogs, export, tail and directory watchers, IPC handlers |
| `preload.js` | preload | Exposes `window.loglab` (thin `ipcRenderer.invoke` wrappers, `webUtils.getPathForFile` for drag & drop) |
| `lib/shared.js` | both | Pure logic (UMD): line parsing, timestamp → epoch parsing, stats, search compilation + ReDoS guard, filter predicate, time-budgeted filtering, range-based highlighting, CSV export |
| `lib/logfile.js` | main | `readLogFile` (plain UTF-8 / UTF-16LE / gzip, stops at Max Lines) and `Tailer` (incremental reads for tail mode) |
| `renderer/app.js` | renderer | State, tabs, virtual scrolling, search/filter UI, stats panel, timeline canvas, bookmarks, settings, modals, drag & drop |
| `renderer/index.html`, `styles.css` | renderer | Markup and Catppuccin Mocha styling |
| `renderer/kccs-branding.js` | — | Shared KCCS footer module; **not loaded** by this app (the footer is inline in `index.html`) |

## Data flow

### Opening a file
1. User picks a file (dialog, drag & drop, recent list, directory watch, or
   command-line argument via file association).
2. Renderer calls `loglab.readLogFile(path, maxLines)`.
3. Main: `readLogFile` streams the file through `readline`, calling
   `parseLogLine` for each non-blank line → `{ line, raw, level, timestamp,
   time, source, message }`. `time` is epoch ms (or null). Reading stops at
   Max Lines. `computeStats` builds level counts, per-hour buckets (local
   time), top error patterns and source counts.
4. The whole entry array is returned over IPC (structured clone) and stored on
   the tab. `endOffset`/`lineCount` are kept so tail mode can resume exactly
   where the read stopped.

### Viewing, search and filtering
- `tab.entries` holds all lines; `tab.filteredEntries` is the result of the
  level / advanced-search predicate (`buildEntryFilter`).
- Virtual scrolling: a spacer of `filteredEntries.length × 20px` gives the
  scrollbar its size; only the visible lines (+25 buffer each side) are built
  as DOM nodes on every scroll event.
- Quick search computes matching indices (`findMatches`) for F3 navigation;
  highlighting is done per rendered line by `highlightLine`, which computes
  ranges on the raw text and escapes each segment.
- User regexes are compiled by `compileSearch`, which rejects nested
  quantifiers (`(a+)+`-style catastrophic backtracking). Filtering and search
  passes stop after a 4 s budget and say the results are partial.

### Tail mode
1. Renderer calls `loglab.startTail(path, tabId, { offset, lineNum, encoding })`.
2. Main creates a `Tailer` and a chokidar watcher on the file. On `change` /
   `add` it calls `tailer.check()`; on `unlink` it marks the file rotated.
3. `Tailer` reads `[pos, size)` (≤16 MB per pass) with a short-lived file
   handle, consumes only up to the last newline, numbers the lines, and sends
   `tail-data` to the renderer. Overlapping checks are coalesced. A smaller
   file or a different file identity means rotation: it restarts at offset 0.
4. Renderer appends entries, applies the current filter and quick search to
   the new lines, updates stats with `updateStats`, and auto-scrolls.

### Persistence
`%APPDATA%\LogLab\loglab-prefs.json` (settings, bookmarks keyed by file path,
recent files) and `window-state.json`, both written atomically. Earlier builds
wrote these next to the app; they are copied over once on first run.

## Known limitations
- Every entry is held in renderer memory and sent over IPC at once. Max Lines
  (default 500 000) is the guard against running out of memory.
- Line wrap mode uses the fixed 20 px line height for virtual scrolling, so
  wrapped lines can overlap or leave gaps.
- The ReDoS guard is a heuristic: it catches nested quantifiers but not, for
  example, overlapping alternation like `(a|aa)+`. The time budget limits how
  long a whole pass can take, but it can't interrupt a single slow `test()`.
- Tail is not available for `.gz` files. UTF-16BE is not detected.
