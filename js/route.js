// route.js -- in-resort routing over the lift and run network. No DOM.
//
// The network is the mapped runs (followed downhill) and lifts (ridden up,
// or both ways for trams and gondolas). OSM rarely joins them exactly, so a
// run or lift end within JOIN_M of another feature is treated as connected,
// and a short downhill traverse over gentle ground (TRAVERSE_M, under
// TRAVERSE_MAX_DEG) bridges wider gaps; those legs are flagged as traverses.
// Routes are the fastest by estimated time: lift rides plus skiing.

export const JOIN_M = 40;             // ends this close count as connected
export const TRAVERSE_M = 150;        // longest gap a traverse may bridge
export const TRAVERSE_MAX_DEG = 25;   // steepest ground a traverse may cross
export const OFF_ROUTE_M = 50;        // farther than this from the route: reroute
export const ARRIVED_M = 30;

const SKI = 7;              // m/s down a run, stops included
const GLIDE = 3;            // m/s over a join, roughly level
const WALK = 1;             // m/s sidestepping or walking up a join
const CLIMB_MAX = 12;       // meters a join may climb
const TRAVERSE = 3;         // m/s along a traverse
const WALK_M = 400;        // farthest walk on foot to the nearest lift or run, from a lot or lodge
const LOAD_S = 120;         // average wait and loading at a lift
export const LIFT_SPEED = {        // m/s along the line
  cable_car: 10, gondola: 5, mixed_lift: 5, chair_lift: 3.5, drag_lift: 3, 't-bar': 3, 'j-bar': 3, platter: 3, rope_tow: 2, magic_carpet: 0.7,
};
const BOTH_WAYS = new Set(['cable_car', 'gondola', 'mixed_lift']);
const SHORT_RUN_M = 150;   // shorter or unnamed stretches of a run fold into the run next to them
const FLAT_M = 6;           // a run whose ends differ by less than this may be skied either way

export const featKey = (kind, index) => `${kind}:${index}`;

/** Whether a feature may be used at a difficulty limit (1 green .. 4 double black) with an avoid set. */
export function allowedFeat(f, maxCls, avoid) {
  if (avoid?.has(f.key)) return false;
  if (f.kind !== 'run') return true;
  return f.cls <= maxCls || (f.cls === 5 && maxCls >= 2);
}

/**
 * Build the network from prepared features (runs.js prepareFeatures).
 * terrain: elevations for stations and traverses. slopeAt(lon, lat): ground
 * slope in degrees (NaN where unknown).
 */
