// POST /api/wompi/checkout: valida el pedido, fija el precio en el servidor y devuelve la URL de pago de Wompi.
const { PLANES, configuracion, crearReferencia, urlCheckout } = require('../../lib/wompi');
const { leerJson, enviarJson } = require('../../lib/http');

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function urlPublica(req, cfg) {
  if (cfg.publicUrl) return cfg.publicUrl.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers.host}`;
}

module.exports = async function checkout(req, res) {
  if (req.method !== 'POST') return enviarJson(res, 405, { error: 'Método no permitido.' });

  const cfg = configuracion();
  if (!cfg) return enviarJson(res, 503, { error: 'Los pagos todavía no están configurados.' });

  const datos = await leerJson(req).catch(() => null);
  if (!datos || typeof datos !== 'object') return enviarJson(res, 400, { error: 'Solicitud inválida.' });

  const clave = typeof datos.plan === 'string' && Object.prototype.hasOwnProperty.call(PLANES, datos.plan) ? datos.plan : null;
  if (!clave) return enviarJson(res, 400, { error: 'Elige un modelo válido.' });

  const nombre = typeof datos.nombre === 'string' ? datos.nombre.trim() : '';
  const correo = typeof datos.correo === 'string' ? datos.correo.trim() : '';
  if (nombre.length < 3 || nombre.length > 120) return enviarJson(res, 400, { error: 'Escribe tu nombre completo.' });
  if (correo.length > 160 || !CORREO.test(correo)) return enviarJson(res, 400, { error: 'Escribe un correo válido.' });

  const url = urlCheckout(cfg, {
    referencia: crearReferencia(clave),
    montoCentavos: PLANES[clave].precioCOP * 100,
    nombre,
    correo,
    redirectUrl: `${urlPublica(req, cfg)}/pago-resultado.html`
  });
  return enviarJson(res, 200, { checkoutUrl: url });
};
