'use strict';
// Standalone landing site for the Menagerai project. Zero dependencies — serves one
// static HTML page (links hardcoded in index.html), the logo and favicon, and a
// /healthz probe. Deployed on its OWN, separate from the demo docker-compose, so the
// marketing site stays up even while the demo redeploys.
//
// Optional analytics: set GA_MEASUREMENT_ID to a Google Analytics measurement ID and
// the gtag snippet is injected. Left unset (the default), nothing is added — so a
// fork never ships the operator's analytics.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);

// Sanitize to the GA ID charset before interpolating into the tag.
const GA_ID = (process.env.GA_MEASUREMENT_ID || '').match(/^[A-Za-z0-9-]+$/) ? process.env.GA_MEASUREMENT_ID : '';
const GA_SNIPPET = GA_ID
  ? '<!-- Google tag (gtag.js) -->\n' +
    '<script async src="https://www.googletagmanager.com/gtag/js?id=' + GA_ID + '"></script>\n' +
    '<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}' +
    "gtag('js',new Date());gtag('config','" + GA_ID + "');</script>\n"
  : '';

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('</head>', GA_SNIPPET + '</head>');
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