export function buildNetwork(prep, terrain, slopeAt, opts = {}) {
  const joinM = opts.joinM ?? JOIN_M, travM = opts.traverseM ?? TRAVERSE_M;
  const all = [...prep.runs.filter(r => !r.area && r.pts.length > 1), ...prep.lifts];
  let lat0 = 0, lon0 = 0;
  for (const f of all) { lat0 += f.pts[0][0]; lon0 += f.pts[0][1]; }
  lat0 /= Math.max(1, all.length); lon0 /= Math.max(1, all.length);
  const mN = 110540, mE = 111320 * Math.cos(lat0 * Math.PI / 180);
  const xy = (lat, lon) => [(lon - lon0) * mE, (lat - lat0) * mN];
  const net = { feats: [], lat: [], lon: [], x: [], y: [], z: [], feat: [], adj: [], ends: [], xy, mE, mN, lat0, lon0, terrain, slopeAt, joinM, travM };
  const node = (lat, lon, z, fi) => {
    const [x, y] = xy(lat, lon), i = net.lat.length;
    net.lat.push(lat); net.lon.push(lon); net.x.push(x); net.y.push(y); net.z.push(z); net.feat.push(fi); net.adj.push([]);
    return i;
  };
  const edge = (a, b, t, kind, fi, path = null) => net.adj[a].push({ to: b, t, kind, feat: fi, path });

  for (const r of prep.runs) {
    if (r.area || r.pts.length < 2) continue;
    const fi = net.feats.length, n = r.pts.length;
    const ids = r.pts.map((p, i) => node(p[0], p[1], r.z[i], fi));
    const drop = r.z[0] - r.z[n - 1], fwd = drop >= -FLAT_M, back = drop <= FLAT_M;
    // downhill order: rank along the run from its top, for "get to this run"
    const top = drop >= 0 ? 0 : n - 1;
    net.feats.push({ kind: 'run', index: r.index, key: featKey('run', r.index), name: r.name, cls: r.cls, ids, top });
    for (let i = 1; i < n; i++) {
      const a = ids[i - 1], b = ids[i];
      const t = Math.hypot(net.x[b] - net.x[a], net.y[b] - net.y[a], net.z[b] - net.z[a]) / SKI;
      if (fwd) edge(a, b, t, 'run', fi);
      if (back) edge(b, a, t, 'run', fi);
    }
    net.ends.push(ids[0], ids[n - 1]);
  }
  for (const l of prep.lifts) {
    const fi = net.feats.length, n = l.pts.length;
    const g = p => terrain.elev(p[1], p[0]);
    const a = node(l.pts[0][0], l.pts[0][1], g(l.pts[0]), fi), b = node(l.pts[n - 1][0], l.pts[n - 1][1], g(l.pts[n - 1]), fi);
    let len = 0;
    for (let i = 1; i < n; i++) len += Math.hypot((l.pts[i][0] - l.pts[i - 1][0]) * mN, (l.pts[i][1] - l.pts[i - 1][1]) * mE, l.z[i] - l.z[i - 1]);
    const t = LOAD_S + len / (LIFT_SPEED[l.type] || 3);
    // lifts are mapped in the direction they run; trust that unless the way plainly
    // runs downhill (drawn backwards). A tunnel carpet may well end lower than it starts.
    const up = net.z[b] >= net.z[a] - 30;
    const path = l.pts.map((p, i) => [p[0], p[1], l.z[i]]);
    const [lo, hi] = up ? [a, b] : [b, a];
    net.feats.push({ kind: 'lift', index: l.index, key: featKey('lift', l.index), name: l.name, type: l.type, ids: [lo, hi], len });
    edge(lo, hi, t, 'lift', fi, up ? path : path.slice().reverse());
    if (BOTH_WAYS.has(l.type)) edge(hi, lo, t, 'lift', fi, up ? path.slice().reverse() : path);
    net.ends.push(a, b);
  }

  // spatial hash of every node, cells the size of the longest link
  const cell = travM, hash = new Map();
  const hk = (cx, cy) => cx * 100003 + cy;
  for (let i = 0; i < net.x.length; i++) {
    const k = hk(Math.floor(net.x[i] / cell), Math.floor(net.y[i] / cell));
    let b = hash.get(k); if (!b) hash.set(k, b = []); b.push(i);
  }
  net.near = (x, y, r) => {
    const out = [], cx = Math.floor(x / cell), cy = Math.floor(y / cell), n = Math.ceil(r / cell);
    for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) {
      const b = hash.get(hk(cx + dx, cy + dy));
      if (b) for (const i of b) if (Math.hypot(net.x[i] - x, net.y[i] - y) <= r) out.push(i);
    }
    return out;
  };

  // links between features: from every end to the nearest node of each feature around it
  for (const e of net.ends) {
    for (const [j, d] of nearestPerFeature(net, net.x[e], net.y[e], travM, net.feat[e])) {
      for (const [a, b] of [[e, j], [j, e]]) {
        const l = link(net, net.lat[a], net.lon[a], net.z[a], net.lat[b], net.lon[b], net.z[b], d);
        if (l) edge(a, b, l.t, l.kind, -1, l.path);
      }
    }
  }
  return net;
}

/** For each feature (other than `skip`) with a node within r of (x, y): its nearest node -> [[node, dist]]. */
function nearestPerFeature(net, x, y, r, skip = -2) {
  const best = new Map();
  for (const i of net.near(x, y, r)) {
    const f = net.feat[i];
    if (f === skip) continue;
    const d = Math.hypot(net.x[i] - x, net.y[i] - y), b = best.get(f);
    if (!b || d < b[1]) best.set(f, [i, d]);
  }
  return [...best.values()];
}

