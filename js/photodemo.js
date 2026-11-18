// photodemo.js -- demo mode on a real photograph.
//
// A wide panorama photo stands in for the camera: the demo looks around inside
// it, and the overlay has to line up with a real mountain. The panorama is
// treated as a cylinder whose sweep is not quite even (a phone panorama drifts
// as it is swept), so its calibration is a row of knots across the width: the
// compass direction at each knot and the height of the level line there.
// The knots were fitted offline by matching the photo's skyline to the terrain.

import { D2R } from './terrain.js?v=1117.2337-974109f';

/**
 * Alta, Albion Basin, 17 February 2023.
 * az: degrees clockwise from north at 13 evenly spaced knots, left to right.
 * y0: height of the level line at each knot, as a fraction of image height from the top.
 * f: focal length as a fraction of image width; aspect: height / width.
 * pan: the headings the view may reach, left and right.
 */
export const ALTA = {
  label: 'Alta: Albion Basin (photo)',
  src: 'demo/alta_albion.jpg',
  credit: 'Photo: PalauanReich, CC BY-SA 4.0, Wikimedia Commons',
  lat: 40.57426, lon: -111.608369, yaw: 300,
  pan: [232, 392],      // headings the view may show: the left end of the sweep is tilted, the right end is rock
  aspect: 0.29968, f: 0.23291,
  az: [175.9, 197.3, 218.45, 238.85, 258.1, 277.6, 297.4, 316.9, 336.2, 355.65, 375.65, 395.55, 415.45],
  y0: [0.5153, 0.5048, 0.4895, 0.4701, 0.4427, 0.4122, 0.3878, 0.37, 0.3713, 0.3738, 0.3751, 0.3835, 0.392],
};

const SKY_SPARE = 10;      // degrees of sky the view may show above the photo's top edge (the top row is stretched)
const SIDE_SPARE = 1.5;    // degrees kept clear of the usable left and right ends
const FOOT_SPARE = 2.5;    // degrees kept clear of the photo's bottom edge

/** Level-line height (fraction of image height) at a heading. */
function levelAt(cal, yawDeg) {
  const n = cal.az.length - 1;
  const a = ((yawDeg - cal.az[0]) % 360 + 360) % 360 + cal.az[0];
  for (let i = 0; i < n; i++) {
    if (a <= cal.az[i + 1]) {
      const k = (a - cal.az[i]) / (cal.az[i + 1] - cal.az[i]);
      return cal.y0[i] + (cal.y0[i + 1] - cal.y0[i]) * k;
    }
  }
  return cal.y0[n];
}

/** Elevation range (degrees) the photo covers at a heading: [bottom, top]. */
function coverAt(cal, yawDeg) {
  const y0 = levelAt(cal, yawDeg), k = cal.aspect / cal.f;
  return [Math.atan(-(1 - y0) * k) / D2R + FOOT_SPARE, Math.atan(y0 * k) / D2R];
}

/** Smallest focal length (fraction of view width) at which a view of this shape fits inside the photo. */
export function minFn(cal, viewAspect) {
  let fn = 0.5 / Math.tan((cal.pan[1] - cal.pan[0] - 2 * SIDE_SPARE) * D2R / 4);    // at most half the sweep across
  for (let i = 0; i < cal.az.length; i++) {
    const [lo, hi] = coverAt(cal, cal.az[i]);
    fn = Math.max(fn, 0.5 * viewAspect / Math.tan((hi + SKY_SPARE - lo) * D2R / 2));
  }
  return fn;
}

