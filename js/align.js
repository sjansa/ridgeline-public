// align.js -- register the camera frame against the terrain model.
//
// The compass is good to maybe 10-20 degrees and the accelerometer to a degree
// or two; neither is close enough to draw a lift on the right tower. This
// finds the residual rotation, focal length and radial distortion that make
// the model's ridges land on the ridges in the picture:
//
//   1. analyzeFrame: find skyline candidates in the image (sharp rows with
//      only smooth sky or cloud above them) and a distance transform of all
//      strong edges.
//   2. coarse: slide the image skyline around the model's 360-degree skyline
//      profile. Every yaw gets its best pitch (median residual) for free.
//   3. refine: Nelder-Mead over yaw, pitch, roll, focal scale and k1, scoring
//      the projected model skyline against the image skyline and the projected
//      interior ridges against image edges.
//
// No DOM: frames are {w, h, data: RGBA bytes}.

import { D2R, R2D, TAU } from './terrain.js?v=1123.1514-aebec47';
import { Camera, matMul, yawMat, pitchRollMat } from './camera.js?v=1123.1514-aebec47';

const SKY_CAP = 8;          // px at analysis width 320: truncation for skyline error
const EDGE_CAP = 6;
// Fog or a white-out: even the strongest half-percent of edges in the frame are
// faint. (A share of all pixels would not do: a clear day can be nearly all flat
// sky and smooth snow.) Measured 17+ through heavy haze, under 8.5 in fog.
const FOG_CONTRAST = 12;
const SOLID_MIN = 0.33;      // strict mode: least share of the model skyline lying on a two-sided edge
const SIDE_DIFF = 10;       // gray levels (0-255): least difference between sky and ground across a ridge

function percentile(arr, q, stride = 7) {
  const s = [];
  for (let i = 0; i < arr.length; i += stride) s.push(arr[i]);
  s.sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/** Image features used by the solver and the renderer. */
export function analyzeFrame(frame) {
  const { w, h, data } = frame, n = w * h;
  const gray = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) gray[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  // Gradient on luminance plus blue-minus-red: snow against a pale sky has
  // almost no luminance edge but usually a color one.
  const chroma = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) chroma[i] = data[j + 2] - data[j];
  const grad = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
    const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
    const cx = chroma[i + 1] - chroma[i - 1], cy = chroma[i + w] - chroma[i - w];
    grad[i] = (Math.abs(gx) + Math.abs(gy)) / 8 + (Math.abs(cx) + Math.abs(cy)) / 2;
  }
  const p70 = percentile(grad, 0.70), p88 = percentile(grad, 0.88);
  const gSky = Math.max(5, 0.8 * p70);

  // Skyline: walk each column down from the top through whatever is smooth
  // (blue sky, haze, cloud) until the ground starts: a stretch that is
  // textured, or dark without being blue. Snow under cloud or pale sky has no
  // such start until the first rocks or trees, and a cloud edge is as sharp as
  // any ridge, so on the way down every sharp row is also kept as a candidate.
  // The model's shape picks among the candidates later; `raw` is only the
  // best single guess.
  const raw = new Int16Array(w).fill(-1);
  const cand = new Uint8Array(n);
  const K = Math.max(6, Math.round(h * 0.07)), eThr = Math.max(8, p88);
  const cb = new Float32Array(h + 1), cd = new Float32Array(h + 1);
  for (let x = 1; x < w - 1; x++) {
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      cb[y + 1] = cb[y] + (grad[i] > gSky ? 1 : 0);
      cd[y + 1] = cd[y] + (gray[i] < 105 && chroma[i] < 18 ? 1 : 0);
    }
    let hit = -1;
    for (let y = 1; y < h - K; y++) {
      if (cb[y + K] - cb[y] > 0.45 * K || cd[y + K] - cd[y] > 0.6 * K) { hit = y; break; }
    }
    const end = hit < 0 ? h - K : hit;
    for (let y = 2; y < end; y++) {
      const g = grad[y * w + x];
      if (g >= eThr && g >= grad[(y - 1) * w + x] && g >= grad[(y + 1) * w + x]) cand[y * w + x] = 1;
    }
    if (hit > 2) {
      // snap to the first sharp row of the changed window (not the sharpest:
      // that is often a tree line a few rows below the real boundary)
      const y0 = Math.max(1, hit - 2), y1 = Math.min(h - 1, hit + K);
      let bg = 0;
      for (let y = y0; y < y1; y++) bg = Math.max(bg, grad[y * w + x]);
      let by = hit;
      for (let y = y0; y < y1; y++) if (grad[y * w + x] >= 0.5 * bg) { by = y; break; }
      raw[x] = by + 1;
      cand[Math.min(h - 1, by + 1) * w + x] = 1;
    }
  }
  const skyRow = new Int16Array(w).fill(-1);
  const win = [];
  for (let x = 0; x < w; x++) {             // 5-wide median kills towers and wires
    win.length = 0;
    for (let k = -2; k <= 2; k++) { const v = raw[x + k]; if (v != null && v >= 0) win.push(v); }
    if (win.length >= 3) { win.sort((a, b) => a - b); skyRow[x] = win[win.length >> 1]; }
  }
  let nSky = 0;
  for (let x = 0; x < w; x++) if (skyRow[x] >= 0) nSky++;

  // Truncated chamfer distances: to any strong edge, and to skyline candidates.
  const chamfer = (seed, cap) => {
    const d = new Float32Array(n).fill(cap);
    for (let i = 0; i < n; i++) if (seed(i)) d[i] = 0;
    for (let y = 1; y < h; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      d[i] = Math.min(d[i], d[i - 1] + 1, d[i - w] + 1, d[i - w - 1] + 1.4, d[i - w + 1] + 1.4);
    }
    for (let y = h - 2; y >= 0; y--) for (let x = w - 2; x >= 1; x--) {
      const i = y * w + x;
      d[i] = Math.min(d[i], d[i + 1] + 1, d[i + w] + 1, d[i + w + 1] + 1.4, d[i + w - 1] + 1.4);
    }
    return d;
  };
  const dt = chamfer(i => grad[i] >= eThr, EDGE_CAP);
  const skyDt = chamfer(i => cand[i], SKY_CAP);

  // Snow threshold: Otsu on luminance below the skyline (snow vs trees/rock).
  const hist = new Float64Array(64);
  let tot = 0;
  for (let x = 0; x < w; x += 2) {
    for (let y = Math.max(0, skyRow[x] + 2); y < h; y += 2) { hist[Math.min(63, gray[y * w + x] / 4 | 0)]++; tot++; }
  }
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += i * hist[i];
  let wB = 0, sB = 0, best = 0, thr = 32;
  for (let i = 0; i < 64; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = tot - wB; if (!wF) break;
    sB += i * hist[i];
    const m = sB / wB - (sum - sB) / wF, v = wB * wF * m * m;
    if (v > best) { best = v; thr = i + 1; }
  }
  return { w, h, gray, chroma, grad, contrast: percentile(grad, 0.995), skyRow, nSky, dt, skyDt, snowThr: Math.min(0.8, Math.max(0.3, thr * 4 / 255)) };
}

