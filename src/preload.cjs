const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('collect', {
  action: (name, payload) => ipcRenderer.invoke('action', name, payload),
  onState: callback => ipcRenderer.on('state', (_event, state) => callback(state))
});
