// POST /api/wompi/webhook: Wompi avisa aquí cada cambio de estado de una transacción.
// Solo se acepta si el checksum del evento coincide con el secreto de eventos.
const { configuracion, eventoAutentico } = require('../../lib/wompi');
const { leerJson, enviarJson } = require('../../lib/http');

module.exports = async function webhook(req, res) {
  if (req.method !== 'POST') return enviarJson(res, 405, { error: 'Método no permitido.' });

  const cfg = configuracion();
  if (!cfg || !cfg.eventsSecret) return enviarJson(res, 503, { error: 'Webhook no configurado.' });

  const evento = await leerJson(req).catch(() => null);
  if (!eventoAutentico(evento, cfg.eventsSecret)) return enviarJson(res, 400, { error: 'Firma inválida.' });

  const transaccion = evento.data && evento.data.transaction;
  if (transaccion) console.log(`[wompi] ${evento.event} ${transaccion.reference} ${transaccion.status}`);
  return enviarJson(res, 200, { ok: true });
};
