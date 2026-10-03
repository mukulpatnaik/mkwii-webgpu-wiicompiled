// Tests for the disc reader worker (mkw_disc_worker.js) with the real nod wasm, against a small
// synthetic GameCube-format image built here, so no game data is needed. The wasm is taken from
// MKW_DISC_WASM, a web build directory's mkw_disc.wasm (MKW_WEB_BUILD_DIR), or a cargo build of
// ../disc-wasm; the wasm tests are skipped when none exists:
//   cargo build --release --target wasm32-unknown-unknown --manifest-path ../disc-wasm/Cargo.toml
// Optional, against your own disc image (never copied anywhere; read in place):
//   MKW_DISC_IMAGE=/path/to/RMCx01.wbfs [MKW_DISC_EXTRACTED=/path/to/Assets/DATA] node --test ...
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';

const here = path.dirname(new URL(import.meta.url).pathname);
const source = await readFile(path.join(here, '../mkw_disc_worker.js'), 'utf8');
const wasmPath = [
  process.env.MKW_DISC_WASM,
  process.env.MKW_WEB_BUILD_DIR && path.join(process.env.MKW_WEB_BUILD_DIR, 'mkw_disc.wasm'),
  path.join(here, '../disc-wasm/target/wasm32-unknown-unknown/release/mkw_disc_wasm.wasm'),
].find((candidate) => candidate && fs.existsSync(candidate));
const wasmBytes = wasmPath ? fs.readFileSync(wasmPath) : null;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));

// In-process BroadcastChannel: delivers a structured clone to every other channel of that name.
function channelHub() {
  const byName = new Map();
  class Channel {
    constructor(name) { this.name = name; this.onmessage = null; (byName.get(name) || byName.set(name, new Set()).get(name)).add(this); }
    postMessage(data) {
      for (const other of byName.get(this.name)) {
        if (other !== this) { const copy = structuredClone(data); setImmediate(() => other.onmessage?.({ data: copy })); }
      }
    }
    close() { byName.get(this.name).delete(this); }
  }
  return Channel;
}

