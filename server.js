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

// ════════════════════════════════════════════════════════════
//  CONFIGURATION CORS
// ════════════════════════════════════════════════════════════
const allowedOrigins = [
  'https://espadministrateur.netlify.app',
  'https://espmagicien.netlify.app',
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

// Réponse explicite aux requêtes preflight OPTIONS
app.options('*', cors(corsOptions));

app.use(express.json());

// ════════════════════════════════════════════════════════════
//  REDIS & ÉTAT GLOBAL
// ════════════════════════════════════════════════════════════
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => console.error('Redis Error:', err));

let users = []; // Cache local des utilisateurs synchronisé avec Redis
let activeStreams = new Map(); // Pour les Server-Sent Events (SSE)

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
//  ROUTES API — AUTH & ADMIN
// ════════════════════════════════════════════════════════════

// Connexion
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password);

  if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });

  if (user.active === false) {
    return res.status(403).json({ error: 'Compte désactivé' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});


// Verification du token (utilise par le magicien au demarrage)
app.get("/auth/me", authenticate, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  res.json({ id: user.id, username: user.username, name: user.name || user.username, role: user.role });
});
// Admin : Liste utilisateurs
app.get('/admin/users', authenticate, isAdmin, (req, res) => {
  res.json(users);
});

// Admin : Création de compte
app.post('/admin/users', authenticate, isAdmin, async (req, res) => {
  const { name, username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username et password requis' });
  }
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Cet utilisateur existe déjà' });
  }
  const newUser = {
    id: crypto.randomUUID(),
    name: name || username,
    username,
    password,
    role: role || 'magicien',
    active: true,
    createdAt: Date.now()
  };
  users.push(newUser);
  await saveUsers(users);
  res.status(201).json(newUser);
});

// Admin : Modification d'un compte (nom, mot de passe, active)
app.patch('/admin/users/:id', authenticate, isAdmin, async (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const { name, password, active } = req.body;
  if (name     !== undefined) user.name     = name;
  if (password !== undefined && password !== '') user.password = password;
  if (active   !== undefined) user.active   = active;

  await saveUsers(users);
  res.json({ success: true, user });
});

// Admin : Suppression de compte
app.delete('/admin/users/:id', authenticate, isAdmin, async (req, res) => {
  const newUsers = users.filter(u => u.id !== req.params.id);
  await saveUsers(newUsers);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════
//  TOURS SSE (Zener, Astro, etc.)
// ════════════════════════════════════════════════════════════
const TOURS = ['zener', 'gogyo', 'oracle', 'astro', 'cadenas'];

TOURS.forEach(tour => {
  // Le flux (Stream) pour le magicien
  app.get(`/${tour}/stream`, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = Date.now();
    if (!activeStreams.has(tour)) activeStreams.set(tour, new Map());
    activeStreams.get(tour).set(clientId, res);

    req.on('close', () => {
      activeStreams.get(tour).delete(clientId);
    });
  });

  // La transmission par le spectateur
  app.post(`/${tour}/transmit`, async (req, res) => {
    const data = { ...req.body, timestamp: Date.now() };

    // Envoyer à tous les magiciens sur ce tour
    if (activeStreams.has(tour)) {
      const message = `data: ${JSON.stringify(data)}\n\n`;
      activeStreams.get(tour).forEach(client => client.write(message));
    }

    // Notification vers l'Admin via WebSocket (si connecté)
    broadcastToAdmins({ type: 'transmission', tour, data });

    res.json({ success: true });
  });
});


// ════════════════════════════════════════════════════════════
//  ROUTES GÉNÉRIQUES (compatibilité spectateur/magicien)
// ════════════════════════════════════════════════════════════

// Route générique /stream → redirige vers /zener/stream par défaut
app.get('/stream', (req, res) => {
  const tour = req.query.tour || 'zener';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now();
  if (!activeStreams.has(tour)) activeStreams.set(tour, new Map());
  activeStreams.get(tour).set(clientId, res);

  req.on('close', () => {
    activeStreams.get(tour).delete(clientId);
  });
});

// Route générique /transmit → redirige vers /zener/transmit par défaut
app.post('/transmit', async (req, res) => {
  const tour = req.query.tour || req.body.tour || 'zener';
  const data = { ...req.body, timestamp: Date.now() };

  if (activeStreams.has(tour)) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    activeStreams.get(tour).forEach(client => client.write(message));
  }

  broadcastToAdmins({ type: 'transmission', tour, data });
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════
//  WEBSOCKET SERVER (Magic Draw, Atelier, Admin)
// ════════════════════════════════════════════════════════════
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role'); // spectateur, magicien, admin
  ws.role = role;

  ws.on('message', (message) => {
    const payload = JSON.parse(message);

    // Logique de dispatching selon le type de message
    wss.clients.forEach(client => {
      if (client !== ws && client.readyState === 1) {
        client.send(JSON.stringify(payload));
      }
    });
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

  // Création d'un admin par défaut si aucun admin n'existe
  const adminExists = users.find(u => u.role === 'admin');
  if (!adminExists) {
    const defaultAdmin = {
      id: '1',
      name: 'Admin',
      username: 'admin',
      password: 'password123',
      role: 'admin',
      active: true,
      createdAt: Date.now()
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
