// VENDOR-SIDE INPUT WRAPPER.
// Captures mouse, wheel and keyboard events inside the remote-screen container and turns them into small JSON events:
//   {"t":"move","x":0.4231,"y":0.1180}                       mouse move (x/y are fractions of the shared screen, 0..1)
//   {"t":"down"|"up","x":0.42,"y":0.11,"b":0|1|2}            button press/release (0 left, 1 middle, 2 right)
//   {"t":"wheel","dx":0,"dy":120}                            scroll, in pixels
//   {"t":"key","k":"KeyA","d":true|false}                    KeyboardEvent.code + pressed/released
// TOUCH (phone/tablet vendor): tap = left click, double tap = double click, long press = right click,
// one-finger drag = click-and-drag, two-finger drag = scroll.
// A double-click needs no special event: two quick down/up pairs at the same spot are a double-click to the Client's OS.
//
// ScopeDeskInput.attach({ stage, video, send }) -> detach()    `send(event, volatile)` decides how the event travels.
(function () {
  // Position inside the PICTURE, ignoring the black bars around a letterboxed video (object-fit: contain):
  //   scale = min(boxW / videoW, boxH / videoH);   picture = videoW*scale by videoH*scale, centred in the box
  //   x = (clientX - box.left - (boxW - pictureW)/2) / pictureW        y likewise
  // This makes the result independent of the vendor's window size and of the Client's screen resolution.
  function mapToVideo(video, clientX, clientY, clamp) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const r = video.getBoundingClientRect();
    const scale = Math.min(r.width / vw, r.height / vh);
    const pw = vw * scale, ph = vh * scale;
    let x = (clientX - r.left - (r.width - pw) / 2) / pw;
    let y = (clientY - r.top - (r.height - ph) / 2) / ph;
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      if (!clamp) return null;
      x = Math.min(1, Math.max(0, x)); y = Math.min(1, Math.max(0, y));
    }
    return { x, y };
  }

  function attach({ stage, video, send }) {
    const heldKeys = new Set();
    const heldButtons = new Map();   // button -> last known position, so a stuck button can always be released
    let lastMove = 0, lastPos = { x: 0.5, y: 0.5 };

    const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); return () => target.removeEventListener(type, fn, opts); };
    const releaseAll = () => {
      heldKeys.forEach((k) => send({ t: 'key', k, d: false }));
      heldButtons.forEach((pos, b) => send({ t: 'up', x: pos.x, y: pos.y, b }));
      heldKeys.clear(); heldButtons.clear();
    };

    // ----- touch gestures -----
    const tp = new Map();                       // pointerId -> { cx, cy }
    const T = { mode: 'none', start: null, timer: null, lastCX: 0, lastCY: 0 };
    const avg = () => { let x = 0, y = 0; tp.forEach((p) => { x += p.cx; y += p.cy; }); return { x: x / tp.size, y: y / tp.size }; };
    const pos = (cx, cy) => mapToVideo(video, cx, cy, true);
    const touchDown = (ev) => {
      stage.setPointerCapture(ev.pointerId);
      tp.set(ev.pointerId, { cx: ev.clientX, cy: ev.clientY });
      clearTimeout(T.timer);
      if (tp.size >= 2) {
        if (T.mode === 'drag') { const q = pos(ev.clientX, ev.clientY); if (q) send({ t: 'up', ...q, b: 0 }); }
        T.mode = 'scroll'; const a = avg(); T.lastCX = a.x; T.lastCY = a.y; return;
      }
      T.mode = 'tap'; T.start = { cx: ev.clientX, cy: ev.clientY };
      T.timer = setTimeout(() => {                // long press: right click
        if (T.mode !== 'tap') return;
        const q = pos(T.start.cx, T.start.cy); T.mode = 'long';
        if (q) { send({ t: 'move', ...q }); send({ t: 'down', ...q, b: 2 }); send({ t: 'up', ...q, b: 2 }); }
      }, 550);
    };
    const touchMove = (ev) => {
      if (!tp.has(ev.pointerId)) return;
      tp.set(ev.pointerId, { cx: ev.clientX, cy: ev.clientY });
      if (T.mode === 'scroll') {
        const a = avg(); send({ t: 'wheel', dx: -(a.x - T.lastCX), dy: -(a.y - T.lastCY) }); T.lastCX = a.x; T.lastCY = a.y; return;
      }
      if (T.mode === 'tap' && Math.hypot(ev.clientX - T.start.cx, ev.clientY - T.start.cy) > 10) {
        clearTimeout(T.timer); T.mode = 'drag';
        const q = pos(T.start.cx, T.start.cy); if (q) { send({ t: 'move', ...q }); send({ t: 'down', ...q, b: 0 }); heldButtons.set(0, q); }
      }
      if (T.mode === 'drag') { const q = pos(ev.clientX, ev.clientY); if (q) { lastPos = q; send({ t: 'move', ...q }, true); } }
    };
    const touchUp = (ev) => {
      if (!tp.has(ev.pointerId)) return;
      tp.delete(ev.pointerId); clearTimeout(T.timer);
      const q = pos(ev.clientX, ev.clientY) || lastPos;
      if (T.mode === 'tap') { send({ t: 'move', ...q }); send({ t: 'down', ...q, b: 0 }); send({ t: 'up', ...q, b: 0 }); lastPos = q; }
      else if (T.mode === 'drag') { heldButtons.delete(0); send({ t: 'up', ...q, b: 0 }); }
      if (tp.size === 0) T.mode = 'none';
    };

    const offs = [
      on(stage, 'pointermove', (ev) => {
        if (ev.pointerType === 'touch') return touchMove(ev);
        const now = performance.now(); if (now - lastMove < 16) return; lastMove = now; // about 60 per second
        const p = mapToVideo(video, ev.clientX, ev.clientY, false);
        if (p) { lastPos = p; send({ t: 'move', ...p }, true); }
      }),
      on(stage, 'pointerdown', (ev) => {
        stage.focus();
        if (ev.pointerType === 'touch') { ev.preventDefault(); return touchDown(ev); }
        const p = mapToVideo(video, ev.clientX, ev.clientY, false); if (!p) return;
        ev.preventDefault();
        stage.setPointerCapture(ev.pointerId);       // keep receiving the release even if the pointer leaves the box
        const b = Math.min(ev.button, 2);
        heldButtons.set(b, p); lastPos = p;
        send({ t: 'down', ...p, b });
      }),
      on(stage, 'pointerup', (ev) => {
        if (ev.pointerType === 'touch') return touchUp(ev);
        const b = Math.min(ev.button, 2);
        if (!heldButtons.has(b)) return;
        const p = mapToVideo(video, ev.clientX, ev.clientY, true) || lastPos;   // clamp: a release outside the box must still arrive
        heldButtons.delete(b);
        send({ t: 'up', ...p, b });
      }),
      on(stage, 'pointercancel', (ev) => { if (ev.pointerType === 'touch') { tp.delete(ev.pointerId); T.mode = 'none'; clearTimeout(T.timer); } releaseAll(); }),
      on(stage, 'contextmenu', (ev) => ev.preventDefault()),
      on(stage, 'dragstart', (ev) => ev.preventDefault()),
      // dblclick is observed only to stop the vendor's own page selecting text. The remote double-click is already made by
      // the two down/up pairs above; forwarding this event too would turn it into a triple click.
      on(stage, 'dblclick', (ev) => ev.preventDefault()),
      on(stage, 'wheel', (ev) => { ev.preventDefault(); const k = ev.deltaMode === 1 ? 40 : 1; send({ t: 'wheel', dx: ev.deltaX * k, dy: ev.deltaY * k }); }, { passive: false }),
      on(stage, 'keydown', (ev) => { ev.preventDefault(); if (ev.repeat) return; heldKeys.add(ev.code); send({ t: 'key', k: ev.code, d: true }); }),
      on(stage, 'keyup', (ev) => { ev.preventDefault(); heldKeys.delete(ev.code); send({ t: 'key', k: ev.code, d: false }); }),
      on(stage, 'blur', releaseAll)                  // never leave a key or button stuck down on the Client's PC
    ];
    return () => { releaseAll(); offs.forEach((off) => off()); };
  }

  window.ScopeDeskInput = { attach, mapToVideo };
})();
