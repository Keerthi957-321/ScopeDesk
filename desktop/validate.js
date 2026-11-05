'use strict';
// Pure checks used by the Electron main process. Kept free of Electron imports so they can be unit-tested.
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// The page hands the main process {taskId, token}. Nothing else (no URL, no command, no path) is accepted from it.
function validateAgentConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'Invalid agent configuration.' };
  const taskId = Number(cfg.taskId);
  if (!Number.isInteger(taskId) || taskId <= 0) return { ok: false, error: 'Invalid task id.' };
  if (typeof cfg.token !== 'string' || cfg.token.length > 4096 || !JWT_SHAPE.test(cfg.token)) return { ok: false, error: 'Invalid agent token.' };
  // `manual` MUST survive validation: main.js ignores every start that is not marked as the Client's own click. Dropping it here
  // meant "Start remote control" was silently thrown away and the host agent never ran.
  return { ok: true, value: { taskId, token: cfg.token, viewOnly: cfg.viewOnly === true, manual: cfg.manual === true } };
}

// Only the ScopeDesk page itself (same origin as the server) may talk to the main process.
function isTrustedSender(senderUrl, serverUrl) {
  try { return new URL(senderUrl).origin === new URL(serverUrl).origin; } catch (_) { return false; }
}

module.exports = { validateAgentConfig, isTrustedSender };
