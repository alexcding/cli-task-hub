//! Owned, exclusively accessed headless Ghostty state for daemon snapshots.
//! The renderer and daemon must share the pinned upstream revision. Snapshot v1
//! does not include Kitty image payloads or glyph glossary registrations.
use std::{ffi::c_void, fmt, ptr::NonNull};

pub const GHOSTTY_REVISION: &str = "82938b633ba646db38591d969c3c526332bd7e65";
pub const SNAPSHOT_LIMIT: usize = 32 * 1024 * 1024;
type Writer = unsafe extern "C" fn(*mut c_void, *const u8, usize) -> bool;

extern "C" {
    fn taskhub_vt_new(cols: u16, rows: u16) -> *mut c_void;
    fn taskhub_vt_free(terminal: *mut c_void);
    fn taskhub_vt_feed(terminal: *mut c_void, bytes: *const u8, len: usize);
    fn taskhub_vt_resize(terminal: *mut c_void, cols: u16, rows: u16) -> i32;
    fn taskhub_vt_snapshot(terminal: *mut c_void, write: Writer, userdata: *mut c_void) -> i32;
    fn taskhub_vt_restore(bytes: *const u8, len: usize) -> *mut c_void;
    fn taskhub_vt_format(terminal: *mut c_void, write: Writer, userdata: *mut c_void) -> i32;
    fn taskhub_vt_cursor(terminal: *mut c_void, x: *mut u16, y: *mut u16) -> i32;
    fn taskhub_vt_mode(terminal: *mut c_void, number: u16, ansi: bool, value: *mut bool) -> i32;
}

