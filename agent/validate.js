'use strict';
// Strict schema for every input event. The agent trusts NOTHING it receives, whichever path it came by
// (data channel via the local bridge, or the server relay). Keep in sync with server/remote-control.js.
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const unit = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);

function parseInput(e) {
  if (!e || typeof e !== 'object') return null;
  switch (e.t) {
    case 'move': { const x = unit(e.x), y = unit(e.y); return x === null || y === null ? null : { t: 'move', x, y }; }
    case 'down':
    case 'up': {
      const x = unit(e.x), y = unit(e.y);
      if (x === null || y === null || ![0, 1, 2].includes(e.b)) return null;
      return { t: e.t, x, y, b: e.b };
    }
    case 'wheel': {
      if (!Number.isFinite(e.dx) || !Number.isFinite(e.dy)) return null;
      return { t: 'wheel', dx: clamp(Math.round(e.dx), -2000, 2000), dy: clamp(Math.round(e.dy), -2000, 2000) };
    }
    case 'key': {
      if (typeof e.k !== 'string' || !/^[A-Za-z0-9]{1,20}$/.test(e.k) || typeof e.d !== 'boolean') return null;
      return { t: 'key', k: e.k, d: e.d };
    }
    case 'open': {   // "open this folder in the file manager". The policy check happens in the injector, not here.
      if (typeof e.p !== 'string' || e.p.length === 0 || e.p.length > 260 || /[\u0000-\u001f]/.test(e.p)) return null;
      return { t: 'open', p: e.p };
    }
    default: return null;
  }
}
module.exports = { parseInput };