/**
 * Can you get from a to b off the mapped lines? Close: a join, gliding or
 * sidestepping a little. Further: a traverse, only downhill-ish and over
 * gentle ground. -> {t, kind: 'join' | 'traverse', path} or null.
 */
function link(net, la, lo, za, lb, lob, zb, d) {
  const dz = zb - za;
  if (d <= net.joinM) {
    if (dz > CLIMB_MAX) return null;
    const t = dz > 2 ? d / WALK + dz * 3 : d / GLIDE + 1;
    return { t, kind: 'join', path: [[la, lo, za], [lb, lob, zb]] };
  }
  if (dz > 2) return null;
  const n = Math.max(2, Math.ceil(d / 10)), path = [];
  let prev = za, climb = 0;
  for (let k = 0; k <= n; k++) {
    const f = k / n, lat = la + (lb - la) * f, lon = lo + (lob - lo) * f;
    const z = k === 0 ? za : k === n ? zb : net.terrain.elev(lon, lat) + 0.5;
    if (!(z === z)) return null;
    if (k > 0 && k < n) {
      const s = net.slopeAt(lon, lat);
      if (s > TRAVERSE_MAX_DEG) return null;
    }
    climb += Math.max(0, z - prev); prev = z;
    path.push([lat, lon, z]);
  }
  if (climb > 8) return null;
  return { t: (d / TRAVERSE) * 1.5 + 10, kind: 'traverse', path };
}

/**
 * A walk on foot to (out) or from the nearest lift or run end within WALK_M,
 * over ground that does not climb much: a parking lot or a lodge off the runs.
 */
function walkTo(net, x, y, lat, lon, z, ok, out) {
  let best = null;
  for (const e of net.ends) {
    if (!ok(net.feat[e])) continue;
    const d = Math.hypot(net.x[e] - x, net.y[e] - y);
    if (d > WALK_M || Math.abs(net.z[e] - z) > 40 || (best && d >= best.d)) continue;
    best = { e, d };
  }
  if (!best) return null;
  const j = best.e, here = [lat, lon, z], there = [net.lat[j], net.lon[j], net.z[j]];
  const t = best.d / WALK + Math.abs(net.z[j] - z) * 3;
  return out ? { to: j, t, kind: 'walk', feat: -1, path: [here, there] } : { from: j, t, path: [there, here] };
}

/** A binary heap of [cost, node]. */
class Heap {
  constructor() { this.c = []; this.n = []; }
  get size() { return this.c.length; }
  push(c, n) {
    const C = this.c, N = this.n;
    let i = C.length; C.push(c); N.push(n);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (C[p] <= c) break;
      C[i] = C[p]; N[i] = N[p]; i = p;
    }
    C[i] = c; N[i] = n;
  }
  pop() {
    const C = this.c, N = this.n, top = N[0], c = C.pop(), n = N.pop();
    if (C.length) {
      let i = 0;
      for (;;) {
        let k = 2 * i + 1;
        if (k >= C.length) break;
        if (k + 1 < C.length && C[k + 1] < C[k]) k++;
        if (C[k] >= c) break;
        C[i] = C[k]; N[i] = N[k]; i = k;
      }
      C[i] = c; N[i] = n;
    }
    return top;
  }
}

/**
 * Fastest route.
 * from: {lat, lon}. to: {kind: 'place', lat, lon, name} or {kind: 'run', index}.
 * opts: {maxCls: 1-4, avoid: Set of feature keys}.
 * to.indices: several pieces of one run, any of which will do.
 * Returns {legs, pts, t, len} or {fail: 'start' | 'end' | 'harder-end' | 'none' | 'harder', need}.
 */