/** Precomputed model geometry for one panorama. */
export function alignModel(pano, chains) {
  const na = pano.na;
  const skyEl = new Float32Array(na), sky = new Float32Array(na * 3);
  for (let a = 0; a < na; a++) {
    const az = a * TAU / na, t = pano.skyT[a], c = 1 / Math.hypot(1, t);
    skyEl[a] = Math.atan(t);
    sky[a * 3] = Math.sin(az) * c; sky[a * 3 + 1] = Math.cos(az) * c; sky[a * 3 + 2] = t * c;
  }
  let total = 0;
  for (const ch of chains) total += ch.cols.length;
  const stride = Math.max(1, Math.ceil(total / 2500));
  const cr = [];
  for (const ch of chains) for (let i = 0; i < ch.cols.length; i += stride) {
    if (ch.d[i] < 150) continue;               // nearby ground: DEM too coarse to trust
    const az = ch.cols[i] * TAU / na, t = ch.t[i], c = 1 / Math.hypot(1, t);
    cr.push(Math.sin(az) * c, Math.cos(az) * c, t * c);
  }
  return { na, skyEl, sky, crests: new Float32Array(cr) };
}

/** Slide the image skyline round the model profile. Returns candidates. */
function coarse(model, cam, an, maxYaw, maxPitch) {
  const { w, h, skyRow } = an, na = model.na;
  const az = [], el = [], d = [0, 0, 0];
  for (let x = 2; x < w - 2; x += 2) {
    if (skyRow[x] < 0) continue;
    cam.unproject(x + 0.5, skyRow[x], w, h, d);
    az.push(Math.atan2(d[0], d[1])); el.push(Math.atan2(d[2], Math.hypot(d[0], d[1])));
  }
  const n = az.length;
  if (n < 24) return [];
  const cap = 1.5 * D2R, res = new Float32Array(n), tmp = new Float32Array(n);
  const step = 0.25, out = [];
  for (let yaw = -maxYaw; yaw <= maxYaw; yaw += step) {
    for (let i = 0; i < n; i++) {
      let a = Math.round((az[i] + yaw * D2R) * na / TAU) % na;
      if (a < 0) a += na;
      res[i] = el[i] - model.skyEl[a];
    }
    tmp.set(res); tmp.sort();
    const med = tmp[n >> 1];
    if (Math.abs(med) > maxPitch * D2R) continue;
    let c = 0;
    for (let i = 0; i < n; i++) c += Math.min(Math.abs(res[i] - med), cap);
    c = c / n / cap + 0.2 * Math.min(1, Math.max(0, Math.abs(yaw) - 15) / 90);
    out.push({ yaw, pitch: -med * R2D, cost: c });
  }
  // keep local minima, best first
  const mins = out.filter((o, i) => (i === 0 || o.cost <= out[i - 1].cost) && (i === out.length - 1 || o.cost < out[i + 1].cost));
  mins.sort((a, b) => a.cost - b.cost);
  return mins;
}

