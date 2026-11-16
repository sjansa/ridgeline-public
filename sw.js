// Service worker: makes the web app installable (Chrome's install criteria
// require one) and keeps the app shell working with no signal.
//
// Network first, cache as the fallback. The app is redeployed often and each
// deploy must reach the phone on the next load; a cache-first worker would pin
// whatever version was installed first. Offline, the last version fetched is
// served instead.
//
// Map packs are not handled here: store.js keeps them in IndexedDB.
const CACHE = "ridgeline-shell-v2";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  // only our own old caches: other apps on this origin keep theirs
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ridgeline-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page lists the files it loaded before this worker was in control.
self.addEventListener("message", (event) => {
  const urls = event.data && event.data.cache;
  if (!Array.isArray(urls)) return;
  event.waitUntil(caches.open(CACHE).then((cache) =>
    Promise.all(urls.map((u) => cache.match(u).then((hit) => hit || cache.add(u).catch(() => {}))))));
});

self.addEventListener("fetch", (event) => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/packs/")) return;
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return res;
    }).catch(async () => {
      // offline: the same file from last time; scripts carry a ?v= stamp that
      // changes per deploy, so match on the path alone
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === "navigate") { const page = await caches.match("./", { ignoreSearch: true }); if (page) return page; }
      return Response.error();
    })
  );
});
