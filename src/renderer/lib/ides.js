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

// ── Runners ─────────────────────────────────────────────────────────────────────────────────
// An IDE with a `runner` is what gives the toolbar a Run button: a destination picker (scheme +
// simulator, like Xcode's own) whose choice is stored on the project (`runScheme` / `runSim`), and
// the command lines Run composes from it. There is no free-text run script — each supported
// toolchain gets its own behaviour rather than a lowest-common-denominator template. Only Xcode has
// a runner today; an IDE without one has no Run.
const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";   // single-quote for the shell

const xcodeRunner = {
  id: 'xcode',
  // Both halves of the destination chosen → Run can go without a script.
  ready: pj => !!(pj?.runScheme && pj?.runSim),
  // The command lines Run types into the build terminal. `target` is the resolved .xcworkspace /
  // .xcodeproj (or the folder, for a package); `settings` is GET /api/xcode/build-settings for this
  // scheme + simulator; `simName` is only for the banner.
  //   1. boot the simulator (a no-op when it's up) and bring Simulator.app forward, so the device is
  //      warming while the build runs — the same overlap Xcode does.
  //   2. build → install → launch as ONE chain: a failing build stops there. `-quiet` keeps
  //      xcodebuild to warnings and errors (its full transcript is unreadable in a terminal).
  //      `--console-pty` blocks with the app's stdout/stderr in the terminal, which is what makes
  //      the toolbar's Stop (⌃C into this PTY) terminate the app, and `--terminate-running-process`
  //      replaces the previous run instead of failing on it.
  script: ({ target, pj, settings, simName }) => {
    const doc = /\.xcworkspace\/?$/.test(target) ? `-workspace ${shq(target)}`
      : /\.xcodeproj\/?$/.test(target) ? `-project ${shq(target)}` : '';
    const cfg = settings?.configuration || 'Debug';
    return [
      // Bring the device's window forward. The simulator UI lives inside the selected Xcode and has
      // moved: Simulator.app (Developer/Applications) through Xcode 26, DeviceHub.app
      // (Contents/Applications) in Xcode 27 — try both by path, then by name, and stay quiet when
      // none is there (the device is booted headless either way; the launch still works).
      `echo ${shq(`▶ ${pj.runScheme} · ${simName || pj.runSim} (${cfg})`)}; xcrun simctl boot ${shq(pj.runSim)} 2>/dev/null; `
        + `{ open "$(xcode-select -p)/Applications/Simulator.app" || open "$(xcode-select -p)/../Applications/DeviceHub.app" || open -a Simulator; } 2>/dev/null`,
      `xcodebuild ${doc} -scheme ${shq(pj.runScheme)} -configuration ${shq(cfg)} -destination ${shq(`id=${pj.runSim}`)} -quiet build`
        + ` && xcrun simctl install ${shq(pj.runSim)} ${shq(settings.appPath)}`
        + ` && xcrun simctl launch --console-pty --terminate-running-process ${shq(pj.runSim)} ${shq(settings.bundleId)}`,
    ];
  },
};

const RUNNERS = { xcode: xcodeRunner };
// The runner for a configured IDE id, or null (no picker, script-only Run).
export const ideRunner = id => RUNNERS[id] || null;
// Does Run have something to do for this project — a runner with its destination set?
export const canRun = pj => !!ideRunner(pj?.ide)?.ready(pj);
