// Huddle server entry. Express API + Socket.IO + the built web client.

require('./env');
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const db = require('./db');
const { bootstrap } = require('./bootstrap');
const socket = require('./socket');

const PORT = Number(process.env.PORT) || 3000;
const SERVER_URL = (process.env.SERVER_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// Allowed browser origins: the app's own URL, plus Vite's dev server, plus
// anything extra in CORS_ORIGINS (comma-separated).
const corsOrigins = [
  SERVER_URL,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
];

const app = express();
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

app.use(
  helmet({
    // The client is same-origin; keep CSP strict but allow inline styles from Vite's build.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:', ...corsOrigins],
        fontSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, version: require('./package.json').version }));
app.use('/auth', require('./routes/auth'));
app.use('/api/server', require('./routes/server'));

// Built client (client/dist). In dev, run `npm run dev:client` instead.
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api|\/auth|\/socket\.io).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('text').send('Huddle server is up. Client not built — run `npm run build`.'));
}

app.use((req, res) => res.status(404).json({ error: 'not_found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const ref = Math.random().toString(36).slice(2, 8);
  console.error(`[error ${ref}]`, err);
  res.status(500).json({ error: 'server_error', ref });
});

const server = http.createServer(app);
socket.attach(server, { corsOrigins });

(async () => {
  await db.migrate();
  await bootstrap();
  server.listen(PORT, () => console.log(`Huddle listening on :${PORT} (${SERVER_URL})`));
})().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
