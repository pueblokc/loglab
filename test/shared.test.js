'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/shared');

// Fixed reference "now" (local time) so year inference is deterministic.
const NOW = new Date(2026, 9, 22, 12, 0, 0);

test('parseTimestamp: ISO with Z, offsets and long fractions', () => {
  assert.equal(S.parseTimestamp('2024-01-15T10:30:00Z'), Date.UTC(2024, 0, 15, 10, 30));
  assert.equal(S.parseTimestamp('2024-01-15T10:30:00.123456Z'), Date.UTC(2024, 0, 15, 10, 30, 0, 123));
  assert.equal(S.parseTimestamp('2024-01-15T10:30:00+0200'), Date.UTC(2024, 0, 15, 8, 30));
  assert.equal(S.parseTimestamp('2024-01-15T10:30:00-05:00'), Date.UTC(2024, 0, 15, 15, 30));
});

test('parseTimestamp: zone-less stamps are local time', () => {
  assert.equal(S.parseTimestamp('2024-01-15 10:30:00'), new Date(2024, 0, 15, 10, 30).getTime());
  assert.equal(S.parseTimestamp('2024-01-15 10:30:00.5'), new Date(2024, 0, 15, 10, 30, 0, 500).getTime());
});

test('parseTimestamp: syslog uses the current year, not 2001', () => {
  assert.equal(S.parseTimestamp('Jan 15 10:30:00', NOW), new Date(2026, 0, 15, 10, 30).getTime());
  // A December stamp read in early January belongs to last year.
  const jan = new Date(2027, 0, 2, 9, 0, 0);
  assert.equal(S.parseTimestamp('Dec 31 23:59:00', jan), new Date(2026, 11, 31, 23, 59).getTime());
});

test('parseTimestamp: Apache/Nginx and epoch', () => {
  assert.equal(S.parseTimestamp('15/Jan/2024:10:30:00 +0100'), Date.UTC(2024, 0, 15, 9, 30));
  assert.equal(S.parseTimestamp('15/Jan/2024:10:30:00 -0700'), Date.UTC(2024, 0, 15, 17, 30));
  assert.equal(S.parseTimestamp('1700000000'), 1700000000000);
  assert.equal(S.parseTimestamp('1700000000.25'), 1700000000250);
  assert.equal(S.parseTimestamp('not a date'), null);
  assert.equal(S.parseTimestamp(null), null);
});

test('parseLogLine: level, timestamp, syslog source and message', () => {
  const e = S.parseLogLine('Jan 15 10:30:00 web01 sshd[1234]: error: auth failed', 7, NOW);
  assert.equal(e.line, 7);
  assert.equal(e.level, 'ERROR');
  assert.equal(e.timestamp, 'Jan 15 10:30:00');
  assert.equal(e.time, new Date(2026, 0, 15, 10, 30).getTime());
  assert.equal(e.source, 'sshd');
  assert.equal(e.message, 'error: auth failed');
});

test('parseLogLine: source name that also appears in the hostname', () => {
  const e = S.parseLogLine('Jan 15 10:30:00 cronbox cron[1]: job ran', 1, NOW);
  assert.equal(e.source, 'cron');
  assert.equal(e.message, 'job ran');
});

test('parseLogLine: level precedence and defaults', () => {
  assert.equal(S.parseLogLine('FATAL and ERROR', 1).level, 'FATAL');
  assert.equal(S.parseLogLine('warning: disk', 1).level, 'WARN');
  assert.equal(S.parseLogLine('trace data', 1).level, 'DEBUG');
  assert.equal(S.parseLogLine('nothing special', 1).level, 'INFO');
  assert.equal(S.parseLogLine('terrorist', 1).level, 'INFO'); // word boundary
});

test('parseLogLine: weekday is not mistaken for a syslog month', () => {
  const e = S.parseLogLine('Mon 15 10:30:00 something', 1, NOW);
  assert.equal(e.timestamp, null);
});

test('errorPattern normalises hex before digits', () => {
  assert.equal(S.errorPattern('fault at 0x1f3a code 42'), 'fault at 0xN code N');
});

