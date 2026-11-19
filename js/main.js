// main.js -- app shell: modes (camera / demo / photo), the frame loop, and
// the alignment state that ties the sensors to the terrain model.

import { buildPano, chainCrests, panoLook, D2R } from './terrain.js?v=1118.1807-8fd4651';
import { loadPack, prepareFeatures, buildOwnership, buildSlope, SLOPE_SCALES, slopeColor, MAX_REACH } from './runs.js?v=1118.1807-8fd4651';
import { Camera, IDENT, matMul, matT, rotFromYPR, yprFromRot, yawMat, pitchRollMat, orthonormalize } from './camera.js?v=1118.1807-8fd4651';
import { analyzeFrame, alignModel, solveAlignment } from './align.js?v=1118.1807-8fd4651';
import { renderSim } from './sim.js?v=1118.1807-8fd4651';
import { PhotoPano, ALTA, minFn, clampView } from './photodemo.js?v=1118.1807-8fd4651';
import { Shader, buildScene, drawOverlay, aimLifts } from './render.js?v=1118.1807-8fd4651';
import { startCamera, listCameras, cameraZoom, Orientation, watchPosition } from './sensors.js?v=1118.1807-8fd4651';
import { photoLens, describeCamera, zoomSteps } from './lens.js?v=1118.1807-8fd4651';
import { pickOnMap } from './mappick.js?v=1118.1807-8fd4651';
import { relocate } from './relocate.js?v=1118.1807-8fd4651';
import { parseExif } from './exif.js?v=1118.1807-8fd4651';
import { loadCatalog, savedAreas, areaAt, openArea, saveBuilt, removeArea, storageUse } from './store.js?v=1118.1807-8fd4651';
import { sendFeedback, shrink, MAX_SHOTS } from './feedback.js?v=1118.1807-8fd4651';
import { buildArea, checkBbox, estimate, bboxKm, AREA_MIN_KM, AREA_MAX_KM } from './build.js?v=1118.1807-8fd4651';

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
const fixBar = document.getElementById('fixBar');
const FOV_MIN = 4, FOV_MAX = 110;    // long telephoto to ultra-wide
const SOFT_ZOOM_MAX = 5;             // on-screen zoom where the camera offers none of its own
const DEFAULT_HFOV = 64;      // phone main camera, video mode, along the long side of the frame
const ZOOMS = [1, 0.6, 1.65]; // focal guesses tried while the lens is unknown: main, ultra-wide, tele
const ANALYSIS_W = 320;
const PHOTO_ACC_UNKNOWN = 10;  // meters: a photo's GPS fix when it does not say how good it is
const RELOCATE_RADIUS = 250;   // meters: how far 'fix a line' may move a photo's spot
const RELOCATE_LIFT = 60;      // meters: how far above the ground it may put the camera (a chairlift, a cliff top)
const PHOTO_ACC_POOR = 25;     // meters: worse than this, suggest setting the spot on the map

const S = {
  mode: null, pack: null, prep: null, own: null,
  pano: null, model: null, scene: null, origin: null, building: false,
  source: null,                         // video or canvas being shown
  sensorR: rotFromYPR(170, 8, 0),       // world -> camera straight from sensors
  yawCorr: 0, camCorr: IDENT,           // alignment: R = camCorr * sensorR * yaw(yawCorr)
  cam: new Camera(IDENT, Camera.hfovToFn(DEFAULT_HFOV), 0),
  opts: { runs: false, lifts: true, ridges: true, labels: true, peaks: true, runLines: true, snowMask: true, snowThr: 0.55, alpha: 0.65, shade: 'rating', slopeScale: 'full', outline: false },
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

/** Show what a box would cost and ask for a name before downloading. then: what to do once it is saved, instead of opening it as usual. */
function proposeArea(bbox, name, then = null) {
  const bad = checkBbox(bbox);
  if (bad) { addState(hasNativePicker() ? null : 'addForm', bad); return; }
  const [kx, ky] = bboxKm(bbox), est = estimate(bbox);
  S.adding = { bbox, then };
  addState('addConfirm');
  $('addWhat').textContent = `${kx.toFixed(0)} × ${ky.toFixed(0)} km. About ${(est.downloadBytes / 1e6).toFixed(0)} MB to download and ${(est.storeBytes / 1e6).toFixed(0)} MB on the phone. Best done on Wi-Fi before the trip.`;
  $('addName').value = (name || '').slice(0, 40);
  $('sheet').hidden = false; showTab('maps');
}

async function downloadArea() {
  const name = $('addName').value.trim() || 'My map area', { bbox, then } = S.adding;
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
    if (then) { $('sheet').hidden = true; await useArea(area); then(); } else await chooseArea(area);
  } catch (e) {
    addState(null, ctl.signal.aborted ? 'Download canceled.' : e.message || String(e));
  } finally { S.adding = null; }
}

