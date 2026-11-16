// build.js -- make a map area on the device, for anywhere the user picks.
//
// The same recipe as tools/build_pack.py, run in the app: elevation from the
// public Terrarium tiles (AWS Open Data), lifts, runs and peaks from
// OpenStreetMap through the Overpass API, declination from the World Magnetic
// Model. The result is the same four files as a prebuilt pack, so the rest of
// the app cannot tell the difference. It needs a connection once; after that
// the area lives on the device.
//
// buildFeatures and the grid maths have no browser dependencies (the tests run
// them in Node); only tile decoding and fetch do.

import { declination } from './geomag.js?v=1115.2129-e2ef7b8';

export const DEM_UNIT = 0.25;
export const FINE_RES = 10, COARSE_RES = 50;      // meters
export const COARSE_MARGIN_KM = 15;               // far ridges beyond the detailed area
export const AREA_MIN_KM = 2, AREA_MAX_KM = 25;   // side of the detailed area
const TILE = 256, MAX_Z = 14, MERC_R = 6378137;
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const LIFT_TYPES = ['cable_car', 'gondola', 'mixed_lift', 'chair_lift', 'drag_lift', 't-bar', 'j-bar', 'platter', 'rope_tow', 'magic_carpet'];
const ATTRIBUTION = 'Terrain: Mapzen/AWS Terrain Tiles. Lifts, runs, peaks: © OpenStreetMap contributors (ODbL).';

// ------------------------------------------------------------------ geometry

const kmPerDegLat = 110.54, kmPerDegLon = lat => 111.32 * Math.cos(lat * Math.PI / 180);

/** Width and height of a [west, south, east, north] box in km. */
export function bboxKm([w, s, e, n]) {
  return [(e - w) * kmPerDegLon((s + n) / 2), (n - s) * kmPerDegLat];
}
export function expandBbox([w, s, e, n], km) {
  const dLat = km / kmPerDegLat, dLon = km / kmPerDegLon((s + n) / 2);
  return [w - dLon, s - dLat, e + dLon, n + dLat].map(v => Math.round(v * 1e5) / 1e5);
}
export function gridDims([w, s, e, n], resM) {
  const [kx, ky] = bboxKm([w, s, e, n]);
  return [Math.max(2, Math.round(kx * 1000 / resM) + 1), Math.max(2, Math.round(ky * 1000 / resM) + 1)];
}
/** Coarsest tile zoom whose pixels are no bigger than resM on the ground. */
export function zoomFor(resM, lat) {
  for (let z = 0; z <= MAX_Z; z++) {
    if (2 * Math.PI * MERC_R * Math.cos(lat * Math.PI / 180) / (TILE * 2 ** z) <= resM) return z;
  }
  return MAX_Z;
}
/** Fractional tile coordinates (slippy-map convention). */
export function tileXY(lon, lat, z) {
  const n = 2 ** z, s = Math.sin(lat * Math.PI / 180);
  return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}
export function tilesFor(bbox, z) {
  const [x0, y0] = tileXY(bbox[0], bbox[3], z), [x1, y1] = tileXY(bbox[2], bbox[1], z);
  // one pixel of slack so bilinear sampling at the edge has a neighbor
  const tx0 = Math.floor(x0 - 1 / TILE), ty0 = Math.floor(y0 - 1 / TILE), tx1 = Math.floor(x1 + 1 / TILE), ty1 = Math.floor(y1 + 1 / TILE);
  const list = [];
  for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) list.push([x, y]);
  return { z, tx0, ty0, cols: tx1 - tx0 + 1, rows: ty1 - ty0 + 1, list };
}

/**
 * Sample a tile mosaic (Float32 elevations, Web Mercator) onto the pack's
 * regular lat/lon lattice: row 0 north, column 0 west, nodes on the box edges.
 * Returns {cols, rows, data: Uint16Array in DEM_UNIT meters}.
 */
