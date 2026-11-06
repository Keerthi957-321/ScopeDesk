'use strict';
// Runs the REAL agent/client-agent.js with the REAL policy, foreground monitor and input injector. Only the three things that
// need a real desktop or network are replaced:
//   socket.io-client          -> an in-process fake server driven by the test over IPC ('harness-server-emit', 'harness-reconnect')
//   @nut-tree-fork/nut-js     -> records each OS input call and reports it to the test (operation + coordinates/key code)
//   active-win                -> returns the foreground app the test sets with 'harness-foreground'
// Started with child_process.fork by remote-control-e2e.test.js. Reports through process.send like the real agent does.
const Module = require('module');
const path = require('path');
const { pathToFileURL } = require('url');

process.env.SERVER_URL = 'http://127.0.0.1:9';
process.env.POLL_MS = process.env.POLL_MS || '30';
delete process.env.SCOPEDESK_AGENT_TOKEN;

const HELLO = JSON.parse(process.env.HARNESS_HELLO || '{}');
let foreground = null;
const handlers = {};
let connects = 0;

process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'harness-foreground') foreground = m.win;
  if (m.type === 'harness-server-emit' && handlers[m.event]) handlers[m.event](m.payload);
  if (m.type === 'harness-reconnect') { if (handlers.disconnect) handlers.disconnect('transport close'); setTimeout(() => handlers.connect && handlers.connect(), 10); }
});

const fakeIo = () => {
  const s = {
    on: (ev, fn) => { handlers[ev] = fn; return s; },
    emit: (ev, payload, ack) => {
      process.send({ type: 'harness-socket-emit', event: ev, state: payload && payload.state, diag: ev === 'agent-diag' ? payload : undefined });
      if (ev === 'agent-hello' && typeof ack === 'function') {
        connects += 1;
        const refuse = process.env.HARNESS_REFUSE_RECONNECT === 'yes' && connects > 1;
        ack(refuse ? { ok: false, error: 'Remote control was stopped by the Client.' } : {
          ok: true, taskId: 7, title: 'harness task', taskType: '', targetProcess: HELLO.targetProcess || '',
          allowedPaths: [], allowedApps: HELLO.allowedApps || [],
          windowEnd: new Date(Date.now() + (HELLO.windowMs || 60000)).toISOString(), serverTime: Date.now(), halted: null
        });
      }
    },
    close: () => process.send({ type: 'harness-socket-closed' })
  };
  setImmediate(() => handlers.connect && handlers.connect());
  return s;
};

const op = (name, detail) => process.send({ type: 'harness-os', op: name, ...detail });
const fakeNut = {
  mouse: {
    config: {},
    setPosition: async (p) => op('move', { x: p.x, y: p.y }),
    pressButton: async (b) => op('press', { b }), releaseButton: async (b) => op('release', { b }),
    scrollDown: async (n) => op('scroll', { n }), scrollUp: async (n) => op('scroll', { n: -n }),
    scrollLeft: async () => {}, scrollRight: async () => {}
  },
  keyboard: { config: {}, pressKey: async (k) => op('keydown', { k }), releaseKey: async (k) => op('keyup', { k }), type: async (s) => op('type', { s }) },
  clipboard: { setContent: async (s) => op('clipboard', { len: s.length }) },
  // one shared window (handle 4242) at 100,50 sized 800x600
  getWindows: async () => [{ windowHandle: 4242, getTitle: async () => process.env.HARNESS_TITLE || '', getRegion: async () => ({ left: 100, top: 50, width: 800, height: 600 }), focus: async () => op('focus', { handle: 4242 }) }],
  screen: { width: async () => 1920, height: async () => 1080 },
  Point: function Point(x, y) { this.x = x; this.y = y; },
  Button: { LEFT: 'L', MIDDLE: 'M', RIGHT: 'R' },
  Key: new Proxy({}, { get: (_t, name) => (typeof name === 'string' ? `Key:${name}` : undefined) })
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'socket.io-client') return { io: fakeIo };
  if (request === '@nut-tree-fork/nut-js') {
    if (process.env.HARNESS_NUT === 'broken') throw new Error('libnut: not available (harness)');
    return fakeNut;
  }
  return realLoad.call(this, request, parent, isMain);
};

// active-win is loaded with import() (ESM), which Module._load does not see: map it with a resolve hook
global.__harnessForeground = () => foreground;
const fakeActiveWin = path.join(__dirname, 'fake-active-win.js');
Module.registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'active-win') return { url: pathToFileURL(fakeActiveWin).href, format: 'commonjs', shortCircuit: true };
    return next(specifier, context);
  }
});

require(path.join(__dirname, '..', '..', 'client-agent.js'));
