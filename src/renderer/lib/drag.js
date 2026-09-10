// Divider drags (sidebar edge, PR ↔ terminal split, history list ↔ diff). One wiring for the
// three because they share a trap: the drag must end when the mouse is released ANYWHERE, but in
// the Tauri build the right pane is a native child webview that swallows a mouseup released over
// it (body.resizing's pointer-events:none only reaches an Electron <webview>). So a drag ends on
// mouseup, pointerup, OR the window losing focus — whichever comes first — and `dragging` can
// never be left stuck on. While a drag is live, body.resizing is set (viewer.css uses it).
//
//   dragDivider(handleEl, { hit?, move(e), end() })
//     hit(e)  — optional filter on the mousedown target (for a handle inside a larger element)
//     move(e) — every mousemove while dragging (throttle inside if the work is heavy)
//     end()   — once, when the drag ends (persist, refit)
export function dragDivider(handle, { hit, move, end }) {
  let dragging = false;
  const stop = () => {
    if (!dragging) return;
    dragging = false; document.body.classList.remove('resizing');
    end?.();
  };
  handle.addEventListener('mousedown', e => {
    if (hit && !hit(e)) return;
    dragging = true; e.preventDefault(); document.body.classList.add('resizing');
  });
  window.addEventListener('mousemove', e => { if (dragging) move(e); });
  window.addEventListener('mouseup', stop);
  window.addEventListener('pointerup', stop);
  window.addEventListener('blur', stop);
}
