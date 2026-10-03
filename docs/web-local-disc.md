# Web build: the player's own disc image

The browser build can play from a disc image the player picks in the page. The image is read on
the player's device and is never uploaded: the server only hosts `WiiCompiled.{html,js,wasm,data}`
and the two disc reader files below, none of which contain game data.

## Where the game data comes from

| Mode | When | Source |
|---|---|---|
| Local disc image (default) | the site has no staged game folder, or `?disc=local` | the file the player picks (WBFS, ISO or CISO) |
| Staged game folder | `game/manifest-v2.txt` and `game/DATA/sys/boot.bin` are served next to the page, or `?disc=fetch` | the extracted disc under `game/` (`tools/stage-web.sh` in the page tooling) |

The page probes for the staged folder before the game loads, so the owner's local setup keeps
working unchanged, and a site without `game/` asks each player for their disc. A sign-in page
returned instead of the manifest does not count as a staged folder.

## How it works

1. `shell.html` starts `mkw_disc_worker.js` with the picked `File`. The worker runs nod
   (`runtime/src/platform/web/disc-wasm`, compiled to `wasm32-unknown-unknown` as `mkw_disc.wasm`),
   which reads the image through one synchronous callback served with `FileReaderSync` on
   `File.slice()`.
2. The worker checks the game ID and the SHA-256 of `main.dol` and `StaticR.rel` against the clean
   retail executables pinned in `projects/*/recomp.yml` (the Node tests keep the two in step). The
   page then requires the disc's game ID to be the one this build was translated from
   (`mkw_web_build_game_id`, from `MKW_REGION_GAME_ID`), and only then enables Start.
3. The page passes a BroadcastChannel name unique to the tab in `MKW_WEB_DISC`. `web_platform.cpp`
   mounts `/game` with the WASMFS fetch backend as before; its JS half (`mkw_fetchfs.js`) hands the
   backend to `mkw_discfs.js` when that name is set. The worker answers with a manifest in the
   format of a staged `game/manifest.txt`, so the C++ side creates the same tree, and then serves
   1 MiB chunks of decrypted partition data on request.
4. `mkw_discfs.js` keeps chunks in a 256 MiB LRU cache. Requests carry a priority (the game is
   waiting / a race is about to need it / background) and the worker serves the most urgent queued
   chunk next. The race prefetch API (`web_race_warm.cpp`'s `mkw-prefetch` channel), the next
   Grand Prix course and final-lap music warmups, and the sound-archive regions a race reads as it
   starts work as they do for a staged folder.

Where the browser has `showOpenFilePicker` (Chrome, Edge), the picked file's handle is kept in
IndexedDB (`mkw-disc`), so a returning player clicks "Use ... again" and confirms access instead
of finding the file. Elsewhere, and after "Clear local game data", the player picks the file again.
"Clear local game data" forgets the handle; saves and settings (OPFS) are kept.

## Building and hosting

The web build compiles the reader with cargo (Rust stable plus
`rustup target add wasm32-unknown-unknown`); nod is pinned by git revision in
`disc-wasm/Cargo.toml` and `Cargo.lock`. For an offline build, point `-DMKW_NOD_SOURCE_DIR=` at a
local nod checkout. Without cargo the build still succeeds, with a warning, and can only play a
staged folder. The build places `mkw_disc.wasm` and `mkw_disc_worker.js` next to
`WiiCompiled.html`; copy them wherever the page is staged or deployed.

## Limits

- RVZ, WIA, GCZ and NKit images need compression backends that are not compiled for the web;
  the page says so and asks for ISO or WBFS.
- Menu videos play from the disc's original THP files. A staged folder can use the half-frame-rate
  copies `tools/stage-web.sh` makes, which cost less to decode.

## Tests

`node --test runtime/src/platform/web/tests/*.test.mjs` covers the backend
(`mkw_discfs.test.mjs`, with a scripted worker), the worker with the real nod wasm against a
synthetic GameCube-layout image (`mkw_disc_worker.test.mjs`; set `MKW_DISC_WASM` or
`MKW_WEB_BUILD_DIR`, otherwise those tests are skipped) and the page (`room_ui.test.mjs`). With
`MKW_DISC_IMAGE=/path/to/your.wbfs` (and optionally `MKW_DISC_EXTRACTED=/path/to/Assets/DATA`) the
worker test also opens your own image in place and compares files with the extracted copy.
