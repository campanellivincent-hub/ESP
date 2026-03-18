/**
 * ═══════════════════════════════════════════════════════════
 *  SERVEUR ESP — PONT DE TRANSMISSION EN TEMPS RÉEL
 *  Stack : Node.js + Express + WebSocket (ws) + Auth JWT
 *  Persistance : Redis (Railway)
 *
 *  AUTH :
 *    POST /auth/register  — création de compte (admin uniquement)
 *    POST /auth/login     — connexion, retourne un JWT
 *    GET  /auth/me        — infos du compte courant
 *
 *  ADMIN :
 *    GET  /admin/users             — liste des comptes
 *    POST /admin/users             — créer un compte
 *    DELETE /admin/users/:id       — supprimer un compte
 *    GET  /admin/sessions          — sessions actives
 *    GET  /admin/stats             — statistiques globales
 *    WS   /?role=admin             — push temps réel vers l'admin
 *
 *  TOURS SSE (protégés par token) :
 *    ① Zener      — POST /zener/transmit   · GET /zener/stream
 *    ② Go-Gyō     — POST /gogyo/transmit   · GET /gogyo/stream
 *    ③ Oracle     — POST /oracle/transmit  · GET /oracle/stream
 *    ④ Astro      — POST /astro/transmit   · GET /astro/stream
 *    ⑦ Cadenas    — POST /cadenas/transmit · GET /cadenas/stream
 *
 *  TOURS WebSocket :
 *    ⑤ Magic Draw — ws://.../?role=spectateur|magicien
 *    ⑥ Atelier    — ws://.../?role=spectateur|magicien&canal=atelier
 *
 *  Rétro-compatibilité : /transmit et /stream → Zener
 *  GET /health — état global
 * ═══════════════════════════════════════════════════════════
 */

const express  = require('express');
const cors     = require('cors');
const http     = require('http');
const https    = require('https');
const crypto   = require('crypto');
const { WebSocketServer } = require('ws');
const { createClient } = require('redis');

const app    = express();
const PORT   = process.env.PORT || 3000;

// ── Secret JWT (env ou généré au démarrage) ──────────────────
const JWT_SECRET   = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'esp-admin-2024';

app.use(cors({ origin: '*' }));
app.use(express.json());

const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ════════════════════════════════════════════════════════════
//  CONNEXION REDIS
// ════════════════════════════════════════════════════════════

const redisClient = createClient({
  url: process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('[REDIS] Erreur:', err.message));
redisClient.on('connect', () => console.log('[REDIS] Connecté ✓'));

// ════════════════════════════════════════════════════════════
//  PERSISTANCE — Redis
// ════════════════════════════════════════════════════════════

const REDIS_USERS_KEY = 'esp:users';

function hashPassword(pwd) {
  return crypto.createHmac('sha256', 'esp-salt-2024').update(pwd).digest('hex');
}

async function loadUsers() {
  try {
    const data = await redisClient.get(REDIS_USERS_KEY);
    if (data) {
      console.log('[USERS] Chargés depuis Redis ✓');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[USERS] Erreur lecture Redis:', e.message);
  }

  // Aucun utilisateur → créer le compte admin par défaut
  const adminId = crypto.randomUUID();
  const admin = {
    [adminId]: {
      id: adminId,
      name: 'Admin',
      username: 'admin',
      passwordHash: hashPassword(ADMIN_SECRET),
      role: 'admin',
      createdAt: Date.now(),
      lastLogin: null,
      totalTransmissions: 0,
      active: true
    }
  };
  await saveUsers(admin);
  console.log(`\n🔑  Compte admin créé — login: admin / mdp: ${ADMIN_SECRET}\n`);
  return admin;
}

async function saveUsers(u) {
  try {
    await redisClient.set(REDIS_USERS_KEY, JSON.stringify(u));
  } catch (e) {
    console.error('[USERS] Erreur sauvegarde Redis:', e.message);
  }
}

// users est initialisé après la connexion Redis (voir bas du fichier)
let users = {};

// ════════════════════════════════════════════════════════════
//  SESSIONS ACTIVES (mémoire)
// ════════════════════════════════════════════════════════════

const activeSessions = new Map();

function createSession(userId, deviceInfo, ip) {
  const sessionId = crypto.randomBytes(16).toString('hex');
  activeSessions.set(sessionId, {
    sessionId,
    userId,
    username: users[userId]?.username || '?',
    name: users[userId]?.name || '?',
    deviceInfo,
    ip,
    connectedAt: Date.now(),
    lastActivity: Date.now(),
    channel: null
  });
  broadcastAdminEvent('session_created', activeSessions.get(sessionId));
  return sessionId;
}

function touchSession(sessionId, channel) {
  const s = activeSessions.get(sessionId);
  if (s) {
    s.lastActivity = Date.now();
    if (channel) s.channel = channel;
    activeSessions.set(sessionId, s);
  }
}

function removeSession(sessionId) {
  const s = activeSessions.get(sessionId);
  if (s) {
    activeSessions.delete(sessionId);
    broadcastAdminEvent('session_removed', { sessionId, userId: s.userId, username: s.username });
  }
}

function getUserSessions(userId) {
  return [...activeSessions.values()].filter(s => s.userId === userId);
}

// ════════════════════════════════════════════════════════════
//  STATISTIQUES
// ════════════════════════════════════════════════════════════

const transmissionLog = [];
const MAX_LOG = 500;

async function logTransmission(userId, channel, symbol) {
  const entry = {
    id: crypto.randomUUID(),
    userId,
    username: users[userId]?.username || '?',
    name: users[userId]?.name || '?',
    channel,
    symbol,
    timestamp: Date.now()
  };
  transmissionLog.unshift(entry);
  if (transmissionLog.length > MAX_LOG) transmissionLog.pop();

  if (users[userId]) {
    users[userId].totalTransmissions = (users[userId].totalTransmissions || 0) + 1;
    users[userId].lastActivity = Date.now();
    await saveUsers(users);
  }
  broadcastAdminEvent('transmission', entry);
  return entry;
}

// ════════════════════════════════════════════════════════════
//  JWT MINIMAL (sans dépendance externe)
// ════════════════════════════════════════════════════════════

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJWT(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now()/1000) }));
  const sig    = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