/** Keep a view inside the photo. Returns the clamped {yaw, pitch}. */
export function clampView(cal, yaw, pitch, fn, viewAspect) {
  const hf = Math.atan(0.5 / fn) / D2R, vf = Math.atan(0.5 * viewAspect / fn) / D2R;
  const a0 = cal.pan[0] + hf + SIDE_SPARE, a1 = cal.pan[1] - hf - SIDE_SPARE;
  let a = ((yaw - cal.az[0]) % 360 + 360) % 360 + cal.az[0];
  if (a > a1) a = a - a1 < a0 + 360 - a ? a1 : a0;     // past the end: stop at the nearer one
  a = Math.max(a0, Math.min(a1, a));
  // the tightest cover across the width of the view
  let lo = -90, hi = 90;
  for (const d of [-hf, 0, hf]) {
    const c = coverAt(cal, a + d);
    lo = Math.max(lo, c[0]); hi = Math.min(hi, c[1]);
  }
  const pMin = lo + vf, pMax = hi + SKY_SPARE - vf;
  return { yaw: a, pitch: pMin > pMax ? (pMin + pMax) / 2 : Math.max(pMin, Math.min(pMax, pitch)) };
}

const VERT = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
const FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform mat3 uRt;            // camera -> world
uniform vec2 uSize;
uniform float uFn, uK1, uF, uAspect;
uniform float uAz[13];
uniform float uY0[13];
void main() {
  vec2 p = vec2(gl_FragCoord.x - 0.5 * uSize.x, 0.5 * uSize.y - gl_FragCoord.y) / (uFn * uSize.x);
  vec2 q = p;
  for (int i = 0; i < 4; i++) q = p / (1.0 + uK1 * dot(q, q));
  vec3 d = uRt * vec3(q, 1.0);
  float t = d.z / length(d.xy);
  float a = mod(degrees(atan(d.x, d.y)) - uAz[0], 360.0) + uAz[0];
  float u = -1.0, y0 = 0.0;
  for (int i = 0; i < 12; i++) {
    if (a >= uAz[i] && a <= uAz[i + 1]) {
      float k = (a - uAz[i]) / (uAz[i + 1] - uAz[i]);
      u = (float(i) + k) / 12.0; y0 = mix(uY0[i], uY0[i + 1], k);
    }
  }
  if (u < 0.0) { gl_FragColor = vec4(0.05, 0.1, 0.13, 1.0); return; }
  gl_FragColor = vec4(texture2D(uTex, vec2(u, clamp(y0 - t * uF / uAspect, 0.0, 1.0))).rgb, 1.0);
}`;

/** Draws views of a calibrated panorama photo into its own canvas. */
export class PhotoPano {
  constructor() {
    this.canvas = document.createElement('canvas');
    // kept after drawing: the frame loop copies this canvas into its own texture and the analysis frame
    const gl = this.gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('This browser cannot draw the demo photo.');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'Demo photo shader failed.');
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of ['uTex', 'uRt', 'uSize', 'uFn', 'uK1', 'uF', 'uAspect', 'uAz', 'uY0']) this.u[n] = gl.getUniformLocation(prog, n);
    this.cal = null;
  }

  /** Load a panorama (once); resolves when it can be drawn. */
  async load(cal) {
    if (this.cal === cal) return;
    const img = new Image();
    img.src = cal.src;
    await img.decode();
    const gl = this.gl, max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    let src = img;
    if (img.naturalWidth > max) {
      // an older phone: shrink the photo to the largest texture it takes
      src = document.createElement('canvas');
      src.width = max; src.height = Math.round(img.naturalHeight * max / img.naturalWidth);
      src.getContext('2d').drawImage(img, 0, 0, src.width, src.height);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex || (this.tex = gl.createTexture()));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform1f(this.u.uF, cal.f); gl.uniform1f(this.u.uAspect, cal.aspect);
    gl.uniform1fv(this.u.uAz, new Float32Array(cal.az)); gl.uniform1fv(this.u.uY0, new Float32Array(cal.y0));
    this.cal = cal;
  }

  /** Draw what `cam` sees into a w x h frame. */
  render(cam, w, h) {
    const gl = this.gl, c = this.canvas;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniformMatrix3fv(this.u.uRt, false, new Float32Array(cam.R));     // row-major R read as columns is its transpose
    gl.uniform2f(this.u.uSize, w, h);
    gl.uniform1f(this.u.uFn, cam.fn); gl.uniform1f(this.u.uK1, cam.k1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
