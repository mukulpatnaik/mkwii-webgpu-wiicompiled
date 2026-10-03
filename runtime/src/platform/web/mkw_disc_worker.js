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
//   backend -> worker  {type: 'hello'}           asks for the manifest ('preparing' until it is ready)
//                      {type: 'read', path, chunkSize, first, last, priority[, raise: true]}
//   worker -> backend  {type: 'manifest', text}    the same format as a staged game/manifest.txt
//                      {type: 'preparing'}         the manifest follows (menu videos are indexed first)
//                      {type: 'chunk', path, index, bytes} | {type: 'chunk-error', path, index, message}
// Paths are relative to /game ("DATA/sys/main.dol", "DATA/files/Race/Common.szs"). Reads are
// queued per chunk and served lowest priority value first (0 = the game is waiting), so
// background prefetches never hold up a read the game is blocked on for more than one chunk. A
// request marked raise only makes chunks that are still queued more urgent.
//
// The menu's video previews are served at half their frame rate, like a staged folder's (see
// "Menu videos" below), so the manifest lists their converted sizes.
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
// The most chunks one request may queue (mkw_discfs.js asks for at most a few dozen 1 MiB chunks).
const MAX_REQUEST_CHUNKS = 4096;

let wasmReady = null;
let exports = null;
let file = null, fileSize = 0, reader = null;
let entries = null;        // "DATA/..." -> {offset, size[, video]} (partition data) or {bytes} (system files)
let manifestLines = [];    // "d <path>" lines and [path, entry] for files, whose size may still change
let manifestText = '';     // set once the menu videos are indexed
let openGeneration = 0;    // bumped by every 'open', so the indexing of an earlier image stops
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

// `length` bytes of decrypted partition data at `offset`.
function readRaw(offset, length) {
  const pointer = exports.disc_alloc(length);
  try {
    if (exports.disc_read_at(offset >>> 0, Math.floor(offset / 0x100000000), pointer, length) !== 0) {
      throw new Error(lastError());
    }
    return memory().slice(pointer, pointer + length);
  } finally {
    exports.disc_free(pointer, length);
  }
}

function readRange(entry, start, length) {
  if (entry.bytes) return entry.bytes.slice(start, start + length);
  if (entry.video) return readVideoRange(entry, start, length);
  return readRaw(entry.offset + start, length);
}

// Menu videos. A staged folder serves the menu's video previews with every other frame, at half
// the frame rate, so they play at the same speed for half the JPEG decoding (tools/
// web_menu_videos.py in the page tooling makes those copies); played from the disc's originals the
// pre-race menus fell to about 30 fps in Chrome. This is the same conversion, made on the fly:
// kept frames are copied byte for byte and only the THP container's frame links, frame count,
// frame rate and offsets change. The converted file is its rewritten header followed by ranges of
// the original (each kept frame, with its two link words replaced, then whatever followed the last
// frame), so only that map is kept, built by walking the frame chain once when the image opens,
// and chunks are assembled from the original as they are read. The selection and the checks
// follow the script; a file it would refuse is served unchanged here (the script stops staging).
// Container reference: https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/thp.c
const THP_HEADER_SIZE = 48;
const VIDEO_SLAB = 4 << 20;

function isMenuVideo(path) {
  return /^DATA\/files\/thp\/(button|course|battle)\/[^/]+\.thp$/.test(path) ||
         path === 'DATA/files/thp/title/top_menu.thp';
}

