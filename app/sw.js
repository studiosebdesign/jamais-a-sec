// Jamais à sec — fonctionnement hors connexion
// - L'app (écrans, scripts, icônes) : servie depuis le cache, mise à jour en arrière-plan.
// - Les prix (GitHub Pages) : toujours le réseau d'abord ; sans réseau, les derniers prix enregistrés,
//   marqués d'un en-tête « x-jas-cache » pour que l'app affiche le bandeau « Hors connexion ».
// - Les bibliothèques et polices (unpkg, jsdelivr, Google Fonts) : cache d'abord.

const VERSION = 'jas-v8';
const APP = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/calcul.js', 'js/carte.js', 'manifest.webmanifest',
  'icones/icone-192.png', 'icones/icone-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== 'jas-donnees' && k !== 'jas-libs').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Prix : réseau d'abord
  if (url.pathname.includes('/data/') && url.pathname.endsWith('.json')) {
    e.respondWith((async () => {
      const cache = await caches.open('jas-donnees');
      try {
        const rep = await fetch(req, { cache: 'no-store' });
        if (rep.ok) cache.put(req, rep.clone());
        return rep;
      } catch (err) {
        const ancien = await cache.match(req);
        if (!ancien) throw err;
        const h = new Headers(ancien.headers); h.set('x-jas-cache', '1');
        return new Response(await ancien.blob(), { status: 200, headers: h });
      }
    })());
    return;
  }

  // Bibliothèques et polices : cache d'abord
  if (/(unpkg\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) {
    e.respondWith(caches.open('jas-libs').then(async c => {
      const r = await c.match(req);
      if (r) return r;
      const rep = await fetch(req);
      if (rep.ok || rep.type === 'opaque') c.put(req, rep.clone());
      return rep;
    }));
    return;
  }

  // L'app elle-même : cache, puis mise à jour en arrière-plan
  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const r = await c.match(req, { ignoreSearch: true });
      const reseau = fetch(req).then(rep => { if (rep.ok) c.put(req, rep.clone()); return rep; }).catch(() => r);
      return r || reseau;
    }));
  }
});
