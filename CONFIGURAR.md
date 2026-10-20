# Configuración de pagos y correo

Todo el código ya está listo. Lo que falta son las llaves de tu cuenta y algunos datos del negocio. Esta guía sigue el orden en que conviene hacerlo. En cualquier momento puedes ejecutar `npm run verificar` para ver qué falta.

## Lo que necesitas antes de empezar

- Cuenta de comercio en Wompi, con acceso al Dashboard.
- Cuenta en Resend y un dominio verificado para el correo. Sin esto, el pago funciona, pero el paquete no llega por correo.
- Acceso a Vercel, al proyecto del sitio. Según el repositorio, el sitio está en `https://onepage-navy.vercel.app`.
- Datos del proveedor: nombre o razón social, CC o NIT, ciudad, dirección, correo, teléfono y marca.

## 1. Revisa el código en tu equipo (opcional, pero recomendado)

```bash
npm install
cp .env.example .env
npm run verificar
```

Verás líneas `[FALTA]` en lo que aún no tienes. Es normal al principio.

## 2. Llaves de Wompi (pruebas)

En el Dashboard de Wompi, busca la sección de llaves o de desarrolladores y copia estos valores en `.env`:

| Variable | Qué es |
|---|---|
| `WOMPI_ENV` | `sandbox` para pruebas. Déjalo así hasta que termines la prueba completa. |
| `WOMPI_PUBLIC_KEY` | Llave pública de pruebas. Normalmente empieza por `pub_test_`. |
| `WOMPI_INTEGRITY_SECRET` | Secreto de integridad de pruebas. Firma cada pago. Nunca se envía al navegador. |
| `WOMPI_EVENTS_SECRET` | Secreto de eventos de pruebas. Verifica los avisos que Wompi envía al sitio. |
| `WOMPI_PRIVATE_KEY` | Opcional. Úsala solo si `npm run verificar` indica que Wompi pide autorización para consultar transacciones. |

## 3. Variables en Vercel

En Vercel, entra al proyecto y ve a **Settings → Environment Variables**. Agrega las mismas variables de `.env`:

- `WOMPI_ENV`, `WOMPI_PUBLIC_KEY`, `WOMPI_INTEGRITY_SECRET`, `WOMPI_EVENTS_SECRET` (y `WOMPI_PRIVATE_KEY` si la necesitas).
- `PUBLIC_URL`: la dirección del sitio, sin barra final. Por ejemplo, `https://onepage-navy.vercel.app`.
- `PROVEEDOR_JSON`: los datos del proveedor en una sola línea JSON.
- `RESEND_API_KEY` y `EMAIL_FROM`, cuando tengas Resend.

Las variables solo se aplican a despliegues nuevos. Después de agregarlas, haz **Redeploy** del último despliegue.

## 4. Conecta el webhook de Wompi

En el Dashboard de Wompi, ambiente de pruebas, configura la URL de eventos (webhook):

```
https://onepage-navy.vercel.app/api/wompi/webhook
```

Revisa que el secreto de eventos de Wompi sea el mismo que pusiste en `WOMPI_EVENTS_SECRET`. Si cambias de dominio, cambia también esta URL.

## 5. Prueba completa en sandbox

1. Abre el sitio, responde el cuestionario y pulsa **Comprar este modelo**.
2. Llena nombre y correo, acepta el paquete y paga con una tarjeta de prueba de Wompi. Las tarjetas de prueba vienen en la documentación de Wompi.
3. Debes volver a la página **Estado de tu pago** y ver "Pago aprobado".
4. Revisa los logs de Vercel. Deben aparecer estas líneas:
   - `[consentimiento]`: se registró la aceptación.
   - `[wompi] … APPROVED`: llegó el aviso de pago.
   - `[paquete] … enviado con 5 documentos`: el paquete salió por correo. Si aparece otro mensaje, dice qué falta.
5. Si configuraste Resend, revisa el correo: deben llegar los PDF.

Sin hacer un pago, también puedes probar:

```bash
npm run verificar -- --enlace                 # imprime un enlace de pago de prueba
npm run verificar -- --correo tu@correo.com   # envía un paquete de prueba por Resend
```

## 6. Pasar a producción

Cuando la prueba haya salido bien:

1. Cambia `WOMPI_ENV` a `production` y pon las llaves y secretos del ambiente de producción en Vercel.
2. Configura la URL de eventos también en el ambiente de producción de Wompi.
3. Revisa la configuración con `npm run verificar -- --produccion`, usando las mismas variables que en Vercel.
4. Haz una compra real de prueba y confirma que el dinero llega a tu cuenta de Wompi.

## 7. Publicar cambios

Cada cambio que subes a `main` se despliega solo en Vercel, siempre que el proyecto siga conectado al repositorio. Antes de subir, ejecuta `npm run verificar`.

## Lo que queda en tus manos

- **Wompi:** suele pedir a los comercios datos de la empresa, términos y condiciones, política de privacidad y política de devoluciones antes de aprobar la cuenta. Publica esas páginas y enlázalas desde el sitio.
- **Legal y contable:** revisa el contrato y la política de datos con un abogado, y la cuenta de cobro con tu contador. Los detalles están en el README.
- **Base de datos:** pedidos y registro de aceptaciones. Hoy todo queda en los logs. Es el siguiente paso técnico pendiente.

## Problemas frecuentes

| Lo que ves | Qué revisar |
|---|---|
| "La compra todavía no está disponible en este sitio" | El sitio no está ejecutando las funciones `/api`. Revisa que el proyecto de Vercel esté conectado a este repositorio y que el último despliegue esté listo. |
| "Los pagos todavía no están configurados" | Falta alguna variable de Wompi en ese ambiente. Ejecuta `npm run verificar`. |
| El webhook responde "Firma inválida" | `WOMPI_EVENTS_SECRET` no es del mismo ambiente que la URL de eventos (pruebas o producción). |
| El pago está aprobado, pero no llega el correo | En los logs busca `[paquete]`. Dice si faltan datos del cliente, datos del proveedor o la configuración de Resend. |
| `verificar` no puede conectar con Wompi | Revisa la conexión de tu equipo. Si Wompi responde 401 o 403, define `WOMPI_PRIVATE_KEY`. |
