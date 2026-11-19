// runs.js -- pack loading, feature preparation, and run ownership.
//
// OSM mostly maps pistes as centerlines. "Ownership" turns those into areas on
// the fine DEM grid: every cell within reach of a centerline is assigned to
// the run that reaches it most cheaply, where crossing a ridge or a break in
// slope is expensive. So in an open bowl the boundary between two runs settles
// on the terrain feature between them. The camera then trims the result to
// actual snow (see render.js), which is what bounds a run cut through trees.

import { Grid, Terrain } from './terrain.js?v=1119.0458-0b12c9f';

export const DIFFICULTY = {
  novice: 1, easy: 1, intermediate: 2, advanced: 3, expert: 4, freeride: 4, extreme: 4, unknown: 5,
};
export const CLASS_NAME = ['', 'Green', 'Blue', 'Black', 'Double black', 'Unrated'];
export const CLASS_COLOR = ['#000000', '#2fa84f', '#2d7ff9', '#16181c', '#16181c', '#8a8f98'];
// Tint used on snow. Black runs tint dark slate so they read against white.
export const CLASS_TINT = [[0, 0, 0], [0.13, 0.72, 0.32], [0.15, 0.48, 1.0], [0.16, 0.17, 0.22], [0.05, 0.05, 0.07], [0.5, 0.52, 0.56]];

export const MAX_REACH = 150;       // cost-meters a centerline may claim sideways
// Mapped areas start at this cost, not 0, so a named line through one (a
// traverse across a bowl) wins a corridor about this wide either side instead
// of a one-cell thread.
const AREA_COST = 30;
// Lift cables. OSM maps an aerial lift as its stations and towers, so the cable
// is drawn as straight spans between those points with a little sag, not laid
// over the terrain: a tram's span can pass 100 m above a gully. Heights are
// typical figures in meters: [tower top, station, least clearance mid-span].
const CABLE_HEIGHT = {
  cable_car: [18, 8, 6], gondola: [12, 6, 5], mixed_lift: [12, 6, 5], chair_lift: [10, 5, 4],
  drag_lift: [3, 3, 2], 't-bar': [3, 3, 2], 'j-bar': [3, 3, 2], platter: [3, 3, 2], rope_tow: [1, 1, 1], magic_carpet: [0.5, 0.5, 0.5],
};
const CABLE_SAG = 0.025;            // mid-span sag as a fraction of span length

/** Fetch a pack directory -> {meta, terrain, features}. */
export async function loadPack(base, fetchBin, fetchJson) {
  const meta = await fetchJson(base + 'pack.json');
  const [fb, cb, features] = await Promise.all([
    fetchBin(base + meta.fine.file), fetchBin(base + meta.coarse.file),
    fetchJson(base + meta.features),
  ]);
  const fine = new Grid(meta.fine, new Uint16Array(fb), meta.demUnit);
  const coarse = new Grid(meta.coarse, new Uint16Array(cb), meta.demUnit);
  return { meta, terrain: new Terrain(fine, coarse), features };
}

/** Insert points so no segment is longer than `maxM` meters. pts = [[lat, lon], ...]. */
export function densify(pts, maxM = 15) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const [la, lo] = pts[i];
    if (i > 0) {
      const [pa, po] = pts[i - 1];
      const d = Math.hypot((la - pa) * 110540, (lo - po) * 111320 * Math.cos(la * Math.PI / 180));
      const n = Math.ceil(d / maxM);
      for (let k = 1; k < n; k++) out.push([pa + (la - pa) * k / n, po + (lo - po) * k / n]);
    }
    out.push([la, lo]);
  }
  return out;
}

/**
 * Prepare lifts, runs and peaks for projection: densified geometry with
 * elevations. Lifts hang between their towers (see cable).
 */
