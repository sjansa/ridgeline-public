// relocate.js -- move the viewpoint so dragged features land where they belong.
//
// Ridges kilometers away barely change over a hundred meters of walking, so
// they cannot say where along the line of sight a photo was taken; nearby
// lifts and runs can. The user drags a misplaced line onto the real thing in
// the picture (an "anchor": a world point and the pixel it should land on).
// This searches spots around the current one, standing on the ground, for
// the one that puts the anchors on their pixels while one rotation still
// keeps the matched skyline where it is.
//
// Cheap per spot: the skyline is treated as fixed points in space (from the
// current panorama's directions and distances), the camera rotation that
// best keeps them in place comes from Horn's closed-form quaternion fit, and
// nothing is re-rendered. No DOM.

import { llToEnu, enuToLat, enuToLon, R_EFF, TAU } from './terrain.js?v=1124.1623-cf16757';
import { Camera } from './camera.js?v=1124.1623-cf16757';

const RIDGE_TOL = 0.008;     // skyline drift worth one anchor miss of ANCHOR_TOL, in picture widths
const RIDGE_CAP = 0.015;     // a point that drifts further is probably mis-detected anyway
const ANCHOR_TOL = 0.008;    // picture widths
const PRIOR_M = 400;         // meters: a mild pull back toward where the user put the spot

/** Rotation (world -> camera rows) taking directions b[i] closest to a[i]. Horn 1987. */
function fitRotation(a, b, n, q) {
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  for (let i = 0; i < n * 3; i += 3) {
    const bx = b[i], by = b[i + 1], bz = b[i + 2], ax = a[i], ay = a[i + 1], az = a[i + 2];
    Sxx += bx * ax; Sxy += bx * ay; Sxz += bx * az;
    Syx += by * ax; Syy += by * ay; Syz += by * az;
    Szx += bz * ax; Szy += bz * ay; Szz += bz * az;
  }
  const N = [
    Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz,
  ];
  // largest eigenvector by power iteration, shifted so every eigenvalue is positive
  for (let k = 0; k < 16; k += 5) N[k] += n;
  let [w, x, y, z] = q;
  for (let it = 0; it < 40; it++) {
    const w2 = N[0] * w + N[1] * x + N[2] * y + N[3] * z;
    const x2 = N[4] * w + N[5] * x + N[6] * y + N[7] * z;
    const y2 = N[8] * w + N[9] * x + N[10] * y + N[11] * z;
    const z2 = N[12] * w + N[13] * x + N[14] * y + N[15] * z;
    const m = Math.hypot(w2, x2, y2, z2);
    w = w2 / m; x = x2 / m; y = y2 / m; z = z2 / m;
  }
  q[0] = w; q[1] = x; q[2] = y; q[3] = z;
  return [
    w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z,
  ];
}

/** Quaternion of a rotation matrix (to start the power iteration in the right place). */
function quatOf(R) {
  const t = R[0] + R[4] + R[8];
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; return [0.25 * s, (R[7] - R[5]) / s, (R[2] - R[6]) / s, (R[3] - R[1]) / s]; }
  if (R[0] > R[4] && R[0] > R[8]) { const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2; return [(R[7] - R[5]) / s, 0.25 * s, (R[1] + R[3]) / s, (R[2] + R[6]) / s]; }
  if (R[4] > R[8]) { const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2; return [(R[2] - R[6]) / s, (R[1] + R[3]) / s, 0.25 * s, (R[5] + R[7]) / s]; }
  const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2; return [(R[3] - R[1]) / s, (R[2] + R[6]) / s, (R[5] + R[7]) / s, 0.25 * s];
}

/**
 * Find a better spot.
 *
 * pano: the current panorama (its frame, eye height and skyline).
 * cam: the camera as matched there (R, fn, k1). aspect: picture height / width.
 * anchors: [{lat, lon, z, u, v}]: a world point (z meters above sea level) and
 *   where it belongs in the picture (u, v from 0 to 1 across and down).
 * terrain: for the ground height of each spot tried. eye: meters above ground.
 * opts.radius: how far to look, meters (default 250).
 *
 * Returns {lat, lon, R, moved (m), before, after: mean anchor miss in
 * picture widths, ridge: skyline drift in picture widths}.
 */
