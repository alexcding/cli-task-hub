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
    refreshTray: noop,                                    // M5 (tray)
    tabMenu: function () { return Promise.resolve(null); },   // M5 (native context menu)
    folderMenu: function () { return Promise.resolve(null); }, // M5
    fetchAvatar: function () { return Promise.resolve(null); }, // (falls back to live avatar URL)
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

      function create(id, url) {
        if (views[id]) return;
        try {
          var wv = new (T().webview.Webview)(T().window.getCurrentWindow(), id, {
            url: url, x: OFF, y: OFF, width: 1, height: 1,
          });
          wv.once('tauri://error', function (e) { console.warn('[wcv] create error', id, e); });
          views[id] = { wv: wv };
        } catch (e) { console.warn('[wcv] create failed', e); }
      }
      function bounds(id, rect, visible) {
        var rec = views[id];
        if (!rec) return;
        try {
          var show = visible && rect && rect.width > 1 && rect.height > 1;
          if (show) {
            rec.wv.setPosition(lpos(Math.round(rect.x), Math.round(rect.y)));
            rec.wv.setSize(lsize(Math.round(rect.width), Math.round(rect.height)));
          } else {
            rec.wv.setPosition(lpos(OFF, OFF));
            rec.wv.setSize(lsize(1, 1));
          }
        } catch (e) { /* webview may be mid-teardown */ }
      }
      function destroy(id) {
        var rec = views[id];
        if (!rec) return;
        delete views[id];
        try { rec.wv.close(); } catch (e) {}
      }
      // JS Webview has no navigate(url) — recreate at the same id; the shim re-pushes bounds next frame.
      function navigate(id, url) { destroy(id); create(id, url); }
      function reload(id) { try { views[id] && views[id].wv.reload(); } catch (e) {} }

      return {
        create: create, load: navigate, navigate: navigate, bounds: bounds,
        destroy: destroy, reload: reload,
        nav: noop, find: noop, stopFind: noop,   // deferred (native glue)
        onEvent: function () { return noop; },
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
