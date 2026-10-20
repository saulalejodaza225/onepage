// Paquete de bienvenida: rellena las plantillas de paquete/plantillas con los datos de la compra
// y las convierte en PDF. Las plantillas usan un subconjunto de Markdown: títulos, párrafos,
// listas, tablas, negritas y líneas horizontales.
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { PLANES } = require('./wompi');

const CARPETA = path.join(__dirname, '..', 'paquete');
const VERSION_PAQUETE = 'paquete-2026-10';
const DOCUMENTOS = [
  { id: 'contrato', archivo: '01-contrato.pdf', opcional: false },
  { id: 'cuenta-de-cobro', archivo: '02-cuenta-de-cobro.pdf', opcional: false },
  { id: 'pasos-siguientes', archivo: '03-pasos-siguientes.pdf', opcional: false },
  { id: 'instrucciones', archivo: '04-instrucciones.pdf', opcional: true },
  { id: 'encuesta-satisfaccion', archivo: '05-encuesta-satisfaccion.pdf', opcional: true }
];
const CAMPOS_PROVEEDOR = ['nombre', 'documento', 'ciudad', 'direccion', 'correo', 'telefono', 'marca'];

const PAGINA = { ancho: 595.28, alto: 841.89, margen: 56 };
const NEGRO = rgb(0.07, 0.08, 0.1);
const GRIS = rgb(0.45, 0.47, 0.52);
// Caracteres fuera de ASCII/Latin-1 que WinAnsi (la codificación de las fuentes estándar de PDF) sí admite.
const EXTRAS_WINANSI = new Set(['€', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', 'Ž', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', 'ž', 'Ÿ']);

// Datos del proveedor: primero la variable PROVEEDOR_JSON (para el hosting), luego paquete/proveedor.json (local).
function cargarProveedor() {
  if (process.env.PROVEEDOR_JSON) return JSON.parse(process.env.PROVEEDOR_JSON);
  const archivo = path.join(CARPETA, 'proveedor.json');
  return fs.existsSync(archivo) ? JSON.parse(fs.readFileSync(archivo, 'utf8')) : null;
}

// Un dato sirve solo si tiene texto real: los corchetes marcan lo que aún falta por completar.
function camposPendientesProveedor(proveedor) {
  return CAMPOS_PROVEEDOR.filter(campo => {
    const valor = proveedor && typeof proveedor[campo] === 'string' ? proveedor[campo].trim() : '';
    return !valor || /^\[.*\]$/.test(valor);
  });
}

function proveedorCompleto(proveedor) {
  return camposPendientesProveedor(proveedor).length === 0;
}

function formatearPrecio(cop) {
  return '$' + cop.toLocaleString('es-CO') + ' COP';
}

function formatearFecha(fecha) {
  return new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' }).format(fecha);
}

function valores(proveedor, pedido) {
  const p = proveedor || {};
  const plan = pedido.plan ? PLANES[pedido.plan] : null;
  return {
    PROVEEDOR_NOMBRE: p.nombre,
    PROVEEDOR_DOCUMENTO: p.documento,
    PROVEEDOR_CIUDAD: p.ciudad,
    PROVEEDOR_DIRECCION: p.direccion,
    PROVEEDOR_CORREO: p.correo,
    PROVEEDOR_TELEFONO: p.telefono,
    PROVEEDOR_MARCA: p.marca,
    CLIENTE_NOMBRE: pedido.nombre,
    CLIENTE_CORREO: pedido.correo,
    PLAN_NOMBRE: plan && plan.nombre,
    PRECIO: plan && formatearPrecio(plan.precioCOP),
    PLAZO_DIAS: plan && String(plan.plazoDias),
    REFERENCIA: pedido.referencia,
    FECHA: pedido.fecha && formatearFecha(pedido.fecha)
  };
}

// Reemplaza {{CAMPO}}. Si falta el dato, deja un recordatorio entre corchetes, por ejemplo [cliente nombre].
function sustituir(texto, datos) {
  return texto.replace(/\{\{([A-Z_]+)\}\}/g, (_, campo) => {
    const valor = datos[campo];
    return valor ? String(valor) : '[' + campo.toLowerCase().replace(/_/g, ' ') + ']';
  });
}