#[derive(Debug)]
pub struct Error(&'static str);
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Error {}

pub struct Terminal(NonNull<c_void>);
// Ghostty requires exclusive access, but not thread affinity. No method exposes
// its pointer; every operation requires &mut self, and Terminal is not Sync.
unsafe impl Send for Terminal {}

impl Terminal {
    pub fn new(cols: u16, rows: u16) -> Result<Self, Error> {
        if cols == 0 || rows == 0 {
            return Err(Error("Terminal dimensions must be nonzero"));
        }
        NonNull::new(unsafe { taskhub_vt_new(cols, rows) })
            .map(Self)
            .ok_or(Error("Could not create Ghostty terminal"))
    }
    pub fn feed(&mut self, bytes: &[u8]) {
        unsafe { taskhub_vt_feed(self.0.as_ptr(), bytes.as_ptr(), bytes.len()) }
    }
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), Error> {
        check(
            unsafe { taskhub_vt_resize(self.0.as_ptr(), cols, rows) },
            "Could not resize Ghostty terminal",
        )
    }
    pub fn snapshot(&mut self) -> Result<Vec<u8>, Error> {
        self.collect(
            taskhub_vt_snapshot,
            "Could not encode complete terminal snapshot",
        )
    }
    pub fn restore(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > SNAPSHOT_LIMIT {
            return Err(Error("Terminal snapshot exceeds its size limit"));
        }
        NonNull::new(unsafe { taskhub_vt_restore(bytes.as_ptr(), bytes.len()) })
            .map(Self)
            .ok_or(Error("Invalid or incomplete terminal snapshot"))
    }
    /// Diagnostic formatting, never used as a state-restoration format.
    pub fn formatted(&mut self) -> Result<Vec<u8>, Error> {
        self.collect(taskhub_vt_format, "Could not format terminal state")
    }
    pub fn cursor(&mut self) -> Result<(u16, u16), Error> {
        let (mut x, mut y) = (0, 0);
        check(
            unsafe { taskhub_vt_cursor(self.0.as_ptr(), &mut x, &mut y) },
            "Could not read terminal cursor",
        )?;
        Ok((x, y))
    }
    pub fn mode(&mut self, number: u16, ansi: bool) -> Result<bool, Error> {
        let mut value = false;
        check(
            unsafe { taskhub_vt_mode(self.0.as_ptr(), number, ansi, &mut value) },
            "Could not read terminal mode",
        )?;
        Ok(value)
    }
    fn collect(
        &mut self,
        action: unsafe extern "C" fn(*mut c_void, Writer, *mut c_void) -> i32,
        message: &'static str,
    ) -> Result<Vec<u8>, Error> {
        let mut bytes: Vec<u8> = Vec::new();
        // The C writer is synchronous and never retains userdata or the slice.
        check(
            unsafe { action(self.0.as_ptr(), write, (&mut bytes as *mut Vec<u8>).cast()) },
            message,
        )?;
        Ok(bytes)
    }
}
impl Drop for Terminal {
    fn drop(&mut self) {
        unsafe { taskhub_vt_free(self.0.as_ptr()) }
    }
}
fn check(result: i32, message: &'static str) -> Result<(), Error> {
    if result == 0 {
        Ok(())
    } else {
        Err(Error(message))
    }
}
unsafe extern "C" fn write(userdata: *mut c_void, data: *const u8, len: usize) -> bool {
    let bytes = &mut *userdata.cast::<Vec<u8>>();
    if len > SNAPSHOT_LIMIT.saturating_sub(bytes.len()) || bytes.try_reserve(len).is_err() {
        return false;
    }
    bytes.extend_from_slice(std::slice::from_raw_parts(data, len));
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    fn equivalent(left: &mut Terminal, right: &mut Terminal) {
        assert_eq!(left.cursor().unwrap(), right.cursor().unwrap());
        assert_eq!(left.formatted().unwrap(), right.formatted().unwrap());
        for mode in [1, 6, 7, 25, 1000, 1006, 1049, 2004] {
            assert_eq!(
                left.mode(mode, false).unwrap(),
                right.mode(mode, false).unwrap(),
                "mode {mode}"
            );
        }
    }
    #[test]
    fn restores_both_screens_modes_saved_cursor_and_future_behavior_after_large_output() {
        let mut source = Terminal::new(80, 24).unwrap();
        let mut output_bytes = 0;
        for i in 0..8000 {
            let line = format!("history {i:05} styled \x1b[32m日本語🦀\x1b[0m line\r\n");
            output_bytes += line.len();
            source.feed(line.as_bytes());
        }
        assert!(output_bytes > 256 * 1024);
        source.feed(b"PRIMARY_MARKER\x1b[5;9H\x1b7\x1b[?2004h\x1b[?1h\x1b[?1000h\x1b[?1006h\x1b[?1049hALT_MARKER\x1b[3;4H\x1b[31");
        let snapshot = source.snapshot().unwrap();
        assert!(snapshot.starts_with(b"GHOSTSNP"));
        let mut restored = Terminal::restore(&snapshot).unwrap();
        equivalent(&mut source, &mut restored);
        assert!(String::from_utf8_lossy(&restored.formatted().unwrap()).contains("ALT_MARKER"));
        for suffix in [
            b"mRED\x1b[0m".as_slice(),
            b"\x1b[?1049l\x1b8AFTER_SAVED_CURSOR",
            b"\x1b[?2004l\x1b[?1000l",
        ] {
            source.feed(suffix);
            restored.feed(suffix);
            equivalent(&mut source, &mut restored);
        }
        source.resize(113, 37).unwrap();
        restored.resize(113, 37).unwrap();
        equivalent(&mut source, &mut restored);
        let text = String::from_utf8_lossy(&restored.formatted().unwrap()).into_owned();
        assert!(
            text.contains("history 00000")
                && text.contains("PRIMARY_MARKER")
                && text.contains("AFTER_SAVED_CURSOR")
        );
    }
    #[test]
    fn restores_split_utf8_and_rejects_truncated_corrupt_and_trailing_snapshots() {
        let mut source = Terminal::new(80, 24).unwrap();
        source.feed(&[0xf0, 0x9f]);
        let snapshot = source.snapshot().unwrap();
        let mut restored = Terminal::restore(&snapshot).unwrap();
        for terminal in [&mut source, &mut restored] {
            terminal.feed(&[0xa6, 0x80]);
        }
        equivalent(&mut source, &mut restored);
        assert!(String::from_utf8_lossy(&restored.formatted().unwrap()).contains("🦀"));
        for length in [0, 9, snapshot.len() / 2, snapshot.len() - 1] {
            assert!(Terminal::restore(&snapshot[..length]).is_err());
        }
        let mut corrupt = snapshot.clone();
        corrupt[30] ^= 1;
        assert!(Terminal::restore(&corrupt).is_err());
        let mut trailing = snapshot;
        trailing.push(0);
        assert!(Terminal::restore(&trailing).is_err());
    }
    #[test]
    fn resumes_unfinished_control_sequences_and_keeps_continuation_tracking() {
        for (prefix, suffix) in [
            (
                b"\x1b]8;;https://example.com".as_slice(),
                b"\x1b\\LINK\x1b]8;;\x1b\\".as_slice(),
            ),
            (b"\x1b[38;2;100;", b"120;140mCOLOR"),
            (b"\x1bP$q", b"m\x1b\\AFTER_DCS"),
        ] {
            let mut source = Terminal::new(80, 24).unwrap();
            source.feed(prefix);
            let mut restored = Terminal::restore(&source.snapshot().unwrap()).unwrap();
            source.feed(suffix);
            restored.feed(suffix);
            equivalent(&mut source, &mut restored);
            // A restored terminal can itself be checkpointed mid-sequence.
            restored.feed(b"\x1b[3");
            let mut twice = Terminal::restore(&restored.snapshot().unwrap()).unwrap();
            restored.feed(b"2mNEXT");
            twice.feed(b"2mNEXT");
            equivalent(&mut restored, &mut twice);
        }
    }
}
