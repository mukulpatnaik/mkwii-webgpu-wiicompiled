// SPDX-License-Identifier: GPL-3.0-or-later
// The /game mount's file source when the player supplies their own disc image (shell.html picks
// it, mkw_disc_worker.js reads it): the JS half of the WASMFS backend web_platform.cpp mounts,
// selected in mkw_fetchfs.js when the page names a disc channel (MKW_WEB_DISC). It mirrors the
// fetch half's layout so the C++ side is unchanged: the worker sends a manifest in the format of
// a staged game/manifest.txt ("d <path>", "f <size> <path>"), which web_platform.cpp reads back
// from /game/manifest.txt to create the tree, and file data arrives in backend-sized chunks that
// are kept in a bounded LRU cache. The race prefetch API (BroadcastChannel 'mkw-prefetch', posted
// by web_race_warm.cpp) and the related-file warmups work against the same paths as for a staged
// copy, but a read now costs a local decrypt (milliseconds) rather than an HTTP round trip.
//
// This runs on the WASMFS proxy worker. Reads go to the disc worker over a BroadcastChannel whose
// name is unique to the page, so another tab's game never answers.

addToLibrary({
  $mkwCreateDiscBackend__deps: ['$wasmFS$backends', '$UTF8ToString', '_wasmfs_fetch_get_file_url',
                                '_wasmfs_fetch_get_chunk_size'],
  $mkwCreateDiscBackend: function(backend, channelName) {
    const CACHE_LIMIT = 256 * 1024 * 1024;
    const MANIFEST_TIMEOUT_MS = 30000;
    const READ_TIMEOUT_MS = 30000;
    // Request priorities, lowest first: the game is blocked on it; a race is about to read it;
    // the rest of an archive the game has started reading, or a file it will read later.
    const DEMAND = 0, URGENT = 1, BACKGROUND = 2;

    const channel = new BroadcastChannel(channelName);
    const sizes = new Map();            // "/game/DATA/..." -> size
    let manifestBytes = null;
    let lowerKeys = null;
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const hello = () => channel.postMessage({type: 'hello'});
    const helloTimer = setInterval(hello, 500);
    hello();
    const giveUp = setTimeout(() => {
      clearInterval(helloTimer);
      if (!manifestBytes) {
        console.error('[web-disc] the disc reader did not answer; reload the page and choose the disc again');
        resolveReady(false);
      }
    }, MANIFEST_TIMEOUT_MS);

    const fileKeys = new Map();         // file pointer -> key
    const cache = new Map();            // key -> Map(index -> Uint8Array)
    const inflight = new Map();         // "key:index" -> {promise, resolve, reject, priority, timer}
    const lru = new Map();              // "key:index" -> {key, index, length}, oldest first
    let cachedBytes = 0;
    let backendChunkSize = 0;           // fixed per backend; known from the first read
    const stats = {reads: 0, hits: 0, misses: 0, waitMs: 0, maxWaitMs: 0, received: 0,
                   receivedBytes: 0, prefetched: 0, failures: 0};
    let reported = '';

    function touch(key, index, length) {
      const id = key + ':' + index;
      if (lru.has(id)) lru.delete(id); else cachedBytes += length;
      lru.set(id, {key, index, length});
      for (const [oldId, old] of lru) {
        if (cachedBytes <= CACHE_LIMIT) break;
        if (oldId === id) continue;
        lru.delete(oldId);
        cache.get(old.key)?.delete(old.index);
        cachedBytes -= old.length;
      }
    }

    function cached(key, index) {
      return cache.get(key)?.get(index);
    }

    function settle(key, index, chunk, failure) {
      const id = key + ':' + index;
      const pending = inflight.get(id);
      if (chunk) {
        let chunks = cache.get(key);
        if (!chunks) cache.set(key, chunks = new Map());
        if (!chunks.has(index)) {
          chunks.set(index, chunk);
          touch(key, index, chunk.byteLength);
        }
      }
      if (!pending) return;
      inflight.delete(id);
      clearTimeout(pending.timer);
      if (chunk) pending.resolve(); else pending.reject(failure);
    }

    channel.onmessage = ({data}) => {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'manifest' && typeof data.text === 'string' && !manifestBytes) {
        const parsed = new Map();
        for (const line of data.text.split('\n')) {
          const match = /^f (\d+) (.+)$/.exec(line);
          if (match) parsed.set('/game/' + match[2], Number(match[1]));
        }
        if (!(parsed.get('/game/DATA/sys/fst.bin') > 0)) return;
        manifestBytes = new TextEncoder().encode(data.text);
        for (const [key, size] of parsed) sizes.set(key, size);
        sizes.set('/game/manifest.txt', manifestBytes.byteLength);
        clearInterval(helloTimer);
        clearTimeout(giveUp);
        console.error('[web-disc] serving ' + parsed.size + ' files from the local disc image');
        resolveReady(true);
      } else if (data.type === 'chunk' && typeof data.path === 'string' && data.bytes instanceof ArrayBuffer) {
        const key = '/game/' + data.path;
        const size = sizes.get(key);
        if (size === undefined || !Number.isSafeInteger(data.index) || data.index < 0 ||
            data.chunkSize !== backendChunkSize ||
            data.bytes.byteLength !== Math.min(backendChunkSize, size - data.index * backendChunkSize)) return;
        stats.received++;
        stats.receivedBytes += data.bytes.byteLength;
        settle(key, data.index, new Uint8Array(data.bytes));
      } else if (data.type === 'chunk-error' && typeof data.path === 'string') {
        stats.failures++;
        settle('/game/' + data.path, data.index, null, new Error(String(data.message)));
      }
    };

    // Requests the chunks of [first, last] that are neither cached nor already requested at an
    // equal or more urgent priority, and returns a promise for all of them.
    function ensure(key, chunkSize, first, last, priority) {
      const waits = [];
      let runFirst = -1;
      const runs = [];
      for (let index = first; index <= last; index++) {
        const chunk = cached(key, index);
        if (chunk) {
          touch(key, index, chunk.byteLength);
          if (runFirst >= 0) { runs.push([runFirst, index - 1]); runFirst = -1; }
          continue;
        }
        const id = key + ':' + index;
        let pending = inflight.get(id);
        let request = false;
        if (!pending) {
          pending = {priority};
          pending.promise = new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
          pending.promise.catch(() => {}); // a prefetched chunk may have no reader
          pending.timer = setTimeout(() => settle(key, index, null, new Error('disc read timed out')), READ_TIMEOUT_MS);
          inflight.set(id, pending);
          request = true;
        } else if (priority < pending.priority) {
          pending.priority = priority;   // the worker raises the queued job
          request = true;
        }
        if (request && runFirst < 0) runFirst = index;
        if (!request && runFirst >= 0) { runs.push([runFirst, index - 1]); runFirst = -1; }
        waits.push(pending.promise);
      }
      if (runFirst >= 0) runs.push([runFirst, last]);
      for (const [from, to] of runs) {
        channel.postMessage({type: 'read', path: key.slice(6), chunkSize, first: from, last: to, priority});
      }
      return Promise.all(waits);
    }

    function lastChunk(size, chunkSize) {
      return Math.max(0, Math.ceil(size / chunkSize) - 1);
    }

    // Reads a file (or the part [start, end) of it) ahead of the game, unless it is cached.
    function warm(key, chunkSize, priority, start = 0, end = Infinity) {
      const size = key && sizes.get(key);
      if (!size || start >= size) return false;
      const first = Math.floor(start / chunkSize);
      const last = Math.min(lastChunk(size, chunkSize), Math.ceil(Math.min(end, size) / chunkSize) - 1);
      let missing = 0, requested = 0;
      for (let index = first; index <= last; index++) {
        if (cached(key, index)) continue;
        missing++;
        if (!inflight.has(key + ':' + index)) requested++;
      }
      if (!missing) return false;
      stats.prefetched += requested;
      ensure(key, chunkSize, first, last, priority).catch(() => { /* a demand read retries */ });
      return true;
    }

    // Parts of the disc the game reads in bursts of small reads, each of which would otherwise
    // wait for the disc: the sound archive's menu banks, the banks a race reads as it starts
    // (19-22, 25-27 and 45-78 MiB, found for mkw_fetchfs.js by logging Luigi Circuit Grand Prix
    // runs; which blocks varies with the characters, so the regions are read whole), and the shared
    // race archives. About 55 MiB, read in the background once the game starts reading.
    let startupWarmed = false;
    function warmStartup(chunkSize) {
      if (startupWarmed) return;
      startupWarmed = true;
      const MiB = 1024 * 1024;
      const soundArchive = lookup('/game/DATA/files/sound/revo_kart.brsar');
      warm(soundArchive, chunkSize, BACKGROUND, 0, 16 * MiB);
      for (const path of ['Race/Common.szs', 'Scene/UI/Race.szs']) warm(lookup('/game/DATA/files/' + path), chunkSize, BACKGROUND);
      for (const [from, to] of [[19, 22], [25, 27], [45, 78]]) warm(soundArchive, chunkSize, BACKGROUND, from * MiB, to * MiB);
    }

    function lookup(path) {
      if (!lowerKeys) {
        lowerKeys = new Map();
        for (const known of sizes.keys()) lowerKeys.set(known.toLowerCase(), known);
      }
      return lowerKeys.get(path.toLowerCase());
    }

    // web_race_warm.cpp posts the archives a race is about to read (one kart per player and the
    // chosen course). Only names that exist on the disc are read, whole, ahead of the game.
    let prefetchChannel = null;
    function listenForPrefetch(chunkSize) {
      if (prefetchChannel || typeof BroadcastChannel === 'undefined') return;
      prefetchChannel = new BroadcastChannel('mkw-prefetch');
      prefetchChannel.onmessage = ({data}) => {
        const paths = data && data.paths;
        if (!Array.isArray(paths)) return;
        let started = 0;
        for (const path of paths.slice(0, 96)) {
          if (typeof path !== 'string' || !/^DATA\/files\/Race\/(Kart|Course)\/[A-Za-z0-9_.-]+\.szs$/.test(path)) continue;
          if (warm(lookup('/game/' + path), chunkSize, URGENT)) started++;
        }
        console.error('[web-disc] race prefetch: ' + started + ' of ' + paths.length + ' race archives read ahead');
      };
    }

    // A race reads the course's final-lap music (the "_f" stream follows the "_n" one) and, in a
    // Grand Prix, the next course long after it starts. Both are known when the first file opens.
    const NEXT_COURSE = new Map();
    for (const cup of [
      ['beginner_course', 'farm_course', 'kinoko_course', 'factory_course'],
      ['castle_course', 'shopping_course', 'boardcross_course', 'truck_course'],
      ['senior_course', 'water_course', 'treehouse_course', 'volcano_course'],
      ['desert_course', 'ridgehighway_course', 'koopa_course', 'rainbow_course'],
      ['old_peach_gc', 'old_falls_ds', 'old_obake_sfc', 'old_mario_64'],
      ['old_sherbet_64', 'old_heyho_gba', 'old_town_ds', 'old_waluigi_gc'],
      ['old_desert_ds', 'old_koopa_gba', 'old_donkey_64', 'old_mario_gc'],
      ['old_mario_sfc', 'old_garden_ds', 'old_donkey_gc', 'old_koopa_64'],
    ]) {
      for (let i = 0; i + 1 < cup.length; i++) NEXT_COURSE.set(cup[i], cup[i + 1]);
    }
    const relatedDone = new Set();
    function warmRelated(key, chunkSize) {
      if (relatedDone.has(key)) return;
      relatedDone.add(key);
      const related = [];
      const music = /^(\/game\/DATA\/files\/sound\/strm\/.+)_n\.brstm$/i.exec(key);
      if (music) related.push(music[1] + '_f.brstm');
      const course = /^(\/game\/DATA\/files\/Race\/Course\/)([^/]+?)(?:_d)?\.szs$/.exec(key);
      if (course && NEXT_COURSE.has(course[2])) related.push(course[1] + NEXT_COURSE.get(course[2]) + '.szs');
      for (const path of related) {
        const target = lookup(path);
        if (warm(target, chunkSize, BACKGROUND)) console.error('[web-disc] reading ' + target + ' ahead (after ' + key + ')');
      }
    }

    // Archives are consumed whole right after their header is read and music streams are read
    // through to the end, so the rest of such a file is queued behind the chunks the game asked for.
    function readsWhole(key, size) {
      return (/\.szs$/i.test(key) && size <= 16 * 1024 * 1024) ||
             (/\.(rel|arc)$/i.test(key) && size <= 8 * 1024 * 1024) ||
             (/\.brstm$/i.test(key) && size <= 32 * 1024 * 1024);
    }

    function keyOf(file) {
      let key = fileKeys.get(file);
      if (!key) {
        // The fetch backend names files "<base URL>/<path>": "game//DATA/sys/fst.bin".
        key = ('/' + UTF8ToString(__wasmfs_fetch_get_file_url(file))).replace(/\/+/g, '/');
        fileKeys.set(file, key);
      }
      return key;
    }

    function report() {
      const line = 'reads=' + stats.reads + ' cached=' + stats.hits + ' (' +
        (stats.reads ? 100 * stats.hits / stats.reads : 0).toFixed(1) + '%) waited=' + stats.misses +
        ' wait avg=' + (stats.misses ? stats.waitMs / stats.misses : 0).toFixed(1) + 'ms max=' +
        stats.maxWaitMs.toFixed(1) + 'ms, received ' + stats.received + ' chunks (' +
        (stats.receivedBytes / 1048576).toFixed(1) + ' MiB), read ahead ' + stats.prefetched +
        ' chunks, cache ' + (cachedBytes / 1048576).toFixed(1) + ' MiB, failures=' + stats.failures;
      if (line !== reported) console.error('[web-disc] game reads: ' + line);
      reported = line;
    }
    setInterval(report, 10000);

    wasmFS$backends[backend] = {
      allocFile: async (file) => { fileKeys.delete(file); },
      freeFile: async (file) => { fileKeys.delete(file); },
      write: async (file, buffer, length, offset) => -{{{ cDefs.EROFS }}},
      read: async (file, buffer, length, offset) => {
        if (offset < 0 || length <= 0) return 0;
        if (!await ready) return -{{{ cDefs.EIO }}};
        const key = keyOf(file);
        const size = sizes.get(key);
        if (size === undefined) return -{{{ cDefs.ENOENT }}};
        length = Math.min(length, size - offset);
        if (length <= 0) return 0;
        if (key === '/game/manifest.txt') {
          HEAPU8.set(manifestBytes.subarray(offset, offset + length), buffer);
          return length;
        }
        const chunkSize = backendChunkSize = __wasmfs_fetch_get_chunk_size(file);
        listenForPrefetch(chunkSize);
        const first = Math.floor(offset / chunkSize);
        const last = Math.floor((offset + length - 1) / chunkSize);
        stats.reads++;
        try {
          let hit = true;
          for (let index = first; index <= last && hit; index++) hit = !!cached(key, index);
          const started = performance.now();
          // A chunk can only be evicted by a later arrival; read it again if that happened.
          for (let attempt = 0; ; attempt++) {
            const wait = ensure(key, chunkSize, first, last, DEMAND);
            if (readsWhole(key, size)) warm(key, chunkSize, URGENT);
            warmRelated(key, chunkSize);
            warmStartup(chunkSize);
            await wait;
            const chunks = [];
            for (let index = first; index <= last; index++) chunks.push(cached(key, index));
            if (chunks.every(Boolean)) {
              for (let index = first; index <= last; index++) {
                const chunkStart = index * chunkSize;
                const from = Math.max(chunkStart, offset);
                const to = Math.min(chunkStart + chunkSize, offset + length);
                HEAPU8.set(chunks[index - first].subarray(from - chunkStart, to - chunkStart),
                           buffer + (from - offset));
              }
              break;
            }
            if (attempt >= 3) throw new Error('disc cache thrashing');
          }
          if (hit) {
            stats.hits++;
          } else {
            const waited = performance.now() - started;
            stats.misses++;
            stats.waitMs += waited;
            stats.maxWaitMs = Math.max(stats.maxWaitMs, waited);
          }
          return length;
        } catch (failed) {
          stats.failures++;
          console.error('[web-disc] read failed: ' + key + ' at ' + offset + ': ' + (failed && failed.message || failed));
          return -{{{ cDefs.EIO }}};
        }
      },
      getSize: async (file) => {
        if (!await ready) return 0;
        return sizes.get(keyOf(file)) ?? 0;
      },
    };
  },
});
