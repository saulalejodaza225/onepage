# Arquitectura digital

Página de presentación con cuestionario. Al terminar, el visitante recibe un modelo recomendado y puede comprarlo con Wompi.

## Cómo funciona la compra

1. El cuestionario recomienda un modelo (Landing, PYME, Empresarial o Tienda).
2. "Comprar este modelo" pide nombre y correo.
3. `POST /api/wompi/checkout` toma el precio desde `lib/wompi.js`, calcula la firma de integridad en el servidor y devuelve la URL de pago.
4. El visitante paga en la página segura de Wompi y vuelve a `pago-resultado.html?id=…`.
5. La página consulta el estado con `GET /api/wompi/transaction`.
6. Wompi envía cada cambio de estado a `POST /api/wompi/webhook`. El servidor verifica el checksum antes de aceptarlo.

El precio nunca viene del navegador: el servidor lo toma de `PLANES`.

## Ejecutar en local

```bash
cp .env.example .env     # llena las llaves de sandbox
npm start                # http://localhost:3000
```

Requiere Node 18 o superior. No tiene dependencias externas.

## Publicar

Las rutas `/api` necesitan un hosting con funciones (por ejemplo Vercel). GitHub Pages solo sirve archivos estáticos y no puede cobrar.

1. Importa el repositorio en Vercel.
2. Configura las mismas variables de `.env.example` en Vercel, con `PUBLIC_URL` igual a tu dominio.
3. En el Dashboard de Wompi, configura la URL de eventos como `https://tu-dominio/api/wompi/webhook`.
4. Cuando las pruebas en sandbox funcionen, cambia `WOMPI_ENV=production` y usa las llaves de producción.

## Pendiente

- El webhook solo verifica y registra en los logs. Para guardar pedidos y enviar confirmaciones hace falta una base de datos y un servicio de correo.
- Los nombres de parámetros del checkout (`customer-data:*`, `signature:integrity`) y la fórmula de firma siguen la documentación pública de Wompi. Confírmalos con un pago de prueba en sandbox antes de cobrar.
