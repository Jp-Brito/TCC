// Painel que sobe de baixo ao tocar numa parada: mostra as linhas que passam
// ali, a previsão de chegada de cada uma e, no mapa, onde o ônibus está agora.
//
// Os dados vêm da nossa função /api/previsao e se atualizam sozinhos enquanto
// o painel estiver aberto.
(function () {
  "use strict";

  var mapa = null;
  var cfg = null;
  var els = {};
  var camadaOnibus = null;
  var camadaSelecao = null;

  var estado = {
    parada: null,          // parada aberta
    linhas: [],            // linhas com previsão, já processadas
    codigoSelecionado: null,
    horaReferencia: null,
    erro: null,
    carregando: false,
    ajustarMapa: false,    // true = na próxima atualização, enquadrar parada + ônibus
    controlador: null,
    timer: null,
    atrasoMs: 0
  };

  /* ---------- Funções de apoio (também usadas nos testes) ---------- */

  function paraMinutos(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  // Minutos entre o horário de referência da API e o horário previsto.
  // Usamos o relógio da própria SPTrans, assim o fuso do celular não atrapalha.
  function minutosAte(chegada, referencia) {
    var c = paraMinutos(chegada);
    var r = paraMinutos(referencia);
    if (c === null || r === null) return null;
    var diferenca = (c - r + 1440) % 1440;     // vira o dia sem problema
    return diferenca > 720 ? null : diferenca; // mais de 12 h à frente = já passou
  }

  function textoTempo(min) {
    return min <= 0 ? "Chegando" : min + " min";
  }

  // Transforma a resposta da API numa lista pronta para mostrar.
  function processar(dados) {
    var ref = dados.horaReferencia;
    return (dados.linhas || []).map(function (l) {
      var veiculos = (l.veiculos || []).map(function (v) {
        return {
          prefixo: v.prefixo, chegada: v.chegada, acessivel: v.acessivel,
          lat: v.lat, lon: v.lon, minutos: minutosAte(v.chegada, ref)
        };
      }).filter(function (v) { return v.minutos !== null; })
        .sort(function (a, b) { return a.minutos - b.minutos; });
      return { codigo: l.codigo, letreiro: l.letreiro, destino: l.destino, veiculos: veiculos };
    }).filter(function (l) { return l.veiculos.length > 0; })
      .sort(function (a, b) { return a.veiculos[0].minutos - b.veiculos[0].minutos; });
  }

  function el(tag, classe, texto) {
    var e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined) e.textContent = texto;   // textContent: nunca interpreta HTML
    return e;
  }

  /* ---------- Desenho do painel ---------- */

  function medirAltura() {
    var aberto = els.painel.classList.contains("aberto");
    var h = aberto ? els.painel.offsetHeight : 0;
    document.documentElement.style.setProperty("--altura-painel", h + "px");
    document.body.classList.toggle("painel-aberto", h > 0);
    return h;
  }

  function renderizar() {
    els.titulo.textContent = estado.parada.nome;
    els.sub.textContent = "Parada " + estado.parada.id +
      (estado.parada.referencia ? " · " + estado.parada.referencia : "");

    els.corpo.textContent = "";

    if (estado.carregando && estado.linhas.length === 0) {
      els.corpo.appendChild(el("p", "painel__aviso", "Buscando previsões..."));
    } else if (estado.erro && estado.linhas.length === 0) {
      els.corpo.appendChild(el("p", "painel__aviso", estado.erro));
    } else if (estado.linhas.length === 0) {
      els.corpo.appendChild(el("p", "painel__aviso", "Nenhum ônibus previsto para este ponto agora."));
    } else {
      estado.linhas.forEach(function (linha) {
        els.corpo.appendChild(criarLinha(linha));
      });
    }

    var rodape = estado.horaReferencia ? "Atualizado às " + estado.horaReferencia : "";
    if (estado.erro && estado.linhas.length > 0) rodape += " · " + estado.erro;
    els.rodape.textContent = rodape;

    medirAltura();
  }

  function criarLinha(linha) {
    var primeiro = linha.veiculos[0];
    var botao = el("button", "linha");
    botao.type = "button";
    var selecionada = linha.codigo === estado.codigoSelecionado;
    if (selecionada) botao.classList.add("linha--ativa");
    botao.setAttribute("aria-pressed", selecionada ? "true" : "false");

    botao.appendChild(el("span", "linha__letreiro", linha.letreiro));

    var meio = el("span", "linha__meio");
    meio.appendChild(el("span", "linha__destino", linha.destino || ""));
    if (linha.veiculos.length > 1) {
      var depois = linha.veiculos.slice(1, 3).map(function (v) { return textoTempo(v.minutos); });
      meio.appendChild(el("span", "linha__depois", "depois: " + depois.join(", ")));
    }
    botao.appendChild(meio);

    var tempo = el("span", "linha__tempo");
    tempo.appendChild(el("strong", "", textoTempo(primeiro.minutos)));
    tempo.appendChild(el("small", "", primeiro.chegada + (primeiro.acessivel ? " · acessível" : "")));
    botao.appendChild(tempo);

    botao.addEventListener("click", function () {
      estado.codigoSelecionado = linha.codigo;
      estado.ajustarMapa = true;
      renderizar();
      desenharOnibus();
    });
    return botao;
  }

  /* ---------- Ônibus no mapa ---------- */

  function desenharOnibus() {
    camadaOnibus.clearLayers();
    var linha = estado.linhas.filter(function (l) { return l.codigo === estado.codigoSelecionado; })[0];
    if (!linha) return;

    var pontos = [[estado.parada.lat, estado.parada.lon]];
    linha.veiculos.forEach(function (v) {
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return;
      var pino = el("div", "bus-pin", linha.letreiro);
      var base = el("div", "bus-pin-base");
      base.appendChild(pino);
      L.marker([v.lat, v.lon], {
        icon: L.divIcon({ className: "bus-pin-icone", html: base, iconSize: [0, 0] }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 500
      }).addTo(camadaOnibus);
      pontos.push([v.lat, v.lon]);
    });

    if (estado.ajustarMapa && pontos.length > 1) {
      estado.ajustarMapa = false;
      mapa.fitBounds(pontos, {
        paddingTopLeft: [40, 90],
        paddingBottomRight: [40, medirAltura() + 30],
        maxZoom: 17
      });
    }
  }

  // Garante que a parada não fique escondida atrás do painel
  function mostrarParadaAcima() {
    var altura = medirAltura();
    var ponto = mapa.latLngToContainerPoint([estado.parada.lat, estado.parada.lon]);
    var visivel = mapa.getSize().y - altura;
    if (ponto.y > visivel - 40 || ponto.y < 90) {
      mapa.panBy([0, ponto.y - visivel / 2], { animate: true });
    }
  }

  /* ---------- Atualização automática ---------- */

  function agendar(ms) {
    clearTimeout(estado.timer);
    estado.timer = setTimeout(buscar, ms);
  }

  function buscar() {
    if (!estado.parada) return;
    if (document.hidden) { estado.timer = null; return; }   // pausa com a aba em segundo plano

    if (estado.controlador) estado.controlador.abort();
    var controlador = new AbortController();
    estado.controlador = controlador;
    var id = estado.parada.id;

    fetch("api/previsao?parada=" + encodeURIComponent(id), { signal: controlador.signal })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (dados) {
        if (!estado.parada || estado.parada.id !== id) return;
        estado.linhas = processar(dados);
        estado.horaReferencia = dados.horaReferencia;
        estado.erro = null;
        estado.carregando = false;
        estado.atrasoMs = cfg.painel.atualizacaoMs;

        var existe = estado.linhas.some(function (l) { return l.codigo === estado.codigoSelecionado; });
        if (!existe) {
          estado.codigoSelecionado = estado.linhas.length ? estado.linhas[0].codigo : null;
          estado.ajustarMapa = true;
        }
        renderizar();
        desenharOnibus();
        agendar(estado.atrasoMs);
      })
      .catch(function (erro) {
        if (erro.name === "AbortError") return;
        if (!estado.parada || estado.parada.id !== id) return;
        estado.carregando = false;
        estado.erro = "Não foi possível atualizar as previsões.";
        // Espera cada vez mais entre as tentativas, até um limite
        estado.atrasoMs = Math.min((estado.atrasoMs || cfg.painel.atualizacaoMs) * 2, cfg.painel.atualizacaoMaxMs);
        renderizar();
        agendar(estado.atrasoMs);
      });
  }

  /* ---------- Abrir e fechar ---------- */

  function abrir(parada) {
    if (estado.controlador) estado.controlador.abort();
    clearTimeout(estado.timer);

    estado.parada = parada;
    estado.linhas = [];
    estado.codigoSelecionado = null;
    estado.horaReferencia = null;
    estado.erro = null;
    estado.carregando = true;
    estado.ajustarMapa = false;
    estado.atrasoMs = cfg.painel.atualizacaoMs;

    camadaOnibus.clearLayers();
    camadaSelecao.clearLayers();
    L.circleMarker([parada.lat, parada.lon], {
      radius: 12, color: "#8B5CF6", weight: 3, fill: false, interactive: false
    }).addTo(camadaSelecao);

    els.painel.classList.add("aberto");
    renderizar();
    mostrarParadaAcima();
    buscar();
  }

  function fechar() {
    if (estado.controlador) estado.controlador.abort();
    clearTimeout(estado.timer);
    estado.parada = null;
    camadaOnibus.clearLayers();
    camadaSelecao.clearLayers();
    els.painel.classList.remove("aberto");
    medirAltura();
  }

  function iniciar(mapaLeaflet, configuracao) {
    mapa = mapaLeaflet;
    cfg = configuracao;
    els = {
      painel: document.getElementById("painel"),
      titulo: document.getElementById("painelTitulo"),
      sub: document.getElementById("painelSub"),
      corpo: document.getElementById("painelCorpo"),
      rodape: document.getElementById("painelRodape")
    };
    camadaSelecao = L.layerGroup().addTo(mapa);
    camadaOnibus = L.layerGroup().addTo(mapa);

    document.getElementById("painelFechar").addEventListener("click", fechar);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") fechar(); });
    window.addEventListener("resize", medirAltura);

    // Ao voltar para a aba, atualiza na hora
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && estado.parada) buscar();
    });
  }

  window.Painel = {
    iniciar: iniciar,
    abrir: abrir,
    fechar: fechar,
    _teste: { paraMinutos: paraMinutos, minutosAte: minutosAte, textoTempo: textoTempo, processar: processar }
  };
})();
