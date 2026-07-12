'use strict';
// Aviary Wiki — a demo "managed app" behind the Menagerai gateway. Zero deps.
// It performs NO login of its own: the gateway authorizes the request and injects
// the user's identity as X-Menagerai-* headers, which this app trusts only when
// accompanied by the correct per-app proxy secret. The UI is fake; the identity
// card at the top is the real payload — it echoes exactly what the gateway sent.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP_KEY = 'wiki';
const APP_NAME = 'Aviary Wiki';
const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_PATH = process.env.APP_BASE_PATH || '/apps/' + APP_KEY;
const PORTAL_URL = process.env.PORTAL_URL || '/';
const DEV_TRUST = process.env.DEV_TRUST === '1'; // local run with no gateway
// The per-app proxy secret. Prefer an explicit MENAGERAI_PROXY_SECRET (standalone
// deploy); otherwise derive it from the shared DEMO_SECRET with the SAME HMAC the
// portal uses, so the bundled compose needs only one env var for the whole stack.
const SECRET =
  process.env.MENAGERAI_PROXY_SECRET ||
  (process.env.DEMO_SECRET ? crypto.createHmac('sha256', process.env.DEMO_SECRET).update('proxy:' + APP_KEY).digest('base64url') : '');

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Constant-time-ish compare; length is allowed to leak (fine for a demo).
function safeEqual(a, b) {
  const ba = Buffer.from(a || '', 'utf8');
  const bb = Buffer.from(b || '', 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function isHealthz(url) {
  return url === '/healthz' || url === BASE_PATH + '/healthz';
}

const server = http.createServer(function (req, res) {
  const url = (req.url || '/').split('?')[0];

  // Public, anonymous, no proxy secret required — the container/gateway healthcheck.
  if (isHealthz(url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  let email, id, roles;
  if (DEV_TRUST) {
    email = 'dev@local';
    id = 'dev';
    roles = 'dev';
  } else if (!safeEqual(req.headers['x-menagerai-proxy-secret'], SECRET)) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>401 — direct access blocked</h1><p>This app trusts identity only from the Menagerai gateway. Reach it through the portal.</p>');
    return;
  } else {
    email = req.headers['x-menagerai-user-email'] || '';
    id = req.headers['x-menagerai-user-id'] || '';
    roles = req.headers['x-menagerai-roles'] || '';
  }

  const body = HTML
    .split('{{APP_NAME}}').join(esc(APP_NAME))
    .split('{{EMAIL}}').join(esc(email))
    .split('{{USER_ID}}').join(esc(id))
    .split('{{ROLES}}').join(esc(roles))
    .split('{{BASE_PATH}}').join(esc(BASE_PATH))
    .split('{{PORTAL_URL}}').join(esc(PORTAL_URL));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
});

server.listen(PORT, function () {
  console.log(APP_NAME + ' (demo) listening on :' + PORT + ' base=' + BASE_PATH);
});
