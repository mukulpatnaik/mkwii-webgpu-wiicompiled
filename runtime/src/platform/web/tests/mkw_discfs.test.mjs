// Tests for the local-disc half of the /game mount (mkw_discfs.js), against a scripted stand-in
// for the disc worker on the other end of its BroadcastChannel. No disc image or wasm is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../mkw_discfs.js', import.meta.url), 'utf8'))
  .replace(/\{\{\{\s*cDefs\.(\w+)\s*\}\}\}/g, (_, name) => ({ EROFS: 30, ENOENT: 2, EIO: 5 })[name]);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const text = (bytes) => new TextDecoder().decode(bytes);
const encode = (value) => new TextEncoder().encode(value);

const discFiles = {
  'DATA/sys/fst.bin': encode('0123456789'),
  'DATA/files/test.bin': encode('abcdefghijkl'),
  'DATA/files/Race/Course/castle_course.szs': encode('CASTLEcastle'),
  'DATA/files/Race/Course/shopping_course.szs': encode('SHOPPINGshop'),
  'DATA/files/Race/Kart/mr_kart-mr.szs': encode('kart-mario'),
  'DATA/files/sound/strm/n_castle_n.brstm': encode('normal-lap'),
  'DATA/files/sound/strm/n_castle_F.brstm': encode('final-lap!'),
};
const manifest = 'd DATA\nd DATA/sys\nd DATA/files\n' +
  Object.entries(discFiles).map(([name, bytes]) => `f ${bytes.byteLength} ${name}`).join('\n') + '\n';

function setup({ chunkSize = 4, worker: script = {}, cacheLimit, manifestTimeout, readTimeout } = {}) {
  const channels = new Map();
  class Channel {
    constructor(name) { this.name = name; this.onmessage = null; (channels.get(name) || channels.set(name, new Set()).get(name)).add(this); }
    postMessage(data) {
      for (const other of channels.get(this.name)) {
        if (other !== this) { const copy = structuredClone(data); setImmediate(() => other.onmessage?.({ data: copy })); }
      }
    }
    close() { channels.get(this.name).delete(this); }
  }
  // The disc worker: answers 'hello' with the manifest and each requested chunk, unless the test
  // holds or rewrites its answers.
  const requests = [];
  const worker = new Channel('disc-test');
  worker.onmessage = ({ data }) => {
    if (data.type === 'hello') {
      if (script.preparing?.()) worker.postMessage({ type: 'preparing' });
      else if (!script.silent) worker.postMessage({ type: 'manifest', text: script.manifest ?? manifest });
      return;
    }
    if (data.type !== 'read') return;
    requests.push(data);
    for (let index = data.first; index <= data.last; index++) {
      const answer = () => {
        if (script.fail?.(data, index)) {
          worker.postMessage({ type: 'chunk-error', path: data.path, index, message: 'host read failed' });
          return;
        }
        const bytes = discFiles[data.path] ?? script.bytes?.(data.path);
        if (!bytes) { worker.postMessage({ type: 'chunk-error', path: data.path, index, message: 'no such file' }); return; }
        let chunk = bytes.slice(index * data.chunkSize, (index + 1) * data.chunkSize);
        if (script.rewrite) chunk = script.rewrite(data.path, index, chunk);
        if (!chunk) return;
        worker.postMessage({ type: 'chunk', path: data.path, index, chunkSize: data.chunkSize, bytes: chunk.buffer });
      };
      if (script.hold) script.hold(data, index, answer); else answer();
    }
  };
  let testSource = source;
  if (cacheLimit !== undefined) testSource = testSource.replace('const CACHE_LIMIT = 256 * 1024 * 1024;', `const CACHE_LIMIT = ${cacheLimit};`);
  if (manifestTimeout !== undefined) testSource = testSource.replace('const MANIFEST_TIMEOUT_MS = 30000;', `const MANIFEST_TIMEOUT_MS = ${manifestTimeout};`);
  if (readTimeout !== undefined) testSource = testSource.replace('const READ_TIMEOUT_MS = 30000;', `const READ_TIMEOUT_MS = ${readTimeout};`);
  const backends = {}, errors = [], heap = new Uint8Array(4096), timers = [];
  let library;
  const fileUrls = { 1: 'manifest.txt', 2: 'DATA/files/test.bin', 3: 'DATA/files/Race/Course/castle_course.szs',
                     4: 'DATA/files/sound/strm/n_castle_n.brstm', 5: 'DATA/files/missing.bin', 6: 'DATA/sys/fst.bin',
                     7: 'DATA/files/thp/title/title.thp' };
  vm.runInNewContext(testSource, {
    addToLibrary(value) { library = value; },
    wasmFS$backends: backends, HEAPU8: heap,
    UTF8ToString: (s) => s,
    __wasmfs_fetch_get_file_url: (file) => 'game//' + fileUrls[file],
    __wasmfs_fetch_get_chunk_size: () => chunkSize,
    BroadcastChannel: Channel, TextEncoder, ArrayBuffer, Uint8Array, Map, Set, Promise, performance,
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.push(id); return id; },
    clearTimeout, clearInterval,
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); id.unref(); timers.push(id); return id; },
    console: { error: (...args) => errors.push(args.join(' ')), log: () => {} },
  });
  library.$mkwCreateDiscBackend(1, 'disc-test');
  const prefetch = new Channel('mkw-prefetch');
  const done = () => { for (const id of timers) { clearTimeout(id); clearInterval(id); } };
  return { backend: backends[1], requests, errors, heap, prefetch, done };
}