export function prepareFeatures(features, terrain) {
  const lifts = features.lifts.map((l, i) => {
    const { pts, z } = cable(l.pts, l.type, terrain);
    return { kind: 'lift', index: i, name: l.name || '', type: l.type, pts, z };
  }).filter(l => l.pts.length > 1 && l.z.every(v => v === v));
  const runs = features.runs.map((r, i) => {
    const pts = densify(r.pts, 15);
    const z = pts.map(p => terrain.elev(p[1], p[0]) + 0.5);
    return {
      kind: 'run', index: i, name: r.name || '', cls: DIFFICULTY[r.difficulty] || 5,
      area: !!r.area, pts, z, pitch: r.area ? null : runPitch(pts, z),
    };
  });
  const peaks = (features.peaks || []).map(p => ({ ...p }));
  return { lifts, runs, peaks };
}

/**
 * A lift's cable: spans between its mapped stations and towers, sagging a
 * little, never closer to the ground than the least clearance. -> {pts, z}
 */
export function cable(supports, type, terrain, stepM = 25) {
  const [tower, station, clear] = CABLE_HEIGHT[type] || CABLE_HEIGHT.chair_lift;
  const n = supports.length, top = supports.map((p, i) => terrain.elev(p[1], p[0]) + (i === 0 || i === n - 1 ? station : tower));
  const pts = [], z = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const a = supports[i - 1], b = supports[i];
      const L = Math.hypot((b[0] - a[0]) * 110540, (b[1] - a[1]) * 111320 * Math.cos(b[0] * Math.PI / 180));
      const m = Math.ceil(L / stepM);
      for (let k = 1; k < m; k++) {
        const f = k / m, p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        const zc = top[i - 1] + (top[i] - top[i - 1]) * f - 4 * CABLE_SAG * L * f * (1 - f);
        pts.push(p); z.push(Math.max(zc, terrain.elev(p[1], p[0]) + clear));
      }
    }
    pts.push(supports[i]); z.push(top[i]);
  }
  return { pts, z };
}

/** Slope angle in whole degrees for every cell of a grid. */
export function buildSlope(grid) {
  const { cols, rows, data, unit, cellE, cellN } = grid;
  const out = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    const cw = c > 0 ? i - 1 : i, ce = c < cols - 1 ? i + 1 : i;
    const rn = r > 0 ? i - cols : i, rs = r < rows - 1 ? i + cols : i;
    const gx = (data[ce] - data[cw]) * unit / ((ce - cw) * cellE);
    const gy = (data[rn] - data[rs]) * unit / (((rs - rn) / cols) * cellN);
    out[i] = Math.round(Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI);
  }
  return out;
}

/** Steepest sustained pitch along a centerline: 90th percentile over ~45 m spans, degrees. */
function runPitch(pts, z) {
  const v = [];
  for (let i = 3; i < pts.length; i++) {
    const d = Math.hypot((pts[i][0] - pts[i - 3][0]) * 110540, (pts[i][1] - pts[i - 3][1]) * 111320 * Math.cos(pts[i][0] * Math.PI / 180));
    if (d > 5) v.push(Math.atan(Math.abs(z[i] - z[i - 3]) / d) * 180 / Math.PI);
  }
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  return Math.round(v[Math.floor(v.length * 0.9)]);
}

