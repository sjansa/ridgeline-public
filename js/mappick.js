// mappick.js -- pick a spot on a map: where was this photo taken?
//
// Satellite or topographic tiles when online, under them always the shaded
// relief of the terrain pack (so it works offline too), with the lifts, runs
// and peaks drawn on top. Drag pans, pinch zooms, two fingers turn it, a tap
// drops the pin. Only the map tiles for the area on screen are fetched. The
// pin can go anywhere, not just on the maps the phone has: the caller offers
// to download the area around a spot outside them.

import { CLASS_COLOR } from './runs.js?v=1118.1807-8fd4651';

const LIFT = '#9b4dff';
const TAP_PX = 12;           // how far off a fingertip lands, CSS pixels: the pick's uncertainty
const TURN_START = 0.17;     // radians of twist before a pinch starts turning the map too

const osm = '© OpenStreetMap contributors';
export const MAP_TYPES = {
  satellite: { name: 'Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', max: 19, credit: 'Imagery © Esri, Maxar, Earthstar Geographics', dark: true },
  topo: { name: 'Topographic', url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', max: 17, credit: `© OpenTopoMap (CC-BY-SA), ${osm}, SRTM` },
  relief: { name: 'Relief (offline)', url: null, credit: 'Terrain: USGS 3DEP' },
};
const TYPE_KEY = 'ridgeline.mapType';

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

// Web Mercator tile edges
const tileLon = (x, z) => x / 2 ** z * 360 - 180;
const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;
const lonTile = (lon, z) => (lon + 180) / 360 * 2 ** z;
const latTile = (lat, z) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z;

const tiles = new Map();     // url -> Image, kept across openings; oldest dropped past the limit

/**
 * Open the picker over the page. el: the #picker element (a canvas, #pickHint,
 * #pickOk, #pickCancel, #pickPhoto, #pickNorth, #pickType, #pickTypes,
 * #pickCredit). grid: the fine terrain grid. prep: lifts, runs, peaks. start:
 * {lat, lon} to center on and pin; prior: {lat, lon, acc} drawn as a circle
 * (the photo's own GPS fix), or null. view: {lat, lon, yaw, hfov} in degrees,
 * the view matched to the skyline from that spot, drawn as a wedge, or null.
 * covered(lat, lon): whether a map on the phone covers a spot (the OK button
 * says it will get one otherwise). find(text): resolves to {lat, lon} for a
 * place name, or null.
 * Resolves to {lat, lon, acc} (acc in meters), 'photo' when another photo is
 * wanted, or null when cancelled.
 */
export function pickOnMap(el, grid, prep, start, prior, view = null, covered = null, find = null) {
  const canvas = el.querySelector('canvas'), ctx = canvas.getContext('2d');
  const $ = s => el.querySelector(s);
  const shade = relief(grid);
  // map meters: x east and y south of a reference point (lat0, lon0), which
  // moves along when the map goes far away so the scale stays true there
  let lat0, lon0, mE, mN = 110540;
  const toM = (lat, lon) => [(lon - lon0) * mE, (lat0 - lat) * mN];
  const toLL = (x, y) => [lat0 - y / mN, lon0 + x / mE];
  // view: center (cx, cy) in map meters, s CSS px per meter, th the map turned clockwise
  let pin, cx, cy, s = 0.5, th = 0, dpr = 1;
  let type = 'satellite';
  try { const t = localStorage.getItem(TYPE_KEY); if (MAP_TYPES[t]) type = t; } catch { /* default */ }
  let lines, peaks, priorM, V, R0, R1;
  /** Put the reference point at (lat, lon), keeping everything where it is on screen. */
  function reframe(lat, lon) {
    const c = cx != null ? toLL(cx, cy) : [start.lat, start.lon], p = pin ? toLL(...pin) : [start.lat, start.lon];
    lat0 = lat; lon0 = lon; mE = 111320 * Math.cos(lat * Math.PI / 180);
    [cx, cy] = toM(...c); pin = toM(...p);
    lines = [
      ...prep.runs.filter(r => !r.area).map(r => ({ pts: r.pts.map(q => toM(q[0], q[1])), color: CLASS_COLOR[r.cls], w: 1.6, run: true })),
      ...prep.lifts.map(l => ({ pts: l.pts.map(q => toM(q[0], q[1])), color: LIFT, w: 2.4, name: l.name })),
    ];
    peaks = prep.peaks.map(q => ({ ...q, m: toM(q.lat, q.lon) }));
    priorM = prior ? toM(prior.lat, prior.lon) : null;
    // the matched view: apex, unit direction (map meters, y south), half angle
    V = view ? { o: toM(view.lat, view.lon), u: [Math.sin(view.yaw * Math.PI / 180), -Math.cos(view.yaw * Math.PI / 180)], half: view.hfov * Math.PI / 360 } : null;
    R0 = toM(grid.north, grid.west); R1 = toM(grid.south, grid.east);
  }
  reframe(start.lat, start.lon);
  const recenterIfFar = () => { if (Math.hypot(cx, cy) > 30000) reframe(...toLL(cx, cy)); };
  const along = k => [V.o[0] + V.u[0] * k, V.o[1] + V.u[1] * k];
  const size = () => [canvas.clientWidth, canvas.clientHeight];
  const fwd = (x, y) => {
    const [w, h] = size(), dx = (x - cx) * s, dy = (y - cy) * s, c = Math.cos(th), n = Math.sin(th);
    return [w / 2 + dx * c - dy * n, h / 2 + dx * n + dy * c];
  };
  const inv = (sx, sy) => {
    const [w, h] = size(), dx = (sx - w / 2) / s, dy = (sy - h / 2) / s, c = Math.cos(th), n = Math.sin(th);
    return [cx + dx * c + dy * n, cy - dx * n + dy * c];
  };

  let queued = false;
  const redraw = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); } };

  function drawTiles(w, h) {
    const t = MAP_TYPES[type];
    if (!t.url) return;
    // tile zoom whose pixels are about the size of the screen's
    const z = Math.max(2, Math.min(t.max, Math.ceil(Math.log2(156543 * Math.cos(lat0 * Math.PI / 180) * s * dpr))));
    const corners = [inv(0, 0), inv(w, 0), inv(0, h), inv(w, h)].map(([x, y]) => toLL(x, y));
    const la = corners.map(c => c[0]), lo = corners.map(c => c[1]);
    const x0 = Math.floor(lonTile(Math.min(...lo), z)), x1 = Math.floor(lonTile(Math.max(...lo), z));
    const y0 = Math.floor(latTile(Math.max(...la), z)), y1 = Math.floor(latTile(Math.min(...la), z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) return;
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const url = t.url.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
      let img = tiles.get(url);
      if (!img) {
        img = new Image();
        img.onload = redraw;
        img.src = url;
        tiles.set(url, img);
        if (tiles.size > 600) tiles.delete(tiles.keys().next().value);
      }
      if (!img.complete || !img.naturalWidth) continue;
      const [ax, ay] = toM(tileLat(ty, z), tileLon(tx, z)), [bx, by] = toM(tileLat(ty + 1, z), tileLon(tx + 1, z));
      // a hair of overlap hides the seams between tiles
      ctx.drawImage(img, ax, ay, bx - ax + 0.6 / s, by - ay + 0.6 / s);
    }
  }

  function draw() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const [w, h] = size();
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0c1a22'; ctx.fillRect(0, 0, w, h);
    // the map itself, in map meters
    ctx.save();
    ctx.translate(w / 2, h / 2); ctx.rotate(th); ctx.scale(s, s); ctx.translate(-cx, -cy);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(shade, R0[0], R0[1], R1[0] - R0[0], R1[1] - R0[1]);
    drawTiles(w, h);
    ctx.restore();
    // lines and labels in screen pixels, so widths and text stay upright
    const dark = MAP_TYPES[type].dark;
    ctx.lineJoin = ctx.lineCap = 'round';
    for (const l of lines) {
      ctx.beginPath();
      l.pts.forEach(([x, y], i) => { const [X, Y] = fwd(x, y); if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
      if (dark && l.run && l.color === CLASS_COLOR[3]) { ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = l.w + 1.6; ctx.stroke(); }
      ctx.strokeStyle = l.color; ctx.lineWidth = l.w; ctx.stroke();
    }
    ctx.font = '600 12px "Barlow Condensed", "Helvetica Neue", Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
    if (s > 0.12) for (const p of peaks) {
      const [x, y] = fwd(p.m[0], p.m[1]);
      if (x < -50 || y < -20 || x > w + 50 || y > h + 20) continue;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 4.5, y + 3); ctx.lineTo(x - 4.5, y + 3); ctx.fill();
      ctx.fillText(p.name, x + 7, y);
    }
    if (s > 0.35) {
      ctx.fillStyle = '#e9dcff';
      for (const l of lines) if (l.name) { const m = l.pts[l.pts.length >> 1], [x, y] = fwd(m[0], m[1]); ctx.fillText(l.name, x + 6, y); }
    }
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
    if (V) {
      // the view the skyline match found, and the line of spots that keep it
      const reach = 4000, rot = a => [V.u[0] * Math.cos(a) - V.u[1] * Math.sin(a), V.u[0] * Math.sin(a) + V.u[1] * Math.cos(a)];
      const [ax, ay] = fwd(...V.o), l = rot(-V.half), r = rot(V.half);
      ctx.beginPath(); ctx.moveTo(ax, ay);
      ctx.lineTo(...fwd(V.o[0] + l[0] * reach, V.o[1] + l[1] * reach));
      ctx.lineTo(...fwd(V.o[0] + r[0] * reach, V.o[1] + r[1] * reach));
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fill();
      // a dark edge under the light one, so it shows on snow and on forest
      ctx.strokeStyle = 'rgba(8,16,22,0.6)'; ctx.lineWidth = 3.5; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(...fwd(...along(-2500))); ctx.lineTo(...fwd(...along(reach)));
      ctx.strokeStyle = 'rgba(8,16,22,0.65)'; ctx.lineWidth = 4.5; ctx.stroke();
      ctx.setLineDash([9, 6]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.2; ctx.stroke();
      ctx.setLineDash([]);
    }
    if (priorM) {
      // the photo's own fix and its stated error
      const [x, y] = fwd(priorM[0], priorM[1]);
      ctx.strokeStyle = 'rgba(255,216,74,0.95)'; ctx.fillStyle = 'rgba(255,216,74,0.18)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, Math.max(4, (prior.acc || 0) * s), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    // the pin
    const [px, py] = fwd(pin[0], pin[1]);
    ctx.fillStyle = '#3fb6ff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.bezierCurveTo(px - 10, py - 14, px - 10, py - 28, px, py - 28); ctx.bezierCurveTo(px + 10, py - 28, px + 10, py - 14, px, py); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px, py - 19, 3.5, 0, Math.PI * 2); ctx.fill();
    // scale bar, bottom left above the buttons
    const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6].find(m => m * s > 60) || 1e6;
    const sy = h - 196;
    ctx.fillStyle = 'rgba(12,20,27,0.7)'; ctx.fillRect(10, sy - 14, nice * s + 16, 20);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(18, sy); ctx.lineTo(18 + nice * s, sy); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, 22, sy - 7);
    // the compass needle turns with the map
    $('#pickNorth svg').style.transform = `rotate(${th}rad)`;
    const [plat, plon] = toLL(...pin);
    $('#pickOk').textContent = !covered || covered(plat, plon) ? 'Use this spot' : 'Use · get map';
  }

  // Keep the map point under screen point (ax, ay) under (bx, by) after a zoom by f and a turn by dt.
  const gesture = (ax, ay, bx, by, f, dt) => {
    const m = inv(ax, ay);
    s = Math.min(8, Math.max(0.00005, s * f)); th += dt;
    const [w, h] = size(), dx = (bx - w / 2) / s, dy = (by - h / 2) / s, c = Math.cos(th), n = Math.sin(th);
    cx = m[0] - (dx * c + dy * n); cy = m[1] - (-dx * n + dy * c);
  };
  const ptrs = new Map();
  let tap = null, twist = 0, turning = false;
  const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const down = e => {
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, local(e));
    tap = ptrs.size === 1 ? { p: local(e), t: performance.now() } : null;
    if (ptrs.size === 2) { twist = 0; turning = false; }
  };
  const move = e => {
    if (!ptrs.has(e.pointerId)) return;
    const before = [...ptrs.values()].map(p => [...p]);
    ptrs.set(e.pointerId, local(e));
    const after = [...ptrs.values()];
    if (ptrs.size === 1) {
      gesture(before[0][0], before[0][1], after[0][0], after[0][1], 1, 0);
      if (tap && Math.hypot(after[0][0] - tap.p[0], after[0][1] - tap.p[1]) > 8) tap = null;
    } else if (ptrs.size === 2) {
      const [a, b] = before, [a2, b2] = after;
      const f = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]) / Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
      let dt = Math.atan2(b2[1] - a2[1], b2[0] - a2[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]);
      dt = Math.atan2(Math.sin(dt), Math.cos(dt));
      if (!turning) { twist += dt; if (Math.abs(twist) > TURN_START) { turning = true; dt = twist; } else dt = 0; }
      gesture((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2, f, dt);
    }
    redraw();
  };
  const up = e => {
    ptrs.delete(e.pointerId);
    if (!ptrs.size) recenterIfFar();
    if (tap && e.type === 'pointerup' && performance.now() - tap.t < 600) {
      const [x, y] = local(e);
      pin = inv(x, y);
      if (V) {
        // near the line of spots that keep the skyline match: land on it
        const k = (pin[0] - V.o[0]) * V.u[0] + (pin[1] - V.o[1]) * V.u[1], on = along(k), [lx, ly] = fwd(...on);
        if (Math.hypot(lx - x, ly - y) < 28) pin = on;
      }
      redraw();
    }
    tap = null;
  };
  const wheel = e => {
    e.preventDefault();
    const [x, y] = local(e);
    // Shift + wheel turns the map, as two fingers do
    if (e.shiftKey) gesture(x, y, x, y, 1, (e.deltaY || e.deltaX) * 0.003);
    else gesture(x, y, x, y, Math.exp(-e.deltaY * 0.002), 0);
    recenterIfFar();
    redraw();
  };

  // map type menu in the corner
  const menu = $('#pickTypes');
  const syncType = () => {
    $('#pickCredit').textContent = MAP_TYPES[type].credit;
    for (const b of menu.children) b.setAttribute('aria-pressed', b.dataset.type === type);
  };
  menu.replaceChildren(...Object.entries(MAP_TYPES).map(([k, t]) => {
    const b = document.createElement('button');
    b.dataset.type = k; b.textContent = t.name;
    b.onclick = () => {
      type = k; menu.hidden = true; syncType(); redraw();
      try { localStorage.setItem(TYPE_KEY, k); } catch { /* not kept */ }
    };
    return b;
  }));
  menu.hidden = true;
  syncType();

  return new Promise(resolve => {
    const done = res => {
      el.hidden = true;
      canvas.onpointerdown = canvas.onpointermove = canvas.onpointerup = canvas.onpointercancel = null;
      canvas.removeEventListener('wheel', wheel);
      $('#pickFind').onsubmit = null;
      window.removeEventListener('resize', redraw);
      resolve(res);
    };
    canvas.onpointerdown = e => { menu.hidden = true; down(e); };
    canvas.onpointermove = move; canvas.onpointerup = up; canvas.onpointercancel = up;
    canvas.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('resize', redraw);
    $('#pickNorth').onclick = () => { th = 0; redraw(); };
    $('#pickType').onclick = () => { menu.hidden = !menu.hidden; };
    $('#pickOk').onclick = () => {
      const [lat, lon] = toLL(pin[0], pin[1]);
      done({ lat, lon, acc: Math.max(5, TAP_PX / s) });
    };
    $('#pickCancel').onclick = () => done(null);
    $('#pickPhoto').onclick = () => done('photo');
    // jump to a place by name, and drop the pin there
    const box = $('#pickPlace');
    $('#pickFind').hidden = !find;
    box.value = '';
    $('#pickFind').onsubmit = async e => {
      e.preventDefault();
      const q = box.value.trim();
      if (!q) return;
      box.blur();
      const hint = $('#pickHint'), was = hint.textContent;
      hint.textContent = 'Searching…';
      let hit = null;
      try { hit = await find(q); } catch { /* reported below */ }
      if (el.hidden) return;
      if (!hit) { hint.textContent = `Nothing found for "${q}". ${was}`; return; }
      hint.textContent = was;
      reframe(hit.lat, hit.lon);
      cx = cy = 0; pin = [0, 0]; s = Math.max(s, 0.12);
      redraw();
    };
    el.hidden = false;
    redraw();
  });
}
