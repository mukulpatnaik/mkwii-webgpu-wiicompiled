# Web build: regions

The browser build's guest hooks use the same region mechanism as the rest of the runtime (see
`tools/region/README.md`): every guest address is written as its PAL (RMCP01) address used as an
identity, `MKW_GADDR(...)`, and resolved per region by the generated `runtime/include/region/*.h`.
Nothing in `runtime/src/platform/web` is compiled per region, so every web feature below works on
whichever executable `generated/` was translated from.

## Features and the identities they use

| Feature | Source | Code identities | Data identities |
|---|---|---|---|
| Real-time catch-up (skip a late race frame's draw) | `web_guest_hooks.cpp`, `abi_bridge.h` | `80554E6C` RaceScene::OnCalc, `80009988` RKSceneManager::draw, `8023AEAC` EGG::SceneManager::draw | - |
| Lag-wait removal online | `web_guest_hooks.cpp`, `abi_bridge.h` | `80654B00` RKNet::PacketMgr::ProcessLagFrames | - |
| Race-asset prefetch | `web_race_warm.cpp` | - | `809BD728` Racedata, `808B3A90` / `808B3B50` / `808B3BE0` / `808B3BEC` kart-name tables |
| Benchmark step report | `web_performance.cpp` | - | `809BD730` Raceinfo, `809BD728` Racedata |
| Invite-room launcher | `web_room_launch.cpp`, `abi_bridge.h` | `80634E44` SectionMgr::Init, `80634FBC` SectionMgr::LoadSection, `806224F8` Section::Update, `80622DA0` Section::AddPageLayer, plus 19 engine calls (license, Mii, section, pad and RKNet::Controller services) | `809C1E38` SectionMgr, `809BD748` RKSYS::Mgr, `809BD728` Racedata, `809BD70C` Input::Manager, `809C20D8` RKNet::Controller, `80386298` RFL manager, `8024C4D0` RFL default Miis |

`web_platform.cpp` also reads `0x800000E4`, which is low-memory OS state at the same address in
every region, so it stays a plain constant.

Code identities need no table row: each is a function entry ported through the chunk table and
validated against the region's `MAP.txt` (all 27 are validated entries in NTSC-U, NTSC-J and
NTSC-K). Data identities need a row in each region's `data_addresses.txt`.

## Evidence for the data rows

| PAL | NTSC-U | NTSC-J | NTSC-K | Object |
|---|---|---|---|---|
| 809BD70C | 809B8F4C | 809BC76C | 809ABD4C | Input::Manager instance |
| 809BD728 | 809B8F68 | 809BC788 | 809ABD68 | Racedata (RaceConfig) instance |
| 809BD730 | 809B8F70 | 809BC790 | 809ABD70 | Raceinfo instance |
| 809BD748 | 809B8F88 | 809BC7A8 | 809ABD88 | RKSYS::Mgr (save manager) instance |
| 809C1E38 | 809BD508 | 809C0E98 | 809B0478 | SectionMgr instance |
| 809C20D8 | 809BD918 | 809C1138 | 809B0718 | RKNet::Controller instance |
| 808B3A90 | 808AF240 | 808B2BF0 | 808A1F08 | driver names (48 pointers) |
| 808B3B50 | 808AF300 | 808B2CB0 | 808A1FC8 | vehicle names (36 pointers) |
| 808B3BE0 | 808AF390 | 808B2D40 | 808A2058 | kind suffixes (`_red`, `_blue`, ``) |
| 808B3BEC | 808AF39C | 808B2D4C | 808A2064 | screen suffixes (``, `_2`, `_4`) |
| 8024C4D0 | 8024C1B8 | 8024BE80 | 8024C2A8 | RFL default Mii records |