/**
 * Coarse search that does not trust the skyline detector: slide the model
 * skyline over the edge map. For each yaw the model points are projected once
 * and then shifted vertically, which is what a pitch error does to first order.
 */
function coarseEdges(model, cam, an, maxYaw, maxPitch) {
  const { w, h, skyDt: dt } = an, na = model.na, o = [0, 0];
  const f = cam.fn * w, half = Math.atan(0.5 / cam.fn);
  const heading = Math.atan2(cam.R[6], cam.R[7]);
  const nPts = 90, us = new Int32Array(nPts), vs = new Float32Array(nPts);
  const maxShift = Math.round(Math.tan(maxPitch * D2R) * f), out = [];
  for (let yaw = -maxYaw; yaw <= maxYaw; yaw += 0.5) {
    const c = new Camera(matMul(cam.R, yawMat(yaw)), cam.fn, cam.k1);
    let n = 0;
    for (let i = 0; i < nPts; i++) {
      const az = heading + yaw * D2R + (i / (nPts - 1) - 0.5) * 2 * half;
      const a = ((Math.round(az * na / TAU) % na) + na) % na, j = a * 3;
      if (!c.project(model.sky[j], model.sky[j + 1], model.sky[j + 2], w, h, o)) continue;
      if (o[0] < 1 || o[0] >= w - 1) continue;
      us[n] = o[0] | 0; vs[n] = o[1]; n++;
    }
    if (n < 40) continue;
    let best = Infinity, bestShift = 0;
    for (let sh = -maxShift; sh <= maxShift; sh += 2) {
      let sum = 0, m = 0;
      for (let i = 0; i < n; i++) {
        const v = (vs[i] + sh) | 0;
        if (v < 1 || v >= h - 1) continue;
        sum += dt[v * w + us[i]]; m++;
      }
      if (m < n * 0.7) continue;
      const cst = sum / m / SKY_CAP;
      if (cst < best) { best = cst; bestShift = sh; }
    }
    if (best === Infinity) continue;
    // moving the picture down by sh pixels = pitching the camera up
    out.push({ yaw, pitch: Math.atan(bestShift / f) * R2D, cost: best + 0.1 * Math.min(1, Math.max(0, Math.abs(yaw) - 15) / 90) });
  }
  const mins = out.filter((q, i) => (i === 0 || q.cost <= out[i - 1].cost) && (i === out.length - 1 || q.cost < out[i + 1].cost));
  mins.sort((x, y) => x.cost - y.cost);
  return mins;
}

function makeCam(base, p) {
  const R = matMul(matMul(pitchRollMat(p[1], p[2]), base.R), yawMat(p[0]));
  return new Camera(R, base.fn * Math.exp(p[3]), base.k1 + p[4]);
}

