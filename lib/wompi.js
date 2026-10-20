// Pasarela de pagos con Wompi (Colombia). Las llaves viven en variables de entorno, nunca en la página:
// el precio y la firma de integridad se calculan aquí, en el servidor.
const crypto = require('crypto');

// Precios en COP. Deben coincidir con MODELOS de la página (index.html).
const PLANES = {
  L: { nombre: 'Landing Page', precioCOP: 675000 },
  P: { nombre: 'Página PYME', precioCOP: 1080000 },
  E: { nombre: 'Página Empresarial', precioCOP: 1620000 },
  T: { nombre: 'Tienda Online', precioCOP: 2160000 }
};

function configuracion() {
  const publicKey = process.env.WOMPI_PUBLIC_KEY;
  const integritySecret = process.env.WOMPI_INTEGRITY_SECRET;
  if (!publicKey || !integritySecret) return null;
  const produccion = process.env.WOMPI_ENV === 'production';
  return {
    modo: produccion ? 'production' : 'sandbox',
    publicKey,
    integritySecret,
    eventsSecret: process.env.WOMPI_EVENTS_SECRET || '',
    apiBase: process.env.WOMPI_API_BASE || (produccion ? 'https://production.wompi.co/v1' : 'https://sandbox.wompi.co/v1'),
    checkoutBase: process.env.WOMPI_CHECKOUT_URL || 'https://checkout.wompi.co/p/',
    publicUrl: process.env.PUBLIC_URL || ''
  };
}

function sha256(texto) {
  return crypto.createHash('sha256').update(texto).digest('hex');
}

function seguro(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function crearReferencia(clavePlan) {
  const sufijo = crypto.randomBytes(4).toString('hex');
  return ['PAG', clavePlan, Date.now().toString(36), sufijo].join('-').toUpperCase();
}

// Firma de integridad del checkout: SHA-256 de referencia + monto en centavos + moneda + secreto de integridad.
function firmaIntegridad(referencia, montoCentavos, moneda, secreto) {
  return sha256(`${referencia}${montoCentavos}${moneda}${secreto}`);
}

function urlCheckout(cfg, pedido) {
  const url = new URL(cfg.checkoutBase);
  url.searchParams.set('public-key', cfg.publicKey);
  url.searchParams.set('currency', 'COP');
  url.searchParams.set('amount-in-cents', String(pedido.montoCentavos));
  url.searchParams.set('reference', pedido.referencia);
  url.searchParams.set('signature:integrity', firmaIntegridad(pedido.referencia, pedido.montoCentavos, 'COP', cfg.integritySecret));
  url.searchParams.set('redirect-url', pedido.redirectUrl);
  url.searchParams.set('customer-data:email', pedido.correo);
  url.searchParams.set('customer-data:full-name', pedido.nombre);
  return url.toString();
}

// Verifica el checksum de un evento (webhook): une los campos listados en signature.properties,
// después el timestamp y el secreto de eventos, y compara su SHA-256 con signature.checksum.
function eventoAutentico(evento, secreto) {
  const firma = evento && evento.signature;
  if (!secreto || !firma || !Array.isArray(firma.properties) || typeof firma.checksum !== 'string') return false;
  const valores = firma.properties.map(ruta => {
    const valor = ruta.split('.').reduce((obj, clave) => (obj == null ? undefined : obj[clave]), evento.data);
    return valor == null ? '' : String(valor);
  });
  const esperado = sha256(valores.join('') + String(evento.timestamp) + secreto);
  return seguro(esperado, firma.checksum);
}

// Devuelve los datos de la transacción, o null si Wompi no la encuentra.
async function consultarTransaccion(cfg, id) {
  const respuesta = await fetch(`${cfg.apiBase}/transactions/${encodeURIComponent(id)}`);
  if (respuesta.status === 404) return null;
  if (!respuesta.ok) throw new Error(`Wompi respondió ${respuesta.status}`);
  const json = await respuesta.json();
  return json.data || null;
}

module.exports = { PLANES, configuracion, crearReferencia, urlCheckout, eventoAutentico, consultarTransaccion };