test('the manifest comes from the disc worker and is served as /game/manifest.txt', async () => {
  const { backend, heap, requests, done } = setup();
  assert.equal(await backend.getSize(1), manifest.length);
  assert.equal(await backend.read(1, 0, manifest.length, 0), manifest.length);
  assert.equal(text(heap.slice(0, manifest.length)), manifest);
  assert.equal(await backend.getSize(6), 10);
  assert.equal(await backend.getSize(5), 0);
  assert.equal(await backend.read(5, 0, 4, 0), -2);
  assert.equal(requests.length, 0);
  done();
});

test('reads cross chunk boundaries, request only missing chunks, and hit the cache afterwards', async () => {
  const { backend, heap, requests, done } = setup();
  assert.equal(await backend.read(2, 0, 8, 2), 8);
  assert.equal(text(heap.slice(0, 8)), 'cdefghij');
  assert.deepEqual(requests.map(({ path, first, last, priority, chunkSize }) => [path, first, last, priority, chunkSize]),
                   [['DATA/files/test.bin', 0, 2, 0, 4]]);
  assert.equal(await backend.read(2, 100, 4, 8), 4);
  assert.equal(text(heap.slice(100, 104)), 'ijkl');
  assert.equal(await backend.read(2, 200, 100, 10), 2);  // clamped to the file size
  assert.equal(text(heap.slice(200, 202)), 'kl');
  assert.equal(requests.length, 1);
  done();
});

test('concurrent cold reads share one request per chunk', async () => {
  const held = [];
  const { backend, heap, requests, done } = setup({ worker: { hold: (data, index, answer) => held.push(answer) } });
  const first = backend.read(2, 0, 4, 0);
  const second = backend.read(2, 10, 6, 2);
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(requests.map(({ first, last }) => [first, last]), [[0, 0], [1, 1]]);
  held.forEach((answer) => answer());
  assert.deepEqual(await Promise.all([first, second]), [4, 6]);
  assert.equal(text(heap.slice(0, 4)), 'abcd');
  assert.equal(text(heap.slice(10, 16)), 'cdefgh');
  done();
});

test('an archive read asks for its own chunks first and the rest of the file behind them', async () => {
  const { backend, heap, requests, done } = setup();
  assert.equal(await backend.read(3, 0, 2, 0), 2);
  assert.equal(text(heap.slice(0, 2)), 'CA');
  assert.deepEqual(requests.slice(0, 2).map(({ path, first, last, priority }) => [path, first, last, priority]), [
    ['DATA/files/Race/Course/castle_course.szs', 0, 0, 0],
    ['DATA/files/Race/Course/castle_course.szs', 1, 2, 1],
  ]);
  for (let i = 0; i < 10; i++) await tick();
  const count = requests.filter((r) => r.path.endsWith('castle_course.szs')).length;
  assert.equal(await backend.read(3, 0, 12, 0), 12);
  assert.equal(text(heap.slice(0, 12)), 'CASTLEcastle');
  assert.equal(requests.filter((r) => r.path.endsWith('castle_course.szs')).length, count);
  done();
});

test('reading a course reads the next Grand Prix course ahead, and a lap stream its final-lap stream', async () => {
  const { backend, requests, errors, done } = setup();
  await backend.read(3, 0, 1, 0);
  await backend.read(4, 0, 1, 0);
  for (let i = 0; i < 10; i++) await tick();
  const background = requests.filter((r) => r.priority === 2).map((r) => r.path);
  assert.ok(background.includes('DATA/files/Race/Course/shopping_course.szs'));
  assert.ok(background.includes('DATA/files/sound/strm/n_castle_F.brstm'));
  assert.ok(errors.some((line) => /reading \/game\/DATA\/files\/Race\/Course\/shopping_course\.szs ahead/.test(line)));
  done();
});

