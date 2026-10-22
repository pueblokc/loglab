# Cloud Wave 2 report: LogLab

Branch: `claude/cloud-wave2-2026-10-22` (not merged, no PR, no release)
Date: 2026-10-22

## TL;DR

1. **Remote-site file access (security, fixed).** The footer link (`target="_blank"`) opened kccsonline.com in a new Electron window. That window inherited the preload, so the remote site got `window.loglab`, which can read any local file. Now child windows are denied, links open in the system browser, navigation is blocked, the renderer is sandboxed with a strict CSP, and IPC only accepts calls from the app's own main frame.
2. **Several headline features were broken and now work:**
   - **Drag & drop:** it used `File.path`, which was removed in Electron 32.
   - **Settings and bookmarks:** they were written into the app folder, which is read-only once the app is installed, so they never saved.
   - **Double-click to open:** the `.log`/`.txt` file association was registered, but the app ignored the file it was launched with.
   - **Tail mode:** it stalled on busy logs, duplicated or split lines, dropped everything written after a rotation, and an I/O error could crash the main process.
   - **CI:** `npm ci` failed because the lockfile was out of sync.
3. **Catastrophic regex hangs are mitigated.** Nested-quantifier patterns such as `(a+)+` are rejected. Every filter or search pass has a 4 s budget and then reports partial results. Highlighting now works on the raw text, so a search can no longer corrupt the rendered HTML.
4. **Electron 34 → 44.** 34 is end-of-life and has dozens of published advisories, including a context-isolation bypass. This still **needs a real Windows smoke test** (see "Needs Justin").
5. **Tests and CI added:** 46 `node:test` tests, an ESLint 9 config, and GitHub Actions running lint and tests on Ubuntu and Windows. CI is green. I also smoke-tested the real app in Electron 44 under Xvfb with Playwright.

No secrets, tokens, IPs, internal hostnames or personal paths were found in the code, git history or screenshots. The screenshots show synthetic data with `C:/logs/api-gateway.log`.

## Commits

| Hash | What |
|---|---|
| `f66d6c3` | Regenerate the out-of-sync lockfile; Electron 34 → 44.9.3, electron-builder 25 → 26; add ESLint |
| `23fad81` | New `lib/shared.js` (pure logic, shared by main and renderer) and `lib/logfile.js` (reader + `Tailer`) |
| `f4997ea` | Main process: tail rewrite, prefs location, file-association opening, Electron hardening, safe export |
| `defe68b` | Renderer: drag-drop, highlighting, ReDoS guard, tail filtering and line numbers, dir-watch cap, CSP |
| `f37658e` | Test suite, ESLint config, CI workflow; fix `errorPattern` hex normalisation |
| `525b6d7` | `ARCHITECTURE.md`; README corrected to match the code |
| (this commit) | This report |

## Bugs found and fixed

Line numbers refer to the **original** code at `f94e9c5`.

