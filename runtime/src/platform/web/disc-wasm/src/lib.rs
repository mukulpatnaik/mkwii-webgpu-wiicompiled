// SPDX-License-Identifier: GPL-3.0-or-later
//! The browser build's disc reader: opens the player's own GameCube/Wii disc image (ISO, WBFS,
//! CISO) through nod, from a host-supplied random-access read callback, so the image is read on
//! the player's device and never uploaded. mkw_disc_worker.js runs it in a Web Worker over
//! `FileReaderSync` on slices of the picked `File`; the Node tests run it over a plain file.
//!
//! Plain C ABI, no wasm-bindgen: one import (`env.host_read_at`) and these exports:
//!   disc_alloc(n) / disc_free(ptr, n)       scratch memory the host fills or reads
//!   disc_last_error(out, cap) -> len        message of the last failure
//!   disc_open(len_lo, len_hi) -> 0 | -1     opens the image and its data partition
//!   disc_close()
//!   disc_game_id(out) -> 6 | 0              the 6-byte game ID (e.g. RMCE01)
//!   disc_list(out, cap) -> len              the data partition's FST in preorder:
//!                                           "d\t<path>\n" or "f\t<offset>\t<size>\t<path>\n",
//!                                           offsets into the partition's data, paths relative
//!   disc_sys(which, out, cap) -> len | -1   1 main.dol, 2 fst.bin, 3 boot.bin, 4 bi2.bin,
//!                                           5 apploader.img (whole, at most `cap` copied)
//!   disc_read_at(off_lo, off_hi, out, len)  `len` bytes of partition data at an offset
//!
//! wasm32-unknown-unknown is single-threaded, which is why `HostStream` can claim `Send`.

use std::alloc::{alloc, dealloc, Layout};
use std::cell::RefCell;
use std::fmt::Write as _;
use std::io::{self, Read, Seek, SeekFrom};

use nod::common::PartitionKind;
use nod::read::{DiscOptions, DiscReader, DiscStream, PartitionMeta, PartitionOptions, PartitionReader};

#[link(wasm_import_module = "env")]
extern "C" {
    /// The host fills `len` bytes at `ptr` from byte offset `(hi << 32) | lo` of the image.
    /// Returns 0 on success, nonzero on failure (short read, I/O error).
    fn host_read_at(ptr: *mut u8, len: u32, offset_lo: u32, offset_hi: u32) -> i32;
}

#[derive(Clone)]
struct HostStream {
    len: u64,
}

// Single-threaded wasm: there is no second thread for this to be unsafe on.
unsafe impl Send for HostStream {}

impl DiscStream for HostStream {
    fn read_exact_at(&mut self, buf: &mut [u8], offset: u64) -> io::Result<()> {
        if offset.checked_add(buf.len() as u64).map_or(true, |end| end > self.len) {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        let rc = unsafe {
            host_read_at(buf.as_mut_ptr(), buf.len() as u32, offset as u32, (offset >> 32) as u32)
        };
        if rc != 0 {
            return Err(io::Error::new(io::ErrorKind::Other, "host read failed"));
        }
        Ok(())
    }

    fn stream_len(&mut self) -> io::Result<u64> { Ok(self.len) }
}

struct State {
    disc: DiscReader,
    partition: Box<dyn PartitionReader>,
    meta: PartitionMeta,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}

fn set_error(message: impl Into<String>) -> i32 {
    LAST_ERROR.with(|e| *e.borrow_mut() = message.into());
    -1
}

fn write_out(out: *mut u8, cap: u32, bytes: &[u8]) -> u32 {
    let n = bytes.len().min(cap as usize);
    if n > 0 {
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, n) };
    }
    bytes.len() as u32
}

/// Allocates `n` bytes the host may write into (paths) or read from (results).
#[no_mangle]
pub extern "C" fn disc_alloc(n: u32) -> *mut u8 {
    unsafe { alloc(Layout::from_size_align_unchecked(n.max(1) as usize, 8)) }
}

#[no_mangle]
pub extern "C" fn disc_free(ptr: *mut u8, n: u32) {
    unsafe { dealloc(ptr, Layout::from_size_align_unchecked(n.max(1) as usize, 8)) }
}

/// Copies the last error message; returns its full length.
#[no_mangle]
pub extern "C" fn disc_last_error(out: *mut u8, cap: u32) -> u32 {
    LAST_ERROR.with(|e| write_out(out, cap, e.borrow().as_bytes()))
}

