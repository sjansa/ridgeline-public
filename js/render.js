// render.js -- draws the camera frame with run shading (WebGL) and the line
// work on top of it (2D canvas): ridges, lifts, run centerlines, labels.

import { TAU, panoLook, panoVisible, panoCol, localFrame } from './terrain.js?v=1123.1925-052acda';
import { CLASS_TINT, CLASS_COLOR, slopeColor, SLOPE_SCALES } from './runs.js?v=1123.1925-052acda';

const VS = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
// Per pixel: undistort, rotate into the world, look the direction up in the
// panorama (which run owns the ground there, how steep it is), and tint it if
// the camera sees snow. The snow test is what trims a run to its real,
// tree-lined width. The panorama is sampled with a hand-rolled bilinear
// filter: class and run id cannot be averaged, so the four neighbors are
// each turned into a color and a coverage first and those are blended.
const FS = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
precision highp float;
uniform sampler2D uVid, uPano, uLut;
uniform vec2 uScreen, uFrame, uTexel;
uniform mat3 uR;
uniform float uF, uK1, uSnow, uAlpha, uUseSnow, uSlope, uOutline, uPx;
uniform vec3 uTint[6];
vec4 tap(vec2 ij) { return texture2D(uPano, vec2(fract((ij.x + 0.5) * uTexel.x), (ij.y + 0.5) * uTexel.y)); }
vec3 tintOf(float r) {
  int c = int(r * 255.0 + 0.5);
  return c == 1 ? uTint[1] : c == 2 ? uTint[2] : c == 3 ? uTint[3] : c == 4 ? uTint[4] : uTint[5];
}
float snowAt(vec2 uv) {
  vec3 c = texture2D(uVid, uv).rgb;
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  return smoothstep(uSnow - 0.10, uSnow + 0.02, dot(c, vec3(0.299, 0.587, 0.114))) * (1.0 - smoothstep(0.40, 0.62, (mx - mn) / max(mx, 0.001)));
}
float band(float m, float w) {
#ifdef GL_OES_standard_derivatives
  float fw = max(fwidth(m), 0.02);
#else
  float fw = 0.12;
#endif
  return 1.0 - smoothstep(w * 0.5, w * 0.5 + 1.0, abs(m - 0.5) / fw);
}
void main() {
  vec2 fp = vec2(gl_FragCoord.x, uScreen.y - gl_FragCoord.y) - 0.5 * uScreen;
  vec2 uv = fp / uFrame + 0.5;
  bool inFrame = uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0;
  vec3 col = inFrame ? texture2D(uVid, uv).rgb : vec3(0.04, 0.06, 0.08);
  if (uAlpha > 0.0 && inFrame) {
    vec2 d = fp / uF, q = d;
    for (int i = 0; i < 4; i++) q = d / (1.0 + uK1 * dot(q, q));
    vec3 w = uR * vec3(q, 1.0);
    float t = w.z / length(w.xy);
    vec2 puv = vec2(fract(atan(w.x, w.y) / 6.2831853 + 1.0), (1.0 - t) * 0.5);
    if (puv.y > 0.0 && puv.y < 1.0) {
      vec2 tc = puv / uTexel - 0.5, i0 = floor(tc), f = tc - i0;
      vec4 p[4];
      p[0] = tap(i0); p[1] = tap(i0 + vec2(1.0, 0.0)); p[2] = tap(i0 + vec2(0.0, 1.0)); p[3] = tap(i0 + vec2(1.0, 1.0));
      float wt[4];
      wt[0] = (1.0 - f.x) * (1.0 - f.y); wt[1] = f.x * (1.0 - f.y); wt[2] = (1.0 - f.x) * f.y; wt[3] = f.x * f.y;
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      float snow = mix(1.0, snowAt(uv), uUseSnow);
      if (uSlope > 0.5) {
        float sAcc = 0.0, wv = 0.0;
        for (int k = 0; k < 4; k++) if (p[k].a < 0.998) { sAcc += wt[k] * p[k].a; wv += wt[k]; }
        if (wv > 0.0) {
          vec4 heat = texture2D(uLut, vec2(sAcc / wv * 255.0 / 254.0, 0.5));
          col = mix(col, heat.rgb * (0.5 + 0.7 * luma), uAlpha * smoothstep(0.0, 0.6, wv) * snow * heat.a);
        }
      } else {
        vec3 cAcc = vec3(0.0);
        float cov = 0.0, wBest = -1.0, idBest = 0.0, black = 0.0;
        for (int k = 0; k < 4; k++) {
          float c = p[k].r > 0.0 ? smoothstep(0.0, 0.22, p[k].b) * wt[k] : 0.0;
          cAcc += c * tintOf(p[k].r); cov += c;
          if (int(p[k].r * 255.0 + 0.5) == 3) black += c;
          if (p[k].r > 0.0 && wt[k] > wBest) { wBest = wt[k]; idBest = p[k].g; }
        }
        if (cov > 0.001) {
          vec3 tint = cAcc / cov;
          // where two runs meet: weight of neighbors owned by another run
          float other = 0.0;
          for (int k = 0; k < 4; k++) if (p[k].r > 0.0 && abs(p[k].g - idBest) > 0.002) other += wt[k];
          float seam = smoothstep(0.2, 0.5, other) * snow;
          float m = cov * snow;
          if (uOutline > 0.5) {
            // The snow edge is one pixel sharp, so a derivative band would be a
            // hairline. Probe the snow test a line-width away on four sides
            // instead: the edge is wherever those probes disagree.
            vec2 o = 1.6 * uPx / uFrame;
            float s0 = snowAt(uv + vec2(o.x, o.y)), s1 = snowAt(uv + vec2(-o.x, o.y));
            float s2 = snowAt(uv + vec2(o.x, -o.y)), s3 = snowAt(uv + vec2(-o.x, -o.y));
            float rim = max(max(s0, s1), max(s2, s3)) - min(min(s0, s1), min(s2, s3));
            rim = mix(0.0, rim, uUseSnow) * smoothstep(0.05, 0.3, cov);
            float line = max(max(rim, band(cov, 2.2 * uPx) * snow), seam);
            // lighten the rating color a little so dark runs show on shadowed snow
            col = mix(col, mix(tint, vec3(1.0), 0.12 + 0.4 * black / cov), min(1.0, uAlpha * 1.5) * line);
          } else {
            // keep the snow's own shading: tint the luminance instead of painting over it
            float a = mix(1.0, 0.72, black / cov);      // black runs: gray the snow, do not bury it
            col = mix(col, tint * (0.35 + 0.9 * luma), uAlpha * a * m);
            col = mix(col, vec3(1.0), 0.5 * uAlpha * seam);
          }
        }
      }
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export class Shader {
  constructor(canvas) {
    const gl = this.gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL is not available in this browser.');
    const deriv = !!gl.getExtension('OES_standard_derivatives');
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const pr = this.prog = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, deriv ? FS : FS.replace(/GL_OES_standard_derivatives/g, 'NO_DERIVATIVES')));
    gl.bindAttribLocation(pr, 0, 'p');
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    gl.useProgram(pr);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of ['uVid', 'uPano', 'uLut', 'uScreen', 'uFrame', 'uTexel', 'uR', 'uF', 'uK1', 'uSnow', 'uAlpha', 'uUseSnow', 'uSlope', 'uOutline', 'uPx', 'uTint'])
      this.u[n] = gl.getUniformLocation(pr, n);
    const tex = (unit, filter) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      return t;
    };
    this.vid = tex(0, gl.LINEAR);
    this.pano = tex(1, gl.NEAREST);
    this.lut = tex(2, gl.LINEAR);
    this.setSlopeScale('full');
    gl.uniform1i(this.u.uVid, 0); gl.uniform1i(this.u.uPano, 1); gl.uniform1i(this.u.uLut, 2);
    gl.uniform3fv(this.u.uTint, new Float32Array(CLASS_TINT.flat()));
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.hasPano = false;
  }

  /** The colors for slope angles (a key of SLOPE_SCALES), as a 256-entry lookup over 0..90°. */
  setSlopeScale(key) {
    const gl = this.gl, stops = (SLOPE_SCALES[key] || SLOPE_SCALES.full).stops, lut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) { const c = slopeColor(i * 90 / 255, stops); lut.set([c[0], c[1], c[2], c[3] * 255], i * 4); }
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
    this.slopeScale = key;
  }

  /** Upload a panorama: R class, G run id, B coverage, A slope (255 = none). */
  setPano(pano, runs) {
    const gl = this.gl, { na, nt, owner, ownerCost, slope } = pano;
    // Phones with small texture limits get every other column.
    const sx = na > this.maxTex ? 2 : 1, w = na / sx;
    const px = new Uint8Array(w * nt * 4);
    for (let r = 0; r < nt; r++) for (let a = 0; a < w; a++) {
      const k = r * na + a * sx, j = (r * w + a) * 4, o = owner[k];
      px[j + 3] = slope[k] === 255 ? 255 : Math.round(slope[k] * 254 / 90);
      if (!o) continue;
      px[j] = runs[o - 1].cls; px[j + 1] = (o * 37) & 255; px[j + 2] = ownerCost[k];
    }
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.pano);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, nt, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.uniform2f(this.u.uTexel, 1 / w, 1 / nt);
    this.hasPano = true;
  }

  /** view = {sw, sh, fw, fh, dpr} in device pixels; source = video | canvas. */
  draw(source, cam, view, o) {
    const gl = this.gl;
    gl.viewport(0, 0, view.sw, view.sh);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.vid);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source); } catch (e) { /* frame not ready */ }
    gl.uniform2f(this.u.uScreen, view.sw, view.sh);
    gl.uniform2f(this.u.uFrame, view.fw, view.fh);
    gl.uniformMatrix3fv(this.u.uR, false, new Float32Array(cam.R));
    gl.uniform1f(this.u.uF, cam.fn * view.fw);
    gl.uniform1f(this.u.uK1, cam.k1);
    gl.uniform1f(this.u.uSnow, o.snowThr);
    gl.uniform1f(this.u.uAlpha, o.runs && this.hasPano ? o.alpha : 0);
    gl.uniform1f(this.u.uUseSnow, o.snowMask ? 1 : 0);
    gl.uniform1f(this.u.uSlope, o.shade === 'slope' ? 1 : 0);
    if (o.slopeScale && o.slopeScale !== this.slopeScale) this.setSlopeScale(o.slopeScale);
    gl.uniform1f(this.u.uOutline, o.outline ? 1 : 0);
    gl.uniform1f(this.u.uPx, view.dpr);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

