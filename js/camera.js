// camera.js -- pinhole camera with one radial distortion term.
//
// World frame is ENU (x east, y north, z up). Camera frame is image-style:
// x right, y down, z forward. R is world -> camera, row-major 3x3.
// Intrinsics are resolution-free: fn is the focal length as a fraction of the
// frame WIDTH, so the same camera describes the full video frame and the small
// analysis frame. Distortion: u_d = u * (1 + k1 * r^2) in focal-length units.

import { D2R } from './terrain.js?v=1118.0227-f84010f';

export function matMul(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}
export function matT(a) { return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]]; }
export const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** World -> camera for a heading (deg clockwise from north), pitch up, roll. */
export function rotFromYPR(yawDeg, pitchDeg, rollDeg = 0) {
  const y = yawDeg * D2R, p = pitchDeg * D2R, r = rollDeg * D2R;
  const sy = Math.sin(y), cy = Math.cos(y), sp = Math.sin(p), cp = Math.cos(p);
  const f = [sy * cp, cy * cp, sp];
  const r0 = [cy, -sy, 0];
  const u0 = [-sy * sp, -cy * sp, cp];
  const cr = Math.cos(r), sr = Math.sin(r);
  const right = [cr * r0[0] + sr * u0[0], cr * r0[1] + sr * u0[1], cr * r0[2] + sr * u0[2]];
  const up = [cr * u0[0] - sr * r0[0], cr * u0[1] - sr * r0[1], cr * u0[2] - sr * r0[2]];
  return [right[0], right[1], right[2], -up[0], -up[1], -up[2], f[0], f[1], f[2]];
}

/** Heading/pitch/roll in degrees of a world -> camera rotation. */
export function yprFromRot(R) {
  const yaw = Math.atan2(R[6], R[7]) / D2R;
  const pitch = Math.asin(Math.max(-1, Math.min(1, R[8]))) / D2R;
  // roll: angle of the camera's right axis out of the horizontal plane
  const roll = Math.atan2(R[2], -R[5]) / D2R;
  return { yaw: (yaw + 360) % 360, pitch, roll };
}

/** World rotation that turns headings by -deg: the camera looks deg further clockwise. */
export function yawMat(deg) {
  const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
/** Camera-frame correction: pitch about x (up positive), then roll about z. */
export function pitchRollMat(pitchDeg, rollDeg) {
  const cp = Math.cos(pitchDeg * D2R), sp = Math.sin(pitchDeg * D2R);
  const cr = Math.cos(rollDeg * D2R), sr = Math.sin(rollDeg * D2R);
  const Rx = [1, 0, 0, 0, cp, sp, 0, -sp, cp];
  const Rz = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
  return matMul(Rx, Rz);
}

/** Re-orthonormalize a nearly-orthogonal matrix (Gram-Schmidt on rows). */
export function orthonormalize(R) {
  let x = [R[0], R[1], R[2]], y = [R[3], R[4], R[5]];
  const nx = Math.hypot(...x); x = x.map(v => v / nx);
  const d = x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  y = y.map((v, i) => v - d * x[i]);
  const ny = Math.hypot(...y); y = y.map(v => v / ny);
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [...x, ...y, ...z];
}

export class Camera {
  constructor(R = IDENT, fn = 0.8, k1 = 0) { this.R = R; this.fn = fn; this.k1 = k1; }
  clone() { return new Camera(this.R.slice(), this.fn, this.k1); }
  static hfovToFn(hfovDeg) { return 0.5 / Math.tan(hfovDeg * D2R / 2); }
  get hfov() { return 2 * Math.atan(0.5 / this.fn) / D2R; }

  /**
   * Project a world direction into a w x h frame (centered principal point).
   * Writes out[0..1]; returns false when the point is behind the camera or so
   * far off-axis that the distortion model is meaningless.
   */
  project(dx, dy, dz, w, h, out) {
    const R = this.R;
    const z = R[6] * dx + R[7] * dy + R[8] * dz;
    if (z <= 1e-6) return false;
    const x = (R[0] * dx + R[1] * dy + R[2] * dz) / z;
    const y = (R[3] * dx + R[4] * dy + R[5] * dz) / z;
    const r2 = x * x + y * y;
    if (r2 > 9) return false;
    const s = (1 + this.k1 * r2) * this.fn * w;
    out[0] = w / 2 + x * s; out[1] = h / 2 + y * s;
    return true;
  }

  /** World direction (unnormalized, forward component 1) through a pixel. */
  unproject(u, v, w, h, out) {
    const f = this.fn * w;
    const xd = (u - w / 2) / f, yd = (v - h / 2) / f;
    let x = xd, y = yd;
    if (this.k1 !== 0) for (let i = 0; i < 4; i++) {
      const s = 1 + this.k1 * (x * x + y * y);
      x = xd / s; y = yd / s;
    }
    const R = this.R;
    out[0] = R[0] * x + R[3] * y + R[6];
    out[1] = R[1] * x + R[4] * y + R[7];
    out[2] = R[2] * x + R[5] * y + R[8];
    return out;
  }
}
