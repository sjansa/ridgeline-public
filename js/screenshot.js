// screenshot.js -- when the phone takes a screenshot, also save a clean copy: just the
// picture and what is drawn on it, without menus, messages or buttons. Shared by Ridgeline
// and Moonshot (app/core/screenshot.js there).
//
// Neither iOS nor Android lets an app stop or change the system screenshot. The native
// Screenshot plugin tells the page when one was taken (window event 'screenshotTaken'), and
// saves the clean copy beside it in Photos (iOS) or Pictures/<app> (Android). In a browser
// there is no such event, so this does nothing.

const native = () => !!window.Capacitor?.PluginHeaders?.some(h => h.name === 'Screenshot');

/** Draw canvases (all the same size on screen) one over the other, cropped to crop {x, y, w, h} in canvas pixels. */
export function stack(canvases, crop = null) {
  const base = canvases[0], c = document.createElement('canvas');
  const r = crop || { x: 0, y: 0, w: base.width, h: base.height };
  c.width = r.w; c.height = r.h;
  const ctx = c.getContext('2d');
  for (const k of canvases) {
    if (!k || !k.width) continue;
    const sx = k.width / base.width, sy = k.height / base.height;
    ctx.drawImage(k, r.x * sx, r.y * sy, r.w * sx, r.h * sy, 0, 0, r.w, r.h);
  }
  return c;
}

/**
 * Start watching. grab() returns (or resolves to) a canvas with the clean view, or null when
 * there is nothing worth saving. where() gives {lat, lon} to tag the picture with, or null.
 * done(ok, error) is told how the save went. Returns true when the phone can do this.
 */
export function watchScreenshots(grab, { app = 'Ridgeline', where = () => null, done = () => {} } = {}) {
  if (!native()) return false;
  let busy = false;
  window.addEventListener('screenshotTaken', async () => {
    if (busy) return;
    busy = true;
    try {
      const c = await grab();
      if (!c) return;
      const url = c.toDataURL('image/jpeg', 0.92), p = where();
      await window.Capacitor.nativePromise('Screenshot', 'save', {
        image: url.slice(url.indexOf(',') + 1), album: app,
        ...(p && isFinite(p.lat) && isFinite(p.lon) ? { lat: p.lat, lon: p.lon } : {}),
      });
      done(true);
    } catch (e) {
      done(false, e?.message || String(e));
    } finally { busy = false; }
  });
  return true;
}