function indexMenuVideo(entry) {
  const size = entry.size;
  let slab = null, slabStart = 0;
  // Reads the frame chain front to back through a few large reads instead of one per frame.
  const view = (position, length) => {
    if (!slab || position < slabStart || position + length > slabStart + slab.byteLength) {
      slabStart = position;
      slab = readRaw(entry.offset + position, Math.min(Math.max(VIDEO_SLAB, length), size - position));
    }
    return new DataView(slab.buffer, slab.byteOffset + position - slabStart, length);
  };
  if (size < THP_HEADER_SIZE) throw new Error('Truncated THP header');
  const header = view(0, THP_HEADER_SIZE);
  const field = (index) => header.getUint32(index * 4);
  const magic = field(0), version = field(1), fps = header.getFloat32(16), count = field(5);
  const firstSize = field(6), dataSize = field(7), components = field(8), offsets = field(9);
  const first = field(10), last = field(11);
  if (magic !== 0x54485000 || (version !== 0x10000 && version !== 0x11000)) throw new Error('Unsupported THP version');
  if (!Number.isFinite(fps) || fps <= 0 || count < 2) throw new Error('Invalid THP frame rate/count');
  if (offsets !== 0) throw new Error('Seek-table THP files require a separate conversion');
  if (components < THP_HEADER_SIZE || components + 20 > first || first > size) throw new Error('Invalid component offsets');
  const component = view(components, 5);
  if (component.getUint32(0) !== 1 || component.getUint8(4) !== 0) throw new Error('Only video-only menu previews may be converted');
  const frames = [];
  let position = first, frameSize = firstSize;
  for (let index = 0; index < count; index++) {
    if (frameSize < 12 || position + frameSize > size) throw new Error('Truncated THP frame');
    const links = view(position, 12);
    const next = links.getUint32(0), previous = links.getUint32(4), image = links.getUint32(8);
    if (image > frameSize - 12) throw new Error('Frame image extends past its container');
    if (index && previous !== frames[index - 1].size) throw new Error('Invalid previous-frame link');
    frames.push({position, size: frameSize, next, previous});
    position += frameSize;
    frameSize = next;
  }
  if (frames[frames.length - 1].position !== last || position !== first + dataSize) throw new Error('Invalid final frame/data size');
  if (frameSize !== 0 && frameSize !== frames[0].size) throw new Error('Invalid looping frame link');

  if (count % 2 || fps < 50) throw new Error('Expected an even number of frames at 50 FPS or more');
  const kept = frames.filter((frame, index) => index % 2 === 0);
  // The script also checks its output as a THP, which needs two frames or more.
  if (kept.length < 2) throw new Error('Invalid THP frame rate/count');
  const loop = frames[frames.length - 1].next !== 0;
  const firstHasPrevious = frames[0].previous !== 0;
  const pieces = [];
  let out = first, lastOffset = 0, largest = 0;
  kept.forEach((frame, index) => {
    lastOffset = out;
    const links = new Uint8Array(8);
    const linkView = new DataView(links.buffer);
    linkView.setUint32(0, index + 1 < kept.length ? kept[index + 1].size : loop ? kept[0].size : 0);
    linkView.setUint32(4, index ? kept[index - 1].size : firstHasPrevious ? kept[kept.length - 1].size : 0);
    pieces.push({out, source: frame.position, length: frame.size, links});
    out += frame.size;
    largest = Math.max(largest, frame.size);
  });
  const converted = readRaw(entry.offset, first);
  const fields = new DataView(converted.buffer, converted.byteOffset, THP_HEADER_SIZE);
  fields.setUint32(8, largest);
  fields.setFloat32(16, fps / 2);
  fields.setUint32(20, kept.length);
  fields.setUint32(24, kept[0].size);
  fields.setUint32(28, out - first);
  fields.setUint32(44, lastOffset);
  if (position < size) {
    pieces.push({out, source: position, length: size - position, links: null});
    out += size - position;
  }
  return {header: converted, pieces, size: out};
}

function readVideoRange(entry, start, length) {
  const {header, pieces} = entry.video;
  const result = new Uint8Array(length);
  const end = start + length;
  if (start < header.byteLength) result.set(header.subarray(start, Math.min(end, header.byteLength)));
  let low = 0, high = pieces.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (pieces[middle].out + pieces[middle].length <= start) low = middle + 1; else high = middle;
  }
  let stop = low;
  while (stop < pieces.length && pieces[stop].out < end) stop++;
  if (low === stop) return result;
  // One read of the original covers every piece in the range (they are in the original's order).
  const from = pieces[low], to = pieces[stop - 1];
  const sourceStart = from.source + Math.max(0, start - from.out);
  const source = readRaw(entry.offset + sourceStart, to.source + Math.min(to.length, end - to.out) - sourceStart);
  for (let index = low; index < stop; index++) {
    const piece = pieces[index];
    const a = Math.max(start, piece.out), b = Math.min(end, piece.out + piece.length);
    const at = piece.source + (a - piece.out) - sourceStart;
    result.set(source.subarray(at, at + (b - a)), a - start);
    if (piece.links && a < piece.out + 8) {
      result.set(piece.links.subarray(a - piece.out, Math.min(8, b - piece.out)), a - start);
    }
  }
  return result;
}

