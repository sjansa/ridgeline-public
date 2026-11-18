// mappick.js -- pick a spot on a map drawn from the terrain pack itself:
// shaded relief with the lifts, runs and peaks on it. Works offline and sends
// nothing anywhere. Used to say where a photo was taken when its GPS tag is
// missing or poor.

import { CLASS_COLOR } from './runs.js?v=1117.2337-974109f';

const LIFT = '#9b4dff';
const TAP_PX = 12;           // how far off a fingertip lands, CSS pixels: the pick's uncertainty

/** Shaded relief of a grid, one canvas pixel per cell. Cached on the grid. */
function relief(g) {
  if (g._relief) return g._relief;
  const { cols, rows, data, unit, cellE, cellN } = g;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < data.length; i++) { const z = data[i]; if (z < lo) lo = z; if (z > hi) hi = z; }
  const c = document.createElement('canvas'); c.width = cols; c.height = rows;
  const ctx = c.getContext('2d'), img = ctx.createImageData(cols, rows), px = img.data;
  // light from the northwest, 45 degrees up
  const lx = -0.5, ly = -0.5, lz = Math.SQRT1_2;
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
    const i = r * cols + k;
    const gx = (data[k < cols - 1 ? i + 1 : i] - data[k > 0 ? i - 1 : i]) * unit / (2 * cellE);
    const gy = (data[r < rows - 1 ? i + cols : i] - data[r > 0 ? i - cols : i]) * unit / (2 * cellN);
    const n = Math.hypot(gx, gy, 1);
    const shade = Math.max(0, (-gx * lx - gy * ly + lz) / n);
    const h = (data[i] - lo) / Math.max(1, hi - lo);      // low valleys dark slate, high ground pale
    const v = 0.12 + 0.88 * shade * shade;
    px[i * 4] = (60 + 150 * h) * v; px[i * 4 + 1] = (78 + 150 * h) * v; px[i * 4 + 2] = (92 + 140 * h) * v; px[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return (g._relief = c);
}

/**
 * Open the picker over the page. el: the #picker element (holds a canvas,
 * #pickOk and #pickCancel). grid: the fine terrain grid. prep: lifts, runs,
 * peaks. start: {lat, lon} to center on and pin; prior: {lat, lon, acc} drawn
 * as a circle (the photo's own GPS fix), or null.
 * Resolves to {lat, lon, acc} (acc in meters), or null when cancelled.
 */
