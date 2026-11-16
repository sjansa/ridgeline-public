// terrain.js -- DEM access, local geodesy, and the per-position panorama.
//
// The panorama is the JS port of ridgeline_svg.march(): rays fan out from the
// viewer, and a sample is on the visible surface when its elevation angle
// beats everything in front of it. Instead of band envelopes it keeps a full
// 360-degree raster (azimuth x tan(elevation)) of visible-surface distance and
// run ownership, which is what the camera overlay needs: occlusion tests for
// lifts and labels, per-pixel run shading, and ridge lines (the skyline plus
// interior depth discontinuities).
//
// No DOM here: this module also runs under node for the tests.

export const D2R = Math.PI / 180, R2D = 180 / Math.PI, TAU = 2 * Math.PI;
export const R_EARTH = 6371008.8;
export const K_REFRACTION = 0.13;          // survey default; see HANDOFF.md
export const R_EFF = R_EARTH / (1 - K_REFRACTION);
const WGS84_A = 6378137.0, WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

// ------------------------------------------------------------ local geodesy

/** Tangent-plane frame at a viewpoint. e/n are meters east/north of it. */
export function localFrame(lat0, lon0) {
  const p = lat0 * D2R, s = Math.sin(p), c = Math.cos(p);
  const w = Math.sqrt(1 - WGS84_E2 * s * s);
  return { lat0, lon0, M: WGS84_A * (1 - WGS84_E2) / (w * w * w), N: WGS84_A / w, c, t: s / c };
}

// Second-order ENU -> geodetic. First order alone (fixed meters per degree)
// ignores meridian convergence and skews bearings ~0.2 deg at 30 km; these
// two extra terms bring it within ~0.002 deg of the exact ellipsoidal ENU.
export function enuToLon(fr, e, n) {
  return fr.lon0 + (e / (fr.N * fr.c)) * (1 + n * fr.t / fr.M) * R2D;
}
export function enuToLat(fr, e, n) {
  return fr.lat0 + (n / fr.M - e * e * fr.t / (2 * fr.M * fr.N)) * R2D;
}
/** Inverse of the above; out = [e, n]. */
export function llToEnu(fr, lat, lon, out) {
  const dl = (lon - fr.lon0) * D2R, dp = (lat - fr.lat0) * D2R;
  let n = dp * fr.M, e = dl * fr.N * fr.c;
  for (let i = 0; i < 3; i++) {
    e = dl * fr.N * fr.c / (1 + n * fr.t / fr.M);
    n = (dp + e * e * fr.t / (2 * fr.M * fr.N)) * fr.M;
  }
  out[0] = e; out[1] = n;
  return out;
}

// ----------------------------------------------------------------- DEM grids

/** Node-registered lat/lon lattice of quarter-meter Uint16 elevations. */
export class Grid {
  constructor(meta, data, unit) {
    Object.assign(this, meta);
    this.data = data; this.unit = unit;
    this.dx = (this.east - this.west) / (this.cols - 1);
    this.dy = (this.north - this.south) / (this.rows - 1);
    const lat = (this.north + this.south) / 2;
    this.cellE = this.dx * 111320 * Math.cos(lat * D2R);   // meters per column
    this.cellN = this.dy * 110540;                          // meters per row
  }
  /** Bilinear elevation in meters, NaN outside the grid. */
  sample(lon, lat) {
    const fx = (lon - this.west) / this.dx, fy = (this.north - lat) / this.dy;
    if (!(fx >= 0 && fy >= 0 && fx <= this.cols - 1 && fy <= this.rows - 1)) return NaN;
    let c = fx | 0, r = fy | 0;
    if (c >= this.cols - 1) c = this.cols - 2;
    if (r >= this.rows - 1) r = this.rows - 2;
    const tx = fx - c, ty = fy - r, i = r * this.cols + c, d = this.data;
    const a = d[i] + (d[i + 1] - d[i]) * tx;
    const b = d[i + this.cols] + (d[i + this.cols + 1] - d[i + this.cols]) * tx;
    return (a + (b - a) * ty) * this.unit;
  }
  /** Nearest cell index, or -1 outside. */
  cell(lon, lat) {
    const c = Math.round((lon - this.west) / this.dx), r = Math.round((this.north - lat) / this.dy);
    return (c < 0 || r < 0 || c >= this.cols || r >= this.rows) ? -1 : r * this.cols + c;
  }
  contains(lon, lat) {
    return lon >= this.west && lon <= this.east && lat >= this.south && lat <= this.north;
  }
}

