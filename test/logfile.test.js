'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { readLogFile, Tailer, detectEncoding, lastLineEnd } = require('../lib/logfile');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loglab-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const file = (content, ext = '.log') => {
  const p = path.join(tmp, `f${++n}${ext}`);
  fs.writeFileSync(p, content);
  return p;
};

// Open file descriptors of this process (Linux only; null elsewhere).
function openFds() {
  try { return fs.readdirSync('/proc/self/fd').length; } catch { return null; }
}

test('readLogFile: parses lines, keeps real line numbers, skips blanks', async () => {
  const p = file('2024-01-15 10:00:00 INFO a\n\nERROR b\r\nlast without newline');
  const r = await readLogFile(p, 1000);
  assert.deepEqual(r.entries.map(e => e.line), [1, 3, 4]);
  assert.equal(r.entries[1].level, 'ERROR');
  assert.equal(r.entries[1].raw, 'ERROR b');
  assert.equal(r.lineCount, 4);
  assert.equal(r.truncated, false);
  assert.equal(r.endOffset, fs.statSync(p).size);
  assert.equal(r.encoding, 'utf8');
});

test('readLogFile: stops at maxLines and reports truncation', async () => {
  const p = file(Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const r = await readLogFile(p, 10);
  assert.equal(r.entries.length, 10);
  assert.equal(r.entries[9].raw, 'line 10');
  assert.equal(r.truncated, true);
  assert.equal(r.endOffset, null);
});

test('readLogFile: strips a UTF-8 BOM so line 1 parses', async () => {
  const p = file(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('1700000000 started\n')]));
  const r = await readLogFile(p, 10);
  assert.equal(r.entries[0].raw, '1700000000 started');
  assert.equal(r.entries[0].time, 1700000000000);
});

test('readLogFile: decodes UTF-16LE (PowerShell redirect output)', async () => {
  const p = file(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('ERROR one\r\nINFO two\r\n', 'utf16le')]));
  assert.equal(detectEncoding(p).encoding, 'utf16le');
  const r = await readLogFile(p, 10);
  assert.deepEqual(r.entries.map(e => e.raw), ['ERROR one', 'INFO two']);
  assert.equal(r.encoding, 'utf16le');
});

test('readLogFile: gzip files', async () => {
  const p = file(zlib.gzipSync('WARN zipped\nINFO two\n'), '.gz');
  const r = await readLogFile(p, 10);
  assert.deepEqual(r.entries.map(e => e.raw), ['WARN zipped', 'INFO two']);
  assert.equal(r.encoding, 'gzip/utf8');
  assert.equal(r.endOffset, null);
});

test('readLogFile: corrupt gzip rejects instead of crashing', async () => {
  const p = file('definitely not gzip', '.gz');
  await assert.rejects(readLogFile(p, 10));
});

test('readLogFile: missing files reject (plain and gzip)', async () => {
  await assert.rejects(readLogFile(path.join(tmp, 'nope.log'), 10), /ENOENT/);
  await assert.rejects(readLogFile(path.join(tmp, 'nope.log.gz'), 10), /ENOENT/);
});

test('readLogFile: empty file', async () => {
  const r = await readLogFile(file(''), 10);
  assert.deepEqual(r.entries, []);
  assert.equal(r.endOffset, 0);
});

