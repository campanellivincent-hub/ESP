/**
 * ═══════════════════════════════════════════════════════════
 *  SERVEUR ESP — PONT DE TRANSMISSION EN TEMPS RÉEL
 *  Stack : Node.js + Express (SSE natif, sans dépendance lourde)
 *
 *  TOURS SUPPORTÉS :
 *    ① Zener  — POST /zener/transmit  · GET /zener/stream
 *    ② Go-Gyō — POST /gogyo/transmit  · GET /gogyo/stream
 *
 *  Rétro-compatibilité : /transmit et /stream → Zener
 *
 *  ENDPOINTS COMMUNS :
 *    GET /health  — état global du serveur
 * ═══════════════════════════════════════════════════════════
 */

const express = require('express');
const cors    = require('cors');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

const SYMBOL_TTL = 60_000; // 60 secondes

// ── Canal SSE générique ───────────────────────────────────────────────────
function createChannel(validSymbols, label) {
  let lastSymbol = null;
  const clients  = new Set();

  function transmit(req, res) {
    const { symbol, n } = req.body;
    if (!symbol || !validSymbols.includes(symbol)) {
      return res.status(400).json({ error: 'Symbole invalide' });
    }
    lastSymbol = { symbol, n: Number(n) || 0, timestamp: Date.now() };
    console.log(`[${label}] ▶ ${symbol} — ${clients.size} client(s)`);
    const payload = JSON.stringify(lastSymbol);
    for (const client of clients) {
      try { client.write(`data: ${payload}\n\n`); }
      catch (_) { clients.delete(client); }
    }
    res.status(204).end();
  }

  function stream(req, res) {
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    clients.add(res);
    console.log(`[${label}] + connecté. Total : ${clients.size}`);

    // Envoie le dernier symbole seulement s'il est récent (< 60s)
    if (lastSymbol && (Date.now() - lastSymbol.timestamp) < SYMBOL_TTL) {
      res.write(`data: ${JSON.stringify(lastSymbol)}\n\n`);
    }

    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); }
      catch (_) { clearInterval(hb); }
    }, 25000);

    req.on('close', () => {
      clearInterval(hb);
      clients.delete(res);
      console.log(`[${label}] - déconnecté. Total : ${clients.size}`);
    });
  }

  function latest(_req, res) {
    res.json(lastSymbol ?? { symbol: null, n: null });
  }

  return { transmit, stream, latest };
}

// ── Tour ① : Zener ────────────────────────────────────────────────────────
const zener = createChannel(
  ['cercle', 'croix', 'vagues', 'carre', 'etoile'], 'ZENER'
);
app.post('/zener/transmit', zener.transmit);
app.get('/zener/stream',    zener.stream);
app.get('/zener/latest',    zener.latest);
// Rétro-compatibilité (anciens fichiers)
app.post('/transmit', zener.transmit);
app.get('/stream',    zener.stream);
app.get('/latest',    zener.latest);

// ── Tour ② : Go-Gyō (五行) ───────────────────────────────────────────────
const gogyo = createChannel(
  ['bois', 'feu', 'terre', 'metal', 'eau'], 'GO-GYŌ'
);
app.post('/gogyo/transmit', gogyo.transmit);
app.get('/gogyo/stream',    gogyo.stream);
app.get('/gogyo/latest',    gogyo.latest);

// ── Santé ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) + 's', tours: ['zener', 'gogyo'] });
});

app.listen(PORT, () => {
  console.log(`\n🎩  Serveur ESP prêt — port ${PORT}`);
  console.log(`    Zener  : /zener/transmit · /zener/stream`);
  console.log(`    Go-Gyō : /gogyo/transmit · /gogyo/stream\n`);
});
