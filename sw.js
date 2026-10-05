'use strict';
const CACHE='miaula-mobile-2.0.5.1';
const ASSETS=[
  './','./index.html','./styles.css?v=2.0.5.1','./db.js?v=2.0.5.1','./xlsx-lite.js?v=2.0.5.1','./app.js?v=2.0.5.1','./manifest.webmanifest?v=2.0.5.1',
  './assets/miaula_logo.png','./assets/icon-books-192.png?v=2.0.5.1','./assets/icon-books-512.png?v=2.0.5.1','./assets/icon-books-maskable-512.png?v=2.0.5.1'
];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  event.respondWith(
    caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{
      const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));return response;
    }).catch(()=>caches.match('./index.html')))
  );
});