export function resample(mosaic, bbox, resM) {
  const [w, s, e, n] = bbox, [cols, rows] = gridDims(bbox, resM);
  const { z, tx0, ty0, width, height, data } = mosaic;
  const out = new Uint16Array(cols * rows);
  const px = new Float64Array(cols);
  for (let c = 0; c < cols; c++) px[c] = (tileXY(w + c * (e - w) / (cols - 1), 0, z)[0] - tx0) * TILE - 0.5;
  for (let r = 0; r < rows; r++) {
    const lat = n - r * (n - s) / (rows - 1);
    const fy = Math.min(height - 1.001, Math.max(0, (tileXY(0, lat, z)[1] - ty0) * TILE - 0.5));
    const y0 = Math.floor(fy), ty = fy - y0;
    for (let c = 0; c < cols; c++) {
      const fx = Math.min(width - 1.001, Math.max(0, px[c])), x0 = Math.floor(fx), tx = fx - x0, i = y0 * width + x0;
      const v = (data[i] * (1 - tx) + data[i + 1] * tx) * (1 - ty) + (data[i + width] * (1 - tx) + data[i + width + 1] * tx) * ty;
      out[r * cols + c] = Math.min(65535, Math.max(0, Math.round(v / DEM_UNIT)));
    }
  }
  return { cols, rows, data: out };
}

/**
 * The tile set has holes that decode to thousands of meters below the ground,
 * and a failed tile leaves NaN. Replace anything that cannot be terrain with
 * the nearest good value, spreading inwards from the edges of each hole.
 */
export function repairMosaic(m) {
  const { width: W, height: H, data: d } = m;
  const bad = i => !(d[i] > -500 && d[i] < 9000);
  let queue = [];
  for (let i = 0; i < d.length; i++) if (bad(i)) { d[i] = NaN; queue.push(i); }
  if (queue.length === d.length) throw new Error('No terrain data for this area.');
  const holes = queue.length;
  for (let pass = 0; queue.length && pass < 4096; pass++) {
    const next = [], fill = [];
    for (const i of queue) {
      const x = i % W, y = (i - x) / W;
      let sum = 0, n = 0;
      if (x > 0 && d[i - 1] === d[i - 1]) { sum += d[i - 1]; n++; }
      if (x < W - 1 && d[i + 1] === d[i + 1]) { sum += d[i + 1]; n++; }
      if (y > 0 && d[i - W] === d[i - W]) { sum += d[i - W]; n++; }
      if (y < H - 1 && d[i + W] === d[i + W]) { sum += d[i + W]; n++; }
      if (n) fill.push(i, sum / n); else next.push(i);
    }
    for (let k = 0; k < fill.length; k += 2) d[fill[k]] = fill[k + 1];
    queue = next;
  }
  return holes;
}

// ----------------------------------------------------------------- downloads

/** Decode one Terrarium PNG to elevations (browser). */
async function decodeTile(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(TILE, TILE) : Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const px = cx.getImageData(0, 0, TILE, TILE).data, out = new Float32Array(TILE * TILE);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
  return out;
}