/** Image-space score of one camera hypothesis (lower is better). */
function score(model, cam, an, parts) {
  const { w, h, dt, skyDt } = an, na = model.na, o = [0, 0];
  const heading = Math.atan2(cam.R[6], cam.R[7]);
  const half = Math.atan(0.5 / cam.fn) * 1.3;
  const a0 = Math.floor((heading - half) * na / TAU), a1 = Math.ceil((heading + half) * na / TAU);
  let sSum = 0, sN = 0, sIn = 0, sSolid = 0;
  for (let k = a0; k <= a1; k += 2) {
    const a = ((k % na) + na) % na, j = a * 3;
    if (!cam.project(model.sky[j], model.sky[j + 1], model.sky[j + 2], w, h, o)) continue;
    if (o[0] < 1 || o[0] >= w - 1) continue;
    if (o[1] < 1 || o[1] >= h - 1) continue;
    // Two witnesses, both truncated: distance to a skyline candidate (an edge
    // with only smooth sky or cloud above it) and to any strong edge.
    const q = (o[1] | 0) * w + (o[0] | 0);
    const e1 = skyDt[q] / SKY_CAP, e2 = dt[q] / EDGE_CAP;
    sSum += 0.5 * e1 + 0.5 * e2; sN++;
    if (skyDt[q] <= 2) {
      sIn++;
      // A ridge has sky on one side and ground on the other. A cable, a
      // tower or a rime-edged branch in fog has the same gray on both.
      if (parts && sidesDiffer(an, o[0] | 0, o[1] | 0)) sSolid++;
    }
  }
  if (sN < 20) return 10;
  let cSum = 0, cN = 0;
  const cr = model.crests;
  for (let j = 0; j < cr.length; j += 3) {
    if (!cam.project(cr[j], cr[j + 1], cr[j + 2], w, h, o)) continue;
    if (o[0] < 1 || o[1] < 1 || o[0] >= w - 1 || o[1] >= h - 1) continue;
    cSum += dt[(o[1] | 0) * w + (o[0] | 0)] / EDGE_CAP; cN++;
  }
  const sky = sSum / sN, crest = cN > 30 ? cSum / cN : 0.5;
  if (parts) { parts.sky = sky; parts.crest = crest; parts.inl = sIn / sN; parts.solid = sSolid / sN; parts.nSky = sN; parts.nCrest = cN; }
  return sky + 0.25 * crest;
}

/** Do the patches just above and just below (x, y) differ in brightness or color? */
function sidesDiffer(an, x, y) {
  const { w, h, gray, chroma } = an;
  let ga = 0, ca = 0, na = 0, gb = 0, cb = 0, nb = 0;
  for (let d = 3; d <= 9; d += 2) for (let dx = -1; dx <= 1; dx++) {
    const xx = Math.min(w - 1, Math.max(0, x + dx));
    if (y - d >= 0) { const i = (y - d) * w + xx; ga += gray[i]; ca += chroma[i]; na++; }
    if (y + d < h) { const i = (y + d) * w + xx; gb += gray[i]; cb += chroma[i]; nb++; }
  }
  if (!na || !nb) return false;
  return Math.abs(ga / na - gb / nb) + Math.abs(ca / na - cb / nb) >= SIDE_DIFF;
}

function nelderMead(f, x0, steps, iters) {
  const n = x0.length;
  let sx = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += steps[i]; sx.push(x); }
  let fx = sx.map(f);
  for (let it = 0; it < iters; it++) {
    const idx = fx.map((v, i) => i).sort((a, b) => fx[a] - fx[b]);
    sx = idx.map(i => sx[i]); fx = idx.map(i => fx[i]);
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += sx[i][j] / n;
    const at = t => c.map((v, j) => v + t * (sx[n][j] - v));
    const xr = at(-1), fr = f(xr);
    if (fr < fx[0]) {
      const xe = at(-2), fe = f(xe);
      if (fe < fr) { sx[n] = xe; fx[n] = fe; } else { sx[n] = xr; fx[n] = fr; }
    } else if (fr < fx[n - 1]) { sx[n] = xr; fx[n] = fr; }
    else {
      const xc = at(fr < fx[n] ? -0.5 : 0.5), fc = f(xc);
      if (fc < Math.min(fr, fx[n])) { sx[n] = xc; fx[n] = fc; }
      else for (let i = 1; i <= n; i++) { sx[i] = sx[i].map((v, j) => sx[0][j] + 0.5 * (v - sx[0][j])); fx[i] = f(sx[i]); }
    }
  }
  let b = 0;
  for (let i = 1; i <= n; i++) if (fx[i] < fx[b]) b = i;
  return { x: sx[b], f: fx[b] };
}

/**
 * Solve for the camera that matches the frame.
 *
 * base: Camera from the sensors (plus any earlier correction).
 * opts.maxYaw: coarse search half-range in degrees (default 180: the whole
 *   horizon, with a mild preference for staying near the compass).
 * opts.maxPitch: how far the sensor pitch may be out, degrees (default 12;
 *   a photo carries no pitch at all, so the app passes more).
 * opts.zooms: focal-length multiples to try, e.g. [1, 0.6, 1.65], for when the
 *   lens is unknown (default [1]); ignored unless opts.lens.
 * opts.lens: also solve focal length and k1 (default true).
 * opts.strict: live view. When cloud or fog hides the mountains the sensors
 *   are the better guide, so: a flat, featureless frame is not solved at all
 *   (returns {ok: false, hidden: true}); and a match is accepted only if a
 *   fair share of the skyline lies on an edge with different things on its
 *   two sides, and a correction away from the compass is clearly the best on
 *   offer. Cables, towers and trees looming out of fog fail one or the other.
 *
 * Returns null when the frame has no usable skyline, else
 * {cam, yaw, pitch, roll, fScale, k1, cost, sky, crest, confidence, ok}.
 */
