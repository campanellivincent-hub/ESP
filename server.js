/**
 * ═══════════════════════════════════════════════════════════
 *  SERVEUR ESP — PONT DE TRANSMISSION EN TEMPS RÉEL
 *  Stack : Node.js + Express (SSE natif, sans dépendance lourde)
 * ═══════════════════════════════════════════════════════════
 *
 *  INSTALLATION :
 *    npm install express cors
 *
 *  LANCEMENT LOCAL :
 *    node server.js
 *    → http://localhost:3000
 *
 *  DÉPLOIEMENT GRATUIT SUR RENDER.COM :
 *    1. Créer compte sur render.com
 *    2. "New Web Service" → connecter votre repo GitHub
 *       (avec server.js + package.json à la racine)
 *    3. Build command : npm install
 *    4. Start command  : node server.js
 *    5. Copier l'URL obtenue (ex: https://mon-projet.onrender.com)
 *    6. Remplacer SERVER_URL dans spectateur.html et magicien.html
 *
 *  ENDPOINTS :
 *    POST /transmit   — spectateur envoie son symbole
 *    GET  /stream     — SSE pour le téléphone du magicien
 *    GET  /latest     — dernier symbole (fallback polling)
 *    GET  /health     — état du serveur
 * ═══════════════════════════════════════════════════════════
 */

const express = require('express');
const cors    = require('cors');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// État partagé
let lastSymbol  = null;
let sseClients  = new Set();

// ── POST /transmit ─────────────────────────────────────────────────────────
app.post('/transmit', (req, res) => {
  const { symbol, n } = req.body;

  if (!symbol) {
    return res.status(400).json({ error: 'Invalide' });
  }

  lastSymbol = { symbol, n: Number(n) || 0, ts: Date.now() };
  console.log(`▶ Reçu : ${symbol} — ${new Date().toLocaleTimeString()}`);

  // Push immédiat vers tous les clients SSE
  const payload = JSON.stringify(lastSymbol);
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (_) {
      sseClients.delete(client);
    }
  }

  res.status(204).end(); // Réponse vide — aucun indice visuel
});

// ── GET /stream — Server-Sent Events ──────────────────────────────────────
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Désactive le buffer Nginx
  res.flushHeaders();

  sseClients.add(res);
  console.log(`+ Magicien connecté. Total : ${sseClients.size}`);

  // Si un symbole a déjà été reçu, l'envoyer immédiatement
  if (lastSymbol) {
    res.write(`data: ${JSON.stringify(lastSymbol)}\n\n`);
  }

  // Heartbeat toutes les 25s pour éviter le timeout Render/Cloudflare
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); }
    catch (_) { clearInterval(hb); }
  }, 25000);

  req.on('close', () => {
    clearInterval(hb);
    sseClients.delete(res);
    console.log(`- Magicien déconnecté. Total : ${sseClients.size}`);
  });
});

// ── GET /latest — Polling magicien ────────────────────────────────────────
app.get('/latest', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  if (lastSymbol && lastSymbol.ts > since) {
    res.json(lastSymbol);
  } else {
    res.json({ symbol: null, ts: lastSymbol?.ts || 0 });
  }
});

// ── GET /health ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:     'ok',
    uptime:     Math.round(process.uptime()) + 's',
    clients:    sseClients.size,
    lastSymbol: lastSymbol?.symbol ?? 'aucun'
  });
});

app.listen(PORT, () => {
  console.log(`\n🎩  Serveur ESP prêt sur le port ${PORT}`);
  console.log(`    Local  : http://localhost:${PORT}/health\n`);
});
