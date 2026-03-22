/**
 * ═══════════════════════════════════════════════════════════
 * SERVEUR ESP — PONT DE TRANSMISSION EN TEMPS RÉEL
 * Stack : Node.js + Express + WebSocket (ws) + Auth JWT
 * Persistance : Redis (Railway)
 * ═══════════════════════════════════════════════════════════
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const redis = require('redis');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'esp-top-secret-key-2024';
const startTime = Date.now();

// ════════════════════════════════════════════════════════════
//  CONFIGURATION CORS
// ════════════════════════════════════════════════════════════
const allowedOrigins = [
  'https://espadministrateur.netlify.app',
  'https://espmagicien.netlify.app',
  'https://esphistorique.netlify.app',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Bloqué par CORS : Origine non autorisée'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

// ════════════════════════════════════════════════════════════
//  SERVICE WORKER — servi avec les bons headers
//  (doit être à la racine du scope de l'app magicien)
// ════════════════════════════════════════════════════════════
const path = require('path');
const fs   = require('fs');

app.get('/esp-sw.js', (req, res) => {
  const swPath = path.join(__dirname, 'esp-sw.js');
  if (!fs.existsSync(swPath)) {
    return res.status(404).send('Service worker not found');
  }
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(swPath);
});

// ════════════════════════════════════════════════════════════
//  REDIS & ÉTAT GLOBAL
// ════════════════════════════════════════════════════════════
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => console.error('Redis Error:', err));

let users        = [];
let activeStreams = new Map();      // Map<tour, Map<clientId, res>>  — broadcast legacy
let userStreams   = new Map();      // Map<userId, Map<clientId, res>> — canal privé magicien

// Sessions actives en mémoire : Map<sessionId, sessionObj>
const sessions = new Map();

// Historique des transmissions (en mémoire, 200 max)
const transmissions = [];

// ════════════════════════════════════════════════════════════
//  MIDDLEWARES D'AUTHENTIFICATION
// ════════════════════════════════════════════════════════════
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token manquant' });
  const token = authHeader.split(' ')[1];
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token invalide' });
    req.user = user;
    next();
  });
};

const isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') next();
  else res.status(403).json({ error: 'Accès administrateur requis' });
};

// ════════════════════════════════════════════════════════════
//  GESTION DES UTILISATEURS (REDIS)
// ════════════════════════════════════════════════════════════
async function loadUsers() {
  const data = await redisClient.get('esp_users');
  return data ? JSON.parse(data) : [];
}

async function saveUsers(newUsers) {
  users = newUsers;
  await redisClient.set('esp_users', JSON.stringify(users));
}

// ════════════════════════════════════════════════════════════
//  HELPERS SESSIONS
// ════════════════════════════════════════════════════════════
function getDeviceInfo(req) {
  const ua = req.headers['user-agent'] || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac/i.test(ua)) return 'Mac';
  return 'Inconnu';
}

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '—';
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}j`;
}

// ════════════════════════════════════════════════════════════
//  ROUTES API — AUTH
// ════════════════════════════════════════════════════════════

// Connexion
app.post('/auth/login', async (req, res) => {
  const { username, password, deviceInfo } = req.body;
  const user = users.find(u => u.username === username && u.password === password);

  if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });
  if (user.active === false) return res.status(403).json({ error: 'Compte désactivé' });

  // Détection connexion multiple
  const existingSessions = [...sessions.values()].filter(s => s.userId === user.id);
  if (existingSessions.length > 0) {
    broadcastToAdmins({
      type: 'duplicate_login',
      data: {
        name: user.name || user.username,
        username: user.username,
        existingCount: existingSessions.length,
        newDevice: deviceInfo || getDeviceInfo(req)
      },
      timestamp: Date.now()
    });
  }

  // Créer la session
  const sessionId = crypto.randomUUID();
  const sessionObj = {
    sessionId,
    userId:       user.id,
    username:     user.username,
    name:         user.name || user.username,
    role:         user.role,
    ip:           getIP(req),
    deviceInfo:   deviceInfo || getDeviceInfo(req),
    channel:      null,
    connectedAt:  Date.now(),
    lastActivity: Date.now()
  };
  sessions.set(sessionId, sessionObj);

  // Mettre à jour lastLogin de l'utilisateur
  user.lastLogin = Date.now();
  await saveUsers(users);

  broadcastToAdmins({ type: 'session_created', data: sessionObj, timestamp: Date.now() });

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, sessionId },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.json({ token, user: { id: user.id, username: user.username, name: user.name || user.username, role: user.role } });
});

// Vérification du token
app.get('/auth/me', authenticate, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  // Mettre à jour lastActivity de la session
  if (req.user.sessionId && sessions.has(req.user.sessionId)) {
    sessions.get(req.user.sessionId).lastActivity = Date.now();
  }
  res.json({ id: user.id, username: user.username, name: user.name || user.username, role: user.role });
});

// Mise à jour du compte par le magicien lui-même
app.post('/auth/update', authenticate, async (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const { username, password } = req.body;

  if (username && username !== user.username) {
    if (users.find(u => u.username === username)) {
      return res.status(400).json({ error: 'Cet identifiant est déjà utilisé' });
    }
    user.username = username;
  }

  if (password && password.trim() !== '') {
    user.password = password;
  }

  await saveUsers(users);
  broadcastToAdmins({ type: 'user_updated', data: user, timestamp: Date.now() });
  res.json({ success: true, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

// ════════════════════════════════════════════════════════════
//  ROUTES API — ADMIN USERS
// ════════════════════════════════════════════════════════════

app.get('/admin/users', authenticate, isAdmin, (req, res) => {
  res.json(users);
});

app.post('/admin/users', authenticate, isAdmin, async (req, res) => {
  const { name, username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username et password requis' });
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Cet utilisateur existe déjà' });

  // Générer un roomId court (8 hex chars) et un qrToken unique
  const roomId   = crypto.randomBytes(4).toString('hex');          // ex: "a3f9c21b"
  const qrToken  = crypto.randomBytes(16).toString('hex');         // token opaque pour l'URL QR

  const newUser = {
    id: crypto.randomUUID(),
    name: name || username,
    username, password,
    role: role || 'magicien',
    active: true,
    createdAt: Date.now(),
    roomId,
    qrToken
  };
  users.push(newUser);
  await saveUsers(users);
  broadcastToAdmins({ type: 'user_created', data: newUser, timestamp: Date.now() });
  res.status(201).json(newUser);
});

app.patch('/admin/users/:id', authenticate, isAdmin, async (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const { name, password, active } = req.body;
  if (name     !== undefined) user.name   = name;
  if (password !== undefined && password !== '') user.password = password;
  if (active   !== undefined) user.active = active;

  await saveUsers(users);
  broadcastToAdmins({ type: 'user_updated', data: user, timestamp: Date.now() });
  res.json({ success: true, user });
});

app.delete('/admin/users/:id', authenticate, isAdmin, async (req, res) => {
  const newUsers = users.filter(u => u.id !== req.params.id);
  await saveUsers(newUsers);
  broadcastToAdmins({ type: 'user_deleted', data: { id: req.params.id }, timestamp: Date.now() });
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════
//  ROUTES API — ADMIN SESSIONS
// ════════════════════════════════════════════════════════════

app.get('/admin/sessions', authenticate, isAdmin, (req, res) => {
  res.json([...sessions.values()]);
});

app.delete('/admin/sessions/:id', authenticate, isAdmin, (req, res) => {
  const sid = req.params.id;
  if (!sessions.has(sid)) return res.status(404).json({ error: 'Session introuvable' });
  const s = sessions.get(sid);
  sessions.delete(sid);
  broadcastToAdmins({ type: 'session_removed', data: s, timestamp: Date.now() });
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════
//  ROUTES API — ADMIN STATS
// ════════════════════════════════════════════════════════════

app.get('/admin/stats', authenticate, isAdmin, (req, res) => {
  const now = Date.now();
  const last24h = transmissions.filter(t => now - t.timestamp < 86_400_000).length;
  const lastHour = transmissions.filter(t => now - t.timestamp < 3_600_000).length;

  const byChannel = {};
  transmissions.forEach(t => {
    const ch = t.tour || t.channel || 'zener';
    byChannel[ch] = (byChannel[ch] || 0) + 1;
  });

  res.json({
    totalUsers:     users.length,
    activeUsers:    users.filter(u => u.active !== false).length,
    activeSessions: sessions.size,
    uptime:         formatUptime(now - startTime),
    transmissions:  { last24h, lastHour, byChannel }
  });
});

// ════════════════════════════════════════════════════════════
//  ROUTES QR CODE & ROOM
// ════════════════════════════════════════════════════════════

// Page QR imprimable — accessible sans auth (token opaque dans l'URL)
// GET /qr/:qrToken  → renvoie une page HTML avec le QR code
app.get('/qr/:qrToken', (req, res) => {
  const user = users.find(u => u.qrToken === req.params.qrToken);
  if (!user) return res.status(404).send('QR invalide ou expiré');

  const spectatorUrl = `https://${req.get('host')}/room/${user.roomId}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accès invité</title>
<script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#f0f0f0;font-family:Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#fff;border-radius:8px;padding:32px 28px;text-align:center;max-width:280px;width:90%;box-shadow:0 2px 12px rgba(0,0,0,.10)}
  .wifi-icon{font-size:28px;margin-bottom:12px;color:#333}
  .title{font-size:15px;font-weight:700;color:#111;margin-bottom:4px}
  .sub{font-size:12px;color:#888;margin-bottom:20px}
  canvas{display:block;margin:0 auto 18px;border-radius:4px}
  .hint{font-size:11px;color:#aaa;margin-bottom:20px;line-height:1.5}
  .print-btn{background:#111;color:#fff;border:none;border-radius:4px;font-family:Arial,sans-serif;font-size:12px;padding:10px 24px;cursor:pointer;transition:background .2s}
  .print-btn:hover{background:#333}
  @media print{.print-btn{display:none}body{background:#fff}.card{box-shadow:none;border:1px solid #ddd}}
</style>
</head>
<body>
<div class="card">
  <div class="wifi-icon">📶</div>
  <div class="title">Accès invité</div>
  <div class="sub">Scannez pour accéder au site</div>
  <canvas id="qr"></canvas>
  <div class="hint">Pointez l'appareil photo de votre<br>téléphone vers ce code</div>
  <button class="print-btn" onclick="window.print()">Imprimer</button>
</div>
<script>
  QRCode.toCanvas(document.getElementById('qr'), ${JSON.stringify(spectatorUrl)}, {
    width: 180, margin: 2,
    color: { dark: '#111111', light: '#ffffff' }
  });
</script>
</body>
</html>`);
});

// Récupère le qrToken d'un utilisateur (admin seulement)
app.get('/admin/users/:id/qr', authenticate, isAdmin, (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (!user.qrToken) {
    // Migration : générer si absent (anciens comptes)
    user.qrToken = crypto.randomBytes(16).toString('hex');
    user.roomId  = user.roomId || crypto.randomBytes(4).toString('hex');
    saveUsers(users).catch(() => {});
  }
  const qrUrl = `https://${req.get('host')}/qr/${user.qrToken}`;
  res.json({ qrUrl, roomId: user.roomId, name: user.name });
});

// Régénère le QR code (admin seulement) — invalide l'ancien token
app.post('/admin/users/:id/qr/regenerate', authenticate, isAdmin, async (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  user.qrToken = crypto.randomBytes(16).toString('hex');
  user.roomId  = crypto.randomBytes(4).toString('hex');
  await saveUsers(users);
  const qrUrl = `https://${req.get('host')}/qr/${user.qrToken}`;
  res.json({ qrUrl, roomId: user.roomId });
});

// Route room spectateur — redirige vers la page spectateur avec roomId en paramètre
// Permet au QR code de pointer vers une URL stable liée au compte
app.get('/room/:roomId', (req, res) => {
  const user = users.find(u => u.roomId === req.params.roomId);
  if (!user) return res.status(404).send('Room introuvable');
  // On redirige vers la page spectateur déployée sur Netlify,
  // avec le roomId en query param pour identification future
  const spectatorBase = process.env.SPECTATOR_URL || 'https://esphistorique.netlify.app';
  res.redirect(`${spectatorBase}?room=${user.roomId}&for=${encodeURIComponent(user.name)}`);
});


const TOURS = ['zener', 'gogyo', 'oracle', 'astro', 'cadenas'];

TOURS.forEach(tour => {
  app.get(`/${tour}/stream`, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = Date.now() + Math.random();
    if (!activeStreams.has(tour)) activeStreams.set(tour, new Map());
    activeStreams.get(tour).set(clientId, res);

    // Inscrire aussi dans le canal privé de l'utilisateur
    const token = req.query.token;
    let userId = null;
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.id;
        if (decoded.sessionId && sessions.has(decoded.sessionId)) {
          sessions.get(decoded.sessionId).channel = tour;
          sessions.get(decoded.sessionId).lastActivity = Date.now();
          broadcastToAdmins({ type: 'stream_connected', data: { username: decoded.username, channel: tour }, timestamp: Date.now() });
        }
        if (userId) {
          if (!userStreams.has(userId)) userStreams.set(userId, new Map());
          userStreams.get(userId).set(clientId, res);
        }
      } catch(_) {}
    }

    req.on('close', () => {
      activeStreams.get(tour)?.delete(clientId);
      if (userId) userStreams.get(userId)?.delete(clientId);
    });
  });

  app.post(`/${tour}/transmit`, async (req, res) => {
    let magicianName = null;
    let ownerId = null;
    if (req.body.roomId) {
      const owner = users.find(u => u.roomId === req.body.roomId);
      if (owner) { magicianName = owner.name || owner.username; ownerId = owner.id; }
    }
    const data = { ...req.body, tour, timestamp: Date.now() };
    if (magicianName) data.magicianName = magicianName;
    transmissions.unshift(data);
    if (transmissions.length > 200) transmissions.pop();

    const message = `data: ${JSON.stringify(data)}\n\n`;

    // Si un roomId est fourni, envoi ciblé uniquement — jamais de broadcast général
    if (req.body.roomId) {
      if (ownerId && userStreams.has(ownerId) && userStreams.get(ownerId).size > 0) {
        userStreams.get(ownerId).forEach(client => client.write(message));
      }
      // roomId présent mais magicien non connecté → on ne diffuse pas aux autres
    } else if (activeStreams.has(tour)) {
      // Pas de roomId : broadcast au canal (usage sans QR code)
      activeStreams.get(tour).forEach(client => client.write(message));
    }

    broadcastToAdmins({ type: 'transmission', tour, data, timestamp: Date.now() });
    res.json({ success: true });
  });
});

// ════════════════════════════════════════════════════════════
//  ROUTES GÉNÉRIQUES (compatibilité spectateur/magicien)
// ════════════════════════════════════════════════════════════

app.get('/stream', (req, res) => {
  const tour = req.query.tour || 'zener';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now() + Math.random();
  if (!activeStreams.has(tour)) activeStreams.set(tour, new Map());
  activeStreams.get(tour).set(clientId, res);

  let userId = null;
  const token = req.query.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
      if (decoded.sessionId && sessions.has(decoded.sessionId)) {
        sessions.get(decoded.sessionId).channel = tour;
        sessions.get(decoded.sessionId).lastActivity = Date.now();
        broadcastToAdmins({ type: 'stream_connected', data: { username: decoded.username, channel: tour }, timestamp: Date.now() });
      }
      if (userId) {
        if (!userStreams.has(userId)) userStreams.set(userId, new Map());
        userStreams.get(userId).set(clientId, res);
      }
    } catch(_) {}
  }

  req.on('close', () => {
    activeStreams.get(tour)?.delete(clientId);
    if (userId) userStreams.get(userId)?.delete(clientId);
  });
});

app.post('/transmit', async (req, res) => {
  const tour = req.query.tour || req.body.tour || 'zener';

  let magicianName = null;
  let ownerId = null;
  if (req.body.roomId) {
    const owner = users.find(u => u.roomId === req.body.roomId);
    if (owner) { magicianName = owner.name || owner.username; ownerId = owner.id; }
  }

  const data = { ...req.body, tour, timestamp: Date.now() };
  if (magicianName) data.magicianName = magicianName;
  transmissions.unshift(data);
  if (transmissions.length > 200) transmissions.pop();

  const message = `data: ${JSON.stringify(data)}\n\n`;

  // Si un roomId est fourni, envoi ciblé uniquement — jamais de broadcast général
  if (req.body.roomId) {
    if (ownerId && userStreams.has(ownerId) && userStreams.get(ownerId).size > 0) {
      userStreams.get(ownerId).forEach(client => client.write(message));
    }
    // roomId présent mais magicien non connecté → on ne diffuse pas aux autres
  } else if (activeStreams.has(tour)) {
    // Pas de roomId : broadcast au canal (usage sans QR code)
    activeStreams.get(tour).forEach(client => client.write(message));
  }

  broadcastToAdmins({ type: 'transmission', tour, data, timestamp: Date.now() });
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════
//  WEBSOCKET SERVER (Admin)
// ════════════════════════════════════════════════════════════
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url  = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role');
  ws.role = role;

  // Envoyer un snapshot initial à l'admin
  if (role === 'admin') {
    const snapshot = {
      type: 'snapshot',
      data: {
        users,
        sessions:            [...sessions.values()],
        recentTransmissions: transmissions.slice(0, 50)
      },
      timestamp: Date.now()
    };
    ws.send(JSON.stringify(snapshot));
  }

  ws.on('message', (message) => {
    try {
      const payload = JSON.parse(message);
      wss.clients.forEach(client => {
        if (client !== ws && client.readyState === 1) {
          client.send(JSON.stringify(payload));
        }
      });
    } catch(_) {}
  });

  ws.on('close', () => {
    // Nettoyage si besoin
  });
});

function broadcastToAdmins(data) {
  wss.clients.forEach(client => {
    if (client.role === 'admin' && client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}

// ════════════════════════════════════════════════════════════
//  DÉMARRAGE
// ════════════════════════════════════════════════════════════
async function start() {
  try {
    await redisClient.connect();
    users = await loadUsers();
  } catch (err) {
    console.error('Redis indisponible, démarrage sans persistance :', err);
    users = [];
  }

  const adminExists = users.find(u => u.role === 'admin');
  if (!adminExists) {
    const defaultAdmin = {
      id: '1', name: 'Admin', username: 'admin',
      password: 'password123', role: 'admin',
      active: true, createdAt: Date.now()
    };
    users.push(defaultAdmin);
    try { await saveUsers(users); } catch(_) {}
    console.log('Admin par défaut créé');
  }

  server.listen(PORT, () => {
    console.log(`\n🎩  Serveur ESP prêt — port ${PORT}`);
    console.log(`    Routes API & SSE : OK`);
    console.log(`    WebSocket Server : OK`);
  });
}

start();