// ------------------------------------------------------------- line overlay

const dirOf = (az, t, out, j) => {
  const c = 1 / Math.hypot(1, t);
  out[j] = Math.sin(az) * c; out[j + 1] = Math.cos(az) * c; out[j + 2] = t * c;
};

/**
 * Everything about the features that depends on where you stand but not on
 * where you look: direction, distance and visibility of every vertex.
 */
export function buildScene(pano, chains, prep) {
  const look = {};
  const feature = (f, maxD) => {
    const n = f.pts.length, dirs = new Float32Array(n * 3), vis = new Uint8Array(n);
    let near = Infinity, any = false;
    for (let i = 0; i < n; i++) {
      panoLook(pano, f.pts[i][0], f.pts[i][1], f.z[i], look);
      dirOf(look.az, look.t, dirs, i * 3);
      if (look.d < maxD && look.d > 3 && panoVisible(pano, look.az, look.t, look.d, f.kind === 'lift' ? 25 : 14)) { vis[i] = 1; any = true; }
      if (look.d < near) near = look.d;
    }
    return any ? { f, dirs, vis, near } : null;
  };
  const lifts = prep.lifts.map(l => feature(l, 12000)).filter(Boolean);
  for (const l of lifts) {
    l.dist = new Float32Array(l.vis.length); l.ok = new Uint8Array(l.vis.length);
    l.f.pts.forEach((p, i) => { panoLook(pano, p[0], p[1], l.f.z[i], look); l.dist[i] = look.d; });
  }
  const runs = prep.runs.filter(r => !r.area).map(r => feature(r, 8000)).filter(Boolean);
  const peaks = [];
  for (const p of prep.peaks) {
    panoLook(pano, p.lat, p.lon, p.ele, look);
    if (look.d < 400) continue;
    const a = panoCol(pano, look.az);
    // on the skyline, or within a few rows of it
    if (look.t < pano.skyT[a] - 4 * pano.dT || look.d > pano.skyD[a] * 1.1 + 300) continue;
    const dir = new Float32Array(3); dirOf(look.az, Math.max(look.t, pano.skyT[a]), dir, 0);
    peaks.push({ name: p.name, ele: p.ele, d: look.d, dir });
  }
  peaks.sort((a, b) => b.ele - a.ele);
  const sky = new Float32Array(pano.na * 3);
  for (let a = 0; a < pano.na; a++) dirOf(a * TAU / pano.na, pano.skyT[a], sky, a * 3);
  const ridges = chains.map(ch => {
    const dirs = new Float32Array(ch.cols.length * 3);
    let d = 0;
    for (let i = 0; i < ch.cols.length; i++) { dirOf(ch.cols[i] * TAU / pano.na, ch.t[i], dirs, i * 3); d += ch.d[i]; }
    return { dirs, d: d / ch.cols.length, cols: ch.cols };
  });
  return { lifts, runs, peaks, sky, ridges, na: pano.na, acc: 0 };
}