/// Opens the image (its byte length split in two words) and its data partition. 0 on success.
#[no_mangle]
pub extern "C" fn disc_open(len_lo: u32, len_hi: u32) -> i32 {
    disc_close();
    let len = ((len_hi as u64) << 32) | len_lo as u64;
    let stream: Box<dyn DiscStream> = Box::new(HostStream { len });
    let disc = match DiscReader::new_stream(stream, &DiscOptions::default()) {
        Ok(d) => d,
        Err(e) => return set_error(format!("not a readable disc image: {e}")),
    };
    let mut partition =
        match disc.open_partition_kind(PartitionKind::Data, &PartitionOptions::default()) {
            Ok(p) => p,
            Err(e) => return set_error(format!("no data partition: {e}")),
        };
    let meta = match partition.meta() {
        Ok(m) => m,
        Err(e) => return set_error(format!("unreadable partition header: {e}")),
    };
    if let Err(e) = meta.fst() {
        return set_error(format!("unreadable file system table: {e}"));
    }
    STATE.with(|s| *s.borrow_mut() = Some(State { disc, partition, meta }));
    0
}

#[no_mangle]
pub extern "C" fn disc_close() { STATE.with(|s| *s.borrow_mut() = None); }

/// Writes the 6-byte game ID (e.g. RMCE01). Returns 6, or 0 when nothing is open.
#[no_mangle]
pub extern "C" fn disc_game_id(out: *mut u8) -> u32 {
    STATE.with(|s| match s.borrow().as_ref() {
        Some(st) => write_out(out, 6, &st.disc.header().game_id),
        None => 0,
    })
}

/// Lists the data partition's file system table (see the module comment for the format).
/// Returns the full length so the host can size the buffer and call again.
#[no_mangle]
pub extern "C" fn disc_list(out: *mut u8, cap: u32) -> u32 {
    STATE.with(|s| {
        let guard = s.borrow();
        let Some(st) = guard.as_ref() else { return 0 };
        let Ok(fst) = st.meta.fst() else { return 0 };
        let is_wii = st.partition.is_wii();
        let mut text = String::new();
        for (_, node, path) in fst.iter() {
            if node.is_dir() {
                let _ = writeln!(text, "d\t{path}");
            } else {
                let _ = writeln!(text, "f\t{}\t{}\t{path}", node.offset(is_wii), node.length());
            }
        }
        write_out(out, cap, text.as_bytes())
    })
}

/// Copies a system file of the data partition, whole (at most `cap` bytes). Returns its full
/// length, or -1 for an unknown `which`.
#[no_mangle]
pub extern "C" fn disc_sys(which: u32, out: *mut u8, cap: u32) -> i64 {
    STATE.with(|s| {
        let guard = s.borrow();
        let Some(st) = guard.as_ref() else { return set_error("not open") as i64 };
        let bytes: &[u8] = match which {
            1 => &st.meta.raw_dol[..],
            2 => &st.meta.raw_fst[..],
            3 => &st.meta.raw_boot[..],
            4 => &st.meta.raw_bi2[..],
            5 => &st.meta.raw_apploader[..],
            _ => return set_error(format!("unknown system file {which}")) as i64,
        };
        write_out(out, cap, bytes) as i64
    })
}

/// Reads `len` bytes of (decrypted) partition data at `offset` into `out`. 0 on success. A file
/// listed by `disc_list` at offset `o` occupies `o .. o + size`.
#[no_mangle]
pub extern "C" fn disc_read_at(offset_lo: u32, offset_hi: u32, out: *mut u8, len: u32) -> i32 {
    STATE.with(|s| {
        let mut guard = s.borrow_mut();
        let Some(st) = guard.as_mut() else { return set_error("not open") };
        let offset = ((offset_hi as u64) << 32) | offset_lo as u64;
        if let Err(e) = st.partition.seek(SeekFrom::Start(offset)) {
            return set_error(format!("seek to {offset:#x}: {e}"));
        }
        let buf = unsafe { std::slice::from_raw_parts_mut(out, len as usize) };
        match st.partition.read_exact(buf) {
            Ok(()) => 0,
            Err(e) => set_error(format!("read {len} bytes at {offset:#x}: {e}")),
        }
    })
}
