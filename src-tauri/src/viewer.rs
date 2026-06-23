// Embedded-viewer native bridge (macOS). The JS multiwebview API doesn't surface navigation/title
// events, so we poll each child webview's WKWebView for title / URL / canGoBack / canGoForward and
// emit `wcv://event` to the renderer when they change. bridge.js fans that to the shim, which
// re-dispatches it as the `<webview>`-shaped `page-title-updated` / `did-navigate` DOM events
// viewer.js already listens for (so tab titles live-update and the nav buttons enable correctly).
//
// AppKit/WKWebView must be touched on the main thread, so the poll body runs via
// run_on_main_thread; only the sleep happens on the worker thread.

#[cfg(target_os = "macos")]
pub fn start_title_watch(app: &tauri::AppHandle) {
  use std::collections::HashMap;
  use std::sync::{Arc, Mutex};
  use std::time::Duration;
  use tauri::Manager;

  let app = app.clone();
  let last: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));

  std::thread::spawn(move || loop {
    let app_main = app.clone();
    let last_main = last.clone();
    let _ = app.run_on_main_thread(move || {
      for (label, webview) in app_main.webviews() {
        if !label.starts_with("wcv") {
          continue;
        }
        let app_cb = app_main.clone();
        let last_cb = last_main.clone();
        let _ = webview.with_webview(move |platform| read_and_emit(&app_cb, &last_cb, &label, platform));
      }
    });
    std::thread::sleep(Duration::from_millis(700));
  });
}

#[cfg(target_os = "macos")]
fn read_and_emit(
  app: &tauri::AppHandle,
  last: &std::sync::Mutex<std::collections::HashMap<String, String>>,
  label: &str,
  platform: tauri::webview::PlatformWebview,
) {
  use objc2_web_kit::WKWebView;
  use tauri::Emitter;

  // SAFETY: runs on the main thread (run_on_main_thread); platform.inner() is the WKWebView backing
  // this webview, valid for the duration of this call. Only reads properties.
  let (title, url, back, fwd) = unsafe {
    let wk: &WKWebView = &*(platform.inner().cast::<WKWebView>());
    let title = wk.title().map(|s| s.to_string()).unwrap_or_default();
    let url = wk
      .URL()
      .and_then(|u| u.absoluteString())
      .map(|s| s.to_string())
      .unwrap_or_default();
    (title, url, wk.canGoBack(), wk.canGoForward())
  };

  let key = format!("{title}\u{1}{url}\u{1}{back}\u{1}{fwd}");
  let changed = {
    let mut map = last.lock().unwrap();
    if map.get(label).map(String::as_str) == Some(key.as_str()) {
      false
    } else {
      map.insert(label.to_string(), key);
      true
    }
  };
  if changed {
    let _ = app.emit(
      "wcv://event",
      serde_json::json!({
        "id": label, "type": "did-navigate",
        "title": title, "url": url, "canGoBack": back, "canGoForward": fwd,
      }),
    );
  }
}

#[cfg(not(target_os = "macos"))]
pub fn start_title_watch(_app: &tauri::AppHandle) {}