/** A place by name, from OpenStreetMap: {lat, lon, name}, or null. */
async function geocode(q) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`);
  const hit = (await r.json())[0];
  return hit ? { lat: +hit.lat, lon: +hit.lon, name: hit.name } : null;
}

/** A map on the phone (or published) covers this spot. */
const covered = (lat, lon) => S.pack?.terrain.fine.contains(lon, lat) || !!areaAt(S.catalog, lat, lon);

/** The photo was taken where there is no map yet: offer the area around it, then carry on with then(). */
function offerPhotoArea(lat, lon, then, name = null) {
  S.pano = S.scene = null;
  const msg = 'This photo was taken outside your maps. Download the area around it to see it.';
  S.photoNote = msg; status(msg, 'bad');
  proposeArea(boxAround(lat, lon, 14), name || `Map at ${lat.toFixed(2)}, ${lon.toFixed(2)}`, then);
}

/** Fallback where there is no native map: find a place by name. */
async function findPlace() {
  const q = $('addPlace').value.trim();
  if (!q) { $('addErr').textContent = 'Type a place name first.'; return; }
  $('addErr').textContent = 'Searching…';
  try {
    const hit = await geocode(q);
    if (!hit) { $('addErr').textContent = 'Nothing found by that name.'; return; }
    proposeArea(boxAround(+hit.lat, +hit.lon, +$('addSize').value), hit.name || q);
  } catch { $('addErr').textContent = 'Search failed. Check the connection.'; }
}
function aroundMe() {
  const go = (lat, lon) => proposeArea(boxAround(lat, lon, +$('addSize').value), `Map at ${lat.toFixed(2)}, ${lon.toFixed(2)}`);
  if (S.gps) { go(S.gps.lat, S.gps.lon); return; }
  $('addErr').textContent = 'Finding your current location…';
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
    status(canGet ? 'No map on this phone for your current location.' : 'No map on this phone for your current location, and no connection to get one.', 'bad');
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
        eye: eyeHeight(), ownerGrid: S.pack.terrain.fine, owner: S.own.owner, ownerCost: S.own.cost, reach: MAX_REACH, slope: S.slope,
      });
      const chains = chainCrests(pano);
      S.pano = pano; S.model = alignModel(pano, chains); S.scene = buildScene(pano, chains, S.prep);
      S.origin = { lat, lon };
      if (S.mode === 'live' && S.gps) aimFromFix(S.gps);
      else if (S.mode === 'photo') S.scene.acc = S.photoAcc || 0;
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
      if (S.afterBuild) { const f = S.afterBuild; S.afterBuild = null; f(); }
      else status(S.mode === 'demo' ? 'Demo view. Drag to look around.'
        : S.mode === 'photo' && S.photoAcc > PHOTO_ACC_POOR ? `Looking for the skyline… This photo's GPS is only good to ±${Math.round(S.photoAcc)} m: Menu > View sets the spot on a map.`
          : 'Looking for the skyline…');
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
  setFix(false);
  S.mode = mode;
  $('statMode').textContent = { live: 'Camera', demo: 'Demo', photo: 'Photo' }[mode];
  for (const b of $('modes').children) b.setAttribute('aria-pressed', b.dataset.mode === mode);
  $('spotRow').hidden = mode === 'live';
  $('photoPosRow').hidden = mode !== 'photo';
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
  else aimFromFix(fix);
}

/** Lifts are close enough that every fix moves them: aim them from it (cheap), and drop the ones nearer than GPS can place. */
function aimFromFix(fix) {
  if (!S.scene || !(fix.lat === fix.lat)) return;
  const z = S.pack.terrain.elev(fix.lon, fix.lat);
  if (!(z === z)) return;
  aimLifts(S.scene, fix.lat, fix.lon, z + (S.chair ? 9 : 1.7), fix.acc || 0);
}

