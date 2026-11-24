// power.js -- power profiling. Every PERIOD_MS a row goes to Documents/power-log.csv (native
// app, Power plugin) or the console (browser): what the phone says (battery, charging, heat,
// low power mode, screen brightness, the app process's CPU and memory) beside what the app
// was doing (its mode, which sensors were on, frames drawn per second, and the share of the
// main thread spent in each named part). Battery drain per hour is read off the log
// afterwards: iOS reports the level in 1% steps, so it takes a few minutes per setting.
// Shared by Ridgeline and Moonshot (app/core/power.js there). For a release, each app turns it
// off with its DEV_LOGS switch (main.js): a log that is not on costs nothing.

const PERIOD_MS = 15000;
const native = () => !!window.Capacitor?.PluginHeaders?.some(h => h.name === 'Power');
const call = (m, o) => window.Capacitor.nativePromise('Power', m, o);

export class PowerLog {
  /**
   * app: name in each row. parts: names of the timed parts (fixed columns). state(): {key: value}
   * describing what the app is doing (mode, sensors on), the same keys each time. on: false makes
   * every call do nothing.
   */
  constructor(app, parts, state = () => ({}), { on = true } = {}) {
    Object.assign(this, { on, app, parts, state, frames: 0, ms: Object.fromEntries(parts.map(p => [p, 0])), t0: 0, timer: 0, header: null, rows: [] });
  }
  /** A frame was drawn. */
  frame() { if (this.on) this.frames++; }
  /** ms spent in a part. */
  add(part, ms) { if (this.on && part in this.ms) this.ms[part] += ms; }
  /** Run fn, adding its time to part. */
  time(part, fn) {
    if (!this.on) return fn();
    const t = performance.now();
    try { return fn(); } finally { this.add(part, performance.now() - t); }
  }
  start() {
    if (!this.on || this.timer) return;
    this.t0 = performance.now();
    this.timer = setInterval(() => this.flush(), PERIOD_MS);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.flush(); else this.reset(); });
  }
  reset() { this.frames = 0; for (const p of this.parts) this.ms[p] = 0; this.t0 = performance.now(); }

  async flush() {
    const dt = (performance.now() - this.t0) / 1000;
    if (!(dt > 1)) return;
    const st = this.state(), n = native();
    let ph = {};
    if (n) { try { ph = await call('sample'); } catch { /* none */ } }
    const f = (v, k = 1) => (typeof v === 'number' && isFinite(v) ? v.toFixed(k) : '');
    const d = new Date(), pad = x => String(x).padStart(2, '0');
    const row = {
      time: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
      app: this.app, secs: f(dt, 0), hidden: document.hidden ? 1 : 0,
      battery: ph.battery >= 0 ? f(ph.battery * 100, 0) : '', charging: ph.charging ? 1 : 0,
      thermal: ['nominal', 'fair', 'serious', 'critical'][ph.thermal] ?? '', lowPower: ph.lowPower ? 1 : 0,
      brightness: f(ph.brightness, 2), appCpu: f(ph.cpu), memMB: f(ph.memMB, 0), fps: f(this.frames / dt),
      ...Object.fromEntries(this.parts.map(p => [`${p}%`, f(this.ms[p] / dt / 10)])),   // ms per s / 10 = % of the main thread
      ...st,
    };
    this.reset();
    const keys = Object.keys(row), line = keys.map(k => String(row[k] ?? '').replace(/[,\n]/g, ';')).join(',');
    const header = keys.join(',');
    this.rows.push(row); if (this.rows.length > 200) this.rows.shift();
    if (n) {
      // a header at the start of each run (and whenever the columns change)
      if (header !== this.header) { try { await call('append', { line: header }); } catch { /* not kept */ } this.header = header; }
      try { await call('append', { line }); } catch { /* not kept */ }
    } else console.log('[power]', line);
  }
}
