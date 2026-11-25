// Garde l'app utilisable hors connexion (réseau d'abord, copie locale si pas de réseau)
var CACHE = 'ma-journee-v15';
var SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    // « mj-reminders » garde les textes des rappels : il survit aux mises à jour
    return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== 'mj-reminders'; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(function (res) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
    return res;
  }).catch(function () { return caches.match(e.request).then(function (r) { return r || caches.match('index.html'); }); }));
});
// Rappels « même app fermée » : le serveur envoie un simple réveil, sans contenu.
// Le texte du rappel est lu ici, sur le téléphone (rangé par l'app dans le cache « mj-reminders »).
self.addEventListener('push', function (e) {
  e.waitUntil(caches.open('mj-reminders').then(function (c) {
    return c.match('/__reminders').then(function (r) { return r ? r.json() : []; }).then(function (list) {
      var now = Date.now();
      var due = list.filter(function (x) { return !x.shown && x.at <= now + 3 * 60 * 1000 && x.at > now - 20 * 60 * 1000; });
      if (!due.length) {
        // Rien de nouveau (rappel déjà affiché, planning changé entre-temps) : chaque réveil doit afficher quelque chose,
        // alors on remet le dernier rappel à sa place, sans bruit, ou un message neutre
        var last = list.filter(function (x) { return x.shown && x.at > now - 30 * 60 * 1000 && x.at <= now + 3 * 60 * 1000; }).pop();
        if (last) return self.registration.showNotification(last.title, { body: last.body, icon: 'icon.svg', tag: last.tag, silent: true });
        return self.registration.showNotification('Ma Journée', { body: 'Ouvre l\'app pour voir la suite de ta journée.', icon: 'icon.svg', tag: 'mj-info', silent: true });
      }
      due.forEach(function (x) { x.shown = true; });
      return Promise.all(due.map(function (x) {
        return self.registration.showNotification(x.title, { body: x.body, icon: 'icon.svg', tag: x.tag, renotify: true });
      })).then(function () {
        return c.put('/__reminders', new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json' } }));
      });
    });
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(function (list) {
    if (list.length) return list[0].focus();
    return self.clients.openWindow('./');
  }));
});