export function planRoute(net, from, to, opts = {}) {
  const maxCls = opts.maxCls ?? 4, avoid = opts.avoid || null;
  const N = net.lat.length, SRC = N, DST = N + 1;
  const ok = fi => fi < 0 || allowedFeat(net.feats[fi], maxCls, avoid);
  const zAt = (lat, lon) => net.terrain.elev(lon, lat) + 0.5;
  // where you are, linked to what is around you
  const z0 = zAt(from.lat, from.lon);
  if (!(z0 === z0)) return { fail: 'start' };
  const [fx, fy] = net.xy(from.lat, from.lon);
  const srcEdges = [];
  for (const [j, d] of nearestPerFeature(net, fx, fy, net.travM)) {
    if (!ok(net.feat[j])) continue;
    const l = link(net, from.lat, from.lon, z0, net.lat[j], net.lon[j], net.z[j], d) || (d <= 15 ? { t: 1, kind: 'join', path: [[from.lat, from.lon, z0], [net.lat[j], net.lon[j], net.z[j]]] } : null);
    if (l) srcEdges.push({ to: j, t: l.t, kind: l.kind === 'join' ? 'walk' : 'traverse', feat: -1, path: l.path });
  }
  // at a base area, any lift within a short walk will do
  for (const f of net.feats) {
    if (f.kind !== 'lift' || !allowedFeat(f, maxCls, avoid)) continue;
    const j = f.ids[0], d = Math.hypot(net.x[j] - fx, net.y[j] - fy), dz = net.z[j] - z0;
    if (d > WALK_M || Math.abs(dz) > 40 || srcEdges.some(e => e.to === j)) continue;
    srcEdges.push({ to: j, t: d / WALK + Math.abs(dz) * 3, kind: 'walk', feat: -1, path: [[from.lat, from.lon, z0], [net.lat[j], net.lon[j], net.z[j]]] });
  }
  // nothing skiable close by (a parking lot, a lodge): walk to the nearest lift or run end
  if (!srcEdges.length) {
    const w = walkTo(net, fx, fy, from.lat, from.lon, z0, ok, true);
    if (w) srcEdges.push(w);
  }
  // where you are going
  const dstOf = new Map();
  let toPt = null;
  if (to.kind === 'run') {
    // a run is often mapped as several pieces with one name: any of them will do
    const want = new Set(to.indices || [to.index]);
    const fs = net.feats.filter(f => f.kind === 'run' && want.has(f.index) && ok(net.feats.indexOf(f)));
    if (!fs.length) return { fail: net.feats.some(f => f.kind === 'run' && want.has(f.index)) ? 'harder-end' : 'end' };
    for (const f of fs) {
      const n = f.ids.length;
      // anywhere in the upper third of the run, so most of it is still ahead
      for (let k = 0; k < Math.max(1, Math.ceil(n / 3)); k++) {
        const id = f.ids[f.top === 0 ? k : n - 1 - k];
        dstOf.set(id, { to: DST, t: 0, kind: 'arrive', feat: -1, path: null });
      }
    }
  } else {
    const zt = zAt(to.lat, to.lon);
    if (!(zt === zt)) return { fail: 'end' };
    toPt = [to.lat, to.lon, zt];
    const [tx, ty] = net.xy(to.lat, to.lon);
    for (const [j, d] of nearestPerFeature(net, tx, ty, net.travM)) {
      if (!ok(net.feat[j])) continue;
      const l = link(net, net.lat[j], net.lon[j], net.z[j], to.lat, to.lon, zt, d) || (d <= 15 ? { t: 1, kind: 'join', path: [[net.lat[j], net.lon[j], net.z[j]], toPt] } : null);
      if (l) dstOf.set(j, { to: DST, t: l.t, kind: l.kind === 'join' ? 'walk' : 'traverse', feat: -1, path: l.path });
    }
    if (!dstOf.size) {
      const w = walkTo(net, tx, ty, to.lat, to.lon, zt, ok, false);
      if (w) dstOf.set(w.from, { to: DST, t: w.t, kind: 'walk', feat: -1, path: w.path });
    }
    // already close enough to walk straight there
    const d = Math.hypot(tx - fx, ty - fy);
    const l = link(net, from.lat, from.lon, z0, to.lat, to.lon, zt, d) || (d <= 15 ? { t: 1, kind: 'join', path: [[from.lat, from.lon, z0], toPt] } : null);
    if (l) srcEdges.push({ to: DST, t: l.t, kind: l.kind === 'join' ? 'walk' : 'traverse', feat: -1, path: l.path });
  }
  if (!srcEdges.length) return { fail: 'start' };
  if (!dstOf.size && !srcEdges.some(e => e.to === DST)) return { fail: 'end' };

  const dist = new Float64Array(N + 2).fill(Infinity), via = new Array(N + 2);
  const heap = new Heap();
  dist[SRC] = 0; heap.push(0, SRC);
  while (heap.size) {
    const u = heap.pop();
    if (u === DST) break;
    const du = dist[u];
    const out = u === SRC ? srcEdges : net.adj[u];
    const extra = dstOf.get(u);
    for (const e of extra ? [...out, extra] : out) {
      if (e.feat >= 0 && !ok(e.feat)) continue;
      const v = e.to, dv = du + e.t;
      if (dv < dist[v]) { dist[v] = dv; via[v] = { u, e }; heap.push(dv, v); }
    }
  }
  if (!(dist[DST] < Infinity)) {
    // would a harder run, or a lift you are avoiding, have done it?
    if (!opts.noRetry && (maxCls < 4 || avoid?.size)) {
      for (let c = avoid?.size ? maxCls : maxCls + 1; c <= 4; c++) {
        const r = planRoute(net, from, to, { maxCls: c, noRetry: true });
        if (!r.fail) return { fail: 'harder', need: c, avoided: c === maxCls };
      }
    }
    return { fail: 'none' };
  }
  const steps = [];
  for (let v = DST; v !== SRC; v = via[v].u) steps.push({ ...via[v], v });
  steps.reverse();
  return toLegs(net, steps, from, z0, toPt);
}

