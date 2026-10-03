// Saves panel (linked with --pre-js; the page part runs only on the browser's main thread).
//
// Export, import and automatic backup of the game save (rksys.dat) and settings (Config.toml)
// kept in this browser's storage, a Web Lock so only one tab of a browser runs the game (and so
// writes the save), and a request for persistent storage.
//
// The files live in the origin private file system (OPFS), whose root web_platform.cpp mounts at
// /persist (RuntimeConfigFile::ApplicationDataDirectory() is /persist/WiiCompiled):
//   WiiCompiled/Config.toml
//   WiiCompiled/NAND/title/00010004/<game code, hex>/data/rksys.dat   (524d4345 RMCE, 524d4350 RMCP)
//   WiiCompiled/SaveBackups/<time>.zip   the save and settings as they were before each import
//   WiiCompiled/PendingImport.zip         an import chosen while the game ran, applied on reload
//
// The page reads and writes these only while the game is not running in its tab. Once the game
// starts, its WASMFS OPFS backend (on its own worker) holds a sync access handle on every file it
// has open, and OPFS gives a file one such handle at a time: a write from the page would fail or
// race the game's own. So an import chosen while the game runs is staged as PendingImport.zip and
// the page reloads; the import is applied on load, before Start. Export while the game runs reads
// the file as the game last wrote it and says so if the browser refuses the read.
//
// The pure parts (save validation, the backup .zip format) are in mkwSavesLib and are tested
// with Node (tests/mkw_saves.test.mjs).