function verifyJWT(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch (_) { return null; }
}

// ── Middleware auth ──────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Token requis' });
  const payload = verifyJWT(token);
  if (!payload) return res.status(401).json({ error: 'Token invalide ou expiré' });
  const user = users[payload.userId];
  if (!user || !user.active) return res.status(401).json({ error: 'Compte inactif ou supprimé' });
  req.user    = user;
  req.payload = payload;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès admin requis' });
    next();
  });
}

// ════════════════════════════════════════════════════════════
//  ROUTES AUTH
// ════════════════════════════════════════════════════════════

app.post('/auth/login', async (req, res) => {
  const { username, password, deviceInfo } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Champs manquants' });

  const user = Object.values(users).find(u => u.username === username.toLowerCase().trim());
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  if (!user.active) return res.status(401).json({ error: 'Compte désactivé' });

  // Détection doublons — avertit l'admin sans bloquer
  const existingSessions = getUserSessions(user.id);
  if (existingSessions.length > 0) {
    broadcastAdminEvent('duplicate_login', {
      userId: user.id,
      username: user.username,
      name: user.name,
      existingCount: existingSessions.length,
      newDevice: deviceInfo || 'inconnu',
      timestamp: Date.now()
    });
  }

  const ip        = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const sessionId = createSession(user.id, deviceInfo || req.headers['user-agent'] || 'inconnu', ip);

  users[user.id].lastLogin = Date.now();
  await saveUsers(users);

  const token = signJWT({
    userId: user.id,
    username: user.username,
    role: user.role,
    sessionId,
    exp: Math.floor(Date.now()/1000) + (90 * 24 * 3600) // 90 jours
  });

  res.json({
    token,
    sessionId,
    user: { id: user.id, name: user.name, username: user.username, role: user.role }
  });
});

app.post('/auth/logout', requireAuth, (req, res) => {
  if (req.payload.sessionId) removeSession(req.payload.sessionId);
  res.status(204).end();
});

app.get('/auth/me', requireAuth, (req, res) => {
  const { passwordHash, ...safe } = req.user;
  res.json(safe);
});

// ════════════════════════════════════════════════════════════
//  ROUTES ADMIN
// ════════════════════════════════════════════════════════════

app.get('/admin/users', requireAdmin, (_req, res) => {
  const list = Object.values(users).map(({ passwordHash, ...u }) => u);
  res.json(list);
});

app.post('/admin/users', requireAdmin, async (req, res) => {
  const { name, username, password, role } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'Champs manquants' });
  if (Object.values(users).find(u => u.username === username.toLowerCase().trim())) {
    return res.status(409).json({ error: 'Nom d\'utilisateur déjà pris' });
  }
  const id = crypto.randomUUID();
  users[id] = {
    id, name,
    username: username.toLowerCase().trim(),
    passwordHash: hashPassword(password),
    role: role === 'admin' ? 'admin' : 'magicien',
    createdAt: Date.now(),
    lastLogin: null,
    lastActivity: null,
    totalTransmissions: 0,
    active: true
  };
  await saveUsers(users);
  broadcastAdminEvent('user_created', { id, name, username: users[id].username, role: users[id].role });
  const { passwordHash, ...safe } = users[id];
  res.status(201).json(safe);
});