/** Turn the edges walked into legs (one per run, lift, traverse) and one polyline with elevations. */
function toLegs(net, steps, from, z0, toPt) {
  const legs = [];
  let cur = null;
  const ptOf = i => [net.lat[i], net.lon[i], net.z[i]];
  for (const { u, e, v } of steps) {
    const kind = e.kind === 'arrive' ? null : e.kind;
    if (!kind) continue;
    const fi = e.feat, pts = e.path || [u === net.lat.length ? [from.lat, from.lon, z0] : ptOf(u), v === net.lat.length + 1 ? toPt : ptOf(v)];
    // short joins belong to the leg after them; runs and lifts continue while the feature does
    const same = cur && ((kind === 'run' && cur.kind === 'run' && cur.feat === fi) || (kind === cur.kind && fi < 0 && kind !== 'lift'));
    if (same) { cur.pts.push(...pts.slice(1)); cur.t += e.t; continue; }
    const f = fi >= 0 ? net.feats[fi] : null;
    cur = { kind, feat: fi, key: f?.key || null, name: f?.name || '', cls: f?.cls || 0, type: f?.type || '', pts: pts.slice(), t: e.t };
    legs.push(cur);
  }
  // fold joins into their neighbors: they are a few meters each
  const out = [];
  for (const l of legs) {
    if (l.kind === 'join' && out.length) { out[out.length - 1].pts.push(...l.pts.slice(1)); out[out.length - 1].t += l.t; continue; }
    if (out.length && out[out.length - 1].kind === 'join') { const j = out.pop(); l.pts = [...j.pts, ...l.pts.slice(1)]; l.t += j.t; }
    out.push(l);
  }
  // a short stretch of one run between two others reads better as part of a neighbor
  const lenOf = l => { let m = 0; for (let i = 1; i < l.pts.length; i++) m += segLen(net, l.pts[i - 1], l.pts[i]); return m; };
  for (const l of out) l.len = lenOf(l);
  for (let again = true; again;) {
    again = false;
    for (let k = 0; k < out.length; k++) {
      const l = out[k];
      if (l.kind !== 'run' || (l.len >= SHORT_RUN_M && l.name)) continue;
      const a = out[k - 1]?.kind === 'run' && (out[k - 1].cls >= l.cls || l.cls === 5) ? out[k - 1] : null;
      const b = out[k + 1]?.kind === 'run' && (out[k + 1].cls >= l.cls || l.cls === 5) ? out[k + 1] : null;
      const into = a && b ? (a.len >= b.len ? a : b) : a || b;
      if (!into) continue;
      if (into === a) { a.pts.push(...l.pts.slice(1)); a.t += l.t; a.len += l.len; }
      else { b.pts = [...l.pts, ...b.pts.slice(1)]; b.t += l.t; b.len += l.len; }
      out.splice(k, 1); again = true; break;
    }
  }
  // the same run twice in a row after that: one leg
  for (let k = 1; k < out.length; k++) {
    if (out[k].kind === 'run' && out[k - 1].kind === 'run' && out[k].key === out[k - 1].key) {
      out[k - 1].pts.push(...out[k].pts.slice(1)); out[k - 1].t += out[k].t; out.splice(k--, 1);
    }
  }
  const pts = [];
  let len = 0, t = 0;
  out.forEach((l, k) => {
    l.len = 0;
    for (let i = 1; i < l.pts.length; i++) l.len += segLen(net, l.pts[i - 1], l.pts[i]);
    l.drop = l.pts[0][2] - l.pts[l.pts.length - 1][2];
    l.i0 = Math.max(0, pts.length - 1);
    pts.push(...(pts.length ? l.pts.slice(1) : l.pts));
    l.i1 = pts.length - 1;
    len += l.len; t += l.t;
    l.k = k;
  });
  // the leg each point belongs to
  const legOf = new Int32Array(pts.length);
  for (const l of out) for (let i = l.i0; i <= l.i1; i++) legOf[i] = l.k;
  return { legs: out, pts, legOf, t, len };
}

