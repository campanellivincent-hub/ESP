/**
 * ═══════════════════════════════════════════════════════════
 *  SERVEUR ESP — PONT DE TRANSMISSION EN TEMPS RÉEL
 *  Stack : Node.js + Express + WebSocket (ws)
 *
 *  SÉCURITÉ MAGICIEN :
 *    Chaque route /*/transmit et les WS role=magicien
 *    exigent un header  X-Magicien-Key: <clé personnelle>
 *    Les clés sont définies dans MAGICIEN_KEYS ci-dessous.
 *    Chaque accès est journalisé (IP, identifiant, date).
 *
 *  JOURNAL : GET /admin/log  (header X-Admin-Key requis)
 *
 *  TOURS SSE :
 *    ① Zener      — POST /zener/transmit   · GET /zener/stream
 *    ② Go-Gyō     — POST /gogyo/transmit   · GET /gogyo/stream
 *    ③ Oracle     — POST /oracle/transmit  · GET /oracle/stream
 *    ④ Astro      — POST /astro/transmit   · GET /astro/stream
 *    ⑦ Cadenas    — POST /cadenas/transmit · GET /cadenas/stream
 *
 *  TOURS WebSocket :
 *    ⑤ Magic Draw — ws://.../?role=spectateur|magicien&key=<clé>
 *    ⑥ Atelier    — ws://.../?role=spectateur|magicien&canal=atelier&key=<clé>
 *
 *  Rétro-compatibilité : /transmit et /stream → Zener
 *  GET /health — état global
 * ═══════════════════════════════════════════════════════════
 */

const express  = require('express');
const cors     = require('cors');
const http     = require('http');
const https    = require('https');
const { WebSocketServer } = require('ws');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ════════════════════════════════════════════════════════════
//  GESTION DES CLÉS MAGICIENS
//  Format : { 'clé-secrète': 'Nom Affiché' }
//  → Modifiez cette liste pour ajouter / révoquer des accès.
//  → Vous pouvez aussi passer par la variable d'env MAGICIEN_KEYS_JSON
//    avec un JSON stringifié du même format.
// ════════════════════════════════════════════════════════════

const MAGICIEN_KEYS = process.env.MAGICIEN_KEYS_JSON
  ? JSON.parse(process.env.MAGICIEN_KEYS_JSON)
  : {
      'CLE-ALICE-2025':  'Alice',
      'CLE-BOB-2025':    'Bob',
      'CLE-CHARLIE-2025':'Charlie',
      // Ajoutez autant de clés que nécessaire
    };

// Clé admin pour consulter le journal
const ADMIN_KEY = process.env.ADMIN_KEY || 'MON-MOT-DE-PASSE-ADMIN';

// ════════════════════════════════════════════════════════════
//  JOURNAL DES ACCÈS (stocké en RAM, max 500 entrées)
// ════════════════════════════════════════════════════════════

const accessLog = [];
const MAX_LOG   = 500;

function logAccess({ name, key, ip, route, canal }) {
  const entry = {
    ts:    new Date().toISOString(),
    name:  name || '?',
    key:   key  || '?',
    ip:    ip   || '?',
    route: route || '?',
    canal: canal || null,
  };
  accessLog.unshift(entry);
  if (accessLog.length > MAX_LOG) accessLog.length = MAX_LOG;
  console.log(`[ACCÈS] ${entry.ts} | ${entry.name} (${entry.ip}) → ${entry.route}`);
}

// ════════════════════════════════════════════════════════════
//  MIDDLEWARE D'AUTHENTIFICATION MAGICIEN (HTTP)
//  Lit X-Magicien-Key dans le header ou "key" dans le body.
// ════════════════════════════════════════════════════════════

function authMagicien(req, res, next) {
  const key  = req.headers['x-magicien-key'] || req.body?.key || '';
  const name = MAGICIEN_KEYS[key];
  if (!name) {
    console.warn(`[AUTH] Clé refusée : "${key}" depuis ${req.ip}`);
    return res.status(401).json({ error: 'Clé magicien invalide ou absente.' });
  }
  req.magicienName = name;
  req.magicienKey  = key;
  logAccess({ name, key, ip: req.ip, route: req.path });
  next();
}

