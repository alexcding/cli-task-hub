// macOS 26 (Tahoe) Liquid Glass + traffic-light positioning.
//
// window-vibrancy gives the pre-Tahoe NSVisualEffectView "frost"; macOS 26's native sidebar uses
// the new NSGlassEffectView (Liquid Glass) material instead. A WKWebView app draws its own sidebar
// in HTML, so the system won't apply Liquid Glass automatically the way it does for a native
// NSSplitViewController sidebar.
//
// We insert a full-window NSGlassEffectView behind the transparent WKWebView. The renderer paints
// the content area opaque (css: html.native-mac .workarea) and leaves the sidebar transparent, so
// once loaded the glass shows only behind the sidebar; during load it backs the whole window so the
// slower-painting content area isn't a bare gap next to the instant native glass. The view
// auto-resizes with the window. NSGlassEffectView doesn't exist before macOS 26, so the caller
// version-gates this; older systems get the NSVisualEffectView vibrancy fallback (lib.rs).

use objc2::AnyThread;
use objc2_app_kit::{
  NSApplication, NSAutoresizingMaskOptions, NSGlassEffectView, NSGlassEffectViewStyle, NSImage,
  NSWindow, NSWindowOrderingMode,
};
use objc2_foundation::{MainThreadMarker, NSData, NSProcessInfo};
use std::sync::Mutex;
use tauri::{WebviewWindow, Window};

// macOS major version (26 = Tahoe). NSProcessInfo is available on every macOS we run on.
pub fn macos_major_version() -> isize {
  NSProcessInfo::processInfo().operatingSystemVersion().majorVersion
}

// The real app icon, embedded so it's available with no bundle on disk and no cwd dependency.
const APP_ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

// Set the Dock/⌘-Tab icon at runtime via [NSApp setApplicationIconImage:]. macOS normally derives
// that icon from the .app bundle's Info.plist (CFBundleIconFile) — but `tauri dev` runs the bare
// `target/debug/taskhub` with no bundle, so any runtime activation-policy change (Accessory→Regular,
// i.e. showing the Dock icon) makes AppKit re-derive it and fall back to the generic executable
// icon. Reapplying the embedded icon after we flip to Regular restores the real one. Harmless in a
// packaged build (re-sets the same icon the bundle already provides). Must run on the main thread;
// no-ops otherwise (the activation-policy callers are already on it).
pub fn set_app_icon() {
  let Some(mtm) = MainThreadMarker::new() else { return };
  let data = NSData::with_bytes(APP_ICON_PNG);
  // SAFETY: standard AppKit calls on the main thread; initWithData returns None on bad data, which
  // we skip rather than setting a nil icon (that would clear it to the generic icon).
  unsafe {
    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
      NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image));
    }
  }
}

// Insert a full-window Liquid Glass backdrop behind the webview. Must run on the main thread.
//
// Full-window, not just the sidebar strip: the native glass paints instantly when the window shows,
// while the WKWebView (the content) paints later — a strip-only glass left the right side as a
// bare/transparent gap during that load. A full-window backdrop fills the whole window uniformly so
// there's no left-fast / right-slow flash. The renderer paints the content area opaque (css:
// html.native-mac .workarea), so once loaded the glass shows through only the transparent sidebar;
// during load it backs the entire window. It auto-resizes with the window, so no width tracking.
pub fn apply_glass_sidebar(window: &WebviewWindow) -> Result<(), String> {
  let mtm =
    MainThreadMarker::new().ok_or("apply_glass_sidebar must run on the main thread")?;
  let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())?;
  if ns_window_ptr.is_null() {
    return Err("ns_window returned null".into());
  }
  // SAFETY: Tauri hands us the window's NSWindow pointer; it outlives this call (and the app).
  let ns_window: &NSWindow = unsafe { &*(ns_window_ptr as *const NSWindow) };
  let content_view = ns_window.contentView().ok_or("window has no contentView")?;

  let frame = content_view.bounds();
  let glass = NSGlassEffectView::initWithFrame(mtm.alloc(), frame);
  // Regular = the standard frosted Liquid Glass (Clear is the more see-through variant).
  glass.setStyle(NSGlassEffectViewStyle::Regular);
  // Round the glass to match the window's rounded corners (full-window backdrop). 0 was right for
  // the old sidebar strip (flush right edge), but full-window with square corners leaves the glass
  // square where the window is rounded. ~10–12pt matches a standard macOS window corner.
  glass.setCornerRadius(11.0);
  // Track the full window on resize (both dimensions).
  glass.setAutoresizingMask(
    NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
  );
  // Rear-most subview, behind the WKWebView. addSubview retains it (the view hierarchy owns it).
  content_view.addSubview_positioned_relativeTo(&glass, NSWindowOrderingMode::Below, None);
  Ok(())
}

