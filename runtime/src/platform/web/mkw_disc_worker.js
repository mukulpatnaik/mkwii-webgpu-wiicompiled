// SPDX-License-Identifier: GPL-3.0-or-later
// Disc reader worker: the player's own disc image, read on their device and never uploaded.
//
// shell.html starts this worker with the File the player picked and posts {type: 'open', file,
// channel}. The worker opens the image with nod compiled to WebAssembly (disc-wasm/, built next to
// the page as mkw_disc.wasm), whose only input is a synchronous read callback served here with
// FileReaderSync on File.slice(). It identifies the disc by its game ID and the SHA-256 of
// main.dol and StaticR.rel, replies {type: 'opened', ...} (or {type: 'failed', message}), and then
// serves the game's /game mount (mkw_discfs.js, on the WASMFS worker) over a BroadcastChannel
// named by the page:
//   backend -> worker  {type: 'hello'}                                  asks for the manifest
//                      {type: 'read', path, chunkSize, first, last, priority}
//   worker -> backend  {type: 'manifest', text}    the same format as a staged game/manifest.txt
//                      {type: 'chunk', path, index, bytes} | {type: 'chunk-error', path, index, message}
// Paths are relative to /game ("DATA/sys/main.dol", "DATA/files/Race/Common.szs"). Reads are
// queued per chunk and served lowest priority value first (0 = the game is waiting), so
// background prefetches never hold up a read the game is blocked on for more than one chunk.
'use strict';

// From projects/*/recomp.yml (inputs.dol.sha256, inputs.rel.sha256): the clean retail executables
// each translation project accepts. tests/mkw_disc_worker.test.mjs checks the two stay in step.
const REGIONS = {
  RMCP01: {name: 'PAL', dol: '80d18895b39c63bd80f457398bfcbb91b7d16ac116a41a88967e954080155b05',
           rel: '16d9d146112541fefea701ecb5bc1a496f9d50e4a752fbb5b6778e7c6399f67d'},
  RMCE01: {name: 'NTSC-U', dol: 'd2beec1b1645fcd134efe9e7e63774b546667764ed8d431029daccd725995694',
           rel: '1168107f8fdef27a356df76036db55afe4fbf7752606dbac991726701133a617'},
  RMCJ01: {name: 'NTSC-J', dol: '1b9621ef7c5d97dada103e50e5389730e67f3c2545dda592edd4b5843655af91',
           rel: '88539012d357a1420724e51dc7e351192ce696da4b0045994895518a3fad6fae'},
  RMCK01: {name: 'NTSC-K', dol: '3098a1e9259b4915e32a4ccb5a1f124823f2a0914db29cd2476e10bdb01a77da',
           rel: 'f441b08e4ccc2d64aadcac8429973f10ea6b1cc8f175500fc084983775f7b3e5'},
};
// disc_sys selectors and the names the extracted layout (nodtool extract) gives these files.
const SYSTEM_FILES = [['boot.bin', 3], ['bi2.bin', 4], ['apploader.img', 5], ['fst.bin', 2], ['main.dol', 1]];
const MAX_CHUNK = 16 * 1024 * 1024;

let wasmReady = null;
let exports = null;
let file = null, fileSize = 0, reader = null;
let entries = null;        // "DATA/..." -> {offset, size} (partition data) or {bytes} (system files)
let manifestText = '';
let channel = null;
const stats = {hostReads: 0, hostBytes: 0, chunks: 0, chunkBytes: 0, readMs: 0, maxReadMs: 0,
               demandChunks: 0, demandWaitMs: 0, errors: 0};
let reported = '', reportTimer = 0;

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

function memory() { return new Uint8Array(exports.memory.buffer); }

function lastError() {
  const cap = 1024, pointer = exports.disc_alloc(cap);
  const length = exports.disc_last_error(pointer, cap);
  const text = new TextDecoder().decode(memory().slice(pointer, pointer + Math.min(length, cap)));
  exports.disc_free(pointer, cap);
  return text;
}

function hostReadAt(pointer, length, offsetLow, offsetHigh) {
  const offset = (offsetHigh >>> 0) * 0x100000000 + (offsetLow >>> 0);
  try {
    if (offset + length > fileSize) return 1;
    const bytes = reader.readAsArrayBuffer(file.slice(offset, offset + length));
    if (bytes.byteLength !== length) return 1;
    memory().set(new Uint8Array(bytes), pointer);
    stats.hostReads++;
    stats.hostBytes += length;
    return 0;
  } catch (failed) {
    // The file was moved, changed or became unreadable after it was picked.
    console.error('[web-disc] reading the image failed at ' + offset + ': ' + failed);
    return 2;
  }
}

