# Arquitectura digital

Página de presentación con cuestionario. Al terminar, el visitante recibe un modelo recomendado, puede comprarlo con Wompi y acepta el paquete de bienvenida.

**Para configurar los pagos y el correo, sigue [CONFIGURAR.md](CONFIGURAR.md).** Puedes revisar en cualquier momento lo que falta con `npm run verificar`.

## Estructura

| Archivo o carpeta | Qué es |
|---|---|
| `index.html`, `code.html` | Las páginas con el cuestionario. Son iguales. |
| `cuestionario.js`, `cuestionario.css` | El cuestionario y la compra. Los usan las dos páginas. |
| `pago-resultado.html` | Página a la que vuelve el visitante después de pagar. |
| `api/wompi/` | Funciones del servidor: crear el pago, recibir avisos de Wompi y consultar el estado. |
| `lib/` | Lógica compartida: Wompi, documentos, correo y entrega del paquete. |
| `paquete/` | Plantillas, documentos de ejemplo y datos del proveedor. |
| `scripts/` | `verificar.js` (revisa la configuración) y `paquete.js` (genera documentos). |

## Cómo funciona la compra

1. El cuestionario recomienda un modelo (Landing, PYME, Empresarial o Tienda).
2. **Comprar este modelo** pide nombre, correo y la aceptación del paquete de bienvenida. El paquete de instrucciones y la encuesta son opcionales.
3. `POST /api/wompi/checkout` toma el precio desde `lib/wompi.js`, calcula la firma de integridad en el servidor y devuelve la URL de pago.
4. El visitante paga en la página segura de Wompi y vuelve a `pago-resultado.html?id=…`.
5. La página consulta el estado con `GET /api/wompi/transaction`.
6. Wompi envía cada cambio de estado a `POST /api/wompi/webhook`. El servidor verifica el checksum y, si el pago está aprobado, entrega el paquete de bienvenida.

El precio nunca viene del navegador: el servidor lo toma de `PLANES`.

## Agregar el cuestionario a otra página

Cualquier página puede tener la compra. Copia de `index.html`:

1. En `<head>`, el enlace a `cuestionario.css`.
2. El botón `#cta-button` y el bloque `<div class="quiz" id="quiz">` (con su formulario).
3. Al final del `<body>`, después de `escena-3d.js`, el script `cuestionario.js`.

Las rutas `paquete/documentos/…` y `pago-resultado.html` deben seguir funcionando desde la página nueva.

## Paquete de bienvenida

`paquete/documentos/` contiene los documentos con los campos en blanco, para revisión:

| Archivo | Contenido | Incluido |
|---|---|---|
| `01-contrato.pdf` | Contrato de prestación de servicios | Siempre |
| `02-cuenta-de-cobro.pdf` | Cuenta de cobro con la referencia del pago | Siempre |
| `03-pasos-siguientes.pdf` | Qué hacer después de pagar | Siempre |
| `04-instrucciones.pdf` | Guía de uso y buenas prácticas | Si lo acepta el cliente |
| `05-encuesta-satisfaccion.pdf` | Encuesta de satisfacción | Si lo acepta el cliente |

Las fuentes editables están en `paquete/plantillas/*.md`. Los campos `{{CAMPO}}` se llenan con los datos de cada compra.

```bash
# Regenerar los documentos con los campos en blanco
node scripts/paquete.js --proveedor paquete/proveedor.ejemplo.json --salida paquete/documentos

# Generar el paquete de un pedido concreto, por ejemplo para enviarlo a mano
node scripts/paquete.js --plan L --nombre "Ana Pérez" --correo ana@ejemplo.com --referencia PAG-L-I-… --instrucciones
```

### Datos del proveedor

Copia `paquete/proveedor.ejemplo.json` a `paquete/proveedor.json` y completa todos los campos. Ese archivo no se sube a git. En Vercel, define la variable `PROVEEDOR_JSON` con el mismo contenido en una sola línea. Si falta algún dato, el paquete no se envía.

### Envío

Con el pago aprobado, el webhook genera el paquete y lo envía por correo con [Resend](https://resend.com). Queda pendiente, y se registra en los logs, en estos casos:

- No hay correo configurado.
- La transacción no trae nombre o correo del cliente.
- El monto cobrado no coincide con el modelo.
- Faltan datos del proveedor.

En esos casos, genera el paquete con el comando de arriba y envíalo a mano.

### Registro de la aceptación

Cada compra deja un registro `[consentimiento]` en los logs, con la referencia, el correo, si pidió instrucciones y la versión del paquete (`paquete-2026-10`). Es un registro de logs, no una base de datos.

## Antes de usar los documentos

- **Abogado:** los documentos son un borrador, no asesoría legal. Revisa el contrato, en especial la cláusula de retracto (Ley 1480 de 2011) y la de datos personales (Ley 1581 de 2012).
- **Contador:** confirma que la cuenta de cobro es el documento correcto para tu régimen. Si facturas electrónicamente, debes emitir factura en lugar de cuenta de cobro. También confirma si los precios incluyen IVA o retenciones.
- **Política de datos:** publica una política de tratamiento de datos personales y enlázala desde el sitio.

## Ejecutar en local

```bash
npm install
cp .env.example .env     # llena las llaves de sandbox
npm run verificar        # revisa la configuración
npm start                # http://localhost:3000
```

Requiere Node 18 o superior. La única dependencia es `pdf-lib`, que genera los PDF.

## Publicar

El sitio está en Vercel (`https://onepage-navy.vercel.app`, según el repositorio). Las rutas `/api` necesitan un hosting con funciones. GitHub Pages solo sirve archivos estáticos: ahí el cuestionario se ve, pero la compra muestra que todavía no está disponible.

`vercel.json` incluye la carpeta `paquete/` en las funciones. Cada cambio que subes a `main` se despliega en Vercel.

## Pendiente

- Una base de datos para pedidos y para el registro de aceptaciones. Hoy todo vive en logs. Con una base de datos también se evitarían envíos duplicados si Wompi reintenta un aviso.
- Confirmar con un pago de prueba en sandbox los nombres de los campos que usa el código (`customer_data`, `customer_email`, `amount_in_cents`) y los parámetros del checkout (`customer-data:*`, `signature:integrity`).