// ════════════════════════════════════════════════════════════
//  ENDPOINT ADMIN — journal des accès
// ════════════════════════════════════════════════════════════

app.get('/admin/log', (req, res) => {
  const key = req.headers['x-admin-key'] || req.query.key || '';
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Accès refusé.' });
  }
  res.json({
    total:   accessLog.length,
    entries: accessLog,
  });
});

// ════════════════════════════════════════════════════════════
//  PARTIE SSE
// ════════════════════════════════════════════════════════════

const SYMBOL_TTL = 60_000;

function createChannel(validSymbols, label) {
  let lastSymbol = null;
  const clients  = new Set();

  function transmit(req, res) {
    const { symbol, n, day, month, year } = req.body;
    if (!symbol || !validSymbols.includes(symbol)) {
      return res.status(400).json({ error: 'Symbole invalide' });
    }
    lastSymbol = {
      symbol, n: Number(n) || 0, timestamp: Date.now(),
      day: day || null, month: month || null, year: year || null
    };
    console.log(`[${label}] ▶ ${symbol} par ${req.magicienName} — ${clients.size} client(s)`);
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
    console.log(`[${label}] + spectateur connecté. Total : ${clients.size}`);

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
      console.log(`[${label}] - spectateur déconnecté. Total : ${clients.size}`);
    });
  }

  function latest(_req, res) {
    res.json(lastSymbol ?? { symbol: null, n: null });
  }

  return { transmit, stream, latest };
}

// ── Tour ① : Zener ──────────────────────────────────────────
const zener = createChannel(
  ['cercle', 'croix', 'vagues', 'carre', 'etoile'], 'ZENER'
);
app.post('/zener/transmit', authMagicien, zener.transmit);
app.get('/zener/stream',    zener.stream);
app.get('/zener/latest',    zener.latest);
// Rétro-compatibilité
app.post('/transmit', authMagicien, zener.transmit);
app.get('/stream',    zener.stream);
app.get('/latest',    zener.latest);

// ── Tour ② : Go-Gyō ─────────────────────────────────────────
const gogyo = createChannel(
  ['bois', 'feu', 'terre', 'metal', 'eau'], 'GO-GYŌ'
);
app.post('/gogyo/transmit', authMagicien, gogyo.transmit);
app.get('/gogyo/stream',    gogyo.stream);
app.get('/gogyo/latest',    gogyo.latest);

// ── Tour ③ : Oracle ─────────────────────────────────────────
{
  const ORACLE_VALID  = ['bois', 'feu', 'terre', 'metal', 'eau'];
  const ORACLE_TTL    = 10 * 60_000;
  let   lastOracle    = null;
  const oracleClients = new Set();

  app.post('/oracle/transmit', authMagicien, (req, res) => {
    const { symbol, token } = req.body;
    if (!symbol || !ORACLE_VALID.includes(symbol)) {
      return res.status(400).json({ error: 'Symbole invalide' });
    }
    lastOracle = { symbol, timestamp: Date.now(), token: token || null };
    console.log(`[ORACLE] ▶ ${symbol} par ${req.magicienName} — ${oracleClients.size} client(s)`);
    const payload = JSON.stringify(lastOracle);
    for (const client of oracleClients) {
      try { client.write(`data: ${payload}\n\n`); }
      catch (_) { oracleClients.delete(client); }
    }
    res.status(204).end();
  });

  app.get('/oracle/stream', (req, res) => {
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    oracleClients.add(res);
    console.log(`[ORACLE] + connecté. Total : ${oracleClients.size}`);
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); }
      catch (_) { clearInterval(hb); }
    }, 25000);
    req.on('close', () => {
      clearInterval(hb);
      oracleClients.delete(res);
      console.log(`[ORACLE] - déconnecté. Total : ${oracleClients.size}`);
    });
  });

  app.get('/oracle/latest', (_req, res) => {
    if (lastOracle && (Date.now() - lastOracle.timestamp) < ORACLE_TTL) {
      res.json(lastOracle);
    } else {
      res.json({ symbol: null });
    }
  });
}

