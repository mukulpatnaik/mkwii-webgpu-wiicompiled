import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import vm from 'node:vm';

// The pure half of mkw_saves.js; the page half needs a document and is skipped without one.
const source = await readFile(new URL('../mkw_saves.js', import.meta.url), 'utf8');
const context = { TextEncoder, TextDecoder, DataView, Blob, Response, DecompressionStream, console };
vm.runInNewContext(source, context);
const lib = context.mkwSavesLib;
assert.ok(lib, 'mkw_saves.js must define mkwSavesLib');

// A synthetic save (no game data): the right size, magic, version, licence markers and checksum.
const SIZE = 0x2BC000, CRC_AT = 0x27FFC;
function makeSave({ licences = 1, fill = 0 } = {}) {
  const bytes = new Uint8Array(SIZE);
  bytes.set(new TextEncoder().encode('RKSD0006'));
  [0x8, 0x8CC8, 0x11988, 0x1A648].slice(0, licences)
    .forEach((offset) => bytes.set(new TextEncoder().encode('RKPD'), offset));
  for (let i = 0x100; i < 0x200; i++) bytes[i] = (i * 7 + fill) & 0xFF;
  bytes[SIZE - 1] = fill;   // ghost area: not covered by the checksum
  new DataView(bytes.buffer).setUint32(CRC_AT, lib.crc32(bytes, 0, CRC_AT));
  return bytes;
}
const config = new TextEncoder().encode('[video]\nwidescreen = true\n');
// Values cross the vm boundary: compare contents, not prototypes.
const same = (a, b) => assert.ok(a && b && a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0);
const rejects = async (promise, pattern) => {
  await assert.rejects(promise, (error) => { assert.match(error.message, pattern); return true; });
};

test('crc32 is the standard zlib CRC', () => {
  assert.equal(lib.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(lib.crc32(new Uint8Array(0)), 0);
});

test('validateSave accepts a well-formed save and counts licences', () => {
  assert.deepEqual({ ...lib.validateSave(makeSave({ licences: 2 })) }, { ok: true, licences: 2 });
  assert.equal(lib.validateSave(makeSave({ licences: 0 })).licences, 0);
});

test('validateSave rejects garbage with a reason', () => {
  const wrongMagic = makeSave();
  wrongMagic.set(new TextEncoder().encode('JUNK'));
  assert.match(lib.validateSave(wrongMagic).error, /not a Mario Kart Wii save/);
  assert.match(lib.validateSave(new Uint8Array(1000)).error, /not a Mario Kart Wii save/);
  assert.match(lib.validateSave(makeSave().subarray(0, SIZE - 1)).error, /2,867,200 bytes, this file is 2,867,199/);
  const version = makeSave();
  version.set(new TextEncoder().encode('0005'), 4);
  assert.match(lib.validateSave(version).error, /unknown version/);
  const damaged = makeSave();
  damaged[0x150] ^= 1;
  assert.match(lib.validateSave(damaged).error, /checksum/);
  const ghostChanged = makeSave();
  ghostChanged[0x28000] ^= 1;
  assert.equal(lib.validateSave(ghostChanged).ok, true, 'ghost data is not covered by the checksum');
  assert.equal(lib.validateSave('text').ok, false);
});

test('title directories follow the game code', () => {
  assert.equal(lib.titleDirForGame('RMCE01'), '524d4345');
  assert.equal(lib.titleDirForGame('RMCP'), '524d4350');
  assert.equal(lib.titleDirForGame('GALE01'), null);
  assert.equal(lib.titleDirForGame(undefined), null);
  assert.equal(lib.gameForTitleDir('524d4345'), 'RMCE');
  assert.equal(lib.gameForTitleDir('524d434a'), 'RMCJ');
  assert.equal(lib.gameForTitleDir('00000002'), null);
  assert.equal(lib.gameForTitleDir('../../x'), null);
});

test('a bundle round-trips save and settings', async () => {
  const save = makeSave({ licences: 3 });
  const zip = lib.encodeBundle({ save, config, game: 'RMCE', created: new Date('2026-10-03T12:34:56Z') });
  assert.equal(String.fromCharCode(...zip.subarray(0, 4)), 'PK\x03\x04');
  const back = await lib.decodeBundle(zip);
  same(back.save, save);
  same(back.config, config);
  assert.equal(back.game, 'RMCE');
  assert.equal(back.licences, 3);
  const names = (await lib.decodeZip(zip)).map((e) => e.name);
  assert.deepEqual([...names], ['manifest.json', 'rksys.dat', 'Config.toml']);
  const manifest = JSON.parse(new TextDecoder().decode((await lib.decodeZip(zip))[0].data));
  assert.equal(manifest.format, 'wiicompiled-saves');
  assert.equal(manifest.created, '2026-10-03T12:34:56.000Z');
});

test('a bundle without settings has no Config.toml', async () => {
  const back = await lib.decodeBundle(lib.encodeBundle({ save: makeSave(), game: 'RMCP' }));
  assert.equal(back.config, null);
  assert.equal(back.game, 'RMCP');
});

test('the .zip is readable by standard tools (stored entries, valid central directory)', async () => {
  // Node has no unzip; check the structure an unzip tool reads: EOCD -> central directory -> local headers.
  const zip = lib.encodeBundle({ save: makeSave(), config, game: 'RMCE' });
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 3);
  const cd = view.getUint32(end + 16, true);
  assert.equal(cd + view.getUint32(end + 12, true), end);
  assert.equal(view.getUint32(cd, true), 0x02014b50);
  assert.equal(view.getUint32(view.getUint32(cd + 42, true), true), 0x04034b50);
});