// Slope heat map: cool when gentle, full red from 30 degrees, purple beyond,
// near black at vertical. [degrees, r, g, b]
// Slope colors: [degrees, r, g, b, opacity 0..1]. Red where avalanches start
// (32°), then on through magenta to a bright violet for cliffs, all light
// enough to read as paint on the snow rather than shadow.
export const SLOPE_SCALES = {
  full: {
    name: 'Full range', ticks: [0, 15, 32, 45, 60, 90], lo: 0, hi: 90,
    stops: [
      [0, 40, 70, 200, 1], [8, 30, 150, 235, 1], [15, 40, 200, 170, 1], [20, 90, 205, 70, 1], [26, 250, 215, 40, 1],
      [29, 255, 140, 20, 1], [32, 255, 0, 0, 1], [40, 230, 0, 125, 1], [50, 195, 40, 235, 1], [65, 175, 95, 255, 1], [90, 215, 165, 255, 1],
    ],
  },
  // Detail where avalanches happen: nothing under 30°, green to 32°, yellow at 32° and up from there.
  avalanche: {
    name: 'Avalanche (30°+)', ticks: [32, 38, 45, 55], lo: 28, hi: 60,
    stops: [
      [29.6, 40, 200, 70, 0], [30, 40, 200, 70, 1], [31.95, 40, 200, 70, 1], [32, 250, 215, 40, 1], [35, 255, 140, 20, 1],
      [38, 255, 0, 0, 1], [42, 230, 0, 125, 1], [47, 195, 40, 235, 1], [55, 175, 95, 255, 1], [70, 215, 165, 255, 1], [90, 215, 165, 255, 1],
    ],
  },
};
/** [r, g, b, opacity] of a slope on a scale's stops. */
export function slopeColor(deg, S = SLOPE_SCALES.full.stops) {
  if (deg <= S[0][0]) return S[0].slice(1);
  let i = 1;
  while (i < S.length - 1 && deg > S[i][0]) i++;
  const a = S[i - 1], b = S[i], t = Math.min(1, Math.max(0, (deg - a[0]) / (b[0] - a[0])));
  return [1, 2, 3, 4].map(k => a[k] + (b[k] - a[k]) * t);
}

// Min-heap keyed by float cost, lazy deletion.
class Heap {
  constructor(cap = 1 << 16) { this.k = new Float32Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float32Array(this.n * 2), v = new Int32Array(this.n * 2);
      k.set(this.k); v.set(this.v); this.k = k; this.v = v;
    }
    let i = this.n++;
    const K = this.k, V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.k, V = this.v, top = V[0];
    this.topKey = K[0];
    const key = K[--this.n], val = V[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && K[c + 1] < K[c]) c++;
      if (K[c] >= key) break;
      K[i] = K[c]; V[i] = V[c]; i = c;
    }
    K[i] = key; V[i] = val;
    return top;
  }
}

/**
 * Assign fine-grid cells to runs.
 * Returns {owner: Uint16Array (run index + 1, 0 = none), cost: Float32Array}.
 */
export function buildOwnership(grid, runs, maxReach = MAX_REACH) {
  const { cols, rows, data, unit } = grid;
  const n = cols * rows;
  const owner = new Uint16Array(n);
  const cost = new Float32Array(n).fill(Infinity);
  const heap = new Heap();
  const seed = (i, id, c0) => {
    if (i >= 0 && c0 < cost[i]) { cost[i] = c0; owner[i] = id; heap.push(c0, i); }
  };

  for (const run of runs) {
    const id = run.index + 1;
    if (id > 65535) break;
    if (run.area) {
      fillPolygon(grid, run.pts, i => seed(i, id, AREA_COST));
      continue;
    }
    for (let k = 0; k < run.pts.length; k++) {
      const [la, lo] = run.pts[k];
      // Centerline points sit up to half a cell off a node; walk the segment
      // so the seeds are 8-connected.
      if (k > 0) {
        const [pa, po] = run.pts[k - 1];
        for (let s = 1; s < 4; s++) seed(grid.cell(po + (lo - po) * s / 4, pa + (la - pa) * s / 4), id, 0);
      }
      seed(grid.cell(lo, la), id, 0);
    }
  }

  // Terrain penalty per cell, computed on demand. The Laplacian is the change
  // in slope across the cell: negative on a ridge or roll-over, positive in a
  // gully or at the foot of a pitch. Both mark a boundary; ridges count double.
  const pen = new Float32Array(n).fill(-1);
  const cE = grid.cellE, cN = grid.cellN;
  const penalty = i => {
    if (pen[i] >= 0) return pen[i];
    const c = i % cols, r = (i / cols) | 0;
    let p = 0;
    if (c > 1 && r > 1 && c < cols - 2 && r < rows - 2) {
      // 2-cell stencil: the 10 m DEM is too smooth for a 1-cell Laplacian.
      const z = data[i] * unit;
      const lap = ((data[i - 2] + data[i + 2]) * unit - 2 * z) / (4 * cE * cE)
                + ((data[i - 2 * cols] + data[i + 2 * cols]) * unit - 2 * z) / (4 * cN * cN);
      p = 110 * Math.max(0, Math.abs(lap) - 0.004) + 110 * Math.max(0, -lap - 0.004);
      if (p > 10) p = 10;
    }
    pen[i] = p;
    return p;
  };

  const dC = [1, -1, 0, 0, 1, 1, -1, -1], dR = [0, 0, 1, -1, 1, -1, 1, -1];
  const diag = Math.hypot(cE, cN);
  const len = [cE, cE, cN, cN, diag, diag, diag, diag];
  while (heap.n) {
    const i = heap.pop(), ci = heap.topKey;
    if (ci > cost[i]) continue;
    const c = i % cols, r = (i / cols) | 0, id = owner[i];
    for (let k = 0; k < 8; k++) {
      const c2 = c + dC[k], r2 = r + dR[k];
      if (c2 < 0 || r2 < 0 || c2 >= cols || r2 >= rows) continue;
      const j = r2 * cols + c2;
      const cj = ci + len[k] * (1 + penalty(j));
      if (cj < cost[j] && cj <= maxReach) { cost[j] = cj; owner[j] = id; heap.push(cj, j); }
    }
  }
  smoothOwners(owner, cost, cols, rows);
  return { owner, cost };
}