export function solveAlignment(model, base0, an, opts = {}) {
  const maxYaw = opts.maxYaw ?? 180, maxPitch = opts.maxPitch ?? 12;
  const lens = opts.lens !== false;
  const prior = p => 0.05 * (p[2] / 4) ** 2 + 0.05 * (p[3] / 0.12) ** 2 + 0.05 * (p[4] / 0.08) ** 2;
  if (opts.strict && an.contrast < FOG_CONTRAST) {
    return { ok: false, hidden: true, cam: base0, yaw: 0, pitch: 0, roll: 0, fScale: 1, k1: base0.k1, cost: 10, sky: 1, crest: 1, inliers: 0, solid: 0, contrast: an.contrast, confidence: 0 };
  }
  const results = [];
  // Each zoom guess gets its own coarse search and refinement: the refinement
  // can only pull the focal length in by about a third, and the coarse search
  // is blind at the wrong scale.
  for (const zoom of (lens && opts.zooms) || [1]) {
    const base = zoom === 1 ? base0 : new Camera(base0.R, base0.fn * zoom, base0.k1);
    const byLine = an.nSky >= an.w * 0.3 ? coarse(model, base, an, maxYaw, maxPitch) : [];
    const byEdge = coarseEdges(model, base, an, maxYaw, maxPitch);
    // interleave the two rankings so neither detector can crowd the other out
    const cands = [];
    for (let i = 0; i < 3; i++) { if (byLine[i]) cands.push(byLine[i]); if (byEdge[i]) cands.push(byEdge[i]); }
    const f = p => {
      if (Math.abs(p[3]) > 0.35 || Math.abs(base.k1 + p[4]) > 0.3) return 10;
      return score(model, makeCam(base, p), an) + prior(p);
    };
    const tried = [];
    for (const c of cands) {
      if (tried.some(y => Math.abs(y - c.yaw) < 3)) continue;
      tried.push(c.yaw);
      // rotation first, then free the lens: a wrong focal length otherwise
      // soaks up a rotation error and the simplex stalls in the wrong basin
      let r = nelderMead(p => f([p[0], p[1], p[2], 0, 0]), [c.yaw, c.pitch, 0], [0.4, 0.4, 0.6], 70);
      let x = [r.x[0], r.x[1], r.x[2], 0, 0];
      if (lens) { r = nelderMead(f, x, [0.2, 0.2, 0.3, 0.04, 0.03], 160); x = r.x; }
      results.push({ x, f: lens ? r.f : f(x), base, zoom });
      if (tried.length >= 5) break;
    }
  }
  if (!results.length) return null;
  results.sort((a, b) => a.f - b.f);
  const best = results[0];
  // Confidence: how much better than the best answer at a different heading.
  // Starts that converge on the same heading are the same answer.
  const rival = results.find(r => Math.abs(r.x[0] - best.x[0]) > 3);
  best.second = rival ? rival.f : null;
  const cam = makeCam(best.base, best.x), parts = {};
  score(model, cam, an, parts);
  const confidence = best.second == null ? 0.5 : Math.max(0, 1 - best.f / Math.max(best.second, 1e-6));
  const plausible = confidence > (opts.strict ? 0.25 : 0.12) || Math.abs(best.x[0]) < 12;
  const evident = !opts.strict || parts.solid >= SOLID_MIN && confidence >= 0.1;
  return {
    cam, yaw: best.x[0], pitch: best.x[1], roll: best.x[2], fScale: Math.exp(best.x[3]) * best.zoom, k1: cam.k1,
    cost: best.f, sky: parts.sky, crest: parts.crest, inliers: parts.inl, solid: parts.solid, contrast: an.contrast, confidence,
    ok: evident && (parts.sky < 0.32 && plausible
      // a so-so fit is still believable when nothing else on the horizon comes close
      || parts.sky < 0.42 && confidence > 0.3
      // Cloud hiding part of the ridge: a good share of it still sits on the
      // line. Wrong headings manage that too, so it only counts when the best
      // answer on the whole horizon is also where the compass said to look
      // (and there a mistake cannot move the overlay far).
      || parts.inl >= 0.35 && parts.sky < 0.55 && Math.abs(best.x[0]) < 10),
  };
}