test('a hand-made .zip with a deflated rksys.dat in a folder is accepted', async () => {
  const save = makeSave({ fill: 9 });
  const deflated = new Uint8Array(deflateRawSync(save));
  // Build the archive by hand: one deflated entry "my save/rksys.dat".
  const name = new TextEncoder().encode('my save/rksys.dat');
  const crc = lib.crc32(save);
  const local = new Uint8Array(30 + name.length + deflated.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, 8, true);
  lv.setUint32(14, crc, true); lv.setUint32(18, deflated.length, true); lv.setUint32(22, save.length, true);
  lv.setUint16(26, name.length, true); local.set(name, 30); local.set(deflated, 30 + name.length);
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true); cv.setUint32(16, crc, true);
  cv.setUint32(20, deflated.length, true); cv.setUint32(24, save.length, true);
  cv.setUint16(28, name.length, true); cv.setUint32(42, 0, true); central.set(name, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true); ev.setUint32(16, local.length, true);
  const zip = new Uint8Array([...local, ...central, ...end]);
  const result = await lib.readImport(zip, 'mine.zip');
  assert.equal(result.kind, 'bundle');
  same(result.save, save);
  assert.equal(result.game, null);
});

test('readImport takes a bare rksys.dat', async () => {
  const save = makeSave({ licences: 4 });
  const result = await lib.readImport(save, 'rksys.dat');
  assert.equal(result.kind, 'save');
  assert.equal(result.licences, 4);
  same(result.save, save);
});

test('readImport rejects garbage, damaged and wrong archives with clear messages', async () => {
  await rejects(lib.readImport(new Uint8Array(0)), /empty/);
  await rejects(lib.readImport(new TextEncoder().encode('<html>hello</html>'), 'page.html'),
    /"page.html" is not a Mario Kart Wii save \(rksys.dat\) or a save backup/);
  await rejects(lib.readImport(makeSave().subarray(0, 4096)), /not a complete Mario Kart Wii save/);
  const damagedSave = makeSave();
  damagedSave[0x180] ^= 0xFF;
  await rejects(lib.readImport(damagedSave), /checksum/);

  const zip = lib.encodeBundle({ save: makeSave(), config, game: 'RMCE' });
  await rejects(lib.readImport(zip.subarray(0, zip.length - 30)), /damaged or incomplete/);
  const flipped = zip.slice();
  flipped[200] ^= 1;   // inside the stored manifest or save: the entry CRC no longer matches
  await rejects(lib.readImport(flipped), /damaged or incomplete/);

  const noSave = lib.encodeZip([{ name: 'notes.txt', data: new TextEncoder().encode('hi') }]);
  await rejects(lib.readImport(noSave), /holds no rksys.dat/);
  const twoSaves = lib.encodeZip([{ name: 'a/rksys.dat', data: makeSave() }, { name: 'b/rksys.dat', data: makeSave() }]);
  await rejects(lib.readImport(twoSaves), /more than one rksys.dat/);
  const badSaveInZip = lib.encodeZip([{ name: 'rksys.dat', data: new Uint8Array(SIZE) }]);
  await rejects(lib.readImport(badSaveInZip), /not a Mario Kart Wii save/);
  const binaryConfig = lib.encodeZip([{ name: 'rksys.dat', data: makeSave() }, { name: 'Config.toml', data: new Uint8Array([0xff, 0xfe, 0]) }]);
  await rejects(lib.readImport(binaryConfig), /settings file in the backup is not text/);
  const future = lib.encodeZip([
    { name: 'manifest.json', data: new TextEncoder().encode('{"format":"wiicompiled-saves","version":2}') },
    { name: 'rksys.dat', data: makeSave() }]);
  await rejects(lib.readImport(future), /newer version/);
});

test('validateConfig accepts text and refuses binary', () => {
  assert.equal(lib.validateConfig(config).ok, true);
  assert.equal(lib.validateConfig(new Uint8Array(0)).ok, false);
  assert.equal(lib.validateConfig(new Uint8Array([0x61, 0, 0x62])).ok, false);
  assert.equal(lib.validateConfig(new Uint8Array(300 * 1024).fill(0x61)).ok, false);
});
