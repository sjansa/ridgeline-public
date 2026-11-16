// main.js -- app shell: modes (camera / demo / photo), the frame loop, and
// the alignment state that ties the sensors to the terrain model.

import { buildPano, chainCrests, D2R } from './terrain.js?v=1115.2115-d4a83cf';
import { loadPack, prepareFeatures, buildOwnership, buildSlope, SLOPE_STOPS, MAX_REACH } from './runs.js?v=1115.2115-d4a83cf';
import { Camera, IDENT, matMul, rotFromYPR, yprFromRot, yawMat, pitchRollMat, orthonormalize } from './camera.js?v=1115.2115-d4a83cf';
import { analyzeFrame, alignModel, solveAlignment } from './align.js?v=1115.2115-d4a83cf';
import { renderSim } from './sim.js?v=1115.2115-d4a83cf';
import { PhotoPano, ALTA, minFn, clampView } from './photodemo.js?v=1115.2115-d4a83cf';
import { Shader, buildScene, drawOverlay } from './render.js?v=1115.2115-d4a83cf';
import { startCamera, listCameras, cameraZoom, Orientation, watchPosition } from './sensors.js?v=1115.2115-d4a83cf';
import { photoLens, describeCamera, zoomSteps } from './lens.js?v=1115.2115-d4a83cf';
import { parseExif } from './exif.js?v=1115.2115-d4a83cf';
import { loadCatalog, savedAreas, areaAt, openArea, saveBuilt, removeArea, storageUse } from './store.js?v=1115.2115-d4a83cf';
import { sendFeedback, shrink, MAX_SHOTS } from './feedback.js?v=1115.2115-d4a83cf';
import { buildArea, checkBbox, estimate, bboxKm, AREA_MIN_KM, AREA_MAX_KM } from './build.js?v=1115.2115-d4a83cf';

if ('serviceWorker' in navigator) {
  addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('./sw.js');
      // The worker starts after this page has already loaded its files, so on
      // a first visit it has seen none of them. Hand it the list, or one visit
      // would not be enough to work offline.
      const reg = await navigator.serviceWorker.ready;
      const mine = performance.getEntriesByType('resource').map(e => e.name)
        .filter(u => u.startsWith(location.origin) && !u.includes('/packs/'));
      reg.active?.postMessage({ cache: [location.href.split('?')[0], ...mine] });
    } catch { /* no offline shell; the app still works online */ }
  });
}

const $ = id => document.getElementById(id);
const FOV_MIN = 4, FOV_MAX = 110;    // long telephoto to ultra-wide
const SOFT_ZOOM_MAX = 5;             // on-screen zoom where the camera offers none of its own
const DEFAULT_HFOV = 64;      // phone main camera, video mode, along the long side of the frame
const ZOOMS = [1, 0.6, 1.65]; // focal guesses tried while the lens is unknown: main, ultra-wide, tele
const ANALYSIS_W = 320;

const S = {
  mode: null, pack: null, prep: null, own: null,
  pano: null, model: null, scene: null, origin: null, building: false,
  source: null,                         // video or canvas being shown
  sensorR: rotFromYPR(170, 8, 0),       // world -> camera straight from sensors
  yawCorr: 0, camCorr: IDENT,           // alignment: R = camCorr * sensorR * yaw(yawCorr)
  cam: new Camera(IDENT, Camera.hfovToFn(DEFAULT_HFOV), 0),
  opts: { runs: true, lifts: true, ridges: true, labels: true, peaks: true, runLines: false, snowMask: true, snowThr: 0.55, alpha: 0.65, shade: 'rating', outline: false },
  auto: true, lens: true, lensKnown: false, chair: false,
  // live camera: which one, what its name says about the lens, its own zoom if exposed
  camera: { key: 'default', label: '', mult: 1, zoom: null, zoomValue: 1 }, softZoom: 1, photoZooms: null,
  locked: false, misses: 0, settled: 0, lastSolve: 0, holdUntil: 0, lastSol: null,
  demo: { yaw: 170, pitch: 8, err: { yaw: 9, pitch: -1.6, roll: 1.3, fScale: 0.93, k1: 0.03 }, dirty: true, dragging: false },
  gps: null, spots: [], view: { sw: 1, sh: 1, fw: 1, fh: 1, dpr: 1 },
};

const video = $('video'), glCanvas = $('gl'), ovCanvas = $('ov');
const octx = ovCanvas.getContext('2d');
const simCanvas = document.createElement('canvas'), simCtx = simCanvas.getContext('2d');
const photoCanvas = document.createElement('canvas');
const anaCanvas = document.createElement('canvas'), anaCtx = anaCanvas.getContext('2d', { willReadFrequently: true });
const orient = new Orientation();
let shader, stopGps = null, stream = null, photoPano = null;

function status(text, cls = '') {
  $('statText').textContent = text;
  $('status').className = 'chip ' + cls;
}

// ----------------------------------------------------------------- loading

async function boot() {
  try { shader = new Shader(glCanvas); } catch (e) { status(e.message, 'bad'); }
  S.catalog = await loadCatalog();
  let want = null;
  try { want = localStorage.getItem('ridgeline.area'); } catch { /* no saved choice */ }
  await useArea(S.catalog.find(a => a.id === want) || S.catalog[0]);
  status('Ready');
  if (S.pending) { const p = S.pending; S.pending = null; p(); }
}

/** Load a map area (from the device if saved, else download and save it) and make it current. */
async function useArea(area) {
  if (S.area?.id === area.id) return;
  S.switching = true;
  try {
    const src = await openArea(area, f => status(`Downloading the ${area.name} map… ${Math.round(f * 100)}%`));
    if (src.saved) status(`Opening the ${area.name} map…`);
    const pack = await loadPack(src.base, src.fetchBin, src.fetchJson);
    await src.finish();
    S.pack = pack; S.area = area;
    S.prep = prepareFeatures(pack.features, pack.terrain);
    S.own = buildOwnership(pack.terrain.fine, S.prep.runs);
    S.slope = buildSlope(pack.terrain.fine);
    S.pano = S.scene = S.model = null; S.origin = null;
    orient.declination = pack.meta.declination ?? 0;
    $('attrib').textContent = pack.meta.attribution;
    try { localStorage.setItem('ridgeline.area', area.id); } catch { /* not remembered */ }
    buildSpots();
    await listAreas();
  } finally { S.switching = false; }
}