/**
 * Lookup of a per-cell label (0 = none) that cannot be averaged: the non-zero
 * label carrying the most bilinear weight among the four surrounding cells.
 * Boundaries between labels then run straight or diagonally between cell
 * centers instead of stepping round each 10 m cell.
 */
export function gridVote(g, arr, lon, lat) {
  const fx = (lon - g.west) / g.dx, fy = (g.north - lat) / g.dy;
  if (!(fx >= 0 && fy >= 0 && fx <= g.cols - 1 && fy <= g.rows - 1)) return 0;
  let c = fx | 0, r = fy | 0;
  if (c >= g.cols - 1) c = g.cols - 2;
  if (r >= g.rows - 1) r = g.rows - 2;
  const tx = fx - c, ty = fy - r, i = r * g.cols + c;
  const a = arr[i], b = arr[i + 1], d = arr[i + g.cols], e = arr[i + g.cols + 1];
  const wa = (1 - tx) * (1 - ty), wb = tx * (1 - ty), wd = (1 - tx) * ty, we = tx * ty;
  let best = 0, bw = 0;
  const sa = a ? wa + (b === a ? wb : 0) + (d === a ? wd : 0) + (e === a ? we : 0) : 0;
  if (sa > bw) { bw = sa; best = a; }
  const sb = b && b !== a ? wb + (d === b ? wd : 0) + (e === b ? we : 0) : 0;
  if (sb > bw) { bw = sb; best = b; }
  const sd = d && d !== a && d !== b ? wd + (e === d ? we : 0) : 0;
  if (sd > bw) { bw = sd; best = d; }
  if (e && e !== a && e !== b && e !== d && we > bw) best = e;
  return best;
}

/**
 * Bilinear lookup of a per-cell array on a grid. Values above `cap` (and
 * Infinity) count as `cap`; returns `cap` outside the grid.
 */
export function gridBilinear(g, arr, lon, lat, cap) {
  const fx = (lon - g.west) / g.dx, fy = (g.north - lat) / g.dy;
  if (!(fx >= 0 && fy >= 0 && fx <= g.cols - 1 && fy <= g.rows - 1)) return cap;
  let c = fx | 0, r = fy | 0;
  if (c >= g.cols - 1) c = g.cols - 2;
  if (r >= g.rows - 1) r = g.rows - 2;
  const tx = fx - c, ty = fy - r, i = r * g.cols + c;
  const v = k => { const x = arr[k]; return x < cap ? x : cap; };
  const a = v(i) + (v(i + 1) - v(i)) * tx, b = v(i + g.cols) + (v(i + g.cols + 1) - v(i + g.cols)) * tx;
  return a + (b - a) * ty;
}

/** Fine grid over the resorts, coarse grid for the distant skyline. */
export class Terrain {
  constructor(fine, coarse) { this.fine = fine; this.coarse = coarse; }
  elev(lon, lat) {
    const z = this.fine.sample(lon, lat);
    return z === z ? z : this.coarse.sample(lon, lat);
  }
}

// ----------------------------------------------------------------- panorama

export const PANO_T_MAX = 1.0;      // tan(elevation) at the raster's top row
export const PANO_T_MIN = -1.0;

const NEAR_FADE = [1, 5];        // meters: run shading is faintest inside the first, full beyond the second
const NEAR_MIN = 0.25;           // shading strength at the near end of the fade

function nearFade(d) {
  const f = Math.min(1, Math.max(0, (d - NEAR_FADE[0]) / (NEAR_FADE[1] - NEAR_FADE[0])));
  return NEAR_MIN + (1 - NEAR_MIN) * f;
}

/**
 * Build the panorama for one viewpoint.
 *
 * opts: eye (m above ground, default 1.7), eyeAlt (absolute meters, overrides
 * eye), na (azimuth columns), nt (rows), maxDist, stepMin, stepK (radial step
 * = max(stepMin, d * stepK)), ownerGrid/owner (Uint16 per fine-grid cell).
 *
 * Returns {na, nt, dist, owner, skyT, skyD, crests, frame, hEye, z0}:
 *   dist[row * na + col]   horizontal meters to the visible surface, 0 = sky
 *   owner[...]             run index + 1 at that surface point, 0 = none
 *   ownerCost[...]         255 on that run's centerline falling to 0 at its reach
 *   skyT/skyD[col]         tan(elevation) and distance of the skyline
 *   crests                 [{col, t, d, dFar}] interior depth discontinuities
 */
