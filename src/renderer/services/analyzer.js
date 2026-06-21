// Headless analysis of a paired terminal's last agent message — the single entry point the Tasks
// card (pages/tasks.js) and the workflow runner (components/workflow.js) both commit to, so the
// read + analyze + record flow lives in ONE place. It owns:
//   • the settle delay (let the final output paint into the xterm buffer before we read it),
//   • the generation guard (a new turn bumps term.gen and supersedes an in-flight call),
//   • the card-path dedupe + min-length skip (a tiny message isn't worth a CLI call),
//   • recording { summary, state } onto the terminal entry,
//   • failure cleanup (clear summaryFor so the next turn-done retries).
// The server-side counterpart (one-shot CLI spawn + JSON parse) is src/server/services/cli-analyze.js.
import { state } from '../stores/store.js';
import { ROUTES } from '/shared/routes.mjs';
import { apiJson } from './api.js';
import { readAgentMessage } from '../components/terminal.js';
import { delay } from '../lib/util.js';

const SETTLE_MS = 500; // let the agent's final output finish painting into the buffer before reading
const MIN_LEN = 80;    // a shorter message isn't worth a CLI call (the card falls back to raw preview)

// Analyze terminal `id`'s last message, record { summary, state } on its entry, and return the full
// result ({ summary, state, decision?, reason? }) — or null when skipped/failed.
//   - context (workflow step info): when set, the result carries a decision AND the call always runs
//     (no dedupe / no min-length skip — every step must be judged, even if its output repeats).
export async function analyzeTerminal(id, { context = '' } = {}) {
  const t = state.terms.get(id);
  if (!t || !t.paired) return null;
  const gen = t.gen; // the turn we're analyzing; a new turn-start bumps gen and supersedes us
  await delay(SETTLE_MS);
  if (state.terms.get(id) !== t || t.gen !== gen) return null; // disposed, or a newer turn started
  const text = readAgentMessage(id);
  if (!text) return null;
  if (!context) {                                   // card path only
    if (text.length < MIN_LEN) return null;
    if (t.summaryFor === text) return null;         // already analyzed (or in-flight) this message
  }
  t.summaryFor = text;
  try {
    const r = await apiJson(ROUTES.AGENT_ANALYZE, 'POST', { cli: t.cli || 'claude', text, context });
    if (t.gen !== gen) return null;                 // a new turn started while we waited — drop stale result
    t.summary = r?.summary || '';
    t.state = r?.state || '';
    return r;
  } catch (e) {
    console.warn('[analyzer] analyze failed for', id, '-', e?.message || e); // server also logs to logs.db
    if (t.summaryFor === text) t.summaryFor = '';    // let the next turn-done retry
    return null;
  }
}
