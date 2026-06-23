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
  // absolute paths. Position is physical px → divide by DPR for elementFromPoint.
  try {
    window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(function (e) {
      var p = e && e.payload;
      if (!p || p.type !== 'drop' || !p.paths || !p.paths.length) return;
      var dpr = window.devicePixelRatio || 1;
      var el = document.elementFromPoint(p.position.x / dpr, p.position.y / dpr);
      var term = el && el.closest ? el.closest('[data-term-id]') : null;
      if (term && window.__taskhubTermDrop) window.__taskhubTermDrop(term.dataset.termId, p.paths);
    });
  } catch (e) { /* webview drag-drop unavailable */ }

  // ── Native window drag ────────────────────────────────────────────────────────
  // -webkit-app-region:drag (Electron/Chromium) is ignored by WKWebView, so the hiddenInset top
  // band stopped dragging the window. Reimplement it: a left mousedown on a top bar — but not on
  // an interactive control — starts a native window drag (double-click toggles maximize, like a
  // real title bar).
  var NODRAG = 'button,a,input,textarea,select,svg,[role=button],.ctab,.ctab-add,.ctab-input,.split-btn,.ctabs';
  function inDragBar(t) { return t && t.closest && !t.closest(NODRAG) && t.closest('.topbar, .split-bar, .sidebar-logo'); }
  window.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || !inDragBar(e.target)) return;
    try {
      var r = window.__TAURI__.window.getCurrentWindow().startDragging();
      if (r && r.catch) r.catch(function (err) { console.warn('[drag] startDragging rejected', err); });
    } catch (err) { console.warn('[drag] startDragging threw', err); }
  }, true);
  window.addEventListener('dblclick', function (e) {
    if (!inDragBar(e.target)) return;
    try { window.__TAURI__.window.getCurrentWindow().toggleMaximize(); } catch (err) {}
  }, true);

  function popupMenu(items) {
    return new Promise(function (resolve) {
      var menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.style.cssText = 'position:fixed;z-index:99999;min-width:180px;padding:4px;border-radius:8px;' +
        'background:var(--surface,#1e1e1e);border:1px solid var(--border,#3a3a3a);' +
        'box-shadow:0 8px 24px rgba(0,0,0,.35);font:13px -apple-system,system-ui,sans-serif;color:var(--text,#eee);';
      var done = false;
      function cleanup() {
        menu.remove();
        document.removeEventListener('mousedown', onDocDown, true);
        document.removeEventListener('keydown', onKey, true);
      }
      function close(val) { if (done) return; done = true; cleanup(); resolve(val); }
      function onDocDown(e) { if (!menu.contains(e.target)) close(null); }
      function onKey(e) { if (e.key === 'Escape') close(null); }

      items.forEach(function (it) {
        if (it.separator) {
          var sep = document.createElement('div');
          sep.style.cssText = 'height:1px;margin:4px 6px;background:var(--border,#3a3a3a);';
          menu.appendChild(sep);
          return;
        }
        var row = document.createElement('div');
        row.textContent = it.label;
        var disabled = it.enabled === false;
        row.style.cssText = 'padding:5px 10px;border-radius:5px;cursor:default;white-space:nowrap;' + (disabled ? 'opacity:.4;' : '');
        if (!disabled) {
          row.addEventListener('mouseenter', function () { row.style.background = 'var(--surface-hover,#333)'; });
          row.addEventListener('mouseleave', function () { row.style.background = 'transparent'; });
          row.addEventListener('mousedown', function (e) { e.preventDefault(); });
          row.addEventListener('click', function () { close(it.id); });
        }
        menu.appendChild(row);
      });

      document.body.appendChild(menu);
      var x = Math.min(_cursor.x, window.innerWidth - menu.offsetWidth - 6);
      var y = Math.min(_cursor.y, window.innerHeight - menu.offsetHeight - 6);
      menu.style.left = Math.max(4, x) + 'px';
      menu.style.top = Math.max(4, y) + 'px';
      setTimeout(function () {
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('keydown', onKey, true);
      }, 0);
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

    // ── Not yet ported — stubbed so the data UI runs; see docs/TAURI-PORT.md milestones ──
    refreshTray: noop,                                    // M5 — dynamic tray body deferred

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
      function T() { return window.__TAURI__; }
      function lpos(x, y) { return new (T().dpi.LogicalPosition)(x, y); }
      function lsize(w, h) { return new (T().dpi.LogicalSize)(w, h); }

      function create(id, url, rect) {
        if (views[id]) return;
        // Create at the real on-screen size/position and VISIBLE so WKWebView loads at full priority
        // and lays out at the right viewport (a hidden/1x1 webview throttles its initial load). The
        // tab is active when it's first created, so showing it immediately is correct.
        var r = rect && rect.width > 1 ? rect : { x: OFF, y: OFF, width: 1024, height: 768 };
        try {
          var wv = new (T().webview.Webview)(T().window.getCurrentWindow(), id, {
            url: url,
            x: Math.round(r.x), y: Math.round(r.y),
            width: Math.round(r.width), height: Math.round(r.height),
          });
          wv.once('tauri://error', function (e) { console.warn('[wcv] create error', id, e); });
          views[id] = { wv: wv, rect: r };
        } catch (e) { console.warn('[wcv] create failed', e); }
      }
      // Each tab keeps its OWN webview, alive and positioned; switching tabs just hides one and
      // shows another (no off-screen move, no reload) so there's no flash. Position is kept current
      // even while hidden, so show() is instant.
      function bounds(id, rect, visible) {
        var rec = views[id];
        if (!rec) return;
        try {
          if (rect && rect.width > 1 && rect.height > 1) {
            rec.rect = rect;
            rec.wv.setPosition(lpos(Math.round(rect.x), Math.round(rect.y)));
            rec.wv.setSize(lsize(Math.round(rect.width), Math.round(rect.height)));
          }
          if (visible && rect && rect.width > 1 && rect.height > 1) rec.wv.show();
          else rec.wv.hide();
        } catch (e) { /* webview may be mid-teardown */ }
      }
      function destroy(id) {
        var rec = views[id];
        if (!rec) return;
        delete views[id];
        try { rec.wv.close(); } catch (e) {}
      }
      // JS Webview has no navigate(url) — recreate at the same id + last known rect (so it reloads
      // visible at the right size, not throttled). Rarely used (home button).
      function navigate(id, url) { var rect = views[id] && views[id].rect; destroy(id); create(id, url, rect); }
      function reload(id) { try { views[id] && views[id].wv.reload(); } catch (e) {} }

      // Back/forward/stop/find — driven by injecting JS into the child webview (history.back(),
      // window.find()) rather than native objc2. No match-count (window.find doesn't expose one).
      function evalIn(id, js) { if (views[id]) invoke('wcv_eval', { id: id, js: js }); }
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

      return {
        create: create, load: navigate, navigate: navigate, bounds: bounds,
        destroy: destroy, reload: reload,
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
