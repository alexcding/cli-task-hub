// Native context menu for the embedded PR/Jira webview — the Tauri port of the Electron build's
// attachWebviewContextMenu (src/main/windows/window.js). The embedded page is a child WKWebView on
// a remote origin (no IPC, GitHub's CSP blocks any JS beacon), so the only way to put our own menu
// on it is native AppKit: WKWebView calls -willOpenMenu:withEvent: (an NSView hook WebKit overrides)
// just before showing its context menu. We swizzle that once at startup and CURATE the menu —
// keeping the useful items and appending "Open Page in Browser".
//
// Why this is safe (unlike the reverted on_new_window work): it touches ONLY the context-menu hook,
// never webview creation/positioning. The main renderer suppresses its own native menu in JS
// (bridge.js), so in practice this only ever fires for the embedded child webviews. As a belt-and-
// suspenders guard, curate() no-ops unless the menu carries WebKit's own item identifiers.
#![cfg(target_os = "macos")]

use std::ffi::c_void;
use std::sync::atomic::{AtomicPtr, Ordering};

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, Sel};
use objc2::{class, define_class, msg_send, sel, AllocAnyThread, MainThreadOnly};
use objc2_app_kit::{NSMenu, NSMenuItem, NSWorkspace};
use objc2_foundation::{MainThreadMarker, NSString, NSURL};

// The original -[WKWebView willOpenMenu:withEvent:] IMP, saved when we swizzle so our replacement
// can call through to it (WebKit populates the menu there) before curating.
static ORIGINAL: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

// A leaked singleton that backs every "Open Page in Browser" item's action. The item carries the
// page URL as its representedObject; this opens it in the default browser.
static TARGET: AtomicPtr<MenuTarget> = AtomicPtr::new(std::ptr::null_mut());

define_class!(
  #[unsafe(super(NSObject))]
  #[name = "TaskHubMenuTarget"]
  struct MenuTarget;

  unsafe impl NSObjectProtocol for MenuTarget {}

  impl MenuTarget {
    #[unsafe(method(openInBrowser:))]
    fn open_in_browser(&self, sender: &NSMenuItem) {
      unsafe {
        let obj: Option<Retained<AnyObject>> = msg_send![sender, representedObject];
        let Some(obj) = obj else { return };
        // representedObject is the page's NSURL.
        let url: &NSURL = &*(Retained::as_ptr(&obj) as *const NSURL);
        let ws = NSWorkspace::sharedWorkspace();
        let _: bool = msg_send![&ws, openURL: url];
      }
    }
  }
);

// WebKit's menu-item identifiers (NSUserInterfaceItemIdentifier). We keep this set and drop the
// rest (Translate, Share, Speech, Services, Look Up, Download…, Open Link in New Window, etc.).
const KEEP: &[&str] = &[
  "WKMenuItemIdentifierOpenLink",
  "WKMenuItemIdentifierCopyLink",
  "WKMenuItemIdentifierCopyImage",
  "WKMenuItemIdentifierCopy",
  "WKMenuItemIdentifierCut",
  "WKMenuItemIdentifierPaste",
  "WKMenuItemIdentifierGoBack",
  "WKMenuItemIdentifierGoForward",
  "WKMenuItemIdentifierReload",
];

// Our swizzled -willOpenMenu:withEvent:. Calls the original (so WebKit fills the menu), then curates.
unsafe extern "C" fn will_open_menu(this: *mut AnyObject, cmd: Sel, menu: *mut AnyObject, event: *mut AnyObject) {
  let orig = ORIGINAL.load(Ordering::Acquire);
  if !orig.is_null() {
    let f: unsafe extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject) = std::mem::transmute(orig);
    f(this, cmd, menu, event);
  }
  if menu.is_null() || this.is_null() {
    return;
  }
  let menu: &NSMenu = &*(menu as *const NSMenu);
  curate(&*(this as *const AnyObject), menu);
}

fn item_identifier(item: &NSMenuItem) -> Option<String> {
  unsafe {
    let id: Option<Retained<NSString>> = msg_send![item, identifier];
    id.map(|s| s.to_string())
  }
}

fn curate(webview: &AnyObject, menu: &NSMenu) {
  let Some(mtm) = MainThreadMarker::new() else { return };
  unsafe {
    let items = menu.itemArray();
    // Guard: only touch menus that are actually WebKit context menus (carry WK identifiers).
    let is_wk = items.iter().any(|it| item_identifier(&it).map(|s| s.starts_with("WKMenuItemIdentifier")).unwrap_or(false));
    if !is_wk {
      return;
    }
    // Drop everything not in KEEP (separators included — we re-add our own structure).
    for item in items.iter() {
      let keep = item_identifier(&item).map(|id| KEEP.contains(&id.as_str())).unwrap_or(false);
      if !keep {
        menu.removeItem(&item);
      }
    }
    // Append: ─── Open Page in Browser (opens the current page URL externally).
    let url: Option<Retained<NSURL>> = msg_send![webview, URL];
    if let Some(url) = url {
      if menu.numberOfItems() > 0 {
        menu.addItem(&NSMenuItem::separatorItem(mtm));
      }
      let title = NSString::from_str("Open Page in Browser");
      let empty = NSString::from_str("");
      let item = NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), &title, Some(sel!(openInBrowser:)), &empty);
      let target = TARGET.load(Ordering::Acquire);
      if !target.is_null() {
        item.setTarget(Some(&*(target as *const NSObject)));
        item.setRepresentedObject(Some(&*(Retained::as_ptr(&url) as *const AnyObject)));
        menu.addItem(&item);
      }
    }
  }
}

// Swizzle -[WKWebView willOpenMenu:withEvent:] once. Safe to call multiple times (no-ops after the
// first). Must run on the main thread (Tauri setup does).
pub fn install() {
  if !ORIGINAL.load(Ordering::Acquire).is_null() {
    return;
  }
  // Leak one MenuTarget instance to back the "Open Page in Browser" action for the app's lifetime.
  let target: Retained<MenuTarget> = unsafe { msg_send![MenuTarget::alloc(), init] };
  TARGET.store(Retained::into_raw(target), Ordering::Release);

  let cls = class!(WKWebView);
  let sel = sel!(willOpenMenu:withEvent:);
  // Only swizzle if WKWebView defines the method ITSELF (don't accidentally swizzle NSView for all
  // views). instance_method returns inherited methods too, so confirm the superclass differs.
  let Some(method) = cls.instance_method(sel) else {
    log::warn!("[webview-menu] WKWebView has no willOpenMenu:withEvent: — skipping");
    return;
  };
  let super_has = cls.superclass().and_then(|s| s.instance_method(sel)).map(|m| m as *const _) ;
  if super_has == Some(method as *const _) {
    log::warn!("[webview-menu] willOpenMenu is inherited (not WKWebView's own) — skipping to avoid global swizzle");
    return;
  }
  let new_imp: unsafe extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject) = will_open_menu;
  let old = unsafe { method.set_implementation(std::mem::transmute(new_imp)) };
  ORIGINAL.store(old as *mut c_void, Ordering::Release);
  log::info!("[webview-menu] installed (curated WKWebView context menu)");
}