app.patch('/admin/users/:id', requireAdmin, async (req, res) => {
  const user = users[req.params.id];
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const { name, password, active, role } = req.body;
  if (name   !== undefined) user.name   = name;
  if (active !== undefined) user.active = !!active;
  if (role   !== undefined) user.role   = role === 'admin' ? 'admin' : 'magicien';
  if (password)             user.passwordHash = hashPassword(password);
  await saveUsers(users);
  if (active === false) {
    for (const [sid, s] of activeSessions) {
      if (s.userId === req.params.id) removeSession(sid);
    }
  }
  broadcastAdminEvent('user_updated', { id: user.id, name: user.name, active: user.active, role: user.role });
  const { passwordHash, ...safe } = user;
  res.json(safe);
});

app.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  if (!users[req.params.id]) return res.status(404).json({ error: 'Introuvable' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Impossible de se supprimer soi-même' });
  const username = users[req.params.id].username;
  delete users[req.params.id];
  await saveUsers(users);
  for (const [sid, s] of activeSessions) {
    if (s.userId === req.params.id) removeSession(sid);
  }
  broadcastAdminEvent('user_deleted', { id: req.params.id, username });
  res.status(204).end();
});

app.get('/admin/sessions', requireAdmin, (_req, res) => {
  res.json([...activeSessions.values()]);
});

app.delete('/admin/sessions/:id', requireAdmin, (req, res) => {
  if (!activeSessions.has(req.params.id)) return res.status(404).json({ error: 'Session introuvable' });
  removeSession(req.params.id);
  res.status(204).end();
});

app.get('/admin/stats', requireAdmin, (_req, res) => {
  const now  = Date.now();
  const h    = 3600_000;
  res.json({
    totalUsers:          Object.keys(users).length,
    activeUsers:         Object.values(users).filter(u => u.active).length,
    activeSessions:      activeSessions.size,
    transmissions: {
      total:             transmissionLog.length,
      lastHour:          transmissionLog.filter(t => now - t.timestamp < h).length,
      last24h:           transmissionLog.filter(t => now - t.timestamp < 24 * h).length,
      byChannel:         transmissionLog.reduce((acc, t) => {
        acc[t.channel] = (acc[t.channel] || 0) + 1; return acc;
      }, {}),
      byUser:            transmissionLog.reduce((acc, t) => {
        acc[t.username] = (acc[t.username] || 0) + 1; return acc;
      }, {}),
    },
    recentTransmissions: transmissionLog.slice(0, 30),
    uptime:              Math.round(process.uptime()) + 's'
  });
});

// ════════════════════════════════════════════════════════════
//  BROADCAST ADMIN (WebSocket)
// ════════════════════════════════════════════════════════════

const adminClients = new Set();

function broadcastAdminEvent(type, data) {
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const ws of adminClients) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch (_) { adminClients.delete(ws); }
    }
  }
}

// ════════════════════════════════════════════════════════════
//  PARTIE SSE
// ════════════════════════════════════════════════════════════

const SYMBOL_TTL = 60_000;

