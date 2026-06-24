// Tauri embedded-viewer shim — the drop-in stand-in for the Electron <webview> element.
//
// In the Electron build, viewer.js embeds GitHub/Jira in a real <webview> tag. Tauri's WKWebView
// has no such tag, so in the Tauri build createWebviewEl() returns one of these instead: a
// layout-anchor <div> appended where the webview would sit, backed by a Tauri *child webview*
// (multiwebview) that the host positions over the div's on-screen rect every frame.
//
// It exposes exactly the slice of the <webview> API that viewer.js / find.js touch — crucially
// setAttribute('src', …) and loadURL(…) — so the rest of viewer.js is unchanged. A requestAnimation
// Frame loop keeps the native webview aligned with the div as panes resize / tabs toggle.
//
// MVP scope (see docs/TAURI-PORT.md M6): create-with-URL, follow bounds, show/hide, reload, close.
// In-page navigation is native. Back/forward, stop, and find-in-page need native (objc2) glue and
// are deferred — their methods are present but inert so callers don't throw.
let _wcvSeq = 0;

export function createWcvShim() {
  const id = 'wcv' + (++_wcvSeq);
  const el = document.createElement('div');
  el.className = 'wcv-shim';
  document.getElementById('split-body').appendChild(el);

  const wcv = window.taskhub.wcv;
  let created = false;
  let raf = 0;
  let lastKey = '';
  let canBack = false;
  let canFwd = false;

  // Native nav/title events from the Rust WKWebView poll (viewer.rs), re-dispatched as the
  // <webview>-shaped DOM events viewer.js/find.js already listen for.
  let wasLoading = false;
  const offEvent = wcv.onEvent((e) => {
    if (!e || e.id !== id) return;
    if (typeof e.canGoBack === 'boolean') canBack = e.canGoBack;
    if (typeof e.canGoForward === 'boolean') canFwd = e.canGoForward;
    if (e.url) { el.src = e.url; const ev = new Event('did-navigate'); ev.url = e.url; el.dispatchEvent(ev); }
    if (e.title) { const ev = new Event('page-title-updated'); ev.title = e.title; el.dispatchEvent(ev); }
    // Emit the loading transition BEFORE progress so a start sets the loading flag before the first
    // progress tick, and a stop clears it before any trailing tick.
    if (typeof e.loading === 'boolean' && e.loading !== wasLoading) {
      wasLoading = e.loading;
      el.dispatchEvent(new Event(e.loading ? 'did-start-loading' : 'did-stop-loading'));
    }
    // Progress (WKWebView estimatedProgress) → the Safari-style toolbar bar — but ONLY while loading.
    // estimatedProgress stays at 1.0 after a load, so a later poll tick (e.g. a title change) would
    // otherwise re-fire did-progress(1.0) and re-show the bar; and GitHub's Turbo (pjax) link nav
    // changes URL/progress without ever setting isLoading, which must not show the bar at all.
    if (typeof e.progress === 'number' && wasLoading) { const ev = new Event('did-progress'); ev.progress = e.progress; el.dispatchEvent(ev); }
  });

  // Shown ⇔ displayed and laid out (offsetParent null ⇒ this or an ancestor is display:none).
  const isVisible = () => el.style.display !== 'none' && el.offsetParent !== null;

  function pushBounds() {
    const r = el.getBoundingClientRect();
    const vis = isVisible();
    const key = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), vis].join(',');
    if (key !== lastKey) {
      lastKey = key;
      wcv.bounds(id, { x: r.x, y: r.y, width: r.width, height: r.height }, vis);
    }
  }
  function loop() {
    if (!el.isConnected) { raf = 0; return; }
    pushBounds();
    raf = requestAnimationFrame(loop);
  }
  function startLoop() { if (!raf) raf = requestAnimationFrame(loop); }
  function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  function load(url) {
    if (!url) return;
    el.src = url;                                   // find.js gates on wv.src; expose the current URL
    if (!created) { created = true; wcv.create(id, url); startLoop(); }
    else wcv.navigate(id, url);
    lastKey = '';                                   // force a reposition on the next frame
    // did-start-loading/did-progress/did-stop-loading now come from the viewer.rs poll
    // (WKWebView isLoading + estimatedProgress), so no synthetic stop is needed here.
  }

  // ── <webview>-compatible surface ──────────────────────────────────────────────
  // viewer.js starts the lazy load via setAttribute('src', url); keep that working.
  const origSetAttribute = el.setAttribute.bind(el);
  el.setAttribute = (name, value) => { if (name === 'src') load(value); else origSetAttribute(name, value); };
  el.loadURL = load;                                // home button (viewer.js) calls this directly
  el.reload = () => wcv.reload(id);
  el.stop = () => wcv.nav(id, 'stop');
  // Back/forward state comes from the native poll (viewer.rs) via the event above.
  el.canGoBack = () => canBack;
  el.canGoForward = () => canFwd;
  el.goBack = () => wcv.nav(id, 'back');
  el.goForward = () => wcv.nav(id, 'forward');
  el.findInPage = (text, opts) => wcv.find(id, text, opts && opts.findNext, !opts || opts.forward !== false);
  el.stopFindInPage = () => wcv.stopFind(id);
  // Force an immediate native reposition/hide instead of waiting for the next rAF frame. The rAF
  // loop is throttled when the renderer isn't painting (page occluded / Web Inspector open in a
  // debug build), so a visibility change made then — e.g. navigating from a tab to the Dashboard —
  // wouldn't hide the native webview and it would linger painted over the page. Callers push the
  // change synchronously (paintLeft / hideAllPanes) so show/hide never depends on rAF cadence.
  el.syncBounds = () => pushBounds();

  // Tear down the native webview when the shim leaves the DOM (closeTab / closeLink / disposeLink).
  const origRemove = el.remove.bind(el);
  el.remove = () => { stopLoop(); offEvent(); wcv.destroy(id); origRemove(); };

  return el;
}