/**
 * The planned route as seen from here: pts [[lat, lon, z]]. Parts behind
 * terrain are kept (drawn faint) so the way on still shows.
 */
export function sceneRoute(scene, pano, pts) {
  if (!pts) { scene.route = null; return; }
  const n = pts.length, dirs = new Float32Array(n * 3), vis = new Uint8Array(n), hid = new Uint8Array(n), look = {};
  for (let i = 0; i < n; i++) {
    panoLook(pano, pts[i][0], pts[i][1], pts[i][2] + 1, look);
    dirOf(look.az, look.t, dirs, i * 3);
    if (look.d < 3) continue;
    if (panoVisible(pano, look.az, look.t, look.d, 20)) vis[i] = 1; else hid[i] = 1;
  }
  // a hidden stretch overlaps its visible neighbors by one point, so the line has no gaps
  for (let i = 0; i < n; i++) if (vis[i] && ((i > 0 && hid[i - 1] === 1) || (i < n - 1 && hid[i + 1] === 1))) hid[i] = 2;
  scene.route = { dirs, vis, hid, n };
}

/**
 * Saved spots as seen from here: [{p, dir, d (m), dz (m, + is up), vis}].
 * elev(lon, lat): ground height, NaN where there is no map.
 */
export function scenePlaces(scene, pano, places, elev) {
  const look = {}, out = [];
  for (const p of places || []) {
    const g = elev(p.lon, p.lat);
    if (!(g === g)) continue;
    panoLook(pano, p.lat, p.lon, g + 2, look);
    if (look.d < 5 || look.d > 30000) continue;
    const dir = new Float32Array(3);
    dirOf(look.az, look.t, dir, 0);
    out.push({ p, dir, d: look.d, dz: g + 1.7 - pano.hEye, vis: panoVisible(pano, look.az, look.t, look.d, 25) });
  }
  out.sort((a, b) => a.d - b.d);
  scene.places = out;
}

