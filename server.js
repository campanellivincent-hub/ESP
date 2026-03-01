const http = require('http');
const { WebSocketServer } = require('ws');
const https = require('https');
const { URLSearchParams } = require('url');

const PORT = process.env.PORT || 3000;

// ── Serveur HTTP (sert aussi les fichiers statiques) ──
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Magic Draw Server running');
});

// ── WebSocket ──
const wss = new WebSocketServer({ server });

let spectatorSocket = null;
let magicianSocket  = null;

// ── Canal Atelier (dessin créatif) ──
let atelierSpectateur = null;
let atelierMagicien   = null;

// Config Pushover (à remplir par l'utilisateur)
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || '';
const PUSHOVER_USER  = process.env.PUSHOVER_USER  || '';

wss.on('connection', (ws, req) => {
  const url   = new URL(req.url, `http://localhost`);
  const role  = url.searchParams.get('role');
  const canal = url.searchParams.get('canal'); // 'atelier' ou absent

  console.log(`[CONNECT] role=${role} canal=${canal || 'default'}`);

  // ══════════════════════════════════════════
  //  CANAL ATELIER — dessin créatif
  // ══════════════════════════════════════════
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
        console.log('[ATELIER] spectateur déconnecté');
        atelierSpectateur = null;
        if (atelierMagicien?.readyState === 1)
          atelierMagicien.send(JSON.stringify({ type: 'spectateur_disconnected' }));
      });

    } else if (role === 'magicien') {
      atelierMagicien = ws;
      console.log('[ATELIER] magicien connecté');
      ws.send(JSON.stringify({ type: 'magicien_ready' }));
      if (atelierSpectateur?.readyState === 1)
        ws.send(JSON.stringify({ type: 'ready' }));

      ws.on('close', () => {
        console.log('[ATELIER] magicien déconnecté');
        atelierMagicien = null;
      });
    }
    return;
  }

  // ══════════════════════════════════════════
  //  CANAL PAR DÉFAUT (Magic Draw original)
  // ══════════════════════════════════════════
  if (role === 'spectateur') {
    spectatorSocket = ws;
    ws.send(JSON.stringify({ type: 'ready' }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (magicianSocket && magicianSocket.readyState === 1)
          magicianSocket.send(data.toString());
        if (msg.type === 'final' && PUSHOVER_TOKEN && PUSHOVER_USER)
          sendPushoverImage(msg.imageData);
      } catch(e) { console.error('Parse error', e); }
    });

    ws.on('close', () => {
      console.log('[DISCONNECT] spectateur');
      spectatorSocket = null;
      if (magicianSocket) magicianSocket.send(JSON.stringify({ type: 'spectateur_disconnected' }));
    });

  } else if (role === 'magicien') {
    magicianSocket = ws;
    console.log('[MAGICIEN] connecté');
    ws.send(JSON.stringify({ type: 'magicien_ready' }));

    ws.on('close', () => {
      console.log('[DISCONNECT] magicien');
      magicianSocket = null;
    });
  }
});

// ── Pushover : envoie une image PNG base64 ──
function sendPushoverImage(base64Data) {
  // Retirer le header data:image/png;base64,
  const imageBuffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64');

  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);

  const formParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${PUSHOVER_TOKEN}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="user"\r\n\r\n${PUSHOVER_USER}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\nNouveau dessin du spectateur !`,
    `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n🎩 Magic Draw`,
    `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="drawing.png"\r\nContent-Type: image/png\r\n\r\n`,
  ];

  const header = Buffer.from(formParts.join('\r\n') + '\r\n');
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, imageBuffer, footer]);

  const options = {
    hostname: 'api.pushover.net',
    path: '/1/messages.json',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    }
  };

  const reqPush = https.request(options, (r) => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => console.log('[PUSHOVER]', d));
  });
  reqPush.on('error', e => console.error('[PUSHOVER ERROR]', e));
  reqPush.write(body);
  reqPush.end();
}

server.listen(PORT, () => console.log(`✅ Magic Draw Server on port ${PORT}`));
