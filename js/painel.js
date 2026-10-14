// Painel que sobe de baixo ao tocar numa parada: mostra as linhas que passam
// ali, a previsão de chegada de cada uma e, no mapa, onde cada ônibus está.
// Tocar na setinha de um ônibus abre um pop-up com as informações dele.
//
// Os dados vêm da nossa função /api/previsao e se atualizam sozinhos enquanto
// o painel estiver aberto.
(function () {
  "use strict";

  var mapa = null;
  var cfg = null;
  var obterIndice = function () { return null; };
  var els = {};
  var camadaOnibus = null;
  var camadaSelecao = null;
  var camadaParadasLinha = null;   // paradas por onde a linha selecionada passa
  var paradasPorLinha = {};        // cache: código da linha -> paradas
  var paradasDesenhadasDe = null;  // linha cujas paradas estão desenhadas agora

  var marcadores = {};   // prefixo do ônibus -> { marcador, popup, idadeEl, rumo }
  var historico = {};    // prefixo -> última posição usada para estimar a direção

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
    atrasoMs: 0,
    linhaPreferida: null,  // linha a manter selecionada ao trocar de parada
    dataServidor: NaN,     // hora do servidor (cabeçalho Date da resposta)
    recebidoEm: 0
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

  // Distância em metros entre dois pontos {lat, lon} (aproximação para distâncias curtas)
  function distanciaM(a, b) {
    var dy = (b.lat - a.lat) * 111320;
    var dx = (b.lon - a.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Direção (0 = norte, 90 = leste...) do ponto a até o ponto b, em graus
  function rumoEntre(a, b) {
    var rad = Math.PI / 180;
    var dLon = (b.lon - a.lon) * rad;
    var y = Math.sin(dLon) * Math.cos(b.lat * rad);
    var x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
            Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function textoIdade(segundos) {
    if (segundos === null) return "—";
    if (segundos < 5) return "agora";
    if (segundos < 60) return "há " + segundos + " s";
    if (segundos < 3600) return "há " + Math.floor(segundos / 60) + " min";
    return "há " + Math.floor(segundos / 3600) + " h";
  }

  // Há quantos segundos a posição foi enviada pelo ônibus.
  // "Agora" vem do servidor (cabeçalho Date), não do relógio do celular.
  function idadeSegundos(atualizadoEm) {
    var quando = Date.parse(atualizadoEm);
    if (!Number.isFinite(quando)) return null;
    var agora = Number.isFinite(estado.dataServidor)
      ? estado.dataServidor + (performance.now() - estado.recebidoEm)
      : Date.now();
    return Math.max(0, Math.round((agora - quando) / 1000));
  }

  // Transforma a resposta da API numa lista pronta para mostrar.
  function processar(dados) {
    var ref = dados.horaReferencia;
    return (dados.linhas || []).map(function (l) {
      var veiculos = (l.veiculos || []).map(function (v) {
        return {
          prefixo: v.prefixo, chegada: v.chegada, acessivel: v.acessivel,
          atualizadoEm: v.atualizadoEm, lat: v.lat, lon: v.lon,
          minutos: minutosAte(v.chegada, ref)
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
      if (estado.codigoSelecionado !== linha.codigo) limparOnibus();
      estado.codigoSelecionado = linha.codigo;
      estado.ajustarMapa = true;
      renderizar();
      desenharOnibus();
    });
    return botao;
  }

  /* ---------- Ônibus no mapa (setinha + pop-up) ---------- */

  function limparOnibus() {
    camadaOnibus.clearLayers();
    marcadores = {};
  }

  // Ícone: círculo roxo com uma seta. Sem direção conhecida, mostra só um ponto.
  function criarIcone(rumo) {
    var temRumo = rumo !== null;
    var html = temRumo
      ? '<div class="seta"><svg viewBox="0 0 24 24" width="22" height="22" style="transform: rotate(' +
        Math.round(rumo) + 'deg)"><path d="M12 3 L19 20 L12 16 L5 20 Z" fill="#fff"></path></svg></div>'
      : '<div class="seta seta--sem-rumo"><span></span></div>';
    return L.divIcon({ className: "seta-icone", html: html, iconSize: [34, 34], iconAnchor: [17, 17] });
  }

  // Estima a direção do ônibus pelo deslocamento desde a última posição conhecida
  function atualizarRumo(veiculo) {
    var anterior = historico[veiculo.prefixo];
    var atual = { lat: veiculo.lat, lon: veiculo.lon };
    if (!anterior) {
      historico[veiculo.prefixo] = { lat: atual.lat, lon: atual.lon, rumo: null };
      return null;
    }
    if (distanciaM(anterior, atual) >= 10) {      // andou o bastante para saber a direção
      anterior.rumo = rumoEntre(anterior, atual);
      anterior.lat = atual.lat;
      anterior.lon = atual.lon;
    }
    return anterior.rumo;
  }

  function conteudoPopup(linha, veiculo) {
    var raiz = el("div", "popup-onibus");
    raiz.appendChild(el("strong", "popup-onibus__titulo", linha.letreiro));
    raiz.appendChild(el("div", "popup-onibus__linha", "Sentido: " + (linha.destino || "—")));

    var idade = el("div", "popup-onibus__linha");
    idade.appendChild(document.createTextNode("Atualizado "));
    var idadeEl = el("b", "", textoIdade(idadeSegundos(veiculo.atualizadoEm)));
    idade.appendChild(idadeEl);
    raiz.appendChild(idade);

    // Localização: parada mais próxima (se houver) e coordenadas
    var indice = obterIndice();
    var perto = indice ? indice.maisProxima(veiculo.lat, veiculo.lon, 300) : null;
    if (perto) {
      var metros = Math.max(10, Math.round(perto.metros / 10) * 10);
      raiz.appendChild(el("div", "popup-onibus__linha", "Perto de: " + perto.parada.nome + " (" + metros + " m)"));
    }
    raiz.appendChild(el("div", "popup-onibus__coord",
      veiculo.lat.toFixed(5) + ", " + veiculo.lon.toFixed(5)));
    raiz.appendChild(el("div", "popup-onibus__coord",
      "Prefixo " + veiculo.prefixo + (veiculo.acessivel ? " · acessível" : "")));

    return { raiz: raiz, idadeEl: idadeEl };
  }

  // Mostra no mapa só as paradas por onde a linha selecionada passa.
  // As paradas de cada linha são buscadas uma vez e guardadas.
  function atualizarParadasDaLinha() {
    var codigo = estado.codigoSelecionado;
    if (codigo === paradasDesenhadasDe) return;
    paradasDesenhadasDe = codigo;
    camadaParadasLinha.clearLayers();
    if (codigo === null || codigo === undefined) return;

    if (paradasPorLinha[codigo]) {
      desenharParadasDaLinha(codigo);
      return;
    }
    fetch("api/paradas-linha?linha=" + encodeURIComponent(codigo))
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (dados) {
        paradasPorLinha[codigo] = dados.paradas || [];
        if (estado.parada && estado.codigoSelecionado === codigo) desenharParadasDaLinha(codigo);
      })
      .catch(function () {
        paradasDesenhadasDe = null;   // tenta de novo na próxima atualização
      });
  }

  function desenharParadasDaLinha(codigo) {
    camadaParadasLinha.clearLayers();
    (paradasPorLinha[codigo] || []).forEach(function (p) {
      if (!estado.parada || p.id === estado.parada.id) return;   // a escolhida já está destacada
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
      L.circleMarker([p.lat, p.lon], {
        radius: 7, color: "#ffffff", weight: 2, fillColor: "#8B5CF6", fillOpacity: 1
      }).on("click", function () { abrir(p, codigo); })   // tocar noutra parada da linha troca o painel
        .addTo(camadaParadasLinha);
    });
  }

  function desenharOnibus() {
    atualizarParadasDaLinha();
    var linha = estado.linhas.filter(function (l) { return l.codigo === estado.codigoSelecionado; })[0];
    if (!linha) { limparOnibus(); return; }

    var pontos = [[estado.parada.lat, estado.parada.lon]];
    var presentes = {};

    linha.veiculos.forEach(function (v) {
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return;
      presentes[v.prefixo] = true;
      pontos.push([v.lat, v.lon]);

      var rumo = atualizarRumo(v);
      var conteudo = conteudoPopup(linha, v);
      var existente = marcadores[v.prefixo];

      if (existente) {
        existente.marcador.setLatLng([v.lat, v.lon]);
        if (existente.rumo !== (rumo === null ? null : Math.round(rumo))) {
          existente.marcador.setIcon(criarIcone(rumo));
          existente.rumo = rumo === null ? null : Math.round(rumo);
        }
        existente.popup.setContent(conteudo.raiz);   // atualiza sem fechar o pop-up
        existente.idadeEl = conteudo.idadeEl;
        return;
      }

      var marcador = L.marker([v.lat, v.lon], {
        icon: criarIcone(rumo),
        keyboard: false,
        zIndexOffset: 500
      }).addTo(camadaOnibus);

      // Antes de abrir o pop-up, reserva espaço para o painel de baixo
      marcador.on("click", function () {
        popup.options.autoPanPaddingBottomRight = [20, medirAltura() + 20];
      });
      var popup = L.popup({
        className: "popup-tema",
        autoPanPaddingTopLeft: [20, 90],
        autoPanPaddingBottomRight: [20, medirAltura() + 20],
        offset: [0, -8],
        closeButton: true
      }).setContent(conteudo.raiz);
      marcador.bindPopup(popup);

      marcadores[v.prefixo] = {
        marcador: marcador, popup: popup, idadeEl: conteudo.idadeEl,
        rumo: rumo === null ? null : Math.round(rumo)
      };
    });

    // Remove ônibus que saíram da lista
    Object.keys(marcadores).forEach(function (prefixo) {
      if (!presentes[prefixo]) {
        camadaOnibus.removeLayer(marcadores[prefixo].marcador);
        delete marcadores[prefixo];
      }
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

  // A cada segundo, atualiza o "há N s" do pop-up que estiver aberto
  function atualizarIdades() {
    var linha = estado.linhas.filter(function (l) { return l.codigo === estado.codigoSelecionado; })[0];
    if (!linha) return;
    linha.veiculos.forEach(function (v) {
      var m = marcadores[v.prefixo];
      if (m && m.marcador.isPopupOpen()) {
        m.idadeEl.textContent = textoIdade(idadeSegundos(v.atualizadoEm));
      }
    });
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
        estado.dataServidor = Date.parse(r.headers.get("Date"));
        estado.recebidoEm = performance.now();
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
          limparOnibus();
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

  function abrir(parada, linhaPreferida) {
    if (estado.controlador) estado.controlador.abort();
    clearTimeout(estado.timer);

    estado.parada = parada;
    estado.linhas = [];
    estado.codigoSelecionado = linhaPreferida || null;
    estado.horaReferencia = null;
    estado.erro = null;
    estado.carregando = true;
    estado.ajustarMapa = false;
    estado.atrasoMs = cfg.painel.atualizacaoMs;

    limparOnibus();
    historico = {};
    camadaSelecao.clearLayers();
    paradasDesenhadasDe = null;
    atualizarParadasDaLinha();   // se já conhecemos a linha, redesenha na hora
    // A parada escolhida fica desenhada aqui (as outras somem enquanto o painel está aberto)
    L.circleMarker([parada.lat, parada.lon], {
      radius: 7, color: "#ffffff", weight: 2, fillColor: "#8B5CF6", fillOpacity: 1, interactive: false
    }).addTo(camadaSelecao);
    L.circleMarker([parada.lat, parada.lon], {
      radius: 13, color: "#8B5CF6", weight: 3, fill: false, interactive: false
    }).addTo(camadaSelecao);

    els.painel.classList.add("aberto");
    avisarMudanca();
    renderizar();
    mostrarParadaAcima();
    buscar();
  }

  function fechar() {
    if (estado.controlador) estado.controlador.abort();
    clearTimeout(estado.timer);
    estado.parada = null;
    limparOnibus();
    historico = {};
    camadaSelecao.clearLayers();
    camadaParadasLinha.clearLayers();
    paradasDesenhadasDe = null;
    els.painel.classList.remove("aberto");
    medirAltura();
    avisarMudanca();
  }

  function estaAberto() {
    return estado.parada !== null;
  }

  // Avisa o resto do app que o painel abriu ou fechou (o mapa esconde ou mostra as paradas)
  function avisarMudanca() {
    document.dispatchEvent(new CustomEvent("painel:mudou"));
  }

  function iniciar(mapaLeaflet, configuracao, funcaoIndice) {
    mapa = mapaLeaflet;
    cfg = configuracao;
    if (typeof funcaoIndice === "function") obterIndice = funcaoIndice;
    els = {
      painel: document.getElementById("painel"),
      titulo: document.getElementById("painelTitulo"),
      sub: document.getElementById("painelSub"),
      corpo: document.getElementById("painelCorpo"),
      rodape: document.getElementById("painelRodape")
    };
    camadaSelecao = L.layerGroup().addTo(mapa);
    camadaParadasLinha = L.layerGroup().addTo(mapa);
    camadaOnibus = L.layerGroup().addTo(mapa);

    document.getElementById("painelFechar").addEventListener("click", fechar);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") fechar(); });
    window.addEventListener("resize", medirAltura);
    setInterval(atualizarIdades, 1000);

    // Ao voltar para a aba, atualiza na hora
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && estado.parada) buscar();
    });
  }

  window.Painel = {
    iniciar: iniciar,
    abrir: abrir,
    fechar: fechar,
    estaAberto: estaAberto,
    _teste: {
      paraMinutos: paraMinutos, minutosAte: minutosAte, textoTempo: textoTempo,
      processar: processar, distanciaM: distanciaM, rumoEntre: rumoEntre, textoIdade: textoIdade
    }
  };
})();