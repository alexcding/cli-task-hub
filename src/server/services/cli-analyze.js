// One-shot, headless analysis of an agent's last message. Spawns the chosen CLI (claude / codex)
// in non-interactive print mode, asks it to return a compact JSON object, and parses it. Two
// consumers, one call:
//   • the Tasks page reads { summary, state } to label a session's card;
//   • an automated workflow also passes step `context` and gates its loop on { decision, reason }.
// The model is ADVISORY only — the workflow still types its predefined step commands; decision
// merely says proceed / retry / stop. Best-effort: any failure/timeout rejects and the caller
// falls back (card shows the raw message; an automated run defaults to proceeding as before).
//
// We deliberately do NOT pass --model — the default model is used (a small/fast model isn't sharp
// enough for the proceed/stop call).
const { spawn } = require('child_process');

// A one-shot summary on the default model can legitimately run over a minute, so this is only a
// backstop against a truly hung child (stuck on auth, a network stall, a model that never returns)
// — generous enough not to guillotine a slow-but-real call. The child is SIGKILLed when it trips.
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 256 * 1024; // cap stdout/stderr accumulation — the answer is one short JSON line

// The instruction + the agent's message. `context` (optional) switches on the workflow decision.
function buildPrompt({ text, context }) {
  const wf = !!(context && String(context).trim());
  const shape = '{"summary": string, "state": "done"|"needs_input"|"working"|"blocked"'
    + (wf ? ', "decision": "proceed"|"retry"|"stop", "reason": string' : '') + '}';
  const lines = [
    "You are monitoring a coding agent in a terminal. After the --- below is the agent's latest message.",
    'Reply with ONLY a compact JSON object (no markdown, no commentary):',
    shape,
    '- summary: one short sentence (max 18 words) on what the agent just did or is asking.',
    '- state: done = finished its work; needs_input = asking the user / awaiting approval; working = still going; blocked = hit an error it cannot resolve.',
  ];
  if (wf) {
    lines.push('- decision: proceed if the step clearly succeeded and the workflow may continue; retry if a transient failure suggests re-running the SAME step; stop if the agent is asking the user something, is blocked, or failed.');
    lines.push('- reason: brief justification (max 12 words).');
    lines.push('', 'Workflow context: ' + String(context).trim());
  }
  lines.push('', '---', String(text || ''));
  return lines.join('\n');
}

// argv for a non-interactive, single-shot run. Claude is confirmed; codex is best-effort (failure
// just falls back). No --model on either — use the default.
function cmdFor(cli, prompt) {
  if (cli === 'codex') return ['codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', prompt]];
  return ['claude', ['-p', '--max-turns', '1', '--output-format', 'text', prompt]];
}

// Parse the JSON object that starts at `start`, scanning FORWARD with string-awareness so a brace
// inside a string value doesn't miscount. Returns the object, or undefined if it doesn't close /
// doesn't parse.
function parseObjectAt(text, start) {
  let depth = 0, inStr = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}

// Extract the LAST well-formed JSON object from text, trying each '{' from last to first. Robust to
// a CLI that echoes the prompt's schema, prints a banner, or repeats the answer (codex exec does all
// three), and to a '}' inside a string value. No '{' → returns immediately (no O(n^2) on a '}'-flood).
function lastJsonObject(out) {
  const text = String(out || '');
  for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    const obj = parseObjectAt(text, start);
    if (obj && typeof obj === 'object') return obj;
  }
  return null;
}

// Parse the model's reply into validated fields. hasContext → also surface a (safe-defaulted)
// decision/reason.
function parseResult(out, hasContext) {
  const s = String(out || '');
  const obj = lastJsonObject(s) || {};
  const summary = typeof obj.summary === 'string' && obj.summary.trim()
    ? obj.summary.trim()
    : (s.trim().split('\n').map(x => x.trim()).filter(Boolean).pop() || '');
  const state = ['done', 'needs_input', 'working', 'blocked'].includes(obj.state) ? obj.state : '';
  const res = { summary, state };
  if (hasContext) {
    // Unparseable/garbled output → 'proceed': don't let a flaky analysis halt an automated run
    // (that's the legacy behavior). We only stop/retry when the model says so clearly.
    res.decision = ['proceed', 'retry', 'stop'].includes(obj.decision) ? obj.decision : 'proceed';
    res.reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  }
  return res;
}

function analyze({ cli = 'claude', text = '', context = '' } = {}) {
  return new Promise((resolve, reject) => {
    const body = String(text || '').trim();
    if (!body) return reject(new Error('no text to analyze'));
    const hasContext = !!String(context || '').trim();
    const [bin, args] = cmdFor(cli === 'codex' ? 'codex' : 'claude', buildPrompt({ text: body, context }));
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return reject(e); }
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('analyze timed out')); }, TIMEOUT_MS);
    // Cap the buffers so a runaway/looping CLI print can't grow them without bound. We only need the
    // first chunk of a one-line JSON answer anyway; stop appending past the cap (the timer still kills).
    child.stdout.on('data', d => { if (out.length < MAX_OUTPUT) out += d; });
    child.stderr.on('data', d => { if (err.length < MAX_OUTPUT) err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      // Empty stdout is a failure however the process exited — a blank result would otherwise
      // become a no-op summary and (with workflow context) a 'proceed' on zero information.
      if (!out.trim()) return reject(new Error(err.trim() || `${bin} produced no output (exit ${code})`));
      resolve(parseResult(out, hasContext));
    });
  });
}

module.exports = { analyze, _buildPrompt: buildPrompt, _cmdFor: cmdFor, _parseResult: parseResult };
