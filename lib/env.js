// Carga las variables de .env (si existe) sin pisar las que ya estén definidas en el entorno.
const fs = require('fs');
const path = require('path');

function cargarEnv(raiz = path.join(__dirname, '..')) {
  const archivo = path.join(raiz, '.env');
  if (!fs.existsSync(archivo)) return false;
  fs.readFileSync(archivo, 'utf8').split('\n').forEach(linea => {
    const m = linea.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  });
  return true;
}

module.exports = { cargarEnv };
