// Servidor local: sirve la página y ejecuta las mismas funciones de /api que en Vercel.
// Uso: npm start  →  http://localhost:3000
// Las llaves de Wompi se leen de .env (ver .env.example). Ese archivo nunca se sirve.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { cargarEnv } = require('./lib/env');

const RAIZ = __dirname;
const PUERTO = Number(process.env.PORT) || 3000;
const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf'
};
const NO_SERVIBLES = ['server.js', 'package.json', 'README.md', 'CONFIGURAR.md'];
const CARPETAS_PRIVADAS = ['api', 'lib', 'scripts', 'node_modules'];

function noEncontrado(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('No encontrado');
}

async function atenderApi(nombre, req, res) {
  const archivo = path.join(RAIZ, 'api', 'wompi', nombre + '.js');
  if (!fs.existsSync(archivo)) return noEncontrado(res);
  try {
    await require(archivo)(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Error interno.' }));
    }
  }
}

function servirArchivo(ruta, res) {
  const relativo = ruta === '/' ? 'index.html' : decodeURIComponent(ruta.slice(1));
  const archivo = path.normalize(path.join(RAIZ, relativo));
  const partes = relativo.split('/');
  const tipo = TIPOS[path.extname(archivo).toLowerCase()];
  const bloqueado = !tipo
    || partes.some(parte => parte.startsWith('.'))
    || CARPETAS_PRIVADAS.includes(partes[0])
    || NO_SERVIBLES.includes(relativo)
    || !archivo.startsWith(RAIZ + path.sep);
  if (bloqueado) return noEncontrado(res);
  fs.stat(archivo, (err, info) => {
    if (err || !info.isFile()) return noEncontrado(res);
    res.setHeader('Content-Type', tipo);
    fs.createReadStream(archivo).pipe(res);
  });
}

cargarEnv(RAIZ);

http.createServer(async (req, res) => {
  try {
    const ruta = new URL(req.url, 'http://localhost').pathname;
    const api = ruta.match(/^\/api\/wompi\/([a-z]+)$/);
    if (api) return await atenderApi(api[1], req, res);
    return servirArchivo(ruta, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) noEncontrado(res);
  }
}).listen(PUERTO, () => {
  const cfg = require('./lib/wompi').configuracion();
  console.log(`Sitio en http://localhost:${PUERTO}`);
  console.log(cfg ? `Pagos Wompi en modo ${cfg.modo}` : 'Pagos sin configurar: revisa el archivo .env (o ejecuta npm run verificar)');
});
