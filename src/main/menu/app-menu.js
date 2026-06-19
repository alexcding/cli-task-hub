// macOS application menu. Beyond relabeling the app menu (dev builds say "Electron"
// otherwise), this is where every keyboard shortcut lives: native menu accelerators
// fire even when focus is inside a <webview> or xterm — a renderer keydown handler
// never hears those keys — and the menus double as the shortcuts' documentation.
// Each item dispatches an action name to the renderer (handleShortcut in app.js);
// runInApp opens the window first if it's closed.
const { app, Menu } = require('electron');
const { runInApp, getWin } = require('../windows/window');

const dispatch = action => runInApp(`window.__shortcut && __shortcut(${JSON.stringify(action)})`);
// Most shortcuts act on whatever is already on screen, so they no-op when the window is
// closed rather than forcing it open — otherwise a no-op key (⌘[, ⌘K, ⌘±, …) would pop a
// window, and ⌘W's no-tab fallback would flash one open then shut.
const send = action => () => { if (getWin()) dispatch(action); };
// Navigation shortcuts are worth opening (or focusing) the window for.
const sendOpen = action => () => dispatch(action);

function setAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'Cmd+,', click: sendOpen('nav:settings') },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ]},
    { label: 'File', submenu: [
      { label: 'New Project…', accelerator: 'Cmd+N', click: sendOpen('project:new') },
      { type: 'separator' },
      // ⌘W closes the active tab; the renderer falls back to closing the window
      // when no tab is in view (see handleShortcut 'tab:close').
      { label: 'Close Tab', accelerator: 'Cmd+W', click: send('tab:close') },
      { label: 'Close All Tabs', accelerator: 'Alt+Cmd+W', click: send('tab:closeAll') },
      { label: 'Close Window', accelerator: 'Shift+Cmd+W', role: 'close' },
    ]},
    // Custom Edit menu (vs role:'editMenu') so Find-in-page lives in its conventional home.
    // ⌘F/⌘G fire even with focus inside a <webview>; find.js drives Chromium's native find.
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find…', accelerator: 'Cmd+F', click: send('find:open') },
      { label: 'Find Next', accelerator: 'Cmd+G', click: send('find:next') },
      { label: 'Find Previous', accelerator: 'Shift+Cmd+G', click: send('find:prev') },
    ]},
    { label: 'View', submenu: [
      // Reloads the embedded page when a tab is in view, otherwise the active page's data.
      { label: 'Reload', accelerator: 'Cmd+R', click: send('view:reload') },
      { type: 'separator' },
      { label: 'Toggle Terminal Panel', accelerator: 'Cmd+J', click: send('pane:toggleTerm') },
      { label: 'Switch Terminal / Changes', accelerator: 'Shift+Cmd+D', click: send('pane:toggleView') },
      { label: 'Clear Terminal', accelerator: 'Cmd+K', click: send('term:clear') },
      { type: 'separator' },
      // Font size of the pane in view — terminal or diff (zoomTarget in fonts.js) —
      // persisted via Settings → Appearance.
      { label: 'Bigger Font', accelerator: 'Cmd+Plus', click: send('font:bigger') },
      { label: 'Smaller Font', accelerator: 'Cmd+-', click: send('font:smaller') },
      { label: 'Reset Font Size', accelerator: 'Cmd+0', click: send('font:reset') },
      // ⌘= (the same key, unshifted) — hidden twin of Bigger Font.
      { label: 'Bigger Font', accelerator: 'Cmd+=', click: send('font:bigger'), visible: false, acceleratorWorksWhenHidden: true },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      { label: 'Reload App', accelerator: 'Shift+Cmd+R', role: 'forceReload' },
      { role: 'toggleDevTools' },
    ]},
    { label: 'Go', submenu: [
      { label: 'Dashboard', accelerator: 'Cmd+1', click: sendOpen('nav:dashboard') },
      { label: 'Scrumboard', accelerator: 'Cmd+2', click: sendOpen('nav:scrumboard') },
      { label: 'Activity', accelerator: 'Cmd+3', click: sendOpen('nav:activity') },
      { type: 'separator' },
      { label: 'Back', accelerator: 'Cmd+[', click: send('nav:back') },
      { label: 'Forward', accelerator: 'Cmd+]', click: send('nav:forward') },
      { type: 'separator' },
      { label: 'Next Tab', accelerator: 'Shift+Cmd+]', click: send('tab:next') },
      { label: 'Previous Tab', accelerator: 'Shift+Cmd+[', click: send('tab:prev') },
      // Browser-style Ctrl+Tab cycling — hidden duplicates of the items above
      // (accelerators on hidden items still fire on macOS).
      { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: send('tab:next'), visible: false, acceleratorWorksWhenHidden: true },
      { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: send('tab:prev'), visible: false, acceleratorWorksWhenHidden: true },
    ]},
    { role: 'windowMenu' },
  ]));
}

module.exports = { setAppMenu };
