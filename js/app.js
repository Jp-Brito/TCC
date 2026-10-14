// Ônibus ao Vivo SP — cabeçalho, tema claro/escuro, mapa e localização do usuário.
(function () {
  "use strict";
  var cfg = window.APP_CONFIG;
  var raiz = document.documentElement;

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
  function mostrarAviso(texto) {
    aviso.textContent = texto;
    aviso.hidden = false;
    clearTimeout(timerAviso);
    timerAviso = setTimeout(function () { aviso.hidden = true; }, 5000);
  }

  /* ---------- Paradas de ônibus ---------- */
  var indiceParadas = null;
  var camadaParadas = L.layerGroup().addTo(mapa);

  // Ao tocar numa parada, abre o painel com as previsões de chegada
  function aoSelecionarParada(parada) {
    Painel.abrir(parada);
  }

  function desenharParadas() {
    camadaParadas.clearLayers();
    if (!indiceParadas || mapa.getZoom() < cfg.paradas.zoomMinimo) return;

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

  Painel.iniciar(mapa, cfg);

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
      icon: L.divIcon({ className: "user-dot", html: "<span></span>", iconSize: [18, 18] }),
      interactive: false,
      keyboard: false
    }).addTo(mapa);

    return ll;
  }

  function falhaLocalizacao(err) {
    var msgs = {
      1: "Permissão de localização negada. Ative a localização no navegador.",
      2: "Não foi possível obter sua localização.",
      3: "A localização demorou demais. Tente de novo."
    };
    mostrarAviso(msgs[err.code] || msgs[2]);
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
    navigator.geolocation.getCurrentPosition(function (pos) {
      var ll = desenharUsuario(pos);
      if (comAnimacao || ultimaPosicao) {
        mapa.flyTo(ll, cfg.mapa.zoomUsuario, { duration: 0.6 });
      } else {
        mapa.setView(ll, cfg.mapa.zoomUsuario);
      }
    }, falhaLocalizacao, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 5000
    });
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

  // Ao abrir o site, já centraliza na pessoa
  irParaMim(false);

  /* ---------- PWA: service worker (exige HTTPS ou localhost) ---------- */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function (err) {
        console.warn("Service worker não registrado:", err);
      });
    });
  }
})();