| # | Where | Symptom | Fix |
|---|---|---|---|
| 1 | `renderer/app.js:1095` | Drag & drop did nothing. `File.path` was removed in Electron 32, and the app ships Electron 34. | `webUtils.getPathForFile` exposed via preload |
| 2 | `main.js:10-11` | Prefs, bookmarks, recent files and window state are written to `__dirname`. That is inside `app.asar` / Program Files once installed, and errors were swallowed, so **nothing ever persisted**. | Now in `app.getPath('userData')`; v1.0.0 files are migrated once; atomic write (tmp + rename) so a crash can't corrupt prefs and wipe bookmarks |
| 3 | `package.json:27-30` / `main.js:586` | The `.log`/`.txt` file association was registered, but `process.argv` and the `second-instance` argv were never read, so double-clicking a log opened an empty window | Parse argv at startup and on `second-instance`; the renderer pulls queued files once it is ready |
| 4 | `main.js:359-362` | Tail used `awaitWriteFinish`. A log written more often than every 200 ms never becomes "stable", so **tail never fired on busy logs** | Removed. The new `Tailer` only consumes complete lines, so reading mid-write is safe |
| 5 | `main.js:366-378` | Overlapping `change` events read the same byte range twice (duplicate lines) because `lastSize` only updated when the stream ended | `Tailer` coalesces checks and advances its position before emitting |
| 6 | `main.js:371-374` | A half-written last line was emitted as one line, and the rest became a second line | Only bytes up to the last newline are consumed |
| 7 | `main.js:379-382` | Truncation set `lastSize = size` and never re-read, so content after a copytruncate rotation was lost. Rename rotation wasn't detected at all. | Restart at offset 0 on a smaller size, a changed file identity (dev/ino/birthtime), or `unlink`+`add` |
| 8 | `main.js:368` | The tail `createReadStream` had no `error` listener. A deleted or locked file (EBUSY on Windows) threw an uncaught exception in the **main process** | Reads use `fs.promises` handles inside try/finally; errors are reported to the UI and handles are always closed |
| 9 | `main.js:220-224` | A missing or corrupt `.gz` file: `fileStream` errors weren't forwarded through `.pipe()`, giving an unhandled error and a promise that never settled | `stream.pipeline` |
| 10 | `main.js:233-234` | Max Lines only stopped *parsing*; the whole file was still read (a 10 GB log was scanned to the end) | Close readline and destroy the stream at the limit; the UI says the file was truncated |
| 11 | `main.js:273`, `315` | Syslog stamps (`Jan 15 10:30:00`) have no year, and V8 parses them as **2001**. Hourly stats were bucketed in 2001, and the date-range filter excluded every syslog line | `parseTimestamp`: current year, or last year if that would be in the future. Also handles Apache `+0100` offsets, epoch seconds, `+0200` offsets without a colon and >3-digit fractions |
| 12 | `main.js:283`, `331` | Error-pattern normalisation replaced digits before hex, so `0x1f` became `0xNf` (and my first fix gave `NxN`) | One-pass replace |
| 13 | `main.js:332-340` | Once 20 error patterns existed, any **new** error type during tail had count 1, sorted last, and was cut off. New errors never showed up. | Stats keep the full pattern map (capped at 10k) and recompute the top 20 |
| 14 | `renderer/app.js:596` | `tab.stats = await updateStats(tab.stats, …)` across IPC: two tail events in flight both started from the same old stats, so counts were lost | `updateStats` now runs synchronously in the renderer (shared module) |
| 15 | `renderer/app.js:565-589` | Tail lines ignored the advanced-search **date range**, and quick-search matches weren't updated for new lines | One shared filter predicate is used by `applyFilters`, tail and the preview count |
| 16 | `renderer/app.js:559` | Tail line numbers were `entries.length + 1`, which skips blank lines and ignores truncation, so the numbers drifted from the real file | The read returns `lineCount`/`endOffset`; tail continues from them, so there's no gap or duplication between the read and the tail start |
| 17 | `renderer/app.js:206-252` | Search regexes ran over **already-escaped HTML with spans inserted**. Searching `span`, `ts`, `src`, `lt`, `amp` or `class` corrupted the line's markup; `&`/`<` didn't highlight; wrapping the user regex in `( )` broke backreferences | `highlightLine` builds ranges on the raw text and escapes each segment |
| 18 | `renderer/app.js:167` | `searchMatches.includes(idx)` for every rendered line: O(matches) per line on every scroll event (500k matches × ~80 lines) | `Set` |
| 19 | `renderer/app.js:243` | `new RegExp` per rendered line per frame | Cached compiled regex |
| 20 | `renderer/app.js:704`, `757` | `Math.max(...array)` throws a RangeError on very large arrays | `maxOf` reduce |
| 21 | `renderer/app.js:612-615` | Directory watch: `tabs.length < 5` was checked before any async load finished, so watching a folder with 50 logs opened 50 files at once | Counts loads in flight |
| 22 | `renderer/app.js:914-918` | Go-to-line fallback jumped to index `line-1` of the *filtered* list, an unrelated line | Binary search for the first shown line at or after the requested line |
| 23 | `renderer/app.js:425-448` | The Tail button state wasn't updated when switching tabs or closing the last tab | Synced in `switchTab` / `closeTab` |
| 24 | `renderer/app.js:505` | The status bar always said UTF-8. UTF-16LE files (PowerShell `>` output) loaded as garbage | BOM detection in the reader and tailer; encoding shown per tab |
| 25 | `main.js:236` | A UTF-8 BOM stayed on line 1, which broke the `^` epoch timestamp match | Stripped |
| 26 | `main.js:202` | The syslog message was found with `indexOf(source)`, which breaks when the hostname contains the process name | Uses the regex match length |
| 27 | `main.js:461`, `468` | `writeFileSync` errors in export rejected the IPC call, so the UI got no feedback | Caught and shown in the status bar |
| 28 | `main.js` (no handler) | Reloading the renderer orphaned chokidar watchers | All watchers stop on `did-start-loading` |
| 29 | `renderer/app.js:290-298` | The date-range "To" (minute precision) excluded seconds 1–59 of that minute | The upper bound includes the whole minute |

## Security findings

