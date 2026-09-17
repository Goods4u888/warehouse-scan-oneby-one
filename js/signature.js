// ============================================================================
// A small freehand signature pad, styled like js/qr.js — a plain object,
// no library. Used to let a requestor/returner sign by hand on a touch
// screen when confirming a fulfillment or return (see the fulfill review
// step and the return-by-request sheet in js/app.js). Draws straight onto a
// <canvas> the caller owns; export happens on demand via toBlob(), not
// continuously, so nothing here talks to the DB directly.
// ============================================================================

const Signature = {
  // Tracks drawing state per canvas (keyed by the element itself) so
  // mount() can be called on more than one signature pad at once — the
  // fulfill sheet and the return sheet each get their own — without
  // stepping on each other.
  _state: new WeakMap(),

  mount(canvasEl) {
    // Backing store at device pixel ratio so strokes stay crisp, while
    // CSS/layout size stays whatever the caller set on the element — same
    // reasoning as any hi-DPI canvas setup.
    const ratio = window.devicePixelRatio || 1;
    const rect = canvasEl.getBoundingClientRect();
    canvasEl.width = Math.max(1, Math.round(rect.width * ratio));
    canvasEl.height = Math.max(1, Math.round(rect.height * ratio));
    const ctx = canvasEl.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1a1a1a';

    let drawing = false;
    let hasInk = false;
    let last = null;

    const pointFor = (e) => {
      const r = canvasEl.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const start = (e) => {
      drawing = true;
      last = pointFor(e);
      canvasEl.setPointerCapture && canvasEl.setPointerCapture(e.pointerId);
    };
    const move = (e) => {
      if (!drawing) return;
      const p = pointFor(e);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
      hasInk = true;
      e.preventDefault();
    };
    const end = () => { drawing = false; last = null; };

    canvasEl.addEventListener('pointerdown', start);
    canvasEl.addEventListener('pointermove', move);
    canvasEl.addEventListener('pointerup', end);
    canvasEl.addEventListener('pointerleave', end);
    // Drawing on a touch device also tries to scroll/pan the page underneath
    // by default — this is the one thing pointer events alone don't stop.
    canvasEl.style.touchAction = 'none';

    this._state.set(canvasEl, { ctx, get hasInk() { return hasInk; }, clearInk: () => { hasInk = false; } });
  },

  clear(canvasEl) {
    const s = this._state.get(canvasEl);
    if (!s) return;
    s.ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    s.clearInk();
  },

  isEmpty(canvasEl) {
    const s = this._state.get(canvasEl);
    return !s || !s.hasInk;
  },

  toBlob(canvasEl) {
    return new Promise((resolve) => {
      canvasEl.toBlob((blob) => resolve(blob), 'image/jpeg', 0.92);
    });
  },
};
