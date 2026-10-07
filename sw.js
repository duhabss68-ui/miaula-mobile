'use strict';
const CACHE='miaula-mobile-2.2.1';
const ASSETS=[
  './','./index.html','./styles.css?v=2.2.1','./db.js?v=2.2.1','./xlsx-lite.js?v=2.2.1','./app.js?v=2.2.1','./manifest.webmanifest?v=2.2.1',
  './assets/miaula_logo.png','./assets/icon-books-192.png?v=2.2.1','./assets/icon-books-512.png?v=2.2.1','./assets/icon-books-maskable-512.png?v=2.2.1'
];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE)
      .then(cache=>cache.addAll(ASSETS))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;

  // Navegaciones: intenta red primero para detectar nuevas versiones.
  // Si no hay internet, conserva funcionamiento offline con la copia local.
  if(req.mode==='navigate'){
    event.respondWith(
      fetch(req,{cache:'no-store'}).then(response=>{
        const copy=response.clone();
        caches.open(CACHE).then(cache=>cache.put('./index.html',copy));
        return response;
      }).catch(()=>caches.match('./index.html').then(r=>r||caches.match('./')))
    );
    return;
  }

  // Archivos versionados: caché primero. Cada release cambia ?v=...
  event.respondWith(
    caches.match(req).then(cached=>cached||fetch(req).then(response=>{
      const copy=response.clone();
      caches.open(CACHE).then(cache=>cache.put(req,copy));
      return response;
    }))
  );
});
