// barometer.js -- the phone's barometer, in the native app where the phone has one.
// Height changes from it are far finer than GPS: a lift ride is checked against it
// and the height above the snow follows it. Pressure, brought to sea level with the
// map's elevation, gives the weather trend. Without a barometer all of this is null.

const KEY = 'ridgeline.baro';
const KEEP_MS = 6 * 3600e3;       // sea-level samples kept for the trend
const TREND_MS = 3 * 3600e3;      // weather trend: change over three hours
const SAMPLE_MS = 60e3;           // one trend sample a minute
const POLL_MS = 1000;

const native = () => !!window.Capacitor?.PluginHeaders?.some(h => h.name === 'Barometer');

/** Station pressure (kPa) at h meters, brought to sea level. */
export const seaLevel = (kPa, h) => kPa * Math.pow(1 - 2.25577e-5 * h, -5.25588);

/**
 * Change over the last span ms, from a least-squares line through samples [{t, v}]:
 * per span, or null when the samples cover less than minMs.
 */
export function trend(samples, now, span = TREND_MS, minMs = 3600e3) {
  const s = samples.filter(q => now - q.t <= span);
  if (s.length < 5 || s.at(-1).t - s[0].t < minMs) return null;
  const mt = s.reduce((a, q) => a + q.t, 0) / s.length, mv = s.reduce((a, q) => a + q.v, 0) / s.length;
  let num = 0, den = 0;
  for (const q of s) { num += (q.t - mt) * (q.v - mv); den += (q.t - mt) ** 2; }
  return den ? (num / den) * span : null;
}

/** Words for a three-hour change in hPa, as forecasters put it. */
export function trendWord(dhPa) {
  if (dhPa == null) return '';
  const a = Math.abs(dhPa);
  if (a < 1) return 'steady';
  return `${dhPa < 0 ? 'falling' : 'rising'}${a >= 3.5 ? ' fast' : ''}`;
}

export class Barometer {
  constructor() {
    this.on = false; this.available = false; this.hist = []; this.last = null; this.timer = 0;
    this.sl = [];
    try { this.sl = JSON.parse(localStorage.getItem(KEY) || '[]').filter(q => Date.now() - q.t < KEEP_MS); } catch { /* none kept */ }
    this.slAcc = [];
  }
  async start() {
    if (this.on || !native()) return this.available;
    this.on = true;
    try { this.available = !!(await window.Capacitor.nativePromise('Barometer', 'start')).available; } catch { this.available = false; }
    if (!this.available) { this.on = false; return false; }
    this.timer = setInterval(() => this.poll(), POLL_MS);
    return true;
  }
  stop() {
    if (!this.on) return;
    this.on = false; clearInterval(this.timer); this.hist = []; this.last = null;
    window.Capacitor?.nativePromise('Barometer', 'stop').catch(() => {});
  }
  async poll() {
    let r;
    try { r = await window.Capacitor.nativePromise('Barometer', 'read'); } catch { return; }
    if (!(r?.kPa > 0)) return;
    const q = { t: performance.now() / 1000, kPa: r.kPa, rel: r.rel };
    this.last = q; this.hist.push(q);
    while (this.hist.length && q.t - this.hist[0].t > 120) this.hist.shift();
  }
  /** Meters climbed per second over the last window seconds (negative going down), or null. */
  climb(window = 15) {
    const h = this.hist;
    if (h.length < 2 || !this.last) return null;
    const now = this.last.t;
    const a = h.find(q => now - q.t <= window);
    return a && now - a.t >= window * 0.6 ? (this.last.rel - a.rel) / (now - a.t) : null;
  }
  /** Height change in meters since start (for following a ride from where it began), or null. */
  rel() { return this.last && performance.now() / 1000 - this.last.t < 5 ? this.last.rel : null; }
  /** Record the pressure at a known height (m) for the weather trend. */
  note(h) {
    if (!this.last || !(h === h)) return;
    const v = seaLevel(this.last.kPa, h) * 10, now = Date.now();   // hPa
    this.slAcc.push(v);
    const prev = this.sl.at(-1);
    if (prev && now - prev.t < SAMPLE_MS) return;
    // a minute's median, so a gust or a door does not count
    const m = this.slAcc.sort((a, b) => a - b)[this.slAcc.length >> 1];
    this.slAcc = [];
    this.sl.push({ t: now, v: +m.toFixed(2) });
    this.sl = this.sl.filter(q => now - q.t < KEEP_MS);
    try { localStorage.setItem(KEY, JSON.stringify(this.sl)); } catch { /* not kept */ }
  }
  /** {hPa (sea level), inHg, d3h (hPa over three hours, or null), word} or null. */
  weather() {
    const s = this.sl.at(-1);
    if (!s || Date.now() - s.t > 15 * 60e3) return null;
    const d = trend(this.sl, Date.now());
    return { hPa: s.v, inHg: s.v * 0.029530, d3h: d, word: trendWord(d) };
  }
}
