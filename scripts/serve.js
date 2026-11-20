// Serveur statique local pour le dossier web/ : node scripts/serve.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'web');
const PORT = +process.argv[2] || 5173;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, '.' + rel);
  // jamais hors du dossier web/
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Québec en mouvement : http://localhost:${PORT}`));