test('readLogFile: does not leak file handles', async () => {
  const p = file(Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n'));
  const before = openFds();
  for (let i = 0; i < 30; i++) await readLogFile(p, 5);
  for (let i = 0; i < 30; i++) await readLogFile(p, 100000);
  await new Promise(r => setTimeout(r, 50));
  if (before !== null) assert.ok(openFds() <= before + 1, `fds ${before} -> ${openFds()}`);
});

function collector() {
  const got = [];
  return { got, onEntries: (es) => got.push(...es) };
}

test('Tailer: continues from the read offset with correct line numbers', async () => {
  const p = file('a\nb\n');
  const r = await readLogFile(p, 100);
  fs.appendFileSync(p, 'c\n\nd\n'); // written between read and tail start
  const c = collector();
  const t = new Tailer(p, { offset: r.endOffset, lineNum: r.lineCount + 1, onEntries: c.onEntries });
  t.init();
  await t.check();
  assert.deepEqual(c.got.map(e => [e.line, e.raw]), [[3, 'c'], [5, 'd']]);
});

test('Tailer: without an offset starts at EOF and numbers lines -1', async () => {
  const p = file('old\n');
  const c = collector();
  const t = new Tailer(p, { onEntries: c.onEntries });
  t.init();
  fs.appendFileSync(p, 'new\n');
  await t.check();
  assert.deepEqual(c.got.map(e => [e.line, e.raw]), [[-1, 'new']]);
});

test('Tailer: holds back a partial line until its newline arrives', async () => {
  const p = file('');
  const c = collector();
  const t = new Tailer(p, { offset: 0, lineNum: 1, onEntries: c.onEntries });
  t.init();
  fs.appendFileSync(p, 'ERROR first\nhalf of a');
  await t.check();
  assert.deepEqual(c.got.map(e => e.raw), ['ERROR first']);
  fs.appendFileSync(p, ' line\n');
  await t.check();
  assert.deepEqual(c.got.map(e => e.raw), ['ERROR first', 'half of a line']);
});

test('Tailer: overlapping checks never emit a line twice', async () => {
  const p = file('');
  const c = collector();
  const t = new Tailer(p, { offset: 0, lineNum: 1, onEntries: c.onEntries });
  t.init();
  const writes = [];
  for (let i = 0; i < 50; i++) {
    fs.appendFileSync(p, `line ${i}\n`);
    writes.push(t.check());
  }
  await Promise.all(writes);
  await t.check();
  assert.deepEqual(c.got.map(e => e.raw), Array.from({ length: 50 }, (_, i) => `line ${i}`));
  assert.deepEqual(c.got.map(e => e.line), Array.from({ length: 50 }, (_, i) => i + 1));
});

test('Tailer: truncation (copytruncate rotation) re-reads from the start', async () => {
  const p = file('one\ntwo\nthree\n');
  const c = collector();
  const t = new Tailer(p, { onEntries: c.onEntries });
  t.init();
  fs.writeFileSync(p, 'fresh\n');
  await t.check();
  assert.deepEqual(c.got.map(e => [e.line, e.raw]), [[1, 'fresh']]);
});

test('Tailer: rename rotation (new file at same path) re-reads from the start', async () => {
  const p = file('x'.repeat(10) + '\n');
  const c = collector();
  const t = new Tailer(p, { onEntries: c.onEntries });
  t.init();
  fs.renameSync(p, p + '.1');
  // New file already larger than the old offset.
  fs.writeFileSync(p, 'rotated line one that is long\nrotated two\n');
  t.markRotated();
  await t.check();
  assert.deepEqual(c.got.map(e => e.raw), ['rotated line one that is long', 'rotated two']);
});

test('Tailer: UTF-16LE appends', async () => {
  const p = file(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('a\r\n', 'utf16le')]));
  const r = await readLogFile(p, 100);
  const c = collector();
  const t = new Tailer(p, { offset: r.endOffset, lineNum: r.lineCount + 1, encoding: 'utf16le', onEntries: c.onEntries });
  t.init();
  fs.appendFileSync(p, Buffer.from('ERROR ünïcode\r\npart', 'utf16le'));
  await t.check();
  assert.deepEqual(c.got.map(e => [e.line, e.raw]), [[2, 'ERROR ünïcode']]);
});

test('Tailer: deleted file does not throw or report an error', async () => {
  const p = file('a\n');
  const errors = [];
  const t = new Tailer(p, { onError: (e) => errors.push(e) });
  t.init();
  fs.unlinkSync(p);
  await t.check();
  assert.deepEqual(errors, []);
});

test('Tailer: closed tailer emits nothing; checks do not leak handles', async () => {
  const p = file('');
  const c = collector();
  const t = new Tailer(p, { offset: 0, lineNum: 1, onEntries: c.onEntries });
  t.init();
  const before = openFds();
  for (let i = 0; i < 100; i++) { fs.appendFileSync(p, `l${i}\n`); await t.check(); }
  if (before !== null) assert.ok(openFds() <= before + 1);
  t.close();
  fs.appendFileSync(p, 'after close\n');
  await t.check();
  assert.equal(c.got.length, 100);
});

test('lastLineEnd', () => {
  assert.equal(lastLineEnd(Buffer.from('ab\ncd'), 'utf8'), 3);
  assert.equal(lastLineEnd(Buffer.from('abcd'), 'utf8'), 0);
  assert.equal(lastLineEnd(Buffer.from('a\nb\n', 'utf16le'), 'utf16le'), 8);
  // 0x0A as the high byte of a UTF-16 code unit is not a newline.
  assert.equal(lastLineEnd(Buffer.from([0x41, 0x0A, 0x42, 0x00]), 'utf16le'), 0);
});
