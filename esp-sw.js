// ══════════════════════════════════════════════════════════════════
//  ESP SERVICE WORKER — Maintient le SSE en arrière-plan
//  Tourne dans un thread séparé, indépendant de l'état de la page
// ══════════════════════════════════════════════════════════════════

const SW_VERSION = 'esp-sw-v1';

let sseUrl         = null;
let eventSource    = null;
let lastTimestamp  = null;
let connectedPorts = [];   // MessagePorts vers la page principale

// ── Réception des messages de la page ────────────────────────────
self.addEventListener('message', (e) => {
  const { type, payload } = e.data || {};

  // Enregistre le port de communication avec la page
  if (e.ports && e.ports[0]) {
    const port = e.ports[0];
    connectedPorts.push(port);
    port.onmessage = (ev) => handlePortMessage(ev, port);
    port.start();
  }

  if (type === 'START_SSE') {
    sseUrl = payload.url;
    lastTimestamp = null;
    startSSE();
  }

  if (type === 'STOP_SSE') {
    stopSSE();
  }
});

function handlePortMessage(e, port) {
  const { type, payload } = e.data || {};
  if (type === 'START_SSE') {
    sseUrl = payload.url;
    lastTimestamp = null;
    startSSE();
  }
  if (type === 'STOP_SSE') {
    stopSSE();
  }
}

// ── Broadcast vers tous les ports connectés ───────────────────────
function broadcast(msg) {
  connectedPorts = connectedPorts.filter(p => {
    try { p.postMessage(msg); return true; } catch(_) { return false; }
  });
}

// ── Connexion SSE ─────────────────────────────────────────────────
function startSSE() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (!sseUrl) return;

  broadcast({ type: 'SSE_STATUS', status: 'connecting' });

  eventSource = new EventSource(sseUrl);

  eventSource.onopen = () => {
    broadcast({ type: 'SSE_STATUS', status: 'connected' });
  };

  eventSource.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (!d.symbol || !d.timestamp) return;
      const age = Date.now() - d.timestamp;
      if (age > 60_000) return;
      if (d.timestamp === lastTimestamp) return;
      lastTimestamp = d.timestamp;
      // Envoie le symbole reçu à la page
      broadcast({ type: 'SYMBOL_RECEIVED', symbol: d.symbol, timestamp: d.timestamp });
    } catch(_) {}
  };

  eventSource.onerror = () => {
    broadcast({ type: 'SSE_STATUS', status: 'reconnecting' });
    // EventSource se reconnecte automatiquement
  };
}

function stopSSE() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  broadcast({ type: 'SSE_STATUS', status: 'stopped' });
}

// ── Keepalive : ping périodique pour que le SW reste actif ────────
self.addEventListener('activate', () => self.clients.claim());
self.addEventListener('install',  () => self.skipWaiting());