async function loadPhoto(file) {
  const buf = await file.arrayBuffer();
  const exif = parseExif(buf);
  S.photoFile = file;
  // the photo's own fix, wherever it is (S.photoFix below only when a map covers it)
  S.photoGps = exif?.lat != null && exif?.lon != null ? { lat: exif.lat, lon: exif.lon, acc: exif.hError > 0 ? exif.hError : PHOTO_ACC_UNKNOWN } : null;
  if (exif?.lat != null) await areaFor(exif.lat, exif.lon).catch(() => false);
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const sc = Math.min(1, 1600 / bmp.width);
  photoCanvas.width = Math.round(bmp.width * sc); photoCanvas.height = Math.round(bmp.height * sc);
  photoCanvas.getContext('2d').drawImage(bmp, 0, 0, photoCanvas.width, photoCanvas.height);
  await setMode('photo');
  S.source = photoCanvas;
  const spot = S.spots[+$('spot').value] || S.spots[0];
  const inMap = exif?.lat != null && exif?.lon != null && S.pack.terrain.fine.contains(exif.lon, exif.lat);
  // The photo's own fix and how far off it may be (iPhones record that; 0 or
  // missing means unknown, so assume a typical phone fix).
  S.photoFix = inMap ? { lat: exif.lat, lon: exif.lon, acc: exif.hError > 0 ? exif.hError : null } : null;
  let pos = spot.pos, yaw = spot.yaw, note = 'No GPS in this photo: tap where it was taken.';
  S.photoAcc = 0; S.photoUp = 0; S.anchors = []; setFix(false);
  if (inMap) {
    pos = [exif.lat, exif.lon]; S.photoAcc = S.photoFix.acc ?? PHOTO_ACC_UNKNOWN;
    note = S.photoFix.acc != null ? `Photo location read from EXIF (±${Math.round(S.photoFix.acc)} m).` : 'Photo location read from EXIF.';
    if (S.photoAcc > PHOTO_ACC_POOR) note += ' That is rough: set the spot on the map under Menu > View.';
    yaw = exif.direction != null ? exif.direction + (exif.directionRef === 'M' ? orient.declination : 0) : 0;
  }
  // Focal length, digital zoom and any crop, from EXIF; the solver refines it.
  const lens = photoLens(exif, photoCanvas.width, photoCanvas.height);
  S.cam.fn = lens.known ? lens.fn : Camera.hfovToFn(DEFAULT_HFOV) * Math.max(photoCanvas.width, photoCanvas.height) / photoCanvas.width;
  S.cam.k1 = 0; S.lensKnown = lens.known; S.photoZooms = lens.zooms;
  clampFn();
  S.photoLensNote = lens.known ? ` Lens: ${lens.why}.` : ' Lens unknown: trying wide, main and telephoto.';
  note += S.photoLensNote;
  S.photoHasCompass = exif?.direction != null && inMap;
  S.sensorR = rotFromYPR(yaw, 0, 0);
  syncFov();
  S.photoNote = note;
  photoPosText(inMap ? 'GPS' : 'spot');
  // Taken where there is no map yet: offer one, then read the photo again.
  if (exif?.lat != null && !inMap) {
    offerPhotoArea(exif.lat, exif.lon, () => { if (S.photoFile === file && S.mode === 'photo') loadPhoto(file); });
    return;
  }
  setViewpoint(pos[0], pos[1]);
  // No position at all: a spot from the list is surely wrong, so ask straight away.
  if (exif?.lat == null) pickPhotoSpot({ lat: pos[0], lon: pos[1] });
}

function photoPosText(how) {
  const f = S.photoFix;
  $('photoPosVal').textContent = how === 'fixed' ? 'spot moved to fit pinned lines' : how === 'map' ? 'spot set on the map'
    : how === 'GPS' ? `GPS${f?.acc != null ? ` ±${Math.round(f.acc)} m` : ''}` : 'no GPS: list spot';
}

// ------------------------------------------- photo: fix a line, move the spot

/** Eye height above the ground: a chair rider sits higher; a photo may have been taken from above the ground. */
const eyeHeight = () => (S.chair ? 9 : 1.7) + (S.mode === 'photo' ? S.photoUp || 0 : 0);

function setFix(on) {
  S.fixing = !!on && S.mode === 'photo';
  S.grab = null;
  const b = $('fixBtn');
  b.setAttribute('aria-pressed', S.fixing);
  b.textContent = S.fixing ? 'Done' : 'Fix a line';
  $('fixUndo').hidden = !S.fixing || !S.anchors?.length;
  if (S.fixing) status('Drag a lift or run line onto where it really is in the photo. Two lines at different distances work best.');
}