function esEspecial(linea) {
  return /^(#\s|\||[-*]\s|\d+\.\s|-{3,}$)/.test(linea.trim());
}

function parsearMarkdown(texto) {
  const lineas = texto.split('\n');
  const bloques = [];
  let i = 0;
  while (i < lineas.length) {
    const linea = lineas[i].trim();
    if (!linea) {
      i++;
    } else if (linea.startsWith('## ')) {
      bloques.push({ tipo: 'h2', texto: linea.slice(3) });
      i++;
    } else if (linea.startsWith('# ')) {
      bloques.push({ tipo: 'h1', texto: linea.slice(2) });
      i++;
    } else if (/^-{3,}$/.test(linea)) {
      bloques.push({ tipo: 'linea' });
      i++;
    } else if (linea.startsWith('|')) {
      const filas = [];
      while (i < lineas.length && lineas[i].trim().startsWith('|')) {
        const celdas = lineas[i].trim().slice(1, -1).split('|').map(c => c.trim());
        if (!celdas.every(c => /^:?-+:?$/.test(c))) filas.push(celdas);
        i++;
      }
      bloques.push({ tipo: 'tabla', filas });
    } else if (/^[-*]\s/.test(linea)) {
      const items = [];
      while (i < lineas.length && /^[-*]\s/.test(lineas[i].trim())) items.push(lineas[i++].trim().slice(2));
      bloques.push({ tipo: 'lista', ordenada: false, items });
    } else if (/^\d+\.\s/.test(linea)) {
      const items = [];
      while (i < lineas.length && /^\d+\.\s/.test(lineas[i].trim())) items.push(lineas[i++].trim().replace(/^\d+\.\s/, ''));
      bloques.push({ tipo: 'lista', ordenada: true, items });
    } else {
      const partes = [linea];
      i++;
      while (i < lineas.length && lineas[i].trim() && !esEspecial(lineas[i])) partes.push(lineas[i++].trim());
      bloques.push({ tipo: 'parrafo', texto: partes.join(' ') });
    }
  }
  return bloques;
}

// Divide un texto en palabras. Cada palabra es una lista de trozos con su estilo (negrita o normal).
function palabras(texto, forzarNegrita = false) {
  const lista = [];
  let actual = [];
  texto.split('**').forEach((segmento, idx) => {
    const negrita = forzarNegrita || idx % 2 === 1;
    segmento.split(/(\s+)/).forEach(trozo => {
      if (!trozo) return;
      if (/^\s+$/.test(trozo)) {
        if (actual.length) lista.push(actual);
        actual = [];
        return;
      }
      actual.push({ t: trozo, negrita });
    });
  });
  if (actual.length) lista.push(actual);
  return lista;
}

function sanear(texto) {
  let salida = '';
  for (const c of texto) {
    const cp = c.codePointAt(0);
    const admitido = (cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA0 && cp <= 0xFF) || EXTRAS_WINANSI.has(c);
    salida += admitido ? c : '?';
  }
  return salida;
}

async function renderPdf(bloques, pie) {
  const pdf = await PDFDocument.create();
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);
  const { ancho: AN, alto: AL, margen: MG } = PAGINA;
  const anchoUtil = AN - 2 * MG;
  let pagina;
  let y;

  const nuevaPagina = () => {
    pagina = pdf.addPage([AN, AL]);
    y = AL - MG;
  };
  // Si el bloque no cabe en la hoja, pasa a la siguiente. Deja espacio libre para el pie de página.
  const asegurar = alto => {
    if (y - alto < MG + 24) nuevaPagina();
  };
  const fuente = trozo => (trozo.negrita ? negrita : normal);
  const medir = (palabra, size) => palabra.reduce((suma, t) => suma + fuente(t).widthOfTextAtSize(sanear(t.t), size), 0);

  function envolver(lista, anchoMax, size) {
    const espacio = normal.widthOfTextAtSize(' ', size);
    const lineas = [];
    let linea = [];
    let ancho = 0;
    lista.forEach(palabra => {
      const w = medir(palabra, size);
      if (linea.length && ancho + espacio + w > anchoMax) {
        lineas.push(linea);
        linea = [];
        ancho = 0;
      }
      ancho = linea.length ? ancho + espacio + w : w;
      linea.push(palabra);
    });
    if (linea.length) lineas.push(linea);
    return lineas;
  }

  function dibujarLinea(linea, x, base, size) {
    const espacio = normal.widthOfTextAtSize(' ', size);
    let cx = x;
    linea.forEach((palabra, i) => {
      if (i > 0) cx += espacio;
      palabra.forEach(trozo => {
        const f = fuente(trozo);
        const t = sanear(trozo.t);
        pagina.drawText(t, { x: cx, y: base, size, font: f, color: NEGRO });
        cx += f.widthOfTextAtSize(t, size);
      });
    });
  }

  function bloqueTexto(texto, { size, lh, antes = 0, despues = 0, forzar = false }) {
    y -= antes;
    envolver(palabras(texto, forzar), anchoUtil, size).forEach(linea => {
      asegurar(lh);
      dibujarLinea(linea, MG, y - size, size);
      y -= lh;
    });
    y -= despues;
  }

  function bloqueLista({ items, ordenada }) {
    items.forEach((texto, idx) => {
      const casilla = /^\[ \]/.test(texto);
      const marca = casilla ? null : (ordenada ? `${idx + 1}.` : '•');
      const sangria = casilla ? 0 : 16;
      envolver(palabras(texto), anchoUtil - sangria, 10.5).forEach((linea, n) => {
        asegurar(14.2);
        if (n === 0 && marca) pagina.drawText(sanear(marca), { x: MG + 3, y: y - 10.5, size: 10.5, font: normal, color: NEGRO });
        dibujarLinea(linea, MG + sangria, y - 10.5, 10.5);
        y -= 14.2;
      });
      y -= 3;
    });
    y -= 4;
  }

  function bloqueTabla(filas) {
    const cols = Math.max(...filas.map(f => f.length));
    const celdasDe = fila => Array.from({ length: cols }, (_, c) => fila[c] || '');
    // Ancho proporcional al texto más largo de cada columna; el mínimo evita que las cifras se partan.
    const pesos = Array.from({ length: cols }, (_, c) => Math.max(28, ...filas.map(f => (f[c] || '').length)));
    const total = pesos.reduce((a, b) => a + b, 0);
    const anchos = pesos.map(p => (anchoUtil * p) / total);
    filas.forEach((fila, idx) => {
      const textos = celdasDe(fila);
      const lineas = textos.map((texto, c) => envolver(palabras(texto, idx === 0), anchos[c] - 10, 10));
      const alto = Math.max(1, ...lineas.map(l => l.length)) * 13 + 10;
      asegurar(alto);
      let x = MG;
      lineas.forEach((celda, c) => {
        pagina.drawRectangle({ x, y: y - alto, width: anchos[c], height: alto, borderColor: GRIS, borderWidth: 0.6 });
        celda.forEach((linea, n) => dibujarLinea(linea, x + 5, y - 14 - n * 13, 10));
        x += anchos[c];
      });
      y -= alto;
    });
    y -= 10;
  }

  nuevaPagina();
  y -= 10;
  bloques.forEach(b => {
    if (b.tipo === 'h1') bloqueTexto(b.texto, { size: 17, lh: 22, despues: 8, forzar: true });
    else if (b.tipo === 'h2') bloqueTexto(b.texto, { size: 12.5, lh: 16, antes: 6, despues: 4, forzar: true });
    else if (b.tipo === 'parrafo') bloqueTexto(b.texto, { size: 10.5, lh: 14.2, despues: 7 });
    else if (b.tipo === 'lista') bloqueLista(b);
    else if (b.tipo === 'tabla') bloqueTabla(b.filas);
    else if (b.tipo === 'linea') {
      asegurar(12);
      pagina.drawLine({ start: { x: MG, y: y - 4 }, end: { x: AN - MG, y: y - 4 }, thickness: 0.6, color: GRIS });
      y -= 14;
    }
  });

  const paginas = pdf.getPages();
  paginas.forEach((p, i) => {
    const texto = sanear(`${pie} · Página ${i + 1} de ${paginas.length}`);
    const ancho = normal.widthOfTextAtSize(texto, 8);
    p.drawText(texto, { x: (AN - ancho) / 2, y: MG / 2, size: 8, font: normal, color: GRIS });
  });
  return pdf.save();
}

// Genera los PDF del paquete. Sin plan ni nombre, deja los campos en blanco (plantillas para revisar).
async function generarDocumentos(pedido, proveedor) {
  const datos = valores(proveedor, pedido);
  const marca = (proveedor && proveedor.marca) || 'Paquete de bienvenida';
  const documentos = [];
  for (const doc of DOCUMENTOS.filter(d => !d.opcional || pedido.instrucciones)) {
    const markdown = fs.readFileSync(path.join(CARPETA, 'plantillas', `${doc.id}.md`), 'utf8');
    const bloques = parsearMarkdown(sustituir(markdown, datos));
    const titulo = bloques.find(b => b.tipo === 'h1');
    const bytes = await renderPdf(bloques, `${marca} · Paquete de bienvenida`);
    documentos.push({ nombre: doc.archivo, titulo: titulo ? titulo.texto : doc.id, bytes });
  }
  return documentos;
}

module.exports = { DOCUMENTOS, VERSION_PAQUETE, cargarProveedor, camposPendientesProveedor, proveedorCompleto, generarDocumentos };
