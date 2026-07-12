'use strict';
// Standalone landing site for the Menagerai project. Zero dependencies. Serves one
// static page with two configurable links (the live demo and the GitHub repo) plus
// a /healthz probe. Deployed on its OWN, separate from the demo docker-compose, so
// the marketing site stays up even while the demo stack is being redeployed.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DEMO_URL = process.env.DEMO_URL || 'https://demo.menager.ai';
const GITHUB_URL = process.env.GITHUB_URL || 'https://github.com/menagerai/menagerai';

const HTML = fs
  .readFileSync(path.join(__dirname, 'index.html'), 'utf8')
  .split('{{DEMO_URL}}').join(DEMO_URL)
  .split('{{GITHUB_URL}}').join(GITHUB_URL);

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
  console.log('menagerai landing listening on :' + PORT + ' (demo=' + DEMO_URL + ')');
});
