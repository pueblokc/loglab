// ============================================================
// LogLab — file reading and tailing (main process, Node only)
// ============================================================

const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline } = require('stream');
const { parseLogLine } = require('./shared');

// Read the first bytes to detect a UTF-8 / UTF-16LE byte-order mark.
// Windows tools (PowerShell `>`, some services) commonly write UTF-16LE.
function detectEncoding(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(3);
    const n = fs.readSync(fd, buf, 0, 3, 0);
    if (n >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { encoding: 'utf16le', bomLength: 2 };
    if (n >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return { encoding: 'utf8', bomLength: 3 };
    return { encoding: 'utf8', bomLength: 0 };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Read a log file - handles plain text (UTF-8 / UTF-16LE) and gzip.
// Stops reading as soon as `maxLines` lines have been consumed, so opening a
// multi-GB file with a limit doesn't scan the whole thing.
// Resolves to { entries, lineCount, truncated, endOffset, encoding }.
// `endOffset` is the byte offset the plain-text read stopped at (null for gzip
// or truncated reads) so tail mode can continue without gaps or duplicates.
function readLogFile(filePath, maxLines) {
  const limit = maxLines > 0 ? maxLines : 500000;
  const isGzip = filePath.toLowerCase().endsWith('.gz');

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(value);
    };

    let source, input, encoding = 'utf8', endOffset = null;
    try {
      if (isGzip) {
        source = fs.createReadStream(filePath);
        input = zlib.createGunzip();
        // pipeline propagates errors from either side and destroys both.
        pipeline(source, input, (err) => { if (err && !truncated) done(err); });
      } else {
        const size = fs.statSync(filePath).size;
        const enc = detectEncoding(filePath);
        encoding = enc.encoding;
        endOffset = size;
        if (size <= enc.bomLength) {
          return done(null, { entries: [], lineCount: 0, truncated: false, endOffset: size, encoding });
        }
        // Bound the read to the size we stat'ed; tail picks up from there.
        source = fs.createReadStream(filePath, { start: enc.bomLength, end: size - 1 });
        input = source;
        source.on('error', (err) => done(err));
      }
      input.setEncoding(encoding);
    } catch (err) {
      if (source) source.destroy();
      return done(err);
    }

    const entries = [];
    const now = new Date();
    let lineNum = 0;
    let truncated = false;
    const rl = readline.createInterface({ input, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (truncated) return;
      if (lineNum >= limit) {
        truncated = true;
        rl.close();
        source.destroy();
        return;
      }
      lineNum++;
      if (lineNum === 1 && line.charCodeAt(0) === 0xFEFF) line = line.substring(1);
      if (line.trim()) entries.push(parseLogLine(line, lineNum, now));
    });
    rl.on('close', () => done(null, {
      entries, lineCount: lineNum, truncated,
      endOffset: truncated ? null : endOffset,
      encoding: isGzip ? 'gzip/utf8' : encoding,
    }));
    rl.on('error', (err) => done(err));
  });
}

// Maximum bytes consumed per tail read; larger appends are processed in
// several passes so a sudden multi-GB append can't exhaust memory.
const TAIL_CHUNK = 16 * 1024 * 1024;

// Follows a growing file. Only complete lines are emitted: a partially written
// final line stays in the file until its newline arrives. Handles truncation
// (copytruncate rotation) and replacement (rename rotation) by restarting
// from offset 0. File handles are opened per read and always closed.
class Tailer {
  constructor(filePath, opts) {
    const o = opts || {};
    this.filePath = filePath;
    this.encoding = o.encoding === 'utf16le' ? 'utf16le' : 'utf8';
    this.pos = typeof o.offset === 'number' ? o.offset : null; // null = start at current EOF
    this.nextLine = typeof o.lineNum === 'number' ? o.lineNum : null;
    this.onEntries = o.onEntries || (() => {});
    this.onError = o.onError || (() => {});
    this.identity = null;
    this.reading = false;
    this.pending = false;
    this.rotated = false;
    this.closed = false;
  }

  // Record the starting position. Call once before watching.
  init() {
    try {
      const st = fs.statSync(this.filePath);
      this.identity = identityOf(st);
      if (this.pos === null || this.pos > st.size) {
        this.pos = st.size;
        this.nextLine = null; // line numbers unknown when starting mid-file
      }
    } catch {
      this.pos = 0;
    }
  }

  markRotated() { this.rotated = true; }

  close() { this.closed = true; }

  // Read whatever has been appended since the last check. Overlapping calls
  // are coalesced so the same byte range is never read twice.
  async check() {
    if (this.closed) return;
    if (this.reading) { this.pending = true; return; }
    this.reading = true;
    try {
      do {
        this.pending = false;
        await this.readOnce();
      } while (this.pending && !this.closed);
    } catch (err) {
      if (!this.closed && err.code !== 'ENOENT') this.onError(err);
    } finally {
      this.reading = false;
    }
  }

  async readOnce() {
    const st = await fs.promises.stat(this.filePath);
    const id = identityOf(st);
    if (this.rotated || st.size < this.pos || (this.identity && id !== this.identity)) {
      this.pos = 0;
      this.nextLine = 1;
      this.rotated = false;
    }
    this.identity = id;
    if (this.pos === 0 && this.encoding === 'utf16le' && st.size >= 2) {
      const bom = await readRange(this.filePath, 0, 2);
      if (bom[0] === 0xFF && bom[1] === 0xFE) this.pos = 2;
    }
    if (st.size <= this.pos) return;

    const len = Math.min(st.size - this.pos, TAIL_CHUNK);
    const buf = await readRange(this.filePath, this.pos, len);
    if (this.closed) return;

    let consumed = lastLineEnd(buf, this.encoding);
    if (consumed === 0) {
      // No complete line yet. If a single line exceeds the chunk size, emit it
      // anyway rather than stalling forever.
      if (len < TAIL_CHUNK) return;
      consumed = this.encoding === 'utf16le' ? len - (len % 2) : len;
    }
    if (len === TAIL_CHUNK && st.size - this.pos > TAIL_CHUNK) this.pending = true;

    this.pos += consumed;
    let text = buf.toString(this.encoding, 0, consumed);
    if (this.nextLine === 1 && text.charCodeAt(0) === 0xFEFF) text = text.substring(1);
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();

    const now = new Date();
    const entries = [];
    for (const line of lines) {
      const num = this.nextLine === null ? -1 : this.nextLine++;
      if (line.trim()) entries.push(parseLogLine(line, num, now));
    }
    if (entries.length > 0) this.onEntries(entries);
  }
}

function identityOf(st) {
  // ino is 0 on some filesystems; birthtime still distinguishes a new file.
  return `${st.dev}:${st.ino}:${st.birthtimeMs}`;
}

async function readRange(filePath, position, length) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return bytesRead < length ? buf.subarray(0, bytesRead) : buf;
  } finally {
    await fh.close();
  }
}

// Number of bytes up to and including the last newline in `buf`.
function lastLineEnd(buf, encoding) {
  if (encoding === 'utf16le') {
    for (let i = (buf.length - 2) & ~1; i >= 0; i -= 2) {
      if (buf[i] === 0x0A && buf[i + 1] === 0x00) return i + 2;
    }
    return 0;
  }
  const i = buf.lastIndexOf(0x0A);
  return i === -1 ? 0 : i + 1;
}

module.exports = { detectEncoding, readLogFile, Tailer, lastLineEnd, TAIL_CHUNK };
