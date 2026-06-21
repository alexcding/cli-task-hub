// Workflow runner: the "automation" button in the terminal toolbar runs a project's saved
// workflow on the active PR/Jira tab — ensure the worktree, open the split terminal in it, launch
// the chosen CLI, then type each step's command, advancing on the CLI's Stop hook (turn-done).
// REQUIRES the chosen CLI's hook installed (Settings → CLIs): the Stop hook is the only reliable
// "this step finished" signal for long agentic turns, so without it we don't run. Config lives in
// the Workflows tab (pages/project.js); the turn-done clock lives in terminal.js (whenTurnDone).
import { ROUTES } from '/shared/routes.mjs';
import { state, activeTab, projectByRepo, projectByPrUrl, projectByJiraKey, jiraByKey } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { jiraKeyFromUrl, canSplitTerminal, delay } from '../lib/util.js';
import { resolvePlaceholders, wfBranchName } from '../lib/workflow.mjs';
import { resolveTabFolder, ensurePrTerminal, applyPrLayout } from './split.js';
import { whenTurnDone, setTermBusy } from './terminal.js';
import { analyzeTerminal } from '../services/analyzer.js';
import { openMenu } from './menu.js';
import { toast, toastErr } from './toast.js';

const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'"; // single-quote a path for the shell
const LAUNCH_SETTLE_MS = 2000; // a CLI launch isn't a "turn" — give the TUI a moment before typing
const CLI_LABEL = { claude: 'Claude', codex: 'Codex' };

function projectForTab(tab) {
  if (!tab) return null;
  if (tab.kind === 'jira') return projectByJiraKey(tab.jiraKey || jiraKeyFromUrl(tab.url));
  return projectByRepo(tab.repo) || projectByPrUrl(tab.url);
}
const workflowsForTab = tab => {
  const p = projectForTab(tab);
  return p && Array.isArray(p.workflows) ? p.workflows : [];
};

// In-flight runs, keyed by tab id → { ac, name, cli, step, total, stepTitle }. The toolbar button
// reflects the ACTIVE tab: a play triangle when idle, a spinner+stop when that tab's workflow is
// running. The Tasks page reads `step`/`total` live via workflowRunState (mutated as steps advance).
const _runs = new Map();
const isRunning = tabId => _runs.has(tabId);

// Live run state for the Tasks page (pages/tasks.js): which workflow is running on this tab and
// how far along. null when no workflow is in flight (a bare/manual session). Returns a snapshot
// copy so callers can't mutate the live record.
export const workflowRunState = tabId => {
  const r = _runs.get(tabId);
  return r ? { name: r.name, cli: r.cli, step: r.step, total: r.total, stepTitle: r.stepTitle } : null;
};

// Nudge the Tasks page to re-render when a run's step advances (busy↔idle edges already refresh it
// via the SSE turn hooks; this covers the between-turns step bump). No-op unless that page is open.
function notifyTasksUpdated() {
  if (document.querySelector('.page.active')?.id === 'page-tasks') window.loadTasks?.();
}

// Reflect the active tab: hidden unless its project has a workflow (or a run is in flight);
// running shows the stop/spinner state.
export function refreshWorkflowBtn() {
  const btn = document.getElementById('term-workflow');
  if (!btn) return;
  const tab = state.activeTermId ? null : activeTab();
  const running = !!(tab && isRunning(tab.id));
  const wfs = tab && canSplitTerminal(tab) ? workflowsForTab(tab) : [];
  btn.hidden = wfs.length === 0 && !running;
  btn.classList.toggle('running', running);
  btn.title = running ? 'Stop workflow' : (wfs.length === 1 ? `Run workflow: ${wfs[0].name}` : 'Run workflow…');
}

