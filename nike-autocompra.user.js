// ==UserScript==
// @name         Autocompra Nike MX
// @namespace    https://rod97-ux.github.io/atajo-puente/
// @version      1.6.0
// @description  Desde el boton de talla de Discord (GENERAL y SNKRS): elige talla, agrega a la bolsa, llega al pago y elige OXXO. Nunca pulsa Realizar pedido.
// @match        https://www.nike.com/*
// @run-at       document-end
// @noframes
// @updateURL    https://rod97-ux.github.io/atajo-puente/nike-autocompra.meta.js
// @downloadURL  https://rod97-ux.github.io/atajo-puente/nike-autocompra.user.js
// ==/UserScript==

// Solo actua si la URL trae ?cb=<id> y #talla=<talla>[&a=<numeros de direccion>] (los pone el puente de Discord).
// Navegar a mano por Nike no dispara nada. El id es Date.now() del toque: sirve de
// pagina fresca (URL nunca visitada), de "una sola vez por toque" y de cronometro.
// Comprueba en el pago la direccion de envio contra los numeros que llegan en el enlace (#a=);
// si no coincide, o si no llegaron, muestra ADDRESS FAIL.
// REGLA FIJA: este script NUNCA pulsa "Realizar pedido" (#ticket-paynow y similares).
(() => {
  'use strict';

  // Una sola copia por documento: en el iPhone el pago se inyecto DOS veces (visto en el informe
  // del grabador) y dos copias corriendo a la vez repiten pasos. El marcador vive en <html>.
  if (document.documentElement.getAttribute('data-nkac')) return;
  document.documentElement.setAttribute('data-nkac', '1');

  const KEY = 'nkac_run';     // estado de la corrida (sessionStorage, solo esta pestana)
  const DONE = 'nkac_done';   // ultimo id terminado (evita repetir al volver atras)
  const TTL = 120000;         // ms desde el toque; pasado esto no actua
  const MAX_RELOADS = 2;      // recargas frescas si la talla sale agotada
  const TALLA_RE = /^[A-Za-z0-9.,\/ -]{1,8}$/;
  // Los numeros de direccion permitidos NO estan en este archivo (es publico): los pone el bot,
  // desde su configuracion privada, en el enlace del boton (#a=...). Se lee en beginRun().
  const ADDR_RE = /^\d{3,6}(,\d{3,6}){0,4}$/;

  const sget = (k) => { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } };
  const sset = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin storage */ } };

  const VERSION = '1.6.0';

  let box = null;
  function say(msg, kind) {
    // El aviso cuelga de <html> (no de <body>): si la pagina vuelve a dibujar el <body> (SNKRS)
    // el aviso no desaparece; y si aun asi lo quitan, se vuelve a poner.
    const host = document.documentElement;
    if (!host) return;
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:2147483647;padding:10px 12px;' +
        'border-radius:10px;font:600 14px/1.3 -apple-system,sans-serif;color:#fff;pointer-events:none;' +
        'box-shadow:0 2px 10px rgba(0,0,0,.35)';
    }
    if (!box.isConnected) host.appendChild(box);
    box.style.background = kind === 'ok' ? '#1a7f37' : kind === 'fail' ? '#7f1d1d' : kind === 'err' ? '#b42318' : '#1f2937';
    box.style.fontSize = kind === 'fail' ? '32px' : '14px';
    box.style.textAlign = kind === 'fail' ? 'center' : 'left';
    box.style.border = kind === 'fail' ? '3px solid #fff' : 'none';
    box.textContent = msg;
  }

  // Espera event-driven: reintenta al cambiar el DOM (y cada 100 ms como respaldo para
  // cambios que no tocan el DOM). Sin retardos aleatorios ni esperas fijas.
  function waitFor(test, timeoutMs) {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (v) => {
        if (finished) return;
        finished = true;
        obs.disconnect();
        clearInterval(iv);
        clearTimeout(tm);
        resolve(v);
      };
      const check = () => {
        if (finished) return;
        let v = null;
        try { v = test(); } catch (e) { v = null; }
        if (v) finish(v);
      };
      const obs = new MutationObserver(check);
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      const iv = setInterval(check, 100);
      const tm = setTimeout(() => finish(null), timeoutMs);
      check();
    });
  }

  const secs = (id) => ((Date.now() - id) / 1000).toFixed(1);
  const norm = (s) => (s || '').replace(/\s+/g, ' ').toLowerCase().trim();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // "A la vista" sin usar offsetParent (es null en elementos position:fixed, como la barra movil).
  const isShown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  function endRun(run, kind, msg) {
    sset(DONE, run.id);
    try { sessionStorage.removeItem(KEY); } catch (e) { /* nada */ }
    say(msg, kind);
  }

  // Del puente de GitHub? (Safari manda al menos el origen como referrer.)
  function cameFromBridge() {
    try { return new URL(document.referrer).hostname === 'rod97-ux.github.io'; } catch (e) { return false; }
  }

  // cb y #talla del enlace. Si la pagina (SPA) ya los borro de la URL, se recuperan de la URL
  // con la que se hizo la navegacion (Navigation Timing).
  function readLink() {
    let search = location.search;
    let hash = location.hash;
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav && nav.name) {
      try {
        const u = new URL(nav.name);
        if (!/[?&]cb=/.test(search) && /[?&]cb=/.test(u.search)) search = u.search;
        if (!/talla=/.test(hash) && /talla=/.test(u.hash)) hash = u.hash;
      } catch (e) { /* nada */ }
    }
    return { search, hash };
  }

  // Arranque comun de GENERAL y SNKRS: valida el enlace del puente (cb + #talla), evita repetir
  // un toque ya hecho o viejo, y deja el estado de la corrida. Devuelve null si no hay que actuar.
  function beginRun(kind) {
    const link = readLink();
    const q = new URLSearchParams(link.search);
    const id = Number(q.get('cb'));
    const m = /[#&]talla=([^&]+)/.exec(link.hash);
    let talla = '';
    try { talla = m ? decodeURIComponent(m[1]) : ''; } catch (e) { talla = ''; }
    // Numeros de direccion permitidos (los manda el bot en el enlace). Formato cerrado: 1 a 5
    // numeros de 3 a 6 digitos separados por coma; cualquier otra cosa se ignora (queda "sin configurar").
    const am = /[#&]a=([0-9,]+)/.exec(link.hash);
    const addr = am && ADDR_RE.test(am[1]) ? am[1].split(',') : [];
    // Si el enlace venia del puente (o trae cb) y aun asi no se actua, decir POR QUE en pantalla.
    // Navegar a mano por Nike (sin cb y sin venir del puente) sigue sin mostrar nada.
    const decline = (why) => {
      if (cameFromBridge() || q.get('cb')) say('Autocompra ' + VERSION + ': no actua - ' + why, 'err');
      return null;
    };
    if (!id || !/^\d{6,16}$/.test(String(id))) return decline('la URL no trae el numero cb del puente');
    if (!TALLA_RE.test(talla)) return decline('la URL no trae la talla (#talla)');
    if (sget(DONE) === id) return decline('este toque ya se uso');
    if (Date.now() - id > TTL) return decline('toque viejo (' + secs(id) + ' s)');

    const prev = sget(KEY);
    const reloads = prev && prev.id === id ? prev.reloads || 0 : 0;
    const run = { id, talla, reloads, kind, step: 'pdp', addr };

    // Diagnostico de frescura: KB realmente bajados de la red para ESTA pagina.
    const nav = performance.getEntriesByType('navigation')[0];
    const kb = nav ? Math.round(nav.transferSize / 1024) : -1;
    run.diag = kb > 20 ? 'pagina fresca ' + kb + 'KB' : 'ATENCION pagina de cache/304 (' + kb + 'KB)';
    sset(KEY, run);
    say('Autocompra: talla ' + talla + ' (' + run.diag + ')...');
    return run;
  }

  // Si la talla no aparece disponible puede ser una pagina vieja: recargar fresca (max. MAX_RELOADS).
  function freshReload(run) {
    if (run.reloads >= MAX_RELOADS) return false;
    run.reloads += 1;
    sset(KEY, run);
    say('Talla ' + run.talla + ' no disponible (posible pagina vieja). Recarga fresca ' + run.reloads + '/' + MAX_RELOADS + '...');
    const u = new URL(location.href);
    u.searchParams.set('cb', String(run.id));   // por si la pagina ya lo habia borrado de la URL
    u.searchParams.set('r', String(run.reloads));
    u.hash = '#talla=' + encodeURIComponent(run.talla) + (run.addr && run.addr.length ? '&a=' + run.addr.join(',') : '');
    location.replace(u.href);
    return true;
  }

  // ---------- Pagina de producto: GENERAL (/mx/t/) ----------
  async function pdp() {
    const run = beginRun('general');
    if (!run) return;
    const { id, talla } = run;

    // 1) que termine la consulta de disponibilidad de la pagina (o 8 s)
    await waitFor(() => performance.getEntriesByType('resource')
      .some((e) => e.name.indexOf('product_details_availability') >= 0 && e.responseEnd > 0), 8000);

    // 2) la talla existe y esta disponible
    const inp = await waitFor(() => {
      const el = document.getElementById('grid-selector-input-' + talla);
      return el && !el.disabled && !el.closest('[aria-disabled="true"]') ? el : null;
    }, 5000);

    if (!inp) {
      if (freshReload(run)) return;
      endRun(run, 'err', 'Talla ' + talla + ' sigue agotada tras ' + (MAX_RELOADS + 1) + ' cargas frescas. No se agrego nada. (' + run.diag + ')');
      return;
    }

    // 3) marcar la talla (click en su label) y comprobar que quedo marcada
    const label = Array.prototype.find.call(document.querySelectorAll('label'), (l) => l.htmlFor === inp.id);
    let marked = false;
    for (let i = 0; i < 3 && !marked; i++) {
      (label || inp).click();
      marked = !!(await waitFor(() => inp.checked, 700));
    }
    if (!marked) {
      endRun(run, 'err', 'No pude marcar la talla ' + talla + '. Hazlo a mano. (' + run.diag + ')');
      return;
    }

    // 4) Agregar a la bolsa. En el movil puede haber varios (barra fija + normal): tomar el
    // primero que este habilitado y a la vista; si no hay ninguno con testid, buscar por texto.
    const atbCands = () => Array.prototype.filter.call(document.querySelectorAll('button'),
      (b) => b.getAttribute('data-testid') === 'atb-button' || /agregar a la bolsa/i.test(b.textContent || ''));
    const atb = await waitFor(() => atbCands().find(
      (b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true' && isShown(b)) || null, 5000);
    if (!atb) {
      const info = atbCands().map((b) => (b.getAttribute('data-testid') || 'sin-testid') + '[dis=' + b.disabled +
        ',aria=' + b.getAttribute('aria-disabled') + ',vis=' + isShown(b) + ']').join(' ') || 'ninguno';
      endRun(run, 'err', 'No encontre Agregar a la bolsa (' + info + '). Talla ' + talla + ' marcada. (' + run.diag + ')');
      return;
    }
    run.sizeText = ((label && label.textContent) || '').replace(/\s+/g, ' ').trim();
    const h1 = document.getElementById('pdp_product_title');
    run.name = ((h1 && h1.textContent) || '').replace(/\s+/g, ' ').trim();
    run.step = 'toCheckout';
    sset(KEY, run);
    atb.click();
    say('Talla ' + talla + ' agregada. Esperando COMPRAR...');

    // 5) el popup "Comprar" se cierra solo: pulsarlo en cuanto aparece
    const buy = await waitFor(() => {
      const b = document.querySelector('button[data-testid="qa-cart-checkout"]');
      return b && !b.disabled ? b : null;
    }, 8000);
    if (!buy) {
      endRun(run, 'err', 'No aparecio COMPRAR. Revisa tu bolsa a mano. (' + run.diag + ')');
      return;
    }
    buy.click();
    say('COMPRAR pulsado. Abriendo pago... (' + secs(id) + 's desde el toque)');
  }

  // ---------- Pagina de producto: SNKRS (/mx/launch/t/) ----------
  // Distinta a GENERAL: la talla es un boton (#size_item_radio<talla>), la compra es "Comprar $X"
  // (se habilita al elegir talla) y NO hay popup con COMPRAR: hay que pasar por la bolsa.
  async function pdpSnkrs() {
    const run = beginRun('snkrs');
    if (!run) return;
    const { id, talla } = run;

    // 1) el boton de la talla existe, esta habilitado y a la vista
    const sizeBtn = await waitFor(() => {
      const b = document.getElementById('size_item_radio' + talla);
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && isShown(b) ? b : null;
    }, 8000);
    if (!sizeBtn) {
      if (freshReload(run)) return;
      const ids = Array.prototype.map.call(document.querySelectorAll('button.size-grid-button'),
        (b) => b.id.replace('size_item_radio', '')).join(',') || 'ninguna';
      endRun(run, 'err', 'Talla ' + talla + ' no disponible en SNKRS tras ' + (MAX_RELOADS + 1) + ' cargas frescas (tallas vistas: ' + ids + '). No se agrego nada. (' + run.diag + ')');
      return;
    }

    // 2) elegir la talla. En el iPhone "Comprar $X" YA viene habilitado antes de elegir talla (visto
    // en el informe del grabador), asi que NO sirve de senal: la talla se toca SIEMPRE, una sola vez
    // (un segundo toque podria des-elegirla), se deja un instante para que la pagina registre la
    // eleccion y solo entonces se busca y pulsa Comprar.
    const buyCta = () => Array.prototype.find.call(document.querySelectorAll('button'),
      (b) => /^comprar/i.test((b.textContent || '').trim()) && isShown(b)) || null;
    const ctaReady = () => {
      const b = buyCta();
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    };
    sizeBtn.click();
    await new Promise((res) => setTimeout(res, 80));
    const cta = await waitFor(ctaReady, 3000);
    if (!cta) {
      const b = buyCta();
      endRun(run, 'err', 'No se habilito Comprar tras elegir la talla ' + talla + ' (' +
        (b ? b.textContent.trim().slice(0, 20) + '[dis=' + b.disabled + ']' : 'sin boton Comprar') + '). Hazlo a mano. (' + run.diag + ')');
      return;
    }

    // 3) comprar = agregar a la bolsa; guardar lo necesario para verificar en el pago
    run.sizeText = (sizeBtn.textContent || '').replace(/\s+/g, ' ').trim();
    const h1 = document.querySelector('h1');
    run.name = ((h1 && h1.textContent) || '').replace(/\s+/g, ' ').trim();
    run.step = 'toCart';
    sset(KEY, run);
    cta.click();
    say('Talla ' + talla + ' agregada (SNKRS). Confirmando bolsa...');

    // 4) esperar la confirmacion "Agregado a la bolsa" (trae el boton "Ver bolsa de compra")
    const added = await waitFor(() => Array.prototype.find.call(document.querySelectorAll('button'),
      (b) => /ver bolsa de compra/i.test(b.textContent || '') && isShown(b)) || null, 8000);
    if (!added) {
      const txt = Array.prototype.filter.call(document.querySelectorAll('button'), isShown)
        .map((b) => (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 16)).filter(Boolean).slice(0, 8).join(' | ');
      endRun(run, 'err', 'No confirmo "Agregado a la bolsa" (' + txt + '). Revisa tu bolsa a mano. (' + run.diag + ')');
      return;
    }
    // Navegacion completa (no clic en el popup) para que el script se vuelva a cargar en la bolsa.
    say('Agregado. Abriendo la bolsa... (' + secs(id) + 's desde el toque)');
    location.assign('https://www.nike.com/mx/cart');
  }

  // ---------- Bolsa (solo SNKRS pasa por aqui) ----------
  async function cart() {
    const run = sget(KEY);
    if (!run || run.step !== 'toCart' || Date.now() - run.id > TTL) return;
    if (sget(DONE) === run.id) return;
    say('Autocompra: en la bolsa, pasando a Pagar...');

    // PC: "Pagar" esta directo. iPhone (visto en el informe del grabador): primero hay que tocar
    // "Finalizar la compra" (barra de abajo, viene deshabilitada un momento) y ENTONCES aparece
    // "Pagar" ("Compra como miembro"). Se acepta cualquiera de los dos como punto de partida.
    const pagarBtn = () => {
      const b = document.querySelector('button[aria-label="Pagar"]');
      return b && !b.disabled && isShown(b) ? b : null;
    };
    const finalizarBtn = () => Array.prototype.find.call(document.querySelectorAll('button'),
      (b) => /^finalizar la compra/i.test((b.textContent || '').trim()) && !b.disabled && isShown(b)) || null;
    const first = await waitFor(() => pagarBtn() || finalizarBtn(), 12000);
    if (!first) {
      endRun(run, 'err', 'No encontre Pagar ni "Finalizar la compra" en la bolsa. Sigue a mano. (' + run.diag + ')');
      return;
    }
    // Debe haber exactamente 1 articulo A LA VISTA; si no, NO seguir (podria llevarse otros).
    const visibles = () => Array.prototype.filter.call(
      document.querySelectorAll('button[aria-label="Eliminar"]'), isShown).length;
    await waitFor(() => visibles() > 0, 5000);
    const n = visibles();
    if (n !== 1) {
      endRun(run, 'err', 'La bolsa tiene ' + n + ' articulos (esperaba 1). No segui a Pagar. (' + run.diag + ')');
      return;
    }
    let pagar = pagarBtn();
    if (!pagar) {
      first.click();
      say('Bolsa: abriendo el resumen de pago...');
      pagar = await waitFor(pagarBtn, 8000);
    }
    if (!pagar) {
      endRun(run, 'err', 'No aparecio Pagar despues de "Finalizar la compra". Sigue a mano. (' + run.diag + ')');
      return;
    }
    run.step = 'toCheckout';
    sset(KEY, run);
    pagar.click();
    say('Pagar pulsado. Abriendo el pago... (' + secs(run.id) + 's desde el toque)');
  }

  // ---------- Checkout ----------
  async function checkout() {
    const run = sget(KEY);
    if (!run || run.step !== 'toCheckout' || Date.now() - run.id > TTL) return;
    if (sget(DONE) === run.id) return;
    say('Autocompra: eligiendo OXXO...');

    const isOxxo = (r) => {
      const img = r.querySelector('img');
      return /oxxo/i.test((r.textContent || '') + ' ' + (img ? img.alt || '' : ''));
    };
    // En el movil la lista de pagos se vuelve a dibujar (aparece Apple Pay) y puede haber copias
    // ocultas: no guardar el elemento; buscar de nuevo, solo entre los visibles, en cada intento.
    const rowsAll = () => Array.prototype.slice.call(
      document.querySelectorAll('div.payment-method-button[role="button"]'));
    const findOxxo = () => rowsAll().find((r) => isOxxo(r) && isShown(r)) || null;
    const isSel = (r) => !!r && (r.classList.contains('selected') ||
      r.getAttribute('aria-pressed') === 'true' || r.getAttribute('aria-checked') === 'true');
    const oxxoInfo = () => {
      const rows = rowsAll();
      const ox = rows.filter(isOxxo);
      const sel = rows.find(isSel);
      return 'filas=' + rows.length + ' oxxo=' + ox.length + ' visibles=' + ox.filter(isShown).length +
        ' seleccionada=' + (sel ? norm(sel.textContent).slice(0, 14) || 'sin-texto' : 'ninguna');
    };
    const row0 = await waitFor(findOxxo, 15000);
    if (!row0) {
      endRun(run, 'err', 'No encontre OXXO a la vista (' + oxxoInfo() + '). Elige el metodo a mano. (' + run.diag + ')');
      return;
    }
    // Visto en el iPhone (informes del grabador): Nike vuelve a dibujar la lista de pagos ~1 s despues
    // de aparecer, asi que el PRIMER clic cae en una fila que se reemplaza. En lugar de esperar 1.2 s
    // para darse cuenta, se reintenta en cuanto esa fila deja de estar en la pagina.
    // Deja OXXO seleccionado (hasta 5 intentos); siempre busca la fila de nuevo, nunca reusa una vieja.
    const ensureOxxo = async () => {
      let ok = isSel(findOxxo());
      for (let i = 0; i < 5 && !ok; i++) {
        const r = await waitFor(findOxxo, 3000);
        if (!r) break;
        r.click();
        await waitFor(() => isSel(findOxxo()) || !r.isConnected, 1200);
        ok = isSel(findOxxo());
      }
      return ok;
    };
    const selected = await ensureOxxo();
    if (!selected) {
      endRun(run, 'err', 'No pude seleccionar OXXO (' + oxxoInfo() + '). Hazlo a mano. (' + run.diag + ')');
      return;
    }

    // Verificar el resumen del pedido: 1 solo articulo, cantidad 1, mismo producto, misma talla.
    // Se lee textContent (no innerText) porque en el iPhone el resumen puede estar plegado.
    // Hay 2 copias del resumen (movil/escritorio): tomar la primera que traiga articulos.
    const items = await waitFor(() => {
      for (const sum of document.querySelectorAll('esw-cart-summary')) {
        const list = sum.querySelectorAll('esw-cart-item');
        if (list.length) return Array.prototype.slice.call(list);
      }
      return null;
    }, 5000);

    const problems = [];
    if (!items) {
      problems.push('no pude leer el resumen del pedido (resumenes=' + document.querySelectorAll('esw-cart-summary').length + ')');
    } else {
      if (items.length !== 1) problems.push(items.length + ' articulos en el pedido (esperaba 1)');
      const it = items[0];
      const q = it.querySelector('.cart-item__quantity');
      const qty = q ? parseInt(norm(q.textContent), 10) : NaN;
      if (qty !== 1) problems.push('cantidad ' + (isNaN(qty) ? 'ilegible' : qty) + ' (esperaba 1)');
      const title = norm((it.querySelector('.cart-item__title') || {}).textContent);
      if (!run.name) problems.push('no pude verificar el producto');
      else if (title.indexOf(norm(run.name)) < 0) problems.push('el producto del pedido no es "' + run.name + '"');
      if (run.sizeText) {
        const sizeRe = new RegExp('(^|[^a-z0-9])' + esc(norm(run.sizeText)) + '($|[^a-z0-9])');
        if (!sizeRe.test(norm(it.textContent))) problems.push('talla distinta a ' + run.sizeText);
      }
    }

    // Direccion de ENVIO: la opcion seleccionada debe contener alguno de los numeros que mando el bot en
    // el enlace (#a=..., digitos completos). Solo se mira ese bloque (no toda la pagina) para que un
    // telefono o una tarjeta no den un falso OK. Si NO llegaron numeros la comprobacion no puede
    // hacerse, y eso cuenta como fallo: una direccion nunca se da por buena sin verificarla.
    const wantedAddr = Array.isArray(run.addr) ? run.addr : [];
    const addrEl = wantedAddr.length ? await waitFor(() => {
      const el = document.querySelector('esw-saved-addresses .toggle-option--selected .saved-addresses__address');
      return el && norm(el.textContent) ? el : null;
    }, 6000) : null;
    let addressFail = '';
    if (!wantedAddr.length) addressFail = 'sin configurar';
    else if (!addrEl) addressFail = 'no pude leer la direccion de envio';
    else if (!wantedAddr.some((n) => new RegExp('(^|\\D)' + n + '(\\D|$)').test(addrEl.textContent))) {
      addressFail = 'la direccion de envio no coincide con ninguna de las permitidas';
    }

    // Nike puede redibujar la lista mientras se verifica el pedido: confirmar OXXO justo antes del LISTO.
    if (!(await ensureOxxo())) problems.push('OXXO no quedo seleccionado');

    // Dejar el boton final a la vista y resaltado, SIN pulsarlo.
    const findPay = () => {
      const b = document.getElementById('ticket-paynow');
      return b && isShown(b) ? b : null;
    };
    const pay = await waitFor(findPay, 8000);
    const bad = addressFail || problems.length;
    const shown = pay ? await showPay(pay, bad ? '#b42318' : '#2ecc71') : false;

    if (addressFail) {
      endRun(run, 'fail', 'ADDRESS FAIL' + (wantedAddr.length ? '' : ' · SIN CONFIGURAR'));
    } else if (problems.length) {
      endRun(run, 'err', 'REVISA: ' + problems.join(' | ') + '. Verifica antes de tocar Realizar pedido. (' + run.diag + ')');
    } else if (!pay || !shown) {
      const payInfo = Array.prototype.map.call(document.querySelectorAll('button[id$="-paynow"]'),
        (b) => b.id + '[vis=' + isShown(b) + ']').join(' ') || 'ninguno';
      endRun(run, 'err', 'Todo verificado, pero no pude dejar Realizar pedido a la vista (' + payInfo + '). Buscalo abajo. (' + run.diag + ')');
    } else {
      endRun(run, 'ok', 'LISTO: ' + run.name + ' ' + run.sizeText + ' x1 + OXXO verificados. Toca REALIZAR PEDIDO (contorno verde). ' +
        secs(run.id) + 's desde el toque (' + run.diag + ')');
      watchOxxo(findOxxo, isSel);
    }
  }

  // Tras el LISTO, la lista de pagos puede volver a dibujarse (movil) y perder la seleccion.
  // Durante 20 s: si OXXO deja de estar seleccionado, en los primeros 3 s se vuelve a marcar
  // (max. 2 veces); despues solo se avisa en rojo, para no pelear con un cambio hecho a mano.
  function watchOxxo(findOxxo, isSel) {
    const t0 = Date.now();
    let fixes = 0;
    let warned = false;
    const check = () => {
      if (warned) return;
      const r = findOxxo();
      if (isSel(r)) return;
      if (r && Date.now() - t0 < 3000 && fixes < 2) { fixes++; r.click(); return; }
      // Avisar UNA vez y desconectar: el aviso cambia el DOM y volveria a disparar este observador.
      warned = true;
      obs.disconnect();
      say('OXXO dejo de estar seleccionado. Revisalo antes de pagar.', 'err');
    };
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    check();   // revisar tambien AHORA: un cambio anterior a esta vigilancia no dispara el observador
    setTimeout(() => obs.disconnect(), 20000);
  }

  // Centra "Realizar pedido", le pone contorno fijo y confirma que quedo visible. NUNCA lo pulsa.
  async function showPay(pay, color) {
    pay.style.outline = '4px solid ' + color;
    pay.style.outlineOffset = '3px';
    await waitFor(() => document.readyState === 'complete', 3000);
    for (let i = 0; i < 4; i++) {
      pay.scrollIntoView({ block: 'center' });
      const visible = await waitFor(() => {
        const r = pay.getBoundingClientRect();
        return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight ? true : null;
      }, 400);
      if (visible) return true;
    }
    return false;
  }

  const path = location.pathname;
  // Latido: si se llego desde el puente, el script avisa que esta vivo (si no sale, no esta corriendo).
  // (Safari no manda el referrer del puente y SNKRS borra el ?cb de la barra, asi que tambien se mira la
  // URL con la que se hizo la navegacion.)
  if (cameFromBridge() || /[?&]cb=/.test(readLink().search)) say('Autocompra ' + VERSION + ' activo (' + path.slice(0, 24) + ')...');
  if (path.indexOf('/mx/t/') === 0) pdp();
  else if (path.indexOf('/mx/launch/t/') === 0) pdpSnkrs();
  else if (path.indexOf('/mx/cart') === 0) cart();
  else if (path.indexOf('/gs/checkout/') === 0) checkout();
})();