// ── Tour ④ : Astro ───────────────────────────────────────────
const astro = createChannel(
  ['belier','taureau','gemeaux','cancer','lion','vierge',
   'balance','scorpion','sagittaire','capricorne','verseau','poissons'],
  'ASTRO'
);
app.post('/astro/transmit', authMagicien, astro.transmit);
app.get('/astro/stream',    astro.stream);
app.get('/astro/latest',    astro.latest);

// ── Tour ⑦ : Cadenas ─────────────────────────────────────────
{
  const CADENAS_TTL = 5 * 60_000;
  let   lastCode    = null;
  const cadeClients = new Set();

  app.post('/cadenas/transmit', authMagicien, (req, res) => {
    const { code } = req.body;
    if (!code || !/^\d{4}$/.test(code)) {
      return res.status(400).json({ error: 'Code invalide (4 chiffres requis)' });
    }
    lastCode = { code, timestamp: Date.now() };
    console.log(`[CADENAS] ▶ ${code} par ${req.magicienName} — ${cadeClients.size} client(s)`);
    const payload = JSON.stringify(lastCode);
    for (const client of cadeClients) {
      try { client.write(`data: ${payload}\n\n`); }
      catch (_) { cadeClients.delete(client); }
    }
    res.status(204).end();
  });

  app.get('/cadenas/stream', (req, res) => {
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    cadeClients.add(res);
    console.log(`[CADENAS] + connecté. Total : ${cadeClients.size}`);
    if (lastCode && (Date.now() - lastCode.timestamp) < CADENAS_TTL) {
      res.write(`data: ${JSON.stringify(lastCode)}\n\n`);
    }
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); }
      catch (_) { clearInterval(hb); }
    }, 25000);
    req.on('close', () => {
      clearInterval(hb);
      cadeClients.delete(res);
      console.log(`[CADENAS] - déconnecté. Total : ${cadeClients.size}`);
    });
  });

  app.get('/cadenas/latest', (_req, res) => {
    if (lastCode && (Date.now() - lastCode.timestamp) < CADENAS_TTL) {
      res.json(lastCode);
    } else {
      res.json({ code: null });
    }
  });
}

// ── Santé ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()) + 's',
    tours:  ['zener', 'gogyo', 'oracle', 'astro', 'draw', 'atelier', 'cadenas'],
  });
});

// ════════════════════════════════════════════════════════════
//  PARTIE WEBSOCKET (Magic Draw + Atelier)
//  Authentification : ?role=magicien&key=<clé>
// ════════════════════════════════════════════════════════════

const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || '';
const PUSHOVER_USER  = process.env.PUSHOVER_USER  || '';

let drawSpectateur    = null;
let drawMagicien      = null;
let atelierSpectateur = null;
let atelierMagicien   = null;

