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
  var camadaTracado = null;        // traçado (caminho) da linha selecionada
  var camadaParadasLinha = null;   // paradas por onde a linha selecionada passa
  var paradasLinhaAtual = null;    // { codigo, lista } paradas da linha selecionada (redesenhadas no zoom)
  var camadaCaminho = null;        // caminho a pé do usuário até a parada
  var posUsuario = null;           // [lat, lon] da última localização (enviada pelo app.js)
  var caminho = { alvo: null, origem: null, irParaParada: false, el: null };
  var rotasCache = {};             // rotas a pé já calculadas (origem arredondada + parada)
  var paradasPorLinha = {};        // cache: código da linha -> paradas
  var paradasDesenhadasDe = null;  // linha cujas paradas estão desenhadas agora
  var tracadosCache = {};          // código da linha -> pontos do traçado
  var tracadoDesenhadoDe = null;   // linha cujo traçado está desenhado agora
  var vazias = {};                 // quantas vezes a API devolveu zero paradas para cada linha

  var marcadores = {};   // prefixo do ônibus -> { marcador, popup, idadeEl, rumo }
  var historico = {};    // prefixo -> última posição usada para estimar a direção

  var estado = {
    parada: null,          // parada aberta
    linhas: [],            // linhas com previsão, já processadas
    codigoSelecionado: null,
    horaReferencia: null,
    erro: null,
    modoLinha: null,       // linha aberta pela busca (sem parada): { codigo, letreiro, cor, ... }
    estacao: null,         // estação de metrô/trem aberta: { id, nome, lat, lon, linhas: [...] }
    minimizado: false,     // painel recolhido (só o cabeçalho), para ver mais do mapa
    carregando: false,
    ajustarMapa: false,    // true = na próxima atualização, enquadrar parada + ônibus
    controlador: null,
    timer: null,
    atrasoMs: 0,
    linhaPreferida: null,  // linha a manter selecionada ao trocar de parada
    infoParadas: null,     // { codigo, total, fonte } paradas da linha selecionada, para o rodapé
    infoTracado: null,     // { total } pontos do traçado da linha selecionada, para o rodapé
    dataServidor: NaN,     // hora do servidor (cabeçalho Date da resposta)
    recebidoEm: 0,
    proximaEm: 0,          // quando será a próxima tentativa (Date.now)
    ultimoSucesso: 0       // quando a última atualização deu certo (Date.now), para o aviso de dado velho
  };

  // Simulação de falhas para os testes do TCC. Só liga com ?simular=falha ou ?simular=lento
  // no endereço; em cada parada ou linha aberta, a primeira atualização funciona e as
  // seguintes falham (ou demoram 15 s).
  var simulacao = (function () {
    try { return new URLSearchParams(location.search).get("simular"); } catch (e) { return null; }
  })();
  var alertaEl = null;     // faixa de aviso no topo do painel
  var LIMITE_GPS_S = 180;  // posição mais nova com mais de 3 min = GPS da SPTrans atrasado
  var LIMITE_ETIQUETA_S = 90;  // ônibus com posição mais velha que isso ganha a etiqueta amarela

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
      return { codigo: l.codigo, letreiro: l.letreiro, destino: l.destino, sentido: l.sentido, cor: l.cor, veiculos: veiculos };
    }).filter(function (l) { return l.veiculos.length > 0; })
      .sort(function (a, b) { return a.veiculos[0].minutos - b.veiculos[0].minutos; });
  }

  // Cor oficial da linha (do GTFS). Se não houver, usa o roxo do app.
  var COR_PADRAO = { fundo: "8B5CF6", texto: "FFFFFF" };
  var HEX = /^[0-9A-Fa-f]{6}$/;

  function corDaLinha(hex) {
    var c = hex ? [hex] : null;
    if (c && HEX.test(c[0])) {
      // Texto preto em fundos claros (amarelo, laranja) e branco nos escuros,
      // calculado pelo brilho da cor, para sempre ficar legível.
      var r = parseInt(c[0].slice(0, 2), 16), g = parseInt(c[0].slice(2, 4), 16), b = parseInt(c[0].slice(4, 6), 16);
      var brilho = 0.299 * r + 0.587 * g + 0.114 * b;
      return { fundo: c[0], texto: brilho > 135 ? "000000" : "FFFFFF" };
    }
    return COR_PADRAO;
  }

  function el(tag, classe, texto) {
    var e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined) e.textContent = texto;   // textContent: nunca interpreta HTML
    return e;
  }

  // Há algo aberto no painel: uma parada ou uma linha vinda da busca
  function ativo() {
    return estado.parada !== null || estado.modoLinha !== null || estado.estacao !== null;
  }

  /* ---------- Desenho do painel ---------- */

  function medirAltura() {
    var aberto = els.painel.classList.contains("aberto");
    var h = aberto ? els.painel.offsetHeight : 0;
    document.documentElement.style.setProperty("--altura-painel", h + "px");
    document.body.classList.toggle("painel-aberto", h > 0);
    return h;
  }

  // Informações de diagnóstico das paradas e do traçado da linha selecionada
  function complementoRodape() {
    var texto = "";
    if (estado.infoParadas) {
      texto += " · linha " + estado.infoParadas.codigo + ": " +
        (estado.infoParadas.total > 0
          ? estado.infoParadas.total + " paradas" +
            (estado.infoParadas.fonte === "previsao" ? " (via previsão)" :
              estado.infoParadas.fonte === "gtfs-stop-times" ? " (GTFS)" :
              estado.infoParadas.fonte === "gtfs-proximidade" ? " (aproximação GTFS)" : "")
          : "a API não devolveu paradas");
    }
    if (estado.infoTracado) {
      texto += " · traçado: " + (estado.infoTracado.total > 0 ? estado.infoTracado.total + " pontos" : "indisponível");
    }
    return texto;
  }

  // Painel no modo linha (aberto pela busca): lista os ônibus da linha
  function renderizarLinha() {
    var item = estado.modoLinha;
    var linha = estado.linhas[0];
    els.titulo.textContent = item.letreiro;
    els.sub.textContent = linha.destino ? "Sentido: " + linha.destino : item.rotulo;
    els.corpo.textContent = "";

    if (estado.carregando && linha.veiculos.length === 0) {
      els.corpo.appendChild(el("p", "painel__aviso", "Buscando os ônibus da linha..."));
    } else if (estado.erro && linha.veiculos.length === 0) {
      // a faixa amarela (atualizarAlerta) explica a falha
    } else if (linha.veiculos.length === 0) {
      els.corpo.appendChild(el("p", "painel__aviso", "Nenhum ônibus em circulação nesta linha agora."));
    } else {
      linha.veiculos.forEach(function (v) {
        var botao = el("button", "onibus-item");
        botao.type = "button";
        botao.appendChild(el("span", "onibus-item__prefixo", "Ônibus " + v.prefixo));
        botao.appendChild(el("span", "onibus-item__idade", "posição " + textoIdade(idadeSegundos(v.atualizadoEm))));
        if (v.acessivel) botao.appendChild(el("span", "onibus-item__tag", "acessível"));
        botao.addEventListener("click", function () {
          var m = marcadores[v.prefixo];
          if (!m) return;
          mapa.flyTo(m.marcador.getLatLng(), Math.max(mapa.getZoom(), 16), { duration: 0.6 });
          m.marcador.openPopup();
        });
        els.corpo.appendChild(botao);
      });
    }

    var rodape = estado.horaReferencia ? "Atualizado às " + estado.horaReferencia : "";
    els.rodape.textContent = rodape + complementoRodape();

    var n = linha.veiculos.length;
    els.resumo.textContent = estado.carregando && n === 0 ? "Buscando os ônibus..."
      : n + (n === 1 ? " ônibus em circulação" : " ônibus em circulação");
    if (atualizarAlerta()) els.resumo.textContent = "⚠ " + els.resumo.textContent;
    medirAltura();
  }

  /* ---------- Estação de metrô ou trem (programação, sem tempo real) ---------- */

  // Hora atual em São Paulo, em minutos desde a meia-noite
  function minutoAgoraSP() {
    var hhmm = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(new Date());
    return paraMinutos(hhmm);
  }

  function textoIntervalo(segundos) {
    return "a cada " + Math.max(1, Math.round(segundos / 60)) + " min";
  }

  function textoHora(minutos) {
    var h = Math.floor(minutos / 60) % 24, m = minutos % 60;
    return h + "h" + (m ? String(m).padStart(2, "0") : "");
  }

  // Faixa em vigor agora e a próxima mudança de intervalo. faixas: [[início, fim, segundos], ...]
  function situacaoSentido(faixas, agora) {
    var atual = null, proxima = null, i;
    for (i = 0; i < faixas.length; i++) {
      if (agora >= faixas[i][0] && agora <= faixas[i][1]) { atual = faixas[i]; break; }
    }
    // próxima faixa com intervalo diferente do atual (ou, se fechado, a próxima abertura)
    for (i = 0; i < faixas.length; i++) {
      if (faixas[i][0] > agora && (!atual || faixas[i][2] !== atual[2])) { proxima = faixas[i]; break; }
    }
    if (!atual && !proxima && faixas.length) proxima = faixas[0];   // abre de novo no dia seguinte
    return { atual: atual, proxima: proxima };
  }

  // Situação das linhas (api/situacao-trilhos, fonte não oficial). Guardada por 2 min.
  var situacao = { dados: null, em: 0, carregando: false };

  function carregarSituacao() {
    if (situacao.carregando || (situacao.dados && Date.now() - situacao.em < 120000)) return;
    situacao.carregando = true;
    fetch("api/situacao-trilhos")
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (dados) { situacao.dados = dados; situacao.em = Date.now(); })
      .catch(function () { /* sem situação: a estação aparece sem essa linha */ })
      .then(function () {
        situacao.carregando = false;
        if (estado.estacao) renderizar();
      });
  }

  function situacaoDaLinha(numero) {
    if (!situacao.dados) return null;
    return situacao.dados.linhas.filter(function (l) { return l.numero === numero; })[0] || null;
  }

  function horaDe(iso) {
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
  }

  function renderizarEstacao() {
    var est = estado.estacao, agora = minutoAgoraSP();
    els.titulo.textContent = "Estação " + est.nome;
    els.sub.textContent = est.linhas.map(function (l) { return l.nome; }).join(" · ");
    els.corpo.textContent = "";
    var resumo = "";

    var temSituacao = false;
    est.linhas.forEach(function (linha) {
      var sit = situacaoDaLinha(linha.numero);
      if (sit) {
        temSituacao = true;
        var hora = horaDe(situacao.dados.atualizadoEm || situacao.dados.consultadoEm);
        var texto = sit.descricao + (est.linhas.length > 1 ? " na linha " + linha.numero : "") +
          (hora ? " · atualizado às " + hora : "");
        els.corpo.appendChild(el("p", "estacao__situacao estacao__situacao--" + sit.situacao, texto));
        if (sit.motivo && sit.situacao !== "normal") els.corpo.appendChild(el("p", "estacao__motivo", sit.motivo));
      }
      linha.sentidos.forEach(function (s) {
        var sit = situacaoSentido(s.faixas, agora);
        var item = el("div", "linha linha--estacao");
        var etiqueta = el("span", "linha__letreiro", "L" + linha.numero);
        var cor = corDaLinha(linha.cor);
        etiqueta.style.background = "#" + cor.fundo;
        etiqueta.style.color = "#" + cor.texto;
        item.appendChild(etiqueta);

        var meio = el("span", "linha__meio");
        meio.appendChild(el("span", "linha__destino", "→ " + s.destino));
        if (sit.proxima) {
          meio.appendChild(el("span", "linha__depois",
            "a partir das " + textoHora(sit.proxima[0]) + ": " + textoIntervalo(sit.proxima[2])));
        }
        item.appendChild(meio);

        var tempo = el("span", "linha__tempo");
        tempo.appendChild(el("strong", "", sit.atual ? textoIntervalo(sit.atual[2]) : "fechado"));
        tempo.appendChild(el("small", "", "programado"));
        item.appendChild(tempo);
        els.corpo.appendChild(item);
        if (!resumo) resumo = "L" + linha.numero + " · " + (sit.atual ? textoIntervalo(sit.atual[2]) : "fora do horário") + " (programado)";
      });
      if (linha.sentidos.length && linha.sentidos[0].faixas.length) {
        var f = linha.sentidos[0].faixas;
        els.corpo.appendChild(el("p", "estacao__info", "Linha " + linha.numero + ": funcionamento programado das " +
          textoHora(f[0][0]) + " às " + textoHora(f[f.length - 1][1] + 1) + "."));
      }
    });

    els.rodape.textContent = "Horários programados (GTFS da SPTrans). O Metrô e a CPTM não publicam a posição dos trens em tempo real." +
      (temSituacao ? " Situação das linhas: Motiva Trilhos (fonte não oficial)." : "");
    els.resumo.textContent = resumo || "Programação indisponível";
    medirAltura();
  }

  function abrirEstacao(est) {
    if (estado.controlador) estado.controlador.abort();
    clearTimeout(estado.timer);
    estado.parada = null;
    estado.modoLinha = null;
    estado.estacao = est;
    estado.linhas = [];
    estado.codigoSelecionado = null;
    estado.erro = null;
    estado.carregando = false;
    estado.infoParadas = null;
    estado.infoTracado = null;

    limparOnibus();
    historico = {};
    camadaSelecao.clearLayers();
    camadaParadasLinha.clearLayers();
    paradasLinhaAtual = null;
    paradasDesenhadasDe = null;
    camadaTracado.clearLayers();
    tracadoDesenhadoDe = null;
    // Desenha a(s) linha(s) de metrô/trem que passam na estação, sem mudar o zoom
    est.linhas.forEach(function (linha) {
      if (!linha.polilinha) return;
      var pontos = decodificarPolilinha(linha.polilinha);
      var opcoes = { interactive: false, lineJoin: "round", lineCap: "round" };
      L.polyline(pontos, Object.assign({ color: "#ffffff", weight: 9, opacity: 0.55 }, opcoes)).addTo(camadaTracado);
      L.polyline(pontos, Object.assign({ color: "#" + corDaLinha(linha.cor).fundo, weight: 6, opacity: 0.95 }, opcoes)).addTo(camadaTracado);
    });
    L.circleMarker([est.lat, est.lon], {
      radius: 17, color: "#8B5CF6", weight: 3, fill: false, interactive: false
    }).addTo(camadaSelecao);

    els.painel.classList.add("aberto");
    minimizar(false);
    avisarMudanca();
    mostrarCaminho(est, false);
    carregarSituacao();
    renderizar();
  }

  function renderizar() {
    if (estado.estacao) { renderizarEstacao(); return; }
    if (estado.modoLinha) { renderizarLinha(); return; }
    els.titulo.textContent = estado.parada.nome;
    els.sub.textContent = "Parada " + estado.parada.id +
      (estado.parada.referencia ? " · " + estado.parada.referencia : "");

    els.corpo.textContent = "";

    if (estado.carregando && estado.linhas.length === 0) {
      els.corpo.appendChild(el("p", "painel__aviso", "Buscando previsões..."));
    } else if (estado.erro && estado.linhas.length === 0) {
      // a faixa amarela (atualizarAlerta) explica a falha
    } else if (estado.linhas.length === 0) {
      els.corpo.appendChild(el("p", "painel__aviso", "Nenhum ônibus previsto para este ponto agora."));
    } else {
      estado.linhas.forEach(function (linha) {
        els.corpo.appendChild(criarLinha(linha));
      });
    }

    var rodape = estado.horaReferencia ? "Atualizado às " + estado.horaReferencia : "";
    rodape += complementoRodape();
    els.rodape.textContent = rodape;

    // Resumo mostrado quando o painel está minimizado: linha selecionada e a próxima chegada
    var selecionada = estado.linhas.filter(function (l) { return l.codigo === estado.codigoSelecionado; })[0];
    els.resumo.textContent = selecionada
      ? selecionada.letreiro + " · " + textoTempo(selecionada.veiculos[0].minutos) + (selecionada.destino ? " · " + selecionada.destino : "")
      : (estado.carregando ? "Buscando previsões..." : "Nenhum ônibus previsto agora");
    if (atualizarAlerta()) els.resumo.textContent = "⚠ " + els.resumo.textContent;

    medirAltura();
  }

  function criarLinha(linha) {
    var primeiro = linha.veiculos[0];
    var botao = el("button", "linha");
    botao.type = "button";
    var selecionada = linha.codigo === estado.codigoSelecionado;
    if (selecionada) botao.classList.add("linha--ativa");
    botao.setAttribute("aria-pressed", selecionada ? "true" : "false");

    var corLinha = corDaLinha(linha.cor);
    var etiqueta = el("span", "linha__letreiro", linha.letreiro);
    etiqueta.style.background = "#" + corLinha.fundo;
    etiqueta.style.color = "#" + corLinha.texto;
    botao.appendChild(etiqueta);

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
    Object.keys(marcadores).forEach(function (k) { pararAnimacao(marcadores[k]); });
    camadaOnibus.clearLayers();
    marcadores = {};
  }

  /* ---------- Animação suave do ônibus até a nova posição ---------- */
  // Quando chega uma posição nova, o ônibus desliza até ela em ANIMACAO_MS seguindo o
  // traçado da linha (ou em reta, se não estiver nele). Não inventa posição: termina
  // exatamente no ponto informado pela SPTrans. Saltos grandes, aba escondida ou zoom
  // de longe: vai direto, sem animar.
  var ANIMACAO_MS = 1500, SALTO_MAX_M = 500, ZOOM_MIN_ANIMACAO = 13;

  // Ponto do traçado mais próximo de (lat, lon): índice do trecho, posição no trecho (0 a 1),
  // distância em metros e o ponto projetado.
  function projetarNoTracado(pontos, lat, lon) {
    var k = 111320, cos = Math.cos(lat * Math.PI / 180);
    var px = lon * k * cos, py = lat * k, melhor = null;
    for (var i = 0; i < pontos.length - 1; i++) {
      var ax = pontos[i][1] * k * cos, ay = pontos[i][0] * k;
      var bx = pontos[i + 1][1] * k * cos, by = pontos[i + 1][0] * k;
      var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      var u = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      var d = Math.sqrt(Math.pow(px - (ax + u * dx), 2) + Math.pow(py - (ay + u * dy), 2));
      if (!melhor || d < melhor.d) {
        melhor = { i: i, u: u, d: d, ponto: [pontos[i][0] + u * (pontos[i + 1][0] - pontos[i][0]),
                                              pontos[i][1] + u * (pontos[i + 1][1] - pontos[i][1])] };
      }
    }
    return melhor;
  }

  function comprimentoM(caminho) {
    var total = 0;
    for (var i = 1; i < caminho.length; i++) {
      total += distanciaM({ lat: caminho[i - 1][0], lon: caminho[i - 1][1] }, { lat: caminho[i][0], lon: caminho[i][1] });
    }
    return total;
  }

  // Pedaço do traçado entre a posição antiga (a) e a nova (b). Devolve null (usar reta) se
  // algum dos dois estiver a mais de 40 m do traçado, se b ficar "para trás" de a no sentido
  // do traçado, ou se o pedaço for muito mais longo que a reta (ex.: lado errado de um laço).
  function trechoNoTracado(pontos, a, b) {
    if (!pontos || pontos.length < 2) return null;
    var pa = projetarNoTracado(pontos, a[0], a[1]), pb = projetarNoTracado(pontos, b[0], b[1]);
    if (!pa || !pb || pa.d > 40 || pb.d > 40) return null;
    if (pb.i + pb.u < pa.i + pa.u) return null;
    var caminho = [a, pa.ponto];
    for (var i = pa.i + 1; i <= pb.i; i++) caminho.push(pontos[i]);
    caminho.push(pb.ponto, b);
    var reta = distanciaM({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
    return comprimentoM(caminho) <= reta * 3 + 50 ? caminho : null;
  }

  // Ponto a uma fração (0 a 1) do comprimento de um caminho
  function pontoNaFracao(caminho, comprimentos, total, f) {
    var alvo = total * f;
    for (var i = 1; i < caminho.length; i++) {
      if (comprimentos[i] >= alvo) {
        var trecho = comprimentos[i] - comprimentos[i - 1];
        var t = trecho ? (alvo - comprimentos[i - 1]) / trecho : 1;
        return [caminho[i - 1][0] + t * (caminho[i][0] - caminho[i - 1][0]),
                caminho[i - 1][1] + t * (caminho[i][1] - caminho[i - 1][1])];
      }
    }
    return caminho[caminho.length - 1];
  }

  function pararAnimacao(registro) {
    if (registro && registro.animacao) { cancelAnimationFrame(registro.animacao); registro.animacao = null; }
  }

  function moverSuave(registro, destino, pontosTracado) {
    pararAnimacao(registro);
    var atual = registro.marcador.getLatLng(), origem = [atual.lat, atual.lng];
    var reta = distanciaM({ lat: origem[0], lon: origem[1] }, { lat: destino[0], lon: destino[1] });
    if (reta < 2 || reta > SALTO_MAX_M || document.hidden || mapa.getZoom() < ZOOM_MIN_ANIMACAO ||
        typeof requestAnimationFrame !== "function") {
      registro.marcador.setLatLng(destino);
      return;
    }
    var caminho = trechoNoTracado(pontosTracado, origem, destino) || [origem, destino];
    var comprimentos = [0];
    for (var i = 1; i < caminho.length; i++) {
      comprimentos.push(comprimentos[i - 1] + distanciaM({ lat: caminho[i - 1][0], lon: caminho[i - 1][1] },
                                                        { lat: caminho[i][0], lon: caminho[i][1] }));
    }
    var total = comprimentos[comprimentos.length - 1], inicio = null;
    function quadro(agora) {
      if (inicio === null) inicio = agora;
      var t = Math.min(1, (agora - inicio) / ANIMACAO_MS);
      var f = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // começa e termina devagar
      registro.marcador.setLatLng(t >= 1 ? destino : pontoNaFracao(caminho, comprimentos, total, f));
      registro.animacao = t < 1 ? requestAnimationFrame(quadro) : null;
    }
    registro.animacao = requestAnimationFrame(quadro);
  }

  // Ônibus visto de cima (a frente fica para cima), com teto, para-brisa, faróis e
  // lanternas. O corpo usa a cor da linha (variável CSS --cor); o degradê, o brilho e a
  // sombra dão a ideia de volume. A rotação (variável --rumo) aponta para onde ele anda.
  var ONIBUS_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 64" aria-hidden="true">' +
    '<defs><linearGradient id="onibusLuz" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0" stop-color="#fff" style="stop-opacity:calc(var(--brilho,1)*0.5)"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#000" stop-opacity="0.3"/></linearGradient></defs>' +
    '<rect class="onibus__corpo" x="2" y="1" width="24" height="62" rx="7" stroke="#fff" stroke-width="1.6"/>' +
    '<rect x="2" y="1" width="24" height="62" rx="7" fill="url(#onibusLuz)"/>' +
    '<rect x="5" y="13" width="18" height="42" rx="3.5" fill="#fff" style="opacity:calc(var(--brilho,1)*0.15)"/>' +
    '<rect x="6.2" y="14.5" width="2.6" height="38" rx="1.3" fill="#fff" style="opacity:calc(var(--brilho,1)*0.4)"/>' +
    '<rect x="8" y="22" width="12" height="7" rx="2" fill="#fff" style="opacity:calc(var(--brilho,1)*0.32)"/>' +
    '<rect x="8" y="35" width="12" height="7" rx="2" fill="#fff" style="opacity:calc(var(--brilho,1)*0.32)"/>' +
    '<path d="M5.5 12 L7 4.8 Q14 2.4 21 4.8 L22.5 12 Q14 10.2 5.5 12Z" fill="#111827"/>' +
    '<path d="M8.2 6.4 Q14 5 19.8 6.4" stroke="#fff" stroke-opacity="0.75" stroke-width="0.9" fill="none"/>' +
    '<rect x="7" y="57" width="14" height="3.4" rx="1.4" fill="#111827"/>' +
    '<circle cx="6.6" cy="2.9" r="1.1" fill="#FEF3C7"/><circle cx="21.4" cy="2.9" r="1.1" fill="#FEF3C7"/>' +
    '<rect x="4.4" y="61" width="3.2" height="1.4" rx="0.7" fill="#EF4444"/><rect x="20.4" y="61" width="3.2" height="1.4" rx="0.7" fill="#EF4444"/>' +
    '<rect x="0.4" y="9" width="2" height="3.6" rx="1" fill="#111827"/><rect x="25.6" y="9" width="2" height="3.6" rx="1" fill="#111827"/>' +
    '</svg>';

  // (As cores já foram conferidas como hexadecimal em corDaLinha, então são seguras no HTML.)
  function criarIconeOnibus(cor) {
    // Cores escuras (vinho, azul-escuro) recebem menos brilho branco, senão ficam "lavadas"
    var r = parseInt(cor.fundo.slice(0, 2), 16), g = parseInt(cor.fundo.slice(2, 4), 16), b = parseInt(cor.fundo.slice(4, 6), 16);
    var claridade = 0.299 * r + 0.587 * g + 0.114 * b;
    var brilho = claridade < 100 ? 0.55 : claridade < 150 ? 0.8 : 1;
    var html = '<div class="onibus-etiqueta" hidden></div>' +
      '<div class="onibus3d" style="--cor:#' + cor.fundo + ';--brilho:' + brilho + '">' + ONIBUS_SVG + '</div>';
    return L.divIcon({ className: "onibus-icone", html: html, iconSize: [56, 56], iconAnchor: [28, 28] });
  }

  // Aponta o ônibus para o rumo (em graus). Soma a menor volta possível, para a rotação
  // nunca girar "pelo lado errado" ao passar de 359 para 1 grau.
  function definirRumo(registro, rumo) {
    if (rumo === null) return;
    var alvo = registro.angulo === null ? rumo : registro.angulo + (((rumo - registro.angulo + 540) % 360) - 180);
    if (registro.angulo !== null && Math.abs(alvo - registro.angulo) < 1) return;
    registro.angulo = alvo;
    var elemento = registro.marcador.getElement();
    var onibus = elemento && elemento.querySelector(".onibus3d");
    if (onibus) onibus.style.setProperty("--rumo", alvo + "deg");
  }

  // Diferença entre dois rumos, em graus (0 a 180)
  function diferencaAngular(a, b) {
    return Math.abs(((a - b + 540) % 360) - 180);
  }

  // Direção do traçado no ponto onde o ônibus está (as linhas do GTFS seguem o sentido da
  // viagem). Em traçados de ida e volta pela mesma rua (ex.: N842-11), o trecho mais próximo
  // pode ser o do sentido contrário; por isso, quando o movimento do ônibus é conhecido
  // ("dica"), escolhe entre os trechos próximos o que vai para o mesmo lado que ele. Se nenhum
  // concordar com o movimento, devolve null e vale o movimento. Mais de 60 m do traçado: null.
  function rumoNoTracado(pontos, lat, lon, dica) {
    var k = 111320, cos = Math.cos(lat * Math.PI / 180);
    var px = lon * k * cos, py = lat * k;
    var trechos = [], menor = Infinity;
    for (var i = 0; i < pontos.length - 1; i++) {
      var ax = pontos[i][1] * k * cos, ay = pontos[i][0] * k;
      var bx = pontos[i + 1][1] * k * cos, by = pontos[i + 1][0] * k;
      var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      var u = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      var d = Math.sqrt(Math.pow(px - (ax + u * dx), 2) + Math.pow(py - (ay + u * dy), 2));
      if (d > 60 || !l2) continue;
      trechos.push({ d: d, i: i });
      if (d < menor) menor = d;
    }
    if (trechos.length === 0) return null;
    function rumoDo(t) {
      return rumoEntre({ lat: pontos[t.i][0], lon: pontos[t.i][1] }, { lat: pontos[t.i + 1][0], lon: pontos[t.i + 1][1] });
    }
    if (dica === null || dica === undefined) {
      return rumoDo(trechos.filter(function (t) { return t.d === menor; })[0]);
    }
    var melhor = null, melhorDif = Infinity;
    trechos.forEach(function (t) {
      if (t.d > menor + 25) return;               // só trechos quase tão perto quanto o mais próximo
      var r = rumoDo(t), dif = diferencaAngular(r, dica);
      if (dif < melhorDif) { melhorDif = dif; melhor = r; }
    });
    return melhorDif <= 100 ? melhor : null;
  }

  // Estima a direção do ônibus pelo deslocamento desde a última posição conhecida
  function atualizarRumo(veiculo) {
    var anterior = historico[veiculo.prefixo];
    var atual = { lat: veiculo.lat, lon: veiculo.lon };
    if (!anterior) {
      historico[veiculo.prefixo] = { lat: atual.lat, lon: atual.lon, rumo: null };
      return null;
    }
    if (distanciaM(anterior, atual) >= 20) {      // andou o bastante para saber a direção (evita ruído do GPS)
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
    paradasLinhaAtual = null;
    estado.infoParadas = null;
    if (codigo === null || codigo === undefined) return;

    if (paradasPorLinha[codigo]) {
      estado.infoParadas = { codigo: codigo, total: paradasPorLinha[codigo].length, fonte: "paradas" };
      desenharParadasDaLinha(codigo, paradasPorLinha[codigo]);
      return;
    }
    var linhaAtual = estado.linhas.filter(function (l) { return l.codigo === codigo; })[0] || estado.modoLinha;
    var urlParadas = "api/paradas-linha?linha=" + encodeURIComponent(codigo);
    if (linhaAtual && linhaAtual.letreiro) {
      urlParadas += "&letreiro=" + encodeURIComponent(linhaAtual.letreiro) +
        "&sentido=" + encodeURIComponent(linhaAtual.sentido || "");
    }
    fetch(urlParadas)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (dados) {
        var lista = dados.paradas || [];
        console.info("Paradas da linha " + codigo + ": " + lista.length);
        if (!ativo() || estado.codigoSelecionado !== codigo) return;
        estado.infoParadas = { codigo: codigo, total: lista.length, fonte: dados.fonte };
        if (lista.length > 0) {
          // A lista completa da API fica guardada; a do plano B (via previsão) depende
          // dos ônibus em circulação no momento, então não é guardada
          if (dados.fonte === "paradas" || dados.fonte === "gtfs-stop-times" || dados.fonte === "gtfs-proximidade") paradasPorLinha[codigo] = lista;
          desenharParadasDaLinha(codigo, lista);
        } else {
          vazias[codigo] = (vazias[codigo] || 0) + 1;
          if (vazias[codigo] < 3) paradasDesenhadasDe = null;   // tenta de novo (até 3 vezes)
        }
        renderizar();
      })
      .catch(function () {
        paradasDesenhadasDe = null;   // tenta de novo na próxima atualização
      });
  }

  function desenharParadasDaLinha(codigo, lista) {
    paradasLinhaAtual = { codigo: codigo, lista: lista || [] };
    redesenharParadasDaLinha();
    caminhoParaLinha();
  }

  // Tamanho das paradas da linha pelo zoom: de longe só o traçado; de perto, todas.
  function raioParadaLinha(zoom) {
    if (zoom <= 13) return 0;
    if (zoom === 14) return 2.5;
    if (zoom === 15) return 3.5;
    if (zoom === 16) return 4.5;
    return 6;
  }

  // Paradas da linha como "contas" sobre o traçado: brancas, com borda na cor da linha.
  // Nos zooms 14 e 15, paradas a menos de 20 px de outra já desenhada são puladas.
  // Chamada ao trocar de linha e a cada zoom.
  function redesenharParadasDaLinha() {
    camadaParadasLinha.clearLayers();
    if (!paradasLinhaAtual || !ativo()) return;
    var zoom = mapa.getZoom(), raio = raioParadaLinha(zoom);
    if (!raio) return;
    var codigo = paradasLinhaAtual.codigo;
    var linha = estado.linhas.filter(function (l) { return l.codigo === codigo; })[0] || estado.modoLinha;
    var borda = "#" + escurecer(corDaLinha(linha && linha.cor).fundo, 0.8);
    var desenhadas = [];
    paradasLinhaAtual.lista.forEach(function (p) {
      if (estado.parada && p.id === estado.parada.id) return;   // a escolhida já está destacada
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
      if (zoom <= 15) {
        var ponto = mapa.project([p.lat, p.lon], zoom);
        if (desenhadas.some(function (q) { return q.distanceTo(ponto) < 20; })) return;
        desenhadas.push(ponto);
      }
      L.circleMarker([p.lat, p.lon], {
        radius: raio, color: borda, weight: zoom >= 16 ? 2 : 1.5, fillColor: "#ffffff", fillOpacity: 1
      }).on("click", function () { abrir(p, codigo); })   // tocar noutra parada da linha troca o painel
        .addTo(camadaParadasLinha);
    });
  }

  /* ---------- Caminho a pé até a parada ---------- */
  // Aparece só quando o usuário abre uma parada (caminho até ela) ou busca uma linha
  // (caminho até a parada da linha mais próxima). Regras:
  //   - mais de ROTA_MAX_M em linha reta: não mostra nada (longe demais para ir a pé);
  //   - até ROTA_MAX_M: pede a rota pelas ruas em api/rota-a-pe (OpenRouteService);
  //   - só se o serviço de rotas falhar, desenha a linha reta com tempo estimado
  //     (reta + 30%, a 80 m/min), marcada como aproximada.
  var FATOR_RUAS = 1.3, CAMINHADA_M_MIN = 80, ROTA_MAX_M = 3000;

  function textoCaminho(metros, minutos, aproximado) {
    var m = metros >= 1000 ? (metros / 1000).toFixed(1).replace(".", ",") + " km" : Math.max(10, Math.round(metros / 10) * 10) + " m";
    return "🚶 " + m + " · ~" + Math.max(1, minutos) + " min a pé" + (aproximado ? " (em linha reta, aproximado)" : "");
  }

  function mostrarTextoCaminho(texto) {
    if (!caminho.el) return;
    var nome = caminho.irParaParada && caminho.alvo ? "Parada mais próxima da linha: " + caminho.alvo.nome + " · " : "";
    caminho.el.textContent = texto ? nome + texto : "";
    caminho.el.hidden = !texto;
    caminho.el.disabled = !caminho.irParaParada;
    medirAltura();
  }

  function limparCaminho() {
    if (camadaCaminho) camadaCaminho.clearLayers();
    caminho.alvo = null;
    caminho.origem = null;
    mostrarTextoCaminho("");
  }

  function desenharLinhaCaminho(pontos, reta) {
    camadaCaminho.clearLayers();
    L.polyline(pontos, {
      color: "#8B5CF6", weight: reta ? 3 : 4, opacity: 0.9,
      dashArray: reta ? "2 8" : "1 7", lineCap: "round", lineJoin: "round", interactive: false
    }).addTo(camadaCaminho);
  }

  // parada = destino; irParaParada = true no modo linha (tocar no texto abre a parada)
  function mostrarCaminho(parada, irParaParada) {
    limparCaminho();
    if (!posUsuario || !parada || !Number.isFinite(parada.lat) || !Number.isFinite(parada.lon)) return;
    var origem = posUsuario.slice(), destino = [parada.lat, parada.lon];
    var reta = distanciaM({ lat: origem[0], lon: origem[1] }, { lat: destino[0], lon: destino[1] });
    if (reta > ROTA_MAX_M) return;            // longe demais para ir a pé: não mostra nada
    caminho.alvo = parada;
    caminho.origem = origem;
    caminho.irParaParada = Boolean(irParaParada);

    var chave = origem[0].toFixed(4) + "," + origem[1].toFixed(4) + ">" + destino[0].toFixed(5) + "," + destino[1].toFixed(5);
    var usar = function (rota) {
      if (caminho.alvo !== parada) return;     // a pessoa já abriu outra coisa
      if (!rota || !rota.pontos || rota.pontos.length < 2) { usarReta(); return; }
      desenharLinhaCaminho(rota.pontos, false);
      mostrarTextoCaminho(textoCaminho(rota.distanciaM, Math.round(rota.duracaoS / 60), false));
    };
    // Plano B, só quando o serviço de rotas não responde: linha reta aproximada
    var usarReta = function () {
      if (caminho.alvo !== parada) return;
      desenharLinhaCaminho([origem, destino], true);
      mostrarTextoCaminho(textoCaminho(reta, Math.round(reta * FATOR_RUAS / CAMINHADA_M_MIN), true));
    };
    if (rotasCache[chave]) { usar(rotasCache[chave]); return; }
    fetch("api/rota-a-pe?de=" + origem[0].toFixed(5) + "," + origem[1].toFixed(5) +
          "&para=" + destino[0].toFixed(5) + "," + destino[1].toFixed(5))
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (rota) { rotasCache[chave] = rota; usar(rota); })
      .catch(usarReta);
  }

  // Modo linha: parada da linha mais próxima do usuário
  function caminhoParaLinha() {
    if (!estado.modoLinha || !posUsuario || !paradasLinhaAtual) return;
    var melhor = null, menor = Infinity;
    paradasLinhaAtual.lista.forEach(function (p) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
      var d = distanciaM({ lat: posUsuario[0], lon: posUsuario[1] }, { lat: p.lat, lon: p.lon });
      if (d < menor) { menor = d; melhor = p; }
    });
    if (melhor && melhor !== caminho.alvo) mostrarCaminho(melhor, true);
  }

  // Chamada pelo app.js quando a localização muda. Refaz o caminho se andou mais de 50 m.
  function definirPosicaoUsuario(ll) {
    posUsuario = ll;
    if (!ativo()) return;
    if (caminho.alvo && caminho.origem &&
        distanciaM({ lat: caminho.origem[0], lon: caminho.origem[1] }, { lat: ll[0], lon: ll[1] }) < 50) return;
    if (estado.modoLinha) { caminho.alvo = null; caminhoParaLinha(); }
    else if (estado.parada) mostrarCaminho(estado.parada, false);
    else if (estado.estacao) mostrarCaminho(estado.estacao, false);
  }

  /* ---------- Traçado da linha ---------- */

  // Decodifica a "polilinha codificada" enviada pelo servidor: uma lista de pontos
  // em que cada número é só a diferença para o anterior (em unidades de 0,00001 grau).
  function decodificarPolilinha(texto) {
    var pontos = [], i = 0, lat = 0, lon = 0;
    while (i < texto.length) {
      for (var eixo = 0; eixo < 2; eixo++) {
        var resultado = 0, deslocamento = 0, byte;
        do {
          byte = texto.charCodeAt(i++) - 63;
          resultado |= (byte & 0x1f) << deslocamento;
          deslocamento += 5;
        } while (byte >= 0x20);
        var delta = (resultado & 1) ? ~(resultado >> 1) : (resultado >> 1);
        if (eixo === 0) lat += delta; else lon += delta;
      }
      pontos.push([lat / 1e5, lon / 1e5]);
    }
    return pontos;
  }

  // Escurece uma cor em hexadecimal (fator 0.8 = 20% mais escura). Cores que já são bem
  // escuras ficam como estão, para o traçado não sumir no mapa escuro.
  function escurecer(hex, fator) {
    var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    if (0.299 * r + 0.587 * g + 0.114 * b < 70) fator = 1;
    function dois(n) { var s = Math.round(n * fator).toString(16); return s.length < 2 ? "0" + s : s; }
    return dois(r) + dois(g) + dois(b);
  }

  // Desenha o caminho na cor da linha (fino e um pouco mais escuro, para o ônibus se
  // destacar por cima), com um contorno branco discreto para não se perder no mapa.
  function desenharTracado(linha, pontos) {
    camadaTracado.clearLayers();
    var cor = corDaLinha(linha.cor);
    var opcoes = { interactive: false, lineJoin: "round", lineCap: "round" };
    L.polyline(pontos, Object.assign({ color: "#ffffff", weight: 5, opacity: 0.5 }, opcoes)).addTo(camadaTracado);
    L.polyline(pontos, Object.assign({ color: "#" + escurecer(cor.fundo, 0.8), weight: 3, opacity: 0.95 }, opcoes)).addTo(camadaTracado);
  }

  // Busca o traçado da linha selecionada (uma vez por linha; depois fica guardado)
  function atualizarTracado(linha) {
    var codigo = linha ? linha.codigo : null;
    if (codigo === tracadoDesenhadoDe) return;
    tracadoDesenhadoDe = codigo;
    camadaTracado.clearLayers();
    estado.infoTracado = null;
    if (!linha) return;

    if (tracadosCache[codigo]) {
      estado.infoTracado = { total: tracadosCache[codigo].length };
      desenharTracado(linha, tracadosCache[codigo]);
      return;
    }
    var url = "api/tracado?linha=" + encodeURIComponent(linha.letreiro) +
      "&destino=" + encodeURIComponent(linha.destino || (estado.modoLinha && estado.modoLinha.destino) || "") +
      "&sentido=" + encodeURIComponent(linha.sentido || "");
    // Posições dos ônibus da linha ajudam o servidor a escolher o traçado do sentido certo
    var posicoes = (linha.veiculos || []).slice(0, 6)
      .filter(function (v) { return Number.isFinite(v.lat) && Number.isFinite(v.lon); })
      .map(function (v) { return v.lat.toFixed(5) + "," + v.lon.toFixed(5); });
    if (posicoes.length) url += "&pos=" + encodeURIComponent(posicoes.join(";"));
    fetch(url)
      .then(function (r) {
        if (r.status === 404) return null;            // linha sem traçado no GTFS
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (dados) {
        if (!ativo() || estado.codigoSelecionado !== codigo) return;
        if (!dados) {
          estado.infoTracado = { total: 0 };
        } else {
          var pontos = decodificarPolilinha(dados.polilinha);
          console.info("Traçado da linha " + linha.letreiro + ": " + pontos.length + " pontos (escolhido por " + dados.criterio + ")");
          tracadosCache[codigo] = pontos;
          estado.infoTracado = { total: pontos.length };
          desenharTracado(linha, pontos);
          if (estado.modoLinha) {
            linha.destino = dados.destino;      // destino real da viagem, vindo do GTFS
            estado.ajustarMapa = true;          // com o traçado conhecido, enquadra a linha inteira
          }
        }
        renderizar();
        desenharOnibus();   // agora que há traçado, os ônibus ganham a direção correta
      })
      .catch(function () {
        tracadoDesenhadoDe = null;                    // tenta de novo na próxima atualização
      });
  }

  function desenharOnibus() {
    atualizarParadasDaLinha();
    var linha = estado.linhas.filter(function (l) { return l.codigo === estado.codigoSelecionado; })[0];
    atualizarTracado(linha);
    if (!linha) { limparOnibus(); return; }

    var pontos = estado.parada ? [[estado.parada.lat, estado.parada.lon]] : [];
    var presentes = {};

    linha.veiculos.forEach(function (v) {
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return;
      presentes[v.prefixo] = true;
      pontos.push([v.lat, v.lon]);

      // Direção: primeiro pelo traçado da linha; se não houver, pelo deslocamento
      var rumoMovimento = atualizarRumo(v);
      var rumoTracado = tracadosCache[linha.codigo] ? rumoNoTracado(tracadosCache[linha.codigo], v.lat, v.lon, rumoMovimento) : null;
      var rumo = rumoTracado !== null ? rumoTracado : rumoMovimento;
      var conteudo = conteudoPopup(linha, v);
      var existente = marcadores[v.prefixo];

      if (existente) {
        moverSuave(existente, [v.lat, v.lon], tracadosCache[linha.codigo]);
        definirRumo(existente, rumo);
        existente.popup.setContent(conteudo.raiz);   // atualiza sem fechar o pop-up
        existente.idadeEl = conteudo.idadeEl;
        return;
      }

      var marcador = L.marker([v.lat, v.lon], {
        icon: criarIconeOnibus(corDaLinha(linha.cor)),
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
        offset: [0, -40],
        closeButton: true
      }).setContent(conteudo.raiz);
      marcador.bindPopup(popup);

      marcadores[v.prefixo] = { marcador: marcador, popup: popup, idadeEl: conteudo.idadeEl, angulo: null };
      definirRumo(marcadores[v.prefixo], rumo);
    });

    // Remove ônibus que saíram da lista
    Object.keys(marcadores).forEach(function (prefixo) {
      if (!presentes[prefixo]) {
        pararAnimacao(marcadores[prefixo]);
        camadaOnibus.removeLayer(marcadores[prefixo].marcador);
        delete marcadores[prefixo];
      }
    });

    atualizarIdades();   // etiqueta amarela já no primeiro desenho

    // No modo linha, enquadra o traçado inteiro além dos ônibus
    if (estado.modoLinha && tracadosCache[linha.codigo]) pontos = pontos.concat(tracadosCache[linha.codigo]);

    if (estado.ajustarMapa && pontos.length > (estado.modoLinha ? 0 : 1)) {
      estado.ajustarMapa = false;
      mapa.fitBounds(pontos, {
        paddingTopLeft: [40, 90],
        paddingBottomRight: [40, medirAltura() + 30],
        maxZoom: 17
      });
    }
  }

  // A cada segundo, atualiza o "há N s" do pop-up aberto e a etiqueta amarela em cima dos
  // ônibus com dado velho: conexão falhando, ônibus que não veio na última resposta ou
  // posição do GPS com mais de LIMITE_ETIQUETA_S segundos.
  function atualizarIdades() {
    var linha = estado.linhas.filter(function (l) { return l.codigo === estado.codigoSelecionado; })[0];
    if (!linha) return;
    linha.veiculos.forEach(function (v) {
      var m = marcadores[v.prefixo];
      if (!m) return;
      var idade = idadeSegundos(v.atualizadoEm);
      if (m.marcador.isPopupOpen()) m.idadeEl.textContent = textoIdade(idade);

      var elemento = m.marcador.getElement();
      var etiqueta = elemento && elemento.querySelector(".onibus-etiqueta");
      if (!etiqueta) return;
      var velho = Boolean(estado.erro) || v.ausente || (idade !== null && idade > LIMITE_ETIQUETA_S);
      etiqueta.hidden = !velho;
      elemento.classList.toggle("onibus-velho", velho);
      if (velho) etiqueta.textContent = "⚠ " + textoIdade(idade);
    });
  }

  // Junta a lista nova com os ônibus que não vieram nesta resposta mas apareceram há pouco
  // (a SPTrans às vezes omite um ônibus por uma atualização). Eles ficam na última posição,
  // marcados como "ausente", por até cfg.painel.retencaoMs. "recalcular" (opcional) atualiza
  // os minutos de chegada e devolve false se o ônibus já deveria ter passado.
  function manterAusentes(antigos, novos, recalcular) {
    var agora = Date.now(), limite = (cfg && cfg.painel.retencaoMs) || 120000, presentes = {};
    novos.forEach(function (v) { v.vistoEm = agora; v.ausente = false; presentes[v.prefixo] = true; });
    (antigos || []).forEach(function (v) {
      if (presentes[v.prefixo] || !v.vistoEm || agora - v.vistoEm > limite) return;
      if (recalcular && !recalcular(v)) return;
      v.ausente = true;
      novos.push(v);
    });
    return novos;
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

  // fetch com tempo limite (cfg.painel.tempoLimiteMs) e com a simulação de falhas
  function buscarComLimite(url, controlador) {
    var estourou = false;
    var relogio = setTimeout(function () { estourou = true; controlador.abort(); },
      cfg.painel.tempoLimiteMs || 10000);
    var espera = Promise.resolve();
    if (simulacao && estado.ultimoSucesso) {
      if (simulacao === "falha") {
        clearTimeout(relogio);
        return Promise.reject(new Error("Falha simulada"));
      }
      if (simulacao === "lento") espera = new Promise(function (ok) { setTimeout(ok, 15000); });
    }
    return espera
      .then(function () {
        if (controlador.signal.aborted) throw new DOMException("cancelado", "AbortError");
        return fetch(url, { signal: controlador.signal });
      })
      .catch(function (erro) {
        if (estourou) { var e = new Error("Tempo esgotado"); e.name = "TempoEsgotado"; throw e; }
        throw erro;
      })
      .finally(function () { clearTimeout(relogio); });
  }

  // Texto do aviso de dado velho (vazio quando está tudo em dia)
  function textoAlerta() {
    var veiculos = [];
    if (estado.modoLinha) { if (estado.linhas[0]) veiculos = estado.linhas[0].veiculos; }
    else estado.linhas.forEach(function (l) { veiculos = veiculos.concat(l.veiculos); });
    if (veiculos.length === 0) {
      // Nada carregado ainda e a consulta falhou: avisa e mostra quando tenta de novo
      if (!estado.erro) return "";
      var faltam = Math.max(0, Math.ceil((estado.proximaEm - Date.now()) / 1000));
      return "⚠ Sem resposta da SPTrans. Tentando de novo " + (faltam > 0 ? "em " + faltam + " s." : "agora...");
    }

    // 1) A atualização falhou: os dados na tela são da última vez que deu certo
    if (estado.erro && estado.ultimoSucesso) {
      var s = Math.round((Date.now() - estado.ultimoSucesso) / 1000);
      return "⚠ Dados desatualizados: última atualização " + textoIdade(s) + ". " + estado.erro +
        (estado.modoLinha ? "" : " Os tempos podem estar errados.");
    }
    // 2) A consulta funcionou, mas o GPS de todos os ônibus está parado há muito tempo
    var maisNova = null;
    veiculos.forEach(function (v) {
      var idade = idadeSegundos(v.atualizadoEm);
      if (idade !== null && (maisNova === null || idade < maisNova)) maisNova = idade;
    });
    if (maisNova !== null && maisNova > LIMITE_GPS_S) {
      return "⚠ A SPTrans não envia posições novas " + textoIdade(maisNova) + ".";
    }
    return "";
  }

  // Mostra, atualiza ou tira a faixa de aviso (chamada ao desenhar e a cada segundo)
  function atualizarAlerta() {
    if (!els || (!estado.parada && !estado.modoLinha)) return;
    var texto = textoAlerta();
    if (!texto) {
      if (alertaEl && alertaEl.parentNode) alertaEl.parentNode.removeChild(alertaEl);
      alertaEl = null;
    } else {
      if (!alertaEl || alertaEl.parentNode !== els.corpo) {
        alertaEl = el("p", "painel__alerta", "");
        alertaEl.setAttribute("role", "status");
        els.corpo.insertBefore(alertaEl, els.corpo.firstChild);
      }
      alertaEl.textContent = texto;
    }
    return texto;
  }

  function agendar(ms) {
    clearTimeout(estado.timer);
    estado.proximaEm = Date.now() + ms;   // usado no aviso "tentando de novo em N s"
    estado.timer = setTimeout(estado.modoLinha ? buscarLinha : buscar, ms);
  }

  function buscar() {
    if (!estado.parada) return;
    if (document.hidden) { estado.timer = null; return; }   // pausa com a aba em segundo plano

    if (estado.controlador) estado.controlador.abort();
    var controlador = new AbortController();
    estado.controlador = controlador;
    var id = estado.parada.id;

    buscarComLimite("api/previsao?parada=" + encodeURIComponent(id), controlador)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        estado.dataServidor = Date.parse(r.headers.get("Date"));
        estado.recebidoEm = performance.now();
        return r.json();
      })
      .then(function (dados) {
        if (!estado.parada || estado.parada.id !== id) return;
        var novas = processar(dados);
        var recalcular = function (v) {
          v.minutos = minutosAte(v.chegada, dados.horaReferencia);
          return v.minutos !== null;
        };
        estado.linhas.forEach(function (antiga) {
          var nova = novas.filter(function (l) { return l.codigo === antiga.codigo; })[0];
          if (nova) {
            nova.veiculos = manterAusentes(antiga.veiculos, nova.veiculos, recalcular);
          } else {
            // A linha não veio nesta resposta: mantém por um tempo, com os ônibus na última posição
            var mantidos = manterAusentes(antiga.veiculos, [], recalcular);
            if (mantidos.length) { antiga.veiculos = mantidos; novas.push(antiga); }
          }
        });
        novas.forEach(function (l) {
          if (l.veiculos.some(function (v) { return !v.vistoEm; })) manterAusentes([], l.veiculos);
          l.veiculos.sort(function (a, b) { return a.minutos - b.minutos; });
        });
        novas.sort(function (a, b) { return a.veiculos[0].minutos - b.veiculos[0].minutos; });
        estado.linhas = novas;
        estado.horaReferencia = dados.horaReferencia;
        estado.erro = null;
        estado.ultimoSucesso = Date.now();
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
        estado.erro = erro.name === "TempoEsgotado" ? "A SPTrans demorou para responder."
          : "Não foi possível atualizar as previsões.";
        // Espera cada vez mais entre as tentativas, até um limite
        estado.atrasoMs = Math.min((estado.atrasoMs || cfg.painel.atualizacaoMs) * 2, cfg.painel.atualizacaoMaxMs);
        renderizar();
        agendar(estado.atrasoMs);
      });
  }

  /* ---------- Abrir e fechar ---------- */

  // Posição dos ônibus da linha aberta pela busca (atualiza sozinha, como as previsões)
  function buscarLinha() {
    var item = estado.modoLinha;
    if (!item) return;
    if (document.hidden) { estado.timer = null; return; }

    if (estado.controlador) estado.controlador.abort();
    var controlador = new AbortController();
    estado.controlador = controlador;

    buscarComLimite("api/posicao?linha=" + encodeURIComponent(item.codigo), controlador)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        estado.dataServidor = Date.parse(r.headers.get("Date"));
        estado.recebidoEm = performance.now();
        return r.json();
      })
      .then(function (dados) {
        if (!estado.modoLinha || estado.modoLinha.codigo !== item.codigo) return;
        var linha = estado.linhas[0];
        linha.veiculos = manterAusentes(linha.veiculos, (dados.veiculos || []).map(function (v) {
          return { prefixo: v.prefixo, acessivel: v.acessivel, atualizadoEm: v.atualizadoEm,
                   lat: v.lat, lon: v.lon, chegada: null, minutos: null };
        }));
        estado.horaReferencia = dados.horaReferencia;
        estado.erro = null;
        estado.ultimoSucesso = Date.now();
        estado.carregando = false;
        estado.atrasoMs = cfg.painel.atualizacaoMs;
        renderizar();
        desenharOnibus();
        agendar(estado.atrasoMs);
      })
      .catch(function (erro) {
        if (erro.name === "AbortError") return;
        if (!estado.modoLinha || estado.modoLinha.codigo !== item.codigo) return;
        estado.carregando = false;
        estado.erro = erro.name === "TempoEsgotado" ? "A SPTrans demorou para responder."
          : "Não foi possível atualizar os ônibus.";
        estado.atrasoMs = Math.min((estado.atrasoMs || cfg.painel.atualizacaoMs) * 2, cfg.painel.atualizacaoMaxMs);
        renderizar();
        agendar(estado.atrasoMs);
      });
  }

  // Abre uma linha escolhida na busca: traçado, paradas da linha e ônibus em circulação
  function abrirLinha(item) {
    if (estado.controlador) estado.controlador.abort();
    clearTimeout(estado.timer);

    estado.parada = null;
    estado.estacao = null;
    estado.modoLinha = item;
    estado.linhas = [{ codigo: item.codigo, letreiro: item.letreiro, destino: null,
                       sentido: item.sentido, cor: item.cor, veiculos: [] }];
    estado.codigoSelecionado = item.codigo;
    estado.horaReferencia = null;
    estado.erro = null;
    estado.ultimoSucesso = 0;
    estado.carregando = true;
    estado.ajustarMapa = true;
    estado.atrasoMs = cfg.painel.atualizacaoMs;
    estado.infoParadas = null;
    estado.infoTracado = null;

    limparOnibus();
    historico = {};
    limparCaminho();
    camadaSelecao.clearLayers();
    camadaParadasLinha.clearLayers();
    paradasLinhaAtual = null;
    camadaTracado.clearLayers();
    paradasDesenhadasDe = null;
    tracadoDesenhadoDe = null;

    els.painel.classList.add("aberto");
    minimizar(false);
    avisarMudanca();
    renderizar();
    buscarLinha();
  }

  // Recolhe o painel (só o cabeçalho com o resumo) ou o abre de novo
  function minimizar(valor) {
    estado.minimizado = (valor === undefined) ? !estado.minimizado : valor;
    els.painel.classList.toggle("minimizado", estado.minimizado);
    els.minimizar.setAttribute("aria-expanded", String(!estado.minimizado));
    els.minimizar.setAttribute("aria-label", estado.minimizado ? "Expandir painel" : "Minimizar painel");
    medirAltura();
  }

  function abrir(parada, linhaPreferida) {
    if (estado.controlador) estado.controlador.abort();
    clearTimeout(estado.timer);

    estado.modoLinha = null;
    estado.estacao = null;
    estado.parada = parada;
    estado.linhas = [];
    estado.codigoSelecionado = linhaPreferida || null;
    estado.horaReferencia = null;
    estado.erro = null;
    estado.ultimoSucesso = 0;
    estado.carregando = true;
    estado.ajustarMapa = false;
    estado.atrasoMs = cfg.painel.atualizacaoMs;

    limparOnibus();
    historico = {};
    camadaSelecao.clearLayers();
    paradasDesenhadasDe = null;
    atualizarParadasDaLinha();   // se já conhecemos a linha, redesenha na hora
    if (!linhaPreferida) { camadaTracado.clearLayers(); tracadoDesenhadoDe = null; estado.infoTracado = null; }
    // A parada escolhida fica desenhada aqui (as outras somem enquanto o painel está aberto)
    L.circleMarker([parada.lat, parada.lon], {
      radius: 7, color: "#ffffff", weight: 2, fillColor: "#8B5CF6", fillOpacity: 1, interactive: false
    }).addTo(camadaSelecao);
    L.circleMarker([parada.lat, parada.lon], {
      radius: 13, color: "#8B5CF6", weight: 3, fill: false, interactive: false
    }).addTo(camadaSelecao);

    els.painel.classList.add("aberto");
    minimizar(false);          // ao abrir uma parada, o painel começa aberto
    avisarMudanca();
    mostrarCaminho(parada, false);
    renderizar();
    mostrarParadaAcima();
    buscar();
  }

  function fechar() {
    if (estado.controlador) estado.controlador.abort();
    clearTimeout(estado.timer);
    estado.parada = null;
    estado.modoLinha = null;
    estado.estacao = null;
    estado.infoParadas = null;
    estado.infoTracado = null;
    limparOnibus();
    historico = {};
    camadaSelecao.clearLayers();
    camadaParadasLinha.clearLayers();
    paradasLinhaAtual = null;
    paradasDesenhadasDe = null;
    camadaTracado.clearLayers();
    tracadoDesenhadoDe = null;
    limparCaminho();
    els.painel.classList.remove("aberto");
    minimizar(false);
    avisarMudanca();
  }

  function estaAberto() {
    return ativo();
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
      rodape: document.getElementById("painelRodape"),
      resumo: document.getElementById("painelResumo"),
      minimizar: document.getElementById("painelMinimizar")
    };
    camadaSelecao = L.layerGroup().addTo(mapa);
    camadaTracado = L.layerGroup().addTo(mapa);         // embaixo das paradas e dos ônibus
    camadaParadasLinha = L.layerGroup().addTo(mapa);
    camadaCaminho = L.layerGroup().addTo(mapa);
    camadaOnibus = L.layerGroup().addTo(mapa);

    // Linha com a distância a pé, entre o cabeçalho e a lista do painel
    caminho.el = document.createElement("button");
    caminho.el.type = "button";
    caminho.el.className = "painel__caminho";
    caminho.el.hidden = true;
    caminho.el.addEventListener("click", function () {
      if (caminho.irParaParada && caminho.alvo && estado.modoLinha) abrir(caminho.alvo, estado.modoLinha.codigo);
    });
    els.corpo.parentNode.insertBefore(caminho.el, els.corpo);

    // O ônibus cresce quando o mapa se aproxima e diminui quando se afasta
    function atualizarEscala() {
      var escala = Math.max(0.6, Math.min(1.8, 1.25 * Math.pow(1.25, mapa.getZoom() - 17)));
      mapa.getContainer().style.setProperty("--escala-onibus", escala.toFixed(3));
    }
    mapa.on("zoom zoomend", atualizarEscala);
    mapa.on("zoomend", redesenharParadasDaLinha);
    atualizarEscala();

    document.getElementById("painelFechar").addEventListener("click", fechar);
    els.minimizar.addEventListener("click", function () { minimizar(); });
    // Tocar na alça alterna; tocar no título só serve para reabrir quando está minimizado
    els.painel.querySelector(".painel__alca").addEventListener("click", function () { minimizar(); });
    els.painel.querySelector(".painel__textos").addEventListener("click", function () {
      if (estado.minimizado) minimizar(false);
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") fechar(); });
    window.addEventListener("resize", medirAltura);
    setInterval(function () { atualizarIdades(); atualizarAlerta(); }, 1000);

    // Ao voltar para a aba, atualiza na hora
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      if (estado.modoLinha) buscarLinha();
      else if (estado.parada) buscar();
    });
  }

  window.Painel = {
    iniciar: iniciar,
    abrir: abrir,
    abrirLinha: abrirLinha,
    corDaLinha: corDaLinha,
    fechar: fechar,
    estaAberto: estaAberto,
    definirPosicaoUsuario: definirPosicaoUsuario,
    abrirEstacao: abrirEstacao,
    decodificarPolilinha: decodificarPolilinha,
    _teste: {
      paraMinutos: paraMinutos, minutosAte: minutosAte, textoTempo: textoTempo,
      processar: processar, decodificarPolilinha: decodificarPolilinha, rumoNoTracado: rumoNoTracado, distanciaM: distanciaM, rumoEntre: rumoEntre, textoIdade: textoIdade,
      diferencaAngular: diferencaAngular, manterAusentes: manterAusentes, raioParadaLinha: raioParadaLinha, textoCaminho: textoCaminho,
      trechoNoTracado: trechoNoTracado, situacaoSentido: situacaoSentido, textoHora: textoHora
    }
  };
})();