test('computeStats: levels, hourly buckets, sources, top errors', () => {
  const lines = [
    '2024-01-15 10:01:00 ERROR db timeout 1',
    '2024-01-15 10:02:00 ERROR db timeout 2',
    '2024-01-15 11:00:00 WARN slow',
    'no timestamp INFO',
  ];
  const st = S.computeStats(lines.map((l, i) => S.parseLogLine(l, i + 1)));
  assert.equal(st.levelCounts.ERROR, 2);
  assert.equal(st.levelCounts.WARN, 1);
  assert.equal(st.levelCounts.INFO, 1);
  assert.deepEqual(st.hourlyData, [{ hour: '2024-01-15 10:00', count: 2 }, { hour: '2024-01-15 11:00', count: 1 }]);
  assert.equal(st.topErrors[0].count, 2);
  assert.equal(st.totalLines, 4);
});

test('updateStats: new error patterns still surface when 20 are tracked', () => {
  const entries = [];
  for (let i = 0; i < 20; i++) for (let k = 0; k < 3; k++) entries.push(S.parseLogLine(`ERROR kind${'abcdefghijklmnopqrst'[i]}`, 1));
  const st = S.computeStats(entries);
  assert.equal(st.topErrors.length, 20);
  const burst = [];
  for (let k = 0; k < 10; k++) burst.push(S.parseLogLine('ERROR brand new failure', 1));
  S.updateStats(st, burst);
  assert.equal(st.topErrors[0].pattern, 'ERROR brand new failure');
  assert.equal(st.topErrors[0].count, 10);
});

test('updateStats: accepts stats from v1.0.0 (no errorPatternCounts)', () => {
  const old = { levelCounts: { FATAL: 0, ERROR: 1, WARN: 0, INFO: 0, DEBUG: 0 }, hourlyData: [], topErrors: [{ pattern: 'ERROR x', count: 1 }], sources: {}, totalLines: 1 };
  S.updateStats(old, [S.parseLogLine('ERROR x', 2)]);
  assert.equal(old.topErrors[0].count, 2);
  assert.equal(old.totalLines, 2);
});

test('maxOf handles arrays too large for Math.max(...spread)', () => {
  const big = Array.from({ length: 300000 }, (_, i) => ({ count: i }));
  assert.equal(S.maxOf(big, h => h.count), 299999);
});

test('isCatastrophicRegex flags nested quantifiers only', () => {
  for (const p of ['(a+)+', '(\\w*)*', '((a+))+', '(x+y?){2,}', '(?:\\s*\\w+)+$']) assert.equal(S.isCatastrophicRegex(p), true, p);
  for (const p of ['(a|b)+', '\\d+\\.\\d+', '.*foo.*', '(?:ab)+', '[(a+)]+', '(a{1,3})+', '(a+){3}', '\\(a+\\)+']) assert.equal(S.isCatastrophicRegex(p), false, p);
});

test('compileSearch: literal, regex, invalid and dangerous patterns', () => {
  assert.ok(S.compileSearch('a.b', {}).re.test('xa.bx'));
  assert.equal(S.compileSearch('a.b', {}).re.test('axb'), false);
  assert.ok(S.compileSearch('a.b', { regex: true }).re.test('axb'));
  assert.equal(S.compileSearch('A', { caseSensitive: true }).re.test('a'), false);
  assert.equal(S.compileSearch('(', { regex: true }).error, 'Invalid regex');
  assert.match(S.compileSearch('(a+)+$', { regex: true }).error, /nested quantifiers/);
  assert.equal(S.compileSearch('', {}).re, null);
});

test('buildEntryFilter: level, text, source and date range', () => {
  const now = NOW;
  const es = [
    S.parseLogLine('2024-01-15T10:00:00Z ERROR db failed', 1, now),
    S.parseLogLine('2024-01-15T12:00:00Z INFO ok', 2, now),
    S.parseLogLine('Jan 15 10:30:00 host nginx[1]: WARN slow', 3, now),
    S.parseLogLine('no timestamp here', 4, now),
  ];
  const run = (c) => es.filter(S.buildEntryFilter(c).test).map(e => e.line);
  assert.deepEqual(run({ level: 'ERROR' }), [1]);
  assert.deepEqual(run({ level: 'all', text: 'OK' }), [2]);
  assert.deepEqual(run({ text: 'OK', caseSensitive: true }), []);
  assert.deepEqual(run({ source: 'NGIN' }), [3]);
  // Syslog line from "this year" (2026) is outside a 2024 range; untimestamped lines are kept.
  assert.deepEqual(run({ fromDate: '2024-01-15T00:00Z', toDate: '2024-01-15T11:00Z' }), [1, 4]);
  assert.deepEqual(run({ fromDate: '2026-01-15T10:00', toDate: '2026-01-15T10:30' }), [3, 4]);
});