// One button, two jobs: run when idle, stop when running. For multiple workflows, use the shared
// context menu (menu.js) so it honors the app-wide Escape-to-close and single-open-menu behavior.
export function toggleWorkflowRun(e) {
  const tab = state.activeTermId ? null : activeTab();
  if (!tab) return;
  if (isRunning(tab.id)) { _runs.get(tab.id).ac.abort(); return; }
  const wfs = workflowsForTab(tab);
  if (!wfs.length) { toastErr('No workflow configured for this project'); return; }
  if (wfs.length === 1) { runWorkflow(tab, wfs[0]); return; }
  if (e) openMenu(e, wfs.map(wf => ({ label: wf.name || 'Untitled workflow', onClick: () => runWorkflow(tab, wf) })));
}

// Type a line then press Enter. Interactive TUIs (claude/codex) read raw input and treat CR (\r),
// not LF (\n), as Enter — and sending text+Enter in one write can register as a paste (inserts a
// newline instead of submitting). So write the text, pause, then send \r as a separate keypress.
async function submitLine(termId, line) {
  window.taskhub?.term?.write(termId, line);
  await delay(60);
  window.taskhub?.term?.write(termId, '\r');
}

// After a step's turn finishes, hand the agent's last message + step context to the shared analyzer
// (one headless CLI call — settle/read/record all live in the service) and return its decision
// (proceed / retry / stop). Any skip/failure → 'proceed' (the prior behavior: keep advancing). The
// model is advisory and never generates commands.
async function decideAfterStep(wf, steps, i, termId) {
  const stepName = steps[i].title || steps[i].command;
  const next = i + 1 < steps.length ? `Next step: "${steps[i + 1].title || steps[i + 1].command}".` : 'This was the last step.';
  const context = `Automated workflow "${wf.name}". Finished step ${i + 1}/${steps.length}: "${stepName}". ${next}`;
  const r = await analyzeTerminal(termId, { context });
  notifyTasksUpdated();
  if (r?.decision) toast(`${wf.name}: ${r.decision}${r.reason ? ` — ${r.reason}` : ''}`);
  return r?.decision || 'proceed';
}