**NTSC-U** rows are proven from the RMCE01 binaries; each row in
`projects/mkwii-ntsc-u/data_addresses.txt` cites the instructions. The StaticR.rel globals were
resolved through the REL relocation table, because REL code holds zero immediates until it is
relocated. The singleton slots come from each class's `CreateInstance`, which null-checks and
stores the slot. The allocation size in each `CreateInstance` also matches the size check the
web code makes (0x73F0, 0x25008, 0x9C, 0x415C, 0x29C8). The four name tables are fixed offsets
from one base that `ArchiveMgr::LoadKartArchive(playerId)` loads. Their relocated contents are
the expected strings (`mr`, `sdf_kart`, `_red`/`_blue`/``, ``/`_2`/`_4`). The default Mii table
is the `lis`/`addi` pair in `RFL::SearchDefaultData`, which walks 6 records of 74 bytes with the
create ID at +0x18. None of these is a fixed delta from PAL: SectionMgr is .bss+0x45E8 in RMCE01
but +0x4758 in PAL, the name tables are PAL-0x4850, and the Mii table is 0x298 below its
section-relative position.

Every NTSC-U value also matches two independent community tables:

* Wiimm's four-region address port database (`wiimms-szs-tools`, `project/src/addr_port.inc` at
  commit `246fdb3`). The only row it does not cover is `809BD70C`.
* For `809BD728`, `809BD748` and `809C1E38`, mkw-tournament-museum's `src/symbols.tsv` (commit
  `bb9cd37`).

Where the mkw-sp chunk table maps a word, it agrees as well.

**NTSC-J and NTSC-K** rows were added by hand in a marked block at the end of their tables,
because no RMCJ01/RMCK01 disc was available to rerun `port_data_addresses.py`:

* The REL rows are what the porter's binary-independent steps produce. REL reference sites never
  decode before relocation, so a real run reaches the same verdicts: `CHUNK-ONLY` for the
  singleton slots, `SECTION-RELATIVE` for RKNet::Controller, and `ANCHORED` for the name tables.
  Each matches Wiimm's database.
* The name tables use the porter's new chunk-anchored step. RMCK01's REL .data sits 0x18 further
  into the section than PAL from PAL 0x808B3984 on, so the old same-offset-in-section fallback
  would have put them 0x18 short in NTSC-K. The chunk-mapped words 0x808B3984 and 0x808B5B1C
  bracket the tables with the same delta, and Wiimm agrees.
* `8024C4D0` is a DOL global the porter proves from its reference site once it has the binary.
  For now its only source is Wiimm's database (the same record reproduces the proven NTSC-U
  address), and it is labelled `COMMUNITY`.

Rerunning the porter with the J/K discs regenerates all of these rows with real verdicts.

## Verified on RMCE01

Built with `emcmake` (Emscripten 6.0.11) and run in Chrome with WebGPU:

* **Attract-mode race:** logs `[web-warm]` and `[web-pace] race steps/s=60.0`.
* **50cc Grand Prix on Luigi Circuit:** `[web-warm]` reads course 8 and the real 12-player roster
  (`mdf_kart/mr sdf_kart/bpc la_kart/dk ...`), `[web-fetch]` prefetches the kart archives, and
  `[web-pace]` reports 60 race steps/s with occasional catch-up skips. Before the change, none of
  these lines appeared on NTSC-U.

* **Invite room (2026-10-29):** two Chrome clients through the room relay vendored in the outer
  repository (`tools/relay`) matched and raced on Luigi Circuit; `[vnet] joined the room`,
  `[room-launch] login complete`, `character selection ready`, `[web-warm]` and
  `[web-pace] race steps/s=60.0` on both. NTSC-U queues the ESRB notice (section `0x16`)
  before the title, where PAL queues nothing; `web_room_launch.cpp` accepts it.

The lag-wait removal needs a laggy peer and was not exercised.

## Possible existing NTSC-K problems (not web, not verified)

Two existing NTSC-K rows disagree with Wiimm's database, in a way consistent with the REL .data
and .rodata shifts above. Without an RMCK01 binary, neither is confirmed:

* `808B4C20` GameScreen vtable: the table gives `808A3080` (SECTION-RELATIVE), Wiimm gives
  `808A3098`.
* `8088FDB8` movie mode table: the table gives `8087E178` (SECTION-RELATIVE), Wiimm gives
  `8087E1C0`.
