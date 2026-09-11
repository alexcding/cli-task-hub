// Launching and RESUMING the agent CLIs (claude / codex) inside a task's terminal.
//
// Resume needs the CLI's own conversation id, so we get it the reliable way (the unpeel model):
//   • Claude lets us MINT it — every fresh launch is `claude --session-id <uuid>`, so the id is
//     known from second zero, independent of hook delivery.
//   • Codex creates its own — we learn it from the first hook payload (`session_id`, relayed by
//     the server as agent-turn-start.sessionId; app.js stamps it on the task).
// Either way the id lives on the durable task record (state.tasks[].sessionId, taskhub.db), and
// a stopped task resumes with `claude --resume <id>` / `codex resume <id>` (openPrPanel).
import { state } from '../stores/store.js';
import { delay } from '../lib/util.js';

const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'"; // single-quote a path for the shell
const LAUNCH_SETTLE_MS = 2000; // a CLI launch isn't a "turn" — give the TUI a moment before typing

const mintSessionId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

// The shell line for a CLI. Fresh Claude launches mint their id; a resume targets the stored one.
// Returns { line, sessionId } — sessionId is '' when the CLI will tell us later (fresh Codex).
function cliCommand(cli, { sessionId = '', resume = false } = {}) {
  if (cli === 'claude') {
    if (resume && sessionId) return { line: `claude --resume ${shq(sessionId)}`, sessionId };
    const id = mintSessionId();
    return { line: `claude --session-id ${id}`, sessionId: id };
  }
  if (cli === 'codex') {
    if (resume && sessionId) return { line: `codex resume ${shq(sessionId)}`, sessionId };
    return { line: 'codex', sessionId: '' };
  }
  return { line: cli, sessionId: '' };
}

export async function submitLine(termId, line) {
  window.taskhub?.term?.write(termId, line);
  await delay(60);
  window.taskhub?.term?.write(termId, '\r');
}

// Launch (or resume) an interactive CLI in a terminal sitting at a shell prompt: cd into the
// worktree, run the command, and give the TUI a moment to draw. No-op if something is already in
// the foreground (busy terminal) — we never type over a running program.
// Resolves to { sessionId } (the minted or targeted id, '' if unknown) or null when skipped.
export async function launchCli(termId, dir, cli, opts = {}) {
  if (!termId || !cli) return null;
  let atShell = !(state.terms.get(termId)?.busy);
  if (atShell) { try { atShell = (await window.taskhub?.term?.foreground(termId))?.atShell !== false; } catch {} }
  if (!atShell) return null;
  const { line, sessionId } = cliCommand(cli, opts);
  if (dir) await submitLine(termId, `cd ${shq(dir)}`);
  await submitLine(termId, line);
  await delay(LAUNCH_SETTLE_MS);
  return { sessionId };
}