function createChannel(validSymbols, label) {
  let lastSymbol = null;
  const clients  = new Set();

  async function transmit(req, res) {
    const { symbol, n, day, month, year } = req.body;
    if (!symbol || !validSymbols.includes(symbol)) {
      return res.status(400).json({ error: 'Symbole invalide' });
    }

    let userId = null;
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (token) {
      const payload = verifyJWT(token);
      if (payload) {
        userId = payload.userId;
        touchSession(payload.sessionId, label);
      }
    }

    lastSymbol = { symbol, n: Number(n) || 0, timestamp: Date.now(), day: day||null, month: month||null, year: year||null };

    if (userId) {
      await logTransmission(userId, label, symbol);
    } else {
      broadcastAdminEvent('transmission', { channel: label, symbol, timestamp: Date.now(), userId: null, username: 'spectateur' });
    }

    console.log(`[${label}] ▶ ${symbol} — ${clients.size} client(s)`);
    const p = JSON.stringify(lastSymbol);
    for (const client of clients) {
      try { client.write(`data: ${p}\n\n`); } catch (_) { clients.delete(client); }
    }
    res.status(204).end();
  }

  function stream(req, res) {
    const token = req.query.token;
    if (token) {
      const payload = verifyJWT(token);
      if (payload) {
        touchSession(payload.sessionId, label);
        broadcastAdminEvent('stream_connected', { userId: payload.userId, username: payload.username, channel: label, timestamp: Date.now() });
      }
    }

    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    clients.add(res);
    console.log(`[${label}] + connecté. Total : ${clients.size}`);

    if (lastSymbol && (Date.now() - lastSymbol.timestamp) < SYMBOL_TTL) {
      res.write(`data: ${JSON.stringify(lastSymbol)}\n\n`);
    }

    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) { clearInterval(hb); }
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

// ── Tour ① : Zener ──────────────────────────────────────────
const zener = createChannel(['cercle', 'croix', 'vagues', 'carre', 'etoile'], 'ZENER');
app.post('/zener/transmit', zener.transmit);
app.get('/zener/stream',    zener.stream);
app.get('/zener/latest',    zener.latest);
app.post('/transmit', zener.transmit);
app.get('/stream',    zener.stream);
app.get('/latest',    zener.latest);

// ── Tour ② : Go-Gyō ─────────────────────────────────────────
const gogyo = createChannel(['bois', 'feu', 'terre', 'metal', 'eau'], 'GO-GYŌ');
app.post('/gogyo/transmit', gogyo.transmit);
app.get('/gogyo/stream',    gogyo.stream);
app.get('/gogyo/latest',    gogyo.latest);

// ── Tour ③ : Oracle ─────────────────────────────────────────
{
  const ORACLE_VALID  = ['bois', 'feu', 'terre', 'metal', 'eau'];
  const ORACLE_TTL    = 10 * 60_000;
  let   lastOracle    = null;
  const oracleClients = new Set();

  app.post('/oracle/transmit', (req, res) => {
    const { symbol, token: oToken } = req.body;
    if (!symbol || !ORACLE_VALID.includes(symbol)) return res.status(400).json({ error: 'Symbole invalide' });
    lastOracle = { symbol, timestamp: Date.now(), token: oToken || null };
    const p = JSON.stringify(lastOracle);
    for (const client of oracleClients) {
      try { client.write(`data: ${p}\n\n`); } catch (_) { oracleClients.delete(client); }
    }
    res.status(204).end();
  });

  app.get('/oracle/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    oracleClients.add(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { clearInterval(hb); } }, 25000);
    req.on('close', () => { clearInterval(hb); oracleClients.delete(res); });
  });

  app.get('/oracle/latest', (_req, res) => {
    if (lastOracle && (Date.now() - lastOracle.timestamp) < ORACLE_TTL) res.json(lastOracle);
    else res.json({ symbol: null });
  });
}

// ── Tour ④ : Astro ───────────────────────────────────────────
const astro = createChannel(
  ['belier','taureau','gemeaux','cancer','lion','vierge','balance','scorpion','sagittaire','capricorne','verseau','poissons'],
  'ASTRO'
);
app.post('/astro/transmit', astro.transmit);
app.get('/astro/stream',    astro.stream);
app.get('/astro/latest',    astro.latest);

// ── Tour ⑦ : Cadenas ─────────────────────────────────────────
{
  const CADENAS_TTL = 5 * 60_000;
  let   lastCode    = null;
  const cadeClients = new Set();

  app.post('/cadenas/transmit', (req, res) => {
    const { code } = req.body;
    if (!code || !/^\d{4}$/.test(code)) return res.status(400).json({ error: 'Code invalide' });
    lastCode = { code, timestamp: Date.now() };
    const p = JSON.stringify(lastCode);
    for (const client of cadeClients) {
      try { client.write(`data: ${p}\n\n`); } catch (_) { cadeClients.delete(client); }
    }
    res.status(204).end();
  });

  app.get('/cadenas/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    cadeClients.add(res);
    if (lastCode && (Date.now() - lastCode.timestamp) < CADENAS_TTL) res.write(`data: ${JSON.stringify(lastCode)}\n\n`);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { clearInterval(hb); } }, 25000);
    req.on('close', () => { clearInterval(hb); cadeClients.delete(res); });
  });

  app.get('/cadenas/latest', (_req, res) => {
    if (lastCode && (Date.now() - lastCode.timestamp) < CADENAS_TTL) res.json(lastCode);
    else res.json({ code: null });
  });
}

// ── Santé ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()) + 's',
    sessions: activeSessions.size,
    redis: redisClient.isOpen ? 'connecté' : 'déconnecté'
  });
});

