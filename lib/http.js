// Utilidades HTTP compartidas por las funciones de /api (Vercel y servidor local).
const LIMITE_BYTES = 16 * 1024;

function leerJson(req) {
  // Vercel ya parsea el cuerpo en req.body; en el servidor local hay que leerlo del flujo.
  if (req.body !== undefined) {
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
  }
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on('data', trozo => {
      total += trozo.length;
      if (total > LIMITE_BYTES) {
        req.destroy();
        reject(new Error('Cuerpo demasiado grande.'));
        return;
      }
      partes.push(trozo);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(partes).toString('utf8') || 'null'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function enviarJson(res, estado, cuerpo) {
  res.statusCode = estado;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(cuerpo));
}

module.exports = { leerJson, enviarJson };
