# Web build: the player's own disc image

The browser build can play from a disc image the player picks in the page. The image is read on
the player's device and is never uploaded: the server only hosts `WiiCompiled.{html,js,wasm,data}`
and the two disc reader files below, none of which contain game data.

## Where the game data comes from

| Mode | When | Source |
|---|---|---|
| Local disc image (default) | the site has no staged game folder, or `?disc=local` | the file the player picks (WBFS, ISO or CISO) |
| Staged game folder | `game/manifest-v2.txt` and the disc's `boot.bin` (`game/DATA/sys/boot.bin`, or the file pack the manifest puts it in) are served next to the page, or `?disc=fetch` | the extracted disc under `game/` (`tools/stage-web.sh` in the page tooling) |

The page probes for the staged folder before the game loads, so the owner's local setup keeps
working unchanged, and a site without `game/` asks each player for their disc. A sign-in page
returned instead of the manifest does not count as a staged folder. The page hands the manifest it
downloaded for the probe to the game's file backend (`MKW_WEB_MANIFEST_URL`, a `blob:` URL), so
it is not downloaded twice.

Before the game starts, the page shows a menu over the whole window (`#menu` in `shell.html`).
With a local disc image it opens on a disc screen and moves to the four choices (Solo, Play with
friends, Controls, Saves) once a disc image is verified; "Change disc" in the header brings the
disc screen back. With a staged game folder there is no disc screen. The game loads in the
background on either screen, and Start hands the menu's blocks to the controls panel beside the
game.

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
   starts work as they do for a staged folder; so do the video ones: a playing video keeps two
   chunks read ahead, and the first 2 MiB of each menu video are read in the background at
   start-up.
5. The menu's video previews (`thp/button`, `thp/course`, `thp/battle` and `thp/title/top_menu.thp`)
   are served with every other frame at half the frame rate, the same files `tools/stage-web.sh`
   stages (`tools/web_menu_videos.py` in the page tooling): they play at the same speed for half
   the JPEG decoding (played from the originals, the pre-race menus fell to about 30 fps in
   Chrome). Kept frames are copied byte for byte; only the THP container's links, frame count,
   rate and offsets change. After it reports the disc, the worker walks each of those files'
   frame chain once (about 3 s for the 490 MB of NTSC-U menu videos, in Node and in Chrome),
   answers the game's requests for the manifest with "preparing" meanwhile, and then lists the
   converted sizes; chunks of a converted file are assembled from the original as they are read.
   A file the conversion refuses is served unchanged.

Where the browser has `showOpenFilePicker` (Chrome, Edge), the picked file's handle is kept in
IndexedDB (`mkw-disc`), so a returning player clicks "Use ... again" and confirms access instead
of finding the file. Elsewhere, and after "Clear local game data", the player picks the file again.
"Clear local game data" forgets the handle; saves and settings (OPFS) are kept.

## Building and hosting

The web build compiles the reader with cargo (Rust stable plus
`rustup target add wasm32-unknown-unknown`); nod is pinned by git revision in
`disc-wasm/Cargo.toml` and `Cargo.lock`. Cargo builds a copy of the crate in the build directory
(`disc-wasm/crate`, by `disc-wasm/build_disc_reader.cmake`), so a build never writes into the
source tree. For an offline build, point `-DMKW_NOD_SOURCE_DIR=` at a local checkout of the nod
repository at the pinned revision (its crates.io dependencies must already be in cargo's cache);
the copied `Cargo.lock` is then re-resolved for the local path, and the committed one is left
alone.

The disc reader is optional for the build. When CMake configures, it checks for cargo and for the
wasm32-unknown-unknown standard library in the toolchain cargo will use; when either is missing it
warns, builds the rest, and leaves out `mkw_disc.wasm` (install it and run CMake again). A cargo
failure during the build (for example offline without a cached nod) is also a warning, and removes
any `mkw_disc.wasm` left from an earlier build. Without it the page says the disc reader is
missing from the site when a player picks an image, and a staged folder still plays.

The build places `mkw_disc.wasm` and `mkw_disc_worker.js` next to `WiiCompiled.html`; copy them
wherever the page is staged or deployed.

## Limits

- RVZ, WIA, GCZ and NKit images need compression backends that are not compiled for the web;
  the page says so and asks for ISO or WBFS.
- The menu videos are indexed each time an image is opened; nothing is kept between visits.

## Tests

`node --test runtime/src/platform/web/tests/*.test.mjs` covers the backend
(`mkw_discfs.test.mjs`, with a scripted worker), the worker with the real nod wasm against a
synthetic GameCube-layout image (`mkw_disc_worker.test.mjs`; set `MKW_DISC_WASM` or
`MKW_WEB_BUILD_DIR`, otherwise those tests are skipped) and the page (`room_ui.test.mjs`). With
`MKW_DISC_IMAGE=/path/to/your.wbfs` (and optionally `MKW_DISC_EXTRACTED=/path/to/Assets/DATA`) the
worker test also opens your own image in place and compares files with the extracted copy. With
`MKW_MENU_VIDEOS_DIR` set as well, to the conversion cache `web_menu_videos.py` writes (its third
argument; run it into a scratch directory outside the repository), it checks that the worker
converts exactly the files the script converts, to the same bytes. All of that output is
game-derived: keep it out of git.