/** The lift or run point drawn nearest to (x, y), device pixels on the overlay. */
function grabAt(x, y) {
  const v = S.view, ox = (v.fw - v.sw) / 2, oy = (v.fh - v.sh) / 2, o = [0, 0];
  let best = null, bd = 28 * v.dpr;
  const near = (f, dirs, vis) => {
    for (let i = 0; i < vis.length; i++) {
      if (!vis[i] || !S.cam.project(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2], v.fw, v.fh, o)) continue;
      const d = Math.hypot(o[0] - ox - x, o[1] - oy - y);
      if (d < bd) { bd = d; best = { lat: f.pts[i][0], lon: f.pts[i][1], z: f.z[i], name: f.name || (f.kind === 'lift' ? 'lift' : 'run') }; }
    }
  };
  if (S.opts.lifts) for (const l of S.scene.lifts) near(l.f, l.dirs, l.ok);
  for (const r of S.scene.runs) near(r.f, r.dirs, r.vis);
  return best;
}

/** Where a world point lands on the overlay now, device pixels, or null. */
function onScreen(p) {
  const v = S.view, look = panoLook(S.pano, p.lat, p.lon, p.z, {}), c = 1 / Math.hypot(1, look.t), o = [0, 0];
  if (!S.cam.project(Math.sin(look.az) * c, Math.cos(look.az) * c, look.t * c, v.fw, v.fh, o)) return null;
  return [o[0] - (v.fw - v.sw) / 2, o[1] - (v.fh - v.sh) / 2];
}

/** The pinned lines: where each is drawn now, a ring where it belongs, a band between. */
function drawAnchors() {
  const v = S.view, s = v.dpr, ox = (v.fw - v.sw) / 2, oy = (v.fh - v.sh) / 2;
  const pair = (from, to, live) => {
    octx.strokeStyle = 'rgba(8,16,22,0.6)'; octx.lineWidth = 4 * s;
    octx.beginPath(); octx.moveTo(...from); octx.lineTo(...to); octx.stroke();
    octx.strokeStyle = live ? '#3fb6ff' : '#ffd84a'; octx.lineWidth = 2 * s;
    octx.beginPath(); octx.moveTo(...from); octx.lineTo(...to); octx.stroke();
    octx.fillStyle = octx.strokeStyle; octx.beginPath(); octx.arc(from[0], from[1], 3.5 * s, 0, Math.PI * 2); octx.fill();
    octx.strokeStyle = '#fff'; octx.lineWidth = 2.2 * s; octx.beginPath(); octx.arc(to[0], to[1], 8 * s, 0, Math.PI * 2); octx.stroke();
  };
  for (const a of S.anchors) { const at = onScreen(a); if (at) pair(at, [a.u * v.fw - ox, a.v * v.fh - oy], false); }
  if (S.grab) { const at = onScreen(S.grab); if (at) pair(at, [S.grab.x, S.grab.y], true); }
}

/** Search spots (and heights) nearby for one that puts every pinned line where it belongs. */
function runRelocate() {
  if (!S.pano || !S.anchors.length) return;
  const v = S.view;
  const r = relocate(S.pano, S.cam, v.fh / v.fw, S.anchors, S.pack.terrain, S.chair ? 9 : 1.7, { radius: RELOCATE_RADIUS, lift: RELOCATE_LIFT });
  if (!r) { status('Could not search around this spot.', 'bad'); return; }
  S.photoUp = r.up;
  // the rotation that keeps the skyline in place from the new spot; hold it there
  S.yawCorr = 0; S.camCorr = orthonormalize(matMul(r.R, matT(S.sensorR)));
  S.locked = true; S.settled = 3; S.holdUntil = 0;
  const px = Math.round(r.after * v.fw / v.dpr);
  const msg = `Moved the spot ${Math.round(r.moved)} m${r.up >= 3 ? `, ${Math.round(r.up)} m above the ground (taken from a lift?)` : ''}. `
    + `${S.anchors.length > 1 ? 'Pinned lines are' : 'The pinned line is'} ${px <= 2 ? 'on target' : `within ${px} px`}.`;
  S.photoNote = msg;
  photoPosText('fixed');
  S.afterBuild = () => status(msg, 'ok');
  setViewpoint(r.lat, r.lon);
}