const segLen = (net, a, b) => Math.hypot((b[0] - a[0]) * net.mN, (b[1] - a[1]) * net.mE);

/**
 * Where along a route a position is: {off (m from the route), i (point
 * index), leg, left (m to the end of the current leg), tLeft (s to the end)}.
 * hint: the point index found last time; going backwards is penalized so a
 * lift line passing a run does not pull you back to it.
 */
export function routeProgress(net, route, lat, lon, hint = 0) {
  const [px, py] = net.xy(lat, lon), P = route.pts;
  let best = Infinity, bi = 0, bf = 0, boff = Infinity;
  for (let i = 1; i < P.length; i++) {
    const [ax, ay] = net.xy(P[i - 1][0], P[i - 1][1]), [bx, by] = net.xy(P[i][0], P[i][1]);
    const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
    const f = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L2)) : 0;
    const d = Math.hypot(ax + vx * f - px, ay + vy * f - py);
    const score = d + (i < hint - 1 ? 30 : 0);
    if (score < best) { best = score; bi = i; bf = f; boff = d; }
  }
  const leg = route.legs[route.legOf[bi]];
  let left = segLen(net, P[bi - 1] || P[0], P[bi]) * (1 - bf);
  for (let i = bi + 1; i <= leg.i1; i++) left += segLen(net, P[i - 1], P[i]);
  let tLeft = leg.len > 0 ? leg.t * left / leg.len : 0;
  for (let k = leg.k + 1; k < route.legs.length; k++) tLeft += route.legs[k].t;
  let toEnd = left;
  for (let k = leg.k + 1; k < route.legs.length; k++) toEnd += route.legs[k].len;
  return { off: boff, i: bi, leg: leg.k, left, tLeft, toEnd };
}

const CLS_WORD = ['', 'green', 'blue', 'black', 'double black', 'unrated'];
const LIFT_WORD = { cable_car: 'tram', gondola: 'gondola', mixed_lift: 'gondola', chair_lift: 'lift', drag_lift: 'surface lift', 't-bar': 'T-bar', 'j-bar': 'J-bar', platter: 'platter', rope_tow: 'rope tow', magic_carpet: 'carpet' };

/** A leg in words: "Ride Collins lift", "Ski Mambo (blue)", "Traverse 120 m". */
export function legText(l) {
  const m = v => v >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(v / 10) * 10)} m`;
  if (l.kind === 'lift') return `Ride ${l.name || 'the'} ${LIFT_WORD[l.type] || 'lift'}`.replace(/(lift|tram|gondola) (lift|tram|gondola)$/i, '$1');
  if (l.kind === 'run') return `Ski ${l.name || 'the unnamed run'} (${CLS_WORD[l.cls]})`;
  if (l.kind === 'traverse') return `Traverse ${m(l.len)}`;
  return `Walk ${m(l.len)}`;
}
export { CLS_WORD };
