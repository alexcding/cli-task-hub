// Build / run: the play button beside the terminal toolbar's IDE chip.
//
// The command is a PROJECT setting (`runCmd`, project Settings → IDE card) — a shell script run in
// the checkout, with {path} (the folder being worked on) and {target} (the resolved IDE target,
// e.g. the .xcworkspace) substituted. There's no per-branch setting: a worktree differs only by
// which folder the script runs in, which is exactly what {path} carries.
//
// Output goes to a terminal, because that's the only honest surface for build output — ANSI,
// progress, scrollback, ⌃C. NOT the session's own terminal: the agent lives there and is almost
// never at a shell prompt. Each context gets its OWN build PTY, shown in the right pane
// (`paneView:'build'`, a pinned Build chip beside Diff), so the agent stays visible on the left.
//
// The build PTY is `paired` with a `build:<url>` key so it survives a window reload the same way
// session terminals do (they live in the detached PTY daemon) and is re-adopted by that key —
// it is NOT a task, so nothing in the sidebar shows it.
import { ROUTES } from '/shared/routes.mjs';
import { state, projectByWorkspace } from '../stores/store.js';
import { api } from '../services/api.js';
import { createTermView, disposeTerm } from './terminal.js';
import { submitLine } from './cli-launch.js';
import { toast, toastErr } from './toast.js';

const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'"; // single-quote for the shell

// {targetFlag} — the xcodebuild/xcodebuildmcp flag that {target} belongs to. Which one is right
// depends on what the target resolved to IN THIS WORKTREE (`--workspace-path` only accepts a
// .xcworkspace, `--project-path` only an .xcodeproj), and a repo can gain a workspace later, so
// the script shouldn't have to hardcode it. Anything else → --project-path, which is what a bare
// checkout of an Xcode project wants.
const xcFlag = target => /\.xcworkspace\/?$/.test(target) ? '--workspace-path' : '--project-path';

// The build PTY's pair key — stable per context, so a reload re-adopts the same terminal.
const buildKey = tab => `build:${tab.url}`;

// This context's build terminal, or null. Looks past tab.buildTermId so a terminal that survived
// a reload (rehydrated by the PTY daemon, never bound to a tab) is found by its pair key.
export function buildTerm(tab) {
  if (!tab) return null;
  const byId = tab.buildTermId && state.terms.get(tab.buildTermId);
  if (byId) return byId;
  const key = buildKey(tab);
  for (const t of state.terms.values()) if (t.pairKey === key) { tab.buildTermId = t.id; return t; }
  tab.buildTermId = null;
  return null;
}

// The run script for this context's project, or '' when none is configured (the toolbar decides
// whether to show the play button from the project record directly — viewer.js runHalfHtml).
// The project is the one behind the folder chip, like the IDE's: updateFolderChip only stamps
// dataset.workspace for a worktree (the right-click delete needs it), so a session sitting on the
// main checkout is matched by the folder itself.
function runCommandFor() {
  const el = document.getElementById('split-folder');
  const ws = el?.dataset.workspace || el?.dataset.path || '';
  return projectByWorkspace(ws)?.runCmd || '';
}

// Is this context's build still running? The terminal's `busy` flag is NOT usable here — it's
// driven by the agent CLIs' turn hooks, which a build never fires. What actually answers the
// question is whether the PTY has a foreground program, so a run polls `term.foreground` until it
// lands back at the shell prompt and the toolbar button flips stop → play.
const _running = new Set();   // build terminal ids currently running a script
// Contexts whose run is mid-START (resolving {target}, spawning the PTY) — everything before the
// terminal exists and can be marked running. Keyed by tab id and set SYNCHRONOUSLY, so a second
// click can't slip through those awaits and spawn a second terminal / a second run.
const _starting = new Set();
export const isBuilding = tab => { const t = buildTerm(tab); return !!t && _running.has(t.id); };

const POLL_MS = 1200;
// Poll until the PTY is back at its prompt, then clear the running flag. The caller marks the
// terminal running BEFORE it types, so this only ever watches for the end.
function watchBuild(id, onState) {
  const tick = async () => {
    if (!state.terms.has(id)) { _running.delete(id); onState?.(); return; }   // terminal went away
    let atShell = true;
    try { atShell = (await window.taskhub?.term?.foreground(id))?.atShell !== false; } catch {}
    if (atShell) { _running.delete(id); onState?.(); return; }
    setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);
}

// Run the project's script in this context's build terminal, creating and showing it first.
// {target} resolves exactly like the IDE launch does (configured target → probe → the folder), so
// `xcodebuild -workspace {target}` gets the same document the IDE button would open.
export async function runBuild(tab, { setView, onState } = {}) {
  if (!tab || _starting.has(tab.id)) return;   // a second click during the start-up awaits
  if (isBuilding(tab)) { toast('A build is already running'); return; }
  const folder = document.getElementById('split-folder')?.dataset.path || '';
  const cmd = runCommandFor();
  if (!folder || !cmd) return;
  _starting.add(tab.id);
  try {
    let target = folder;
    try {
      const el = document.getElementById('split-ide');
      const q = `path=${encodeURIComponent(folder)}&rel=${encodeURIComponent(el?.dataset.ideRel || '')}&kind=${encodeURIComponent(el?.dataset.ideProbe || '')}`;
      const r = await api(`${ROUTES.LAUNCH_TARGET}?${q}`);
      if (r?.path) target = r.path;
    } catch { /* {target} falls back to the folder */ }

    let t = buildTerm(tab);
    if (!t) {
      try {
        tab.buildTermId = await createTermView(folder, 'Build', { paired: true, pairKey: buildKey(tab) });
        t = state.terms.get(tab.buildTermId);
      } catch (e) { toastErr(`Couldn't start a build terminal: ${e.message}`); return; }
    }
    if (!t) return;
    setView?.('build');                   // show the pane before typing, so the output is watched
    if (_running.has(t.id)) { toast('A build is already running'); return; }
    // Marked running (and the button flipped to stop) BEFORE the first line is typed: submitting a
    // multi-line script takes several awaits, and a click landing inside that window would
    // otherwise pass the guard and interleave a second run into the same shell.
    _running.add(t.id);
    onState?.();
    const script = cmd
      .replaceAll('{targetFlag}', xcFlag(target))
      .replaceAll('{path}', shq(folder))
      .replaceAll('{target}', shq(target));
    try {
      // The script may be several lines; each is submitted in turn, so a failing `set -e` line
      // stops the rest exactly as it would in a shell.
      for (const line of script.split('\n').map(l => l.trim()).filter(Boolean)) await submitLine(t.id, line);
    } catch (e) {
      _running.delete(t.id); onState?.();  // nothing is running — don't strand the stop button
      toastErr(`Couldn't start the build: ${e.message}`);
      return;
    }
    watchBuild(t.id, onState);
  } finally {
    _starting.delete(tab.id);
  }
}

// Stop the running build: ⌃C into its PTY, the same interrupt the user would type.
export function stopBuild(tab) {
  const t = buildTerm(tab);
  if (t && _running.has(t.id)) window.taskhub?.term?.write(t.id, '\x03');
}

// Drop a context's build terminal — its tab is closing / its session is being removed. The PTY
// outlives the window otherwise (it's paired), so this is the only thing that ends it.
export function disposeBuildTerm(tab) {
  const t = buildTerm(tab);
  if (t) { _running.delete(t.id); disposeTerm(t.id); }
  if (tab) tab.buildTermId = null;
}
