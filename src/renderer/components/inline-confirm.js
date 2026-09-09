// Inline confirmation for destructive row actions (sidebar task / worktree trash): instead of a
// native dialog, a strip slides in right under the row — the consequence in one line, then
// Delete / Cancel. Resolves true on Delete; false on Cancel, Escape, a click elsewhere, or the row
// being re-rendered away. One strip at a time: opening a second cancels the first.
import { esc } from '../lib/util.js';

let _open = null; // () => cancel the current strip

export function inlineConfirm(rowEl, { text, label = 'Delete' } = {}) {
  _open?.();
  if (!rowEl) return Promise.resolve(false);
  return new Promise(resolve => {
    let _mo = null;
    const strip = document.createElement('div');
    strip.className = 'row-confirm';
    strip.innerHTML = `<span class="rc-text">${esc(text || 'Delete?')}</span>
      <button class="rc-btn rc-del">${esc(label)}</button>
      <button class="rc-btn rc-cancel">Cancel</button>`;
    rowEl.insertAdjacentElement('afterend', strip);
    rowEl.classList.add('confirming');
    const done = ok => {
      if (_open !== cancel) return; // already settled
      _open = null;
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      rowEl.classList.remove('confirming');
      strip.remove();
      _mo?.disconnect();
      resolve(ok);
    };
    const cancel = () => done(false);
    const onOutside = e => { if (!strip.contains(e.target)) cancel(); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
    strip.querySelector('.rc-del').onclick = e => { e.stopPropagation(); done(true); };
    strip.querySelector('.rc-cancel').onclick = e => { e.stopPropagation(); cancel(); };
    strip.onclick = e => e.stopPropagation();
    // Defer the outside-click listener so the trash click that opened us doesn't close us.
    setTimeout(() => { if (_open === cancel) document.addEventListener('mousedown', onOutside, true); }, 0);
    document.addEventListener('keydown', onKey, true);
    // A sidebar re-render (setHtmlIfChanged on the group) can drop the strip: settle as a cancel.
    _mo = new MutationObserver(() => { if (!document.contains(strip)) cancel(); });
    _mo.observe(document.body, { childList: true, subtree: true });
    _open = cancel;
    strip.querySelector('.rc-del').focus();
  });
}