async function listAreas() {
  const saved = await savedAreas(S.catalog), sel = $('area');
  sel.innerHTML = '';
  for (const a of S.catalog) sel.add(new Option(`${a.name} · ${saved[a.id] ? 'saved' : `${(a.bytes / 1e6).toFixed(0)} MB`}`, a.id));
  sel.value = S.area.id;
  $('covers').textContent = `Covers ${S.catalog.map(a => a.name).join(', ')}.`;
  // Menu > Maps: what is on the phone, with Use and Delete
  $('areas').replaceChildren(...S.catalog.map(a => {
    const row = document.createElement('div'), txt = document.createElement('div'), name = document.createElement('b'), sub = document.createElement('small');
    row.className = 'area';
    name.textContent = a.name;
    const cur = a.id === S.area.id, mb = `${(a.bytes / 1e6).toFixed(0)} MB`;
    sub.textContent = cur ? `${mb} · in use` : saved[a.id] ? `${mb} · on this phone` : `${mb} · not downloaded`;
    txt.append(name, sub);
    const use = document.createElement('button'), del = document.createElement('button');
    use.className = 'btn'; use.textContent = saved[a.id] ? 'Use' : 'Get'; use.disabled = cur;
    use.onclick = () => chooseArea(a);
    del.className = 'btn danger'; del.textContent = 'Delete'; del.disabled = cur || !saved[a.id];
    del.onclick = async () => {
      // two taps: the first arms it for a few seconds
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1'; del.textContent = 'Sure?';
        setTimeout(() => { del.dataset.armed = ''; del.textContent = 'Delete'; }, 3500);
        return;
      }
      await removeArea(a);
      if (a.custom) S.catalog = S.catalog.filter(x => x.id !== a.id);
      await listAreas();
    };
    row.append(txt, use, del);
    return row;
  }));
  const use = await storageUse();
  $('storage').textContent = use?.used != null
    ? `Saved maps and app data use ${(use.used / 1e6).toFixed(0)} MB on this phone. The map in use cannot be deleted; switch to another first.`
    : 'The map in use cannot be deleted; switch to another first.';
}
async function chooseArea(a) {
  try {
    await useArea(a);
    if (S.mode === 'live') { if (S.gps) onFix(S.gps); } else useSpot();
  } catch (err) { status(`Could not load that map: ${err.message}`, 'bad'); listAreas(); }
}

// -------------------------------------------------- adding an area of your own

const hasNativePicker = () => !!window.Capacitor?.PluginHeaders?.some(h => h.name === 'AreaPicker');
const boxAround = (lat, lon, km) => {
  const dLat = km / 2 / 110.54, dLon = km / 2 / (111.32 * Math.cos(lat * D2R));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
};
function addState(which, err = '') {
  for (const id of ['addForm', 'addConfirm', 'addProg']) $(id).hidden = id !== which;
  $('addArea').hidden = which != null;
  $('addErr').textContent = err;
}

/** Start choosing an area: on the phone's own map where there is one, else by name or position. */
async function pickArea() {
  if (!hasNativePicker()) { addState('addForm'); return; }
  const c = S.gps ? [S.gps.lat, S.gps.lon] : S.origin ? [S.origin.lat, S.origin.lon]
    : [(S.area.bbox[1] + S.area.bbox[3]) / 2, (S.area.bbox[0] + S.area.bbox[2]) / 2];
  try {
    const r = await window.Capacitor.nativePromise('AreaPicker', 'pick', {
      lat: c[0], lon: c[1], minKm: AREA_MIN_KM, maxKm: AREA_MAX_KM, saved: S.catalog.map(a => a.bbox),
    });
    if (!r || r.canceled) return;
    proposeArea([r.west, r.south, r.east, r.north], r.name);
  } catch (e) { addState('addForm', `The map could not be opened: ${e.message || e}`); }
}

/** Show what a box would cost and ask for a name before downloading. */
function proposeArea(bbox, name) {
  const bad = checkBbox(bbox);
  if (bad) { addState(hasNativePicker() ? null : 'addForm', bad); return; }
  const [kx, ky] = bboxKm(bbox), est = estimate(bbox);
  S.adding = { bbox };
  addState('addConfirm');
  $('addWhat').textContent = `${kx.toFixed(0)} × ${ky.toFixed(0)} km. About ${(est.downloadBytes / 1e6).toFixed(0)} MB to download and ${(est.storeBytes / 1e6).toFixed(0)} MB on the phone. Best done on Wi-Fi before the trip.`;
  $('addName').value = (name || '').slice(0, 40);
  $('sheet').hidden = false; showTab('maps');
}

async function downloadArea() {
  const name = $('addName').value.trim() || 'My map area', bbox = S.adding.bbox;
  const ctl = new AbortController();
  S.adding.stop = () => ctl.abort();
  addState('addProg');
  try {
    const { area, files } = await buildArea({ id: `my-${Date.now().toString(36)}`, name, bbox }, (f, msg) => {
      $('addBar').value = f; $('addMsg').textContent = `${msg} ${Math.round(f * 100)}%`;
    }, ctl.signal);
    await saveBuilt(area, files);
    S.catalog.push(area);
    addState(null);
    $('getHere').hidden = true;
    status(`${name}: ${area.lifts} lifts and ${area.runs} runs saved.`, 'ok');
    await chooseArea(area);
  } catch (e) {
    addState(null, ctl.signal.aborted ? 'Download canceled.' : e.message || String(e));
  } finally { S.adding = null; }
}

