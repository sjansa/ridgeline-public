// store.js -- map areas ("packs") kept on the device.
//
// A pack is a few files: two elevation grids and the lifts, runs and peaks for
// one area. packs/index.json lists the areas on offer. The first time an area
// is needed its files are downloaded and written to IndexedDB; after that they
// are read from there, so the app works with no signal -- which is the normal
// state of affairs on a mountain. A pack is re-downloaded only when the index
// says it was rebuilt.
//
// Files are looked for next to the page first (a native build bundles its home
// area there) and then on the public site.

const REMOTE = 'https://sjansa.github.io/ridgeline-public/packs/';
const DB = 'ridgeline', STORE = 'files';

function openDb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode), rq = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(rq?.result);
      tx.onerror = tx.onabort = () => rej(tx.error);
    });
  } finally { db.close(); }
}
// Storage can be missing or blocked (private windows); the app then simply
// downloads every time.
const get = key => idb('readonly', s => s.get(key)).catch(() => undefined);
const put = (key, val) => idb('readwrite', s => s.put(val, key)).then(() => true, () => false);

async function fetchFrom(bases, path) {
  let err;
  for (const b of bases) {
    try {
      const r = await fetch(b + path);
      if (r.ok) return r;
      err = new Error(`${path}: ${r.status}`);
    } catch (e) { err = e; }
  }
  throw err;
}

/**
 * The list of areas: [{id, name, built, bytes, bbox: [w, s, e, n], files}],
 * the published ones followed by any the user built on this device
 * (custom: true). Falls back to the saved copy offline.
 */
export async function loadCatalog() {
  const custom = (await get('custom')) || [];
  let list;
  try {
    list = await (await fetchFrom(['packs/', REMOTE], 'index.json')).json();
    put('index', list);
  } catch (e) {
    list = await get('index');
    if (!list && !custom.length) throw new Error('No map list, and none saved on this device. Connect once to download a map.');
  }
  return [...(list || []), ...custom];
}

/** Keep an area built on this device (see build.js): its files and its catalog entry. */
export async function saveBuilt(area, files) {
  for (const [name, buf] of Object.entries(files)) {
    if (!await put(`${area.id}/${name}`, buf)) throw new Error('Could not save the map: the device is out of storage, or storage is blocked.');
  }
  await put(`${area.id}/built`, area.built);
  const custom = ((await get('custom')) || []).filter(a => a.id !== area.id);
  custom.push(area);
  await put('custom', custom);
  try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
}

/** Bytes this app's saved data takes on the device, and the room left, where the browser will say. */
export async function storageUse() {
  try { const e = await navigator.storage.estimate(); return { used: e.usage, quota: e.quota }; } catch { return null; }
}

/** Which areas are already on the device, at the version the catalog lists. */
export async function savedAreas(catalog) {
  const out = {};
  for (const a of catalog) out[a.id] = (await get(`${a.id}/built`)) === a.built;
  return out;
}

export function areaAt(catalog, lat, lon) {
  return catalog.find(a => lon >= a.bbox[0] && lon <= a.bbox[2] && lat >= a.bbox[1] && lat <= a.bbox[3]) || null;
}

/**
 * Readers for one area's files, for loadPack(): from the device when saved,
 * otherwise downloaded (progress(0..1) as bytes arrive) and then saved.
 */
export async function openArea(area, progress) {
  const have = (await get(`${area.id}/built`)) === area.built;
  const bases = [`packs/${area.id}/`, `${REMOTE}${area.id}/`];
  let done = 0;
  const read = async file => {
    const key = `${area.id}/${file}`;
    if (have) { const hit = await get(key); if (hit) return hit; }
    const r = await fetchFrom(bases, file);
    let buf;
    if (r.body && progress) {
      const reader = r.body.getReader(), parts = [];
      let n = 0;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        parts.push(value); n += value.length; done += value.length;
        progress(Math.min(1, done / (area.bytes || 1)));
      }
      const all = new Uint8Array(n);
      let o = 0;
      for (const p of parts) { all.set(p, o); o += p.length; }
      buf = all.buffer;
    } else buf = await r.arrayBuffer();
    await put(key, buf);
    return buf;
  };
  const base = '';
  const fetchBin = name => read(name);
  const fetchJson = async name => JSON.parse(new TextDecoder().decode(await read(name)));
  const finish = async () => {
    if (!have) await put(`${area.id}/built`, area.built);
    try { await navigator.storage?.persist?.(); } catch { /* best effort: ask the browser not to evict the maps */ }
  };
  return { base, fetchBin, fetchJson, finish, saved: have };
}

/** Delete an area's files from the device. One the user built is also taken off the list. */
export async function removeArea(area) {
  await idb('readwrite', s => s.delete(IDBKeyRange.bound(`${area.id}/`, `${area.id}/\uffff`))).catch(() => {});
  if (area.custom) await put('custom', ((await get('custom')) || []).filter(a => a.id !== area.id));
}
