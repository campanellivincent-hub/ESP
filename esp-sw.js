// ══════════════════════════════════════════════════════════════════
//  ESP SERVICE WORKER
//  - Reçoit les push notifications du serveur (même page fermée)
//  - Vibre selon le symbole reçu
//  - Transmet à la page si elle est ouverte (affichage)
// ══════════════════════════════════════════════════════════════════

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

const SYMBOLS = { cercle: 1, croix: 2, vagues: 3, carre: 4, etoile: 5 };

// ── Push reçu depuis le serveur ───────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch(_) { return; }

  const symbol = payload.symbol;
  const n      = SYMBOLS[symbol] || 0;
  if (!n) return;

  event.waitUntil((async () => {
    // Transmettre à la page si elle est ouverte
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length > 0) {
      clients.forEach(c => c.postMessage({
        type: 'SYMBOL_RECEIVED', symbol, timestamp: payload.timestamp
      }));
    }

    // Vibrer depuis le SW (Android)
    const dur = payload.vibrationMs || 300;
    const pattern = [];
    for (let i = 0; i < n; i++) { pattern.push(dur); if (i < n-1) pattern.push(200); }
    await new Promise(r => setTimeout(r, 700));
    if (self.registration?.vibrate) self.registration.vibrate(pattern);

    // Notification silencieuse et discrète (réveille iOS)
    await self.registration.showNotification(' ', {
      body: ' ', silent: true, tag: 'esp-signal',
      renotify: false, data: { symbol, timestamp: payload.timestamp }
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length > 0) { clients[0].focus(); return; }
      self.clients.openWindow('./');
    })
  );
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'PING' && e.ports?.[0]) e.ports[0].postMessage({ type: 'PONG' });
});