/** Fallback where there is no native map: find a place by name. */
async function findPlace() {
  const q = $('addPlace').value.trim();
  if (!q) { $('addErr').textContent = 'Type a place name first.'; return; }
  $('addErr').textContent = 'Searching…';
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`);
    const hit = (await r.json())[0];
    if (!hit) { $('addErr').textContent = 'Nothing found by that name.'; return; }
    proposeArea(boxAround(+hit.lat, +hit.lon, +$('addSize').value), hit.name || q);
  } catch { $('addErr').textContent = 'Search failed. Check the connection.'; }
}
function aroundMe() {
  const go = (lat, lon) => proposeArea(boxAround(lat, lon, +$('addSize').value), `Map at ${lat.toFixed(2)}, ${lon.toFixed(2)}`);
  if (S.gps) { go(S.gps.lat, S.gps.lon); return; }
  $('addErr').textContent = 'Finding where you are…';
  navigator.geolocation.getCurrentPosition(p => go(p.coords.latitude, p.coords.longitude),
    () => { $('addErr').textContent = 'Could not get your position. Search for the place instead.'; }, { enableHighAccuracy: true, timeout: 15000 });
}

/** Switch to the area covering a position, if there is one and it is not the current one. */
async function areaFor(lat, lon) {
  if (S.pack.terrain.fine.contains(lon, lat)) return true;
  const a = areaAt(S.catalog, lat, lon);
  if (!a) return false;
  await useArea(a);
  return true;
}

function buildSpots() {
  const spots = [];
  const bearing = (a, b) => Math.atan2((b[1] - a[1]) * Math.cos(a[0] * D2R), b[0] - a[0]) / D2R;
  for (const l of S.prep.lifts) {
    if (!l.name || l.type === 'magic_carpet' || l.type === 'rope_tow') continue;
    const a = l.pts[0], b = l.pts[l.pts.length - 1];
    if (!S.pack.terrain.fine.contains(a[1], a[0]) || !S.pack.terrain.fine.contains(b[1], b[0])) continue;
    // stand 15 m to the side so the cable is not directly overhead
    const side = (p, hd) => [p[0] + 15 * Math.cos((hd + 90) * D2R) / 110540, p[1] + 15 * Math.sin((hd + 90) * D2R) / (111320 * Math.cos(p[0] * D2R))];
    const up = bearing(a, b);
    spots.push({ label: `${l.name} — bottom`, pos: side(a, up), yaw: up, pitch: 12 });
    spots.push({ label: `${l.name} — top`, pos: side(b, up + 180), yaw: up + 180, pitch: -8 });
  }
  spots.sort((x, y) => x.label.localeCompare(y.label));
  if (!spots.length) {
    // an area with no lifts mapped: stand in the middle of it
    spots.push({ label: 'Center of the map', pos: [(S.area.bbox[1] + S.area.bbox[3]) / 2, (S.area.bbox[0] + S.area.bbox[2]) / 2], yaw: 0, pitch: 5 });
  }
  // a real photograph to look around in, where there is one for this area
  if (S.area?.id === 'cottonwoods') spots.unshift({ label: ALTA.label, pos: [ALTA.lat, ALTA.lon], yaw: ALTA.yaw, pitch: 0, photo: ALTA });
  S.spots = spots;
  const sel = $('spot');
  sel.innerHTML = '';
  spots.forEach((s, i) => sel.add(new Option(s.label, i)));
  const def = spots.findIndex(s => /tram.*bottom/i.test(s.label));
  sel.value = spots[0].photo ? 0 : def >= 0 ? def : 0;
}

/** (Re)build everything that depends on where the viewer stands. */
function setViewpoint(lat, lon) {
  if (S.building) return;
  if (!S.pack.terrain.fine.contains(lon, lat)) {
    // On the hill with a signal: offer to fetch a map for right here.
    const canGet = S.mode === 'live' && navigator.onLine !== false;
    status(canGet ? 'No map on this phone for where you are.' : 'No map on this phone for where you are, and no connection to get one.', 'bad');
    $('getHere').hidden = !canGet;
    return;
  }
  $('getHere').hidden = true;
  S.building = true;
  status('Reading the terrain…');
  setTimeout(() => {
    try {
      const t0 = performance.now();
      const pano = buildPano(S.pack.terrain, lat, lon, {
        eye: S.chair ? 9 : 1.7, ownerGrid: S.pack.terrain.fine, owner: S.own.owner, ownerCost: S.own.cost, reach: MAX_REACH, slope: S.slope,
      });
      const chains = chainCrests(pano);
      S.pano = pano; S.model = alignModel(pano, chains); S.scene = buildScene(pano, chains, S.prep);
      S.origin = { lat, lon };
      shader?.setPano(pano, S.prep.runs);
      S.buildMs = performance.now() - t0;
      if (S.mode === 'demo' && S.demo.autoPitch) {
        // frame the skyline in the upper part of the picture
        const col = ((Math.round(S.demo.yaw / 360 * pano.na) % pano.na) + pano.na) % pano.na;
        const vfov = DEFAULT_HFOV * Math.min(1.4, S.view.sh / S.view.sw);
        // upright, the menu takes the lower part of the screen: put the skyline higher
        const drop = S.view.sh > S.view.sw ? 0.24 : 0.12;
        S.demo.pitch = Math.max(-5 - 30 * (drop - 0.12), Math.atan(pano.skyT[col]) / D2R - drop * vfov);
        S.demo.autoPitch = false;
      }
      S.demo.dirty = true; S.lastSolve = 0;
      status(S.mode === 'demo' ? 'Demo view. Drag to look around.' : 'Looking for the skyline…');
    } catch (e) { status(e.message, 'bad'); }
    S.building = false;
  }, 30);
}

// ------------------------------------------------------------------- modes

// The lens is a property of the phone, not of the moment: once the solver has
// found the focal length and distortion for a given video format, keep them
// for next time. Stored per frame size, which also separates portrait from
// landscape.
// The stored figure is for the camera's zoom at 1; the live zoom multiplies it.
const lensKey = (w, h) => `ridgeline.lens.${S.camera.key}.${w}x${h}`;
const hwZoom = () => (S.mode === 'live' && S.camera.zoom ? S.camera.zoomValue : 1);
function recallLens(w, h) {
  // first guess: a main camera's field of view along the long side of the
  // frame, scaled by what the camera's name says about its lens
  S.cam.fn = Camera.hfovToFn(DEFAULT_HFOV) * Math.max(w, h) / w * S.camera.mult * hwZoom(); S.cam.k1 = 0; S.lensKnown = false;
  try {
    const v = JSON.parse(localStorage.getItem(lensKey(w, h)));
    if (v && v.fn > 0.1 && v.fn < 30 && Math.abs(v.k1) < 0.3) { S.cam.fn = v.fn * hwZoom(); S.cam.k1 = v.k1; S.lensKnown = true; }
  } catch { /* private window, or nothing stored: the guess stands */ }
  clampFn(); syncFov();
}
function rememberLens() {
  if (S.mode !== 'live') return;
  const [w, h] = sourceSize();
  try { localStorage.setItem(lensKey(w, h), JSON.stringify({ fn: S.cam.fn / hwZoom(), k1: S.cam.k1 })); } catch { /* not kept */ }
  S.lensKnown = true;
}
function clampFn() {
  S.cam.fn = Math.min(Camera.hfovToFn(FOV_MIN), Math.max(Camera.hfovToFn(FOV_MAX), S.cam.fn));
}

// ---------------------------------------------------- live camera: lens, zoom

// Zoom is shown the way the phone's camera app shows it: 1x is the main
// camera. S.camera.mult converts the camera's own zoom scale to that.
const zoomShown = () => S.camera.mult * (S.camera.zoom ? S.camera.zoomValue : S.softZoom);
function zoomLimits() {
  const z = S.camera.zoom, m = S.camera.mult;
  return z ? [m * z.min, m * z.max] : [m, m * SOFT_ZOOM_MAX];
}
function setZoom(shown) {
  if (S.mode !== 'live') return;
  const [lo, hi] = zoomLimits(), z = S.camera.zoom;
  const v = Math.min(hi, Math.max(lo, shown)) / S.camera.mult;
  if (z) {
    // The camera crops (or changes lens); the overlay's focal length follows.
    S.cam.fn *= v / S.camera.zoomValue; S.camera.zoomValue = v; z.set(v);
    clampFn(); syncFov();
    S.holdUntil = Math.max(S.holdUntil, performance.now() + 700);   // let the picture catch up before solving
  } else S.softZoom = v;          // no camera zoom: enlarge picture and overlay together
  S.settled = 0;
  syncZoom();
}
function syncZoom() {
  const el = $('zoom'), live = S.mode === 'live';
  el.hidden = !live;
  if (!live) return;
  const [lo, hi] = zoomLimits(), now = zoomShown();
  const steps = zoomSteps(lo, hi), key = steps.join();
  if (el.dataset.steps !== key) {
    el.dataset.steps = key;
    el.replaceChildren(...steps.map(z => {
      const b = document.createElement('button');
      b.dataset.z = z; b.onclick = () => setZoom(z);
      return b;
    }));
  }
  // The step at or below the current zoom carries the readout, as on the phone's own camera.
  let cur = 0;
  steps.forEach((z, i) => { if (z <= now * 1.03) cur = i; });
  [...el.children].forEach((b, i) => {
    const on = i === cur, z = on ? now : steps[i];
    b.setAttribute('aria-pressed', on);
    b.textContent = `${z < 1 ? z.toFixed(1).replace(/^0/, '') : z.toFixed(Math.abs(z - Math.round(z)) < 0.05 ? 0 : 1)}${on ? '×' : ''}`;
    b.setAttribute('aria-label', `Zoom ${z.toFixed(1)} times`);
  });
}

/** Open a back camera (the saved choice, the given one, or the browser's default) and read what it can do. */
async function openCamera(deviceId) {
  stream?.getTracks().forEach(t => t.stop());
  stream = await startCamera(video, deviceId);
  let track = stream.getVideoTracks()[0];
  const cams = await listCameras();
  if (!deviceId) {
    // First open: names are readable only now. Go back to the lens used last time.
    let want = null;
    try { want = localStorage.getItem('ridgeline.camera'); } catch { /* no memory */ }
    const saved = want && cams.find(c => c.label === want);
    if (saved && saved.deviceId !== track.getSettings().deviceId) {
      try {
        stream.getTracks().forEach(t => t.stop());
        stream = await startCamera(video, saved.deviceId);
      } catch { stream = await startCamera(video); }
      track = stream.getVideoTracks()[0];
    }
  }
  const id = track.getSettings().deviceId, idx = Math.max(0, cams.findIndex(c => c.deviceId === id));
  const label = cams[idx]?.label || track.label || '';
  const d = describeCamera(label, idx), zoom = cameraZoom(stream);
  S.camera = { key: (label || 'default').replace(/[^\w]+/g, '_'), label, mult: d.mult, zoom, zoomValue: zoom ? zoom.value : 1 };
  S.softZoom = 1; S.lensFor = null;
  // A camera that covers several lenses opens on its widest: start at the main lens (1x).
  if (zoom && d.mult < 1 && zoom.max * d.mult >= 1 && Math.abs(zoom.value * d.mult - 1) > 0.05) {
    S.camera.zoomValue = 1 / d.mult; zoom.set(S.camera.zoomValue);
  }
  const sel = $('lens');
  sel.replaceChildren(...cams.map((c, i) => {
    const o = document.createElement('option');
    o.value = c.deviceId; o.textContent = describeCamera(c.label, i).name; o.selected = c.deviceId === id;
    return o;
  }));
  $('lensRow').hidden = cams.length < 2;
}

function resetAlignment() {
  S.yawCorr = 0; S.camCorr = IDENT; S.locked = false; S.misses = 0; S.lastSolve = 0; S.lastSol = null; S.settled = 0;
  if (S.mode !== 'photo') { S.cam.fn = Camera.hfovToFn(DEFAULT_HFOV); S.cam.k1 = 0; S.lensKnown = false; S.photoZooms = null; }
  S.lensFor = null;            // live view: pick the lens up again for the current frame size
  S.demo.base = 0; S.demo.zoom = 1; S.demo.dirty = true;       // demo photo: the window starts over too
  syncFov();
}

function stopLive() {
  orient.stop(); stopGps?.(); stopGps = null;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
}

async function setMode(mode) {
  if (mode !== 'live') stopLive();
  S.mode = mode;
  $('statMode').textContent = { live: 'Camera', demo: 'Demo', photo: 'Photo' }[mode];
  for (const b of $('modes').children) b.setAttribute('aria-pressed', b.dataset.mode === mode);
  $('spotRow').hidden = mode === 'live';
  $('getHere').hidden = true;
  if (mode !== 'live') { $('lensRow').hidden = true; S.softZoom = 1; }
  resetAlignment(); syncZoom();
  if (mode === 'demo') {
    S.source = simCanvas;
    useSpot();
  } else if (mode === 'live') {
    S.source = video; S.pano = S.scene = S.model = null; S.origin = null;
    status('Waiting for GPS…');
    stopGps = watchPosition(onFix, msg => status(msg, 'bad'));
  }
}

function useSpot() {
  const s = S.spots[+$('spot').value] || S.spots[0];
  if (!s) return;
  if (S.mode === 'demo') {
    S.demo.yaw = s.yaw; S.demo.pitch = s.pitch; S.demo.autoPitch = !s.photo; S.demo.zoom = 1;
    S.demo.photo = null; S.source = simCanvas;
    $('credit').hidden = true;
    resetAlignment();
    if (s.photo) {
      const want = s;
      (async () => {
        photoPano = photoPano || new PhotoPano();
        await photoPano.load(s.photo);
        if (S.mode !== 'demo' || (S.spots[+$('spot').value] || S.spots[0]) !== want) return;   // moved on while it loaded
        S.demo.photo = s.photo; S.source = photoPano.canvas; S.demo.dirty = true;
        $('credit').textContent = s.photo.credit; $('credit').hidden = false;
      })().catch(e => status(`Could not load the demo photo: ${e.message}`, 'bad'));
    }
  }
  setViewpoint(s.pos[0], s.pos[1]);
}

function onFix(fix) {
  S.gps = fix;
  if (S.mode !== 'live' || S.building || S.switching) return;
  if (!S.pack.terrain.fine.contains(fix.lon, fix.lat) && areaAt(S.catalog, fix.lat, fix.lon)) {
    // walked (or drove) into another area: fetch its map, then carry on
    areaFor(fix.lat, fix.lon).then(() => onFix(fix)).catch(e => status(`Could not load that map: ${e.message}`, 'bad'));
    return;
  }
  const o = S.origin;
  const moved = o ? Math.hypot((fix.lat - o.lat) * 110540, (fix.lon - o.lon) * 111320 * Math.cos(fix.lat * D2R)) : Infinity;
  // Rebuild once the move outgrows GPS noise; a few meters does not shift the picture.
  if (moved > Math.max(10, Math.min(fix.acc || 10, 40))) setViewpoint(fix.lat, fix.lon);
}

async function loadPhoto(file) {
  const buf = await file.arrayBuffer();
  const exif = parseExif(buf);
  if (exif?.lat != null) await areaFor(exif.lat, exif.lon).catch(() => false);
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const sc = Math.min(1, 1600 / bmp.width);
  photoCanvas.width = Math.round(bmp.width * sc); photoCanvas.height = Math.round(bmp.height * sc);
  photoCanvas.getContext('2d').drawImage(bmp, 0, 0, photoCanvas.width, photoCanvas.height);
  await setMode('photo');
  S.source = photoCanvas;
  const spot = S.spots[+$('spot').value] || S.spots[0];
  let pos = spot.pos, yaw = spot.yaw, note = 'No GPS in this photo: using the spot chosen under Menu > View.';
  if (exif?.lat != null && exif?.lon != null && S.pack.terrain.fine.contains(exif.lon, exif.lat)) {
    pos = [exif.lat, exif.lon]; note = 'Photo location read from EXIF.';
    yaw = exif.direction != null ? exif.direction + (exif.directionRef === 'M' ? orient.declination : 0) : 0;
  } else if (exif?.lat != null) note = 'This photo was taken outside the map: using the spot chosen under Menu > View.';
  // Focal length, digital zoom and any crop, from EXIF; the solver refines it.
  const lens = photoLens(exif, photoCanvas.width, photoCanvas.height);
  S.cam.fn = lens.known ? lens.fn : Camera.hfovToFn(DEFAULT_HFOV) * Math.max(photoCanvas.width, photoCanvas.height) / photoCanvas.width;
  S.cam.k1 = 0; S.lensKnown = lens.known; S.photoZooms = lens.zooms;
  clampFn();
  note += lens.known ? ` Lens: ${lens.why}.` : ' Lens unknown: trying wide, main and telephoto.';
  S.photoHasCompass = exif?.direction != null && pos !== spot.pos;
  S.sensorR = rotFromYPR(yaw, 0, 0);
  syncFov();
  S.photoNote = note;
  setViewpoint(pos[0], pos[1]);
}

// -------------------------------------------------------------- frame loop

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const sw = Math.round(innerWidth * dpr), sh = Math.round(innerHeight * dpr);
  for (const c of [glCanvas, ovCanvas]) { if (c.width !== sw) c.width = sw; if (c.height !== sh) c.height = sh; }
  S.view.sw = sw; S.view.sh = sh; S.view.dpr = dpr;
}

function sourceSize() {
  const s = S.source;
  return s === video ? [video.videoWidth, video.videoHeight] : [s.width, s.height];
}

function renderDemo(now) {
  const d = S.demo;
  if (d.photo) return renderPhotoDemo();
  // Coarse while dragging, sharp once the view settles.
  const settled = !d.dragging && now - (d.lastMove || 0) > 140;
  const w = settled ? 560 : 256, h = Math.round(w * S.view.sh / S.view.sw);
  if (!d.dirty && d.w === w && d.h === h) return;
  const truth = new Camera(rotFromYPR(d.yaw + d.err.yaw, d.pitch + d.err.pitch, d.err.roll), Camera.hfovToFn(DEFAULT_HFOV) * d.err.fScale, d.err.k1);
  const frame = renderSim({ pano: S.pano, terrain: S.pack.terrain, ownerCost: S.own.cost }, truth, w, h);
  simCanvas.width = w; simCanvas.height = h;
  simCtx.putImageData(new ImageData(frame.data, w, h), 0, 0);
  d.w = w; d.h = h; d.dirty = false;
  S.sensorR = rotFromYPR(d.yaw, d.pitch, 0);
}

// The demo on a real photo: the "camera" is a window into the panorama. Zoom
// narrows the window; the view is kept inside the photo.
const demoBaseFn = () => Math.max(Camera.hfovToFn(DEFAULT_HFOV), minFn(S.demo.photo, S.view.sh / S.view.sw));
function renderPhotoDemo() {
  const d = S.demo, shape = S.view.sh / S.view.sw;
  const base = demoBaseFn();
  if (d.base !== base) {
    // first frame, or the screen turned: the lens guess follows the window
    S.cam.fn *= base / (d.base || Camera.hfovToFn(DEFAULT_HFOV));
    d.base = base; d.dirty = true; syncFov();
    // the window's lens is known to within the demo's small error: no wide or tele guesses
    S.lensKnown = true; S.photoZooms = null;
  }
  if (!d.dirty) return;
  const fn = base * d.zoom;
  // what must stay inside the photo is the true view, sensor and lens errors included
  const v = clampView(d.photo, d.yaw + d.err.yaw, d.pitch + d.err.pitch, fn * d.err.fScale, shape);
  d.yaw = v.yaw - d.err.yaw; d.pitch = v.pitch - d.err.pitch;
  const w = Math.min(S.view.sw, 1280), h = Math.round(w * shape);
  // the same deliberate sensor and lens errors as the drawn demo, for the solver to find
  const truth = new Camera(rotFromYPR(d.yaw + d.err.yaw, d.pitch + d.err.pitch, d.err.roll), fn * d.err.fScale, d.err.k1);
  photoPano.render(truth, w, h);
  d.w = w; d.h = h; d.dirty = false;
  S.sensorR = rotFromYPR(d.yaw, d.pitch, 0);
}

function currentR() {
  return matMul(matMul(S.camCorr, S.sensorR), yawMat(S.yawCorr));
}

function trySolve(now) {
  const [vw, vh] = sourceSize();
  if (!vw || !S.model) return;
  if (S.mode === 'live' && orient.rate > 12) return;           // phone is swinging
  if (S.mode === 'demo' && (S.demo.dragging || S.demo.w < 400)) return;
  S.lastSolve = now;
  const ah = Math.round(ANALYSIS_W * vh / vw);
  anaCanvas.width = ANALYSIS_W; anaCanvas.height = ah;
  anaCtx.imageSmoothingQuality = 'high';     // a 5x shrink without it aliases, and aliasing reads as edges
  anaCtx.drawImage(S.source, 0, 0, ANALYSIS_W, ah);
  const an = analyzeFrame({ w: ANALYSIS_W, h: ah, data: anaCtx.getImageData(0, 0, ANALYSIS_W, ah).data });
  S.opts.snowThr += (an.snowThr - S.opts.snowThr) * 0.5;
  if (!S.auto || now < S.holdUntil) return;
  const t0 = performance.now();
  const base = new Camera(currentR(), S.cam.fn, S.cam.k1);
  const sol = solveAlignment(S.model, base, an, {
    // Live, the compass is good to a few tens of degrees, and searching the
    // whole horizon invites a false lock on some other ridge (or a window
    // frame). A photo's compass tag can be anything.
    maxYaw: S.locked ? 10 : S.mode === 'live' ? 45 : 180, lens: S.lens,
    // unknown lens: try wide and tele too; a photo whose EXIF leaves the zoom unclear: try both readings
    zooms: S.locked ? null : S.lensKnown ? S.photoZooms : ZOOMS,
    maxPitch: S.mode === 'photo' && !S.locked ? 35 : 12,       // a photo says nothing about tilt
    strict: S.mode !== 'photo',                                // live: in cloud or fog, leave it to the sensors
  });
  S.solveMs = performance.now() - t0;
  S.lastSol = sol;
  if (sol && sol.ok) {
    // Once locked, take half of each new correction: steady, but still tracks drift.
    const k = S.locked && Math.abs(sol.yaw) < 3 ? 0.5 : 1;
    S.yawCorr += sol.yaw * k;
    S.camCorr = orthonormalize(matMul(pitchRollMat(sol.pitch * k, sol.roll * k), S.camCorr));
    if (S.lens) {
      S.cam.fn *= Math.pow(sol.fScale, k);
      clampFn();
      S.cam.k1 += (sol.k1 - S.cam.k1) * k;
      syncFov();
      if (S.locked) rememberLens();      // second agreeing solve: worth keeping
    }
    S.locked = true; S.misses = 0; S.settled++;
    status(S.mode === 'photo' && !S.photoHasCompass ? 'Aligned to the skyline' : `Aligned to the skyline (compass was ${Math.abs(S.yawCorr).toFixed(0)}° off)`, 'ok');
  } else {
    if (++S.misses > 3) S.locked = false;
    if (!S.locked || sol?.hidden) {
      status(sol?.hidden ? 'Mountains hidden: going by the compass. Drag to adjust.'
        : sol ? 'Skyline match is weak. Drag to line it up.' : 'No skyline in view. Tilt up, or drag to line it up.');
    }
  }
}

function tick(now) {
  requestAnimationFrame(tick);
  if (!S.source || !shader) return;
  resize();
  if (S.mode === 'live' && orient.R) S.sensorR = orient.R;
  if (S.mode === 'demo' && S.pano) renderDemo(now);
  const [vw, vh] = sourceSize();
  if (!vw) return;
  if (S.mode === 'live' && S.lensFor !== `${vw}x${vh}`) { S.lensFor = `${vw}x${vh}`; recallLens(vw, vh); syncZoom(); }
  const v = S.view;
  const sc = (S.mode === 'photo' ? Math.min(v.sw / vw, v.sh / vh) : Math.max(v.sw / vw, v.sh / vh)) * S.softZoom;
  v.fw = vw * sc; v.fh = vh * sc;
  S.cam.R = currentR();
  shader.draw(S.source, S.cam, v, S.opts);
  if (S.scene) drawOverlay(octx, S.scene, S.cam, v, S.opts);
  else octx.clearRect(0, 0, v.sw, v.sh);
  // a photo does not move: once it has settled, further solves can only disturb it
  const still = S.mode === 'photo' && S.settled >= 3;
  if (S.pano && !still && now - S.lastSolve > (S.locked ? 1800 : 900)) trySolve(now);
  if (!$('sheet').hidden && now - (S.lastDebug || 0) > 400) { S.lastDebug = now; debug(); }
}

function debug() {
  const y = yprFromRot(S.cam.R), sol = S.lastSol;
  $('debug').textContent = [
    `heading ${y.yaw.toFixed(1)}°  pitch ${y.pitch.toFixed(1)}°  roll ${y.roll.toFixed(1)}°`,
    `correction: yaw ${S.yawCorr.toFixed(1)}°  fov ${S.cam.hfov.toFixed(1)}°  k1 ${S.cam.k1.toFixed(3)}`,
    sol ? `last solve: sky ${sol.sky.toFixed(2)} ridges ${sol.crest.toFixed(2)} conf ${sol.confidence.toFixed(2)} ${sol.ok ? 'ok' : 'rejected'} (${S.solveMs?.toFixed(0)} ms)` : 'last solve: none',
    S.mode === 'live' && orient.raw ? `compass ${orient.raw.heading.toFixed(0)}°${orient.raw.firm ? '' : ' (near vertical)'}  alpha ${orient.raw.alpha.toFixed(0)} beta ${orient.raw.beta.toFixed(0)} gamma ${orient.raw.gamma.toFixed(0)}  offset ${(orient.offset ?? 0).toFixed(0)}°` : '',
    S.gps ? `gps ${S.gps.lat.toFixed(5)}, ${S.gps.lon.toFixed(5)} ±${Math.round(S.gps.acc)} m` : '',
    S.pano ? `terrain build ${S.buildMs?.toFixed(0)} ms, eye ${S.pano.hEye.toFixed(0)} m` : '',
    S.photoNote && S.mode === 'photo' ? S.photoNote : '',
  ].filter(Boolean).join('\n');
}

// Beta feedback: notes and screenshots, opened as a new message in the phone's mail app.
function wireFeedback() {
  const notes = $('fbNotes'), box = $('fbShots'), msg = $('fbMsg'), shots = [];
  const say = (text, cls = '') => { msg.textContent = text; msg.className = `legend ${cls}`; };
  try { notes.value = localStorage.getItem('fbNotes') || ''; } catch { /* no saved draft */ }
  notes.oninput = () => { try { localStorage.setItem('fbNotes', notes.value); } catch { /* draft not kept */ } };
  const draw = () => {
    box.textContent = '';
    shots.forEach((s, i) => {
      const b = document.createElement('button');
      b.style.backgroundImage = `url(${s.url})`;
      b.setAttribute('aria-label', `Remove screenshot ${i + 1}`);
      b.onclick = () => { URL.revokeObjectURL(s.url); shots.splice(i, 1); draw(); };
      box.append(b);
    });
    $('fbAdd').disabled = shots.length >= MAX_SHOTS;
  };
  const clear = () => {
    for (const s of shots) URL.revokeObjectURL(s.url);
    shots.length = 0; notes.value = ''; draw();
    try { localStorage.removeItem('fbNotes'); } catch { /* nothing kept */ }
  };
  $('fbAdd').onclick = () => $('fbFile').click();
  $('fbFile').onchange = async e => {
    const files = [...e.target.files]; e.target.value = '';
    const room = MAX_SHOTS - shots.length;
    let bad = 0;
    for (const f of files.slice(0, room)) {
      try { shots.push(await shrink(f)); } catch { bad++; }
    }
    draw();
    say(bad ? `${bad} picture${bad > 1 ? 's' : ''} could not be read.` : files.length > room ? `Up to ${MAX_SHOTS} screenshots per message.` : '', bad ? 'bad' : '');
  };
  $('fbSend').onclick = async () => {
    if (!notes.value.trim() && !shots.length) { say('Add a note or a screenshot first.', 'bad'); notes.focus(); return; }
    debug();
    const a = S.area, details = [
      `version ${document.querySelector('.ver')?.textContent}`,
      `mode ${S.mode || 'none'}  area ${a?.name || a?.id || 'none'}  screen ${innerWidth}x${innerHeight} @${devicePixelRatio}`,
      `status: ${$('statText').textContent}`,
      $('debug').textContent,
      navigator.userAgent,
    ].filter(Boolean).join('\n');
    $('fbSend').disabled = true; say('Opening your mail app…');
    try {
      const r = await sendFeedback({ notes: notes.value, shots, details, version: document.querySelector('.ver')?.textContent || 'dev' });
      if (r.sent === true) { clear(); say('Sent. Thank you.', 'ok'); }
      else if (r.sent === false) say('Not sent. Your notes are still here.');
      else if (r.dropped) say('A browser cannot attach pictures to an email: attach your screenshots in the mail app before sending.', 'bad');
      else say(r.via === 'share' ? 'Choose your mail app, and check the address before sending.' : 'Press Send in your mail app. Your notes stay here until you clear them.');
    } catch (e) { say(`The mail app could not be opened: ${e.message || e}`, 'bad'); }
    $('fbSend').disabled = false;
  };
  // keep the panel above the on-screen keyboard where the page is not resized for it
  const vv = window.visualViewport;
  if (vv) {
    const lift = () => document.documentElement.style.setProperty('--kb', `${Math.max(0, innerHeight - vv.height - vv.offsetTop)}px`);
    vv.addEventListener('resize', lift); vv.addEventListener('scroll', lift);
  }
}

function syncFov() {
  $('fov').value = S.cam.hfov;
  $('fovVal').textContent = `${S.cam.hfov.toFixed(0)}°`;
}

// ---------------------------------------------------------------------- UI

function showTab(name) {
  for (const b of $('tabs').children) b.setAttribute('aria-selected', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== name;
}

function wire() {
  // Layer switches live in two places (the dock and the menu); keep them in step.
  const setLayer = (k, on) => {
    S.opts[k] = on;
    document.querySelector(`.tog[data-k="${k}"]`)?.setAttribute('aria-pressed', on);
    const box = document.querySelector(`.sw input[data-k="${k}"]`);
    if (box) box.checked = on;
  };
  for (const b of document.querySelectorAll('.tog[data-k]')) b.onclick = () => setLayer(b.dataset.k, !S.opts[b.dataset.k]);
  for (const c of document.querySelectorAll('.sw input[data-k]')) c.onchange = () => setLayer(c.dataset.k, c.checked);
  const setAlpha = v => {
    S.opts.alpha = v;
    $('alpha').value = v; $('alphaVal').textContent = `${Math.round(v * 100)}%`;
    // lines and names fade with the shading, but stay readable a little longer
    ovCanvas.style.opacity = Math.min(1, v * 1.6);
  };
  $('alpha').oninput = e => setAlpha(+e.target.value);
  setAlpha(S.opts.alpha);
  $('legendBar').style.background = `linear-gradient(90deg, ${SLOPE_STOPS.map(s => `rgb(${s[1]},${s[2]},${s[3]}) ${(s[0] / 90 * 100).toFixed(1)}%`).join(', ')})`;
  [0, 15, 30, 45, 60, 90].forEach((d, i) => { $('legendTicks').children[i].style.left = `${d / 90 * 100}%`; });
  for (const b of $('shade').children) b.onclick = () => {
    S.opts.shade = b.dataset.shade;
    for (const o of $('shade').children) o.setAttribute('aria-pressed', o === b);
    $('legend').hidden = S.opts.shade !== 'slope';
  };
  $('cOutline').onchange = e => { S.opts.outline = e.target.checked; };
  const sheet = $('sheet');
  for (const b of $('tabs').children) b.onclick = () => showTab(b.dataset.tab);
  $('more').onclick = () => { sheet.hidden = !sheet.hidden; };
  $('sheetClose').onclick = () => { sheet.hidden = true; };
  // Full screen in a browser. Android browsers can be asked for it on a tap.
  // iPhone Safari cannot: there the app runs full screen only when it is
  // opened from a Home Screen icon, so the start screen says how to add one.
  const native = !!window.Capacitor?.isNativePlatform?.();
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
  $('a2hs').hidden = native || !ios || standalone;
  const goFull = () => {
    if (native || ios || standalone || document.fullscreenElement) return;
    document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch(() => {});
  };
  const enter = async fn => {
    $('startErr').textContent = '';
    try {
      if (!S.pack) { await new Promise(res => { S.pending = res; }); }
      await fn();
      $('start').hidden = true; $('bar').hidden = false;
    } catch (e) { $('startErr').textContent = e.message || String(e); }
  };
  $('goLive').onclick = () => {
    // Ask for motion access synchronously in the tap, before any await.
    orient.stop();
    const p = orient.start();
    goFull();
    enter(async () => { await p; await openCamera(); await setMode('live'); });
  };
  $('goDemo').onclick = () => { goFull(); enter(() => setMode('demo')); };
  $('goPhoto').onclick = () => $('file').click();
  $('file').onchange = e => { const f = e.target.files[0]; if (f) enter(() => loadPhoto(f)); e.target.value = ''; };
  for (const b of $('modes').children) b.onclick = async () => {
    try {
      if (b.dataset.mode === 'photo') $('file').click();
      else if (b.dataset.mode === 'live') { orient.stop(); const p = orient.start(); await p; await openCamera(); await setMode('live'); }
      else await setMode('demo');
      sheet.hidden = true;
    } catch (e) { status(e.message || String(e), 'bad'); }
  };
  $('area').onchange = e => chooseArea(S.catalog.find(x => x.id === e.target.value));
  $('addArea').onclick = pickArea;
  $('addFind').onclick = findPlace;
  $('addPlace').onkeydown = e => { if (e.key === 'Enter') findPlace(); };
  $('addHere').onclick = aroundMe;
  $('addGo').onclick = downloadArea;
  $('addCancel').onclick = () => { S.adding = null; addState(null); };
  $('addStop').onclick = () => S.adding?.stop?.();
  $('getHere').onclick = () => { if (S.gps) proposeArea(boxAround(S.gps.lat, S.gps.lon, 14), `Map at ${S.gps.lat.toFixed(2)}, ${S.gps.lon.toFixed(2)}`); };
  $('lens').onchange = async e => {
    const id = e.target.value;
    try {
      await openCamera(id);
      try { localStorage.setItem('ridgeline.camera', S.camera.label); } catch { /* not kept */ }
      resetAlignment(); syncZoom(); status('Lens changed. Lining up…');
    } catch (err) { status(`Could not open that lens: ${err.message || err}`, 'bad'); }
  };
  $('spot').onchange = () => { if (S.mode !== 'live') useSpot(); };
  $('fov').oninput = e => { S.cam.fn = Camera.hfovToFn(+e.target.value); $('fovVal').textContent = `${(+e.target.value).toFixed(0)}°`; S.holdUntil = performance.now() + 1500; };
  $('cAuto').onchange = e => { S.auto = e.target.checked; };
  $('cLens').onchange = e => { S.lens = e.target.checked; };
  $('cSnow').onchange = e => { S.opts.snowMask = e.target.checked; };
  $('cLines').onchange = e => { S.opts.runLines = e.target.checked; };
  $('cPeaks').onchange = e => { S.opts.peaks = e.target.checked; };
  $('cChair').onchange = e => { S.chair = e.target.checked; if (S.origin) setViewpoint(S.origin.lat, S.origin.lon); };
  // Sensor recorder: a short log of raw readings and what the app made of
  // them, as text the user can copy out of the phone.
  $('rec').onclick = () => {
    if (S.mode !== 'live') { status('Sensor recording needs camera mode.', 'bad'); return; }
    const rows = [], t0 = performance.now(), SECS = 12;
    let lastT = -1e9;
    const f = (v, d = 1) => (typeof v === 'number' ? v.toFixed(d) : '');
    orient.tap = (ev, R) => {
      const t = performance.now() - t0;
      if (t - lastT < 100) return;
      lastT = t;
      const y = yprFromRot(R), sa = screen.orientation?.angle ?? window.orientation ?? 0;
      rows.push([Math.round(t), f(ev.alpha), f(ev.beta), f(ev.gamma), f(ev.webkitCompassHeading), f(ev.webkitCompassAccuracy, 0), ev.absolute ? 1 : 0, sa,
        f(orient.offset), f(y.yaw), f(y.pitch), f(y.roll), f(S.yawCorr), S.locked ? 1 : 0].join(','));
    };
    $('rec').disabled = true; sheet.hidden = true;
    const tick = setInterval(() => {
      const left = SECS - (performance.now() - t0) / 1000;
      if (left > 0) { status(`Recording sensors… ${Math.ceil(left)} s. Tip the phone slowly down, then up.`); return; }
      clearInterval(tick); orient.tap = null; $('rec').disabled = false;
      const g = S.gps, [vw, vh] = sourceSize();
      $('recText').value = [
        `# ridgeline sensor log, version ${document.querySelector('.ver')?.textContent}`,
        `# ${navigator.userAgent}`,
        `# gps ${g ? `${g.lat.toFixed(5)},${g.lon.toFixed(5)} acc ${Math.round(g.acc)}` : 'none'}  declination ${orient.declination}  video ${vw}x${vh}  fov ${S.cam.hfov.toFixed(1)}`,
        't_ms,alpha,beta,gamma,compass,compassAcc,absolute,screenAngle,offset,appHeading,appPitch,appRoll,yawCorr,locked',
        ...rows,
      ].join('\n');
      $('recOut').hidden = false; sheet.hidden = false; showTab('help');
      $('recShare').hidden = !navigator.share;
      status(`Recorded ${rows.length} samples. Copy or share them from Menu > Info.`, 'ok');
    }, 250);
  };
  $('recCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('recText').value); status('Sensor log copied.', 'ok'); }
    catch { $('recText').select(); status('Select all and copy the log by hand.', 'bad'); }
  };
  $('recShare').onclick = () => navigator.share({ title: 'Ridgeline sensor log', text: $('recText').value }).catch(() => {});
  wireFeedback();
  $('reset').onclick = () => {
    const [w, h] = S.source ? sourceSize() : [0, 0];
    try { localStorage.removeItem(lensKey(w, h)); } catch { /* nothing to forget */ }
    resetAlignment(); status('Alignment reset.');
  };

  // Hand alignment. One finger (or the mouse) slides the overlay; two fingers
  // twist it (roll) and pinch it (zoom). With a mouse: Shift-drag rolls about
  // the center of the picture, the wheel zooms. In the demo a plain drag looks
  // around instead.
  const stage = $('stage'), pts = new Map();
  const hold = () => {
    S.holdUntil = performance.now() + 6000; S.locked = true; S.settled = 0;
    status('Lined up by hand. Auto-align resumes in a few seconds.');
  };
  const nudge = (dxPx, dyPx, rollDeg, zoom) => {
    const degPerPx = S.cam.hfov / (S.view.fw / S.view.dpr);
    if (S.mode === 'demo' && !rollDeg && (zoom === 1 || S.demo.photo)) {
      if (zoom !== 1) {
        // the demo photo zooms like a camera: picture and overlay together
        const z = Math.max(1, Math.min(8, S.demo.zoom * zoom));
        S.cam.fn *= z / S.demo.zoom; S.demo.zoom = z; syncFov();
      }
      S.demo.yaw -= dxPx * degPerPx; S.demo.pitch = Math.max(-35, Math.min(40, S.demo.pitch + dyPx * degPerPx));
      S.demo.dirty = true; S.demo.lastMove = performance.now();
      return;
    }
    S.yawCorr -= dxPx * degPerPx;
    S.camCorr = orthonormalize(matMul(pitchRollMat(dyPx * degPerPx, rollDeg), S.camCorr));
    // Live, a pinch zooms the camera itself and the overlay follows; on a
    // photo or the demo it rescales the overlay against the picture.
    if (zoom !== 1 && S.mode === 'live') { setZoom(zoomShown() * zoom); if (!dxPx && !dyPx && !rollDeg) return; }
    else if (zoom !== 1) { S.cam.fn *= zoom; clampFn(); syncFov(); }
    hold();
  };
  const centerAngle = e => Math.atan2(e.clientY - innerHeight / 2, e.clientX - innerWidth / 2);
  stage.addEventListener('pointerdown', e => {
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    stage.setPointerCapture(e.pointerId);
    if (S.mode === 'demo') S.demo.dragging = true;
  });
  stage.addEventListener('pointermove', e => {
    const was = pts.get(e.pointerId);
    if (!was) return;
    const now = [e.clientX, e.clientY];
    if (pts.size === 1) {
      if (e.shiftKey) {
        let d = centerAngle(e) - Math.atan2(was[1] - innerHeight / 2, was[0] - innerWidth / 2);
        d = Math.atan2(Math.sin(d), Math.cos(d));
        nudge(0, 0, d / D2R, 1);
      } else nudge(now[0] - was[0], now[1] - was[1], 0, 1);
    } else if (pts.size === 2) {
      // the other finger stays put for this event: twist and pinch are measured about it
      let other;
      for (const [id, p] of pts) if (id !== e.pointerId) other = p;
      const a0 = Math.atan2(was[1] - other[1], was[0] - other[0]), a1 = Math.atan2(now[1] - other[1], now[0] - other[0]);
      const d0 = Math.hypot(was[0] - other[0], was[1] - other[1]), d1 = Math.hypot(now[0] - other[0], now[1] - other[1]);
      const twist = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
      nudge((now[0] - was[0]) / 2, (now[1] - was[1]) / 2, twist / D2R, d0 > 20 && d1 > 20 ? d1 / d0 : 1);
    }
    pts.set(e.pointerId, now);
  });
  const up = e => {
    pts.delete(e.pointerId);
    if (!pts.size && S.demo.dragging) { S.demo.dragging = false; S.demo.dirty = true; S.demo.lastMove = performance.now(); }
  };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.shiftKey) nudge(0, 0, (e.deltaY || e.deltaX) * 0.02, 1);
    else nudge(0, 0, 0, Math.exp(-e.deltaY * 0.0008));
  }, { passive: false });
  addEventListener('resize', () => { S.demo.dirty = true; });
}

wire();
syncFov();
requestAnimationFrame(tick);
boot().then(() => {
  // URL switches for testing: ?demo&slope&outline&nosnow&alpha=0.4, ?photo=<url>
  const q = new URLSearchParams(location.search);
  if (q.has('demo')) $('goDemo').click();
  if (q.has('debug')) { $('sheet').hidden = false; showTab(q.get('debug') || 'help'); }
  if (q.has('photo')) fetch(q.get('photo')).then(r => r.blob()).then(b => loadPhoto(b)).then(() => { $('start').hidden = true; $('bar').hidden = false; });
  if (q.has('slope')) $('shade').children[1].click();
  if (q.has('outline')) $('cOutline').click();
  if (q.has('nosnow')) $('cSnow').click();
  if (q.has('alpha')) { $('alpha').value = q.get('alpha'); $('alpha').oninput({ target: $('alpha') }); }
}).catch(e => { status(`Could not load the map: ${e.message}`, 'bad'); $('startErr').textContent = `Could not load the map: ${e.message}`; });
// Test hook: lets a headless run drive the app.
window.__ridgeline = { S, setMode, setViewpoint, proposeArea };