async function fetchMosaic(bbox, resM, onTile, signal) {
  const t = tilesFor(bbox, zoomFor(resM, (bbox[1] + bbox[3]) / 2));
  const width = t.cols * TILE, height = t.rows * TILE, data = new Float32Array(width * height).fill(NaN);
  let next = 0, failed = 0;
  const worker = async () => {
    while (next < t.list.length) {
      const [x, y] = t.list[next++];
      let tile = null;
      for (let attempt = 0; attempt < 3 && !tile; attempt++) {
        try {
          const r = await fetch(TILE_URL(t.z, x, y), { signal });
          if (r.ok) tile = await decodeTile(await r.blob());
          else if (r.status === 404 || r.status === 403) break;       // open sea: no tile
        } catch (e) { if (signal?.aborted) throw e; }
      }
      if (tile) {
        const c0 = (x - t.tx0) * TILE, r0 = (y - t.ty0) * TILE;
        for (let r = 0; r < TILE; r++) data.set(tile.subarray(r * TILE, (r + 1) * TILE), (r0 + r) * width + c0);
      } else failed++;
      onTile();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (failed > t.list.length * 0.2) throw new Error('Could not download the terrain. Check the connection and try again.');
  const m = { z: t.z, tx0: t.tx0, ty0: t.ty0, width, height, data };
  repairMosaic(m);
  return m;
}

export function overpassQuery(fine, coarse) {
  const fb = `(${fine[1]},${fine[0]},${fine[3]},${fine[2]})`, cb = `(${coarse[1]},${coarse[0]},${coarse[3]},${coarse[2]})`;
  return '[out:json][timeout:120];('
    + `way["piste:type"="downhill"]${fb};relation["piste:type"="downhill"]${fb};`
    + `way["aerialway"~"^(${LIFT_TYPES.join('|')})$"]${fb};`
    + `node["natural"="peak"]["name"]${cb};`
    + `relation["landuse"="winter_sports"]["name"]${fb};way["landuse"="winter_sports"]["name"]${fb};`
    + `relation["site"="piste"]["name"]${fb};way["site"="piste"]["name"]${fb};`
    + ');out geom;';
}

async function fetchOverpass(query, signal) {
  let last = 'no answer';
  for (const url of [...OVERPASS, OVERPASS[0]]) {
    try {
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal });
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.elements)) return j;
        last = 'unreadable answer';
      } else last = `status ${r.status}`;
    } catch (e) { if (signal?.aborted) throw e; last = e.message; }
  }
  throw new Error(`Could not download lifts and runs (${last}). Try again in a minute.`);
}

// ------------------------------------------------------------------ features

const r6 = v => Math.round(v * 1e6) / 1e6;

