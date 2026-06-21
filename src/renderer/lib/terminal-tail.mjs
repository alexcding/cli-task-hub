// Pure extraction of an agent's last message from a terminal's rendered lines. Claude Code and
// Codex both mark each assistant message with a leading dot (Claude's ⏺), then pin a working/
// "Brewed for…" line, an optional recap, an input box, and a status bar at the very bottom. So
// the message we want is the LAST dot-marked block, read above all that chrome.
//
// Given the grid rows (top→bottom, ending around the cursor row), agentOutput returns that block;
// if there's no dot marker (a plain shell, or a CLI that doesn't mark output), it falls back to
// the last few content lines above the input chrome.
//
// Factored out (DOM-free, unit-tested in test/terminal-tail.test.js) because this same "what did
// it just say" read is what a later step will hand to a CLI to decide the next workflow action.
// For now it only drives the Tasks-page preview (pages/tasks.js).

const DOT = /^[⏺●◉•]\s+/;                                     // assistant-message marker (Claude ⏺ / Codex bullet)
const SPINNER = /^[✻✽✶✷✸✹✺✱✲❋❉⁂∗*]/;                          // Claude's working / "Brewed for…" line
const RECAP = /^※/;                                           // Claude recap line
const RULE = /[─━—–═=_~]/;                                    // a horizontal box/separator char

// A line made up only of box-drawing / rule characters (and spaces) — a border or divider.
export const isRule = s => RULE.test(s) && /^[\s│┃|╭╮╰╯┌┐└┘├┤┬┴┼─━—–═=_~]+$/.test(s);
// A bare input prompt with nothing typed after it.
export const isPrompt = s => /^[❯➜›▸»>$%#]\s*$/.test(String(s).trim());
// The TUI status bar (cost / model / mode line) — matched by its distinctive GLYPHS, not by the
// words "auto mode"/"for agents", which can legitimately appear in an agent's own message. The real
// status bar always carries ⏵ / 💰 / 🤖, so the glyphs identify it without false positives on prose.
export const isStatus = s => /[💰🤖]|⏵|esc to interrupt/i.test(s);
// Drop the input-box side borders ("│ text │" → "text") and trim.
export const stripBorders = s => String(s).replace(/^\s*[│┃|]\s?/, '').replace(/\s?[│┃|]\s*$/, '').trim();

// "Hard" chrome that ends/sits-outside a message block: rules, prompt, status bar, the working
// spinner ("✻ Brewed for…"), and the recap line. Blank lines are NOT hard chrome — a message has
// blank lines between its paragraphs.
const isHardChrome = s => isRule(s) || isPrompt(s) || isStatus(s) || SPINNER.test(s) || RECAP.test(s);
// A line that STARTS with a TUI input-prompt glyph, with or without typed text after it (e.g.
// "❯ git status"). Excludes >/$/%/# — those begin legit markdown/prose (quotes, headings) — but
// the ❯➜›▸» glyphs don't appear in prose, so this reliably marks the input line.
const PROMPT_LINE = /^[❯➜›▸»]/;
// Where an assistant MESSAGE block ends: the input line (bare prompt OR a prompt-glyph line), the
// status bar, the spinner/"Brewed", or the recap — but NOT a bare rule. Agents emit their own
// markdown dividers ('---', '==='), so a rule mid-message is content. Stopping at the prompt line
// (not the rule) keeps those dividers while still never swallowing the input box below the message.
const isBlockEnd = s => isPrompt(s) || PROMPT_LINE.test(s) || isStatus(s) || SPINNER.test(s) || RECAP.test(s);

const norm = rawLines => (Array.isArray(rawLines) ? rawLines : []).map(s => stripBorders(String(s ?? '')));

// The last dot-marked assistant message, top→bottom, dot stripped, capped at maxLines. [] if none.
export function lastDotMessage(rawLines, maxLines = 6) {
  const rows = norm(rawLines);
  let mark = -1;
  for (let i = rows.length - 1; i >= 0; i--) { if (DOT.test(rows[i])) { mark = i; break; } }
  if (mark < 0) return [];
  const out = [rows[mark].replace(DOT, '').trim()];
  for (let i = mark + 1; i < rows.length && out.length < maxLines; i++) {
    if (isBlockEnd(rows[i])) break;            // message ends where the spinner/recap/input begins
    out.push(rows[i]);                         // keep content, internal blanks, and the agent's own dividers
  }
  // Trim trailing blanks AND a trailing separator rule (e.g. the divider just above the input box).
  while (out.length && (!out[out.length - 1].trim() || isRule(out[out.length - 1]))) out.pop();
  return out;
}

// Fallback for un-marked output: the last n content lines above the input chrome.
export function agentTail(rawLines, n = 3) {
  const rows = norm(rawLines);
  const out = [];
  for (let i = rows.length - 1; i >= 0 && out.length < n; i--) {
    const s = rows[i];
    if (!s || isHardChrome(s)) continue;
    out.unshift(s);
  }
  return out;
}

// What the page shows: the last dot-marked message if there is one, else the line-tail. Both honor
// the SAME maxLines — a caller asking for 40 lines (the analyzer) must not be silently clipped to a
// smaller default when the output has no dot marker.
export function agentOutput(rawLines, { maxLines = 6 } = {}) {
  const msg = lastDotMessage(rawLines, maxLines);
  return msg.length ? msg : agentTail(rawLines, maxLines);
}