// A File-like object over a Buffer or an open file descriptor, and FileReaderSync over it.
function memoryFile(bytes, name = 'synthetic.iso') {
  return { name, size: bytes.byteLength, slice: (start, end) => ({ read: () => bytes.subarray(start, end) }) };
}
function diskFile(file) {
  const fd = fs.openSync(file, 'r');
  return {
    name: path.basename(file), size: fs.fstatSync(fd).size,
    slice: (start, end) => ({ read: () => { const out = Buffer.alloc(end - start); fs.readSync(fd, out, 0, out.length, start); return out; } }),
  };
}
// The worker schedules its queue through a MessageChannel; a real one would keep the test
// process alive, so this one posts with setImmediate (also after already queued deliveries).
class ImmediateChannel {
  constructor() {
    this.port1 = { onmessage: null };
    this.port2 = { postMessage: (data) => setImmediate(() => this.port1.onmessage?.({ data })) };
  }
}
class FileReaderSync {
  readAsArrayBuffer(blob) { const bytes = blob.read(); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
}

// Synchronous XMLHttpRequest over an image a local helper server offers (Range requests only).
function rangeServer(bytes, url) {
  const requests = [];
  class XMLHttpRequest {
    open(method, target, async) { this.method = method; this.target = target; this.async = async; this.headers = {}; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send() {
      assert.equal(this.async, false);
      requests.push(this.headers.Range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(this.headers.Range || '');
      if (this.target !== url || !match) { this.status = 404; return; }
      const piece = bytes.subarray(Number(match[1]), Number(match[2]) + 1);
      this.status = 206;
      this.response = piece.buffer.slice(piece.byteOffset, piece.byteOffset + piece.byteLength);
    }
  }
  return { XMLHttpRequest, requests };
}

function startWorker({ regions, XMLHttpRequest } = {}) {
  const Channel = channelHub();
  const posted = [];
  const logs = [];
  let text = source;
  if (regions) text = text.replace(/const REGIONS = \{[\s\S]*?\n\};/, 'const REGIONS = ' + JSON.stringify(regions) + ';');
  const self = { location: { href: 'https://game.test/mkw_disc_worker.js' }, postMessage: (m) => posted.push(m) };
  const timers = [];
  vm.runInNewContext(text, {
    self, BroadcastChannel: Channel, MessageChannel: ImmediateChannel, FileReaderSync, XMLHttpRequest, WebAssembly, TextDecoder, URL,
    crypto: webcrypto, performance, setTimeout, console: { log: (s) => logs.push(s), error: (s) => logs.push(s) },
    setInterval: (fn, ms) => { timers.push(fn); return timers.length; },
    fetch: async (url) => {
      assert.equal(String(url), 'https://game.test/mkw_disc.wasm');
      return new Response(wasmBytes);
    },
  });
  // The game's side of the channel.
  const game = new Channel('test-channel');
  const received = [];
  game.onmessage = ({ data }) => received.push(data);
  async function open(file) {
    await self.onmessage({ data: { type: 'open', file, channel: 'test-channel' } });
    return posted.at(-1);
  }
  async function waitFor(predicate) {
    for (let i = 0; i < 2000; i++) {
      const found = received.filter(predicate);
      if (found.length) return found;
      await tick();
    }
    throw new Error('timed out');
  }
  return { open, game, received, waitFor, logs, timers, posted };
}

// A GameCube-layout disc: boot.bin, bi2.bin, an apploader, a DOL, an FST and three files, plus
// any `extra` files ({"dir/name": Buffer}).
function syntheticDisc(gameId = 'RMCE01', extra = {}) {
  const files = {
    'Race/Course/castle_course.szs': Buffer.alloc(70000).map((_, i) => (i * 7) & 255),
    'opening.bnr': Buffer.from('banner'),
    'rel/StaticR.rel': Buffer.from('static rel ' + 'r'.repeat(5000)),
    ...extra,
  };
  const dataStart = 0x8000;
  let imageSize = dataStart;
  for (const bytes of Object.values(files)) imageSize = (imageSize + bytes.length + 0x7FFF) & ~0x7FFF;
  const image = Buffer.alloc(Math.max(imageSize, 0x40000));
  image.write(gameId, 0, 'latin1');
  image.writeUInt32BE(0xC2339F3D, 0x1C);
  image.write('SYNTHETIC TEST DISC', 0x20, 'latin1');
  // Apploader at 0x2440: 32-byte header (date, entry, size, trailer) then its body.
  image.write('2008/04/01', 0x2440, 'latin1');
  image.writeUInt32BE(0x81200000, 0x2450);
  image.writeUInt32BE(0x40, 0x2454);
  // DOL at 0x3000 with one 0x80-byte text section.
  const dol = 0x3000;
  image.writeUInt32BE(0x100, dol);
  image.writeUInt32BE(0x80003100, dol + 0x48);
  image.writeUInt32BE(0x80, dol + 0x90);
  image.writeUInt32BE(0x80003100, dol + 0xE0);
  image.fill(0x60, dol + 0x100, dol + 0x180);
  // File data from 0x8000.
  let next = dataStart;
  const placed = {};
  for (const [name, bytes] of Object.entries(files)) {
    bytes.copy(image, next);
    placed[name] = { offset: next, size: bytes.length };
    next = (next + bytes.length + 0x7FFF) & ~0x7FFF;
  }
  // FST at 0x4000, in preorder: a directory's entry holds its parent's index and the index after
  // its last descendant; a file's its offset and size.
  const tree = new Map();
  for (const name of Object.keys(files).sort()) {
    let node = tree;
    const parts = name.split('/');
    for (const part of parts.slice(0, -1)) node = node.get(part) || node.set(part, new Map()).get(part);
    node.set(parts.at(-1), name);
  }
  const names = [];
  const nameOffset = (name) => { const at = names.reduce((n, s) => n + s.length + 1, 0); names.push(name); return at; };
  const nodes = [[1, 0, 0, 0]];  // root; its length is the node count
  const emit = (dir, parent) => {
    for (const [name, child] of dir) {
      if (typeof child === 'string') {
        nodes.push([0, nameOffset(name), placed[child].offset, placed[child].size]);
      } else {
        const index = nodes.push([1, nameOffset(name), parent, 0]) - 1;
        emit(child, index);
        nodes[index][3] = nodes.length;
      }
    }
  };
  emit(tree, 0);
  nodes[0][3] = nodes.length;
  const fst = 0x4000;
  nodes.forEach(([kind, name, offset, length], i) => {
    image.writeUInt32BE((kind << 24) | name, fst + i * 12);
    image.writeUInt32BE(offset, fst + i * 12 + 4);
    image.writeUInt32BE(length, fst + i * 12 + 8);
  });
  const strings = Buffer.from(names.map((n) => n + '\0').join(''), 'latin1');
  strings.copy(image, fst + nodes.length * 12);
  const fstSize = nodes.length * 12 + strings.length;
  assert.ok(fst + fstSize <= dataStart);
  image.writeUInt32BE(dol, 0x420);
  image.writeUInt32BE(fst, 0x424);
  image.writeUInt32BE(fstSize, 0x428);
  image.writeUInt32BE(fstSize, 0x42C);
  return { image, files, dolBytes: image.subarray(dol, dol + 0x180) };
}

// A THP movie in the layout of the game's menu previews: a header, one video component, then
// `count` frames of varying size, each starting with its links (next size, previous size, image
// size), the last linking back to the first when it loops.
function syntheticThp({ count = 8, fps = 59.94, loop = true, previous = true, audio = false, trailer = 0 } = {}) {
  const first = 0x60;
  const sizes = Array.from({ length: count }, (_, i) => 0x40 + ((i * 37) % 5) * 0x20);
  const dataSize = sizes.reduce((a, b) => a + b, 0);
  const thp = Buffer.alloc(first + dataSize + trailer);
  thp.write('THP\0', 0, 'latin1');
  thp.writeUInt32BE(0x11000, 4);
  thp.writeUInt32BE(Math.max(...sizes), 8);
  thp.writeFloatBE(fps, 16);
  thp.writeUInt32BE(count, 20);
  thp.writeUInt32BE(sizes[0], 24);
  thp.writeUInt32BE(dataSize, 28);
  thp.writeUInt32BE(0x30, 32);
  thp.writeUInt32BE(first, 40);
  thp.writeUInt32BE(first + dataSize - sizes.at(-1), 44);
  thp.writeUInt32BE(audio ? 2 : 1, 0x30);
  thp.fill(0xFF, 0x34, 0x44);
  thp.writeUInt8(0, 0x34);
  if (audio) thp.writeUInt8(1, 0x35);
  thp.writeUInt32BE(608, 0x44);
  thp.writeUInt32BE(456, 0x48);
  let at = first;
  sizes.forEach((size, i) => {
    thp.writeUInt32BE(i + 1 < count ? sizes[i + 1] : loop ? sizes[0] : 0, at);
    thp.writeUInt32BE(i ? sizes[i - 1] : previous ? sizes.at(-1) : 0, at + 4);
    thp.writeUInt32BE(size - 16, at + 8);
    thp.fill(i + 1, at + 12, at + size);
    at += size;
  });
  thp.fill(0xEE, at);
  return thp;
}

// The conversion web_menu_videos.py makes (tools/ in the page tooling), on a whole file: every
// other frame, links rewritten, frame rate halved.
function halveThp(thp) {
  const first = thp.readUInt32BE(40), count = thp.readUInt32BE(20);
  const frames = [];
  let at = first, size = thp.readUInt32BE(24);
  for (let i = 0; i < count; i++) { frames.push([at, size]); at += size; size = thp.readUInt32BE(at - size); }
  const kept = frames.filter((_, i) => i % 2 === 0);
  const loop = thp.readUInt32BE(frames.at(-1)[0]) !== 0, previous = thp.readUInt32BE(first + 4) !== 0;
  const parts = [Buffer.from(thp.subarray(0, first))];
  let out = first, last = 0;
  kept.forEach(([position, length], i) => {
    const frame = Buffer.from(thp.subarray(position, position + length));
    frame.writeUInt32BE(i + 1 < kept.length ? kept[i + 1][1] : loop ? kept[0][1] : 0, 0);
    frame.writeUInt32BE(i ? kept[i - 1][1] : previous ? kept.at(-1)[1] : 0, 4);
    last = out;
    out += length;
    parts.push(frame);
  });
  const header = parts[0];
  header.writeUInt32BE(Math.max(...kept.map(([, length]) => length)), 8);
  header.writeFloatBE(thp.readFloatBE(16) / 2, 16);
  header.writeUInt32BE(kept.length, 20);
  header.writeUInt32BE(kept[0][1], 24);
  header.writeUInt32BE(out - first, 28);
  header.writeUInt32BE(last, 44);
  parts.push(thp.subarray(at));
  return Buffer.concat(parts);
}

// Every chunk of a file the worker serves, joined.
async function readWhole(worker, name, size, chunkSize) {
  const last = Math.ceil(size / chunkSize) - 1;
  worker.game.postMessage({ type: 'read', path: name, chunkSize, first: 0, last, priority: 0 });
  await worker.waitFor((m) => m.type === 'chunk' && m.path === name && m.chunkSize === chunkSize && m.index === last);
  return Buffer.concat([...Array(last + 1).keys()].map((i) => Buffer.from(worker.received.find((m) =>
    m.type === 'chunk' && m.path === name && m.chunkSize === chunkSize && m.index === i).bytes)));
}

function manifestSizes(text) {
  return new Map(text.split('\n').filter((l) => l.startsWith('f ')).map((l) => {
    const [, size, name] = /^f (\d+) (.+)$/.exec(l);
    return [name, Number(size)];
  }));
}

async function recompHashes() {
  const root = path.join(here, '../../../../../projects');
  const result = {};
  for (const name of await readdir(root)) {
    const yml = path.join(root, name, 'recomp.yml');
    if (!fs.existsSync(yml)) continue;
    const text = await readFile(yml, 'utf8');
    const id = /^\s+game_id:\s*(\S+)/m.exec(text)?.[1] || (name === 'mkwii' ? 'RMCP01' : null);
    const dol = /\n  dol:\n(?:    .*\n)*?    sha256: ([0-9a-f]{64})/.exec(text)?.[1];
    const rel = /\n  rel:\n(?:    .*\n)*?    sha256: ([0-9a-f]{64})/.exec(text)?.[1];
    if (id && dol && rel) result[id] = { dol, rel };
  }
  return result;
}

test('the accepted executables are the ones the translation projects pin', async () => {
  const regions = vm.runInNewContext('(' + source.match(/const REGIONS = (\{[\s\S]*?\n\});/)[1] + ')');
  const projects = await recompHashes();
  assert.deepEqual(Object.keys(projects).sort(), ['RMCE01', 'RMCJ01', 'RMCK01', 'RMCP01']);
  for (const [id, { dol, rel }] of Object.entries(projects)) {
    assert.equal(regions[id].dol, dol, id + ' main.dol');
    assert.equal(regions[id].rel, rel, id + ' StaticR.rel');
  }
});

test('a synthetic disc opens, lists its files and is rejected as not a clean dump', { skip: !wasmBytes && 'no disc wasm built' }, async () => {
  const { image } = syntheticDisc();
  const worker = startWorker();
  const result = await worker.open(memoryFile(image));
  assert.equal(result.type, 'opened');
  assert.equal(result.gameId, 'RMCE01');
  assert.equal(result.region, 'NTSC-U');
  assert.equal(result.files, 3);
  assert.equal(result.valid, false);
  assert.match(result.reason, /main\.dol and StaticR\.rel differ/);
});

test('matching hashes validate, and the manifest and file chunks match the image', { skip: !wasmBytes && 'no disc wasm built' }, async () => {
  const { image, files, dolBytes } = syntheticDisc();
  const worker = startWorker({ regions: { RMCE01: { name: 'NTSC-U', dol: sha256(dolBytes), rel: sha256(files['rel/StaticR.rel']) } } });
  const result = await worker.open(memoryFile(image));
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.dolOk && result.relOk, true);

  worker.game.postMessage({ type: 'hello' });
  const [manifest] = await worker.waitFor((m) => m.type === 'manifest');
  const lines = manifest.text.trim().split('\n');
  assert.deepEqual(lines.slice(0, 2), ['d DATA', 'd DATA/sys']);
  assert.ok(lines.includes('f 384 DATA/sys/main.dol'));
  assert.ok(lines.includes('f 1088 DATA/sys/boot.bin'));
  assert.ok(lines.includes('d DATA/files/Race/Course'));
  assert.ok(lines.indexOf('d DATA/files/Race') < lines.indexOf('d DATA/files/Race/Course'));
  assert.ok(lines.includes('f 70000 DATA/files/Race/Course/castle_course.szs'));

  worker.game.postMessage({ type: 'read', path: 'DATA/files/Race/Course/castle_course.szs', chunkSize: 32768, first: 0, last: 2, priority: 0 });
  worker.game.postMessage({ type: 'read', path: 'DATA/sys/main.dol', chunkSize: 32768, first: 0, last: 0, priority: 0 });
  const chunks = await worker.waitFor((m) => m.type === 'chunk' && m.path.endsWith('.szs') && m.index === 2);
  const all = worker.received.filter((m) => m.type === 'chunk');
  const course = Buffer.concat([0, 1, 2].map((i) => Buffer.from(all.find((m) => m.path.endsWith('.szs') && m.index === i).bytes)));
  assert.equal(sha256(course), sha256(files['Race/Course/castle_course.szs']));
  assert.equal(chunks[0].bytes.byteLength, 70000 - 65536);
  await worker.waitFor((m) => m.type === 'chunk' && m.path === 'DATA/sys/main.dol');
  assert.equal(sha256(Buffer.from(all.concat(worker.received).find((m) => m.path === 'DATA/sys/main.dol').bytes)), sha256(dolBytes));
});

test('an image offered by the local helper server is read with range requests', { skip: !wasmBytes && 'no disc wasm built' }, async () => {
  const { image, files, dolBytes } = syntheticDisc();
  const url = 'https://game.test/mkw-server-disc';
  const server = rangeServer(image, url);
  const worker = startWorker({ XMLHttpRequest: server.XMLHttpRequest,
    regions: { RMCE01: { name: 'NTSC-U', dol: sha256(dolBytes), rel: sha256(files['rel/StaticR.rel']) } } });
  const result = await worker.open({ url, size: image.byteLength, name: 'disc.iso' });
  assert.equal(result.type, 'opened');
  assert.equal(result.valid, true, result.reason);
  assert.ok(server.requests.length > 0);
  assert.ok(server.requests.every((range) => /^bytes=\d+-\d+$/.test(range)));

  worker.game.postMessage({ type: 'read', path: 'DATA/files/Race/Course/castle_course.szs', chunkSize: 32768, first: 0, last: 2, priority: 0 });
  await worker.waitFor((m) => m.type === 'chunk' && m.path.endsWith('.szs') && m.index === 2);
  const chunks = worker.received.filter((m) => m.type === 'chunk' && m.path.endsWith('.szs')).sort((a, b) => a.index - b.index);
  assert.equal(sha256(Buffer.concat(chunks.map((m) => Buffer.from(m.bytes)))), sha256(files['Race/Course/castle_course.szs']));
});

test('queued chunks are served most urgent first, and bad requests answer with an error', { skip: !wasmBytes && 'no disc wasm built' }, async () => {
  const { image } = syntheticDisc();
  const worker = startWorker();
  await worker.open(memoryFile(image));
  const path = 'DATA/files/Race/Course/castle_course.szs';
  // Posted together, so all three are queued before the worker runs any.
  worker.game.postMessage({ type: 'read', path, chunkSize: 4096, first: 0, last: 9, priority: 2 });
  worker.game.postMessage({ type: 'read', path, chunkSize: 4096, first: 12, last: 12, priority: 0 });
  worker.game.postMessage({ type: 'read', path: 'DATA/files/missing.bin', chunkSize: 4096, first: 0, last: 0, priority: 0 });
  worker.game.postMessage({ type: 'read', path, chunkSize: 4096, first: 30, last: 30, priority: 0 });
  await worker.waitFor((m) => m.type === 'chunk' && m.index === 9);
  const order = worker.received.filter((m) => m.type === 'chunk' || m.type === 'chunk-error').map((m) => m.type === 'chunk' ? m.index : 'error');
  assert.deepEqual(order.slice(0, 2), [12, 'error']);
  assert.ok(order.indexOf(12) < order.indexOf(0));
  assert.match(worker.received.find((m) => m.type === 'chunk-error' && m.path.endsWith('missing.bin')).message, /no such file/);
  assert.match(worker.received.find((m) => m.type === 'chunk-error' && m.index === 30).message, /past the end/);
});

test('a raise reorders queued chunks and never reads a chunk again', { skip: !wasmBytes && 'no disc wasm built' }, async () => {
  const { image } = syntheticDisc();
  const worker = startWorker();
  await worker.open(memoryFile(image));
  const path = 'DATA/files/Race/Course/castle_course.szs';
  worker.game.postMessage({ type: 'read', path, chunkSize: 4096, first: 0, last: 9, priority: 2 });
  worker.game.postMessage({ type: 'read', path, chunkSize: 4096, first: 7, last: 7, priority: 0, raise: true });
  worker.game.postMessage({ type: 'read', path, chunkSize: 4096, first: 12, last: 12, priority: 0, raise: true });
  await worker.waitFor((m) => m.type === 'chunk' && m.index === 9);
  // Chunk 3 has been sent: raising it now (it was in transit when the game came to need it) does
  // not read it again.
  worker.game.postMessage({ type: 'read', path, chunkSize: 4096, first: 3, last: 3, priority: 0, raise: true });
  for (let i = 0; i < 20; i++) await tick();
  const order = worker.received.filter((m) => m.type === 'chunk' || m.type === 'chunk-error').map((m) => m.index);
  assert.deepEqual(order, [7, 0, 1, 2, 3, 4, 5, 6, 8, 9]);
});

test('a request queues only the chunks its file has, and an absurd range is refused', { skip: !wasmBytes && 'no disc wasm built' }, async () => {
  const { image } = syntheticDisc();
  const worker = startWorker();
  await worker.open(memoryFile(image));
  const path = 'DATA/files/Race/Course/castle_course.szs';  // 70000 bytes: chunks 0-2 of 32 KiB
  worker.game.postMessage({ type: 'read', path, chunkSize: 32768, first: 1, last: Number.MAX_SAFE_INTEGER, priority: 0 });
  worker.game.postMessage({ type: 'read', path, chunkSize: 32768, first: 1e12, last: 1e12 + 5, priority: 0 });
  worker.game.postMessage({ type: 'read', path, chunkSize: 1, first: 0, last: 69999, priority: 0 });
  worker.game.postMessage({ type: 'read', path: 'DATA/files/missing.bin', chunkSize: 32768, first: 0, last: 1e9, priority: 0 });
  worker.game.postMessage({ type: 'read', path: 'DATA/files/opening.bnr', chunkSize: 32768, first: 0, last: 0, priority: 2 });
  await worker.waitFor((m) => m.path === 'DATA/files/opening.bnr');
  for (let i = 0; i < 20; i++) await tick();
  const answers = worker.received.filter((m) => m.type === 'chunk' || m.type === 'chunk-error')
    .map((m) => [m.type, m.path.split('/').pop(), m.index]);
  assert.deepEqual(answers.filter(([, name]) => name === 'castle_course.szs').sort(), [
    ['chunk', 'castle_course.szs', 1],
    ['chunk', 'castle_course.szs', 2],
    ['chunk-error', 'castle_course.szs', 0],
    ['chunk-error', 'castle_course.szs', 1e12],
  ]);
  assert.match(worker.received.find((m) => m.type === 'chunk-error' && m.index === 0 && m.path === path).message, /too many chunks/);
  assert.match(worker.received.find((m) => m.type === 'chunk-error' && m.index === 1e12).message, /past the end/);
  assert.deepEqual(answers.filter(([, name]) => name === 'missing.bin'), [['chunk-error', 'missing.bin', 0]]);
});

test('menu videos are served at half frame rate, as web_menu_videos.py stages them', { skip: !wasmBytes && 'no disc wasm built' }, async () => {
  const movie = syntheticThp();
  const extra = {
    'thp/course/flower.thp': movie,                                   // converted
    'thp/battle/battle_wii.thp': syntheticThp({ count: 10, loop: false, previous: false, trailer: 40 }),
    'thp/title/top_menu.thp': movie,                                  // converted
    'thp/title/title.thp': movie,                                     // not a menu preview
    'thp/ending/ending_normal.thp': movie,                            // not a menu preview
    'thp/course/odd.thp': syntheticThp({ count: 7 }),                 // refused: odd frame count
    'thp/course/slow.thp': syntheticThp({ fps: 29.97 }),              // refused: under 50 fps
    'thp/button/sound.thp': syntheticThp({ audio: true }),            // refused: has audio
    'thp/button/two.thp': syntheticThp({ count: 2 }),                 // refused: one frame left
  };
  const { image, files, dolBytes } = syntheticDisc('RMCE01', extra);
  const worker = startWorker({ regions: { RMCE01: { name: 'NTSC-U', dol: sha256(dolBytes), rel: sha256(files['rel/StaticR.rel']) } } });
  const opened = worker.open(memoryFile(image));
  // Asked while the videos are being indexed, the worker says the manifest is coming.
  while (!worker.posted.length) await tick();
  worker.game.postMessage({ type: 'hello' });
  await worker.waitFor((m) => m.type === 'preparing');
  assert.ok(!worker.received.some((m) => m.type === 'manifest'));
  assert.equal((await opened).valid, true);
  const [manifest] = await worker.waitFor((m) => m.type === 'manifest');
  const sizes = manifestSizes(manifest.text);
  assert.ok(worker.logs.some((line) => /menu videos: 3 at half frame rate/.test(line)), worker.logs.join('\n'));
  for (const [name, bytes] of Object.entries(extra)) {
    const converted = ['thp/course/flower.thp', 'thp/battle/battle_wii.thp', 'thp/title/top_menu.thp'].includes(name);
    const expected = converted ? halveThp(bytes) : bytes;
    assert.equal(sizes.get('DATA/files/' + name), expected.length, name);
    // Small chunks, so that reads start and end inside frames and inside their link words.
    for (const chunkSize of [7, 100, 4096]) {
      assert.equal(sha256(await readWhole(worker, 'DATA/files/' + name, expected.length, chunkSize)), sha256(expected), name + ' in chunks of ' + chunkSize);
    }
  }
  const half = halveThp(movie);
  assert.equal(half.readUInt32BE(20), 4);
  assert.equal(half.readFloatBE(16), Math.fround(Math.fround(59.94) / 2));
  for (const name of ['odd', 'slow']) assert.ok(worker.logs.some((line) => line.includes('thp/course/' + name + '.thp is served at its original frame rate')));
});

test('your own disc image (MKW_DISC_IMAGE) serves the menu videos web_menu_videos.py makes (MKW_MENU_VIDEOS_DIR)',
     { skip: !(wasmBytes && process.env.MKW_DISC_IMAGE && process.env.MKW_MENU_VIDEOS_DIR) && 'set MKW_DISC_IMAGE and MKW_MENU_VIDEOS_DIR to run' }, async () => {
  // MKW_MENU_VIDEOS_DIR is the script's conversion cache (its third argument), holding
  // files/thp/... for exactly the files it converted:
  //   python3 tools/web_menu_videos.py Assets/DATA <scratch>/out <scratch>/cache
  const reference = process.env.MKW_MENU_VIDEOS_DIR;
  const converted = new Map();
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.name.endsWith('.thp')) converted.set('DATA/' + path.relative(reference, full).split(path.sep).join('/'), full);
    }
  };
  walk(path.join(reference, 'files'));
  assert.ok(converted.size > 0, 'no converted videos under ' + reference);
  const worker = startWorker();
  const started = performance.now();
  const result = await worker.open(diskFile(process.env.MKW_DISC_IMAGE));
  console.log(`opened and indexed in ${(performance.now() - started).toFixed(0)} ms: ${worker.logs.find((line) => /menu videos/.test(line))}`);
  assert.equal(result.valid, true, result.reason);
  worker.game.postMessage({ type: 'hello' });
  const [manifest] = await worker.waitFor((m) => m.type === 'manifest');
  const sizes = manifestSizes(manifest.text);
  const extracted = process.env.MKW_DISC_EXTRACTED;
  for (const [name, size] of sizes) {
    if (!name.startsWith('DATA/files/thp/')) continue;
    if (converted.has(name)) {
      assert.equal(size, fs.statSync(converted.get(name)).size, name + ' has the converted size');
    } else if (extracted) {
      assert.equal(size, fs.statSync(path.join(extracted, name.slice(5))).size, name + ' is not converted, as by the script');
    }
  }
  for (const [name, file] of converted) {
    assert.ok(sizes.has(name), name + ' is on the disc');
    const bytes = await readWhole(worker, name, sizes.get(name), 1 << 20);
    assert.equal(sha256(bytes), sha256(fs.readFileSync(file)), name + ' matches the script\'s output byte for byte');
    worker.received.length = 0;
  }
});

