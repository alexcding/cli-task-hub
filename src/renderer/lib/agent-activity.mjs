// Map a CLI's PreToolUse hook payload (the tool it's about to run) to a short human status
// like "Editing app.js" or "Running: npm test", shown live on the Tasks page. Tool names are
// Claude Code's; unknown tools fall back to the raw name. Pure + DOM-free so it's unit-tested
// directly (test/agent-activity.test.js) and safe to import from a test.

const basename = p => { const s = String(p || ''); const parts = s.split(/[\\/]/); return parts[parts.length - 1] || s; };
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// payload: the PreToolUse stdin JSON, { tool_name, tool_input }. Returns '' when there's nothing
// useful to say (the caller then falls back to a plain "Working" state).
export function activityFromTool(toolName, toolInput) {
  const t = String(toolName || '');
  const i = toolInput || {};
  const file = i.file_path || i.path || i.notebook_path;
  switch (t) {
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
      return file ? `Editing ${basename(file)}` : 'Editing files';
    case 'Read':
      return file ? `Reading ${basename(file)}` : 'Reading files';
    case 'Bash':
      return i.command ? `Running: ${clip(i.command, 40)}` : 'Running a command';
    case 'Grep': case 'Glob':
      return 'Searching the codebase';
    case 'WebFetch': case 'WebSearch':
      return 'Researching the web';
    case 'Task':
      return 'Delegating to a subagent';
    case 'TodoWrite':
      return 'Planning its next steps';
    default:
      return t ? clip(t, 32) : '';
  }
}
