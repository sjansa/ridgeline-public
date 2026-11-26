// drawer.js -- a drawer attached to the bottom (or top) edge of the screen, with a handle.
// Shared by Ridgeline and Moonshot (app/core/drawer.js there).
// The same mechanic for every app with a drawer:
//   - it opens at its first stop; dragging the handle away from the edge grows it to the next
//     stop, dragging it toward the edge shrinks or closes it; a quick flick goes on to the next stop;
//   - a tap on the handle closes it;
//   - a tap anywhere beyond the drawer (above a bottom drawer, below a top one) closes it, and
//     that tap does nothing else;
//   - a closed drawer can have an opener: a handle left on the screen edge; a tap opens the
//     drawer, a drag away from the edge pulls it out.
// The handle graphic is DRAWER_CSS's .grabber, the same everywhere: 34 x 2 pt, fully rounded,
// #a0a9b5, its outer edge 15 pt in from the drawer's edge (measured off Instagram's sheet).

export const DRAWER_CSS = `
.drawer { overflow: hidden; touch-action: none; }
.drawer.dragging { transition: none !important; }
.drawer:not(.dragging) { transition: height .24s cubic-bezier(.32,.72,0,1); }
.drawer-grip { flex: none; width: 100%; height: 32px; padding: 0; border: 0; background: none; display: grid; place-items: center; cursor: grab; touch-action: none; }
.drawer.bottom > .drawer-grip { align-items: start; padding-top: 15px; }
.drawer.top > .drawer-grip { align-items: end; padding-bottom: 15px; }
.grabber { display: block; width: 34px; height: 2px; border-radius: 1px; background: #a0a9b5; pointer-events: none; }
@media (prefers-reduced-motion: reduce) { .drawer:not(.dragging) { transition: none; } }
`;

const TAP_PX = 6;          // a pointer that moves less than this is a tap
const FLING = 0.6;         // px/ms: a quicker release goes on to the next stop that way

let styled = false;
function style() {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = DRAWER_CSS;
  document.head.prepend(s);    // first, so the page's own rules can adjust it
}

/**
 * el: the drawer; open means !el.hidden. grip: its handle (a button holding a .grabber), inside el.
 * edge: 'bottom' or 'top'. stops(): heights in px, smallest first (it opens at the first).
 * opener: a handle shown while it is closed (optional). ignore: a selector for things on top of
 * the page (a full-screen map, a dialog) where a tap must not close it.
 * show() and hide() do the showing and hiding (default: el.hidden), so a page can animate them;
 * enabled(): false leaves the size to the page's CSS and turns the dragging off (a side panel in
 * landscape, say).
 */
export class Drawer {
  constructor(el, grip, { edge = 'bottom', stops = () => [innerHeight * 0.5, innerHeight * 0.9], opener = null, ignore = '',
    show = () => { el.hidden = false; }, hide = () => { el.hidden = true; }, enabled = () => true } = {}) {
    style();
    Object.assign(this, { el, grip, edge, stops, opener, ignore, show, hide, enabled, at: 0 });
    el.classList.add('drawer', edge);
    grip.classList.add('drawer-grip');
    this.drag(grip, false);
    if (opener) this.drag(opener, true);
    this.wireOutside();
    addEventListener('resize', () => { if (this.isOpen) this.size(this.at); });
  }
  get isOpen() { return !this.el.hidden; }
  open(at = 0) {
    if (!this.isOpen) this.show();
    this.size(at);
  }
  close() {
    if (!this.isOpen) return;
    this.hide();
  }
  size(at) {
    if (!this.enabled()) { this.el.style.height = ''; return; }
    const s = this.stops();
    this.at = Math.max(0, Math.min(s.length - 1, at));
    this.el.style.height = `${Math.round(s[this.at])}px`;
  }

  // a handle: on the drawer (a tap closes) or the opener (a tap opens); a drag moves the edge
  drag(h, opens) {
    const sign = this.edge === 'bottom' ? -1 : 1;   // a pointer moving away from the edge grows it
    let d = null;
    h.addEventListener('pointerdown', e => {
      if (!this.enabled() || (e.pointerType === 'mouse' && e.button)) return;
      try { h.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer (tests): no capture */ }
      d = { y: e.clientY, h0: null, moved: false, v: 0, ly: e.clientY, lt: e.timeStamp };
    });
    h.addEventListener('pointermove', e => {
      if (!d) return;
      const dy = e.clientY - d.y;
      if (!d.moved) {
        if (Math.abs(dy) <= TAP_PX) return;
        d.moved = true;
        if (opens && !this.isOpen) { this.el.style.height = '0px'; this.show(); }
        d.h0 = this.el.getBoundingClientRect().height - sign * dy;
        this.el.classList.add('dragging');
      }
      const s = this.stops(), x = Math.max(0, Math.min(s.at(-1), d.h0 + sign * dy));
      this.el.style.height = `${x}px`;
      if (e.timeStamp > d.lt) { d.v = sign * (e.clientY - d.ly) / (e.timeStamp - d.lt); d.ly = e.clientY; d.lt = e.timeStamp; }
    });
    const end = e => {
      if (!d) return;
      const dd = d; d = null;
      this.el.classList.remove('dragging');
      if (!dd.moved) { if (e.type === 'pointerup') { if (opens) this.open(0); else this.close(); } return; }
      if (e.type === 'pointercancel') { this.size(this.at); return; }
      const s = this.stops(), x = this.el.getBoundingClientRect().height;
      // the nearest stop, or the next one the way it was flicked; under half the first stop: closed
      let k = s.reduce((b, v, i) => (Math.abs(v - x) < Math.abs(s[b] - x) ? i : b), 0);
      if (dd.v > FLING) { k = s.findIndex(v => v > x + 1); if (k < 0) k = s.length - 1; }
      else if (dd.v < -FLING) k = s.findLastIndex(v => v < x - 1);
      if (k < 0 || (x < s[0] * 0.5 && dd.v <= FLING)) { this.close(); return; }
      this.size(k);
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  }

  // A tap beyond the drawer closes it and goes no further.
  wireOutside() {
    let swallow = false, until = 0;
    const beyond = e => {
      if (!this.isOpen || !e.isPrimary) return false;
      const t = e.target;
      if (this.el.contains(t) || (this.ignore && t.closest?.(this.ignore))) return false;
      const r = this.el.getBoundingClientRect();
      return this.edge === 'bottom' ? e.clientY < r.top : e.clientY > r.bottom;
    };
    document.addEventListener('pointerdown', e => {
      if (!beyond(e)) return;
      e.stopPropagation(); e.preventDefault();
      swallow = true; until = Date.now() + 800;
      this.close();
    }, true);
    for (const type of ['pointermove', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchmove', 'touchend', 'dblclick']) {
      document.addEventListener(type, e => {
        if (!swallow) return;
        if (Date.now() > until) { swallow = false; return; }
        e.stopPropagation(); if (e.cancelable) e.preventDefault();
        if (type === 'click') swallow = false;
        else if (type === 'pointerup') until = Math.min(until, Date.now() + 350);   // its click, if any, comes right after
      }, true);
    }
  }
}