test('a file that is not a disc image fails with a readable reason', { skip: !wasmBytes && 'no disc wasm built' }, async () => {
  const worker = startWorker();
  const result = await worker.open(memoryFile(Buffer.alloc(0x10000), 'holiday.rvz'));
  assert.equal(result.type, 'failed');
  assert.match(result.message, /not a disc image/);
  assert.match(result.message, /RVZ/);
});

test('your own disc image (MKW_DISC_IMAGE) validates and reads like the extracted tree',
     { skip: !(wasmBytes && process.env.MKW_DISC_IMAGE) && 'set MKW_DISC_IMAGE to run' }, async () => {
  const worker = startWorker();
  const started = performance.now();
  const result = await worker.open(diskFile(process.env.MKW_DISC_IMAGE));
  console.log(`opened ${result.gameId} ${result.region} valid=${result.valid} files=${result.files} in ${(performance.now() - started).toFixed(0)} ms`);
  assert.equal(result.valid, true, result.reason);
  worker.game.postMessage({ type: 'hello' });
  const [manifest] = await worker.waitFor((m) => m.type === 'manifest');
  const sizes = new Map(manifest.text.split('\n').filter((l) => l.startsWith('f ')).map((l) => {
    const [, size, name] = /^f (\d+) (.+)$/.exec(l);
    return [name, Number(size)];
  }));
  const chunkSize = 1 << 20;
  for (const name of ['DATA/sys/fst.bin', 'DATA/files/Race/Common.szs', 'DATA/files/Race/Course/castle_course.szs',
                      'DATA/files/sound/revo_kart.brsar']) {
    const size = sizes.get(name);
    assert.ok(size > 0, name);
    const last = Math.min(Math.ceil(size / chunkSize), 8) - 1;
    const t0 = performance.now();
    worker.game.postMessage({ type: 'read', path: name, chunkSize, first: 0, last, priority: 0 });
    await worker.waitFor((m) => m.type === 'chunk' && m.path === name && m.index === last);
    const bytes = Buffer.concat([...Array(last + 1).keys()].map((i) =>
      Buffer.from(worker.received.find((m) => m.type === 'chunk' && m.path === name && m.index === i).bytes)));
    console.log(`${name}: ${bytes.length} bytes in ${(performance.now() - t0).toFixed(1)} ms`);
    const extracted = process.env.MKW_DISC_EXTRACTED && path.join(process.env.MKW_DISC_EXTRACTED, name.slice(5));
    if (extracted && fs.existsSync(extracted)) {
      const reference = fs.readFileSync(extracted).subarray(0, bytes.length);
      assert.equal(sha256(bytes), sha256(reference), name + ' matches the extracted copy');
    }
  }
});
