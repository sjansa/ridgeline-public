// near.js -- 1 m terrain close to the viewer, from USGS 3DEP lidar.
//
// The 10 m map is too coarse for what is a few hundred meters away: the ground
// under a lift tower, the lip of a run, the knoll in front of you. The USGS
// elevation service mosaics the best data it has (1 m lidar over most of the
// US) and answers browsers without a key. We fetch it in fixed tiles about
// 1.1 km square (0.01° of latitude tall), as LERC: elevations packed at a stated
// tolerance (here 12.5 cm, half the 25 cm step we store), about five times
// smaller than raw floats. Tiles are kept on the device, so a place seen once
// works offline, and the user can save a block of them ahead of a trip.
//
// How far out 1 m is worth having depends on the lens: past the distance where
// one meter shrinks below a screen pixel, the extra detail cannot show. The
// caller passes that radius; nearGrid() pieces the tiles in hand into one grid
// of that radius around the viewer, filling any gap from the 10 m map.

import { Grid } from './terrain.js?v=1123.1514-aebec47';
import { decodeLerc1 } from './lerc1.js';
import { getFile, putFile, delFile } from './store.js?v=1123.1514-aebec47';

const URL3DEP = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
export const ATTRIBUTION = '1 m terrain: USGS 3D Elevation Program.';
export const TILE = 0.01;                    // degrees of latitude a tile spans
export const NEAR_MIN = 300, NEAR_MAX = 1000; // meters: radius worth fetching, whatever the lens
export const SAVE_KM = 5;                    // side of a block saved ahead of time
export const TILE_BYTES = 1.1e6;             // a typical tile, compressed, for estimates
const UNIT = 0.25, TOL = 0.125, NODATA = 65535;
const ROWS = Math.round(TILE * 110540);      // ~1 m rows
const STEP = TILE / ROWS;                    // degrees between samples, both ways
const D2R = Math.PI / 180;
// The service insists on pixels square in degrees (asked for anything else, it
// quietly widens the box), so columns are STEP apart too: ~0.75 m east-west in
// Utah. A tile is as many columns as make it about as wide as it is tall; the
// count is fixed per 5° band of latitude so neighboring tiles line up.
export const colsAt = lat => Math.round(ROWS / Math.cos((Math.floor(lat / 5) * 5 + 2.5) * D2R));
const tileW = lat => colsAt(lat) * STEP;     // degrees of longitude a tile spans
const MEM_TILES = 16, CACHE_TILES = 60;      // decoded in memory; kept on the device beyond the saved ones

/** Rough check that a spot is in the US data (lower 48, Alaska, Hawaii, Puerto Rico). */
export function in3dep(lat, lon) {
  return (lat > 24 && lat < 50 && lon > -125.5 && lon < -66) || (lat > 51 && lat < 72 && (lon < -129 || lon > 172))
    || (lat > 18.5 && lat < 22.5 && lon > -161 && lon < -154) || (lat > 17.5 && lat < 18.7 && lon > -68 && lon < -65);
}

/** Radius worth 1 m data: where one meter is a screen pixel. fn: focal length over frame width; px: frame width in pixels. */
export function nearRadius(fn, px) {
  return Math.round(Math.min(NEAR_MAX, Math.max(NEAR_MIN, fn * px)));
}

const key = (ty, tx) => `near/${ty}_${tx}`;
const tileOf = (lat, lon, band = lat) => [Math.floor(lat / TILE), Math.floor(lon / tileW(band))];

/** The tiles a square of radius r meters around (lat, lon) touches, as [ty, tx]. */
export function tilesFor(lat, lon, r) {
  const dLat = r / 110540, dLon = r / (111320 * Math.cos(lat * D2R));
  const [ty0, tx0] = tileOf(lat - dLat, lon - dLon, lat), [ty1, tx1] = tileOf(lat + dLat, lon + dLon, lat);
  const out = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push([ty, tx]);
  return out;
}
/** The tiles covering a [west, south, east, north] box. */
export function tilesInBox([w, s, e, n]) {
  const m = (s + n) / 2, [ty0, tx0] = tileOf(s, w, m), [ty1, tx1] = tileOf(n, e, m);
  const out = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push([ty, tx]);
  return out;
}

// ------------------------------------------------------------- the tile store