// A lift nearer than this many GPS errors could be anywhere in the picture: leave it out.
const LIFT_MIN_ACC_RATIO = 3;

/**
 * Re-aim the lifts from where the viewer is now. They are the nearest things
 * drawn, so a few meters of walking moves them visibly while the terrain
 * (rebuilt only after a larger move) stays put. Visibility is kept from the
 * last terrain build. acc: GPS error in meters, 0 when the position is exact.
 */
export function aimLifts(scene, lat, lon, hEye, acc = 0) {
  const p = { frame: localFrame(lat, lon), hEye }, look = {};
  for (const l of scene.lifts) {
    l.f.pts.forEach((q, i) => {
      panoLook(p, q[0], q[1], l.f.z[i], look);
      dirOf(look.az, look.t, l.dirs, i * 3); l.dist[i] = look.d;
    });
  }
  scene.acc = acc;
}

// Run lines: green and blue as rated; black and double black in red so they show on snow and trees.
const LINE_COLOR = ['#000', '#2fd265', '#2d8cff', '#ff3b30', '#ff3b30', '#b9bec7'];
const TAG_COLOR = ['#000', 'rgba(24,150,66,0.94)', 'rgba(28,104,214,0.94)', 'rgba(200,34,30,0.94)', 'rgba(200,34,30,0.94)', 'rgba(90,96,106,0.94)'];

// Lifts: purple, a color no run rating uses. Drawn after the runs so they stay on top.
const LIFT_COLOR = '#9b4dff';
// The planned route and saved spots: gold, which nothing else uses.
export const ROUTE_COLOR = '#ffd84a';
const PLACE_COLOR = '#ffd84a';

