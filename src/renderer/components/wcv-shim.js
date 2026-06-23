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
    if (!created) { created = true; wcv.create(id, url); startLoop(); }
    else wcv.navigate(id, url);
    lastKey = '';                                   // force a reposition on the next frame
    // No native did-stop-loading yet, so synthesize one shortly after load so viewer.js clears
    // its per-tab loading state (the spinner sits behind the native webview regardless).
    setTimeout(() => { try { el.dispatchEvent(new Event('did-stop-loading')); } catch {} }, 500);
  }

  // ── <webview>-compatible surface ──────────────────────────────────────────────
  // viewer.js starts the lazy load via setAttribute('src', url); keep that working.
  const origSetAttribute = el.setAttribute.bind(el);
  el.setAttribute = (name, value) => { if (name === 'src') load(value); else origSetAttribute(name, value); };
  el.loadURL = load;                                // home button (viewer.js) calls this directly
  el.reload = () => wcv.reload(id);
  el.stop = () => {};                               // deferred
  el.canGoBack = () => false;                       // deferred (needs native nav history)
  el.canGoForward = () => false;
  el.goBack = () => {};
  el.goForward = () => {};
  el.findInPage = () => {};                         // deferred
  el.stopFindInPage = () => {};

  // Tear down the native webview when the shim leaves the DOM (closeTab / closeLink / disposeLink).
  const origRemove = el.remove.bind(el);
  el.remove = () => { stopLoop(); wcv.destroy(id); origRemove(); };

  return el;
}
