// sim.js -- synthetic camera frames for demo mode and the tests.
//
// Renders what a camera would see from the panorama's viewpoint: sky, white
// runs, dark forest, alpine snow above treeline, gray rock where it is steep.
// The run width here is deliberately narrower than the ownership reach, so the
// overlay has to find the real edge from the picture, as it must on the hill.

import { TAU, R2D, enuToLat, enuToLon, panoCol, PANO_T_MAX, gridBilinear } from './terrain.js?v=1123.1514-aebec47';

const SUN = (() => { const az = 150 / R2D, el = 32 / R2D; return [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)]; })();
const TREELINE = 3180, RUN_HALF_WIDTH = 24;

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in 0..1. */
function noise(x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  let fx = x - x0, fy = y - y0;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0), b = hash(x0 + 1, y0), c = hash(x0, y0 + 1), d = hash(x0 + 1, y0 + 1);
  return a + (b - a) * fx + (c - a + (a - b + d - c) * fx) * fy;
}

/**
 * Render an RGBA frame {w, h, data}.
 * world = {pano, terrain, ownerCost (Float32 per fine cell)}; cam = Camera.
 */
export function renderSim(world, cam, w, h, out) {
  const { pano, terrain, ownerCost } = world, fine = terrain.fine;
  const data = out?.data?.length === w * h * 4 ? out.data : new Uint8ClampedArray(w * h * 4);
  const d = [0, 0, 0], fr = pano.frame, na = pano.na, nt = pano.nt;
  for (let y = 0, j = 0; y < h; y++) for (let x = 0; x < w; x++, j += 4) {
    cam.unproject(x + 0.5, y + 0.5, w, h, d);
    const hz = Math.hypot(d[0], d[1]), t = d[2] / hz;
    let az = Math.atan2(d[0], d[1]); if (az < 0) az += TAU;
    const a = panoCol(pano, az);
    const r = Math.floor((PANO_T_MAX - t) / pano.dT);
    const dist = (t > pano.skyT[a] || r < 0) ? 0 : (r >= nt ? -1 : pano.dist[r * na + a]);
    let R, G, B;
    if (dist <= 0) {
      if (dist < 0) { R = 228; G = 232; B = 238; }        // ground at the viewer's feet
      else {
        const k = Math.min(1, Math.max(0, (t - pano.skyT[a]) * 2.2 + 0.1));
        R = 196 - 96 * k; G = 216 - 70 * k; B = 240 - 22 * k;
      }
    } else {
      const e = dist * d[0] / hz, n = dist * d[1] / hz;
      const lon = enuToLon(fr, e, n), lat = enuToLat(fr, e, n);
      const z = terrain.elev(lon, lat);
      const s = Math.max(8, dist * 0.004), dl = s / 111320 / fr.c, dp = s / 110540;
      const gx = (terrain.elev(lon + dl, lat) - terrain.elev(lon - dl, lat)) / (2 * s);
      const gy = (terrain.elev(lon, lat + dp) - terrain.elev(lon, lat - dp)) / (2 * s);
      const nl = 1 / Math.hypot(gx, gy, 1);
      const lambert = Math.max(0, (-gx * SUN[0] - gy * SUN[1] + SUN[2]) * nl);
      const slope = Math.hypot(gx, gy);
      const cell = Math.max(3, dist * 0.002);
      const nz = noise((pano.lon0 * 111320 * fr.c + e) / cell, (pano.lat0 * 110540 + n) / cell);
      // ragged tree line: the edge wanders a few meters either way
      const onRun = gridBilinear(fine, ownerCost, lon, lat, 400) < RUN_HALF_WIDTH + 7 * (noise(e / 9 + 31, n / 9 - 17) - 0.5);
      if (onRun || z > TREELINE + 60 * (nz - 0.5) && slope < 0.85) {
        const v = 0.62 + 0.38 * lambert;
        R = 250 * v; G = 252 * v; B = 255 * Math.min(1, v + 0.06);
      } else if (slope >= 0.85) {
        const v = 0.45 + 0.5 * lambert + 0.1 * nz;
        R = 150 * v; G = 146 * v; B = 142 * v;
      } else {
        const v = 0.35 + 0.5 * lambert + 0.35 * nz;
        R = 46 * v; G = 74 * v; B = 52 * v;
      }
      const haze = 1 - Math.exp(-dist / 30000);
      R += (196 - R) * haze; G += (214 - G) * haze; B += (236 - B) * haze;
    }
    data[j] = R; data[j + 1] = G; data[j + 2] = B; data[j + 3] = 255;
  }
  return { w, h, data };
}
