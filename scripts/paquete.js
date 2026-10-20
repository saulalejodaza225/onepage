// Genera los PDF del paquete de bienvenida.
// Sin --plan, genera las plantillas con los campos en blanco, para revisarlas.
// Con --plan, genera el paquete de un pedido concreto, por ejemplo para enviarlo a mano.
//
// Uso:
//   node scripts/paquete.js --proveedor paquete/proveedor.ejemplo.json --salida paquete/documentos
//   node scripts/paquete.js --plan L --nombre "Ana Pérez" --correo ana@ejemplo.com --referencia PAG-L-I-... --instrucciones
const fs = require('fs');
const path = require('path');
const { generarDocumentos, cargarProveedor } = require('../lib/paquete');
const { PLANES, parsearReferencia } = require('../lib/wompi');

function leerArgumentos(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const clave = argv[i].slice(2);
    const siguiente = argv[i + 1];
    if (siguiente === undefined || siguiente.startsWith('--')) {
      args[clave] = true;
    } else {
      args[clave] = siguiente;
      i++;
    }
  }
  return args;
}

async function main() {
  const args = leerArgumentos(process.argv.slice(2));
  const proveedor = args.proveedor ? JSON.parse(fs.readFileSync(args.proveedor, 'utf8')) : cargarProveedor();
  const salida = path.resolve(args.salida || path.join(__dirname, '..', 'paquete', 'documentos'));

  let pedido;
  if (args.plan) {
    if (!PLANES[args.plan]) throw new Error(`Modelo desconocido: ${args.plan} (usa L, P, E o T)`);
    const referencia = typeof args.referencia === 'string' ? args.referencia : '';
    const datosReferencia = parsearReferencia(referencia);
    pedido = {
      plan: args.plan,
      nombre: typeof args.nombre === 'string' ? args.nombre : '',
      correo: typeof args.correo === 'string' ? args.correo : '',
      referencia,
      fecha: datosReferencia ? datosReferencia.fecha : new Date(),
      instrucciones: args.instrucciones === true
    };
  } else {
    pedido = { plan: null, nombre: '', correo: '', referencia: '', fecha: null, instrucciones: true };
  }

  const documentos = await generarDocumentos(pedido, proveedor || {});
  fs.mkdirSync(salida, { recursive: true });
  documentos.forEach(d => fs.writeFileSync(path.join(salida, d.nombre), d.bytes));
  console.log(`${documentos.length} documentos en ${salida}`);
  documentos.forEach(d => console.log(`  - ${d.nombre}`));
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