var mkwSavesLib = (() => {
  const SAVE_SIZE = 0x2BC000;
  const SAVE_CRC_OFFSET = 0x27FFC;
  const LICENCE_OFFSETS = [0x8, 0x8CC8, 0x11988, 0x1A648];
  const CONFIG_LIMIT = 256 * 1024;
  const BUNDLE_LIMIT = 16 * 1024 * 1024;
  const BUNDLE_FORMAT = 'wiicompiled-saves';
  const SAVE_NAME = 'rksys.dat', CONFIG_NAME = 'Config.toml', MANIFEST_NAME = 'manifest.json';

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  // Standard (zlib / zip) CRC-32 of bytes[start, end).
  const crc32 = (bytes, start = 0, end = bytes.length) => {
    let c = 0xFFFFFFFF;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };

  const ascii = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  const asBytes = (data) => data instanceof Uint8Array ? data
    : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : data instanceof ArrayBuffer ? new Uint8Array(data) : null;

  // A Mario Kart Wii save (any region): 0x2BC000 bytes, "RKSD" + version "0006", and a big-endian
  // CRC-32 of the first 0x27FFC bytes stored right after them (mkwiiki.org/wiki/Rksys.dat).
  // Returns {ok: true, licences} or {ok: false, error} with a message for the player.
  const validateSave = (data) => {
    const bytes = asBytes(data);
    if (!bytes) return { ok: false, error: 'The file could not be read.' };
    if (bytes.length >= 4 && ascii(bytes, 0, 4) !== 'RKSD') {
      return { ok: false, error: 'This is not a Mario Kart Wii save: rksys.dat starts with "RKSD".' };
    }
    if (bytes.length !== SAVE_SIZE) {
      return { ok: false, error: `This is not a complete Mario Kart Wii save: rksys.dat is ${SAVE_SIZE.toLocaleString('en')} bytes, `
        + `this file is ${bytes.length.toLocaleString('en')}.` };
    }
    if (ascii(bytes, 4, 4) !== '0006') {
      return { ok: false, error: `This save has an unknown version ("${ascii(bytes, 4, 4).replace(/[^\x20-\x7e]/g, '?')}"; expected "0006").` };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(SAVE_CRC_OFFSET) !== crc32(bytes, 0, SAVE_CRC_OFFSET)) {
      return { ok: false, error: 'This save is damaged: its checksum does not match its contents.' };
    }
    const licences = LICENCE_OFFSETS.filter((offset) => ascii(bytes, offset, 4) === 'RKPD').length;
    return { ok: true, licences };
  };

  // "RMCE" / "RMCE01" <-> the NAND title directory "524d4345".
  const titleDirForGame = (gameId) => {
    const code = String(gameId || '').slice(0, 4);
    if (!/^RMC[A-Z]$/.test(code)) return null;
    return [...code].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  };
  const gameForTitleDir = (dir) => {
    if (!/^524d43[0-9a-f]{2}$/.test(dir)) return null;
    const code = String.fromCharCode(...dir.match(/../g).map((hex) => parseInt(hex, 16)));
    return /^RMC[A-Z]$/.test(code) ? code : null;
  };

  // Settings are text; refuse anything that is not plausibly a Config.toml.
  const validateConfig = (data) => {
    const bytes = asBytes(data);
    if (!bytes || bytes.length === 0) return { ok: false, error: 'The settings file in the backup is empty.' };
    if (bytes.length > CONFIG_LIMIT) return { ok: false, error: 'The settings file in the backup is too large.' };
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
      return { ok: false, error: 'The settings file in the backup is not text.' };
    }
    if (text.includes('\0')) return { ok: false, error: 'The settings file in the backup is not text.' };
    return { ok: true, text };
  };

  // --- A minimal .zip (stored entries; deflated ones are read through DecompressionStream) ---
  const dosDateTime = (date) => {
    const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  };
  const encodeZip = (entries, when = new Date()) => {
    const encoder = new TextEncoder();
    const { time, date } = dosDateTime(when);
    const prepared = entries.map(({ name, data }) => {
      const bytes = asBytes(data);
      return { name: encoder.encode(name), bytes, crc: crc32(bytes) };
    });
    const localSize = prepared.reduce((sum, e) => sum + 30 + e.name.length + e.bytes.length, 0);
    const centralSize = prepared.reduce((sum, e) => sum + 46 + e.name.length, 0);
    const out = new Uint8Array(localSize + centralSize + 22);
    const view = new DataView(out.buffer);
    let at = 0;
    const offsets = [];
    for (const e of prepared) {
      offsets.push(at);
      view.setUint32(at, 0x04034b50, true);
      view.setUint16(at + 4, 10, true);          // version needed: stored
      view.setUint16(at + 6, 0x0800, true);      // UTF-8 names
      view.setUint16(at + 8, 0, true);           // stored
      view.setUint16(at + 10, time, true);
      view.setUint16(at + 12, date, true);
      view.setUint32(at + 14, e.crc, true);
      view.setUint32(at + 18, e.bytes.length, true);
      view.setUint32(at + 22, e.bytes.length, true);
      view.setUint16(at + 26, e.name.length, true);
      view.setUint16(at + 28, 0, true);
      out.set(e.name, at + 30);
      out.set(e.bytes, at + 30 + e.name.length);
      at += 30 + e.name.length + e.bytes.length;
    }
    const centralStart = at;
    prepared.forEach((e, i) => {
      view.setUint32(at, 0x02014b50, true);
      view.setUint16(at + 4, 20, true);
      view.setUint16(at + 6, 10, true);
      view.setUint16(at + 8, 0x0800, true);
      view.setUint16(at + 10, 0, true);
      view.setUint16(at + 12, time, true);
      view.setUint16(at + 14, date, true);
      view.setUint32(at + 16, e.crc, true);
      view.setUint32(at + 20, e.bytes.length, true);
      view.setUint32(at + 24, e.bytes.length, true);
      view.setUint16(at + 28, e.name.length, true);
      // extra, comment, disk, internal and external attributes: 0
      view.setUint32(at + 42, offsets[i], true);
      out.set(e.name, at + 46);
      at += 46 + e.name.length;
    });
    view.setUint32(at, 0x06054b50, true);
    view.setUint16(at + 8, prepared.length, true);
    view.setUint16(at + 10, prepared.length, true);
    view.setUint32(at + 12, at - centralStart, true);
    view.setUint32(at + 16, centralStart, true);
    return out;
  };

  const inflateRaw = async (bytes) => {
    if (typeof DecompressionStream !== 'function') throw new Error('compressed');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  // Returns [{name, data}]; throws an Error with a message for the player.
  const decodeZip = async (data) => {
    const bytes = asBytes(data);
    const damaged = () => new Error('This .zip file is damaged or incomplete.');
    if (!bytes || bytes.length < 22) throw damaged();
    if (bytes.length > BUNDLE_LIMIT) throw new Error('This file is too large to be a save backup.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xFFFF); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw damaged();
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const decoder = new TextDecoder();
    const entries = [];
    for (let n = 0; n < count; n++) {
      if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw damaged();
      const method = view.getUint16(at + 10, true);
      const crc = view.getUint32(at + 16, true);
      const packed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
      const nameLength = view.getUint16(at + 28, true);
      const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
      const local = view.getUint32(at + 42, true);
      const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
      at += 46 + skip;
      if (name.endsWith('/')) continue;
      if (size > BUNDLE_LIMIT || local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw damaged();
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      if (start + packed > bytes.length) throw damaged();
      const raw = bytes.subarray(start, start + packed);
      let content;
      if (method === 0) content = raw.slice();
      else if (method === 8) {
        try { content = await inflateRaw(raw); } catch {
          throw new Error('This .zip file uses compression this browser cannot read. Use the backup exported by this page.');
        }
      } else throw new Error('This .zip file uses an unsupported compression method.');
      if (content.length !== size || crc32(content) !== crc) throw damaged();
      entries.push({ name, data: content });
    }
    return entries;
  };

  // The backup bundle: rksys.dat, Config.toml when there is one, and manifest.json saying what it is.
  const encodeBundle = ({ save, config, game, created = new Date() }) => {
    const files = [SAVE_NAME];
    if (config) files.push(CONFIG_NAME);
    const manifest = { format: BUNDLE_FORMAT, version: 1, game: game || null, created: created.toISOString(), files };
    const entries = [{ name: MANIFEST_NAME, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n') },
                     { name: SAVE_NAME, data: save }];
    if (config) entries.push({ name: CONFIG_NAME, data: config });
    return encodeZip(entries, created);
  };

  // Accepts a bundle from encodeBundle, or any .zip holding an rksys.dat (and optionally a
  // Config.toml) in any folder. Returns {save, config, game, licences}; throws on anything else.
  const decodeBundle = async (data) => {
    const entries = await decodeZip(data);
    const base = (name) => name.split('/').pop();
    const find = (wanted) => {
      const found = entries.filter((e) => base(e.name) === wanted && !e.name.startsWith('__MACOSX/'));
      if (found.length > 1) throw new Error(`This .zip file holds more than one ${wanted}; it must hold exactly one.`);
      return found[0];
    };
    let manifest = null;
    const manifestEntry = find(MANIFEST_NAME);
    if (manifestEntry) {
      try { manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data)); } catch { manifest = null; }
      if (manifest?.format !== BUNDLE_FORMAT) manifest = null;
      else if (manifest.version !== 1) throw new Error('This backup was made by a newer version of the page.');
    }
    const saveEntry = find(SAVE_NAME);
    if (!saveEntry) throw new Error('This .zip file holds no rksys.dat save.');
    const check = validateSave(saveEntry.data);
    if (!check.ok) throw new Error(check.error);
    const configEntry = find(CONFIG_NAME);
    if (configEntry) {
      const configCheck = validateConfig(configEntry.data);
      if (!configCheck.ok) throw new Error(configCheck.error);
    }
    const game = typeof manifest?.game === 'string' && /^RMC[A-Z]/.test(manifest.game) ? manifest.game.slice(0, 4) : null;
    return { save: saveEntry.data, config: configEntry?.data || null, game, licences: check.licences };
  };

  // What a picked file is: a bare rksys.dat or a backup .zip. Throws an Error whose message says
  // why the file cannot be imported.
  const readImport = async (data, fileName = '') => {
    const bytes = asBytes(data);
    if (!bytes || bytes.length === 0) throw new Error('The chosen file is empty.');
    const magic = bytes.length >= 4 ? ascii(bytes, 0, 4) : '';
    if (magic === 'PK\x03\x04' || magic === 'PK\x05\x06') {
      return { kind: 'bundle', ...await decodeBundle(bytes) };
    }
    if (magic === 'RKSD') {
      const check = validateSave(bytes);
      if (!check.ok) throw new Error(check.error);
      return { kind: 'save', save: bytes, config: null, game: null, licences: check.licences };
    }
    throw new Error(`${fileName ? '"' + fileName + '"' : 'This file'} is not a Mario Kart Wii save (rksys.dat) `
      + 'or a save backup (.zip) exported by this page.');
  };

  return { SAVE_SIZE, crc32, validateSave, validateConfig, titleDirForGame, gameForTitleDir,
           encodeZip, decodeZip, encodeBundle, decodeBundle, readImport };
})();

if (typeof document !== 'undefined') {
  (() => {
    const lib = mkwSavesLib;
    const LOCK_NAME = 'wiicompiled-game';
    const APP = 'WiiCompiled';
    const NAND_TITLES = [APP, 'NAND', 'title', '00010004'];
    const BACKUPS = [APP, 'SaveBackups'];
    const PENDING = [APP, 'PendingImport.zip'];
    const CONFIG = [APP, 'Config.toml'];
    const KEEP_BACKUPS = 5;

    const $ = (id) => document.getElementById(id);
    const panel = $('saves-panel');
    const storageLine = $('saves-storage');
    const messageLine = $('saves-message');
    const buttons = ['saves-export', 'saves-backup', 'saves-import', 'saves-restore'].map($).filter(Boolean);
    const fileInput = $('saves-file');
    const say = (text) => {
      if (messageLine) messageLine.textContent = text;
      console.log('[web-saves] ' + text);
    };

    let running = false;    // the game was started in this tab
    let busy = false;
    let lockHeld = false, lockSettled = false, lockBlocked = false;
    let resolveLockSettled;
    const lockSettledPromise = new Promise((resolve) => { resolveLockSettled = resolve; });
    let pendingApplied = Promise.resolve();

    // --- OPFS ---
    const opfsAvailable = typeof navigator.storage?.getDirectory === 'function';
    const directory = async (parts, create = false) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
      return dir;
    };
    const notFound = (error) => error?.name === 'NotFoundError' || error?.name === 'TypeMismatchError';
    const readFile = async (parts) => {
      try {
        const dir = await directory(parts.slice(0, -1));
        const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    };
    const writeFile = async (parts, bytes) => {
      const dir = await directory(parts.slice(0, -1), true);
      const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      if (typeof handle.createWritable !== 'function') {
        throw new Error('This browser cannot write files from the page (no createWritable).');
      }
      // The new contents replace the file only when close() succeeds.
      const writable = await handle.createWritable();
      try {
        await writable.write(bytes);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
      }
    };
    const removeFile = async (parts) => {
      try { await (await directory(parts.slice(0, -1))).removeEntry(parts[parts.length - 1]); } catch (error) {
        if (!notFound(error)) throw error;
      }
    };
    const listNames = async (parts, kind) => {
      try {
        const names = [];
        for await (const [name, handle] of (await directory(parts)).entries()) {
          if (handle.kind === kind) names.push(name);
        }
        return names.sort();
      } catch (error) {
        if (notFound(error)) return [];
        throw error;
      }
    };
    const sha256 = async (bytes) => bytes && [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');

    // --- Which release this is: the NAND folder of its save depends on it ---
    // In order: a page that knows (window.mkwGameId, e.g. from a picked disc image), the build
    // itself (mkw_web_build_game_id, once the runtime has loaded), the staged disc's header, and
    // last the one release that already has a save folder in this browser.
    let gameIdPromise = null;
    const buildGameId = () => {
      try {
        if (typeof _mkw_web_build_game_id === 'function' && typeof UTF8ToString === 'function') {
          return UTF8ToString(_mkw_web_build_game_id());
        }
      } catch {}
      return null;
    };
    const detectGameId = async () => {
      const known = window.mkwGameId || buildGameId();
      if (lib.titleDirForGame(known)) return known.slice(0, 4);
      try {
        const response = await fetch('game/DATA/sys/boot.bin', { headers: { Range: 'bytes=0-3' } });
        if (response.ok) {
          const code = String.fromCharCode(...new Uint8Array(await response.arrayBuffer()).subarray(0, 4));
          if (lib.titleDirForGame(code)) return code;
        }
      } catch {}
      const titles = (await listNames(NAND_TITLES, 'directory').catch(() => []))
        .map(lib.gameForTitleDir).filter(Boolean);
      return titles.length === 1 ? titles[0] : null;
    };
    const gameId = async () => {
      const id = await (gameIdPromise ||= detectGameId());
      if (!id) gameIdPromise = null;   // try again next time (the runtime may have loaded since)
      return id;
    };
    const savePath = (id) => [...NAND_TITLES, lib.titleDirForGame(id), 'data', 'rksys.dat'];

    const stamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const download = (bytes, name, type) => {
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    };

    // --- Persistent storage ---
    // Without it the browser may clear the save when the disk runs low. Chrome decides silently
    // (bookmarked or often-used sites); Firefox asks, so ask from a click (Start, Import, Export).
    let persisted = null, persistAsked = false;
    const showStorage = () => {
      if (!storageLine) return;
      const parts = [];
      if (!opfsAvailable) parts.push('This browser has no storage for saves: progress is lost when the page closes.');
      else if (persisted === true) parts.push('Saves are kept in this browser (persistent storage granted).');
      else if (persisted === false) {
        parts.push('Saves are kept in this browser, but it may clear them if the disk runs low (persistent storage '
          + 'not granted). Export a backup now and then.');
      } else parts.push('Checking browser storage…');
      if (lockBlocked) parts.push('The game is open in another tab: saves are read-only here.');
      storageLine.textContent = parts.join(' ');
    };
    const checkPersisted = async () => {
      try { persisted = await navigator.storage.persisted(); } catch { persisted = false; }
      showStorage();
    };
    const requestPersist = async () => {
      if (persisted || persistAsked || typeof navigator.storage?.persist !== 'function') return;
      persistAsked = true;
      try { persisted = await navigator.storage.persist(); } catch { persisted = false; }
      console.log('[web-saves] navigator.storage.persist() -> ' + persisted);
      showStorage();
    };

    // --- One game per browser: a Web Lock held for the life of the page ---
    const startButton = $('start');
    const statusEl = $('status');
    const blockedText = 'The game is already open in another tab or window of this browser. Close it there '
      + '(or keep playing there), then reload this page. Two copies would overwrite each other\'s save.';
    const showBlocked = () => {
      if (statusEl) statusEl.textContent = blockedText;
      if (startButton) {
        startButton.disabled = true;
        startButton.textContent = 'Already open in another tab';
      }
    };
    const updateButtons = () => {
      for (const button of buttons) {
        const writes = button.id === 'saves-import' || button.id === 'saves-restore';
        button.disabled = busy || !opfsAvailable || (writes && !lockHeld);
        button.style.opacity = button.disabled ? '0.5' : '';
      }
    };
    // "Restore previous save" only while there is a backup to restore.
    const refreshRestore = async () => {
      const restore = $('saves-restore');
      if (!restore || !opfsAvailable) return;
      restore.hidden = !(await listNames(BACKUPS, 'file').catch(() => [])).some((n) => n.endsWith('.zip'));
    };
    const settleLock = (held) => {
      lockHeld = held;
      lockBlocked = !held;
      lockSettled = true;
      resolveLockSettled();
      showStorage();
      updateButtons();
    };
    const holdUntilUnload = () => new Promise(() => {});
    if (!navigator.locks?.request) {
      // No Web Locks (an old browser): nothing to coordinate with, so behave as the only tab.
      settleLock(true);
    } else {
      navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (lock) {
          console.log('[web-saves] game lock acquired');
          settleLock(true);
          return holdUntilUnload();
        }
        console.warn('[web-saves] game lock held by another tab: ' + blockedText);
        settleLock(false);
        showBlocked();
        say(blockedText);
        // Take over once the other tab closes.
        navigator.locks.request(LOCK_NAME, () => {
          console.log('[web-saves] game lock acquired after the other tab closed');
          lockHeld = true;
          lockBlocked = false;
          showStorage();
          updateButtons();
          say('The other tab closed. Reload this page to play here.');
          if (statusEl?.textContent === blockedText) statusEl.textContent = 'The other tab closed. Reload this page to play here.';
          return holdUntilUnload();
        });
        return undefined;
      }).catch((error) => {
        console.warn('[web-saves] Web Lock unavailable: ' + error);
        settleLock(true);
      });
    }
    // The page enables Start and rewrites the status line as the runtime loads (shell.html); keep
    // both on the message in a blocked tab.
    if (typeof Module !== 'undefined') {
      const ready = Module.onRuntimeInitialized;
      Module.onRuntimeInitialized = (...args) => {
        const result = ready?.(...args);
        if (lockBlocked) showBlocked();
        return result;
      };
      const setStatus = Module.setStatus;
      Module.setStatus = (...args) => lockBlocked ? showBlocked() : setStatus?.(...args);
    }
    // Runs before the page's own Start handler (capture on the document): hold a click until the
    // lock and any pending import are settled, and refuse it in a blocked tab.
    let releasingClick = false;
    document.addEventListener('click', (event) => {
      if (!startButton || event.target !== startButton || releasingClick) {
        if (event.target === startButton && !startButton.disabled) running = true;
        return;
      }
      if (startButton.disabled) return;
      if (lockSettled && !lockBlocked && !busy) {
        running = true;
        updateButtons();
        requestPersist();
        return;
      }
      event.stopImmediatePropagation();
      event.preventDefault();
      if (lockBlocked) {
        showBlocked();
        return;
      }
      requestPersist();
      (async () => {
        await lockSettledPromise;
        await pendingApplied;
        while (busy) await new Promise((resolve) => setTimeout(resolve, 50));
        if (lockBlocked) { showBlocked(); return; }
        releasingClick = true;
        try { startButton.click(); } finally { releasingClick = false; }
      })();
    }, true);

    // --- Import ---
    const readCurrent = async (id) => ({
      save: id ? await readFile(savePath(id)) : null,
      config: await readFile(CONFIG),
    });
    const backupCurrent = async (id) => {
      const current = await readCurrent(id);
      if (!current.save && !current.config) return null;
      // A save the game itself damaged is still worth keeping; store it whatever it holds.
      const bundle = current.save
        ? lib.encodeBundle({ save: current.save, config: current.config, game: id })
        : lib.encodeZip([{ name: 'Config.toml', data: current.config }]);
      const now = new Date();
      const name = `${stamp(now)}-${String(now.getUTCMilliseconds()).padStart(3, '0')}.zip`;
      await writeFile([...BACKUPS, name], bundle);
      const names = (await listNames(BACKUPS, 'file')).filter((n) => n.endsWith('.zip'));
      for (const old of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) await removeFile([...BACKUPS, old]);
      return name;
    };
    // Writes an already validated import into the NAND (the game must not be running here).
    const applyImport = async (data, id) => {
      const backup = await backupCurrent(id);
      await writeFile(savePath(id), data.save);
      if (data.config) await writeFile(CONFIG, data.config);
      const written = await readFile(savePath(id));
      const [want, got] = await Promise.all([sha256(data.save), sha256(written)]);
      if (want !== got) throw new Error('The save was not written correctly (it reads back differently).');
      console.log(`[web-saves] imported rksys.dat sha256=${got} into ${savePath(id).join('/')}`
        + (data.config ? ' with Config.toml' : '') + (backup ? `; previous save backed up as ${BACKUPS.join('/')}/${backup}` : ''));
      return { backup, sha256: got };
    };
    const licencesText = (n) => n === 1 ? '1 licence' : n + ' licences';
    // "?resetsave" would copy the staged save over the import when the game starts.
    const reloadWithoutReset = () => {
      const next = new URL(location.href);
      next.searchParams.delete('resetsave');
      location.replace(next.href);
    };
    const importFile = async (file) => {
      let data;
      try {
        if (file.size > 16 * 1024 * 1024) throw new Error('This file is too large to be a save or a save backup.');
        data = await lib.readImport(new Uint8Array(await file.arrayBuffer()), file.name);
      } catch (error) {
        say('Not imported: ' + error.message);
        return;
      }
      const id = await gameId();
      if (!id) {
        say('Not imported: the page could not tell which release of the game this is. Start the game once, reload, then import.');
        return;
      }
      const what = `${file.name} (${licencesText(data.licences)}${data.config ? ', with settings' : ''})`;
      const otherRegion = data.game && data.game !== id ? ` It was exported from ${data.game}; this game is ${id}.` : '';
      if (running) {
        if (!confirm(`Import ${what}? The game is running, so the page reloads to import it, and anything not yet `
            + `saved in the game is lost. The current save is backed up in this browser first.${otherRegion}`)) return;
        await writeFile(PENDING, lib.encodeBundle({ save: data.save, config: data.config, game: data.game || id }));
        console.log('[web-saves] import staged for after the reload');
        reloadWithoutReset();
        return;
      }
      if (!confirm(`Replace the save in this browser with ${what}? The current save is backed up in this browser first.`
          + otherRegion)) return;
      const result = await applyImport(data, id);
      say(`Imported ${what}.` + (result.backup ? ' The previous save was backed up (Restore previous save undoes this).' : '')
        + ' Press Start to play.' + otherRegion);
      if (new URLSearchParams(location.search).has('resetsave')) reloadWithoutReset();
    };
    const applyPending = async () => {
      const staged = await readFile(PENDING);
      if (!staged) return;
      try {
        const data = await lib.decodeBundle(staged);
        const id = await gameId();
        if (!id) throw new Error('the page could not tell which release of the game this is');
        await applyImport(data, id);
        say(`Imported the save chosen before the reload (${licencesText(data.licences)}). Press Start to play.`);
      } catch (error) {
        say('The save chosen before the reload was not imported: ' + error.message);
      }
      await removeFile(PENDING);
    };
    const restorePrevious = async () => {
      const names = (await listNames(BACKUPS, 'file')).filter((n) => n.endsWith('.zip'));
      const newest = names[names.length - 1];
      if (!newest) { say('There is no backup to restore.'); return; }
      let data;
      try { data = await lib.decodeBundle(await readFile([...BACKUPS, newest])); } catch (error) {
        say('The backup ' + newest + ' could not be restored: ' + error.message);
        return;
      }
      if (running) {
        if (!confirm('Restore the save from before the last import? The page reloads, and anything not yet saved in '
            + 'the game is lost.')) return;
        await writeFile(PENDING, lib.encodeBundle({ save: data.save, config: data.config, game: data.game }));
        await removeFile([...BACKUPS, newest]);
        reloadWithoutReset();
        return;
      }
      if (!confirm('Restore the save from before the last import? The current save is backed up first.')) return;
      const id = await gameId();
      if (!id) { say('Not restored: the page could not tell which release of the game this is.'); return; }
      await removeFile([...BACKUPS, newest]);
      await applyImport(data, id);
      say(`Restored the save from ${newest.replace('.zip', '')} (${licencesText(data.licences)}).`);
    };

    // --- Export ---
    const exportFiles = async (bundle) => {
      const id = await gameId();
      let current;
      try { current = await readCurrent(id); } catch (error) {
        say((running ? 'The game is using its save, so the browser refused to read it. Reload the page and export '
          + 'before pressing Start.' : 'Could not read the save.') + ' (' + error.name + ')');
        return;
      }
      if (!current.save) {
        say(id ? 'There is no save yet: start the game and create a licence first.'
          : 'There is no save yet (or the page could not tell which release of the game this is).');
        return;
      }
      const check = lib.validateSave(current.save);
      const name = bundle ? `wiicompiled-save-${id}-${stamp()}.zip` : 'rksys.dat';
      download(bundle ? lib.encodeBundle({ save: current.save, config: current.config, game: id }) : current.save,
               name, bundle ? 'application/zip' : 'application/octet-stream');
      console.log(`[web-saves] exported ${name} rksys.dat sha256=${await sha256(current.save)}`);
      say(`Exported ${name}` + (check.ok ? ` (${licencesText(check.licences)}).` : ` — note: ${check.error}`)
        + (running ? ' This is the save as the game last wrote it.' : ''));
    };

    const guard = (work) => async (...args) => {
      if (busy) return;
      busy = true;
      updateButtons();
      requestPersist();
      try { await work(...args); } catch (error) {
        say('Something went wrong: ' + (error?.message || error));
        console.error('[web-saves]', error);
      } finally {
        busy = false;
        updateButtons();
        refreshRestore();
      }
    };
    $('saves-export')?.addEventListener('click', guard(() => exportFiles(false)));
    $('saves-backup')?.addEventListener('click', guard(() => exportFiles(true)));
    $('saves-restore')?.addEventListener('click', guard(restorePrevious));
    $('saves-import')?.addEventListener('click', () => { if (!busy) fileInput?.click(); });
    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) guard(importFile)(file);
    });

    // Debugging and tests: the save as stored now.
    window.mkwSaves = {
      info: async () => {
        const id = await gameId();
        const save = id ? await readFile(savePath(id)) : null;
        return { game: id, path: id ? savePath(id).join('/') : null, size: save?.length ?? null,
                 sha256: await sha256(save), valid: save ? lib.validateSave(save) : null,
                 lockHeld, lockBlocked, running, persisted,
                 backups: await listNames(BACKUPS, 'file') };
      },
      lib,
    };

    if (panel) panel.hidden = false;
    updateButtons();
    showStorage();
    if (opfsAvailable) {
      checkPersisted();
      pendingApplied = (async () => {
        await lockSettledPromise;
        if (!lockHeld) return;
        busy = true;
        updateButtons();
        try { await applyPending(); } catch (error) { console.error('[web-saves]', error); }
        busy = false;
        updateButtons();
        refreshRestore();
      })();
    }
  })();
}