/** OSM `ele` is messy in the wild: '3,352', '11253 ft', '2 950 m'. Meters, or null. */
export function parseEle(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw;
  let s = String(raw).replace(/,/g, '').replace(/ /g, ' ').trim();
  s = s.replace(/(\d)\s(?=\d{3}(?:\D|$))/g, '$1');      // space as a thousands separator
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  let v = parseFloat(m[0]);
  if (/(ft|feet|')\s*$/i.test(s)) v *= 0.3048;
  return v;
}

/** Join member ways (arrays of [lat, lon]) into closed rings. */
function stitchRings(ways) {
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const segs = ways.filter(w => w.length >= 2).map(w => w.slice()), rings = [];
  while (segs.length) {
    let cur = segs.shift(), grew = true;
    while (!same(cur[0], cur[cur.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], end = cur[cur.length - 1];
        if (same(s[0], end)) cur = cur.concat(s.slice(1));
        else if (same(s[s.length - 1], end)) cur = cur.concat(s.slice().reverse().slice(1));
        else if (same(s[s.length - 1], cur[0])) cur = s.slice(0, -1).concat(cur);
        else if (same(s[0], cur[0])) cur = s.slice().reverse().slice(0, -1).concat(cur);
        else continue;
        segs.splice(i, 1); grew = true;
        break;
      }
    }
    rings.push(cur);
  }
  return rings.filter(r => r.length >= 4 && same(r[0], r[r.length - 1]));
}

/**
 * Turn an Overpass answer into the pack's features: {resorts, lifts, runs,
 * peaks}. sample(lat, lon) gives ground elevation in meters (runs are stored
 * top first, lifts bottom first). coarse = [w, s, e, n] bounds for peaks.
 */
export function buildFeatures(data, sample, coarse) {
  const els = data.elements, lifts = [], runs = [], peaks = [], resorts = new Map();
  const pisteWays = new Set(), lin = [], later = [];
  const wayPts = el => (el.geometry || []).filter(Boolean).map(g => [r6(g.lat), r6(g.lon)]);
  const runTags = t => [t.name || t['piste:name'] || '', t['piste:difficulty'] || 'unknown', t['piste:grooming'] || ''];
  for (const el of els) {
    const t = el.tags || {}, typ = el.type;
    if (typ === 'node' && t.natural === 'peak' && t.name) {
      if (!(coarse[0] <= el.lon && el.lon <= coarse[2] && coarse[1] <= el.lat && el.lat <= coarse[3])) continue;
      const ele = parseEle(t.ele) ?? sample(el.lat, el.lon);
      peaks.push({ name: t.name, lat: r6(el.lat), lon: r6(el.lon), ele: Math.round(ele * 10) / 10 });
      continue;
    }
    if ((typ === 'way' || typ === 'relation') && (t.landuse === 'winter_sports' || t.site === 'piste') && t.name) {
      const pts = typ === 'way' ? wayPts(el)
        : el.bounds ? [[(el.bounds.minlat + el.bounds.maxlat) / 2, (el.bounds.minlon + el.bounds.maxlon) / 2]] : [];
      if (pts.length && !resorts.has(t.name)) {
        resorts.set(t.name, { name: t.name, lat: r6(pts.reduce((a, p) => a + p[0], 0) / pts.length), lon: r6(pts.reduce((a, p) => a + p[1], 0) / pts.length) });
      }
    }
    if (typ === 'way' && LIFT_TYPES.includes(t.aerialway)) {
      const pts = wayPts(el);
      if (pts.length >= 2) lifts.push({ id: el.id, name: t.name || '', type: t.aerialway, pts });
      continue;
    }
    if (t['piste:type'] !== 'downhill') continue;
    const [name, difficulty, grooming] = runTags(t);
    if (typ === 'way') {
      const pts = wayPts(el);
      if (pts.length < 2) continue;
      pisteWays.add(el.id);
      const closed = pts.length >= 4 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
      if (closed && t.area === 'yes') runs.push({ id: el.id, name, difficulty, area: true, grooming, pts });
      else lin.push({ id: el.id, name, difficulty, grooming, pts, nodes: el.nodes || [] });
    } else if (typ === 'relation') {
      const mems = (el.members || []).filter(m => m.type === 'way' && m.geometry);
      if (t.type === 'multipolygon') {
        const outer = mems.filter(m => m.role === 'outer' || m.role === '' || m.role == null).map(m => m.geometry.map(g => [g.lat, g.lon]));
        stitchRings(outer).forEach((ring, k) => runs.push({
          id: k === 0 ? el.id : el.id * 100 + k, name, difficulty, area: true, grooming, pts: ring.map(p => [r6(p[0]), r6(p[1])]),
        }));
      } else later.push([el, mems]);
    }
  }
  // route relations: members not already returned as piste ways of their own
  for (const [el, mems] of later) {
    const [name, difficulty, grooming] = runTags(el.tags);
    for (const m of mems) {
      if (pisteWays.has(m.ref)) continue;
      pisteWays.add(m.ref);
      lin.push({ id: m.ref, name, difficulty, grooming, pts: m.geometry.map(g => [r6(g.lat), r6(g.lon)]), nodes: [] });
    }
  }
  // join end-to-end ways that share a name and difficulty into one run
  const ends = w => (w.nodes.length ? [String(w.nodes[0]), String(w.nodes[w.nodes.length - 1])] : [w.pts[0].join(), w.pts[w.pts.length - 1].join()]);
  const flip = w => ({ ...w, pts: w.pts.slice().reverse(), nodes: w.nodes.slice().reverse() });
  const groups = new Map(), outLin = [];
  for (const w of lin) {
    if (!w.name) { outLin.push(w); continue; }
    const k = `${w.name}\u0000${w.difficulty}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  for (let ws of groups.values()) {
    for (let changed = true; changed;) {
      changed = false;
      search: for (let i = 0; i < ws.length; i++) for (let j = 0; j < ws.length; j++) {
        if (i === j) continue;
        let a = ws[i], b = ws[j];
        const ea = ends(a), eb = ends(b);
        if (ea[1] === eb[0]) { /* already head to tail */ }
        else if (ea[1] === eb[1]) b = flip(b);
        else if (ea[0] === eb[1]) [a, b] = [b, a];
        else if (ea[0] === eb[0]) { b = flip(b); [a, b] = [b, a]; }
        else continue;
        if (ends(a)[1] !== ends(b)[0]) continue;
        const merged = {
          id: ws[Math.min(i, j)].id, name: a.name, difficulty: a.difficulty, grooming: a.grooming || b.grooming,
          pts: a.pts.concat(b.pts.slice(1)), nodes: a.nodes.length && b.nodes.length ? a.nodes.concat(b.nodes.slice(1)) : [],
        };
        ws = ws.filter((_, k) => k !== i && k !== j).concat([merged]);
        changed = true;
        break search;
      }
    }
    outLin.push(...ws);
  }
  for (const w of outLin) {
    let pts = w.pts;
    if (sample(...pts[0]) < sample(...pts[pts.length - 1])) pts = pts.slice().reverse();
    runs.push({ id: w.id, name: w.name, difficulty: w.difficulty, area: false, grooming: w.grooming, pts });
  }
  for (const l of lifts) if (sample(...l.pts[0]) > sample(...l.pts[l.pts.length - 1])) l.pts.reverse();
  runs.sort((a, b) => a.id - b.id);
  lifts.sort((a, b) => a.id - b.id);
  return { resorts: [...resorts.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), lifts, runs, peaks };
}

/** Bilinear elevation lookup on a resampled grid, for buildFeatures. */
export function gridSampler(grid, [w, s, e, n]) {
  const { cols, rows, data } = grid;
  return (lat, lon) => {
    const fr = Math.min(rows - 1.001, Math.max(0, (n - lat) / (n - s) * (rows - 1)));
    const fc = Math.min(cols - 1.001, Math.max(0, (lon - w) / (e - w) * (cols - 1)));
    const r = Math.floor(fr), c = Math.floor(fc), tr = fr - r, tc = fc - c, i = r * cols + c;
    return ((data[i] * (1 - tc) + data[i + 1] * tc) * (1 - tr) + (data[i + cols] * (1 - tc) + data[i + cols + 1] * tc) * tr) * DEM_UNIT;
  };
}

// --------------------------------------------------------------------- build

/** Why a box cannot be built, or null if it can. */
export function checkBbox(bbox) {
  const [kx, ky] = bboxKm(bbox);
  if (!(kx > 0 && ky > 0) || Math.abs(bbox[1]) > 80 || Math.abs(bbox[3]) > 80) return 'Pick an area on the map.';
  if (Math.max(kx, ky) > AREA_MAX_KM) return `Too big: ${kx.toFixed(0)} × ${ky.toFixed(0)} km. Zoom in until it is under ${AREA_MAX_KM} km a side.`;
  if (Math.min(kx, ky) < AREA_MIN_KM) return `Too small: zoom out until it is at least ${AREA_MIN_KM} km a side.`;
  return null;
}

/** Rough download and storage figures for a box, before building it. */
export function estimate(bbox, { fineRes = FINE_RES, coarseRes = COARSE_RES, marginKm = COARSE_MARGIN_KM } = {}) {
  const coarse = expandBbox(bbox, marginKm);
  const [fc, fr] = gridDims(bbox, fineRes), [cc, cr] = gridDims(coarse, coarseRes);
  const tiles = tilesFor(bbox, zoomFor(fineRes, (bbox[1] + bbox[3]) / 2)).list.length
    + tilesFor(coarse, zoomFor(coarseRes, (coarse[1] + coarse[3]) / 2)).list.length;
  return { storeBytes: (fc * fr + cc * cr) * 2 + 400e3, downloadBytes: tiles * 110e3 + 1e6, tiles };
}

/**
 * Download and resample terrain only. spec = {bbox, fineRes, coarseRes, marginKm}
 * (defaults FINE_RES, COARSE_RES, COARSE_MARGIN_KM). progress(fraction 0..1 of the
 * terrain download, message). Resolves to {fine, coarse, fineGrid, coarseGrid}:
 * the two [w, s, e, n] boxes (fine rounded to 5 decimals, coarse = fine expanded by
 * marginKm) and their resampled grids {cols, rows, data: Uint16Array}.
 */
export async function buildTerrain(spec, progress = () => {}, signal) {
  const { fineRes = FINE_RES, coarseRes = COARSE_RES, marginKm = COARSE_MARGIN_KM } = spec;
  const fine = spec.bbox.map(v => Math.round(v * 1e5) / 1e5), coarse = expandBbox(fine, marginKm);
  const total = estimate(fine, { fineRes, coarseRes, marginKm }).tiles;
  let done = 0;
  const onTile = () => progress(++done / total, 'Downloading terrain…');
  progress(0, 'Downloading terrain…');
  const fineGrid = resample(await fetchMosaic(fine, fineRes, onTile, signal), fine, fineRes);
  const coarseGrid = resample(await fetchMosaic(coarse, coarseRes, onTile, signal), coarse, coarseRes);
  return { fine, coarse, fineGrid, coarseGrid };
}

/**
 * Build an area. spec = {id, name, bbox: [w, s, e, n]}; progress(fraction,
 * message) is called as it goes; signal aborts. Resolves to
 * {area, files}: a catalog entry and {fileName: ArrayBuffer}.
 */
export async function buildArea(spec, progress = () => {}, signal) {
  const bad = checkBbox(spec.bbox);
  if (bad) throw new Error(bad);
  const fine = spec.bbox.map(v => Math.round(v * 1e5) / 1e5), coarse = expandBbox(fine, COARSE_MARGIN_KM);
  // lifts and runs travel alongside the terrain; both are needed before anything is kept
  const osm = fetchOverpass(overpassQuery(fine, coarse), signal);
  osm.catch(() => {});                               // reported when awaited below
  // terrain gets the first 90% of the bar; buildTerrain starts synchronously, after the Overpass request
  const { fineGrid, coarseGrid } = await buildTerrain({ bbox: fine }, (f, msg) => progress(0.9 * f, msg), signal);
  progress(0.92, 'Downloading lifts and runs…');
  const features = buildFeatures(await osm, gridSampler(fineGrid, fine), coarse);
  progress(0.97, 'Saving…');
  const built = new Date().toISOString().replace(/\.\d+Z$/, '+00:00');
  const side = (g, b, file) => ({ file, west: b[0], south: b[1], east: b[2], north: b[3], cols: g.cols, rows: g.rows });
  const lat = (fine[1] + fine[3]) / 2, lon = (fine[0] + fine[2]) / 2;
  const centerEle = gridSampler(fineGrid, fine)(lat, lon);
  const pack = {
    id: spec.id, name: spec.name, built, demUnit: DEM_UNIT,
    fine: side(fineGrid, fine, 'dem_fine.bin'), coarse: side(coarseGrid, coarse, 'dem_coarse.bin'),
    features: 'features.json', attribution: ATTRIBUTION,
    declination: Math.round(declination(lat, lon, centerEle / 1000, new Date().getFullYear() + (new Date().getMonth() + 0.5) / 12) * 10) / 10,
  };
  const enc = o => new TextEncoder().encode(JSON.stringify(o)).buffer;
  const files = { 'pack.json': enc(pack), 'dem_fine.bin': fineGrid.data.buffer, 'dem_coarse.bin': coarseGrid.data.buffer, 'features.json': enc(features) };
  const bytes = Object.values(files).reduce((a, b) => a + b.byteLength, 0);
  return {
    area: { id: spec.id, name: spec.name, built, bbox: fine, bytes, files: Object.keys(files), custom: true, lifts: features.lifts.length, runs: features.runs.length },
    files,
  };
}
