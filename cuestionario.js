// Cuestionario y compra: lo usan index.html y code.html; cualquier página con el bloque .quiz puede cargarlo.
// Cuestionario: 5 preguntas; cada respuesta suma puntos a los cuatro modelos
// (L = Landing, P = PYME, E = Empresarial, T = Tienda). Gana el de más puntos;
// en empate, el primero de la lista. Mismos precios y demos que el sitio.
// "Volver" solo minimiza: al abrirlo de nuevo sigue en la misma pregunta o muestra el resultado;
// únicamente "Volver a empezar" lo reinicia.
(function () {
  var PREGUNTAS = [
    { q: '¿Qué tiene hoy tu negocio en línea?', o: [
      { t: 'Nada todavía', p: { L: 2 } },
      { t: 'Redes sociales o una página básica', p: { P: 2 } },
      { t: 'Un catálogo amplio de productos o servicios', p: { E: 2 } },
      { t: 'Quiero vender y cobrar en línea', p: { T: 2 } }
    ] },
    { q: '¿Quién actualizará el contenido?', o: [
      { t: 'Inventario y pedidos al día', p: { T: 2 } },
      { t: 'Un equipo con varias personas', p: { E: 2 } },
      { t: 'Casi nunca cambiará, quiero una presencia fija', p: { L: 2 } },
      { t: 'Yo, sin depender de nadie', p: { P: 2, E: 1 } }
    ] },
    { q: '¿Cuántos productos o servicios quieres mostrar?', o: [
      { t: 'Uno o pocos (hasta 4 bloques)', p: { L: 2 } },
      { t: 'Entre 5 y 20', p: { P: 2 } },
      { t: 'Más de 20', p: { E: 1, T: 2 } }
    ] },
    { q: '¿Necesitas cobrar en línea con pasarela de pago?', o: [
      { t: 'Sí, con Wompi, PayU o PSE', p: { T: 3 } },
      { t: 'Por ahora no, pero lo planeo', p: { P: 1, E: 1 } },
      { t: 'No', p: { L: 1, P: 1, E: 1 } }
    ] },
    { q: '¿Cómo describirías tu negocio?', o: [
      { t: 'Independiente o emprendimiento con un servicio principal', p: { L: 2 } },
      { t: 'Negocio local: consultorio, restaurante, taller o estudio', p: { P: 2 } },
      { t: 'Empresa con varias áreas, sedes o líneas de servicio', p: { E: 2 } },
      { t: 'Comercio con productos para vender y enviar', p: { T: 2 } }
    ] }
  ];
  var MODELOS = {
    L: { nombre: 'Landing Page', precio: '$675.000', entrega: 'Entrega: 5 días', demo: 'https://landing-page-demo-ruby.vercel.app/',
         texto: 'Ideal para un negocio que hoy no tiene nada en línea y quiere empezar a recibir clientes.' },
    P: { nombre: 'Página PYME', precio: '$1.080.000', entrega: 'Entrega: 8 días', demo: 'https://modelo-pyme-demo.vercel.app/',
         texto: 'Ideal para un negocio que quiere poder actualizar su propia web sin depender de terceros.' },
    E: { nombre: 'Página Empresarial', precio: '$1.620.000', entrega: 'Entrega: 12 días', demo: 'https://dise-o-empresarial-demo.vercel.app/',
         texto: 'Ideal para un negocio que necesita mostrar un catálogo amplio de productos o servicios con prestancia.' },
    T: { nombre: 'Tienda Online', precio: '$2.160.000', entrega: 'Entrega: 15 días', demo: 'https://e-store-demo1.vercel.app/',
         texto: 'Ideal para un negocio que quiere vender y cobrar en línea directamente con pasarela de pagos.' }
  };
  var ORDEN = ['L', 'P', 'E', 'T'];

  var cta = document.getElementById('cta-button');
  var textos = document.querySelector('.text-block'), botonera = document.querySelector('.button-wrapper');
  var quiz = document.getElementById('quiz');
  var barra = quiz.querySelector('.quiz-bar span'), contador = quiz.querySelector('.quiz-count'), pregunta = quiz.querySelector('.quiz-q');
  var opciones = quiz.querySelector('.quiz-options'), resultado = quiz.querySelector('.quiz-result');
  var form = quiz.querySelector('.quiz-checkout'), formError = form.querySelector('.quiz-co-error'), formBtn = form.querySelector('button[type="submit"]');
  var paso = 0, puntos = { L: 0, P: 0, E: 0, T: 0 }, iniciado = false, terminado = false, seleccion = ORDEN[0];

  function mostrarPaso() {
    var p = PREGUNTAS[paso];
    contador.textContent = 'Pregunta ' + (paso + 1) + ' de ' + PREGUNTAS.length;
    barra.style.width = (paso / PREGUNTAS.length * 100) + '%';
    pregunta.textContent = p.q; pregunta.hidden = false;
    opciones.innerHTML = '';
    p.o.forEach(function (op) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = op.t;
      b.addEventListener('click', function () { responder(op.p); });
      opciones.appendChild(b);
    });
    opciones.hidden = false; resultado.hidden = true; form.hidden = true; formError.hidden = true;
    pregunta.focus({ preventScroll: true });
  }
  function responder(suma) {
    Object.keys(suma).forEach(function (k) { puntos[k] += suma[k]; });
    paso++;
    if (paso < PREGUNTAS.length) mostrarPaso(); else mostrarResultado();
  }
  function mostrarResultado() {
    var mejor = ORDEN[0];
    ORDEN.forEach(function (k) { if (puntos[k] > puntos[mejor]) mejor = k; });
    seleccion = mejor;
    var m = MODELOS[mejor];
    contador.textContent = 'Tu resultado';
    barra.style.width = '100%';
    pregunta.hidden = true; opciones.hidden = true; opciones.innerHTML = '';
    quiz.querySelector('.quiz-r-name').textContent = m.nombre;
    quiz.querySelector('.quiz-r-price').textContent = m.precio;
    quiz.querySelector('.quiz-r-time').textContent = m.entrega;
    quiz.querySelector('.quiz-r-text').textContent = m.texto;
    var demo = quiz.querySelector('.quiz-demo');
    demo.href = m.demo; demo.setAttribute('aria-label', 'Ver demo de ' + m.nombre + ' (se abre en una pestaña nueva)');
    resultado.hidden = false; terminado = true;
    quiz.querySelector('.quiz-r-name').focus({ preventScroll: true });
  }
  function empezar() { paso = 0; puntos = { L: 0, P: 0, E: 0, T: 0 }; iniciado = true; terminado = false; quiz.scrollTop = 0; mostrarPaso(); }
  function mostrarCompra() {
    var m = MODELOS[seleccion];
    form.querySelector('.quiz-co-summary').textContent = m.nombre + ' · ' + m.precio + ' COP';
    formError.hidden = true;
    resultado.hidden = true; form.hidden = false;
    form.elements.nombre.focus({ preventScroll: true });
  }
  function mostrarErrorCompra(texto) {
    formError.textContent = texto; formError.hidden = false;
    formBtn.disabled = false; formBtn.textContent = 'Pagar con Wompi';
  }

  cta.addEventListener('click', function () {
    textos.hidden = true; botonera.hidden = true; quiz.hidden = false;
    if (terminado) (form.hidden ? quiz.querySelector('.quiz-r-name') : form.elements.nombre).focus({ preventScroll: true });   // the result, or the form, is still there
    else if (iniciado) pregunta.focus({ preventScroll: true });   // back to the same question
    else empezar();
  });
  quiz.querySelector('.quiz-restart').addEventListener('click', empezar);
  quiz.querySelector('.quiz-back').addEventListener('click', function () {   // minimise only, nothing is lost
    quiz.hidden = true; textos.hidden = false; botonera.hidden = false;
    cta.focus({ preventScroll: true });
  });
  resultado.querySelector('.quiz-buy').addEventListener('click', mostrarCompra);
  form.querySelector('.quiz-co-back').addEventListener('click', function () {
    form.hidden = true; resultado.hidden = false;
    resultado.querySelector('.quiz-buy').focus({ preventScroll: true });
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var nombre = form.elements.nombre.value.trim(), correo = form.elements.correo.value.trim();
    if (!nombre || !form.elements.correo.checkValidity()) {
      mostrarErrorCompra('Escribe tu nombre y un correo válido.');
      return;
    }
    if (!form.elements.aceptaPaquete.checked) {
      mostrarErrorCompra('Acepta el paquete de bienvenida para continuar.');
      return;
    }
    formError.hidden = true; formBtn.disabled = true; formBtn.textContent = 'Conectando con Wompi…';
    fetch('/api/wompi/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: seleccion,
        nombre: nombre,
        correo: correo,
        aceptaPaquete: form.elements.aceptaPaquete.checked,
        instrucciones: form.elements.instrucciones.checked
      })
    }).then(function (r) {
      // Sin funciones de servidor (solo archivos estáticos), /api no responde JSON: la compra no está disponible
      var esJson = (r.headers.get('content-type') || '').indexOf('application/json') !== -1;
      if (!esJson) throw new Error('La compra todavía no está disponible en este sitio.');
      return r.json().catch(function () { return {}; }).then(function (datos) {
        if (!r.ok) throw new Error(datos.error || 'No pudimos iniciar el pago. Intenta de nuevo.');
        return datos;
      });
    }).then(function (datos) {
      window.location.href = datos.checkoutUrl;
    }).catch(function (err) {
      mostrarErrorCompra(err.name === 'TypeError' ? 'Sin conexión con el servidor de pagos. Intenta de nuevo.' : err.message);
    });
  });
  // Al volver con el botón "atrás" del navegador, el botón de pago no debe quedar bloqueado
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) { formBtn.disabled = false; formBtn.textContent = 'Pagar con Wompi'; }
  });
})();