export function buildPano(terrain, lat0, lon0, opts = {}) {
  const na = opts.na || 3600, nt = opts.nt || 1200;
  const maxDist = opts.maxDist || 45000;
  const stepMin = opts.stepMin || 7, stepK = opts.stepK || 0.003;
  const fr = localFrame(lat0, lon0);
  const z0 = terrain.elev(lon0, lat0);
  if (!(z0 === z0)) throw new Error('Viewpoint is outside the terrain pack.');
  const hEye = opts.eyeAlt != null ? Math.max(opts.eyeAlt, z0 + 0.5) : z0 + (opts.eye ?? 1.7);

  const ds = [];
  for (let d = 2; d < maxDist; d += Math.max(stepMin, d * stepK)) ds.push(d);
  const nd = ds.length;
  const dist = new Float32Array(ds), drop = new Float32Array(nd);
  for (let k = 0; k < nd; k++) drop[k] = dist[k] * dist[k] / (2 * R_EFF);

  const dT = (PANO_T_MAX - PANO_T_MIN) / nt;
  const rasD = new Float32Array(na * nt);
  const rasO = new Uint16Array(na * nt);
  const rasC = new Uint8Array(na * nt);
  const rasS = new Uint8Array(na * nt).fill(255);  // slope in degrees, 255 = unknown
  const slopeGrid = opts.slope;          // 255 on a run's centerline, 0 at its reach
  const skyT = new Float32Array(na), skyD = new Float32Array(na);
  const crests = [];
  const og = opts.ownerGrid, own = opts.owner, ownCost = opts.ownerCost, reach = opts.reach || 150;
  const fine = terrain.fine, coarse = terrain.coarse;
  const kLon = R2D / (fr.N * fr.c), kLat = R2D / fr.M;
  const tOverM = fr.t / fr.M, k2 = fr.t / (2 * fr.M * fr.N) * R2D;

  for (let a = 0; a < na; a++) {
    const az = a * TAU / na, sa = Math.sin(az), ca = Math.cos(az);
    let maxT = -Infinity, dMax = 0, prevT = 0, prevD = 0, prevVis = false, rOld = nt;
    let fineLeft = false;
    for (let k = 0; k < nd; k++) {
      const d = dist[k], e = d * sa, n = d * ca;
      const lon = lon0 + e * kLon * (1 + n * tOverM);
      const lat = lat0 + n * kLat - e * e * k2;
      let z = fineLeft ? NaN : fine.sample(lon, lat);
      if (!(z === z)) {
        // A ray that has left the fine grid never re-enters it (convex bbox),
        // unless the viewer itself stands outside it.
        if (k > 0 && !fineLeft && fine.contains(lon0, lat0)) fineLeft = true;
        z = coarse.sample(lon, lat);
        if (!(z === z)) { if (fineLeft) break; continue; }
      }
      const t = (z - hEye - drop[k]) / d;
      if (t > maxT) {
        // Reappearing well behind the last visible sample: that sample was a
        // crest hiding the ground in between.
        if (dMax > 0 && d - dMax > Math.max(40, 0.08 * dMax))
          crests.push({ col: a, t: maxT, d: dMax, dFar: d });
        let rNew = Math.ceil((PANO_T_MAX - t) / dT - 0.5);
        if (rNew < 0) rNew = 0;
        if (rNew < rOld) {
          const ci = og && own ? og.cell(lon, lat) : -1;
          const o = ci < 0 ? 0 : gridVote(og, own, lon, lat);
          // Coverage is interpolated between cells so a run's edge is a smooth
          // contour, not the staircase of the 10 m grid.
          // Shading thins out linearly over the last few meters to the viewer's
          // feet (see nearFade), applied per row below.
          const ocFull = o && ownCost ? 255 * (1 - gridBilinear(og, ownCost, lon, lat, reach) / reach) : (o ? 255 : 0);
          const sl = slopeGrid && ci >= 0 ? Math.min(90, gridBilinear(og, slopeGrid, lon, lat, 90)) : 255;
          const smooth = prevVis && t > prevT;
          for (let r = rNew; r < rOld; r++) {
            let dr = d;
            if (smooth) {
              const tr = PANO_T_MAX - (r + 0.5) * dT;
              dr = prevD + (d - prevD) * Math.min(1, Math.max(0, (tr - prevT) / (t - prevT)));
            }
            rasD[r * na + a] = dr; rasO[r * na + a] = o; rasC[r * na + a] = o ? Math.max(1, ocFull * nearFade(dr)) : 0; rasS[r * na + a] = sl;
          }
          rOld = rNew;
        }
        maxT = t; dMax = d; prevVis = true;
      } else prevVis = false;
      prevT = t; prevD = d;
    }
    skyT[a] = maxT > -Infinity ? maxT : PANO_T_MIN; skyD[a] = dMax;
  }
  return { na, nt, dT, dist: rasD, owner: rasO, ownerCost: rasC, slope: rasS, skyT, skyD, crests, frame: fr, hEye, z0, lat0, lon0 };
}

