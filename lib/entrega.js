// Entrega del paquete de bienvenida cuando Wompi confirma un pago aprobado.
const { PLANES, parsearReferencia } = require('./wompi');
const { cargarProveedor, proveedorCompleto, generarDocumentos } = require('./paquete');
const { correoConfigurado, enviarCorreo } = require('./correo');

function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function mensajeBienvenida({ nombre, plan, referencia, marca, correoContacto, documentos }) {
  const titulos = documentos.map(d => d.titulo);
  const asunto = `Tu paquete de bienvenida · ${plan.nombre}`;
  const html = `<p>Hola ${escapar(nombre)},</p>
<p>Gracias por tu compra del modelo <strong>${escapar(plan.nombre)}</strong>. Te enviamos tu paquete de bienvenida:</p>
<ul>${titulos.map(t => `<li>${escapar(t)}</li>`).join('')}</ul>
<p>Guarda el contrato y la cuenta de cobro, revisa los pasos siguientes y responde a este correo con tu material para empezar.</p>
<p>Referencia de pago: ${escapar(referencia)}</p>
<p>${escapar(marca)} · ${escapar(correoContacto)}</p>`;
  const texto = `Hola ${nombre},

Gracias por tu compra del modelo ${plan.nombre}. Te enviamos tu paquete de bienvenida:
${titulos.map(t => `- ${t}`).join('\n')}

Guarda el contrato y la cuenta de cobro, revisa los pasos siguientes y responde a este correo con tu material para empezar.

Referencia de pago: ${referencia}
${marca} · ${correoContacto}`;
  return { asunto, html, texto };
}

// Devuelve 'enviado', 'pendiente' (falta algún dato o el correo no está configurado) u 'omitido' (no es un pago de este sitio).
async function entregarPaquete(transaccion) {
  const referencia = transaccion.reference;
  const pedido = parsearReferencia(referencia);
  if (!pedido) return 'omitido';

  const plan = PLANES[pedido.plan];
  const cobrado = Number(transaccion.amount_in_cents ?? transaccion.amountInCents);
  if (cobrado !== plan.precioCOP * 100) {
    console.warn(`[paquete] ${referencia}: el monto cobrado no coincide con el modelo; revisar antes de enviar`);
    return 'pendiente';
  }

  const cliente = transaccion.customer_data || transaccion.customerData || {};
  const nombre = String(cliente.full_name || cliente.fullName || '').trim();
  const correo = String(transaccion.customer_email || transaccion.customerEmail || '').trim();
  if (!nombre || !correo) {
    console.warn(`[paquete] ${referencia}: la transacción no trae nombre o correo; envío manual`);
    return 'pendiente';
  }

  const proveedor = cargarProveedor();
  if (!proveedorCompleto(proveedor)) {
    console.warn(`[paquete] ${referencia}: faltan datos del proveedor (PROVEEDOR_JSON); envío manual`);
    return 'pendiente';
  }

  const documentos = await generarDocumentos({
    plan: pedido.plan,
    nombre,
    correo,
    referencia,
    fecha: pedido.fecha,
    instrucciones: pedido.instrucciones
  }, proveedor);

  if (!correoConfigurado()) {
    console.warn(`[paquete] ${referencia}: correo sin configurar (RESEND_API_KEY, EMAIL_FROM); paquete listo para envío manual`);
    return 'pendiente';
  }

  const mensaje = mensajeBienvenida({
    nombre,
    plan,
    referencia,
    marca: proveedor.marca,
    correoContacto: proveedor.correo,
    documentos
  });
  await enviarCorreo({ para: correo, ...mensaje, adjuntos: documentos });
  console.log(`[paquete] ${referencia}: enviado con ${documentos.length} documentos`);
  return 'enviado';
}

module.exports = { entregarPaquete, mensajeBienvenida };
