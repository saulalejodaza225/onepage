// Revisa lo necesario para cobrar y enviar el paquete de bienvenida. Solo lee la configuración;
// no cambia nada, salvo con --correo, que envía un correo de prueba.
//
// Uso:
//   npm run verificar                              revisa la configuración
//   npm run verificar -- --produccion              exige lo necesario para cobrar de verdad
//   npm run verificar -- --enlace                  imprime un enlace de pago de prueba
//   npm run verificar -- --correo tu@correo.com    envía un paquete de prueba por Resend
const { cargarEnv } = require('../lib/env');

cargarEnv();

const { configuracion, probarConexion, crearReferencia, urlCheckout, PLANES } = require('../lib/wompi');
const { cargarProveedor, camposPendientesProveedor, generarDocumentos } = require('../lib/paquete');
const { correoConfigurado, enviarCorreo, consultarDominios } = require('../lib/correo');
const { mensajeBienvenida } = require('../lib/entrega');

const args = process.argv.slice(2);
const produccion = args.includes('--produccion');
const pedirEnlace = args.includes('--enlace');
const posicionCorreo = args.indexOf('--correo');
const correoPrueba = posicionCorreo >= 0 ? args[posicionCorreo + 1] : null;

const resultados = [];
const registrar = (nivel, texto) => resultados.push({ nivel, texto });
const env = nombre => (process.env[nombre] || '').trim();
const urlSitio = () => env('PUBLIC_URL').replace(/\/$/, '');

async function revisarWompi() {
  const definido = env('WOMPI_ENV');
  const modo = definido || 'sandbox';
  if (definido && !['sandbox', 'production'].includes(definido)) {
    registrar('falta', `WOMPI_ENV debe ser "sandbox" o "production", no "${definido}"`);
  } else if (!definido) {
    registrar('aviso', 'WOMPI_ENV no está definida: se usa sandbox (pruebas)');
  } else {
    registrar('ok', `Modo de Wompi: ${modo}`);
  }
  if (produccion && modo !== 'production') registrar('falta', 'Para producción, WOMPI_ENV debe ser production');

  const publica = env('WOMPI_PUBLIC_KEY');
  const prefijo = modo === 'production' ? 'pub_prod_' : 'pub_test_';
  if (!publica) registrar('falta', 'WOMPI_PUBLIC_KEY: falta la llave pública');
  else if (publica.startsWith(prefijo)) registrar('ok', `WOMPI_PUBLIC_KEY: ${publica.slice(0, 14)}…`);
  else registrar(produccion ? 'falta' : 'aviso', `WOMPI_PUBLIC_KEY no empieza por ${prefijo}: revisa que sea la llave del modo ${modo}`);

  const integridad = env('WOMPI_INTEGRITY_SECRET');
  if (!integridad) registrar('falta', 'WOMPI_INTEGRITY_SECRET: falta el secreto de integridad (sin él no se puede firmar el pago)');
  else if (integridad.startsWith('pub_')) registrar('aviso', 'WOMPI_INTEGRITY_SECRET parece una llave pública; el secreto de integridad es otro valor');
  else registrar('ok', 'WOMPI_INTEGRITY_SECRET: definido');

  if (!env('WOMPI_EVENTS_SECRET')) registrar('falta', 'WOMPI_EVENTS_SECRET: falta el secreto de eventos (sin él el webhook no confirma pagos)');
  else registrar('ok', 'WOMPI_EVENTS_SECRET: definido');

  const privada = env('WOMPI_PRIVATE_KEY');
  if (privada) registrar('ok', 'WOMPI_PRIVATE_KEY: definida (se usa para consultar transacciones)');

  const url = urlSitio();
  if (!url) registrar(produccion ? 'falta' : 'aviso', 'PUBLIC_URL está vacía; en producción debe ser la dirección del sitio, por ejemplo https://onepage-navy.vercel.app');
  else if (produccion && !url.startsWith('https://')) registrar('falta', 'PUBLIC_URL debe empezar por https:// en producción');
  else registrar('ok', `PUBLIC_URL: ${url}`);
  const destino = url || 'https://TU-SITIO';
  registrar('info', `En Wompi, URL de eventos (webhook): ${destino}/api/wompi/webhook`);
  registrar('info', `La redirección tras el pago (${destino}/pago-resultado.html) la envía el sistema en cada enlace`);

  const cfg = configuracion();
  if (!cfg) {
    registrar('info', 'Sin llaves de Wompi no se prueba la conexión');
    return null;
  }
  try {
    const estado = await probarConexion(cfg);
    if (estado === 200 || estado === 404) {
      registrar('ok', `Wompi responde y acepta la consulta de transacciones (${cfg.apiBase})`);
    } else if (estado === 401 || estado === 403) {
      registrar('falta', privada
        ? 'Wompi no aceptó WOMPI_PRIVATE_KEY; revisa que sea la llave privada del mismo modo'
        : 'Wompi pide autorización para consultar transacciones: define WOMPI_PRIVATE_KEY');
    } else {
      registrar('aviso', `Wompi respondió ${estado} al consultar una transacción de prueba`);
    }
  } catch (err) {
    registrar('aviso', `No se pudo conectar con Wompi desde este equipo (${err.message}); revisa la conexión o el firewall`);
  }
  return cfg;
}

