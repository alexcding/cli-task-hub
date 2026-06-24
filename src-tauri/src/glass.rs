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

use objc2_app_kit::{
  NSAutoresizingMaskOptions, NSGlassEffectView, NSGlassEffectViewStyle, NSView, NSWindow,
  NSWindowButton, NSWindowOrderingMode,
};
use objc2_foundation::{MainThreadMarker, NSProcessInfo};
use tauri::WebviewWindow;

// Traffic-light inset from the window's top-left — sits the buttons centered in the ~60px sidebar
// header (layout.css .sidebar-logo), matching the macOS 26 sidebar. Used at window creation and
// re-applied on every resize.
pub const TRAFFIC_X: f64 = 20.0;
pub const TRAFFIC_Y: f64 = 24.0;

// macOS major version (26 = Tahoe). NSProcessInfo is available on every macOS we run on.
pub fn macos_major_version() -> isize {
  NSProcessInfo::processInfo().operatingSystemVersion().majorVersion
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

// Reposition the native traffic lights to (x, y) from the window's top-left. This mirrors tao's
// inset_traffic_lights, which Tauri never applies on a webview window: tao runs it from its own
// content view's drawRect, but our content view is the WKWebView, so that draw never fires. So we
// drive it ourselves — at window creation and on every resize (macOS rebuilds the titlebar
// container on resize, snapping the buttons back). Must run on the main thread. Safely no-ops if
// the titlebar button hierarchy isn't what we expect (e.g. a future macOS layout change).
pub fn set_traffic_lights(ns_window_ptr: *mut std::ffi::c_void, x: f64, y: f64) {
  if ns_window_ptr.is_null() {
    return;
  }
  // SAFETY: a valid NSWindow pointer from Tauri; only touched on the main thread.
  let ns_window: &NSWindow = unsafe { &*(ns_window_ptr as *const NSWindow) };
  let (close, mini, zoom) = match (
    ns_window.standardWindowButton(NSWindowButton::CloseButton),
    ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton),
    ns_window.standardWindowButton(NSWindowButton::ZoomButton),
  ) {
    (Some(c), Some(m), Some(z)) => (c, m, z),
    _ => return,
  };
  // The titlebar container is the buttons' grandparent view. Resizing it taller and pinning it to
  // the window top is what pushes the buttons down by `y` (tao's exact approach).
  let container = match unsafe { close.superview().and_then(|v| v.superview()) } {
    Some(v) => v,
    None => return,
  };

  let close_frame = NSView::frame(&close);
  let title_bar_height = close_frame.size.height + y;
  let mut bar = NSView::frame(&container);
  bar.size.height = title_bar_height;
  bar.origin.y = ns_window.frame().size.height - title_bar_height;
  container.setFrame(bar);

  let spacing = NSView::frame(&mini).origin.x - close_frame.origin.x;
  for (i, button) in [close, mini, zoom].into_iter().enumerate() {
    let mut origin = NSView::frame(&button).origin;
    origin.x = x + i as f64 * spacing;
    button.setFrameOrigin(origin);
  }
}
