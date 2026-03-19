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
//  REDIS & ÉTAT GLOBAL
// ════════════════════════════════════════════════════════════
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => console.error('Redis Error:', err));

let users        = [];
let activeStreams = new Map();

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

  const newUser = {
    id: crypto.randomUUID(),
    name: name || username,
    username, password,
    role: role || 'magicien',
    active: true,
    createdAt: Date.now()
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
//  TOURS SSE (Zener, Astro, etc.)
// ════════════════════════════════════════════════════════════
const TOURS = ['zener', 'gogyo', 'oracle', 'astro', 'cadenas'];

TOURS.forEach(tour => {
  app.get(`/${tour}/stream`, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = Date.now();
    if (!activeStreams.has(tour)) activeStreams.set(tour, new Map());
    activeStreams.get(tour).set(clientId, res);

    // Mettre à jour le canal dans la session
    const token = req.query.token;
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.sessionId && sessions.has(decoded.sessionId)) {
          sessions.get(decoded.sessionId).channel = tour;
          sessions.get(decoded.sessionId).lastActivity = Date.now();
          broadcastToAdmins({ type: 'stream_connected', data: { username: decoded.username, channel: tour }, timestamp: Date.now() });
        }
      } catch(_) {}
    }

    req.on('close', () => {
      activeStreams.get(tour).delete(clientId);
    });
  });

  app.post(`/${tour}/transmit`, async (req, res) => {
    const data = { ...req.body, tour, timestamp: Date.now() };
    transmissions.unshift(data);
    if (transmissions.length > 200) transmissions.pop();

    if (activeStreams.has(tour)) {
      const message = `data: ${JSON.stringify(data)}\n\n`;
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

  const clientId = Date.now();
  if (!activeStreams.has(tour)) activeStreams.set(tour, new Map());
  activeStreams.get(tour).set(clientId, res);

  const token = req.query.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.sessionId && sessions.has(decoded.sessionId)) {
        sessions.get(decoded.sessionId).channel = tour;
        sessions.get(decoded.sessionId).lastActivity = Date.now();
        broadcastToAdmins({ type: 'stream_connected', data: { username: decoded.username, channel: tour }, timestamp: Date.now() });
      }
    } catch(_) {}
  }

  req.on('close', () => {
    activeStreams.get(tour).delete(clientId);
  });
});

app.post('/transmit', async (req, res) => {
  const tour = req.query.tour || req.body.tour || 'zener';
  const data = { ...req.body, tour, timestamp: Date.now() };
  transmissions.unshift(data);
  if (transmissions.length > 200) transmissions.pop();

  if (activeStreams.has(tour)) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
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
