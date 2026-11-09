// Ônibus ao Vivo SP — cabeçalho, tema claro/escuro, mapa e localização do usuário.
(function () {
  "use strict";
  var cfg = window.APP_CONFIG;
  var raiz = document.documentElement;

  // Se algo quebrar, mostra o erro na tela (no celular não há console para olhar)
  window.addEventListener("error", function (e) {
    var caixa = document.getElementById("aviso");
    if (!caixa || (e.filename && e.filename.indexOf(location.origin) !== 0)) return;
    caixa.textContent = "Erro no app: " + e.message;
    caixa.hidden = false;
  });

  document.getElementById("brandName").textContent = cfg.nome;

  /* ---------- Tema ---------- */
  var COR_BARRA = { dark: "#0f0f14", light: "#F5F3FF" };

  function temaAtual() {
    return raiz.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  function aplicarTema(tema) {
    raiz.setAttribute("data-theme", tema);
    document.getElementById("metaTema").setAttribute("content", COR_BARRA[tema]);
    try { localStorage.setItem("busjp-tema", tema); } catch (e) {}
    if (camadaMapa) camadaMapa.setUrl(cfg.mapa.urlTiles(tema));
  }

  /* ---------- Mapa ---------- */
  var mapa = L.map("map", {
    center: cfg.mapa.centro,
    zoom: cfg.mapa.zoom,
    minZoom: cfg.mapa.zoomMin,
    maxZoom: cfg.mapa.zoomMax,
    zoomControl: false,
    preferCanvas: true,
    renderer: L.canvas({ padding: 0.5, tolerance: 8 })   // pontos leves e fáceis de tocar
  });

  // Créditos: tira o prefixo "Leaflet" e deixa só o "i" recolhido.
  // (OpenStreetMap e CARTO exigem que o crédito continue acessível.)
  mapa.attributionControl.setPrefix(false);
  var atrib = mapa.attributionControl.getContainer();
  atrib.classList.add("colapsada");
  atrib.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("a")) return;
    atrib.classList.toggle("colapsada");
  });
  mapa.on("click", function () { atrib.classList.add("colapsada"); });

  var camadaMapa = L.tileLayer(cfg.mapa.urlTiles(temaAtual()), {
    attribution: cfg.mapa.atribuicao,
    detectRetina: true,
    maxZoom: cfg.mapa.zoomMax
  }).addTo(mapa);

  L.control.zoom({ position: "bottomright" }).addTo(mapa);

  document.getElementById("metaTema").setAttribute("content", COR_BARRA[temaAtual()]);

  document.getElementById("btnTema").addEventListener("click", function () {
    aplicarTema(temaAtual() === "dark" ? "light" : "dark");
  });

  window.addEventListener("resize", function () { mapa.invalidateSize(); });
  window.addEventListener("orientationchange", function () {
    setTimeout(function () { mapa.invalidateSize(); }, 200);
  });

  /* ---------- Aviso rápido ---------- */
  var aviso = document.getElementById("aviso");
  var timerAviso = null;
  function mostrarAviso(texto, duracaoMs) {
    aviso.textContent = texto;
    aviso.hidden = false;
    clearTimeout(timerAviso);
    timerAviso = setTimeout(function () { aviso.hidden = true; }, duracaoMs || 5000);
  }

  function ehIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);   // iPad novo
  }

  // Pede a localização logo no início, antes das outras etapas: assim, mesmo que
  // algo adiante falhe, o aparelho já recebeu o pedido de permissão.
  irParaMim(false);

  /* ---------- Paradas de ônibus ---------- */
  var indiceParadas = null;
  var camadaParadas = L.layerGroup().addTo(mapa);

  // Ao tocar numa parada, abre o painel com as previsões de chegada
  function aoSelecionarParada(parada) {
    Painel.abrir(parada);
  }

  function desenharParadas() {
    camadaParadas.clearLayers();
    // Com o painel aberto, só a parada escolhida fica no mapa
    if (!indiceParadas || Painel.estaAberto() || mapa.getZoom() < cfg.paradas.zoomMinimo) return;

    var area = mapa.getBounds();
    var centro = mapa.getCenter();
    var lista = indiceParadas.emRetangulo(
      area.getSouth(), area.getWest(), area.getNorth(), area.getEast()
    );

    // Se houver pontos demais, fica com os mais próximos do centro da tela
    if (lista.length > cfg.paradas.maxMarcadores) {
      lista.sort(function (a, b) {
        return distancia2(a, centro) - distancia2(b, centro);
      });
      lista = lista.slice(0, cfg.paradas.maxMarcadores);
    }

    lista.forEach(function (parada) {
      L.circleMarker([parada.lat, parada.lon], {
        radius: 7,
        color: "#ffffff",
        weight: 2,
        fillColor: "#8B5CF6",
        fillOpacity: 1
      }).on("click", function () { aoSelecionarParada(parada); })
        .addTo(camadaParadas);
    });
  }

  // Distância ao quadrado (basta para ordenar do mais perto ao mais longe)
  function distancia2(parada, centro) {
    var dLat = parada.lat - centro.lat;
    var dLon = parada.lon - centro.lng;
    return dLat * dLat + dLon * dLon;
  }

  Painel.iniciar(mapa, cfg, function () { return indiceParadas; });
  // Lupa: busca de linhas. Se o arquivo da busca não carregar, o resto do app continua funcionando.
  if (window.Busca) {
    window.Busca.iniciar(function (linha) { Painel.abrirLinha(linha); });
  } else {
    console.warn("js/busca.js não foi carregado: a busca de linhas não vai funcionar.");
    document.getElementById("btnBusca").addEventListener("click", function () {
      mostrarAviso("A busca não está disponível agora. Recarregue a página.");
    });
  }

  // Painel abriu: esconde as outras paradas. Painel fechou: elas voltam.
  document.addEventListener("painel:mudou", function () {
    setTimeout(desenharParadas, 0);
  });

  mapa.on("moveend", desenharParadas);

  Paradas.carregar(cfg.paradas.arquivo).then(function (indice) {
    indiceParadas = indice;
    desenharParadas();
    if (mapa.getZoom() < cfg.paradas.zoomMinimo) {
      mostrarAviso("Aproxime o mapa para ver os pontos de ônibus.");
    }
  }).catch(function () {
    mostrarAviso("Não foi possível carregar os pontos de ônibus.");
  });

  /* ---------- Localização do usuário ---------- */

  // Marcador da posição do usuário: um pino simples (gota com um círculo branco e a
  // sombra no chão), na cor roxa do tema. A ponta do pino fica exatamente na posição.
  var PINO_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 60" width="48" height="60" aria-hidden="true">' +
    '<ellipse cx="24" cy="52" rx="19" ry="6" fill="#5B21B6"/>' +
    '<path d="M24 3C14.6 3 7 10.4 7 19.6 7 31 20 44 24 51 28 44 41 31 41 19.6 41 10.4 33.4 3 24 3Z" fill="#8B5CF6"/>' +
    '<circle cx="24" cy="19.6" r="8" fill="#fff"/>' +
    '</svg>';

  var marcadorUsuario = null;
  var circuloPrecisao = null;
  var ultimaPosicao = null;   // [lat, lng] da última localização obtida

  function desenharUsuario(pos) {
    var ll = [pos.coords.latitude, pos.coords.longitude];
    ultimaPosicao = ll;

    if (circuloPrecisao) mapa.removeLayer(circuloPrecisao);
    if (marcadorUsuario) mapa.removeLayer(marcadorUsuario);

    circuloPrecisao = L.circle(ll, {
      radius: pos.coords.accuracy,
      color: "#8B5CF6", weight: 1, fillColor: "#8B5CF6", fillOpacity: 0.12,
      interactive: false
    }).addTo(mapa);

    marcadorUsuario = L.marker(ll, {
      icon: L.divIcon({
        className: "user-pin",
        html: PINO_SVG,
        iconSize: [48, 60],
        iconAnchor: [24, 52]          // a ponta do pino fica na posição do usuário
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000
    }).addTo(mapa);

    Painel.definirPosicaoUsuario(ll);   // usado no caminho a pé até a parada
    return ll;
  }

  function mensagemFalhaLocalizacao(err) {
    if (!window.isSecureContext) return "A localização só funciona em conexão segura (HTTPS).";
    if (err.code === 1) {
      return ehIOS()
        ? "Localização bloqueada. No iPhone: Ajustes > Privacidade e Segurança > Serviços de Localização > Sites do Safari > Ao Usar o App. Depois toque no botão de localização. (erro 1)"
        : "Localização bloqueada para este site. Toque no cadeado ao lado do endereço > Permissões > Localização > Permitir. Depois toque no botão de localização. (erro 1)";
    }
    if (err.code === 2) return "Não foi possível obter sua posição. Confira se a localização (GPS) do aparelho está ligada. (erro 2)";
    return "A localização demorou demais. Toque no botão de localização para tentar de novo. (erro 3)";
  }

  function falhaLocalizacao(err) {
    mostrarAviso(mensagemFalhaLocalizacao(err), 10000);
  }

  // Tenta com GPS (mais preciso). Se demorar ou falhar por outro motivo que não seja
  // permissão, tenta de novo com precisão menor, que costuma funcionar em ambientes fechados.
  function pedirPosicao(sucesso, falha) {
    navigator.geolocation.getCurrentPosition(sucesso, function (err) {
      if (err.code === 1) { falha(err); return; }
      navigator.geolocation.getCurrentPosition(sucesso, falha, {
        enableHighAccuracy: false,
        timeout: 15000,
        maximumAge: 60000
      });
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
  }

  // Pede a localização e centraliza o mapa nela (ponto do usuário no centro da tela)
  function irParaMim(comAnimacao) {
    if (!("geolocation" in navigator)) {
      mostrarAviso("Seu navegador não oferece localização.");
      return;
    }
    // Se já sabemos onde a pessoa está, volta na hora e atualiza em seguida
    if (ultimaPosicao) {
      mapa.flyTo(ultimaPosicao, cfg.mapa.zoomUsuario, { duration: 0.6 });
    }
    pedirPosicao(function (pos) {
      var ll = desenharUsuario(pos);
      if (comAnimacao || ultimaPosicao) {
        mapa.flyTo(ll, cfg.mapa.zoomUsuario, { duration: 0.6 });
      } else {
        mapa.setView(ll, cfg.mapa.zoomUsuario);
      }
    }, falhaLocalizacao);
  }

  // Botão no mapa (direita, acima do zoom)
  var ControleLocalizar = L.Control.extend({
    options: { position: "bottomright" },
    onAdd: function () {
      var caixa = L.DomUtil.create("div", "leaflet-bar leaflet-control controle-localizar");
      var botao = L.DomUtil.create("a", "", caixa);
      botao.href = "#";
      botao.setAttribute("role", "button");
      botao.setAttribute("title", "Ir para minha localização");
      botao.setAttribute("aria-label", "Ir para minha localização");
      botao.innerHTML =
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="3"></circle><circle cx="12" cy="12" r="8"></circle>' +
        '<line x1="12" y1="1" x2="12" y2="4"></line><line x1="12" y1="20" x2="12" y2="23"></line>' +
        '<line x1="1" y1="12" x2="4" y2="12"></line><line x1="20" y1="12" x2="23" y2="12"></line></svg>';
      L.DomEvent.disableClickPropagation(caixa);
      L.DomEvent.on(botao, "click", function (e) {
        L.DomEvent.preventDefault(e);
        irParaMim(true);
      });
      return caixa;
    }
  });
  new ControleLocalizar().addTo(mapa);

  /* ---------- Linhas de metrô e trem (liga/desliga) ---------- */
  // Desenho fixo das linhas sobre trilhos (cor oficial, traçado e estações), vindo de
  // /api/trilhos (GTFS da SPTrans). Fica por baixo dos traçados de ônibus. Não há posição
  // dos trens em tempo real: o Metrô e a CPTM não publicam esse dado.
  mapa.createPane("trilhos").style.zIndex = 390;   // abaixo da camada padrão (400)
  var camadaTrilhos = L.layerGroup();
  var camadaEstacoes = L.layerGroup();
  var dadosTrilhos = null;
  var trilhosLigados = false;
  var botaoTrilhos = null;

  function popupTexto(titulo, linhaTexto) {
    var raiz = document.createElement("div");
    var forte = document.createElement("strong");
    forte.textContent = titulo;
    raiz.appendChild(forte);
    if (linhaTexto) {
      var sub = document.createElement("div");
      sub.textContent = linhaTexto;
      raiz.appendChild(sub);
    }
    return raiz;
  }

  function desenharTrilhos() {
    camadaTrilhos.clearLayers();
    dadosTrilhos.linhas.forEach(function (linha) {
      if (!linha.polilinha) return;
      var pontos = Painel.decodificarPolilinha(linha.polilinha);
      L.polyline(pontos, { pane: "trilhos", color: "#ffffff", weight: 8, opacity: 0.35, interactive: false })
        .addTo(camadaTrilhos);
      L.polyline(pontos, { pane: "trilhos", color: "#" + linha.cor, weight: 5, opacity: 0.9 })
        .bindPopup(popupTexto(linha.nome, linha.trecho), { className: "popup-tema" })
        .addTo(camadaTrilhos);
    });
    desenharEstacoes();
  }

  // Estações a partir do zoom 13, maiores de perto
  function desenharEstacoes() {
    camadaEstacoes.clearLayers();
    if (!trilhosLigados || !dadosTrilhos || mapa.getZoom() < 13) return;
    var raio = mapa.getZoom() >= 15 ? 5.5 : 4;
    dadosTrilhos.linhas.forEach(function (linha) {
      linha.estacoes.forEach(function (e) {
        if (!Number.isFinite(e.lat) || !Number.isFinite(e.lon)) return;
        L.circleMarker([e.lat, e.lon], {
          pane: "trilhos", radius: raio, color: "#" + linha.cor, weight: 2.5, fillColor: "#ffffff", fillOpacity: 1
        }).bindPopup(popupTexto("Estação " + e.nome, linha.nome), { className: "popup-tema" })
          .addTo(camadaEstacoes);
      });
    });
  }

  function ligarTrilhos(ligar) {
    trilhosLigados = ligar;
    try { localStorage.setItem("busjp-trilhos", ligar ? "1" : "0"); } catch (e) {}
    if (botaoTrilhos) {
      botaoTrilhos.classList.toggle("ativo", ligar);
      botaoTrilhos.setAttribute("aria-pressed", ligar ? "true" : "false");
    }
    if (!ligar) {
      mapa.removeLayer(camadaTrilhos);
      mapa.removeLayer(camadaEstacoes);
      return;
    }
    camadaTrilhos.addTo(mapa);
    camadaEstacoes.addTo(mapa);
    if (dadosTrilhos) { desenharEstacoes(); return; }
    fetch("api/trilhos")
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (dados) {
        dadosTrilhos = dados;
        if (trilhosLigados) desenharTrilhos();
      })
      .catch(function () {
        mostrarAviso("Não foi possível carregar as linhas de metrô e trem.");
        ligarTrilhos(false);
      });
  }

  mapa.on("zoomend", desenharEstacoes);

  var ControleTrilhos = L.Control.extend({
    options: { position: "bottomright" },
    onAdd: function () {
      var caixa = L.DomUtil.create("div", "leaflet-bar leaflet-control controle-localizar controle-trilhos");
      botaoTrilhos = L.DomUtil.create("a", "", caixa);
      botaoTrilhos.href = "#";
      botaoTrilhos.setAttribute("role", "button");
      botaoTrilhos.setAttribute("aria-pressed", "false");
      botaoTrilhos.setAttribute("title", "Mostrar linhas de metrô e trem");
      botaoTrilhos.setAttribute("aria-label", "Mostrar linhas de metrô e trem");
      botaoTrilhos.innerHTML =
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="5" y="3" width="14" height="14" rx="3"></rect><line x1="5" y1="11" x2="19" y2="11"></line>' +
        '<circle cx="9" cy="14" r="0.8"></circle><circle cx="15" cy="14" r="0.8"></circle>' +
        '<line x1="8" y1="21" x2="10" y2="17"></line><line x1="16" y1="21" x2="14" y2="17"></line></svg>';
      L.DomEvent.disableClickPropagation(caixa);
      L.DomEvent.on(botaoTrilhos, "click", function (e) {
        L.DomEvent.preventDefault(e);
        ligarTrilhos(!trilhosLigados);
      });
      return caixa;
    }
  });
  new ControleTrilhos().addTo(mapa);
  try { if (localStorage.getItem("busjp-trilhos") === "1") ligarTrilhos(true); } catch (e) {}

  /* ---------- Instalar como aplicativo (PWA) ---------- */
  var btnInstalar = document.getElementById("btnInstalar");
  var eventoInstalacao = null;

  function jaInstalado() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true;
  }

  // Android/Chrome: o navegador avisa quando o app pode ser instalado
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    eventoInstalacao = e;
    if (!jaInstalado()) btnInstalar.hidden = false;
  });
  window.addEventListener("appinstalled", function () {
    eventoInstalacao = null;
    btnInstalar.hidden = true;
  });
  // iPhone/iPad: não existe aviso automático; o botão mostra o passo a passo
  if (ehIOS() && !jaInstalado()) btnInstalar.hidden = false;

  btnInstalar.addEventListener("click", function () {
    if (eventoInstalacao) {
      eventoInstalacao.prompt();
      eventoInstalacao.userChoice.then(function () {
        eventoInstalacao = null;
        btnInstalar.hidden = true;
      });
    } else {
      mostrarAviso("Para instalar: toque em Compartilhar (o quadrado com a seta) e depois em \u201cAdicionar à Tela de Início\u201d. Se não aparecer, abra o endereço direto no Safari.", 12000);
    }
  });

  /* ---------- PWA: service worker (exige HTTPS ou localhost) ---------- */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function (err) {
        console.warn("Service worker não registrado:", err);
      });
    });
  }
})();