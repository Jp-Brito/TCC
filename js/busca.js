// Busca de linhas: o usuário toca na lupa, digita o número ou o nome da linha e vê até 5
// opções. Ao tocar numa opção, a linha é aberta no mapa (traçado, paradas e ônibus).
(function () {
  "use strict";

  var MAXIMO = 5;        // número máximo de opções na lista
  var ATRASO_MS = 350;   // espera depois da última tecla, para não consultar a API a cada letra
  var MINIMO = 2;        // mínimo de caracteres para buscar

  var els = {};
  var aoEscolher = null;
  var controlador = null;
  var timer = null;

  function el(tag, classe, texto) {
    var e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined) e.textContent = texto;   // textContent: nunca interpreta HTML
    return e;
  }

  // Ordem das opções: linha exata primeiro, depois as que começam com o que foi digitado
  function pontuar(item, termo) {
    var letreiro = item.letreiro.toLowerCase();
    var t = termo.toLowerCase();
    if (letreiro === t || letreiro.split("-")[0] === t) return 0;
    if (letreiro.indexOf(t) === 0) return 1;
    if (letreiro.indexOf(t) > -1) return 2;
    return 3;
  }

  function ordenar(lista, termo) {
    return lista
      .map(function (item, i) { return { item: item, i: i, p: pontuar(item, termo) }; })
      .sort(function (a, b) { return a.p - b.p || a.i - b.i; })
      .map(function (o) { return o.item; });
  }

  function mensagem(texto) {
    els.msg.textContent = texto || "";
  }

  function limparLista() {
    els.lista.textContent = "";
  }

  function mostrar(lista, termo) {
    limparLista();
    if (lista.length === 0) {
      mensagem("Nenhuma linha encontrada para “" + termo + "”.");
      return;
    }
    var total = lista.length;
    ordenar(lista, termo).slice(0, MAXIMO).forEach(function (linha) {
      var cor = window.Painel.corDaLinha(linha.cor);
      var li = el("li");
      var botao = el("button", "busca__item");
      botao.type = "button";

      var pilula = el("span", "busca__pilula", linha.letreiro);
      pilula.style.background = "#" + cor.fundo;
      pilula.style.color = "#" + cor.texto;
      botao.appendChild(pilula);

      var texto = el("span", "busca__texto");
      texto.appendChild(el("span", "busca__nome", linha.terminalPrincipal + " ⇄ " + linha.terminalSecundario));
      texto.appendChild(el("span", "busca__detalhe", "sentido " + linha.sentido + (linha.circular ? " · circular" : "")));
      botao.appendChild(texto);

      botao.addEventListener("click", function () {
        fechar();
        if (aoEscolher) {
          aoEscolher({
            codigo: linha.codigo,
            letreiro: linha.letreiro,
            sentido: linha.sentido,
            cor: linha.cor,
            destino: linha.destino,
            rotulo: linha.terminalPrincipal + " ⇄ " + linha.terminalSecundario + " · sentido " + linha.sentido
          });
        }
      });
      li.appendChild(botao);
      els.lista.appendChild(li);
    });
    mensagem(total > MAXIMO ? "Mostrando " + MAXIMO + " de " + total + ". Digite mais para refinar." : "");
  }

  function buscar(termo) {
    if (controlador) controlador.abort();
    controlador = new AbortController();
    mensagem("Buscando...");
    fetch("api/linhas?termo=" + encodeURIComponent(termo), { signal: controlador.signal })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (dados) {
        if (els.entrada.value.trim() !== termo) return;   // o usuário já digitou outra coisa
        mostrar(dados.linhas || [], termo);
      })
      .catch(function (erro) {
        if (erro.name === "AbortError") return;
        limparLista();
        mensagem("Não foi possível buscar agora. Tente de novo.");
      });
  }

  function aoDigitar() {
    clearTimeout(timer);
    var termo = els.entrada.value.trim();
    if (termo.length < MINIMO) {
      if (controlador) controlador.abort();
      limparLista();
      mensagem(termo.length === 0 ? "" : "Digite pelo menos " + MINIMO + " caracteres.");
      return;
    }
    timer = setTimeout(function () { buscar(termo); }, ATRASO_MS);
  }

  function abrir() {
    els.caixa.hidden = false;
    els.botao.setAttribute("aria-expanded", "true");
    els.entrada.focus();
  }

  function fechar() {
    clearTimeout(timer);
    if (controlador) controlador.abort();
    els.caixa.hidden = true;
    els.botao.setAttribute("aria-expanded", "false");
    els.entrada.value = "";
    limparLista();
    mensagem("");
    els.entrada.blur();
  }

  function alternar() {
    if (els.caixa.hidden) abrir(); else fechar();
  }

  function iniciar(funcaoAoEscolher) {
    aoEscolher = funcaoAoEscolher;
    els = {
      botao: document.getElementById("btnBusca"),
      caixa: document.getElementById("busca"),
      entrada: document.getElementById("buscaEntrada"),
      lista: document.getElementById("buscaLista"),
      msg: document.getElementById("buscaMsg")
    };
    els.botao.addEventListener("click", alternar);
    document.getElementById("buscaFechar").addEventListener("click", fechar);
    els.entrada.addEventListener("input", aoDigitar);
    els.entrada.addEventListener("keydown", function (e) {
      if (e.key === "Escape") fechar();
      if (e.key === "Enter") {              // Enter abre a primeira opção
        var primeiro = els.lista.querySelector("button");
        if (primeiro) primeiro.click();
      }
    });
  }

  window.Busca = { iniciar: iniciar, alternar: alternar, fechar: fechar, _teste: { ordenar: ordenar, pontuar: pontuar } };
})();