/** Column index for an azimuth in radians. */
export function panoCol(p, az) {
  let a = Math.round(az * p.na / TAU) % p.na;
  return a < 0 ? a + p.na : a;
}

/** Visible-surface distance along a direction; 0 for sky, -1 below the raster. */
export function panoDist(p, az, t) {
  const a = panoCol(p, az);
  if (t > p.skyT[a]) return 0;
  const r = Math.floor((PANO_T_MAX - t) / p.dT);
  if (r >= p.nt) return -1;
  return r < 0 ? 0 : p.dist[r * p.na + a];
}

/** Is a point at (az, tan elevation, distance) in front of the terrain? */
export function panoVisible(p, az, t, d, tol = 12) {
  const a = panoCol(p, az);
  if (t > p.skyT[a]) return true;
  const r = Math.floor((PANO_T_MAX - t) / p.dT);
  if (r < 0) return true;
  if (r >= p.nt) return false;
  const D = p.dist[r * p.na + a];
  return D === 0 || d <= D * 1.03 + tol;
}

/**
 * Direction from the pano's eye to a geodetic point: {az, t, d} with t the
 * tangent of the apparent elevation (curvature and refraction included).
 */
export function panoLook(p, lat, lon, z, out = {}) {
  const en = llToEnu(p.frame, lat, lon, _en);
  const d = Math.hypot(en[0], en[1]);
  out.d = d;
  out.az = Math.atan2(en[0], en[1]);
  if (out.az < 0) out.az += TAU;
  out.t = d > 0.01 ? (z - p.hEye - d * d / (2 * R_EFF)) / d : -1e9;
  return out;
}
const _en = [0, 0];

/**
 * Chain crest points on neighboring rays into ridge polylines.
 * Returns [{cols:Int32Array, t:Float32Array, d:Float32Array, jump:number}].
 */
export function chainCrests(p, minLen = 10) {
  const byCol = new Map();
  for (const c of p.crests) {
    if (!byCol.has(c.col)) byCol.set(c.col, []);
    byCol.get(c.col).push(c);
  }
  const done = [];
  let open = [];                                  // chains whose last point is in col-1 or col-2
  const tolT = 3.5 * p.dT;
  for (let col = 0; col < p.na; col++) {
    const here = byCol.get(col) || [];
    const used = new Set(), next = [];
    for (const ch of open) {
      const last = ch[ch.length - 1];
      let best = -1, bd = Infinity;
      for (let i = 0; i < here.length; i++) {
        if (used.has(i)) continue;
        const c = here[i];
        const dt = Math.abs(c.t - last.t);
        if (dt > tolT * (col - last.col) || Math.abs(Math.log(c.d / last.d)) > 0.12) continue;
        if (dt < bd) { bd = dt; best = i; }
      }
      if (best >= 0) { used.add(best); ch.push(here[best]); next.push(ch); }
      else if (col - last.col < 2) next.push(ch);   // tolerate a one-ray gap
      else done.push(ch);
    }
    for (let i = 0; i < here.length; i++) if (!used.has(i)) next.push([here[i]]);
    open = next;
  }
  done.push(...open);
  const out = [];
  for (const ch of done) {
    if (ch.length < minLen) continue;
    let jump = 0;
    for (const c of ch) jump += Math.log(c.dFar / c.d);
    out.push({
      cols: Int32Array.from(ch, c => c.col),
      t: Float32Array.from(ch, c => c.t),
      d: Float32Array.from(ch, c => c.d),
      jump: jump / ch.length,
    });
  }
  return out;
}
