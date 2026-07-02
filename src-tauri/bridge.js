// TaskHub ⇄ Tauri bridge — the Tauri analog of src/preload/index.js.
//
// Injected into the renderer as a Tauri initialization script (runs before page scripts, like
// the Electron preload), so window.taskhub.* exists by the time the SPA boots. It is only ever
// present inside the Tauri webview — in a plain browser this file isn't loaded at all, so
// window.taskhub stays undefined and the renderer's optional-chaining guards take over.
//
// Methods read window.__TAURI__ lazily (at call time, not eval time) so injection order between
// this script and Tauri's own global-API script can't matter. Each method maps to a Rust command
// in src-tauri/src/commands.rs (or a stub for a not-yet-ported milestone).
(function () {
  var invoke = function (cmd, args) { return window.__TAURI__.core.invoke(cmd, args); };
  var noop = function () {};

  // ── Native-app feel (WKWebView) ───────────────────────────────────────────────
  // WKWebView, like a browser, lets you select arbitrary UI text and pops a page context menu on
  // right-click — both read wrong for a native app. Electron suppressed these from the main process;
  // we do it here (Tauri-only — the shared renderer is untouched). Default-deny, opting back in:
  //   • Text selection: off on the chrome; on for form fields, the Monaco editor, the xterm
  //     terminal, diff code cells (.dc), and anything tagged .selectable.
  //   • Context menu: the native page menu is suppressed everywhere except text fields (so cut/
  //     copy/paste still works); the app draws its own menus via popupMenu below.
  (function () {
    var css =
      'html,body{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}' +
      'input,textarea,select,[contenteditable],[contenteditable] *,' +
      '.monaco-editor,.monaco-editor *,.xterm,.xterm *,.dc,.selectable,.selectable *' +
      '{-webkit-user-select:text;user-select:text;}';
    var inject = function () {
      var s = document.createElement('style');
      s.textContent = css;
      (document.head || document.documentElement).appendChild(s);
    };
    if (document.head || document.documentElement) inject();
    else document.addEventListener('DOMContentLoaded', inject);
    window.addEventListener('contextmenu', function (e) {
      var t = e.target;
      if (t && t.closest && t.closest('input,textarea,[contenteditable]')) return; // native editing menu
      e.preventDefault();
    }, false); // bubble: the app's own oncontextmenu handlers (popupMenu) run first
  })();

  // ── Avatar caching (no flicker) ───────────────────────────────────────────────
  // WKWebView re-fetches + re-decodes GitHub avatar <img>s on every card re-render (Chromium served
  // them from its image cache; WKWebView flickers). Rewrite github.com/<login>.png → the avatar://
  // scheme, served from the Rust avatar cache (avatars.rs) so re-renders are instant. Frozen
  // data-URI srcs (tabs) and already-rewritten srcs don't match, so they're left alone.
  (function () {
    var RE = /^https?:\/\/github\.com\/([^/?#]+)\.png/i;
    function rewrite(img) {
      var s = img.getAttribute('src');
      var m = s && RE.exec(s);
      if (m) img.src = 'avatar://a/' + m[1];
    }
    function scan(node) {
      if (node.tagName === 'IMG') rewrite(node);
      else if (node.querySelectorAll) {
        var list = node.querySelectorAll('img');
        for (var i = 0; i < list.length; i++) rewrite(list[i]);
      }
    }
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'attributes') { if (m.target.tagName === 'IMG') rewrite(m.target); continue; }
        for (var j = 0; j < m.addedNodes.length; j++) {
          if (m.addedNodes[j].nodeType === 1) scan(m.addedNodes[j]);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  })();

  // ── Lightweight DOM context menu (M5) ─────────────────────────────────────────
  // The Electron build drew tab / folder-chip right-click menus natively. We draw them in the page
  // instead — same contract (resolve the chosen action id, or null if dismissed) so viewer.js is
  // unchanged. Themed with the app's CSS tokens. These anchors are renderer-drawn chrome (not over
  // the embedded webview), so the DOM menu shows correctly above them.
  var _cursor = { x: 0, y: 0 };
  window.addEventListener('contextmenu', function (e) { _cursor = { x: e.clientX, y: e.clientY }; }, true);

  // ── Terminal file drop ────────────────────────────────────────────────────────
  // Tauri captures OS file drops at the window level (the DOM drop event gets no files), so resolve
  // the terminal under the drop point (terminal.js tags each with data-term-id) and hand it the
  // absolute paths.
  //
  // Registered once window.__TAURI__.webview exists — this init script can run before Tauri's
  // global-API script (see the header note), so poll briefly rather than call it eagerly.
  (function wireDrop(tries) {
    var wv = window.__TAURI__ && window.__TAURI__.webview;
    if (!wv || !wv.getCurrentWebview) { if (tries > 0) setTimeout(function () { wireDrop(tries - 1); }, 50); return; }
    // The try/catch (not just the promise .catch) is load-bearing: a synchronous throw here — e.g.
    // a partially-initialized __TAURI__ where getCurrentWebview()/onDragDropEvent() blow up — would
    // otherwise escape this top-level IIFE and skip the native window-drag wiring below it.
    try {
      wv.getCurrentWebview().onDragDropEvent(function (e) {
        var p = e && e.payload;
        if (!p || p.type !== 'drop' || !p.paths || !p.paths.length) return;
        // wry delivers this position in LOGICAL points on macOS (despite the PhysicalPosition type),
        // so hit-test at the raw coords. Only on a display where they differ (DPR≠1) do we also try
        // the scaled point, for a hypothetical platform that really reports physical px — guarding it
        // on dpr avoids a spurious second hit-test (at a shifted point) misrouting a near-miss drop.
        var dpr = window.devicePixelRatio || 1;
        var termAt = function (x, y) {
          var el = document.elementFromPoint(x, y);
          return el && el.closest ? el.closest('[data-term-id]') : null;
        };
        var term = termAt(p.position.x, p.position.y)
          || (dpr !== 1 ? termAt(p.position.x / dpr, p.position.y / dpr) : null);
        if (term && window.__taskhubTermDrop) window.__taskhubTermDrop(term.dataset.termId, p.paths);
      }).catch(function () { /* webview drag-drop unavailable */ });
    } catch (e) { /* webview API not ready — leave drops unwired */ }
  })(40); // ~2s of 50ms retries

  // ── Native window drag ────────────────────────────────────────────────────────
  // -webkit-app-region:drag (Electron/Chromium) is ignored by WKWebView, so the hiddenInset top
  // band stopped dragging the window. Reimplement it: a left mousedown on a top bar — but not on
  // an interactive control — starts a native window drag (double-click toggles maximize, like a
  // real title bar).
  // NB: the .ctabs CONTAINER is intentionally NOT in NODRAG — only the individual .ctab tabs (and
  // the +/rename controls) are. That makes the empty toolbar area around the tabs drag the window,
  // while clicking a tab still selects/reorders it. Listing .ctabs here would kill dragging across
  // the whole tab-bar strip.
  var NODRAG = 'button,a,input,textarea,select,svg,[role=button],.ctab,.ctab-add,.ctab-input,.split-btn';
  function inDragBar(t) {
    if (!t || !t.closest || !t.closest('.topbar, .split-bar, .sidebar-logo')) return false;
    // The read-only default content pill (.ctab.default — the PR/Jira page tab) drags/zooms like the
    // bar itself: it can't be closed, reordered, or renamed, and it fills the middle of the chrome
    // bar, so leaving it in NODRAG made most of that bar dead to double-click. Other tabs stay excluded.
    if (t.closest('.ctab.default')) return true;
    return !t.closest(NODRAG);
  }
  // Arm a potential window-drag on press, but do NOT start it yet. Calling startDragging() on a
  // stationary mousedown enters the OS drag-tracking loop, which swallows the rest of the click
  // sequence — so the second click of a double-click never arrives and dblclick-to-zoom can never
  // fire. Instead we only startDragging once the pointer actually MOVES (mousemove below); a
  // stationary single/double click then reaches the dblclick handler normally.
  var dragArmed = false, downX = 0, downY = 0;
  window.addEventListener('mousedown', function (e) {
    dragArmed = e.button === 0 && !!inDragBar(e.target);
    downX = e.screenX; downY = e.screenY;
  }, true);
  window.addEventListener('mousemove', function (e) {
    if (!dragArmed) return;
    // Only begin the native drag once the pointer has actually moved a few px. Starting it on the
    // first pixel meant the tiny hand-jitter between the two clicks of a double-click fired this,
    // opened the OS drag loop, and swallowed the dblclick — so double-click-to-zoom only worked if
    // you held perfectly still. The threshold leaves a stationary-ish double-click for the dblclick
    // handler while a real drag (movement past the threshold) still starts immediately.
    if (Math.abs(e.screenX - downX) < 4 && Math.abs(e.screenY - downY) < 4) return;
    dragArmed = false;
    try {
      var r = window.__TAURI__.window.getCurrentWindow().startDragging();
      if (r && r.catch) r.catch(function (err) { console.warn('[drag] startDragging rejected', err); });
    } catch (err) { console.warn('[drag] startDragging threw', err); }
  }, true);
  window.addEventListener('mouseup', function () { dragArmed = false; }, true);
  // Double-click the top band (title area, empty toolbar, tab strip) zooms/restores the window, like
  // a native title bar — but WE clock the animation here with requestAnimationFrame instead of using
  // the native zoom. Native zoom animates the frame on AppKit's clock, which the WKWebView can't
  // relayout fast enough to track (the window outruns the view). By stepping the frame ourselves one
  // rAF at a time (zoom_begin sets up the tween; zoom_apply tweens to eased t), the view lays out for
  // each step before we ask for the next — they stay in lockstep, exactly like a drag-resize.
  var zooming = false;
  function animateZoom() {
    if (zooming) return;
    zooming = true;
    Promise.resolve(invoke('zoom_begin')).then(function () {
      var start = performance.now(), dur = 240; // ~native zoom duration
      (function frame(now) {
        var t = Math.min(1, (now - start) / dur);
        var eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
        invoke('zoom_apply', { t: t >= 1 ? 1 : eased });
        if (t < 1) requestAnimationFrame(frame);
        else zooming = false;
      })(start);
    }).catch(function (err) { console.warn('[zoom] failed', err); zooming = false; });
  }
  window.addEventListener('dblclick', function (e) {
    if (!inDragBar(e.target)) return;
    animateZoom();
  }, true);

  // Native macOS context menu (muda via window.__TAURI__.menu). Same contract as the old DOM menu —
  // resolves the chosen item id, or null if dismissed — so tabMenu/folderMenu are unchanged. On
  // macOS popup() is modal (returns after the menu closes); item clicks fire their `action`. We
  // resolve from the action when one fires, else null shortly after popup() returns (dismissed).
  function popupMenu(items) {
    return new Promise(function (resolve) {
      var settled = false;
      function pick(v) { if (!settled) { settled = true; resolve(v); } }
      (async function () {
        try {
          var M = window.__TAURI__.menu;
          var built = [];
          for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.separator) {
              built.push(await M.PredefinedMenuItem.new({ item: 'Separator' }));
              continue;
            }
            built.push(await M.MenuItem.new({
              id: String(it.id),
              text: it.label,
              enabled: it.enabled !== false,
              action: (function (id) { return function () { pick(id); }; })(it.id),
            }));
          }
          var menu = await M.Menu.new({ items: built });
          await menu.popup();
          // Menu closed: give a click's action event a moment to arrive; if none, it was dismissed.
          setTimeout(function () { pick(null); }, 150);
        } catch (e) {
          console.warn('[menu] native popup failed', e);
          pick(null);
        }
      })();
    });
  }

  window.taskhub = {
    // Sync platform string in Electron's vocabulary (this is the macOS build).
    platform: 'darwin',

    setTheme: function (value) { return invoke('set_theme', { value: value }); },
    chooseFolder: function () { return invoke('choose_folder'); },
    previewSound: function (p) { return invoke('preview_sound', { path: p == null ? null : p }); },
    openPath: function (p) { return invoke('open_path', { path: p }); },
    openExternal: function (url) { return invoke('open_external', { url: url }); },
    openInGitClient: function (cmd, path) { return invoke('open_in_git_client', { cmd: cmd, path: path }); },
    closeWindow: function () { return invoke('close_window'); },

    // Rebuild the tray now (refresh_tray → tray::refresh) — the renderer fires this after the
    // usage-agent toggle and review-sound / activity-notify settings, none of which move the PR
    // snapshot, so the tray's own SSE-sync refresh wouldn't otherwise pick them up.
    refreshTray: function () { return invoke('refresh_tray'); },

    // Launch at login — read/toggle the macOS login-item (a LaunchAgent the host registers). The
    // OS owns this state, so Settings reads it live (get() → bool) and writes straight back
    // (set(on) → the resulting bool) with no backend round-trip. Desktop-only: in a plain browser
    // window.taskhub is undefined and the Settings card stays hidden.
    autostart: {
      get: function () { return invoke('autostart_get'); },
      set: function (enabled) { return invoke('autostart_set', { enabled: !!enabled }); },
    },

    // Tab right-click: open/copy handled here (matches Electron, where main did them); only
    // 'close' (or null) is returned for the renderer to act on.
    tabMenu: function (url) {
      var u = String(url || '');
      var isHttp = /^https?:\/\//i.test(u);
      return popupMenu([
        { id: 'open', label: 'Open Link in Browser', enabled: isHttp },
        { id: 'copy', label: 'Copy Link', enabled: !!u },
        { separator: true },
        { id: 'close', label: 'Close Tab' },
      ]).then(function (action) {
        if (action === 'open') { invoke('open_external', { url: u }); return null; }
        if (action === 'copy') { try { navigator.clipboard.writeText(u); } catch (e) {} return null; }
        return action; // 'close' | null
      });
    },
    // Folder-chip right-click: the renderer acts on 'client' | 'finder' | 'delete' | null.
    folderMenu: function (ctx) {
      ctx = ctx || {};
      var items = [];
      if (ctx.hasClient) items.push({ id: 'client', label: 'Open in ' + (ctx.clientLabel || 'git client') });
      items.push({ id: 'finder', label: 'Reveal in Finder' });
      if (ctx.isWorktree) { items.push({ separator: true }); items.push({ id: 'delete', label: 'Delete Worktree…' }); }
      return popupMenu(items);
    },
    fetchAvatar: function (login) { return invoke('fetch_avatar', { login: login }); },
    getUsage: function () { return invoke('get_usage'); },     // M7 (sysinfo, host process)
    pathForFile: function () { return ''; },              // M4 follow-up (Tauri drag-drop carries paths)

    // M6 — embedded GitHub/Jira viewer via Tauri multiwebview (unstable feature). One child
    // WKWebview per PR/Jira tab, created lazily off-screen and positioned over the renderer's
    // shim div (components/wcv-shim.js drives create/bounds/destroy). In-page navigation is
    // handled natively by WKWebView; back/forward, find-in-page, and nav/title/favicon events
    // need native (objc2) glue and are deferred — see docs/TAURI-PORT.md M6.
    wcv: (function () {
      var views = {};            // id -> { wv }
      var OFF = -32000;          // park hidden views far off-screen (no paint, no input)
      // Embedded WKWebView's default UA omits the "Version/<n> Safari/<n>" tokens, so sites that
      // sniff the UA (Atlassian/Confluence, Jira) serve a "Browser not supported" page. Present a
      // full desktop Safari UA so we get the same content a real Safari would. GitHub is fine either
      // way; this only helps the stricter sniffers.
      var SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15';
      // Persistent WKWebsiteDataStore for the embedded PR/Jira pages. On macOS a webview's cookies +
      // localStorage live in a store keyed by this 16-byte identifier (the Apple replacement for
      // dataDirectory, which is a no-op here). Without it each child gets a fresh store, so a GitHub
      // login is forgotten on the next boot. A fixed UUID shared by every child means: log in once,
      // every PR tab is authenticated, and the session survives restarts. (macOS 14+ / supported.)
      var DATA_STORE = [122, 63, 28, 32, 155, 78, 77, 138, 191, 97, 46, 92, 138, 13, 79, 147];
      function T() { return window.__TAURI__; }
      function lpos(x, y) { return new (T().dpi.LogicalPosition)(x, y); }
      function lsize(w, h) { return new (T().dpi.LogicalSize)(w, h); }

      function create(id, url) {
        if (views[id]) return;
        // Create OFF-SCREEN at 1x1 (the original fast path); the shim's bounds() moves it on-screen.
        try {
          var wv = new (T().webview.Webview)(T().window.getCurrentWindow(), id, {
            url: url, x: OFF, y: OFF, width: 1, height: 1, userAgent: SAFARI_UA,
            dataStoreIdentifier: DATA_STORE,
          });
          wv.once('tauri://error', function (e) { console.warn('[wcv] create error', id, e); });
          views[id] = { wv: wv, rect: null };
          // Injected once the webview is created; persists across the embedded page's (SPA/Turbo)
          // navigations (the document survives, so the listener + style stay). Two things:
          //  1. Record the hovered link/image on right-click so the native "Open Link in New Tab"
          //     menu item (webview_menu.rs) can read it back via evaluateJavaScript.
          //  2. Hide GitHub's own Turbo (pjax) progress bar — its blue top-of-page loading line is
          //     redundant with our in-tab progress bar and reads as a stray loader under the tabs.
          //     The <style> goes on documentElement (outside <head>/<body>) so Turbo's head/body
          //     swap doesn't strip it.
          wv.once('tauri://created', function () {
            // Replay the last-requested geometry. Webview creation is async, and the shim's rAF
            // loop pushes bounds() on the very next frame — those setPosition/setSize/show invokes
            // can land before the webview registers and are silently dropped (rejected promises).
            // The shim only re-sends when the rect CHANGES, so a lost first push left the tab
            // permanently blank (webview parked off-screen at 1x1) until any relayout — e.g. a
            // panel toggle — happened to re-push. Re-applying here closes the race.
            var rec = views[id];
            if (rec && rec.last) { rec.hidden = undefined; bounds(id, rec.last.rect, rec.last.visible); }
            setTimeout(function () {
              invoke('wcv_eval', { id: id, js: "if(!window.__thInstalled){window.__thInstalled=1;document.addEventListener('contextmenu',function(e){var t=e.target;var a=t&&t.closest&&t.closest('a');window.__thLink=(a&&a.href)||'';window.__thImg=(t&&t.tagName==='IMG'&&t.src)||'';},true);var s=document.createElement('style');s.textContent='.turbo-progress-bar{display:none!important}';document.documentElement.appendChild(s);}" });
            }, 300);
          });
        } catch (e) { console.warn('[wcv] create failed', e); }
      }
      // Each tab keeps its OWN webview. Visibility uses the native Webview.hide()/show() — the
      // standard Tauri way — instead of parking off-screen: a hidden webview is fully removed from
      // the window, so it can NEVER linger painted over another page (the off-screen park it
      // replaced could, e.g. over the Dashboard after navigating away). While shown, the rAF loop
      // (wcv-shim.js) keeps its rect synced to the anchor div. Trade-off vs off-screen parking: a
      // hidden tab's WKWebView throttles, so a background tab that was mid-load resumes (rather than
      // keeps loading) when shown again — acceptable, and the common case is a fully-loaded page.
      // bounds() is only called when the rect/visibility actually changes (the shim diffs a key),
      // so the hide()/show() calls aren't per-frame; rec.hidden de-dupes redundant ones.
      function bounds(id, rect, visible) {
        var rec = views[id];
        if (!rec) return;
        rec.last = { rect: rect, visible: visible }; // remembered for the created-event replay
        try {
          if (visible && rect && rect.width > 1 && rect.height > 1) {
            rec.rect = rect;
            rec.wv.setPosition(lpos(Math.round(rect.x), Math.round(rect.y)));
            rec.wv.setSize(lsize(Math.round(rect.width), Math.round(rect.height)));
            if (rec.hidden !== false) { rec.hidden = false; rec.wv.show(); }  // position FIRST, then show (no flash)
          } else if (rec.hidden !== true) {
            rec.hidden = true; rec.wv.hide();
          }
        } catch (e) { /* webview may be mid-teardown */ }
      }
      function destroy(id) {
        var rec = views[id];
        if (!rec) return;
        // Kill the WebContent process BEFORE closing: Tauri's webview close() on macOS never
        // deallocates the WKWebView (verified: close() resolves + the label unregisters, but the
        // ~200-300MB com.apple.WebKit.WebContent process survives indefinitely — one leaked per
        // closed tab). wcv_kill_content (-[WKWebView _killWebContentProcess]) terminates it
        // directly, which also stops any playing media — replacing the old pause+about:blank
        // eval, which emptied the page but couldn't free the process. Then close on the next
        // tick so the kill lands while the webview still exists.
        try {
          invoke('wcv_kill_content', { id: id });
        } catch (e) {}
        delete views[id];
        setTimeout(function () { try { rec.wv.close(); } catch (e) {} }, 80);
      }
      // Re-navigate an existing webview IN PLACE via location.assign() (a real top-level navigation),
      // falling back to create() only when it doesn't exist yet. The old destroy()+create() raced:
      // destroy() defers wv.close() ~80ms, so create() ran against a still-live label → Tauri's
      // duplicate-label error → blank/stuck page (the Home button hit this every time).
      function navigate(id, url) {
        if (!url) return;
        if (views[id]) evalIn(id, 'location.assign(' + JSON.stringify(url) + ')');
        else create(id, url);
      }

      // Back/forward/stop/find/reload — driven by injecting JS into the child webview (history.back(),
      // window.find(), location.reload()) rather than native objc2. The JS Webview has no reload()/
      // navigate() of its own. No match-count (window.find doesn't expose one).
      function evalIn(id, js) { if (views[id]) invoke('wcv_eval', { id: id, js: js }); }
      function reload(id) { evalIn(id, 'location.reload()'); }
      function nav(id, action, url) {
        if (action === 'back') evalIn(id, 'history.back()');
        else if (action === 'forward') evalIn(id, 'history.forward()');
        else if (action === 'stop') evalIn(id, 'window.stop()');
        else if (action === 'home' && url) evalIn(id, 'location.assign(' + JSON.stringify(url) + ')');
      }
      function find(id, text, findNext, forward) {
        if (!text) return;
        var js = (findNext ? '' : '(window.getSelection&&window.getSelection().removeAllRanges());') +
          'window.find(' + JSON.stringify(text) + ',false,' + (forward ? 'false' : 'true') + ',true)';
        evalIn(id, js);
      }
      function stopFind(id) { evalIn(id, '(window.getSelection&&window.getSelection().removeAllRanges())'); }

      // Run cb(webview) for each of the window's wcv* child webviews. The label scheme lives here in
      // one place (hideAll and the on-load sweep both go through it). Async (getAllWebviews) + guarded.
      function forEachWcv(cb) {
        try {
          T().webview.getAllWebviews().then(function (list) {
            (list || []).forEach(function (w) {
              if (w && typeof w.label === 'string' && w.label.indexOf('wcv') === 0) { try { cb(w); } catch (e) {} }
            });
          }).catch(function () {});
        } catch (e) {}
      }

      // Force EVERY embedded webview out of view — called when the renderer navigates to a non-web
      // page (Dashboard, Scrumboard, Settings, a project, …), where no PR/Jira webview should show.
      // Belt-and-suspenders over per-tab hide (hideAllPanes): it also reaches webviews this session
      // doesn't track. Tracked ones are hidden (kept alive for a fast re-show); untracked ones are
      // closed (they should not exist once the unload/on-load teardown below is doing its job).
      function hideAll() {
        forEachWcv(function (w) {
          var rec = views[w.label];
          if (rec) { rec.hidden = true; rec.wv.hide(); }
          else { try { invoke('wcv_kill_content', { id: w.label }); } catch (e) {} w.close(); }
        });
      }

      // Root cause of orphaned webviews: the window outlives the renderer (quit only from tray; dev
      // reloads), but child webviews are attached to the WINDOW, not this document — so a reload
      // leaves the prior session's webviews painted over the next renderer's Dashboard, and their
      // labels (wcv1, wcv2…) collide with the fresh ids (Tauri rejects a duplicate → blank/stuck
      // tab, and selecting one can crash). Tear down THIS session's tracked webviews on unload so a
      // reload starts clean. pagehide fires on reload/navigation/close (more reliable than unload).
      window.addEventListener('pagehide', function () {
        for (var id in views) {
          try { invoke('wcv_kill_content', { id: id }); } catch (e) {}
          try { views[id].wv.close(); } catch (e) {}
        }
      });

      // Backstop for a hard crash where pagehide never fired: at load, close any wcv* still on the
      // window from a previous session. The renderer creates its own lazily on tab activation, so at
      // load every existing wcv* is stale. ('main' and other non-wcv labels are left untouched.)
      forEachWcv(function (w) { try { invoke('wcv_kill_content', { id: w.label }); } catch (e) {} w.close(); });

      return {
        create: create, load: navigate, navigate: navigate, bounds: bounds,
        destroy: destroy, reload: reload, hideAll: hideAll,
        nav: nav, find: find, stopFind: stopFind,
        // Page nav/title events come from the Rust WKWebView poll (viewer.rs) as `wcv://event`.
        onEvent: function (cb) {
          var off = noop;
          window.__TAURI__.event.listen('wcv://event', function (e) { cb(e.payload); })
            .then(function (u) { off = u; });
          return function () { off(); };
        },
      };
    })(),

    // M4 — terminals. Each PTY lives in the Rust host (terminals.rs); output arrives as the global
    // `term://data` / `term://exit` events tagged with the terminal id, which we fan out to the
    // per-id callbacks the renderer registered (mirrors the Electron preload).
    term: (function () {
      var dataCbs = {};   // id -> [cb(chunk, seq)]
      var exitCbs = {};   // id -> [cb({exitCode, signal})]
      var wired = false;
      function fan(map, id, payload) { (map[id] || []).slice().forEach(function (cb) { try { payload(cb); } catch (e) {} }); }
      function wire() {
        if (wired) return; wired = true;
        var ev = window.__TAURI__.event;
        ev.listen('term://data', function (e) { var p = e.payload; fan(dataCbs, p.id, function (cb) { cb(p.chunk, p.seq); }); });
        ev.listen('term://exit', function (e) { var p = e.payload; fan(exitCbs, p.id, function (cb) { cb({ exitCode: p.exitCode, signal: p.signal }); }); });
      }
      function sub(map, id, cb) {
        wire();
        (map[id] = map[id] || []).push(cb);
        return function () { map[id] = (map[id] || []).filter(function (f) { return f !== cb; }); };
      }
      return {
        create: function (opts) { wire(); return invoke('term_create', { opts: opts || {} }); },
        write: function (id, data) { invoke('term_write', { id: id, data: data }); },
        resize: function (id, cols, rows) { invoke('term_resize', { id: id, cols: cols, rows: rows }); },
        kill: function (id) { return invoke('term_kill', { id: id }); },
        list: function () { return invoke('term_list'); },
        attach: function (id) { return invoke('term_attach', { id: id }); },
        foreground: function (id) { return invoke('term_foreground', { id: id }); },
        onData: function (id, cb) { return sub(dataCbs, id, cb); },
        onExit: function (id, cb) { return sub(exitCbs, id, cb); },
      };
    })(),
  };
})();