/** Say where the photo was taken by tapping a map. The compass tag goes with a bad fix, so search every heading. */
async function pickPhotoSpot(start) {
  if (S.mode !== 'photo' || !S.pack) return;
  $('sheet').hidden = true;
  const o = start?.lat != null ? start : S.photoGps && !S.photoFix ? S.photoGps : S.origin;
  if (!o) return;
  $('pickHint').textContent = 'Tap where the photo was taken. Drag to move, pinch to zoom, twist to turn.'
    + (S.photoGps ? ' The yellow circle is where the photo\'s own GPS put it.' : '');
  // Once the skyline has been matched, show the view it found: every spot along
  // its center line sees the far ridges the same way, so that is where to slide.
  const view = S.locked && S.origin ? { lat: S.origin.lat, lon: S.origin.lon, yaw: yprFromRot(S.cam.R).yaw, hfov: S.cam.hfov } : null;
  if (view) $('pickHint').textContent += ' The white wedge is the view matched to the skyline: spots along its dashed line keep the ridges lined up, and a tap near the line lands on it.';
  $('pickHint').textContent += ' Anywhere works: outside your maps, it offers to download the area.';
  let place = null;   // the last place searched for, to name a new map after
  const got = await pickOnMap($('picker'), S.pack.terrain.fine, S.prep, o, S.photoGps, view,
    covered, async q => (place = await geocode(q)));
  if (!got || got === 'photo' || S.mode !== 'photo') return;   // 'photo': the library is open for another one
  if (!S.pack.terrain.fine.contains(got.lon, got.lat)) {
    const file = S.photoFile, again = () => { if (S.photoFile === file && S.mode === 'photo') usePhotoSpot(got); };
    if (!areaAt(S.catalog, got.lat, got.lon)) {
      const near = place && Math.hypot(place.lat - got.lat, (place.lon - got.lon) * Math.cos(got.lat * D2R)) < 0.05;
      offerPhotoArea(got.lat, got.lon, again, near ? place.name : null);
      return;
    }
    try { await areaFor(got.lat, got.lon); } catch (e) { status(`Could not load that map: ${e.message}`, 'bad'); return; }
  }
  usePhotoSpot(got);
}