export function relocate(pano, cam, aspect, anchors, terrain, eye = 1.7, opts = {}) {
  const radius = opts.radius ?? 250, fr = pano.frame, en = [0, 0];
  const heading = Math.atan2(cam.R[6], cam.R[7]), half = Math.atan(0.5 / cam.fn) * 1.2;
  // skyline in front of the camera as points in space, relative to the current eye
  const pts = [];
  for (let k = Math.floor((heading - half) * pano.na / TAU); k <= Math.ceil((heading + half) * pano.na / TAU); k += 2) {
    const a = ((k % pano.na) + pano.na) % pano.na, d = pano.skyD[a];
    if (!(d > 300)) continue;
    const az = a * TAU / pano.na;
    pts.push(d * Math.sin(az), d * Math.cos(az), pano.skyT[a] * d);
  }
  const n = pts.length / 3;
  // where the matched camera sees them now, in camera coordinates
  const R0 = cam.R, A = new Float64Array(pts.length), B = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2], m = Math.hypot(x, y, z);
    A[i] = (R0[0] * x + R0[1] * y + R0[2] * z) / m;
    A[i + 1] = (R0[3] * x + R0[4] * y + R0[5] * z) / m;
    A[i + 2] = (R0[6] * x + R0[7] * y + R0[8] * z) / m;
  }
  const anc = anchors.map(p => {
    llToEnu(fr, p.lat, p.lon, en);
    return { e: en[0], n: en[1], z: p.z, u: p.u, v: p.v * aspect };
  });
  const q = quatOf(R0), o = [0, 0];
  const lift = opts.lift ?? 0;
  const tryAt = (de, dn, up = 0) => {
    const lat = enuToLat(fr, de, dn), lon = enuToLon(fr, de, dn), g = terrain.elev(lon, lat);
    if (!(g === g)) return null;
    const dh = g + eye + up - pano.hEye;
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i] - de, y = pts[i + 1] - dn, z = pts[i + 2] - dh, m = Math.hypot(x, y, z);
      B[i] = x / m; B[i + 1] = y / m; B[i + 2] = z / m;
    }
    const R = fitRotation(A, B, n, q);
    let ridge = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const ex = R[0] * B[i] + R[1] * B[i + 1] + R[2] * B[i + 2] - A[i];
      const ey = R[3] * B[i] + R[4] * B[i + 1] + R[5] * B[i + 2] - A[i + 1];
      ridge += Math.min(RIDGE_CAP ** 2, (ex * ex + ey * ey) * cam.fn * cam.fn);
    }
    ridge /= Math.max(1, n);
    const c = new Camera(R, cam.fn, cam.k1);
    let miss = 0;
    for (const p of anc) {
      const x = p.e - de, y = p.n - dn, d = Math.hypot(x, y);
      const zz = p.z - (g + eye + up) - d * d / (2 * R_EFF);
      if (!c.project(x, y, zz, 1, aspect, o)) return null;
      miss += (o[0] - p.u) ** 2 + (o[1] - p.v) ** 2;
    }
    miss /= anc.length;
    const cost = miss / ANCHOR_TOL ** 2 + ridge / RIDGE_TOL ** 2 + (de * de + dn * dn) / PRIOR_M ** 2 + (up / 30) ** 2;
    return { de, dn, up, lat, lon, R, cost, miss: Math.sqrt(miss), ridge: Math.sqrt(ridge) };
  };
  const start = tryAt(0, 0);
  if (!start) return null;
  let best = start;
  // coarse grid, then finer ones around the best so far
  const ups = lift ? [0, lift / 4, lift / 2, 3 * lift / 4, lift] : [0];
  for (const [step, span] of [[12, radius], [4, 16], [1.5, 5]]) {
    const c0 = best;
    for (const up of span === radius ? ups : [c0.up - lift / 8, c0.up, c0.up + lift / 8]) {
      if (up < 0 || up > lift) continue;
      for (let dn = -span; dn <= span + 1e-9; dn += step) for (let de = -span; de <= span + 1e-9; de += step) {
        if (span === radius && de * de + dn * dn > radius * radius) continue;
        const r = tryAt(c0.de + de, c0.dn + dn, up);
        if (r && r.cost < best.cost) best = r;
      }
    }
  }
  return { lat: best.lat, lon: best.lon, up: best.up, R: best.R, moved: Math.hypot(best.de, best.dn), before: start.miss, after: best.miss, ridge: best.ridge };
}
