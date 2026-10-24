'use strict';
// Owns the host agent (agent/client-agent.js) as a hidden background process. The Client never sees a terminal.
//
//   warm()   fork the agent in STANDBY the moment the app opens (no token needed yet)
//   init()   hand it {taskId, token} over the IPC channel when the Client creates/accepts a ticket
//   input()  forward one vendor input frame (from the WebRTC data channel) to the agent
//   freeze() lock input at once (violation); stop() end the session
// The token travels over IPC only: not on the command line and not in the environment, where other programs could read it.
// After every session the agent exits and a fresh standby agent is forked, so the next ticket starts instantly.
const path = require('path');
const { fork } = require('child_process');

const IDLE = { phase: 'stopped', uiState: 'offline', taskId: null, policy: '', detail: '' };

function createAgentRunner({ agentDir, serverUrl, forkFn = fork, execPath = process.execPath, onStatus = () => {}, onViolation = () => {}, log = () => {}, rewarmMs = 500 }) {
  let child = null, inited = false, quitting = false, rewarmTimer = null;
  let status = { ...IDLE };
  const tail = [];

  function set(patch) { status = { ...status, ...patch }; onStatus({ ...status }); }
  function remember(line) { tail.push(line); if (tail.length > 200) tail.shift(); log(line); }

  function spawn() {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SERVER_URL: serverUrl };
    delete env.SCOPEDESK_AGENT_TOKEN;   // never inherit a token from the parent environment
    const c = forkFn(path.join(agentDir, 'client-agent.js'), [], { cwd: agentDir, env, execPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child = c; inited = false;

    const pipeLines = (stream) => stream && stream.on('data', (b) => String(b).split(/\r?\n/).filter(Boolean).forEach(remember));
    pipeLines(c.stdout); pipeLines(c.stderr);

    c.on('message', (m) => {
      if (c !== child || !m || typeof m !== 'object') return;
      if (m.type === 'standby') { if (!inited) set({ ...IDLE, phase: 'standby' }); }
      else if (m.type === 'connected') set({ phase: 'connected', uiState: 'waiting' });
      else if (m.type === 'state') set({ phase: 'running', uiState: String(m.state), policy: String(m.policy || '') });
      else if (m.type === 'violation') {
        set({ detail: `Scope violation (${m.kind}): ${m.processName || 'unknown app'}` });
        try { onViolation({ kind: m.kind === 'path' ? 'path' : 'app', processName: String(m.processName || 'unknown'), detail: String(m.detail || '') }); } catch (_) { /* a listener must not break the runner */ }
      }
      else if (m.type === 'ended') set({ detail: String(m.reason || '') });
    });
    c.on('error', (e) => { if (c !== child) return; child = null; set({ phase: 'error', uiState: 'error', detail: e.message }); scheduleWarm(); });
    c.on('exit', (code) => {
      if (c !== child) return;
      child = null; inited = false;
      if (code === 0 || code === null) set({ ...IDLE });
      else set({ phase: 'error', uiState: 'error', detail: tail[tail.length - 1] || `The host agent stopped (code ${code}).` });
      scheduleWarm();
    });
    return c;
  }

  // Bring a fresh standby agent up for the next ticket (keeps an error message on screen until the next init)
  function scheduleWarm() {
    if (quitting) return;
    clearTimeout(rewarmTimer);
    rewarmTimer = setTimeout(() => { if (!child && !quitting) { try { spawn(); } catch (e) { log('warm failed: ' + e.message); } } }, rewarmMs);
    if (rewarmTimer.unref) rewarmTimer.unref();
  }

  function warm() {
    if (child || quitting) return { ok: true };
    try { spawn(); } catch (e) { set({ phase: 'error', uiState: 'error', detail: e.message }); return { ok: false, error: 'Could not start the host agent: ' + e.message }; }
    set({ ...IDLE, phase: 'standby' });
    return { ok: true };
  }

  function init({ taskId, token, viewOnly = false }) {
    if (child && inited) stop('restart');                 // a second ticket replaces the first
    if (!child) { try { spawn(); } catch (e) { set({ phase: 'error', uiState: 'error', taskId, detail: e.message }); return { ok: false, error: 'Could not start the host agent: ' + e.message }; } }
    inited = true;
    set({ phase: 'starting', uiState: 'starting', taskId, policy: '', detail: '' });
    try { child.send({ type: 'init', token, viewOnly: !!viewOnly }); } catch (e) { return { ok: false, error: 'The host agent is not reachable: ' + e.message }; }
    return { ok: true };
  }

  function input(data) {
    if (!child || !inited || typeof data !== 'string' || data.length > 600) return false;
    try { child.send({ type: 'input', data }); return true; } catch (_) { return false; }
  }

  function freeze() { if (child && inited) { try { child.send({ type: 'freeze' }); } catch (_) { /* gone */ } } }

  function stop(reason = 'stopped') {
    const c = child;
    if (!c) return { ok: true };
    child = null; inited = false;
    try { c.send({ type: 'stop' }); } catch (_) { /* already gone */ }   // lets the agent release held keys and buttons
    const killer = setTimeout(() => { try { c.kill(); } catch (_) { /* ignore */ } }, 1500);
    if (killer.unref) killer.unref();
    c.once('exit', () => clearTimeout(killer));
    set({ ...IDLE, detail: reason === 'restart' ? '' : status.detail });
    scheduleWarm();
    return { ok: true };
  }

  function shutdown() { quitting = true; clearTimeout(rewarmTimer); const c = child; if (c) { child = null; try { c.send({ type: 'stop' }); } catch (_) { /* gone */ } setTimeout(() => { try { c.kill(); } catch (_) { /* gone */ } }, 300).unref(); } }

  return { warm, init, start: init, input, freeze, stop, shutdown, status: () => ({ ...status }), logs: () => tail.slice() };
}

module.exports = { createAgentRunner };
