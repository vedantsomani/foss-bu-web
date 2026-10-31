/* Fragline offline cache: game files load from disk after the first visit. */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `fragline-${VERSION}`;
// Large game files are fetched with ?v=<version>, so a cached copy is always the right one.
const VERSIONED = /\.(gz|wad|cfg|js|css)$/;

// Room links (/abcd2345) are all the same page; other pages (credits.html) keep their own entry.
const pageKey = url => (/^\/[a-hjkmnp-z2-9]{8}$/.test(url.pathname) ? '/' : url.pathname);

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) if (key.startsWith('fragline-') && key !== CACHE) await caches.delete(key);
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
    if (url.searchParams.get('v') === VERSION && VERSIONED.test(url.pathname)) {
        event.respondWith(caches.open(CACHE).then(async cache => {
            const hit = await cache.match(event.request);
            if (hit) return hit;
            const response = await fetch(event.request);
            if (response.ok) cache.put(event.request, response.clone());
            return response;
        }));
    } else if (event.request.mode === 'navigate') {
        // Pages: network first so updates arrive, cached copy when offline.
        event.respondWith(fetch(event.request).then(response => {
            if (response.ok) {
                const copy = response.clone();
                caches.open(CACHE).then(cache => cache.put(pageKey(url), copy));
            }
            return response;
        }).catch(async () => (await caches.match(pageKey(url))) || (await caches.match('/')) || Response.error()));
    }
});