function loadWasm() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const response = await fetch(new URL('mkw_disc.wasm', self.location.href));
      if (!response.ok) throw new Error('the disc reader (mkw_disc.wasm) is missing from this site: HTTP ' + response.status);
      const {instance} = await WebAssembly.instantiate(await response.arrayBuffer(),
                                                       {env: {host_read_at: hostReadAt}});
      exports = instance.exports;
    })();
    wasmReady.catch(() => { wasmReady = null; });
  }
  return wasmReady;
}

// Copies a result the wasm sizes itself: call(pointer, capacity) returns the full length.
function readSized(call, initial) {
  let cap = initial, pointer = exports.disc_alloc(cap);
  try {
    let length = Number(call(pointer, cap));
    if (length < 0) throw new Error(lastError());
    if (length > cap) {
      exports.disc_free(pointer, cap);
      cap = length;
      pointer = exports.disc_alloc(cap);
      length = Number(call(pointer, cap));
      if (length < 0) throw new Error(lastError());
    }
    return memory().slice(pointer, pointer + length);
  } finally {
    exports.disc_free(pointer, cap);
  }
}

function readRange(entry, start, length) {
  if (entry.bytes) return entry.bytes.slice(start, start + length);
  const pointer = exports.disc_alloc(length);
  try {
    const offset = entry.offset + start;
    if (exports.disc_read_at(offset >>> 0, Math.floor(offset / 0x100000000), pointer, length) !== 0) {
      throw new Error(lastError());
    }
    return memory().slice(pointer, pointer + length);
  } finally {
    exports.disc_free(pointer, length);
  }
}

function findEntry(path) {
  const lower = path.toLowerCase();
  for (const [name, entry] of entries) if (name.toLowerCase() === lower) return entry;
  return null;
}

function unsupportedFormatHint(name) {
  return /\.(rvz|wia|gcz|nkit\.iso|wbf[1-9])$/i.test(name)
    ? ' Compressed images (RVZ, WIA, GCZ, NKit) cannot be read here: convert yours to ISO or WBFS with Dolphin or nodtool first.'
    : '';
}

async function open(picked) {
  const started = performance.now();
  await loadWasm();
  file = picked;
  fileSize = picked.size;
  reader = new FileReaderSync();
  if (exports.disc_open(fileSize >>> 0, Math.floor(fileSize / 0x100000000)) !== 0) {
    throw new Error('This file is not a disc image that can be read (' + lastError() + ').' +
                    unsupportedFormatHint(picked.name || ''));
  }
  const idPointer = exports.disc_alloc(6);
  exports.disc_game_id(idPointer);
  const gameId = new TextDecoder().decode(memory().slice(idPointer, idPointer + 6)).replace(/[^\x20-\x7e]/g, '?');
  exports.disc_free(idPointer, 6);

  entries = new Map();
  const lines = ['d DATA', 'd DATA/sys'];
  for (const [name, which] of SYSTEM_FILES) {
    const bytes = readSized((pointer, cap) => exports.disc_sys(which, pointer, cap), 4 << 20);
    entries.set('DATA/sys/' + name, {bytes, size: bytes.byteLength});
    lines.push('f ' + bytes.byteLength + ' DATA/sys/' + name);
  }
  lines.push('d DATA/files');
  const listing = new TextDecoder().decode(readSized((pointer, cap) => exports.disc_list(pointer, cap), 1 << 20));
  let files = 0, bytes = 0;
  for (const line of listing.split('\n')) {
    const fields = line.split('\t');
    if (fields[0] === 'd' && fields.length === 2 && fields[1]) {
      lines.push('d DATA/files/' + fields[1]);
    } else if (fields[0] === 'f' && fields.length === 4 && fields[3]) {
      const entry = {offset: Number(fields[1]), size: Number(fields[2])};
      entries.set('DATA/files/' + fields[3], entry);
      lines.push('f ' + entry.size + ' DATA/files/' + fields[3]);
      files++;
      bytes += entry.size;
    }
  }
  manifestText = lines.join('\n') + '\n';

  const region = REGIONS[gameId] || null;
  const result = {type: 'opened', gameId, region: region ? region.name : '', files, bytes,
                  dolSha256: '', relSha256: '', dolOk: false, relOk: false, valid: false, reason: ''};
  if (!/^RMC[A-Z]01$/.test(gameId)) {
    result.reason = 'This is not Mario Kart Wii (the disc says ' + gameId + ').';
  } else {
    result.dolSha256 = hex(await crypto.subtle.digest('SHA-256', entries.get('DATA/sys/main.dol').bytes));
    const rel = findEntry('DATA/files/rel/StaticR.rel');
    if (rel) result.relSha256 = hex(await crypto.subtle.digest('SHA-256', readRange(rel, 0, rel.size)));
    result.dolOk = !!region && result.dolSha256 === region.dol;
    result.relOk = !!region && result.relSha256 === region.rel;
    result.valid = result.dolOk && result.relOk;
    result.reason = !region ? 'No translation of the ' + gameId + ' release of Mario Kart Wii exists.'
      : result.valid ? ''
      : 'This ' + region.name + ' disc image does not match a clean retail dump (' +
        (!result.dolOk && !result.relOk ? 'main.dol and StaticR.rel differ' : result.dolOk ? 'StaticR.rel differs' : 'main.dol differs') +
        '). Modified or patched images are not supported.';
  }
  result.ms = Math.round(performance.now() - started);
  console.log('[web-disc] opened ' + gameId + ' (' + (region ? region.name : 'unknown region') + '): ' +
              files + ' files, main.dol ' + (result.dolOk ? 'ok' : 'differs') + ', StaticR.rel ' +
              (result.relOk ? 'ok' : 'differs') + ', ' + result.ms + ' ms, ' + stats.hostReads +
              ' image reads');
  return result;
}