/** Look from a spot picked on the map. */
function usePhotoSpot(got) {
  S.photoFix = S.photoFix && S.pack.terrain.fine.contains(S.photoFix.lon, S.photoFix.lat) ? S.photoFix : null;
  S.photoAcc = got.acc; S.photoUp = 0;
  S.photoHasCompass = false;
  resetAlignment();
  S.photoNote = `Spot set on the map (±${Math.round(got.acc)} m); searching every direction for the skyline.${S.photoLensNote || ''}`;
  photoPosText('map');
  setViewpoint(got.lat, got.lon);
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
  if (S.mode === 'photo' && S.pano && (S.anchors?.length || S.grab)) drawAnchors();
  // A snapshot has to be read in the same frame it was drawn: WebGL clears its canvas after.
  if (snapWant) { const f = snapWant; snapWant = null; f(captureView()); }
  const fixOff = S.mode !== 'photo' || !S.scene;
  if (fixBar.hidden !== fixOff) fixBar.hidden = fixOff;
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

// ------------------------------------------------- feedback: live snapshot

let snapWant = null;
const SNAP_MAX = 2000;        // pixels on the long side of a snapshot picture

/** Everything worth knowing to reproduce what is on screen, as plain data. */
function telemetry() {
  const r = (v, k = 5) => (typeof v === 'number' && isFinite(v) ? +v.toFixed(k) : v ?? null);
  const ypr = R => { const y = yprFromRot(R); return { yaw: r(y.yaw, 2), pitch: r(y.pitch, 2), roll: r(y.roll, 2) }; };
  const [vw, vh] = S.source ? sourceSize() : [0, 0], sol = S.lastSol, a = S.area;
  return {
    time: new Date().toISOString(), version: document.querySelector('.ver')?.textContent || 'dev',
    mode: S.mode, area: a ? { id: a.id, name: a.name } : null, status: $('statText').textContent,
    screen: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, orientation: screen.orientation?.type || null },
    view: { sw: S.view.sw, sh: S.view.sh, fw: r(S.view.fw, 1), fh: r(S.view.fh, 1) }, source: { w: vw, h: vh }, softZoom: S.softZoom,
    camera: { ...ypr(S.cam.R), hfov: r(S.cam.hfov, 3), fn: r(S.cam.fn, 5), k1: r(S.cam.k1, 5), R: S.cam.R.map(v => r(v, 6)) },
    sensors: { ...ypr(S.sensorR || IDENT), yawCorr: r(S.yawCorr, 3), camCorr: S.camCorr.map(v => r(v, 6)),
      compass: orient.raw ? { heading: r(orient.raw.heading, 1), firm: orient.raw.firm, alpha: r(orient.raw.alpha, 1), beta: r(orient.raw.beta, 1), gamma: r(orient.raw.gamma, 1) } : null,
      offset: r(orient.offset, 2), declination: orient.declination },
    lens: { label: S.camera.label, mult: S.camera.mult, zoom: r(S.camera.zoomValue, 3), known: S.lensKnown, solveLens: S.lens },
    align: { auto: S.auto, locked: S.locked, settled: S.settled, misses: S.misses,
      last: sol ? { ok: sol.ok, sky: r(sol.sky, 3), crest: r(sol.crest, 3), confidence: r(sol.confidence, 3), inliers: r(sol.inliers, 3), solid: r(sol.solid, 3), contrast: r(sol.contrast, 1), ms: r(S.solveMs, 0) } : null },
    position: {
      origin: S.origin ? { lat: r(S.origin.lat, 6), lon: r(S.origin.lon, 6) } : null,
      ground: S.pano ? r(S.pano.z0, 1) : null, eye: S.pano ? r(S.pano.hEye, 1) : null, chair: S.chair,
      gps: S.gps ? { lat: r(S.gps.lat, 6), lon: r(S.gps.lon, 6), acc: r(S.gps.acc, 1), alt: r(S.gps.alt, 1) } : null,
    },
    photo: S.mode === 'photo' ? { fix: S.photoFix, acc: S.photoAcc, up: S.photoUp, compass: S.photoHasCompass, note: S.photoNote,
      pins: (S.anchors || []).map(p => ({ name: p.name, lat: r(p.lat, 6), lon: r(p.lon, 6), z: r(p.z, 1), u: r(p.u, 4), v: r(p.v, 4) })) } : null,
    layers: S.opts, scene: S.scene ? { lifts: S.scene.lifts.length, runs: S.scene.runs.length, peaks: S.scene.peaks.length, liftAcc: S.scene.acc } : null,
    build: { ms: r(S.buildMs, 0) }, ua: navigator.userAgent,
  };
}

/** Draw the view as it is now, picture and overlay, without any of the controls. Call from tick only. */
function captureView() {
  // the part of the screen the picture covers (a letterboxed photo leaves bars)
  const v = S.view, x0 = Math.max(0, Math.round((v.sw - v.fw) / 2)), y0 = Math.max(0, Math.round((v.sh - v.fh) / 2));
  const cw = Math.min(glCanvas.width, glCanvas.width - 2 * x0) || glCanvas.width, ch = Math.min(glCanvas.height, glCanvas.height - 2 * y0) || glCanvas.height;
  const k = Math.min(1, SNAP_MAX / Math.max(cw, ch));
  const c = document.createElement('canvas');
  c.width = Math.round(cw * k); c.height = Math.round(ch * k);
  const ctx = c.getContext('2d');
  ctx.drawImage(glCanvas, x0, y0, cw, ch, 0, 0, c.width, c.height);
  ctx.drawImage(ovCanvas, x0, y0, cw, ch, 0, 0, c.width, c.height);
  // a caption with the essentials, in case the text of the message goes missing
  const t = telemetry(), cam = t.camera, pos = t.position.origin;
  const lines = [
    `${t.version}  ${t.mode}  ${t.area?.name || ''}  ${t.time.slice(0, 19).replace('T', ' ')}Z`,
    `heading ${cam.yaw}°  pitch ${cam.pitch}°  roll ${cam.roll}°  fov ${cam.hfov}°  k1 ${cam.k1}`,
    `${pos ? `spot ${pos.lat}, ${pos.lon}` : 'no spot'}  eye ${t.position.eye ?? '?'} m${t.position.gps ? `  gps ±${Math.round(t.position.gps.acc)} m` : ''}`,
    t.status,
  ];
  const fs = Math.max(11, Math.round(c.width / 46));
  ctx.font = `500 ${fs}px ui-monospace, Menlo, monospace`;
  const lh = fs * 1.3, hgt = lines.length * lh + fs * 0.8;
  ctx.fillStyle = 'rgba(8,16,22,0.72)'; ctx.fillRect(0, c.height - hgt, c.width, hgt);
  ctx.fillStyle = '#e8f0f4'; ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, fs * 0.5, c.height - hgt + fs * 0.4 + i * lh, c.width - fs));
  // and the picture the overlay was matched against, with nothing drawn on it
  let raw = null;
  if (S.source) {
    const [w, h] = sourceSize(), q = Math.min(1, SNAP_MAX / Math.max(w, h));
    raw = document.createElement('canvas'); raw.width = Math.round(w * q); raw.height = Math.round(h * q);
    try { raw.getContext('2d').drawImage(S.source, 0, 0, raw.width, raw.height); } catch { raw = null; }
  }
  return { view: c, raw, telemetry: t };
}

