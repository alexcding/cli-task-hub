// Save the exact model version submitted to disk. Edits made while awaiting the
// backend stay dirty; an undo back to the submitted version becomes clean.
export function saveEditorBuffer(tab, write) {
  if (tab?._savePromise) return tab._savePromise;
  if (!tab?.edView || !tab._edModel || tab.readOnly || !tab.dirty) return Promise.resolve(false);
  if (!tab._fileRevision) return Promise.reject(new Error('Reload this file before saving so its disk revision can be checked.'));
  const model = tab._edModel;
  const version = model.getAlternativeVersionId();
  const payload = { path: tab.path, content: tab.edView.getValue({ preserveBOM: true }), revision: tab._fileRevision };
  const pending = Promise.resolve().then(() => write(payload)).then(result => {
    if (!result?.revision) throw new Error('The save response did not include a file revision. Keep your edits and reload the file before saving again.');
    if (tab._edModel === model) {
      tab._savedVersion = version;
      tab._fileRevision = result.revision;
      tab.dirty = model.getAlternativeVersionId() !== version;
    }
    return true;
  }).finally(() => { if (tab._savePromise === pending) tab._savePromise = null; });
  tab._savePromise = pending;
  return pending;
}
