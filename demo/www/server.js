'use strict';
// Standalone landing site for the Menagerai project. Zero dependencies, zero
// config — serves one static HTML page (links hardcoded in index.html), the logo
// and favicon, and a /healthz probe. Deployed on its OWN, separate from the demo
// docker-compose, so the marketing site stays up even while the demo redeploys.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
// Static image assets, read once at startup and served with a long cache TTL.
const ASSETS = {
  '/logo.png': fs.readFileSync(path.join(__dirname, 'logo.png')),
  '/favicon.png': fs.readFileSync(path.join(__dirname, 'favicon.png')),
};

const server = http.createServer(function (req, res) {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (ASSETS[url]) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(ASSETS[url]);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});

server.listen(PORT, function () {
  console.log('menagerai landing listening on :' + PORT);
});
