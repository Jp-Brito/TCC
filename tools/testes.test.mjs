// Testes automáticos do protótipo (node:test, sem bibliotecas extras).
// Rodar:  npm test     (ou: node --test tools/testes.test.mjs)
// Cada execução acrescenta uma linha em tools/medicoes/testes.csv
// (data, total, quantos passaram, quantos falharam e quais), como registro para o TCC.
// Não chamam a Olho Vivo nem a OpenRouteService de verdade: as respostas são simuladas.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import vm from "node:vm";
import * as gtfs from "../lib/gtfs.js";
import linhas from "../api/linhas.js";
import previsao from "../api/previsao.js";
import rotaAPe from "../api/rota-a-pe.js";

process.env.OLHOVIVO_TOKEN = "token-de-teste";   // só para os testes; a Olho Vivo é simulada

/* ---------- Registro dos resultados ---------- */
const resultados = [];
function caso(nome, fn) {
  test(nome, async () => {
    try { await fn(); resultados.push({ nome, ok: true }); }
    catch (erro) { resultados.push({ nome, ok: false }); throw erro; }
  });
}
after(() => {
  const pasta = new URL("./medicoes/", import.meta.url);
  const arquivo = new URL("testes.csv", pasta);
  if (!existsSync(pasta)) mkdirSync(pasta, { recursive: true });
  if (!existsSync(arquivo)) appendFileSync(arquivo, "dataHora,total,passou,falhou,falhas\n");
  const falhas = resultados.filter((r) => !r.ok).map((r) => r.nome.replace(/[",]/g, " ")).join(" | ");
  const passou = resultados.filter((r) => r.ok).length;
  appendFileSync(arquivo, `${new Date().toISOString()},${resultados.length},${passou},${resultados.length - passou},"${falhas}"\n`);
});

/* ---------- Funções do site (js/painel.js), carregadas sem navegador ---------- */
const contexto = { window: {}, location: { search: "" }, URLSearchParams, performance, console };
vm.runInNewContext(readFileSync(new URL("../js/painel.js", import.meta.url), "utf8"), contexto);
const P = contexto.window.Painel._teste;
// Listas criadas dentro do vm têm outro "Array"; JSON deixa comparáveis
const simples = (x) => JSON.parse(JSON.stringify(x));

caso("minutos: conta normal e virada da meia-noite", () => {
  assert.equal(P.minutosAte("10:15", "10:05"), 10);
  assert.equal(P.minutosAte("00:02", "23:59"), 3);
  assert.equal(P.minutosAte("10:00", "10:05"), null);    // já passou
  assert.equal(P.textoTempo(0), "Chegando");
});

caso("traçado: decodifica a polilinha do Google", () => {
  const pontos = P.decodificarPolilinha("_p~iF~ps|U_ulLnnqC_mqNvxq`@");   // exemplo da documentação
  assert.deepEqual(simples(pontos.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)])),
    [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

caso("direção: em traçado de ida e volta (laço), segue o movimento do ônibus", () => {
  // ida para leste e, 15 m ao norte, volta para oeste (como a N842-11)
  const laco = [[0, 0], [0, 0.01], [0.000135, 0.01], [0.000135, 0]];
  const leste = P.rumoNoTracado(laco, 0.0001, 0.005, 90);
  const oeste = P.rumoNoTracado(laco, 0.00002, 0.005, 270);
  assert.ok(P.diferencaAngular(leste, 90) < 5, "ônibus indo para leste");
  assert.ok(P.diferencaAngular(oeste, 270) < 5, "ônibus indo para oeste");
  assert.equal(P.rumoNoTracado(laco, 0.01, 0.005, 90), null);   // longe do traçado
});

caso("ônibus ausente na resposta fica por até 2 min", () => {
  const agora = Date.now();
  const antigos = [{ prefixo: "1", vistoEm: agora - 5000 }, { prefixo: "2", vistoEm: agora - 200000 }];
  const lista = P.manterAusentes(antigos, [{ prefixo: "3" }]);
  assert.deepEqual(simples(lista.map((v) => v.prefixo + (v.ausente ? "*" : ""))), ["3", "1*"]);
});

caso("animação: o ônibus desliza pelo traçado, não pela reta", () => {
  // traçado em "L": leste e depois norte (uma esquina)
  const tracado = [[0, 0], [0, 0.002], [0.002, 0.002]];
  const caminho = simples(P.trechoNoTracado(tracado, [0, 0.0005], [0.0015, 0.002]));
  assert.ok(caminho.some(([a, b]) => a === 0 && b === 0.002), "passa pela esquina");
  assert.deepEqual(caminho.at(-1), [0.0015, 0.002]);        // termina na posição real
  assert.equal(P.trechoNoTracado(tracado, [0.0015, 0.002], [0, 0.0005]), null);   // andando "para trás": reta
  assert.equal(P.trechoNoTracado(tracado, [0.01, 0.01], [0, 0.0005]), null);      // fora do traçado: reta
});

caso("paradas da linha: tamanho pelo zoom", () => {
  assert.equal(P.raioParadaLinha(13), 0);
  assert.ok(P.raioParadaLinha(14) < P.raioParadaLinha(16));
});

caso("caminho a pé: texto da distância", () => {
  assert.equal(P.textoCaminho(396, 5, false), "🚶 400 m · ~5 min a pé");
  assert.match(P.textoCaminho(1530, 25, true), /1,5 km .*aproximado/);
});

/* ---------- Servidor ---------- */

function respostaFalsa() {
  return {
    codigo: null, corpo: null,
    setHeader() {},
    status(c) { this.codigo = c; return this; },
    json(b) { this.corpo = b; }
  };
}
// Troca o fetch por respostas prontas durante um teste
async function comFetch(responder, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => responder(String(url));
  try { await fn(); } finally { globalThis.fetch = original; }
}
const olhoVivoFalsa = (dados) => (url) => url.includes("/Login/")
  ? new Response("true", { headers: { "set-cookie": "sessao=1; path=/" } })
  : new Response(JSON.stringify(dados));

caso("sentido: /api/linhas põe o destino certo (1 = principal, 2 = secundário)", async () => {
  const res = respostaFalsa();
  await comFetch(olhoVivoFalsa([
    { cl: 1, lt: "5119", tl: 10, sl: 1, lc: false, tp: "LGO. SÃO FRANCISCO", ts: "TERM. CAPELINHA" },
    { cl: 32769, lt: "5119", tl: 10, sl: 2, lc: false, tp: "LGO. SÃO FRANCISCO", ts: "TERM. CAPELINHA" }
  ]), () => linhas({ method: "GET", query: { termo: "5119" } }, res));
  assert.equal(res.codigo, 200);
  assert.equal(res.corpo.linhas[0].destino, "LGO. SÃO FRANCISCO");
  assert.equal(res.corpo.linhas[1].destino, "TERM. CAPELINHA");
});

caso("sentido: /api/previsao usa o sentido para escolher o destino", async () => {
  const res = respostaFalsa();
  await comFetch(olhoVivoFalsa({ hr: "01:49", p: { cp: 450011848, np: "C/B", py: -23.6, px: -46.7, l: [
    { c: "5119-10", cl: 32769, sl: 2, lt0: "LGO. SÃO FRANCISCO", lt1: "TERM. CAPELINHA", vs: [] }
  ] } }), () => previsao({ method: "GET", query: { parada: "450011848" } }, res));
  assert.equal(res.corpo.linhas[0].destino, "TERM. CAPELINHA");
  assert.equal(res.corpo.linhas[0].origem, "LGO. SÃO FRANCISCO");
});

caso("GTFS: traçado escolhido pelo destino segue o sentido certo (5119-10)", () => {
  assert.equal(gtfs.tracadoDaLinha("5119-10", "TERM. CAPELINHA", 2).direcao, 1);
  assert.equal(gtfs.tracadoDaLinha("5119-10", "LGO. SÃO FRANCISCO", 1).direcao, 0);
});

caso("GTFS: paradas do sentido 1 da 5119-10 saem do Terminal Capelinha", () => {
  const paradas = gtfs.paradasDoGtfs("5119-10", 1);
  assert.ok(paradas.length > 30, "lista com as paradas da viagem");
  assert.match(paradas[0].nome, /Capelinha/i);
});

caso("GTFS: cor oficial da linha", () => {
  assert.match(gtfs.corDaLinha("5119-10") ?? "", /^[0-9A-F]{6}$/i);
});

caso("rota a pé: valida parâmetros, distância e chave", async () => {
  delete process.env.ORS_KEY;
  let res = respostaFalsa();
  await rotaAPe({ method: "GET", query: { de: "abc", para: "-23.55,-46.63" } }, res);
  assert.equal(res.codigo, 400);
  res = respostaFalsa();
  await rotaAPe({ method: "GET", query: { de: "-23.5505,-46.6333", para: "-23.6505,-46.6333" } }, res);
  assert.equal(res.codigo, 422);                      // ~11 km: longe demais
  res = respostaFalsa();
  await rotaAPe({ method: "GET", query: { de: "-23.5505,-46.6333", para: "-23.5520,-46.6350" } }, res);
  assert.equal(res.codigo, 503);                      // sem ORS_KEY
});

caso("rota a pé: converte a resposta da OpenRouteService (lon,lat -> lat,lon)", async () => {
  process.env.ORS_KEY = "chave-de-teste";
  const res = respostaFalsa();
  await comFetch(() => new Response(JSON.stringify({ features: [{
    geometry: { coordinates: [[-46.6333, -23.5505], [-46.635, -23.552]] },
    properties: { summary: { distance: 396.2, duration: 285.4 } }
  }] })), () => rotaAPe({ method: "GET", query: { de: "-23.5505,-46.6333", para: "-23.5520,-46.6350" } }, res));
  delete process.env.ORS_KEY;
  assert.equal(res.codigo, 200);
  assert.deepEqual(res.corpo, { distanciaM: 396, duracaoS: 285, pontos: [[-23.5505, -46.6333], [-23.552, -46.635]] });
});
