// ============================================================
// LogLab — shared pure logic
// Loaded by the main process via require() and by the renderer via a
// <script> tag (exposed as window.LogLabShared). No Node or DOM APIs here.
// ============================================================

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LogLabShared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LEVELS = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG'];
  const TOP_ERRORS = 20;
  // Cap on distinct error patterns tracked for incremental (tail) stats.
  const MAX_ERROR_PATTERNS = 10000;

  const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const MONTH_ALT = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';

  // ============================================================
  // Timestamps
  // ============================================================
  const TS_PATTERNS = [
    // ISO 8601: 2024-01-15T10:30:00.000Z
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/,
    // Common log: 2024-01-15 10:30:00
    /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)/,
    // Syslog: Jan 15 10:30:00
    new RegExp(`((?:${MONTH_ALT})\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2})`),
    // Apache/Nginx: [15/Jan/2024:10:30:00 +0000]
    /\[(\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2}\s+[+-]\d{4})\]/,
    // Epoch seconds
    /^(\d{10}(?:\.\d+)?)\s/,
  ];

  const RE_ISO = /^(\d{4}-\d{2}-\d{2})[T\s]+(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;
  const RE_SYSLOG = new RegExp(`^(${MONTH_ALT})\\s+(\\d{1,2})\\s+(\\d{2}):(\\d{2}):(\\d{2})$`);
  const RE_APACHE = /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s+([+-])(\d{2})(\d{2})$/;
  const RE_EPOCH = /^\d{10}(?:\.\d+)?$/;

  // Convert an extracted timestamp string to epoch milliseconds (or null).
  // Timestamps without a zone are interpreted as local time. Syslog stamps
  // carry no year: assume the current one, or last year if that would put the
  // stamp more than a day in the future (e.g. reading December logs in January).
  function parseTimestamp(ts, now) {
    if (!ts) return null;
    let m = RE_ISO.exec(ts);
    if (m) {
      const frac = m[3] ? '.' + (m[3] + '00').substring(0, 3) : '';
      let zone = m[4] || '';
      if (zone && zone !== 'Z' && zone.indexOf(':') === -1) zone = zone.substring(0, 3) + ':' + zone.substring(3);
      const t = Date.parse(`${m[1]}T${m[2]}${frac}${zone}`);
      return isNaN(t) ? null : t;
    }
    m = RE_SYSLOG.exec(ts);
    if (m) {
      const ref = now || new Date();
      const mon = MONTHS[m[1]];
      let d = new Date(ref.getFullYear(), mon, +m[2], +m[3], +m[4], +m[5]);
      if (d.getTime() > ref.getTime() + 86400000) d = new Date(ref.getFullYear() - 1, mon, +m[2], +m[3], +m[4], +m[5]);
      return isNaN(d.getTime()) ? null : d.getTime();
    }
    m = RE_APACHE.exec(ts);
    if (m) {
      const mon = MONTHS[m[2]];
      if (mon === undefined) return null;
      const utc = Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +m[6]);
      const offsetMs = (m[7] === '-' ? -1 : 1) * (+m[8] * 60 + +m[9]) * 60000;
      return utc - offsetMs;
    }
    if (RE_EPOCH.test(ts)) return Math.round(parseFloat(ts) * 1000);
    const t = Date.parse(ts);
    return isNaN(t) ? null : t;
  }

  // ============================================================
  // Line parsing
  // ============================================================
  const RE_SYSLOG_SOURCE = /^\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+(\S+)\s+(\S+?)(?:\[\d+\])?:/;

  // Parse a single log line - detect level, timestamp, source
  function parseLogLine(line, lineNum, now) {
    const entry = { line: lineNum, raw: line, level: 'INFO', timestamp: null, time: null, source: '', message: line };

    if (/\b(FATAL|CRIT(?:ICAL)?)\b/i.test(line)) entry.level = 'FATAL';
    else if (/\b(ERR(?:OR)?)\b/i.test(line)) entry.level = 'ERROR';
    else if (/\b(WARN(?:ING)?)\b/i.test(line)) entry.level = 'WARN';
    else if (/\b(DEBUG|TRACE|VERBOSE)\b/i.test(line)) entry.level = 'DEBUG';

    for (const pat of TS_PATTERNS) {
      const m = pat.exec(line);
      if (m) {
        entry.timestamp = m[1];
        entry.time = parseTimestamp(m[1], now);
        break;
      }
    }

    // Syslog format: "Mon DD HH:MM:SS hostname process[pid]: message"
    const sm = RE_SYSLOG_SOURCE.exec(line);
    if (sm) {
      entry.source = sm[2];
      entry.message = line.substring(sm[0].length).replace(/^\s+/, '');
    }

    return entry;
  }

  // Epoch ms for an entry, tolerating entries created before `time` existed.
  function entryTime(e, now) {
    if (e.time !== undefined) return e.time;
    return parseTimestamp(e.timestamp, now);
  }

  // ============================================================
  // Statistics
  // ============================================================
  function pad2(n) { return String(n).padStart(2, '0'); }

  function hourKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:00`;
  }

  // Normalise an error message so repeats group together. Hex runs must be
  // replaced before plain digits or "0x1f" would become "0xNf".
  function errorPattern(message) {
    return String(message || '').substring(0, 80).replace(/0x[0-9a-f]+/gi, '0xN').replace(/\d+/g, 'N');
  }

  function topErrorsFrom(counts) {
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_ERRORS)
      .map(([pattern, count]) => ({ pattern, count }));
  }

  function computeStats(entries) {
    return updateStats(emptyStats(), entries);
  }

  function emptyStats() {
    return {
      levelCounts: { FATAL: 0, ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 },
      hourlyData: [], topErrors: [], sources: {}, totalLines: 0,
      errorPatternCounts: {},
    };
  }

  // Incrementally fold new entries into existing stats (used by tail mode).
  function updateStats(existingStats, newEntries) {
    const s = existingStats;
    if (!s.errorPatternCounts) {
      // Stats produced by an older version: seed from what we have.
      s.errorPatternCounts = {};
      for (const ep of s.topErrors || []) s.errorPatternCounts[ep.pattern] = ep.count;
    }
    const patterns = s.errorPatternCounts;
    let patternCount = Object.keys(patterns).length;
    const hours = new Map((s.hourlyData || []).map(h => [h.hour, h]));
    let hoursChanged = false;
    let errorsChanged = false;
    const now = new Date();

    for (const e of newEntries) {
      if (s.levelCounts[e.level] !== undefined) s.levelCounts[e.level]++;
      if (e.source) s.sources[e.source] = (s.sources[e.source] || 0) + 1;

      const t = entryTime(e, now);
      if (t !== null && !isNaN(t)) {
        const key = hourKey(t);
        const h = hours.get(key);
        if (h) h.count++;
        else { hours.set(key, { hour: key, count: 1 }); hoursChanged = true; }
      }

      if (e.level === 'ERROR' || e.level === 'FATAL') {
        const p = errorPattern(e.message);
        if (patterns[p] !== undefined) patterns[p]++;
        else if (patternCount < MAX_ERROR_PATTERNS) { patterns[p] = 1; patternCount++; }
        errorsChanged = true;
      }
    }

    if (hoursChanged || !s.hourlyData) {
      s.hourlyData = Array.from(hours.values()).sort((a, b) => a.hour.localeCompare(b.hour));
    }
    if (errorsChanged) s.topErrors = topErrorsFrom(patterns);
    s.totalLines += newEntries.length;
    return s;
  }

  function maxOf(arr, fn) {
    let m = -Infinity;
    for (const x of arr) { const v = fn(x); if (v > m) m = v; }
    return m;
  }

  // ============================================================
  // Search / filtering
  // ============================================================
  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Heuristic check for patterns with exponential backtracking, i.e. an
  // unbounded quantifier applied to a group that itself contains an unbounded
  // quantifier: (a+)+, (\w*)*, (x+y?){2,} ... These can freeze the UI on a
  // single line. Polynomial cases (.*.*.*) are left to the time budget.
  function isCatastrophicRegex(pattern) {
    const stack = [];          // per open group: contains an unbounded quantifier?
    let lastGroupInner = false; // flag of the group that just closed
    let afterGroup = false;     // previous token was ')'
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === '\\') { i++; afterGroup = false; continue; }
      if (inClass) { if (c === ']') inClass = false; continue; }
      if (c === '[') { inClass = true; afterGroup = false; continue; }
      if (c === '(') { stack.push(false); afterGroup = false; continue; }
      if (c === ')') {
        lastGroupInner = stack.length ? stack.pop() : false;
        if (lastGroupInner && stack.length) stack[stack.length - 1] = true;
        afterGroup = true;
        continue;
      }
      let unbounded;
      if (c === '*' || c === '+') unbounded = true;
      else if (c === '?') unbounded = false;
      else if (c === '{' && /^\{\d*,?\d*\}/.test(pattern.substring(i))) {
        const m = /^\{(\d*)(,?)(\d*)\}/.exec(pattern.substring(i));
        unbounded = m[2] === ',' && m[3] === '';
        i += m[0].length - 1;
      } else { afterGroup = false; continue; }

      if (unbounded) {
        if (afterGroup && lastGroupInner) return true;
        if (stack.length) stack[stack.length - 1] = true;
      }
      afterGroup = false;
    }
    return false;
  }

  // Compile a user search into a RegExp. Returns { re, error }.
  function compileSearch(query, opts) {
    const o = opts || {};
    if (!query) return { re: null, error: null };
    const flags = (o.caseSensitive ? '' : 'i') + (o.global ? 'g' : '');
    if (o.regex && isCatastrophicRegex(query)) {
      return { re: null, error: 'Pattern has nested quantifiers and could hang' };
    }
    try {
      return { re: new RegExp(o.regex ? query : escapeRegex(query), flags), error: null };
    } catch (err) {
      return { re: null, error: 'Invalid regex' };
    }
  }

  // datetime-local inputs have minute precision ("2024-01-15T10:30"); make the
  // upper bound include the whole minute.
  function parseFilterDate(value, isUpper) {
    if (!value) return isUpper ? Infinity : -Infinity;
    const t = new Date(value).getTime();
    if (isNaN(t)) return isUpper ? Infinity : -Infinity;
    if (isUpper && /T\d{2}:\d{2}$/.test(value)) return t + 59999;
    return t;
  }

  // Build a predicate for the level / advanced-search criteria.
  // criteria: { level, text, regex, caseSensitive, fromDate, toDate, source }
  // Returns { test(entry) -> bool, error }.
  function buildEntryFilter(criteria) {
    const c = criteria || {};
    const checks = [];
    let error = null;

    if (c.level && c.level !== 'all') checks.push(e => e.level === c.level);

    if (c.text) {
      const { re, error: err } = compileSearch(c.text, { regex: c.regex, caseSensitive: c.caseSensitive });
      if (re) checks.push(e => re.test(e.raw));
      else error = err;
    }

    if (c.fromDate || c.toDate) {
      const from = parseFilterDate(c.fromDate, false);
      const to = parseFilterDate(c.toDate, true);
      const now = new Date();
      checks.push(e => {
        if (!e.timestamp) return true; // keep lines without timestamps
        const t = entryTime(e, now);
        return t !== null && t >= from && t <= to;
      });
    }

    if (c.source) {
      const needle = String(c.source).toLowerCase();
      checks.push(e => (e.source || '').toLowerCase().includes(needle));
    }

    const test = checks.length === 0
      ? () => true
      : (e) => { for (const fn of checks) if (!fn(e)) return false; return true; };
    return { test, error };
  }

  // Filter with a wall-clock budget so a slow pattern over millions of lines
  // can't lock the UI indefinitely. Returns { entries, timedOut }.
  function filterEntries(entries, test, budgetMs) {
    if (!budgetMs || budgetMs === Infinity) return { entries: entries.filter(test), timedOut: false };
    const out = [];
    const deadline = Date.now() + budgetMs;
    for (let i = 0; i < entries.length; i++) {
      if ((i & 1023) === 0 && i > 0 && Date.now() > deadline) return { entries: out, timedOut: true };
      if (test(entries[i])) out.push(entries[i]);
    }
    return { entries: out, timedOut: false };
  }

  // Indices into `entries` that match `re` (non-global regex).
  function findMatches(entries, re, budgetMs) {
    const out = [];
    const deadline = budgetMs ? Date.now() + budgetMs : Infinity;
    for (let i = 0; i < entries.length; i++) {
      if ((i & 1023) === 0 && i > 0 && Date.now() > deadline) return { matches: out, timedOut: true };
      if (re.test(entries[i].raw)) out.push(i);
    }
    return { matches: out, timedOut: false };
  }

  // Binary search: index of the first entry whose line number is >= lineNum.
  // Entries are kept in ascending line order. Returns -1 if none.
  function findLineIndex(entries, lineNum) {
    let lo = 0, hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (entries[mid].line < lineNum) lo = mid + 1; else hi = mid;
    }
    return lo < entries.length ? lo : -1;
  }

  // ============================================================
  // Highlighting
  // ============================================================
  const LEVEL_KEYWORDS = {
    FATAL: /\b(FATAL|CRITICAL|CRIT)\b/gi,
    ERROR: /\b(ERROR|ERR)\b/gi,
    WARN: /\b(WARNING|WARN)\b/gi,
    INFO: /\b(INFO|INFORMATION|NOTICE)\b/gi,
    DEBUG: /\b(DEBUG|TRACE|VERBOSE)\b/gi,
  };
  const MAX_HIGHLIGHTS = 500;

  // Build the HTML for a log line. Ranges are computed on the raw text and
  // each segment is escaped on output, so search terms can never match inside
  // generated markup or HTML entities. `searchRe` must have the 'g' flag.
  function highlightLine(entry, searchRe) {
    const raw = String(entry.raw);
    const base = []; // non-overlapping [start, end, className]

    const overlaps = (s, e) => base.some(r => s < r[1] && e > r[0]);
    let after = 0;
    if (entry.timestamp) {
      const i = raw.indexOf(entry.timestamp);
      if (i >= 0) { base.push([i, i + entry.timestamp.length, 'ts']); after = i + entry.timestamp.length; }
    }
    if (entry.source) {
      const i = raw.indexOf(entry.source, after);
      if (i >= 0 && !overlaps(i, i + entry.source.length)) base.push([i, i + entry.source.length, 'src']);
    }
    const kw = LEVEL_KEYWORDS[entry.level];
    if (kw) {
      kw.lastIndex = 0;
      let m, n = 0;
      while ((m = kw.exec(raw)) && n++ < MAX_HIGHLIGHTS) {
        if (!overlaps(m.index, m.index + m[0].length)) base.push([m.index, m.index + m[0].length, `level-tag level-${entry.level}`]);
      }
    }
    base.sort((a, b) => a[0] - b[0]);

    const hits = [];
    if (searchRe) {
      searchRe.lastIndex = 0;
      let m, n = 0;
      while ((m = searchRe.exec(raw)) && n++ < MAX_HIGHLIGHTS) {
        if (m[0].length === 0) { searchRe.lastIndex++; continue; }
        hits.push([m.index, m.index + m[0].length]);
      }
      searchRe.lastIndex = 0;
    }

    if (base.length === 0 && hits.length === 0) return escapeHtml(raw);

    const cuts = new Set([0, raw.length]);
    for (const r of base) { cuts.add(r[0]); cuts.add(r[1]); }
    for (const r of hits) { cuts.add(r[0]); cuts.add(r[1]); }
    const points = Array.from(cuts).sort((a, b) => a - b);

    let html = '';
    let bi = 0, hi = 0;
    for (let p = 0; p < points.length - 1; p++) {
      const s = points[p], e = points[p + 1];
      if (s === e) continue;
      while (bi < base.length && base[bi][1] <= s) bi++;
      while (hi < hits.length && hits[hi][1] <= s) hi++;
      const cls = bi < base.length && base[bi][0] <= s ? base[bi][2] : null;
      const hit = hi < hits.length && hits[hi][0] <= s;
      let seg = escapeHtml(raw.substring(s, e));
      if (hit) seg = `<span class="search-highlight">${seg}</span>`;
      if (cls) seg = `<span class="${cls}">${seg}</span>`;
      html += seg;
    }
    return html;
  }

  // ============================================================
  // Export
  // ============================================================
  // Quote a CSV cell. Cells that a spreadsheet would treat as a formula are
  // prefixed with an apostrophe (CSV/formula injection from hostile log text).
  function csvCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function toCSV(entries) {
    const header = 'Line,Level,Timestamp,Source,Message';
    const rows = entries.map(e => [
      e.line, csvCell(e.level), csvCell(e.timestamp || ''), csvCell(e.source || ''), csvCell(e.message || e.raw || ''),
    ].join(','));
    return [header].concat(rows).join('\n') + '\n';
  }

  return {
    LEVELS, parseTimestamp, parseLogLine, entryTime,
    hourKey, errorPattern, computeStats, updateStats, maxOf,
    escapeHtml, escapeRegex, isCatastrophicRegex, compileSearch,
    parseFilterDate, buildEntryFilter, filterEntries, findMatches, findLineIndex,
    highlightLine, csvCell, toCSV,
  };
});
