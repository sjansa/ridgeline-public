// liftride.js -- notice when the rider is going up a lift line, from GPS alone:
// staying on one lift's line, moving along it uphill at lift speed.

import { LIFT_SPEED } from './route.js?v=1123.1925-052acda';

const KEEP_S = 90;          // seconds of fixes kept
const MIN_GAIN_M = 30;      // meters gained along the line before calling it a ride
const MIN_SPEED = 1.2;      // m/s: slower is walking or standing in line (carpets excepted)
const MAX_SPEED = 13;       // m/s: faster than any lift
const TOP_M = 15;           // this close to the top station: off the lift
const MISSES = 2;           // fixes in a row off the line before the ride ends
const HANG_M = 2;           // chair or cabin floor below the cable, roughly
const BARO_UP = 0.15;       // m/s: with a barometer, a ride must be climbing at least this fast
const BARO_DOWN = -0.5;     // m/s: going down this fast is skiing under the lift, not riding it

/** How far off a lift line a fix may sit and still be on it. */
const tol = acc => Math.min(50, Math.max(15, 1.5 * (acc || 10)));

export class LiftRide {
  constructor(lifts) {
    const lat0 = lifts.length ? lifts[0].pts[0][0] : 0;
    this.mN = 110540; this.mE = 111320 * Math.cos(lat0 * Math.PI / 180);
    this.lifts = lifts.map(l => {
      const xy = l.pts.map(p => [p[1] * this.mE, p[0] * this.mN]), s = [0];
      for (let i = 1; i < xy.length; i++) s.push(s[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
      const xs = xy.map(q => q[0]), ys = xy.map(q => q[1]);
      return { l, xy, s, len: s.at(-1), box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
    });
    this.hist = []; this.ride = null;
  }

  /** Nearest point on lift L: { d (m off the line), s (m along it) }. */
  project(L, x, y) {
    let best = { d: Infinity, s: 0 };
    for (let i = 1; i < L.xy.length; i++) {
      const [ax, ay] = L.xy[i - 1], [bx, by] = L.xy[i], dx = bx - ax, dy = by - ay, q = dx * dx + dy * dy;
      const t = q ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / q)) : 0;
      const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
      if (d < best.d) best = { d, s: L.s[i - 1] + t * (L.s[i] - L.s[i - 1]) };
    }
    return best;
  }
  /** Cable height at s meters along lift L. */
  zAt(L, s) {
    let i = 1;
    while (i < L.s.length - 1 && L.s[i] < s) i++;
    const f = (s - L.s[i - 1]) / ((L.s[i] - L.s[i - 1]) || 1), z = L.l.z;
    return z[i - 1] + (z[i] - z[i - 1]) * Math.max(0, Math.min(1, f));
  }

  /**
   * Feed a fix ({lat, lon, acc, climb}; t in seconds). climb: m/s up from the
   * barometer, when the phone has one; it vetoes a ride that is not climbing. Returns the ride or null:
   * { lift (the prepared lift), up (+1 riding toward its last point, -1 toward its first),
   *   s, left (m to the top), tLeft (s), speed (m/s), top [lat, lon], cableZ }.
   */
  update(fix, t = performance.now() / 1000) {
    const x = fix.lon * this.mE, y = fix.lat * this.mN;
    this.hist.push({ x, y, acc: fix.acc || 10, t });
    while (this.hist.length && t - this.hist[0].t > KEEP_S) this.hist.shift();
    const R = this.ride;
    if (R) {
      const L = R.L, p = this.project(L, x, y);
      if (p.d > tol(fix.acc)) { if (++R.miss >= MISSES) this.ride = null; return this.ride && this.out(); }
      R.miss = 0;
      if (fix.climb != null && fix.climb < BARO_DOWN) { this.ride = null; return null; }
      const back = (R.s - p.s) * R.up;
      if (back > Math.max(40, 2 * (fix.acc || 10))) { this.ride = null; return null; }   // heading back down: skiing under it
      if (back < 0) {
        const dt = t - R.t;
        if (dt > 0) R.speed = 0.7 * R.speed + 0.3 * Math.min(MAX_SPEED, -back / dt);
        R.s = p.s; R.t = t;
      }
      if ((R.up > 0 ? L.len - R.s : R.s) < TOP_M) { this.ride = null; return null; }
      return this.out();
    }
    // not riding: look for a lift whose line every recent fix sits on, climbing steadily
    for (const L of this.lifts) {
      const m = 50;
      if (x < L.box[0] - m || x > L.box[2] + m || y < L.box[1] - m || y > L.box[3] + m) continue;
      const now = this.project(L, x, y);
      if (now.d > tol(fix.acc)) continue;
      // walk back through the history while it stays on this line and behind us
      let first = null;
      for (let k = this.hist.length - 2; k >= 0; k--) {
        const h = this.hist[k], p = this.project(L, h.x, h.y);
        if (p.d > tol(h.acc)) break;
        first = { s: p.s, t: h.t, acc: h.acc };
      }
      if (!first) continue;
      const gain = now.s - first.s, up = Math.sign(gain), dt = t - first.t;
      if (Math.abs(gain) < Math.max(MIN_GAIN_M, 1.5 * Math.max(fix.acc || 10, first.acc)) || dt <= 0) continue;
      const v = Math.abs(gain) / dt, slow = L.l.type === 'magic_carpet' ? 0.3 : MIN_SPEED;
      if (v < slow || v > MAX_SPEED) continue;
      if (this.zAt(L, now.s) - this.zAt(L, first.s) < 3) continue;   // must be going up
      if (fix.climb != null && L.l.type !== 'magic_carpet' && fix.climb < BARO_UP) continue;
      if ((up > 0 ? L.len - now.s : now.s) < TOP_M) continue;
      this.ride = { L, up, s: now.s, t, speed: v, miss: 0 };
      return this.out();
    }
    return null;
  }

  out() {
    const R = this.ride, L = R.L, left = R.up > 0 ? L.len - R.s : R.s;
    const v = R.speed > 0.3 ? R.speed : LIFT_SPEED[L.l.type] || 3;
    return { lift: L.l, up: R.up, s: R.s, left, tLeft: left / v, speed: R.speed, top: R.up > 0 ? L.l.pts.at(-1) : L.l.pts[0], cableZ: this.zAt(L, R.s) - HANG_M };
  }
  end() { this.ride = null; this.hist = []; }
}
