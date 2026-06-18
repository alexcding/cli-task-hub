// Built-in git-client launch presets for the viewer's folder/worktree chip and its Settings
// picker. Each preset is a command TEMPLATE that the main process runs with `{path}` replaced
// by the tab's worktree/checkout folder (see src/main/native/git-client.js), plus the brand
// icon shown on the chip (downloaded into /img — Fork from the installed app, Sourcetree/Tower
// from their sites, GitHub Desktop's official logo).
//
// The presets use macOS `open -a <App>` — it reliably opens the repo folder in any installed
// GUI, and since the folder is already on the PR branch, that lands you on the right branch.
// Users who'd rather use a URL-scheme deeplink pick "Custom…" in Settings and author their own
// template (e.g. `open x-github-client://openLocalRepo/{path}`).
export const GIT_CLIENTS = [
  { id: 'fork',       label: 'Fork',           cmd: 'open -a Fork {path}',             icon: '/img/fork.png' },
  { id: 'tower',      label: 'Tower',          cmd: 'open -a Tower {path}',            icon: '/img/tower.png' },
  { id: 'sourcetree', label: 'Sourcetree',     cmd: 'open -a Sourcetree {path}',       icon: '/img/sourcetree.png' },
  { id: 'github',     label: 'GitHub Desktop', cmd: 'open -a "GitHub Desktop" {path}', icon: '/img/github.svg' },
];

// Display label for a configured client id — falls back to a generic name for 'custom' and
// for an id no longer in the preset list.
export const gitClientLabel = id =>
  (GIT_CLIENTS.find(c => c.id === id)?.label) || 'git client';

// Brand-icon path for a configured client id, or '' when there's none (Custom, or unknown id) —
// callers fall back to the folder/worktree glyph.
export const gitClientIcon = id =>
  (GIT_CLIENTS.find(c => c.id === id)?.icon) || '';

// The command template to run for a chosen client. Presets resolve from GIT_CLIENTS at use
// time (so a future preset change reaches existing users — we persist only the id, never the
// resolved preset command); 'custom' uses the user's stored template. '' when nothing applies.
export const resolveGitClientCmd = (id, customCmd) =>
  id === 'custom' ? (customCmd || '') : (GIT_CLIENTS.find(c => c.id === id)?.cmd || '');