export function pickOnMap(el, grid, prep, start, prior) {
  const canvas = el.querySelector('canvas'), ctx = canvas.getContext('2d');
  const shade = relief(grid);
  const W = grid.cellE * (grid.cols - 1), H = grid.cellN * (grid.rows - 1);
  // map meters: x east from the west edge, y south from the north edge
  const toM = (lat, lon) => [(lon - grid.west) / grid.dx * grid.cellE, (grid.north - lat) / grid.dy * grid.cellN];
  const toLL = (x, y) => [grid.north - y / grid.cellN * grid.dy, grid.west + x / grid.cellE * grid.dx];
  const clampPt = ([x, y]) => [Math.min(W, Math.max(0, x)), Math.min(H, Math.max(0, y))];
  let pin = clampPt(toM(start.lat, start.lon)), [cx, cy] = pin, s = 0.5, dpr = 1;   // s: CSS px per meter
  const lines = [
    ...prep.runs.filter(r => !r.area).map(r => ({ pts: r.pts.map(p => toM(p[0], p[1])), color: CLASS_COLOR[r.cls], w: 1.6 })),
    ...prep.lifts.map(l => ({ pts: l.pts.map(p => toM(p[0], p[1])), color: LIFT, w: 2.4, name: l.name })),
  ];
  const peaks = prep.peaks.map(p => ({ ...p, m: toM(p.lat, p.lon) }));
  const priorM = prior ? toM(prior.lat, prior.lon) : null;

  const draw = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0c1a22'; ctx.fillRect(0, 0, w, h);
    const X = x => (x - cx) * s + w / 2, Y = y => (y - cy) * s + h / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(shade, X(0), Y(0), W * s, H * s);
    ctx.lineJoin = ctx.lineCap = 'round';
    for (const l of lines) {
      ctx.strokeStyle = l.color; ctx.lineWidth = l.w;
      ctx.beginPath();
      l.pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      ctx.stroke();
    }
    ctx.font = '600 12px "Barlow Condensed", "Helvetica Neue", Arial, sans-serif';
    ctx.textBaseline = 'middle';
    if (s > 0.12) for (const p of peaks) {
      const x = X(p.m[0]), y = Y(p.m[1]);
      if (x < -50 || y < -20 || x > w + 50 || y > h + 20) continue;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 4.5, y + 3); ctx.lineTo(x - 4.5, y + 3); ctx.fill();
      ctx.fillText(p.name, x + 7, y);
    }
    if (s > 0.35) {
      ctx.fillStyle = '#e9dcff';
      for (const l of lines) if (l.name) { const m = l.pts[l.pts.length >> 1]; ctx.fillText(l.name, X(m[0]) + 6, Y(m[1])); }
    }
    if (priorM) {
      // the photo's own fix and its stated error
      ctx.strokeStyle = 'rgba(255,216,74,0.9)'; ctx.fillStyle = 'rgba(255,216,74,0.15)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(X(priorM[0]), Y(priorM[1]), Math.max(4, (prior.acc || 0) * s), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    // the pin
    const px = X(pin[0]), py = Y(pin[1]);
    ctx.fillStyle = '#3fb6ff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.bezierCurveTo(px - 10, py - 14, px - 10, py - 28, px, py - 28); ctx.bezierCurveTo(px + 10, py - 28, px + 10, py - 14, px, py); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px, py - 19, 3.5, 0, Math.PI * 2); ctx.fill();
    // scale bar
    const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find(m => m * s > 60) || 5000;
    ctx.fillStyle = 'rgba(12,20,27,0.7)'; ctx.fillRect(10, h - 30, nice * s + 16, 20);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(18, h - 16); ctx.lineTo(18 + nice * s, h - 16); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, 22, h - 23);
  };

  // drag pans, pinch and wheel zoom, a tap moves the pin
  const ptrs = new Map();
  let tap = null, pinch = null;
  const zoomAt = (f, sx, sy) => {
    const w = canvas.clientWidth, h = canvas.clientHeight, ns = Math.min(8, Math.max(0.03, s * f));
    cx += (sx - w / 2) * (1 / s - 1 / ns); cy += (sy - h / 2) * (1 / s - 1 / ns); s = ns;
  };
  const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const down = e => {
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, local(e));
    tap = ptrs.size === 1 ? { p: local(e), t: performance.now() } : null;
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
  };
  const move = e => {
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId), now = local(e);
    ptrs.set(e.pointerId, now);
    if (ptrs.size === 1) {
      cx -= (now[0] - prev[0]) / s; cy -= (now[1] - prev[1]) / s;
      if (tap && Math.hypot(now[0] - tap.p[0], now[1] - tap.p[1]) > 8) tap = null;
    } else if (ptrs.size === 2 && pinch) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt(d / pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); pinch = d;
    }
    draw();
  };
  const up = e => {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (tap && e.type === 'pointerup' && performance.now() - tap.t < 600) {
      const [x, y] = local(e), w = canvas.clientWidth, h = canvas.clientHeight;
      pin = clampPt([cx + (x - w / 2) / s, cy + (y - h / 2) / s]);
      draw();
    }
    tap = null;
  };
  const wheel = e => { e.preventDefault(); const [x, y] = local(e); zoomAt(Math.exp(-e.deltaY * 0.002), x, y); draw(); };

  return new Promise(resolve => {
    const done = res => {
      el.hidden = true;
      canvas.onpointerdown = canvas.onpointermove = canvas.onpointerup = canvas.onpointercancel = null;
      canvas.removeEventListener('wheel', wheel);
      window.removeEventListener('resize', draw);
      resolve(res);
    };
    canvas.onpointerdown = down; canvas.onpointermove = move; canvas.onpointerup = up; canvas.onpointercancel = up;
    canvas.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('resize', draw);
    el.querySelector('#pickOk').onclick = () => {
      const [lat, lon] = toLL(pin[0], pin[1]);
      done({ lat, lon, acc: Math.max(5, TAP_PX / s) });
    };
    el.querySelector('#pickCancel').onclick = () => done(null);
    el.hidden = false;
    requestAnimationFrame(draw);
  });
}