async function revisarCorreo() {
  const clave = env('RESEND_API_KEY');
  const remitente = env('EMAIL_FROM');
  if (!clave) {
    registrar(produccion ? 'falta' : 'aviso', 'Correo: RESEND_API_KEY no está definida; el paquete quedará pendiente para envío manual');
    return;
  }
  if (!remitente) registrar('falta', 'Correo: EMAIL_FROM no está definida (por ejemplo, Arquitectura digital <hola@tu-dominio.com>)');
  try {
    const { estado, dominios } = await consultarDominios();
    if (estado === 401 || estado === 403) return registrar('falta', 'Correo: RESEND_API_KEY no es válida');
    if (estado !== 200) return registrar('aviso', `Correo: Resend respondió ${estado} al listar los dominios`);
    if (!remitente) return;
    const dominio = (remitente.match(/@([^>\s]+)/) || [])[1] || '';
    const verificado = dominios.some(d => d.nombre === dominio && d.estado === 'verified');
    if (verificado) registrar('ok', `Correo: el dominio ${dominio} está verificado en Resend`);
    else registrar('falta', `Correo: el dominio "${dominio}" no está verificado en Resend; verifícalo antes de enviar`);
  } catch (err) {
    registrar('aviso', `Correo: no se pudo conectar con Resend desde este equipo (${err.message})`);
  }
}

function revisarProveedor(proveedor) {
  if (!proveedor) {
    registrar('falta', 'Datos del proveedor: no hay paquete/proveedor.json ni PROVEEDOR_JSON; copia paquete/proveedor.ejemplo.json y complétalo');
    return;
  }
  const faltantes = camposPendientesProveedor(proveedor);
  if (faltantes.length) registrar('falta', `Datos del proveedor incompletos: ${faltantes.join(', ')}`);
  else registrar('ok', `Datos del proveedor completos (marca: ${proveedor.marca})`);
}

async function revisarDocumentos(proveedor) {
  try {
    const documentos = await generarDocumentos({
      plan: 'L',
      nombre: 'Cliente de prueba',
      correo: 'prueba@ejemplo.com',
      referencia: 'PAG-L-I-VERIFICAR-00000000',
      fecha: new Date(),
      instrucciones: true
    }, proveedor || {});
    registrar('ok', `Documentos: se generan ${documentos.length} PDF sin errores`);
  } catch (err) {
    registrar('falta', `Documentos: error al generarlos (${err.message})`);
  }
}

function enlaceDePrueba(cfg) {
  if (!cfg) return 'No hay enlace de prueba: faltan las llaves de Wompi.';
  const url = urlCheckout(cfg, {
    referencia: crearReferencia('L', true),
    montoCentavos: PLANES.L.precioCOP * 100,
    nombre: 'Cliente de prueba',
    correo: 'prueba@ejemplo.com',
    redirectUrl: `${urlSitio() || 'http://localhost:3000'}/pago-resultado.html`
  });
  return `Enlace de pago de prueba (modo ${cfg.modo}; úsalo solo para probar):\n${url}`;
}

async function mandarPrueba(proveedor) {
  if (!correoPrueba) return registrar('falta', 'Para --correo indica una dirección: npm run verificar -- --correo tu@correo.com');
  if (!correoConfigurado()) return registrar('falta', '--correo necesita RESEND_API_KEY y EMAIL_FROM');
  try {
    const plan = 'P';
    const referencia = crearReferencia(plan, true);
    const documentos = await generarDocumentos({
      plan,
      nombre: 'Cliente de prueba',
      correo: correoPrueba,
      referencia,
      fecha: new Date(),
      instrucciones: true
    }, proveedor || {});
    const mensaje = mensajeBienvenida({
      nombre: 'Cliente de prueba',
      plan: PLANES[plan],
      referencia,
      marca: (proveedor && proveedor.marca) || 'Paquete de bienvenida',
      correoContacto: (proveedor && proveedor.correo) || '',
      documentos
    });
    await enviarCorreo({ para: correoPrueba, ...mensaje, adjuntos: documentos });
    registrar('ok', `Correo de prueba enviado a ${correoPrueba} con ${documentos.length} documentos`);
  } catch (err) {
    registrar('falta', `Correo de prueba: ${err.message}`);
  }
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) registrar('ok', `Node ${process.versions.node}`);
  else registrar('falta', `Node ${process.versions.node}: se necesita la versión 18 o superior`);
  try {
    require.resolve('pdf-lib');
    registrar('ok', 'Dependencias instaladas (pdf-lib)');
  } catch (err) {
    registrar('falta', 'Dependencias: ejecuta npm install');
  }

  const cfg = await revisarWompi();
  await revisarCorreo();
  const proveedor = cargarProveedor();
  revisarProveedor(proveedor);
  await revisarDocumentos(proveedor);
  if (posicionCorreo >= 0) await mandarPrueba(proveedor);

  const etiquetas = { ok: '[ OK  ]', falta: '[FALTA]', aviso: '[AVISO]', info: '[ >>  ]' };
  resultados.forEach(r => console.log(`${etiquetas[r.nivel]} ${r.texto}`));
  const cuenta = nivel => resultados.filter(r => r.nivel === nivel).length;
  console.log(`\nResumen: ${cuenta('ok')} correctos, ${cuenta('aviso')} avisos, ${cuenta('falta')} por completar.`);
  if (cuenta('falta')) console.log('Sigue CONFIGURAR.md para completar lo que falta.');
  if (pedirEnlace) console.log(`\n${enlaceDePrueba(cfg)}`);
  process.exitCode = cuenta('falta') ? 1 : 0;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