// Chunk jobs, one per (path, chunk). A repeated request only raises a queued job's priority.
const jobs = new Map();
let sequence = 0, scheduled = false;
const pump = new MessageChannel();
pump.port1.onmessage = () => { scheduled = false; runNextJob(); };
function schedule() {
  if (!scheduled && jobs.size) {
    scheduled = true;
    pump.port2.postMessage(0);
  }
}

function enqueue(path, chunkSize, index, priority) {
  const key = path + ':' + chunkSize + ':' + index;
  const job = jobs.get(key);
  if (job) {
    if (priority < job.priority) job.priority = priority;
    return;
  }
  jobs.set(key, {key, path, chunkSize, index, priority, sequence: sequence++, queued: performance.now()});
}

function runNextJob() {
  let next = null;
  for (const job of jobs.values()) {
    if (!next || job.priority < next.priority ||
        (job.priority === next.priority && job.sequence < next.sequence)) next = job;
  }
  if (!next) return;
  jobs.delete(next.key);
  const {path, chunkSize, index} = next;
  try {
    const entry = entries && entries.get(path);
    if (!entry) throw new Error('no such file on the disc: ' + path);
    const start = index * chunkSize;
    const length = Math.min(chunkSize, entry.size - start);
    if (!(length > 0)) throw new Error('read past the end of ' + path);
    const begun = performance.now();
    const bytes = readRange(entry, start, length);
    const elapsed = performance.now() - begun;
    stats.chunks++;
    stats.chunkBytes += length;
    stats.readMs += elapsed;
    stats.maxReadMs = Math.max(stats.maxReadMs, elapsed);
    if (next.priority === 0) {
      stats.demandChunks++;
      stats.demandWaitMs += performance.now() - next.queued;
    }
    channel.postMessage({type: 'chunk', path, index, chunkSize, bytes: bytes.buffer});
  } catch (failed) {
    stats.errors++;
    channel.postMessage({type: 'chunk-error', path, index, message: String(failed && failed.message || failed)});
  }
  schedule();
}

function serve(name) {
  if (channel) channel.close();
  channel = new BroadcastChannel(name);
  channel.onmessage = ({data}) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'hello') {
      channel.postMessage({type: 'manifest', text: manifestText});
    } else if (data.type === 'read') {
      const {path, chunkSize, first, last, priority} = data;
      if (typeof path !== 'string' || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 ||
          chunkSize > MAX_CHUNK || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) ||
          first < 0 || last < first) return;
      for (let index = first; index <= last; index++) enqueue(path, chunkSize, index, Number(priority) || 0);
      schedule();
    }
  };
  // The game may already be waiting for the manifest (it asks again until it arrives).
  channel.postMessage({type: 'manifest', text: manifestText});
  if (reportTimer) return;
  reportTimer = setInterval(() => {
    const line = 'chunks=' + stats.chunks + ' (' + (stats.chunkBytes / 1048576).toFixed(1) + ' MiB) ' +
      'read avg=' + (stats.chunks ? stats.readMs / stats.chunks : 0).toFixed(1) + 'ms max=' +
      stats.maxReadMs.toFixed(1) + 'ms, demand chunks=' + stats.demandChunks + ' queue+read avg=' +
      (stats.demandChunks ? stats.demandWaitMs / stats.demandChunks : 0).toFixed(1) + 'ms, image reads=' +
      stats.hostReads + ' (' + (stats.hostBytes / 1048576).toFixed(1) + ' MiB), errors=' + stats.errors;
    if (line !== reported) console.log('[web-disc] worker: ' + line);
    reported = line;
  }, 10000);
}

self.onmessage = async ({data}) => {
  if (!data || data.type !== 'open') return;
  try {
    const result = await open(data.file);
    serve(data.channel);
    self.postMessage(result);
  } catch (failed) {
    self.postMessage({type: 'failed', message: String(failed && failed.message || failed)});
  }
};
