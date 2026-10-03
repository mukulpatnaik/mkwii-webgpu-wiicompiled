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

function startWorker({ regions } = {}) {
  const Channel = channelHub();
  const posted = [];
  const logs = [];
  let text = source;
  if (regions) text = text.replace(/const REGIONS = \{[\s\S]*?\n\};/, 'const REGIONS = ' + JSON.stringify(regions) + ';');
  const self = { location: { href: 'https://game.test/mkw_disc_worker.js' }, postMessage: (m) => posted.push(m) };
  const timers = [];
  vm.runInNewContext(text, {
    self, BroadcastChannel: Channel, MessageChannel: ImmediateChannel, FileReaderSync, WebAssembly, TextDecoder, URL,
    crypto: webcrypto, performance, console: { log: (s) => logs.push(s), error: (s) => logs.push(s) },
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
  return { open, game, received, waitFor, logs, timers };
}

// A GameCube-layout disc: boot.bin, bi2.bin, an apploader, a DOL, an FST and three files.
function syntheticDisc(gameId = 'RMCE01') {
  const files = {
    'rel/StaticR.rel': Buffer.from('static rel ' + 'r'.repeat(5000)),
    'Race/Course/castle_course.szs': Buffer.alloc(70000).map((_, i) => (i * 7) & 255),
    'opening.bnr': Buffer.from('banner'),
  };
  const image = Buffer.alloc(0x40000);
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
  let next = 0x8000;
  const placed = {};
  for (const [name, bytes] of Object.entries(files)) {
    bytes.copy(image, next);
    placed[name] = { offset: next, size: bytes.length };
    next = (next + bytes.length + 0x7FFF) & ~0x7FFF;
  }
  // FST at 0x4000: root, "Race" > "Course" > castle_course.szs, opening.bnr, "rel" > StaticR.rel.
  const names = [];
  const nameOffset = (name) => { const at = names.reduce((n, s) => n + s.length + 1, 0); names.push(name); return at; };
  const nodes = [];
  const dir = (name, parent, end) => nodes.push([1, nameOffset(name), parent, end]);
  const file = (name, key) => nodes.push([0, nameOffset(name), placed[key].offset, placed[key].size]);
  nodes.push([1, 0, 0, 0]);  // root; its length is the node count
  dir('Race', 0, 4);
  dir('Course', 1, 4);
  file('castle_course.szs', 'Race/Course/castle_course.szs');
  file('opening.bnr', 'opening.bnr');
  dir('rel', 0, 7);
  file('StaticR.rel', 'rel/StaticR.rel');
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
  image.writeUInt32BE(dol, 0x420);
  image.writeUInt32BE(fst, 0x424);
  image.writeUInt32BE(fstSize, 0x428);
  image.writeUInt32BE(fstSize, 0x42C);
  return { image, files, dolBytes: image.subarray(dol, dol + 0x180) };
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