/**
 * The cheapest-path fronts meet along ragged, cell-by-cell boundaries. Tidy
 * them with a few rounds of majority vote over a 7x7 window, leaving cells
 * next to their own centerline alone so a narrow run is never voted away.
 */
function smoothOwners(owner, cost, cols, rows) {
  const ids = new Uint16Array(49), cnt = new Uint8Array(49);
  let src = owner, dst = new Uint16Array(owner.length);
  for (let pass = 0; pass < 4; pass++) {
    dst.set(src);
    for (let r = 3; r < rows - 3; r++) for (let c = 3; c < cols - 3; c++) {
      const i = r * cols + c, me = src[i];
      if (!me || cost[i] < 12) continue;
      let n = 0, mixed = false;
      for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
        const o = src[i + dr * cols + dc];
        if (!o) continue;
        if (o !== me) mixed = true;
        let k = 0;
        while (k < n && ids[k] !== o) k++;
        if (k === n) { ids[n] = o; cnt[n] = 0; n++; }
        cnt[k]++;
      }
      if (!mixed) continue;
      let best = me, bc = 0;
      for (let k = 0; k < n; k++) if (cnt[k] > bc || cnt[k] === bc && ids[k] === me) { bc = cnt[k]; best = ids[k]; }
      dst[i] = best;
    }
    const t = src; src = dst; dst = t;
  }
  if (src !== owner) owner.set(src);
}

/** Scanline-fill a lat/lon ring onto grid cells. */
function fillPolygon(grid, ring, visit) {
  let rMin = Infinity, rMax = -Infinity;
  const xs = ring.map(p => (p[1] - grid.west) / grid.dx), ys = ring.map(p => (grid.north - p[0]) / grid.dy);
  for (const y of ys) { rMin = Math.min(rMin, y); rMax = Math.max(rMax, y); }
  rMin = Math.max(0, Math.ceil(rMin)); rMax = Math.min(grid.rows - 1, Math.floor(rMax));
  for (let r = rMin; r <= rMax; r++) {
    const hits = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if ((ys[i] > r) !== (ys[j] > r)) hits.push(xs[i] + (r - ys[i]) / (ys[j] - ys[i]) * (xs[j] - xs[i]));
    }
    hits.sort((a, b) => a - b);
    for (let h = 0; h + 1 < hits.length; h += 2) {
      const c0 = Math.max(0, Math.ceil(hits[h])), c1 = Math.min(grid.cols - 1, Math.floor(hits[h + 1]));
      for (let c = c0; c <= c1; c++) visit(r * grid.cols + c);
    }
  }
}
