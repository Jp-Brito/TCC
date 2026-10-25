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
    minimizado: false,     // painel recolhido (só o cabeçalho), para ver mais do mapa
    carregando: false,
    ajustarMapa: false,    // true = na próxima atualização, enquadrar parada + ônibus
    controlador: null,
    timer: null,
    atrasoMs: 0,
    linhaPreferida: null,  // linha a manter selecionada ao trocar de parada
    infoParadas: null,     // { codigo, total } paradas da linha selecionada, para o rodapé
    infoTracado: null,     // { total } pontos do traçado da linha selecionada, para o rodapé
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
    if (estado.infoParadas) {
      rodape += " · linha " + estado.infoParadas.codigo + ": " +
        (estado.infoParadas.total > 0
          ? estado.infoParadas.total + " paradas" + (estado.infoParadas.fonte === "previsao" ? " (via previsão)" : "")
          : "a API não devolveu paradas");
    }
    if (estado.infoTracado) {
      rodape += " · traçado: " + (estado.infoTracado.total > 0 ? estado.infoTracado.total + " pontos" : "indisponível");
    }
    els.rodape.textContent = rodape;

    // Resumo mostrado quando o painel está minimizado: linha selecionada e a próxima chegada
    var selecionada = estado.linhas.filter(function (l) { return l.codigo === estado.codigoSelecionado; })[0];
    els.resumo.textContent = selecionada
      ? selecionada.letreiro + " · " + textoTempo(selecionada.veiculos[0].minutos) + (selecionada.destino ? " · " + selecionada.destino : "")
      : (estado.carregando ? "Buscando previsões..." : "Nenhum ônibus previsto agora");

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
    camadaOnibus.clearLayers();
    marcadores = {};
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
    var html = '<div class="onibus3d" style="--cor:#' + cor.fundo + ';--brilho:' + brilho + '">' + ONIBUS_SVG + '</div>';
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

  // Direção do trecho do traçado mais próximo do ônibus (as linhas do GTFS seguem o
  // sentido da viagem). Se o ônibus estiver a mais de 60 m do traçado, devolve null.
  function rumoNoTracado(pontos, lat, lon) {
    var k = 111320, cos = Math.cos(lat * Math.PI / 180);
    var px = lon * k * cos, py = lat * k;
    var menor = Infinity, rumo = null;
    for (var i = 0; i < pontos.length - 1; i++) {
      var ax = pontos[i][1] * k * cos, ay = pontos[i][0] * k;
      var bx = pontos[i + 1][1] * k * cos, by = pontos[i + 1][0] * k;
      var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      var u = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      var d = Math.sqrt(Math.pow(px - (ax + u * dx), 2) + Math.pow(py - (ay + u * dy), 2));
      if (d < menor) {
        menor = d;
        rumo = rumoEntre({ lat: pontos[i][0], lon: pontos[i][1] }, { lat: pontos[i + 1][0], lon: pontos[i + 1][1] });
      }
    }
    return menor <= 60 ? rumo : null;
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
    estado.infoParadas = null;
    if (codigo === null || codigo === undefined) return;

    if (paradasPorLinha[codigo]) {
      estado.infoParadas = { codigo: codigo, total: paradasPorLinha[codigo].length, fonte: "paradas" };
      desenharParadasDaLinha(codigo, paradasPorLinha[codigo]);
      return;
    }
    fetch("api/paradas-linha?linha=" + encodeURIComponent(codigo))
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (dados) {
        var lista = dados.paradas || [];
        console.info("Paradas da linha " + codigo + ": " + lista.length);
        if (!estado.parada || estado.codigoSelecionado !== codigo) return;
        estado.infoParadas = { codigo: codigo, total: lista.length, fonte: dados.fonte };
        if (lista.length > 0) {
          // A lista completa da API fica guardada; a do plano B (via previsão) depende
          // dos ônibus em circulação no momento, então não é guardada
          if (dados.fonte !== "previsao") paradasPorLinha[codigo] = lista;
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
    camadaParadasLinha.clearLayers();
    (lista || []).forEach(function (p) {
      if (!estado.parada || p.id === estado.parada.id) return;   // a escolhida já está destacada
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
      L.circleMarker([p.lat, p.lon], {
        radius: 7, color: "#ffffff", weight: 2, fillColor: "#8B5CF6", fillOpacity: 1
      }).on("click", function () { abrir(p, codigo); })   // tocar noutra parada da linha troca o painel
        .addTo(camadaParadasLinha);
    });
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
      "&destino=" + encodeURIComponent(linha.destino || "") +
      "&sentido=" + encodeURIComponent(linha.sentido || "");
    fetch(url)
      .then(function (r) {
        if (r.status === 404) return null;            // linha sem traçado no GTFS
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (dados) {
        if (!estado.parada || estado.codigoSelecionado !== codigo) return;
        if (!dados) {
          estado.infoTracado = { total: 0 };
        } else {
          var pontos = decodificarPolilinha(dados.polilinha);
          console.info("Traçado da linha " + linha.letreiro + ": " + pontos.length + " pontos (escolhido por " + dados.criterio + ")");
          tracadosCache[codigo] = pontos;
          estado.infoTracado = { total: pontos.length };
          desenharTracado(linha, pontos);
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

    var pontos = [[estado.parada.lat, estado.parada.lon]];
    var presentes = {};

    linha.veiculos.forEach(function (v) {
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return;
      presentes[v.prefixo] = true;
      pontos.push([v.lat, v.lon]);

      // Direção: primeiro pelo traçado da linha; se não houver, pelo deslocamento
      var rumoMovimento = atualizarRumo(v);
      var rumoTracado = tracadosCache[linha.codigo] ? rumoNoTracado(tracadosCache[linha.codigo], v.lat, v.lon) : null;
      var rumo = rumoTracado !== null ? rumoTracado : rumoMovimento;
      var conteudo = conteudoPopup(linha, v);
      var existente = marcadores[v.prefixo];

      if (existente) {
        existente.marcador.setLatLng([v.lat, v.lon]);
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
    camadaTracado.clearLayers();
    tracadoDesenhadoDe = null;
    els.painel.classList.remove("aberto");
    minimizar(false);
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
      rodape: document.getElementById("painelRodape"),
      resumo: document.getElementById("painelResumo"),
      minimizar: document.getElementById("painelMinimizar")
    };
    camadaSelecao = L.layerGroup().addTo(mapa);
    camadaTracado = L.layerGroup().addTo(mapa);         // embaixo das paradas e dos ônibus
    camadaParadasLinha = L.layerGroup().addTo(mapa);
    camadaOnibus = L.layerGroup().addTo(mapa);

    // O ônibus cresce quando o mapa se aproxima e diminui quando se afasta
    function atualizarEscala() {
      var escala = Math.max(0.6, Math.min(1.8, 1.25 * Math.pow(1.25, mapa.getZoom() - 17)));
      mapa.getContainer().style.setProperty("--escala-onibus", escala.toFixed(3));
    }
    mapa.on("zoom zoomend", atualizarEscala);
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
      processar: processar, decodificarPolilinha: decodificarPolilinha, rumoNoTracado: rumoNoTracado, distanciaM: distanciaM, rumoEntre: rumoEntre, textoIdade: textoIdade
    }
  };
})();