test('buildEntryFilter: datetime-local upper bound includes the whole minute', () => {
  const e = S.parseLogLine('2024-01-15 10:30:45 INFO x', 1);
  assert.equal(S.buildEntryFilter({ toDate: '2024-01-15T10:30' }).test(e), true);
  assert.equal(S.buildEntryFilter({ toDate: '2024-01-15T10:29' }).test(e), false);
});

test('buildEntryFilter: dangerous regex reports an error and does not filter', () => {
  const f = S.buildEntryFilter({ text: '(a+)+b', regex: true });
  assert.ok(f.error);
  assert.equal(f.test({ raw: 'zzz', level: 'INFO' }), true);
});

test('filterEntries stops at the time budget', () => {
  const entries = Array.from({ length: 50000 }, (_, i) => ({ raw: String(i) }));
  let calls = 0;
  const slow = () => { calls++; const t = Date.now(); while (Date.now() - t < 1) { /* spin */ } return true; };
  const r = S.filterEntries(entries, slow, 50);
  assert.equal(r.timedOut, true);
  assert.ok(calls < entries.length);
  assert.equal(S.filterEntries(entries, () => true, 0).entries.length, 50000);
});

test('findMatches returns indices', () => {
  const r = S.findMatches([{ raw: 'a' }, { raw: 'b' }, { raw: 'ab' }], /a/);
  assert.deepEqual(r.matches, [0, 2]);
});

test('findLineIndex returns the first entry at or after a line', () => {
  const es = [1, 4, 9, 12].map(line => ({ line }));
  assert.equal(S.findLineIndex(es, 1), 0);
  assert.equal(S.findLineIndex(es, 5), 2);
  assert.equal(S.findLineIndex(es, 12), 3);
  assert.equal(S.findLineIndex(es, 13), -1);
  assert.equal(S.findLineIndex([], 1), -1);
});

test('highlightLine escapes log content', () => {
  const html = S.highlightLine({ raw: '<img src=x onerror=alert(1)> & "q"', level: 'INFO' }, null);
  assert.equal(html, '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;');
});

test('highlightLine: searching markup-like words does not corrupt the line', () => {
  const e = S.parseLogLine('2024-01-15T10:00:00Z ERROR span class ts lt &', 1);
  for (const q of ['span', 'class', 'ts', 'lt', 'amp', 'level', 'search']) {
    const html = S.highlightLine(e, S.compileSearch(q, { global: true }).re);
    // Stripping tags and unescaping must give back the raw line.
    const text = html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    assert.equal(text, e.raw, q);
  }
});

test('highlightLine: marks timestamp, source, level and search hits', () => {
  const e = S.parseLogLine('Jan 15 10:30:00 host sshd[1]: ERROR bad login', 1, NOW);
  const html = S.highlightLine(e, S.compileSearch('bad', { global: true }).re);
  assert.match(html, /<span class="ts">Jan 15 10:30:00<\/span>/);
  assert.match(html, /<span class="src">sshd<\/span>/);
  assert.match(html, /<span class="level-tag level-ERROR">ERROR<\/span>/);
  assert.match(html, /<span class="search-highlight">bad<\/span>/);
});

test('highlightLine: zero-length regex matches do not loop forever', () => {
  const html = S.highlightLine({ raw: 'abc', level: 'INFO' }, S.compileSearch('x*', { regex: true, global: true }).re);
  assert.equal(html, 'abc');
  const html2 = S.highlightLine({ raw: 'abc', level: 'INFO' }, S.compileSearch('^', { regex: true, global: true }).re);
  assert.equal(html2, 'abc');
});

test('highlightLine: backreferences work (pattern is not re-wrapped)', () => {
  const html = S.highlightLine({ raw: 'xx yy', level: 'INFO' }, S.compileSearch('(y)\\1', { regex: true, global: true }).re);
  assert.equal(html, 'xx <span class="search-highlight">yy</span>');
});

test('toCSV quotes every field and neutralises formulas', () => {
  const csv = S.toCSV([
    { line: 1, level: 'ERROR', timestamp: null, source: 'a"b', message: '=HYPERLINK("http://x")' },
    { line: 2, level: 'INFO', timestamp: '2024-01-15', source: '', message: 'multi\nline, ok' },
  ]);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'Line,Level,Timestamp,Source,Message');
  assert.equal(lines[1], '1,"ERROR","","a""b","\'=HYPERLINK(""http://x"")"');
  assert.ok(csv.includes('"multi\nline, ok"'));
  for (const bad of ['+1', '-1', '@x', '\tx']) assert.ok(S.csvCell(bad).startsWith('"\''), bad);
});