const mem = new Map();        // key -> {C, data: Uint16Array | null (no data there)}, most recent last
const failed = new Map();     // key -> time of a failed download, to wait before trying again
let index = null;             // key -> {t: last used, pins: [ids]}, kept on the device
let saveTimer = 0;

async function loadIndex() {
  if (!index) index = (await getFile('near/index').catch(() => null)) || {};
  return index;
}
function saveIndex() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => putFile('near/index', index), 500);
}
function touch(k) {
  const e = index[k] || (index[k] = { t: 0, pins: [] });
  e.t = Date.now();
}
/** Keep the device cache to its size: drop the least recently used tiles nobody saved. */
async function evict() {
  const loose = Object.entries(index).filter(([, e]) => !e.pins.length).sort((a, b) => a[1].t - b[1].t);
  for (const [k] of loose.slice(0, Math.max(0, loose.length - CACHE_TILES))) { delete index[k]; await delFile(k); }
  saveIndex();
}

/** Download one tile's LERC blob (an empty buffer where the service has nothing). */
async function download(ty, tx, signal) {
  // pixel centers on the tile's edges (neighbors share them): half a pixel more all round
  const C = colsAt((ty + 0.5) * TILE), h = STEP / 2;
  const w = tx * C * STEP, s = ty * ROWS * STEP, e = (tx + 1) * C * STEP, n = (ty + 1) * ROWS * STEP;
  const q = new URLSearchParams({
    bbox: [w - h, s - h, e + h, n + h].map(v => v.toFixed(10)).join(','), bboxSR: 4326, imageSR: 4326,
    size: `${C + 1},${ROWS + 1}`, format: 'lerc', compressionTolerance: TOL, pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation', f: 'image',
  });
  const r = await fetch(`${URL3DEP}?${q}`, { signal });
  if (!r.ok) throw new Error(`1 m terrain: ${r.status}`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength < 10 || String.fromCharCode(...new Uint8Array(buf, 0, 9)) !== 'CntZImage') {
    // an error comes back as JSON; anything else that is not LERC counts as no data
    if (/error/i.test(new TextDecoder().decode(buf.slice(0, 200)))) throw new Error('1 m terrain: the service refused.');
    return new ArrayBuffer(0);
  }
  return buf;
}

/** Elevations of a tile in UNIT steps, NODATA in the holes; null when mostly holes. */
function decode(buf, ty) {
  if (!buf.byteLength) return { C: colsAt((ty + 0.5) * TILE), data: null };
  const l = decodeLerc1(buf), C = l.width - 1;
  if (l.height !== ROWS + 1) return { C, data: null };
  const data = new Uint16Array(l.data.length);
  let holes = 0;
  for (let i = 0; i < data.length; i++) {
    const z = l.data[i];
    if (z > -500 && z < 9000) data[i] = Math.max(0, Math.round(z / UNIT));
    else { data[i] = NODATA; holes++; }
  }
  return { C, data: holes > 0.5 * data.length ? null : data };
}

function remember(k, tile) {
  mem.delete(k); mem.set(k, tile);
  while (mem.size > MEM_TILES) mem.delete(mem.keys().next().value);
}

/**
 * Have these tiles in memory: from memory, the device, or (net) the service.
 * Resolves to the number that arrived from the device or the network.
 */
export async function ensureTiles(list, { net = true, signal } = {}) {
  await loadIndex();
  let got = 0;
  const todo = list.filter(([ty, tx]) => {
    const k = key(ty, tx);
    if (mem.has(k)) { remember(k, mem.get(k)); return false; }
    return !(failed.get(k) > Date.now() - 60e3);
  });
  const one = async ([ty, tx]) => {
    const k = key(ty, tx);
    try {
      let buf = await getFile(k).catch(() => null);
      if (!buf) {
        if (!net) return;
        buf = await download(ty, tx, signal);
        await putFile(k, buf);
      }
      remember(k, decode(buf, ty));
      touch(k); got++;
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      failed.set(k, Date.now());
    }
  };
  // a few at a time
  for (let i = 0; i < todo.length; i += 4) await Promise.all(todo.slice(i, i + 4).map(one));
  if (got) { saveIndex(); evict(); }
  return got;
}