function pill(ctx, x, y, text, o) {
  const padX = 7 * o.s, h = 20 * o.s, icon = o.icon ? 16 * o.s : 0;
  const w = ctx.measureText(text).width + padX * 2 + icon;
  const bx = x - w / 2, by = y - h / 2;
  for (const b of o.taken) if (bx < b[2] && bx + w > b[0] && by < b[3] && by + h > b[1]) return false;
  if (bx < 4 || bx + w > o.sw - 4 || by < 4 || by + h > o.sh - 4) return false;
  o.taken.push([bx - 4, by - 3, bx + w + 4, by + h + 3]);
  ctx.fillStyle = o.bg || 'rgba(12,20,27,0.78)';
  if (o.stem) {
    // callout: a tail from the tag down to the point on the line it names
    const t = 5 * o.s;
    ctx.beginPath(); ctx.moveTo(x - t, by + h - 1); ctx.lineTo(x + t, by + h - 1); ctx.lineTo(x, y + o.stem); ctx.closePath(); ctx.fill();
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 6 * o.s; ctx.shadowOffsetY = 2 * o.s;
  }
  ctx.beginPath(); ctx.roundRect(bx, by, w, h, o.stem ? 5 * o.s : h / 2); ctx.fill();
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  if (o.icon) drawIcon(ctx, bx + padX + 5 * o.s, y, o.icon, o.s);
  ctx.fillStyle = o.fg || '#fff';
  ctx.fillText(text, bx + padX + icon, y + 0.5);
  return true;
}

