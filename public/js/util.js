import { state } from './store.js';

// Escapes quotes too, so escaped text is safe inside double- OR single-quoted attributes.
export const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

// For values embedded in a '…'-quoted JS string INSIDE an inline on* attribute: HTML
// entities decode before the JS parses, so esc() alone can't stop a quote from ending
// the JS literal — backslash-escape first, then esc() the result for the attribute.
export const escJs = s => esc(String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));

// Jira ticket link. Base is auto-detected from acli (or a settings override),
// loaded once at startup into state.jiraBase — never hardcoded.
export const jiraUrl = key => state.jiraBase ? `${state.jiraBase}/browse/${key}` : '#';

// Pull the ticket key out of a Jira URL ({base}/browse/RECORD-1234) so a restored or
// tray-opened Jira tab can still map to a worktree without separate metadata.
export const jiraKeyFromUrl = url => (String(url || '').match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i) || [])[1] || '';

// A webview tab (GitHub PR or Jira ticket) can pair a terminal beside it.
export const canSplitTerminal = t => !!t && (t.kind === 'github' || t.kind === 'jira');

export const fmtDate = s => s ? new Date(s).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '';
export const timeAgo = s => {
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(s)) / 1000));
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec/60);
  if (min < 60) return `${min}m ago`;
  return `${Math.round(min/60)}h ago`;
};