// Double-click-to-zoom that "mimics a drag-resize" instead of NSWindow's native zoom.
//
// The native zoom (toggleMaximize / the green button) animates the window frame over ~0.2s on
// AppKit's own clock. The WKWebView content can't relayout fast enough to track that, so the window
// outruns the view (the reported "window resizes faster than the view"). A *drag* never shows this,
// at any speed, because each step is a discrete resize the view lays out for before the next one.
//
// So we reproduce a drag: the renderer clocks the animation with requestAnimationFrame and, each
// frame, sends an eased progress t∈[0,1]; we setFrame…animate:NO to the interpolated frame. Because
// the renderer drives the step, the view has laid out for the current size before it asks for the
// next — they stay in lockstep. zoom_begin captures the from/to frames (and toggles maximize vs.
// restore); zoom_apply tweens and clears the state on the final frame.
//
// (origin x/y, width, height) in macOS screen coords — kept in Cocoa space so there's no top-left ↔
// bottom-left conversion; both frames come straight from NSWindow/NSScreen.
type Frame = (f64, f64, f64, f64);

// Pre-maximize frame, remembered while maximized so a later restore knows the normal size. None =
// the window is at its normal size (next zoom maximizes).
static SAVED_FRAME: Mutex<Option<Frame>> = Mutex::new(None);

struct Zoom {
  from: Frame,
  to: Frame,
}
// The in-flight tween set up by zoom_begin and consumed by zoom_apply.
static ZOOM: Mutex<Option<Zoom>> = Mutex::new(None);

// AppKit must be touched on the main thread, but Tauri runs commands off it, so hop over via
// run_on_main_thread (re-fetching the NSWindow there — the raw pointer isn't Send). Called from the
// always-compiled commands::zoom_* shims (this module is macOS-only). Takes a Window (not a
// WebviewWindow): the command resolves it via get_webview("main").window(), which — unlike a
// WebviewWindow command arg — still works once the window is multiwebview (a PR/Jira tab open).
fn with_ns_window(window: &Window, f: impl FnOnce(&NSWindow) + Send + 'static) {
  let window = window.clone();
  let _ = window.clone().run_on_main_thread(move || {
    match window.ns_window() {
      Ok(p) if !p.is_null() => {
        // SAFETY: valid NSWindow pointer from Tauri, used only here on the main thread.
        let ns_window: &NSWindow = unsafe { &*(p as *const NSWindow) };
        f(ns_window);
      }
      _ => {}
    }
  });
}

fn frame_tuple(ns_window: &NSWindow) -> Frame {
  let r = ns_window.frame();
  (r.origin.x, r.origin.y, r.size.width, r.size.height)
}

// Decide direction and capture the tween endpoints. Maximize → save the current frame and target the
// screen's visible (work-area) frame, which excludes the menu bar + Dock. Restore → tween back to the
// saved frame and forget it.
pub fn zoom_begin(window: Window) {
  with_ns_window(&window, |ns_window| {
    let cur = frame_tuple(ns_window);
    let mut saved = SAVED_FRAME.lock().unwrap();
    let to = if let Some(normal) = saved.take() {
      normal
    } else {
      let Some(screen) = ns_window.screen() else { return };
      let v = screen.visibleFrame();
      *saved = Some(cur);
      (v.origin.x, v.origin.y, v.size.width, v.size.height)
    };
    *ZOOM.lock().unwrap() = Some(Zoom { from: cur, to });
  });
}

// Tween toward the target by eased progress t (sent per requestAnimationFrame by the renderer). The
// final frame (t ≥ 1) snaps exactly to the target and clears the tween.
pub fn zoom_apply(window: Window, t: f64) {
  with_ns_window(&window, move |ns_window| {
    let mut zoom = ZOOM.lock().unwrap();
    let Some(z) = zoom.as_ref() else { return };
    let lerp = |a: f64, b: f64| a + (b - a) * t;
    let mut f = ns_window.frame();
    f.origin.x = lerp(z.from.0, z.to.0);
    f.origin.y = lerp(z.from.1, z.to.1);
    f.size.width = lerp(z.from.2, z.to.2);
    f.size.height = lerp(z.from.3, z.to.3);
    ns_window.setFrame_display_animate(f, true, false);
    if t >= 1.0 {
      *zoom = None;
    }
  });
}

// (No custom traffic-light positioning — the buttons sit at macOS's default spot. A hand-rolled inset
// jittered on resize, and the only jitter-free fix is an NSWindow-delegate wrap; not worth the extra
// code/library for a small cosmetic gain. The overlay/hidden-title chrome stays; only the lights are
// left stock.)
