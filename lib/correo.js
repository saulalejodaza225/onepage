// Envío de correo con Resend (https://resend.com). Sin RESEND_API_KEY y EMAIL_FROM no se envía nada.
// RESEND_API_URL solo sirve para pruebas con un servidor simulado.

function correoConfigurado() {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

// adjuntos: [{ nombre, bytes }]
async function enviarCorreo({ para, asunto, html, texto, adjuntos }) {
  const respuesta = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [para],
      subject: asunto,
      html,
      text: texto,
      attachments: adjuntos.map(a => ({ filename: a.nombre, content: Buffer.from(a.bytes).toString('base64') }))
    }),
    signal: AbortSignal.timeout(20000)
  });
  if (!respuesta.ok) throw new Error(`Resend respondió ${respuesta.status}`);
  return respuesta.json();
}

// Lista los dominios de la cuenta de Resend y su estado. Solo lee; no cambia nada.
async function consultarDominios() {
  const respuesta = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    signal: AbortSignal.timeout(10000)
  });
  if (!respuesta.ok) return { estado: respuesta.status, dominios: [] };
  const json = await respuesta.json();
  return {
    estado: respuesta.status,
    dominios: (json.data || []).map(d => ({ nombre: d.name, estado: d.status }))
  };
}

module.exports = { correoConfigurado, enviarCorreo, consultarDominios };