/**
 * One grid of radius r meters around (lat, lon) from the tiles in memory,
 * gaps filled from fallback(lon, lat) (the 10 m map). Returns {grid, cover:
 * the share that is real 1 m data}, or null when there is none at all.
 */
export function nearGrid(lat, lon, r, fallback) {
  const C = colsAt(lat), dLat = r / 110540, dLon = r / (111320 * Math.cos(lat * D2R));
  // global sample lattice: lon = i * STEP, lat = j * STEP; tile (ty, tx) holds i in tx*C..tx*C+C, j in ty*ROWS..ty*ROWS+ROWS
  const i0 = Math.floor((lon - dLon) / STEP), i1 = Math.ceil((lon + dLon) / STEP);
  const j0 = Math.floor((lat - dLat) / STEP), j1 = Math.ceil((lat + dLat) / STEP);
  const cols = i1 - i0 + 1, rows = j1 - j0 + 1, out = new Uint16Array(cols * rows);
  let real = 0;
  for (let j = j1, m = 0; j >= j0; j--, m++) {
    const ty = Math.floor(j / ROWS), rr = ROWS - (j - ty * ROWS);     // a tile's south edge row is ROWS
    for (let i = i0; i <= i1;) {
      const tx = Math.floor(i / C), end = Math.min(i1, tx * C + C - 1), t = mem.get(key(ty, tx));
      const ok = t && t.data && t.C === C;
      for (; i <= end; i++) {
        const o = m * cols + (i - i0);
        const v = ok ? t.data[rr * (C + 1) + (i - tx * C)] : NODATA;
        if (v !== NODATA) { out[o] = v; real++; } else {
          const z = fallback(i * STEP, j * STEP);
          out[o] = z === z ? Math.max(0, Math.round(z / UNIT)) : 0;
        }
      }
    }
  }
  if (!real) return null;
  const grid = new Grid({ west: i0 * STEP, east: i1 * STEP, south: j0 * STEP, north: j1 * STEP, cols, rows }, out, UNIT);
  return { grid, cover: real / out.length };
}

/** All of these tiles are in memory (holes and no-data tiles count as in hand). */
export const haveTiles = list => list.every(([ty, tx]) => mem.has(key(ty, tx)) || failed.get(key(ty, tx)) > Date.now() - 60e3);

// ------------------------------------------------------- saving ahead of time

/**
 * Save the tiles of a box on the device for good, under pin (an area id, or
 * 'here'). progress(f, bytes). Resolves to {tiles, bytes}.
 */
export async function saveBox(bbox, pin, progress = () => {}, signal) {
  await loadIndex();
  const list = tilesInBox(bbox);
  let bytes = 0, done = 0;
  const one = async ([ty, tx]) => {
    const k = key(ty, tx);
    let buf = await getFile(k).catch(() => null);
    if (!buf) { buf = await download(ty, tx, signal); if (!await putFile(k, buf)) throw new Error('Could not save the 1 m terrain: the device is out of storage.'); }
    bytes += buf.byteLength;
    touch(k);
    if (!index[k].pins.includes(pin)) index[k].pins.push(pin);
    progress(++done / list.length, bytes);
  };
  for (let i = 0; i < list.length; i += 4) await Promise.all(list.slice(i, i + 4).map(one));
  saveIndex();
  return { tiles: list.length, bytes };
}

/** Let go of what was saved under pin; the tiles fall back into the ordinary cache. */
export async function unpin(pin) {
  await loadIndex();
  for (const e of Object.values(index)) e.pins = e.pins.filter(p => p !== pin);
  await evict();
}

/** What is saved under pin: {tiles, bytes (estimated)}. */
export async function pinned(pin) {
  await loadIndex();
  const n = Object.values(index).filter(e => e.pins.includes(pin)).length;
  return { tiles: n, bytes: n * TILE_BYTES };
}

/** A square box of side km around (lat, lon), clipped to clip if given. */
export function boxAround(lat, lon, km, clip = null) {
  const dLat = km / 2 / 110.54, dLon = km / 2 / (111.32 * Math.cos(lat * D2R));
  const b = [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
  return clip ? [Math.max(b[0], clip[0]), Math.max(b[1], clip[1]), Math.min(b[2], clip[2]), Math.min(b[3], clip[3])] : b;
}
