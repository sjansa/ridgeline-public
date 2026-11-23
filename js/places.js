// places.js -- spots the user saves (parked car, meeting place, lodge) and
// share links for them. Kept on the phone; a link carries one spot, no server.

export const ICONS = {
  car: { emoji: '🚗', name: 'Car' },
  meet: { emoji: '👋', name: 'Meet-up' },
  lodge: { emoji: '🏠', name: 'Lodge' },
  pin: { emoji: '📍', name: 'Spot' },
};
const KEY = 'ridgeline.places';
const SHARE_BASE = 'https://sjansa.github.io/ridgeline-public/';

export function loadPlaces() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon)) : [];
  } catch { return []; }
}
export function savePlaces(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
}

export function newPlace(lat, lon, name, icon = 'pin') {
  return { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, lat: +lat.toFixed(6), lon: +lon.toFixed(6), name: name || ICONS[icon]?.name || 'Spot', icon: ICONS[icon] ? icon : 'pin', t: Date.now() };
}

/** A link that adds the spot in Ridgeline, and a plain map link for any phone. */
export function shareLinks(p) {
  const q = new URLSearchParams({ spot: `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`, name: p.name, icon: p.icon });
  return {
    app: `${SHARE_BASE}?${q}`,
    map: `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`,
  };
}

/** The spot in a share link (or its query string), or null. */
export function parseShare(text) {
  // a message with the link somewhere in it
  const s0 = String(text ?? '').trim();
  if (/\s/.test(s0)) {
    for (const u of s0.match(/https?:\/\/\S+/g) || []) { const g = parseShare(u); if (g) return g; }
    return null;
  }
  let q;
  try {
    const s = String(text).trim();
    q = new URL(s.includes('://') ? s : `x://x/${s.startsWith('?') ? s : `?${s}`}`).searchParams;
  } catch { return null; }
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(q.get('spot') || '');
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, name: (q.get('name') || 'Shared spot').slice(0, 40), icon: ICONS[q.get('icon')] ? q.get('icon') : 'pin' };
}