test('the sound archive regions a race start reads are read ahead in the background, once', async () => {
  const MiB = 1024 * 1024;
  const withArchive = manifest + `f ${100 * MiB} DATA/files/sound/revo_kart.brsar\nf 12 DATA/files/Race/Common.szs\n`;
  const { backend, requests, done } = setup({ chunkSize: MiB, worker: { manifest: withArchive,
    hold: (data, index, answer) => { if (!data.path.endsWith('.brsar') && !data.path.endsWith('Common.szs')) answer(); } } });
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  assert.equal(await backend.read(2, 0, 4, 4), 4);
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(requests.map(({ path, first, last, priority }) => [path.split('/').pop(), first, last, priority]), [
    ['test.bin', 0, 0, 0],
    ['revo_kart.brsar', 0, 15, 2],
    ['Common.szs', 0, 0, 2],
    ['revo_kart.brsar', 19, 21, 2],
    ['revo_kart.brsar', 25, 26, 2],
    ['revo_kart.brsar', 45, 77, 2],
  ]);
  done();
});

test('a playing video keeps two chunks read ahead, and menu videos start warm', async () => {
  const MiB = 1024 * 1024;
  const withVideos = manifest + `f ${5 * MiB} DATA/files/thp/course/flower.thp\nf ${5 * MiB} DATA/files/thp/title/title.thp\n` +
    `f ${MiB / 2} DATA/files/thp/title/top_menu.thp\nf ${5 * MiB} DATA/files/thp/ending/ending_normal.thp\n`;
  const video = new Uint8Array(5 * MiB);
  const { backend, requests, done } = setup({ chunkSize: MiB, worker: { manifest: withVideos, bytes: () => video,
    hold: (data, index, answer) => { if (data.priority !== 2) answer(); } } });
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  for (let i = 0; i < 10; i++) await tick();
  const background = requests.filter((r) => r.path.includes('/thp/')).map(({ path, first, last, priority }) => [path.split('/').slice(-2).join('/'), first, last, priority]);
  assert.deepEqual(background, [['course/flower.thp', 0, 1, 2], ['title/top_menu.thp', 0, 0, 2]]);
  requests.length = 0;
  await backend.read(7, 0, 16, 2 * MiB + 5);
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(requests.map(({ first, last, priority }) => [first, last, priority]), [[2, 2, 0], [3, 4, 1]]);
  done();
});

test('race prefetch requests read listed archives that exist, ignoring case and unsafe names', async () => {
  const { backend, prefetch, requests, errors, done } = setup();
  await backend.read(2, 0, 1, 0);  // the first read starts listening
  prefetch.postMessage({ paths: ['DATA/files/Race/Kart/MR_KART-mr.szs', 'DATA/files/Race/Kart/nope-xx.szs',
                                 'DATA/files/../sys/fst.bin', 'DATA/files/Race/Course/castle_course.szs'] });
  for (let i = 0; i < 20; i++) await tick();
  const urgent = requests.filter((r) => r.priority === 1).map((r) => [r.path, r.first, r.last]);
  assert.deepEqual(urgent, [['DATA/files/Race/Kart/mr_kart-mr.szs', 0, 2], ['DATA/files/Race/Course/castle_course.szs', 0, 2]]);
  assert.ok(errors.some((line) => /race prefetch: 2 of 4/.test(line)));
  done();
});

test('a demand read raises the priority of chunks a race prefetch already asked for', async () => {
  const held = [];
  const { backend, prefetch, heap, requests, done } = setup({ worker: { hold: (data, index, answer) => held.push(answer) } });
  const first = backend.read(2, 0, 1, 0);  // the first read starts listening for prefetches
  for (let i = 0; i < 5; i++) await tick();
  held.splice(0).forEach((answer) => answer());
  await first;
  prefetch.postMessage({ paths: ['DATA/files/Race/Course/castle_course.szs'] });
  for (let i = 0; i < 10; i++) await tick();
  const read = backend.read(3, 0, 1, 0);
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(requests.filter((r) => r.path.endsWith('castle_course.szs')).map(({ first, last, priority, raise }) => [first, last, priority, !!raise]),
                   [[0, 2, 1, false], [0, 0, 0, true]]);
  held.forEach((answer) => answer());
  assert.equal(await read, 1);
  assert.equal(text(heap.slice(0, 1)), 'C');
  done();
});

test('a raised priority is re-sent for chunks already requested at a lower one', async () => {
  const held = [];
  const { backend, requests, done } = setup({ worker: { hold: (data, index, answer) => held.push(answer) } });
  await Promise.race([backend.read(4, 0, 1, 0), (async () => { for (let i = 0; i < 10; i++) await tick(); })()]);
  // The lap stream's read asked for chunk 0 now and chunks 1-2 at priority 1; read chunk 2 now.
  const later = backend.read(4, 50, 1, 9);
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(requests.filter((r) => r.path.endsWith('n_castle_n.brstm')).map(({ first, last, priority, raise }) => [first, last, priority, !!raise]),
                   [[0, 0, 0, false], [1, 2, 1, false], [2, 2, 0, true]]);
  held.forEach((answer) => answer());
  assert.equal(await later, 1);
  done();
});