wss.on('connection', (ws, req) => {
  const url   = new URL(req.url, 'http://localhost');
  const role  = url.searchParams.get('role');
  const canal = url.searchParams.get('canal');
  const key   = url.searchParams.get('key') || '';
  const ip    = req.socket.remoteAddress || '?';

  // Vérification de la clé pour le rôle magicien
  if (role === 'magicien') {
    const name = MAGICIEN_KEYS[key];
    if (!name) {
      console.warn(`[WS AUTH] Clé WS refusée : "${key}" depuis ${ip}`);
      ws.send(JSON.stringify({ type: 'error', message: 'Clé magicien invalide.' }));
      ws.close(4001, 'Unauthorized');
      return;
    }
    logAccess({ name, key, ip, route: `WS canal=${canal || 'draw'}`, canal: canal || 'draw' });
    ws.magicienName = name;
    console.log(`[WS] Magicien "${name}" connecté — canal=${canal || 'draw'}`);
  } else {
    console.log(`[WS] Spectateur connecté — canal=${canal || 'draw'}`);
  }

  // ── Canal Atelier ──────────────────────────────────────────
  if (canal === 'atelier') {
    if (role === 'spectateur') {
      atelierSpectateur = ws;
      ws.send(JSON.stringify({ type: 'ready' }));
      if (atelierMagicien?.readyState === 1)
        atelierMagicien.send(JSON.stringify({ type: 'ready' }));

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (atelierMagicien?.readyState === 1)
            atelierMagicien.send(data.toString());
          if (msg.type === 'final' && PUSHOVER_TOKEN && PUSHOVER_USER)
            sendPushoverImage(msg.imageData);
        } catch(e) { console.error('[ATELIER] Parse error', e); }
      });

      ws.on('close', () => {
        atelierSpectateur = null;
        if (atelierMagicien?.readyState === 1)
          atelierMagicien.send(JSON.stringify({ type: 'spectateur_disconnected' }));
      });

    } else if (role === 'magicien') {
      atelierMagicien = ws;
      ws.send(JSON.stringify({ type: 'magicien_ready' }));
      if (atelierSpectateur?.readyState === 1)
        ws.send(JSON.stringify({ type: 'ready' }));

      ws.on('close', () => { atelierMagicien = null; });
    }
    return;
  }

  // ── Canal Magic Draw (défaut) ──────────────────────────────
  if (role === 'spectateur') {
    drawSpectateur = ws;
    ws.send(JSON.stringify({ type: 'ready' }));
    if (drawMagicien?.readyState === 1)
      drawMagicien.send(JSON.stringify({ type: 'ready' }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (drawMagicien?.readyState === 1)
          drawMagicien.send(data.toString());
        if (msg.type === 'final' && PUSHOVER_TOKEN && PUSHOVER_USER)
          sendPushoverImage(msg.imageData);
      } catch(e) { console.error('[DRAW] Parse error', e); }
    });

    ws.on('close', () => {
      drawSpectateur = null;
      if (drawMagicien?.readyState === 1)
        drawMagicien.send(JSON.stringify({ type: 'spectateur_disconnected' }));
    });

  } else if (role === 'magicien') {
    drawMagicien = ws;
    ws.send(JSON.stringify({ type: 'magicien_ready' }));
    if (drawSpectateur?.readyState === 1)
      ws.send(JSON.stringify({ type: 'ready' }));

    ws.on('close', () => { drawMagicien = null; });
  }
});

// ── Pushover ──────────────────────────────────────────────────
function sendPushoverImage(base64Data) {
  const imageBuffer = Buffer.from(
    base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64'
  );
  const boundary = '----Boundary' + Math.random().toString(36).slice(2);
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${PUSHOVER_TOKEN}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="user"\r\n\r\n${PUSHOVER_USER}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\nNouveau dessin !`,
    `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n🎩 ESP Draw`,
    `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="drawing.png"\r\nContent-Type: image/png\r\n\r\n`,
  ];
  const header = Buffer.from(parts.join('\r\n') + '\r\n');
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body   = Buffer.concat([header, imageBuffer, footer]);

  const reqP = https.request({
    hostname: 'api.pushover.net', path: '/1/messages.json', method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    }
  }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => console.log('[PUSHOVER]', d)); });
  reqP.on('error', e => console.error('[PUSHOVER ERROR]', e));
  reqP.write(body); reqP.end();
}

// ════════════════════════════════════════════════════════════
//  DÉMARRAGE
// ════════════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`\n🎩  Serveur ESP prêt — port ${PORT}`);
  console.log(`    SSE : Zener · Go-Gyō · Oracle · Astro`);
  console.log(`    WS  : Draw (?role=&key=) · Atelier (?role=&canal=atelier&key=)`);
  console.log(`    Admin log : GET /admin/log  (header X-Admin-Key)\n`);
  console.log(`    Magiciens enregistrés : ${Object.values(MAGICIEN_KEYS).join(', ')}\n`);
});