### Fixed
- **Preload exposed to a remote origin** (`renderer/index.html:289` + `main.js:122`). A `target="_blank"` link created a child BrowserWindow with the parent's webPreferences (preload included), so a website got the `window.loglab` file-read API. Fixed with `setWindowOpenHandler` (deny; `https?` opens via `shell.openExternal`) and `will-navigate` blocking.
- **Renderer hardening:** `sandbox: true` explicitly; a strict CSP (`default-src 'none'; script-src 'self'`; inline script moved into `app.js`); permission requests denied; IPC handlers reject callers that aren't the main window's top frame; IPC string arguments validated.
- **CSV/formula injection in export** (`main.js:463-468`). Log text from web logs etc. went into CSV cells raw (`=HYPERLINK(...)`), and the source and timestamp columns weren't quote-escaped. All fields are now quoted, and formula-leading cells get a `'` prefix.
- **ReDoS (self-inflicted UI freeze):** nested-quantifier guard plus time budget (see TL;DR).
- **Dependencies:** Electron 34 (EOL, roughly 40 advisories in `npm audit`) → 44.9.3. electron-builder 26 removes the high-severity `extract-zip` / `http-cache-semantics` findings.
- XSS review: every `innerHTML` that takes log-derived text goes through `escapeHtml`. File names in tabs and recent files were already escaped or used `textContent`. Highlighting is now structurally safe too.

### Not fixed (with why)
- **8 moderate `npm audit` findings remain**, all in the **build-time** chain `electron-builder → app-builder-lib → @electron/get@3 → global-agent → roarr → sprintf-js` (sprintf-js DoS). They aren't shipped in the app and there is no fix within electron-builder 26 yet. I left them alone.
- **The renderer can ask main to read any path** (`read-log-file`), as the app's design requires. With the sandbox, CSP and IPC sender checks, exploiting this would need code execution in the renderer first. Restricting it to paths the user picked would be a design change.
- **Release integrity:** there are no `asarIntegrity` / Electron fuses and no code signing in the build config. That needs your signing certificate and decision.
- `renderer/kccs-branding.js` is unused here, and it also uses `target="_blank"`. It's harmless now (the window-open handler covers it), but it may be worth fixing in the shared copy used by other KCCS apps.

## Tests

```bash
npm ci            # set ELECTRON_SKIP_BINARY_DOWNLOAD=1 to skip the Electron binary
npm test          # node --test "test/**/*.test.js"
npm run lint      # eslint .
```

- **46 tests, 46 passing, 0 failing** locally (Node 22). I also ran them with `TZ=America/Denver`, `Asia/Kolkata` and `Pacific/Auckland`: all pass. CI is green on `ubuntu-latest` and `windows-latest`.
- `test/shared.test.js` (27 tests): timestamps and timezones, parsing, stats, the ReDoS guard, filters, the time budget, highlighting and escaping, CSV.
- `test/logfile.test.js` (19 tests): reading (BOM, UTF-16LE, gzip, corrupt or missing files, maxLines, fd-leak check) and the Tailer (offset hand-off, partial lines, 50 overlapping checks without duplicates, truncation, rename rotation, UTF-16 appends, deleted file, fd-leak check, close).
- **Manual end-to-end smoke** (not in CI): launched the real app with Electron 44 under Xvfb via Playwright, opening a file passed on the command line. Verified that rendering, highlighting/escaping, search, the catastrophic-regex message, tail with a partial line, line numbering, rotation, a footer click opening no new window, IPC, and zero console errors all worked.
- Performance check: reading 500k lines of a 1M-line file took 1.2 s, stats 0.4 s, and a regex filter over 500k lines 25 ms.

## Needs Justin

1. **Smoke test the Electron 44 upgrade on real Windows:**
   - `npm ci && npm start`
   - Open a file, drag & drop a file, tail a live log (try a rotating one), use the tray, Ctrl+Shift+L, and export CSV and JSON.
   - `npm run build`, install, then double-click a `.log` file in Explorer.
   If anything is off, `f66d6c3` can be reverted on its own, but the drag-drop fix still needs `webUtils`, which exists since Electron 29.
2. **Settings moved** to `%APPDATA%\LogLab\`. Existing `loglab-prefs.json` / `window-state.json` next to a *source checkout* are copied over on first run. Installed builds never managed to save anything, so nothing is lost there.
3. **Decide on code signing / Electron fuses** (asar integrity, `RunAsNode` off) for releases.
4. **Line-wrap mode** is still approximate: virtual scrolling assumes 20 px rows. Fixing it properly needs measured row heights (a design change), so I documented it instead.
5. **Memory model:** every line is held in the renderer and sent over IPC in one go. Max Lines (500k) is the guard. Paging from the main process would be a bigger refactor.
6. Credentials to rotate: **none found.**
7. No deploy steps are needed. CI needs no secrets.

## Things I was unsure about

- **Electron major bump:** the brief says no framework migrations unless the framework is end-of-life and broken. Electron 34 is EOL, carries a context-isolation-bypass advisory, and broke drag & drop, so I bumped it. I chose 44.x over the one-day-old 45.0.0.
- **Date filter on unparseable timestamps:** lines with *no* timestamp are kept, as before. Lines whose timestamp was found but can't be parsed are excluded, also as before. With the new parser that case is rare.
- **Line numbers after rotation:** the main process numbers the new file from 1, but the renderer keeps numbering on from the existing lines so bookmarks and go-to-line stay consistent within the tab.
- **The ReDoS guard is a heuristic.** It catches nested quantifiers but not overlapping alternation like `(a|aa)+`. The time budget limits how long a whole pass can take, but it can't interrupt one pathological `test()` on a single huge line. A fully safe option would be running searches in a Worker with a hard timeout, a larger change.
- **Tail starts with no offset when the read was truncated (Max Lines) or the file is gzip.** In the truncated case it starts at end of file and the line numbers continue from the last loaded line, so they don't match the real file.