test('only a read the game waits on times out, counted from when it starts waiting', async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const held = [];
  const { backend, heap, errors, done } = setup({ readTimeout: 100, worker: {
    hold: (data, index, answer) => { if (data.priority === 0 && index === 0) answer(); else held.push(answer); } } });
  // The course archive's first chunk now; its chunks 1-2 are read ahead and stay queued.
  assert.equal(await backend.read(3, 0, 1, 0), 1);
  await sleep(70);
  // The game comes to need chunk 2 while it is still queued behind the read ahead, and the
  // worker answers 140 ms after the read ahead was asked for: longer than the timeout, but only
  // 70 ms after the game started waiting.
  const read = backend.read(3, 0, 4, 8);
  await sleep(70);
  held.splice(0).forEach((answer) => answer());
  assert.equal(await read, 4);
  assert.equal(text(heap.slice(0, 4)), 'stle');
  assert.ok(!errors.some((line) => /timed out/.test(line)), errors.join('\n'));
  // A read the game waits on that is never answered still fails.
  assert.equal(await backend.read(2, 0, 4, 4), -5);
  assert.ok(errors.some((line) => /test\.bin at 4: disc read timed out/.test(line)));
  done();
});

test('one read asks for new chunks and raises queued ones in separate requests', async () => {
  const held = [];
  const { backend, requests, done } = setup({ worker: { hold: (data, index, answer) => held.push(answer) } });
  // The lap stream's first read asks for chunk 0 now and reads chunks 1-2 ahead.
  const first = backend.read(4, 0, 1, 0);
  for (let i = 0; i < 10; i++) await tick();
  // Chunks 0-2 at once: 0 is already wanted now, 1-2 are raised.
  const whole = backend.read(4, 0, 10, 0);
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(requests.filter((r) => r.path.endsWith('n_castle_n.brstm')).map(({ first, last, priority, raise }) => [first, last, priority, !!raise]),
                   [[0, 0, 0, false], [1, 2, 1, false], [1, 2, 0, true]]);
  held.forEach((answer) => answer());
  assert.deepEqual(await Promise.all([first, whole]), [1, 10]);
  done();
});

test('a worker error for a chunk is EIO, and the next read asks again', async () => {
  let attempts = 0;
  const { backend, heap, requests, errors, done } = setup({ worker: { fail: () => ++attempts === 1 } });
  assert.equal(await backend.read(2, 0, 4, 0), -5);
  assert.ok(errors.some((line) => /read failed: \/game\/DATA\/files\/test\.bin at 0: host read failed/.test(line)));
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  assert.equal(text(heap.slice(0, 4)), 'abcd');
  assert.equal(requests.length, 2);
  done();
});

test('chunks of the wrong size are ignored rather than copied into game memory', async () => {
  const { backend, heap, done } = setup({ readTimeout: 50, worker: { rewrite: (path, index, chunk) => encode('XXXXXXXX') } });
  heap.fill(123);
  assert.equal(await backend.read(2, 0, 4, 0), -5);
  assert.ok(heap.every((byte) => byte === 123));
  done();
});

test('the cache stays bounded and evicted chunks are read again', async () => {
  const { backend, heap, requests, done } = setup({ cacheLimit: 8 });
  assert.equal(await backend.read(2, 0, 4, 0), 4);   // chunk 0
  assert.equal(await backend.read(2, 0, 4, 4), 4);   // chunk 1
  assert.equal(await backend.read(2, 0, 4, 8), 4);   // chunk 2 evicts chunk 0
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  assert.equal(text(heap.slice(0, 4)), 'abcd');
  assert.deepEqual(requests.map((r) => r.first), [0, 1, 2, 0]);
  done();
});

test('without an answer from the disc worker, reads fail instead of hanging', async () => {
  const { backend, errors, done } = setup({ manifestTimeout: 30, worker: { silent: true } });
  assert.equal(await backend.read(2, 0, 4, 0), -5);
  assert.equal(await backend.getSize(2), 0);
  assert.ok(errors.some((line) => /did not answer/.test(line)));
  done();
});

test('a worker that is still preparing the manifest is waited for past the timeout', async () => {
  const ready = performance.now() + 1200;
  const { backend, heap, errors, done } = setup({ manifestTimeout: 700, worker: { preparing: () => performance.now() < ready } });
  assert.equal(await backend.read(2, 0, 4, 0), 4);
  assert.equal(text(heap.slice(0, 4)), 'abcd');
  assert.ok(!errors.some((line) => /did not answer/.test(line)));
  done();
});

test('the backend is read-only', async () => {
  const { backend, done } = setup();
  assert.equal(await backend.write(2, 0, 4, 0), -30);
  done();
});
