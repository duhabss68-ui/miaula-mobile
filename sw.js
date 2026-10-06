'use strict';
const CACHE='miaula-mobile-2.1.2';
const ASSETS=[
  './','./index.html','./styles.css?v=2.1.2','./db.js?v=2.1.2','./xlsx-lite.js?v=2.1.2','./app.js?v=2.1.2','./manifest.webmanifest?v=2.1.2',
  './assets/miaula_logo.png','./assets/icon-books-192.png?v=2.1.2','./assets/icon-books-512.png?v=2.1.2','./assets/icon-books-maskable-512.png?v=2.1.2'
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
