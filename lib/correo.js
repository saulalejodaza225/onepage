// Envío de correo con Resend (https://resend.com). Sin RESEND_API_KEY y EMAIL_FROM no se envía nada.
const URL_API = process.env.RESEND_API_URL || 'https://api.resend.com/emails';

function correoConfigurado() {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

// adjuntos: [{ nombre, bytes }]
async function enviarCorreo({ para, asunto, html, texto, adjuntos }) {
  const respuesta = await fetch(URL_API, {
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
    })
  });
  if (!respuesta.ok) throw new Error(`Resend respondió ${respuesta.status}`);
  return respuesta.json();
}

module.exports = { correoConfigurado, enviarCorreo };
