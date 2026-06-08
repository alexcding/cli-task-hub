// Bridge a tiny, explicit API into the sandboxed renderer (contextIsolation is on,
// nodeIntegration is off — the page can't use Node directly). Anything the dashboard
// needs from the Electron main process is exposed here as window.taskhub.*
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taskhub', {
  // Open the native folder picker; resolves to the chosen absolute path, or null if
  // the dialog was cancelled. Used to set a project's workspace folder.
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
});
