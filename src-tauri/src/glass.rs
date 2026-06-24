// macOS 26 (Tahoe) Liquid Glass sidebar.
//
// window-vibrancy gives the pre-Tahoe NSVisualEffectView "frost"; macOS 26's native sidebar uses
// the new NSGlassEffectView (Liquid Glass) material instead. A WKWebView app draws its own sidebar
// in HTML, so the system won't apply Liquid Glass automatically the way it does for a native
// NSSplitViewController sidebar.
//
// We insert an NSGlassEffectView sized to the SIDEBAR STRIP only (left edge, sidebar width, full
// height) behind the transparent WKWebView, so the glass appears only behind the sidebar — never
// the content area. (Sizing the strip natively is why we don't just lay a full-window glass and
// mask it with opaque CSS: a single transparent content region would otherwise blur the whole
// window. Whole-window plugins like tauri-plugin-liquid-glass can't constrain the region.)
//
// The sidebar is user-resizable, so the renderer pushes the live width via set_sidebar_glass_width
// (commands.rs → set_width here). We keep the view handle in Tauri state to resize it. NSGlassEffectView
// doesn't exist before macOS 26, so the caller version-gates this; older systems get the vibrancy
// fallback (lib.rs).

use std::sync::Mutex;

use objc2::rc::Retained;
use objc2_app_kit::{
  NSAutoresizingMaskOptions, NSGlassEffectView, NSGlassEffectViewStyle, NSView, NSWindow,
  NSWindowButton, NSWindowOrderingMode,
};
use objc2_foundation::{MainThreadMarker, NSPoint, NSProcessInfo, NSRect, NSSize};
use tauri::{Manager, WebviewWindow};

// Traffic-light inset from the window's top-left — sits the buttons centered in the ~60px sidebar
// header (layout.css .sidebar-logo), matching the macOS 26 sidebar. Used at window creation and
// re-applied on every resize.
pub const TRAFFIC_X: f64 = 20.0;
pub const TRAFFIC_Y: f64 = 24.0;

// The glass view, kept so the resize command can update its width. Retained<NSGlassEffectView> isn't
// Send (AppKit objects are main-thread-only); we only ever touch it on the main thread
// (run_on_main_thread), so the wrapper just makes it storable in Tauri's managed state.
#[derive(Default)]
pub struct SidebarGlass(pub Mutex<Option<GlassHandle>>);
pub struct GlassHandle(Retained<NSGlassEffectView>);
// SAFETY: only dereferenced on the main thread (see set_width / apply_glass_sidebar).
unsafe impl Send for GlassHandle {}

// macOS major version (26 = Tahoe). NSProcessInfo is available on every macOS we run on.
pub fn macos_major_version() -> isize {
  NSProcessInfo::processInfo().operatingSystemVersion().majorVersion
}

// Insert the Liquid Glass strip behind the webview, sized to `width` × full height, pinned left.
// Must run on the main thread (AppKit view work). Stores the view in state for later resizing.
pub fn apply_glass_sidebar(window: &WebviewWindow, width: f64) -> Result<(), String> {
  let mtm =
    MainThreadMarker::new().ok_or("apply_glass_sidebar must run on the main thread")?;
  let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())?;
  if ns_window_ptr.is_null() {
    return Err("ns_window returned null".into());
  }
  // SAFETY: Tauri hands us the window's NSWindow pointer; it outlives this call (and the app).
  let ns_window: &NSWindow = unsafe { &*(ns_window_ptr as *const NSWindow) };
  let content_view = ns_window.contentView().ok_or("window has no contentView")?;

  let height = content_view.bounds().size.height;
  let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
  let glass = NSGlassEffectView::initWithFrame(mtm.alloc(), frame);
  // Regular = the standard frosted Liquid Glass (Clear is the more see-through variant).
  glass.setStyle(NSGlassEffectViewStyle::Regular);
  // Square corners. Liquid Glass rounds its corners by default (it's meant as a floating element),
  // which makes the strip's visible right edge read as a floating card instead of a flush, edge-to-
  // edge sidebar. Zero gives the sharp sidebar edge that meets the content area cleanly.
  glass.setCornerRadius(0.0);
  // Pin to the left at a fixed width, full height: height tracks the window; the right margin is
  // flexible so the strip stays left-anchored and doesn't widen on resize.
  glass.setAutoresizingMask(
    NSAutoresizingMaskOptions::ViewHeightSizable | NSAutoresizingMaskOptions::ViewMaxXMargin,
  );
  // Rear-most subview, behind the WKWebView, so the glass shows through the transparent sidebar.
  // addSubview retains it; we also keep a handle in state for resizing.
  content_view.addSubview_positioned_relativeTo(&glass, NSWindowOrderingMode::Below, None);
  let state = window
    .try_state::<SidebarGlass>()
    .ok_or("SidebarGlass state not managed")?;
  state.0.lock().map_err(|e| e.to_string())?.replace(GlassHandle(glass));
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

// Resize the glass strip to a new sidebar width. Must run on the main thread (caller dispatches via
// run_on_main_thread). No-op if the glass was never applied (older macOS / apply failed).
pub fn set_width(app: &tauri::AppHandle, width: f64) {
  // try_state (not state) so a missing/unmanaged state degrades to a no-op instead of panicking.
  let state = match app.try_state::<SidebarGlass>() {
    Some(s) => s,
    None => return,
  };
  let guard = match state.0.lock() {
    Ok(g) => g,
    Err(_) => return,
  };
  if let Some(handle) = guard.as_ref() {
    let view = &handle.0;
    let mut frame = view.frame();
    frame.size.width = width;
    view.setFrame(frame);
  }
}
