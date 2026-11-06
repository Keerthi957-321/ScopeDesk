'use strict';
// The control bar's only bridge: three buttons out, one info message in. No Node, no ipcRenderer for the page.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('scopedeskMini', {
  action: (a) => { if (['show', 'stop', 'terminate'].includes(a)) ipcRenderer.send('mini:action', a); },
  onInfo: (cb) => { ipcRenderer.on('mini:info', (_e, info) => { try { cb(info); } catch (_) { /* ignore */ } }); }
});
