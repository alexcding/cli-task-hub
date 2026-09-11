// Per-project IDE launch presets for the terminal toolbar's folder chip (and the project's
// Settings tab picker). Same shape and contract as GIT_CLIENTS (lib/git-clients.js): each
// preset is a command TEMPLATE whose `{path}` is replaced by the tab's worktree/checkout
// folder, run by the shell (src-tauri/src/commands.rs → open_in_git_client, which is the
// generic "{path} template" launcher — quoted app names included).
//
// This is a PROJECT setting, not an app one: which editor a checkout belongs in is a property
// of the repo (Xcode for the iOS app, VS Code for the web one), so it lives on the project
// record (`ide` / `ideCmd`) — see src/renderer/pages/project.js → Settings.
// `probe: 'xcode'` marks a preset that can't open a plain folder at all. When the project has no
// explicit target configured, the click asks the server to find one (GET /api/launch-target → the
// checkout's .xcworkspace/.xcodeproj/Package.swift). Presets without a `probe` open the folder.
// Either way an explicitly configured target (project Settings → IDE) wins.
// `icon` is the app's own mark under /img (VS Code's and Xcode's lifted from the installed apps,
// the rest from each vendor's site/GitHub org) — same treatment as GIT_CLIENTS, so the toolbar
// button wears the editor you'd recognise in the Dock rather than a generic glyph.
export const IDES = [
  { id: 'vscode',   label: 'VS Code',        cmd: 'open -a "Visual Studio Code" {path}', icon: '/img/vscode.png' },
  { id: 'cursor',   label: 'Cursor',         cmd: 'open -a Cursor {path}',               icon: '/img/cursor.png' },
  { id: 'windsurf', label: 'Windsurf',       cmd: 'open -a Windsurf {path}',             icon: '/img/windsurf.png' },
  { id: 'zed',      label: 'Zed',            cmd: 'open -a Zed {path}',                  icon: '/img/zed.png' },
  { id: 'xcode',    label: 'Xcode',          cmd: 'open -a Xcode {path}',                icon: '/img/xcode.png', probe: 'xcode' },
  { id: 'intellij', label: 'IntelliJ IDEA',  cmd: 'open -a "IntelliJ IDEA" {path}',      icon: '/img/intellij.png' },
  { id: 'webstorm', label: 'WebStorm',       cmd: 'open -a WebStorm {path}',             icon: '/img/webstorm.png' },
  { id: 'android',  label: 'Android Studio', cmd: 'open -a "Android Studio" {path}',     icon: '/img/android.png' },
];

// Brand-icon path for a configured IDE id, or '' when there's none ('custom', or an unknown id) —
// callers fall back to the generic ICON.code glyph.
export const ideIcon = id => IDES.find(i => i.id === id)?.icon || '';

// The server-side probe to fall back on when no target is configured: 'xcode', or '' for an IDE
// that opens a folder happily. 'custom' has none — that template's author decides.
export const ideProbe = id => IDES.find(i => i.id === id)?.probe || '';

// Display label for a configured IDE id — a generic name for 'custom' and for an id no
// longer in the preset list.
export const ideLabel = id => IDES.find(i => i.id === id)?.label || 'IDE';

// The template to run for a chosen IDE. Presets resolve from IDES at use time (only the id is
// persisted, so a preset fix reaches existing projects); 'custom' uses the project's stored
// template. '' when nothing applies — the chip then shows no IDE button.
export const resolveIdeCmd = (id, customCmd) =>
  id === 'custom' ? (customCmd || '') : (IDES.find(i => i.id === id)?.cmd || '');