export async function runWorkflow(tab, wf) {
  const p = projectForTab(tab);
  if (!p || !p.workspace) { toastErr('Project has no local workspace'); return; }
  const steps = (wf.steps || []).filter(s => s.command && s.command.trim());
  if (!steps.length) { toastErr(`"${wf.name}" has no commands`); return; }
  if (isRunning(tab.id)) return; // already running on this tab

  // Require the chosen CLI's hook — its Stop hook is the only reliable "step finished" signal for
  // long agentic turns. Without it a step has no dependable end, so we don't run.
  const st = await api(ROUTES.AGENT_HOOKS).catch(() => null);
  if (!st || st[wf.cli] !== 'installed') {
    const cli = CLI_LABEL[wf.cli] || wf.cli;
    // A dialog (not a transient toast) because the user must act — and offer to take them there.
    if (confirm(`The ${cli} hook isn't installed.\n\nWorkflows need it so TaskHub knows when each step finishes. Open Settings → CLIs to install it?`)) {
      window.showPage?.('settings');
      const btn = document.querySelector('button[onclick="switchSettingsTab(\'clis\',this)"]');
      if (btn) window.switchSettingsTab?.('clis', btn);
    }
    return;
  }

  // If our own hook/busy detection shows the terminal is already working (a CLI mid-turn), don't
  // start automation on top of it — that's a reliable signal, unlike probing the PTY foreground.
  if (tab.termId && state.terms.get(tab.termId)?.busy) {
    toastErr('Terminal is busy — finish or stop the current run first');
    return;
  }

  const ac = new AbortController();
  const run = { ac, name: wf.name || 'Workflow', cli: wf.cli, step: 0, total: steps.length, stepTitle: '' };
  _runs.set(tab.id, run);
  refreshWorkflowBtn();
  notifyTasksUpdated();
  try {
    // 1. Ensure the worktree (create for a new Jira task / unbuilt PR branch; reuse if present).
    toast(`${wf.name}: preparing worktree…`);
    let f = await resolveTabFolder(tab);
    const key = tab.kind === 'jira' ? (tab.jiraKey || jiraKeyFromUrl(tab.url)) : '';
    let branch = tab.kind === 'jira'
      ? wfBranchName(key, jiraByKey(key)?.summary || '')
      : (tab.branch || (p.prs || []).find(pr => pr.url === tab.url)?.headRefName || '');
    if (!f.matched && branch) {
      const r = await apiJson(ROUTES.WORKTREE, 'POST', { path: f.workspace || p.workspace, branch });
      if (r && r.error) throw new Error(r.error);
      f = await resolveTabFolder(tab); // re-resolve now that it exists, so the terminal opens in it
    }

    // 2. Open the split terminal in that worktree.
    tab.prSplit = true;
    await ensurePrTerminal(tab);
    if (state.activeTabId === tab.id) applyPrLayout(tab, true);
    const termId = tab.termId;
    if (!termId) throw new Error('terminal not ready');
    const dir = (f && f.path) || p.workspace;

    // 3. Launch the CLI only if the terminal is at a shell prompt. If a program is already in the
    //    foreground (e.g. claude/codex left running from a previous run — terminals outlive tabs),
    //    typing the CLI name would go INTO it as input, so skip the launch and reuse the session.
    //    When we DO launch, cd into the worktree first: the terminal may be a reused PTY rooted at
    //    the workspace (it was created before the worktree existed), so steps must not run there.
    // If our hook/busy detection already shows this terminal working, a CLI is running — never
    // launch on top of it (the reliable signal). Otherwise fall back to the PTY foreground check.
    let atShell = !(state.terms.get(termId)?.busy);
    if (atShell) { try { atShell = (await window.taskhub?.term?.foreground(termId))?.atShell !== false; } catch {} }
    if (atShell) {
      if (dir) await submitLine(termId, `cd ${shq(dir)}`);
      await submitLine(termId, wf.cli);
      await delay(LAUNCH_SETTLE_MS);
    }
    const pr = tab.kind === 'github' ? String((tab.url.match(/\/pull\/(\d+)/) || [])[1] || '') : '';
    const ctx = {
      key, pr, url: tab.url, branch,
      repo: p.repo || tab.repo || '',
      worktree: (f && f.path) || '', workspace: (f && f.workspace) || p.workspace,
    };
    let retried = false; // one retry budget per step
    for (let i = 0; i < steps.length; i++) {
      if (ac.signal.aborted) break;
      run.step = i + 1; run.stepTitle = steps[i].title || '';
      notifyTasksUpdated();
      toast(`${wf.name}: step ${i + 1}/${steps.length}`);
      await submitLine(termId, resolvePlaceholders(steps[i].command, ctx));
      // Wait for the Stop hook (turn-done) — any duration. Resolves false only on abort or the
      // terminal being disposed (tab closed); either way, stop rather than type into a dead/aborted run.
      const done = await whenTurnDone(termId, { signal: ac.signal });
      if (ac.signal.aborted || !done) break;

      // Judge the step from the agent's last message (advisory — we still only type predefined
      // step commands). proceed → next step; retry → re-run THIS step once; stop → halt (the agent
      // is asking the user / is blocked / failed). Its summary+state also populate the session card.
      const decision = await decideAfterStep(wf, steps, i, termId);
      if (ac.signal.aborted) break;
      if (decision === 'stop') { toast(`${wf.name}: stopped — agent needs attention`); break; }
      if (decision === 'retry') {
        if (retried) { toast(`${wf.name}: stopped after retry`); break; }
        retried = true; i--; continue;   // re-run the same predefined step once
      }
      retried = false;                    // a clean proceed refreshes the retry budget
    }
    if (ac.signal.aborted) {
      window.taskhub?.term?.write(termId, '\x1b'); // ESC — interrupt the CLI's current turn
      setTermBusy(termId, false); // an interrupt fires NO Stop hook, so clear the spinner ourselves
      toast(`${wf.name}: stopped`);
    } else {
      toast(`${wf.name}: done`);
    }
  } catch (e) { toastErr('Workflow failed: ' + e.message); }
  finally { _runs.delete(tab.id); refreshWorkflowBtn(); notifyTasksUpdated(); }
}