function drawIcon(ctx, x, y, cls, s) {
  const r = 5 * s;
  ctx.save();
  ctx.lineWidth = 1.2 * s; ctx.strokeStyle = '#fff';
  ctx.fillStyle = CLASS_COLOR[cls];
  ctx.beginPath();
  if (cls === 1) ctx.arc(x, y, r, 0, TAU);
  else if (cls === 2) ctx.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
  else if (cls === 5) ctx.arc(x, y, r * 0.7, 0, TAU);
  else {
    const dia = cx => { ctx.moveTo(cx, y - r * 1.15); ctx.lineTo(cx + r * 0.8, y); ctx.lineTo(cx, y + r * 1.15); ctx.lineTo(cx - r * 0.8, y); ctx.closePath(); };
    if (cls === 4) { dia(x - r * 0.55); dia(x + r * 0.75); } else dia(x);
  }
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

/**
 * Draw the overlay. view = {sw, sh, fw, fh, dpr}; o = toggles.
 * Returns counts for the status line.
 */
export function drawOverlay(ctx, scene, cam, view, o) {
  const { sw, sh, fw, fh } = view, s = view.dpr;
  const ox = (fw - sw) / 2, oy = (fh - sh) / 2, pt = [0, 0];
  const P = (d, j) => {
    if (!cam.project(d[j], d[j + 1], d[j + 2], fw, fh, pt)) return false;
    pt[0] -= ox; pt[1] -= oy;
    return true;
  };
  const inView = m => pt[0] > -m && pt[1] > -m && pt[0] < sw + m && pt[1] < sh + m;
  ctx.clearRect(0, 0, sw, sh);
  ctx.lineJoin = ctx.lineCap = 'round';
  // a letterboxed photo: keep the drawing inside the picture
  const letterbox = fw < sw - 1 || fh < sh - 1;
  if (letterbox) { ctx.save(); ctx.beginPath(); ctx.rect(-ox, -oy, fw, fh); ctx.clip(); }

  // polyline of consecutive drawable points; returns the longest on-screen stretch
  let lastPath = null;
  const stroke = (dirs, n, ok, skip) => {
    let pen = false, run = 0, best = null, startI = 0;
    const path = lastPath = new Path2D();
    for (let i = 0; i <= n; i++) {
      const good = i < n && (!ok || ok[i]) && P(dirs, i * 3) && inView(60);
      if (good) {
        if (!pen) { path.moveTo(pt[0], pt[1]); pen = true; run = 0; startI = i; }
        else path.lineTo(pt[0], pt[1]);
        run++;
      } else if (pen) {
        pen = false;
        if (!best || run > best.n) best = { n: run, i0: startI, i1: i - 1 };
      }
    }
    if (!skip) ctx.stroke(path);
    return best;
  };
  const anchor = (dirs, st) => {
    if (!st || st.n < 3) return null;
    const mid = (st.i0 + st.i1) >> 1;
    if (!P(dirs, mid * 3) || !inView(-20)) return null;
    const a = [pt[0], pt[1]];
    P(dirs, st.i0 * 3); const x0 = pt[0], y0 = pt[1];
    P(dirs, st.i1 * 3);
    return { x: a[0], y: a[1], len: Math.hypot(pt[0] - x0, pt[1] - y0) };
  };

  if (o.ridges) {
    // interior ridges, far ones fainter
    for (const r of scene.ridges) {
      const k = Math.max(0.25, Math.min(1, 2500 / r.d));
      ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.4 * k})`; ctx.lineWidth = (0.8 + 0.9 * k) * s;
      stroke(r.dirs, r.dirs.length / 3, null);
    }
    // skyline: only the arc in front of the camera
    const hd = Math.atan2(cam.R[6], cam.R[7]), half = Math.atan(0.5 / cam.fn) * 1.6 + 0.2;
    const a0 = Math.floor((hd - half) * scene.na / TAU), a1 = Math.ceil((hd + half) * scene.na / TAU);
    for (const [color, lw] of [['rgba(8,16,22,0.55)', 4.2], ['#ffffff', 2]]) {
      ctx.strokeStyle = color; ctx.lineWidth = lw * s;
      ctx.beginPath();
      let pen = false;
      for (let k = a0; k <= a1; k++) {
        const a = ((k % scene.na) + scene.na) % scene.na;
        if (P(scene.sky, a * 3)) { if (pen) ctx.lineTo(pt[0], pt[1]); else { ctx.moveTo(pt[0], pt[1]); pen = true; } }
        else pen = false;
      }
      ctx.stroke();
    }
  }

  const labels = [];
  if (o.runLines || o.labels) {
    const ribbons = [];
    for (const r of scene.runs) {
      const st = stroke(r.dirs, r.vis.length, r.vis, true);
      if (o.runLines && st) ribbons.push({ path: lastPath, cls: r.f.cls, near: r.near });
      if (o.labels && r.f.name) {
        const a = anchor(r.dirs, st);
        if (a && a.len > 26 * s) labels.push({ ...a, text: o.shade === 'slope' && r.f.pitch != null ? `${r.f.name}  ${r.f.pitch}°` : r.f.name, icon: r.f.cls, pri: r.near + 400 });
      }
    }
    // Glowing ribbons, far ones first and thinner: a soft halo, the color, a light center.
    ribbons.sort((a, b) => b.near - a.near);
    const wide = r => Math.max(0.55, Math.min(1.5, 900 / r.near)) * s;
    for (const [w, alpha, light] of [[9, 0.26, 0], [3.4, 0.95, 0], [1, 0.4, 1]]) {
      ctx.globalAlpha = alpha;
      for (const r of ribbons) {
        ctx.strokeStyle = light ? '#fff' : LINE_COLOR[r.cls]; ctx.lineWidth = w * wide(r);
        ctx.stroke(r.path);
      }
    }
    ctx.globalAlpha = 1;
  }
  if (o.lifts) {
    for (const l of scene.lifts) {
      // the lift being ridden runs straight overhead: leave it out
      if (l.f.index === o.hideLift) { l.ok.fill(0); continue; }
      for (let i = 0; i < l.ok.length; i++) l.ok[i] = l.vis[i] && l.dist[i] > LIFT_MIN_ACC_RATIO * scene.acc ? 1 : 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 4.6 * s;
      stroke(l.dirs, l.ok.length, l.ok);
      const liftColor = LIFT_COLOR;
      ctx.strokeStyle = liftColor; ctx.lineWidth = 2.6 * s;
      const st = stroke(l.dirs, l.ok.length, l.ok);
      // stations
      for (const i of [0, l.ok.length - 1]) {
        if (l.ok[i] && P(l.dirs, i * 3) && inView(0)) {
          ctx.fillStyle = liftColor; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * s;
          ctx.beginPath(); ctx.arc(pt[0], pt[1], 4.5 * s, 0, TAU); ctx.fill(); ctx.stroke();
        }
      }
      if (o.labels) {
        const a = anchor(l.dirs, st);
        if (a && a.len > 18 * s) labels.push({ ...a, text: l.f.name || 'Lift', lift: true, pri: l.near * 0.5 });
      }
    }
  }

  if (scene.route) {
    // the planned route on top of everything: the way on behind a ridge faint and dashed
    const r = scene.route;
    ctx.setLineDash([7 * s, 6 * s]);
    ctx.strokeStyle = 'rgba(8,16,22,0.35)'; ctx.lineWidth = 4.4 * s;
    stroke(r.dirs, r.n, r.hid);
    ctx.strokeStyle = 'rgba(255,216,74,0.8)'; ctx.lineWidth = 2.2 * s;
    stroke(r.dirs, r.n, r.hid);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(8,16,22,0.7)'; ctx.lineWidth = 8 * s;
    stroke(r.dirs, r.n, r.vis);
    ctx.strokeStyle = ROUTE_COLOR; ctx.lineWidth = 4.4 * s;
    stroke(r.dirs, r.n, r.vis);
  }

  o.taken = []; o.s = s; o.sw = sw; o.sh = sh;
  ctx.font = `600 ${12 * s}px "Barlow Condensed", "Helvetica Neue", Arial, sans-serif`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  let shown = 0;
  if (o.peaks) {
    let n = 0;
    for (const p of scene.peaks) {
      if (n >= 5) break;
      if (!P(p.dir, 0) || !inView(-30)) continue;
      const x = pt[0], y = pt[1], ly = Math.max(16 * s, y - 34 * s);
      const text = `${p.name}  ${Math.round(p.ele * 3.28084).toLocaleString()}'`;
      if (pill(ctx, x, ly, text, { ...o, taken: o.taken, bg: 'rgba(255,255,255,0.88)', fg: '#0c1a22' })) {
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1 * s;
        ctx.beginPath(); ctx.moveTo(x, ly + 10 * s); ctx.lineTo(x, y); ctx.stroke();
        n++;
      }
    }
  }
  if (scene.places) {
    // saved spots first, so names never push them off: dimmed when a ridge is in the way
    ctx.font = `600 ${13 * s}px "Barlow Condensed", "Helvetica Neue", Arial, sans-serif`;
    for (const q of scene.places) {
      if (!P(q.dir, 0) || !inView(-10)) continue;
      const x = pt[0], y = pt[1], dist = q.d >= 1000 ? `${(q.d / 1000).toFixed(1)} km` : `${Math.round(q.d / 10) * 10} m`;
      const dz = Math.abs(q.dz) < 10 ? '' : ` · ${q.dz > 0 ? '↑' : '↓'}${Math.round(Math.abs(q.dz))} m`;
      ctx.fillStyle = q.vis ? PLACE_COLOR : 'rgba(255,255,255,0.6)'; ctx.strokeStyle = 'rgba(8,16,22,0.8)'; ctx.lineWidth = 1.5 * s;
      ctx.beginPath(); ctx.arc(x, y, 4.5 * s, 0, TAU); ctx.fill(); ctx.stroke();
      const ly = Math.max(14 * s, y - 30 * s);
      ctx.strokeStyle = q.vis ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.2 * s;
      ctx.beginPath(); ctx.moveTo(x, ly + 10 * s); ctx.lineTo(x, y - 4.5 * s); ctx.stroke();
      pill(ctx, x, ly, `${q.p.emoji || ''} ${q.p.name} · ${dist}${dz}${q.vis ? '' : ' · behind ridge'}`.trim(),
        { ...o, taken: o.taken, bg: q.vis ? 'rgba(255,255,255,0.94)' : 'rgba(12,20,27,0.9)', fg: q.vis ? '#0c1a22' : '#b7c4cb' });
    }
    ctx.font = `600 ${12 * s}px "Barlow Condensed", "Helvetica Neue", Arial, sans-serif`;
  }
  labels.sort((a, b) => a.pri - b.pri);
  for (const l of labels) {
    if (shown >= 26) break;
    // with run lines on, a run's name is a tag in the run's color pointing at its line
    const tag = o.runLines && !l.lift;
    const opt = l.lift ? { ...o, taken: o.taken, bg: 'rgba(124,58,237,0.94)' }
      : tag ? { ...o, taken: o.taken, icon: l.icon, bg: TAG_COLOR[l.icon], stem: 20 * s }
        : { ...o, taken: o.taken, icon: l.icon };
    if (pill(ctx, l.x, tag ? l.y - 20 * s : l.y, l.text, opt)) shown++;
  }
  if (letterbox) ctx.restore();
  return { labels: shown };
}
