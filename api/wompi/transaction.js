// GET /api/wompi/transaction?id=...: estado de una transacción, para la página de resultado.
const { configuracion, consultarTransaccion } = require('../../lib/wompi');
const { enviarJson } = require('../../lib/http');

const ID_VALIDO = /^[A-Za-z0-9-]{5,80}$/;

module.exports = async function transaccion(req, res) {
  if (req.method !== 'GET') return enviarJson(res, 405, { error: 'Método no permitido.' });

  const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
  if (!ID_VALIDO.test(id)) return enviarJson(res, 400, { error: 'Falta el número de transacción.' });

  const cfg = configuracion();
  if (!cfg) return enviarJson(res, 503, { error: 'Los pagos todavía no están configurados.' });

  try {
    const tx = await consultarTransaccion(cfg, id);
    if (!tx) return enviarJson(res, 404, { error: 'Transacción no encontrada.' });
    return enviarJson(res, 200, {
      status: tx.status,
      reference: tx.reference,
      amount: Number(tx.amount_in_cents ?? tx.amountInCents) / 100,
      currency: tx.currency
    });
  } catch (err) {
    return enviarJson(res, 502, { error: 'No pudimos consultar el estado del pago.' });
  }
};