// ════════════════════════════════════════════════════════════
//  PARTIE WEBSOCKET
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
  const token = url.searchParams.get('token');

  // ── Admin WebSocket ────────────────────────────────────────
  if (role === 'admin') {
    if (!token) { ws.send(JSON.stringify({ type: 'error', message: 'Token requis' })); ws.close(); return; }
    const payload = verifyJWT(token);
    if (!payload || users[payload.userId]?.role !== 'admin') {
      ws.send(JSON.stringify({ type: 'error', message: 'Accès refusé' })); ws.close(); return;
    }
    adminClients.add(ws);
    ws.send(JSON.stringify({
      type: 'snapshot',
      data: {
        sessions: [...activeSessions.values()],
        users: Object.values(users).map(({ passwordHash, ...u }) => u),
        recentTransmissions: transmissionLog.slice(0, 50)
      },
      timestamp: Date.now()
    }));
    ws.on('close', () => adminClients.delete(ws));
    console.log(`[WS-ADMIN] connecté. Total admins: ${adminClients.size}`);
    return;
  }

  console.log(`[WS] role=${role} canal=${canal || 'draw'}`);

  // ── Canal Atelier ──────────────────────────────────────────
  if (canal === 'atelier') {
    if (role === 'spectateur') {
      atelierSpectateur = ws;
      ws.send(JSON.stringify({ type: 'ready' }));
      if (atelierMagicien?.readyState === 1) atelierMagicien.send(JSON.stringify({ type: 'ready' }));
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (atelierMagicien?.readyState === 1) atelierMagicien.send(data.toString());
          if (msg.type === 'final' && PUSHOVER_TOKEN && PUSHOVER_USER) sendPushoverImage(msg.imageData);
        } catch(e) {}
      });
      ws.on('close', () => { atelierSpectateur = null; if (atelierMagicien?.readyState === 1) atelierMagicien.send(JSON.stringify({ type: 'spectateur_disconnected' })); });
    } else if (role === 'magicien') {
      atelierMagicien = ws;
      ws.send(JSON.stringify({ type: 'magicien_ready' }));
      if (atelierSpectateur?.readyState === 1) ws.send(JSON.stringify({ type: 'ready' }));
      ws.on('close', () => { atelierMagicien = null; });
    }
    return;
  }

  // ── Canal Magic Draw (défaut) ──────────────────────────────
  if (role === 'spectateur') {
    drawSpectateur = ws;
    ws.send(JSON.stringify({ type: 'ready' }));
    if (drawMagicien?.readyState === 1) drawMagicien.send(JSON.stringify({ type: 'ready' }));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (drawMagicien?.readyState === 1) drawMagicien.send(data.toString());
        if (msg.type === 'final' && PUSHOVER_TOKEN && PUSHOVER_USER) sendPushoverImage(msg.imageData);
      } catch(e) {}
    });
    ws.on('close', () => { drawSpectateur = null; if (drawMagicien?.readyState === 1) drawMagicien.send(JSON.stringify({ type: 'spectateur_disconnected' })); });
  } else if (role === 'magicien') {
    drawMagicien = ws;
    ws.send(JSON.stringify({ type: 'magicien_ready' }));
    if (drawSpectateur?.readyState === 1) ws.send(JSON.stringify({ type: 'ready' }));
    ws.on('close', () => { drawMagicien = null; });
  }
});

// ── Pushover ──────────────────────────────────────────────────
function sendPushoverImage(base64Data) {
  const imageBuffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
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
  const reqP   = https.request({
    hostname: 'api.pushover.net', path: '/1/messages.json', method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
  }, (r) => { let d=''; r.on('data', c=>d+=c); r.on('end', ()=>console.log('[PUSHOVER]', d)); });
  reqP.on('error', e => console.error('[PUSHOVER ERROR]', e));
  reqP.write(body); reqP.end();
}

// ════════════════════════════════════════════════════════════
//  DÉMARRAGE — Redis d'abord, puis serveur HTTP
// ════════════════════════════════════════════════════════════
async function start() {
  await redisClient.connect();
  users = await loadUsers();

  server.listen(PORT, () => {
    console.log(`\n🎩  Serveur ESP prêt — port ${PORT}`);
    console.log(`    SSE  : Zener · Go-Gyō · Oracle · Astro · Cadenas`);
    console.log(`    WS   : Draw · Atelier · Admin (?role=admin&token=...)`);
    console.log(`    Auth : POST /auth/login · /auth/logout · GET /auth/me`);
    console.log(`    Admin REST : /admin/users · /admin/sessions · /admin/stats`);
    console.log(`    Redis : ${process.env.REDIS_URL ? 'Railway Redis ✓' : 'localhost (dev)'}\n`);
  });
}

start().catch(err => {
  console.error('Erreur démarrage:', err);
  process.exit(1);
});