// Indexes the menu videos of the open image, giving the event loop a turn between files.
async function prepareMenuVideos(generation) {
  const started = performance.now();
  let count = 0, before = 0, after = 0;
  for (const [path, entry] of entries) {
    if (!isMenuVideo(path) || entry.bytes) continue;
    try {
      const video = indexMenuVideo(entry);
      count++;
      before += entry.size;
      after += video.size;
      entry.video = video;
      entry.size = video.size;
    } catch (failed) {
      console.log('[web-disc] ' + path + ' is served at its original frame rate: ' + (failed && failed.message || failed));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (generation !== openGeneration) return false;
  }
  console.log('[web-disc] menu videos: ' + count + ' at half frame rate, ' + (before / 1e6).toFixed(1) +
              ' -> ' + (after / 1e6).toFixed(1) + ' MB, indexed in ' + Math.round(performance.now() - started) + ' ms');
  return true;
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
  manifestText = '';
  const lines = manifestLines = ['d DATA', 'd DATA/sys'];
  for (const [name, which] of SYSTEM_FILES) {
    const bytes = readSized((pointer, cap) => exports.disc_sys(which, pointer, cap), 4 << 20);
    const entry = {bytes, size: bytes.byteLength};
    entries.set('DATA/sys/' + name, entry);
    lines.push(['DATA/sys/' + name, entry]);
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
      lines.push(['DATA/files/' + fields[3], entry]);
      files++;
      bytes += entry.size;
    }
  }

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

function enqueue(path, chunkSize, index, priority, raiseOnly) {
  const key = path + ':' + chunkSize + ':' + index;
  const job = jobs.get(key);
  if (job) {
    if (priority < job.priority) job.priority = priority;
    return;
  }
  if (raiseOnly) return;
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
      channel.postMessage(manifestText ? {type: 'manifest', text: manifestText} : {type: 'preparing'});
    } else if (data.type === 'read') {
      const {path, chunkSize, first, last, priority} = data;
      if (typeof path !== 'string' || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 ||
          chunkSize > MAX_CHUNK || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) ||
          first < 0 || last < first) return;
      // Only chunks the file has are queued. A range that starts past its end, or names no file,
      // queues its first chunk alone, which is answered with the error in turn.
      const entry = entries && entries.get(path);
      const end = Math.min(last, entry ? Math.max(first, Math.ceil(entry.size / chunkSize) - 1) : first);
      if (end - first >= MAX_REQUEST_CHUNKS) {
        stats.errors++;
        channel.postMessage({type: 'chunk-error', path, index: first,
                             message: 'too many chunks in one request: ' + (end - first + 1)});
        return;
      }
      // A raise (data.raise) is for chunks already requested at a lower priority: it only reorders
      // jobs still queued, since a chunk no longer queued has been read and sent already.
      for (let index = first; index <= end; index++) enqueue(path, chunkSize, index, Number(priority) || 0, !!data.raise);
      schedule();
    }
  };
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

// Lists the files with their final sizes, and sends the list to a game that may be waiting for
// it (the game asks again until it arrives).
function publishManifest() {
  manifestText = manifestLines.map((line) => typeof line === 'string' ? line : 'f ' + line[1].size + ' ' + line[0])
    .join('\n') + '\n';
  channel.postMessage({type: 'manifest', text: manifestText});
}

self.onmessage = async ({data}) => {
  if (!data || data.type !== 'open') return;
  const generation = ++openGeneration;
  let result;
  try {
    result = await open(data.file);
    serve(data.channel);
    self.postMessage(result);
  } catch (failed) {
    self.postMessage({type: 'failed', message: String(failed && failed.message || failed)});
    return;
  }
  // The page shows the result and the player starts the game meanwhile. Only an image the game
  // can play is worth indexing; another one's manifest is published as it is.
  try {
    if (result.valid && !await prepareMenuVideos(generation)) return;
  } catch (failed) {
    // Unreadable video data: the game will meet the same error reading those files.
    console.error('[web-disc] indexing the menu videos failed: ' + (failed && failed.message || failed));
  }
  if (generation === openGeneration) publishManifest();
};
