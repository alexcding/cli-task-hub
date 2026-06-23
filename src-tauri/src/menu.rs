// macOS application menu — the Tauri port of src/main/menu/app-menu.js. Its real job is the
// keyboard accelerators: a native menu accelerator fires even when focus is inside an embedded
// child webview or a terminal (a renderer keydown never hears those keys). Each custom item
// dispatches an action to the renderer's window.__shortcut (handleShortcut in app.js); the
// predefined items (copy/paste/quit/…) use their native roles.
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, Wry};

// Run a shortcut action in the renderer (opening/focusing the window for navigation actions).
pub fn dispatch(app: &AppHandle, action: &str) {
  if action.starts_with("nav:") || action == "project:new" {
    crate::show_main(app);
  }
  if let Some(w) = app.get_webview("main") {
    let js = format!("window.__shortcut&&window.__shortcut({})", serde_json::to_string(action).unwrap_or_else(|_| "\"\"".into()));
    let _ = w.eval(&js);
  }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
  // id = "sc:<action>"; the action is dispatched to the renderer on click. A bad accelerator
  // string must NOT abort the whole menu (an unparseable accel would otherwise drop the entire
  // app menu) — fall back to the item without its accelerator and log it.
  let mi = |id: &str, label: &str, accel: &str| -> tauri::Result<MenuItem<Wry>> {
    MenuItemBuilder::with_id(format!("sc:{id}"), label).accelerator(accel).build(app).or_else(|e| {
      log::warn!("[menu] unsupported accelerator '{accel}' for '{label}': {e}");
      MenuItemBuilder::with_id(format!("sc:{id}"), label).build(app)
    })
  };

  let app_menu = SubmenuBuilder::new(app, "TaskHub")
    .about(Some(AboutMetadata::default()))
    .separator()
    .item(&mi("nav:settings", "Settings…", "Cmd+Comma")?)
    .separator()
    .services()
    .separator()
    .hide()
    .hide_others()
    .show_all()
    .separator()
    .quit()
    .build()?;

  let file = SubmenuBuilder::new(app, "File")
    .item(&mi("project:new", "New Project…", "Cmd+N")?)
    .separator()
    .item(&mi("tab:close", "Close Tab", "Cmd+W")?)
    .item(&mi("tab:closeAll", "Close All Tabs", "Alt+Cmd+W")?)
    .close_window()
    .build()?;

  // Custom Edit menu (vs the default role) so Find lives in its conventional home; ⌘F/⌘G fire
  // even with focus inside a webview (find.js drives the embedded page's window.find).
  let edit = SubmenuBuilder::new(app, "Edit")
    .undo()
    .redo()
    .separator()
    .cut()
    .copy()
    .paste()
    .select_all()
    .separator()
    .item(&mi("find:open", "Find…", "Cmd+F")?)
    .item(&mi("find:next", "Find Next", "Cmd+G")?)
    .item(&mi("find:prev", "Find Previous", "Shift+Cmd+G")?)
    .build()?;

  let view = SubmenuBuilder::new(app, "View")
    .item(&mi("view:reload", "Reload", "Cmd+R")?)
    .separator()
    .item(&mi("pane:toggleTerm", "Toggle Terminal Panel", "Cmd+J")?)
    .item(&mi("pane:toggleView", "Switch Terminal / Changes", "Shift+Cmd+D")?)
    .separator()
    .item(&mi("font:bigger", "Bigger Font", "Cmd+=")?)
    .item(&mi("font:smaller", "Smaller Font", "Cmd+Minus")?)
    .item(&mi("font:reset", "Reset Font Size", "Cmd+0")?)
    .separator()
    .fullscreen()
    .build()?;

  let go = SubmenuBuilder::new(app, "Go")
    .item(&mi("nav:dashboard", "Dashboard", "Cmd+1")?)
    .item(&mi("nav:scrumboard", "Scrumboard", "Cmd+2")?)
    .item(&mi("nav:tasks", "Tasks", "Cmd+3")?)
    .item(&mi("nav:activity", "Events", "Cmd+4")?)
    .separator()
    .item(&mi("nav:back", "Back", "Cmd+BracketLeft")?)
    .item(&mi("nav:forward", "Forward", "Cmd+BracketRight")?)
    .separator()
    .item(&mi("tab:next", "Next Tab", "Shift+Cmd+BracketRight")?)
    .item(&mi("tab:prev", "Previous Tab", "Shift+Cmd+BracketLeft")?)
    .build()?;

  let window = SubmenuBuilder::new(app, "Window").minimize().separator().fullscreen().build()?;

  let menu = MenuBuilder::new(app)
    .items(&[&app_menu, &file, &edit, &view, &go, &window])
    .build()?;
  app.set_menu(menu)?;
  Ok(())
}
