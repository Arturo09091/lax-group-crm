// Servidor estático mínimo (sin dependencias) para la landing MOON.
// Sirve index.html en cualquier ruta. Railway inyecta PORT.
// Arranque en Railway:  node landing-server.js
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'));

http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
  res.end(HTML);
}).listen(PORT, () => console.log('MOON landing escuchando en :' + PORT));
