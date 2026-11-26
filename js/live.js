// live.js -- the rules of a live camera view, shared by Ridgeline and Moonshot (app/core):
// when to match the skyline, how far to search, how a match is taken up, and when
// the viewpoint follows GPS. Taken from Moonshot's live view, which held the ridges
// better in the field. No DOM.

import { matMul, pitchRollMat, orthonormalize } from './camera.js?v=1125.2219-5046fd2';

export const LIVE = {
  SOLVE_MS: 900,            // skyline match this often while looking for a lock...
  SOLVE_LOCKED_MS: 1800,    // ...and this often once locked
  HOLD_MS: 4000,            // after a drag or pinch, no match for this long: the hand wins for a while
  SWING_DEG_S: 12,          // phone turning faster than this: the picture is smeared, skip the match
  MAX_YAW: 45,              // search this far either side of the compass while not locked
  MAX_YAW_LOCKED: 10,       // ...and this far once locked
  MISSES: 3,                // failed matches in a row before the lock is let go
  HALF_STEP_DEG: 3,         // locked, a correction smaller than this is taken half at a time
  MAX_DIST_M: 60000,        // skyline model out to this distance
  // viewpoint following GPS
  STEP_M: 4,                // a move this big (or half the fix's error, if more) rebuilds the view
  GOOD_FIX_M: 20,           // fixes worse than this do not move the viewpoint
  SETTLE_MS: 2000,          // a move counts once the position has stayed put this long...
  SETTLE_M: 3,              // ...within this
  // ...but a big move is taken at once, on the move and from a rougher fix: a viewpoint
  // 30 m out is far better than one left a kilometer behind
  FAR_M: 40,                // this far (or twice the fix's error, if more) from the drawn spot
  FAR_FIX_M: 50,            // from fixes this good or better
  FAR_EVERY_MS: 5000,       // at most this often
};
/** Focal guesses while the lens is unknown: main, ultra-wide, tele. */
export const ZOOMS = [1, 0.6, 1.65];

export const metersApart = (a, b) => Math.hypot((a.lat - b.lat) * 110540, (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));

/** How long to wait between skyline matches. */
export const solveEvery = locked => (locked ? LIVE.SOLVE_LOCKED_MS : LIVE.SOLVE_MS);

/**
 * Options for solveAlignment in a live view. aimHeld: the aim is not from the compass
 * (a camera on a tripod, no motion sensors): search all the way round.
 */
export function liveSolveOpts({ locked, lensKnown, aimHeld = false }) {
  return {
    maxYaw: locked ? LIVE.MAX_YAW_LOCKED : aimHeld ? 180 : LIVE.MAX_YAW,
    lens: true, strict: true,
    zooms: locked || lensKnown ? null : ZOOMS,
  };
}

/**
 * Take up a match. c = {yawCorr, camCorr, fn, k1, locked, misses} is changed in place;
 * fnMin/fnMax clamp the focal length; lens: false leaves fn and k1 alone.
 * Returns {ok, remember}: remember is true when a second agreeing match says the lens is worth keeping.
 */
export function applySolve(c, sol, { fnMin = 0, fnMax = Infinity, lens = true } = {}) {
  if (sol && sol.ok) {
    const k = c.locked && Math.abs(sol.yaw) < LIVE.HALF_STEP_DEG ? 0.5 : 1;   // once locked, half steps: steady but still tracks drift
    c.yawCorr += sol.yaw * k;
    c.camCorr = orthonormalize(matMul(pitchRollMat(sol.pitch * k, sol.roll * k), c.camCorr));
    if (lens) {
      c.fn = Math.min(fnMax, Math.max(fnMin, c.fn * Math.pow(sol.fScale, k)));
      c.k1 += (sol.k1 - c.k1) * k;
    }
    const remember = c.locked && lens;
    c.locked = true; c.misses = 0;
    return { ok: true, remember };
  }
  if (++c.misses > LIVE.MISSES) c.locked = false;
  return { ok: false, remember: false };
}

/**
 * The viewpoint follows GPS: a good fix that has stayed put for a moment, far enough
 * from where the view is drawn from, calls move(fix); so does a big move, straight away.
 * here() gives that spot ({lat, lon}).
 */
export class StandFollow {
  constructor(here, move) { this.here = here; this.move = move; this.last = null; this.timer = 0; this.farT = -Infinity; }
  fix(p, now = Date.now()) {
    this.last = p;
    clearTimeout(this.timer);
    const h = this.here();
    if (h && p.acc <= LIVE.FAR_FIX_M && now - this.farT >= LIVE.FAR_EVERY_MS && metersApart(p, h) >= Math.max(LIVE.FAR_M, 2 * p.acc)) {
      this.farT = now;
      this.move(p);
      return;
    }
    this.timer = setTimeout(() => {
      const q = this.last, h = this.here();
      if (!q || metersApart(q, p) > LIVE.SETTLE_M || !(q.acc <= LIVE.GOOD_FIX_M) || !h) return;
      if (metersApart(q, h) >= Math.max(LIVE.STEP_M, 0.5 * q.acc)) this.move(q);
    }, LIVE.SETTLE_MS);
  }
  stop() { clearTimeout(this.timer); this.last = null; }
}
