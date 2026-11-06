'use strict';
// The ONLY bridge between the ScopeDesk page and the desktop shell. The page never gets ipcRenderer or Node itself.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, cb) => {
  const handler = (_event, payload) => { try { cb(payload); } catch (_) { /* a listener must not break the bridge */ } };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);   // returns an unsubscribe function
};

contextBridge.exposeInMainWorld('scopedeskDesktop', {
  isDesktop: true,

  // Page -> main: the ticket's session config. Main forwards it to the background agent that is already running in
  // standby. Fire-and-forget: progress and errors come back through onAgentStatus.
  initSession: (cfg) => ipcRenderer.send('init-session', { taskId: cfg && cfg.taskId, token: cfg && cfg.token, viewOnly: !!(cfg && cfg.viewOnly), manual: !!(cfg && cfg.manual) }),
  // Same thing under the name the page bridge already uses
  initializeAgent: (cfg) => { ipcRenderer.send('init-session', { taskId: cfg && cfg.taskId, token: cfg && cfg.token, viewOnly: !!(cfg && cfg.viewOnly), manual: !!(cfg && cfg.manual) }); return Promise.resolve({ ok: true }); },

  // Page -> main: one vendor input frame received on the WebRTC data channel. Main passes it to the agent, which validates it again.
  sendInput: (frame) => { if (typeof frame === 'string' && frame.length <= 20000) ipcRenderer.send('agent:input', frame); },
  // Multi-monitor: the Client's displays (ids, sizes, which is primary) and the one to share. Nothing else about the PC is exposed.
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  selectDisplay: (id) => ipcRenderer.invoke('displays:select', String(id)),
  // Screen / window picker: tiles with a small thumbnail; the Client's choice decides what getDisplayMedia() shares
  listSources: () => ipcRenderer.invoke('sources:list'),
  selectSource: (s) => ipcRenderer.invoke('sources:select', { id: String((s && s.id) || ''), displayId: String((s && s.displayId) || '') }),
  // Page -> main: the data channel was cut on the page side; lock the agent too
  freezeInput: () => ipcRenderer.send('agent:freeze'),

  stopAgent: () => ipcRenderer.invoke('agent:stop'),
  // The server ended this task (time up, terminated, breach): the agent stops and the page cannot start it again
  endTask: (taskId) => ipcRenderer.invoke('agent:end-task', Number(taskId)),
  getAgentStatus: () => ipcRenderer.invoke('agent:status'),
  // Why the last screen-capture request was refused (empty when it was not)
  getDisplayMediaDenial: () => ipcRenderer.invoke('display-media:last-denial'),

  // Main -> page
  onAgentStatus: (cb) => listen('agent:status', cb),
  onLockout: (cb) => listen('agent:lockout', cb),   // { kind, processName, detail }: the vendor left the approved scope
  // The small control bar shown while the vendor has control: its Stop / End buttons, and what it displays
  onMiniAction: (cb) => listen('mini:action', cb),  // 'stop' | 'terminate'
  setSessionInfo: (info) => ipcRenderer.send('mini:info', { endsAt: Number(info && info.endsAt) || 0, apps: String((info && info.apps) || '').slice(0, 80) })
});
