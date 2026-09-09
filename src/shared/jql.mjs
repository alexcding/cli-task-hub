// Turn what someone typed into the Tickets search box into JQL. Three shapes:
//   a ticket key  ("ABC-123", any case)      → key = ABC-123
//   real JQL      (has an operator/keyword)  → passed through untouched
//   plain words   ("login crash")            → text ~ "login crash" [scoped to the project key]
// So the box works as a keyword search by default and still accepts hand-written JQL. The
// project scope is only added for keyword searches — typed JQL is the user's exact intent.
const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/i;
// What counts as JQL (looksLikeJql): a comparison operator, an ORDER BY, or a word-operator
// (in / is / was / changed, optionally negated) between a field token and a JQL-shaped operand.
// Bare English words never qualify, so "not working", "log in crash", "video is black" and
// "ios or android" all stay keyword searches; `status in (Open)`, `assignee is EMPTY`,
// `summary ~ x order by created` are JQL.

export function looksLikeJql(s) {
  const t = String(s || '').trim();
  // A word-operator needs a field token before it AND a JQL-shaped operand after it: a paren
  // list, NOT, EMPTY/NULL, a quoted string, a function call, or a number/date. "log in crash" has
  // "log in " but "crash" is no operand, so it stays a keyword search. (Trade-off: `status was
  // Done` with a bare unquoted word is also read as keywords — quote the value to force JQL.)
  if (/[=~<>!]|(?:^|\s)order\s+by\s/i.test(t)) return true;
  const m = /(?:^|\s|\()[\w."'\[\]]+\s+(?:not\s+)?(?:in|is|was|changed)\s+(.*)$/i.exec(t);
  if (!m) return false;
  return /^(?:\(|not\s|empty\b|null\b|"|'|\w+\(|-?\d)/i.test(m[1]);
}

export function toJql(input, projectKey = '') {
  const s = String(input || '').trim();
  if (!s) return '';
  if (KEY_RE.test(s)) return `key = ${s.toUpperCase()}`;
  if (looksLikeJql(s)) return s;
  const text = `text ~ "${s.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
  const scope = projectKey ? `project = ${projectKey} AND ` : '';
  return `${scope}${text} ORDER BY updated DESC`;
}