const toJpeg = c => new Promise(done => c.toBlob(done, 'image/jpeg', 0.88));

// Beta feedback: notes and screenshots, opened as a new message in the phone's mail app.
function wireFeedback() {
  const notes = $('fbNotes'), box = $('fbShots'), msg = $('fbMsg'), shots = [], snaps = [];
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
    $('fbSnap').disabled = shots.length > MAX_SHOTS - 2 || !S.source;
  };
  const clear = () => {
    for (const s of shots) URL.revokeObjectURL(s.url);
    shots.length = 0; snaps.length = 0; notes.value = ''; draw();
    try { localStorage.removeItem('fbNotes'); } catch { /* nothing kept */ }
  };
  $('fbAdd').onclick = () => $('fbFile').click();
  $('fbSnap').onclick = async () => {
    if (!S.source) { say('Nothing on screen to capture yet.', 'bad'); return; }
    if (shots.length > MAX_SHOTS - 2) { say(`Up to ${MAX_SHOTS} pictures per message.`, 'bad'); return; }
    $('fbSnap').disabled = true;
    try {
      const got = await new Promise((done, fail) => { snapWant = done; setTimeout(() => { if (snapWant === done) { snapWant = null; fail(new Error('the view is not drawing')); } }, 1500); });
      const n = snaps.length + 1;
      snaps.push(got.telemetry);
      for (const c of [got.view, got.raw]) {
        if (!c) continue;
        const blob = await toJpeg(c);
        if (blob) shots.push({ blob, url: URL.createObjectURL(blob), snap: n });
      }
      say(`Snapshot ${n} added: the view without the menu, the plain ${S.mode === 'photo' ? 'photo' : 'camera frame'}, and the app's settings and readings.`, 'ok');
    } catch (e) { say(`Could not capture the view: ${e.message || e}`, 'bad'); }
    draw();
  };
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
    if (!notes.value.trim() && !shots.length) { say('Add a note, a snapshot or a screenshot first.', 'bad'); notes.focus(); return; }
    debug();
    const kept = new Set(shots.map(s => s.snap).filter(Boolean));
    const a = S.area, details = [
      `version ${document.querySelector('.ver')?.textContent}`,
      `mode ${S.mode || 'none'}  area ${a?.name || a?.id || 'none'}  screen ${innerWidth}x${innerHeight} @${devicePixelRatio}`,
      `status: ${$('statText').textContent}`,
      $('debug').textContent,
      navigator.userAgent,
      // full readings, as data: one line per snapshot taken, then the state at sending
      ...snaps.map((t, i) => (kept.has(i + 1) ? `snapshot ${i + 1}: ${JSON.stringify(t)}` : '')),
      `at send: ${JSON.stringify(telemetry())}`,
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
  // the slope legend: the scale's range, sampled finely so the hard steps stay sharp
  const setSlopeScale = key => {
    const sc = SLOPE_SCALES[key] || SLOPE_SCALES.full, span = sc.hi - sc.lo, at = d => `${((d - sc.lo) / span * 100).toFixed(1)}%`;
    S.opts.slopeScale = key;
    for (const o of $('slopeScale').children) o.setAttribute('aria-pressed', o.dataset.scale === key);
    const g = [];
    for (let i = 0; i <= 120; i++) { const d = sc.lo + span * i / 120, c = slopeColor(d, sc.stops); g.push(`rgba(${c.slice(0, 3).map(Math.round)},${Math.max(0.15, c[3])}) ${at(d)}`); }
    $('legendBar').style.background = `linear-gradient(90deg, ${g.join(', ')})`;
    $('legendTicks').replaceChildren(...sc.ticks.map(d => { const t = document.createElement('span'); t.textContent = `${d}°`; t.style.left = at(d); t.style.transform = d <= sc.lo ? 'none' : d >= sc.hi ? 'translateX(-100%)' : ''; return t; }));
    try { localStorage.setItem('ridgeline.slopeScale', key); } catch { /* not kept */ }
  };
  for (const b of $('slopeScale').children) b.onclick = () => setSlopeScale(b.dataset.scale);
  let savedScale = 'full';
  try { savedScale = localStorage.getItem('ridgeline.slopeScale') || 'full'; } catch { /* default */ }
  setSlopeScale(savedScale);
  for (const b of $('shade').children) b.onclick = () => {
    S.opts.shade = b.dataset.shade;
    for (const o of $('shade').children) o.setAttribute('aria-pressed', o === b);
    $('legend').hidden = $('slopeRow').hidden = S.opts.shade !== 'slope';
  };
  $('cOutline').onchange = e => { S.opts.outline = e.target.checked; };
  const sheet = $('sheet');
  for (const b of $('tabs').children) b.onclick = () => showTab(b.dataset.tab);
  $('more').onclick = () => { sheet.hidden = !sheet.hidden; };
  $('sheetClose').onclick = () => { sheet.hidden = true; };
  // Full screen in a browser. Android browsers can be asked for it on a tap.
  // iPhone Safari generally cannot: there the app runs full screen only when it is
  // opened from a Home Screen icon, so the start screen says how to add one.
  const native = !!window.Capacitor?.isNativePlatform?.();
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
  $('a2hs').hidden = native || !ios || standalone;
  const goFull = () => {
    if (native || standalone || document.fullscreenElement || document.webkitFullscreenElement) return;
    // tried on iPhone too, in case its Safari allows it; where it does not, nothing happens
    const el = document.documentElement;
    try {
      if (el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' })?.catch(() => {});
      else el.webkitRequestFullscreen?.();
    } catch { /* stays in the browser window */ }
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
  $('spot').onchange = () => { if (S.mode !== 'live') { if (S.mode === 'photo') { S.photoAcc = 0; S.photoUp = 0; S.photoHasCompass = false; resetAlignment(); photoPosText('spot'); } useSpot(); } };
  $('photoPick').onclick = () => pickPhotoSpot();
  $('fixBtn').onclick = () => setFix(!S.fixing);
  $('fixUndo').onclick = () => {
    S.anchors.pop();
    $('fixUndo').hidden = !S.anchors.length;
    if (S.anchors.length) runRelocate(); else status('No lines pinned.');
  };
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
    if (S.fixing && S.scene && !pts.size && !S.grab) {
      // fixing a line: grab the nearest lift or run, never slide the overlay
      const x = e.clientX * S.view.dpr, y = e.clientY * S.view.dpr, g = grabAt(x, y);
      if (g) { S.grab = { ...g, x, y, id: e.pointerId }; stage.setPointerCapture(e.pointerId); }
      else status('Start the drag on a lift or run line.');
      return;
    }
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    stage.setPointerCapture(e.pointerId);
    if (S.mode === 'demo') S.demo.dragging = true;
  });
  stage.addEventListener('pointermove', e => {
    if (S.grab && e.pointerId === S.grab.id) { S.grab.x = e.clientX * S.view.dpr; S.grab.y = e.clientY * S.view.dpr; return; }
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
    if (S.grab && e.pointerId === S.grab.id) {
      const g = S.grab, v = S.view; S.grab = null;
      const from = onScreen(g);
      if (e.type === 'pointerup' && from && Math.hypot(from[0] - g.x, from[1] - g.y) > 6 * v.dpr) {
        // one pin per point: dragging the same spot again replaces it
        S.anchors = S.anchors.filter(a => Math.hypot(a.lat - g.lat, a.lon - g.lon) > 1e-6);
        S.anchors.push({ lat: g.lat, lon: g.lon, z: g.z, name: g.name,
          u: (g.x + (v.fw - v.sw) / 2) / v.fw, v: (g.y + (v.fh - v.sh) / 2) / v.fh });
        $('fixUndo').hidden = false;
        status('Finding the spot that fits…');
        setTimeout(runRelocate, 20);
      }
      return;
    }
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
