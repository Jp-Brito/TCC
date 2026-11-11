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
import trilhos from "../api/trilhos.js";
import { lerSituacao } from "../api/situacao-trilhos.js";
import programacao, { montarIndice, programacaoDaParada } from "../api/programacao.js";

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

caso("trilhos: linhas de metrô e trem com cor, traçado e estações", () => {
  const res = respostaFalsa();
  trilhos({ method: "GET" }, res);
  assert.equal(res.codigo, 200);
  const linhas = res.corpo.linhas;
  assert.ok(linhas.length >= 15, "metrô e CPTM");
  const azul = linhas.find((l) => l.id === "METRÔ L1");
  assert.equal(azul.nome, "Metrô · Linha 1 – Azul");
  assert.ok(azul.polilinha && azul.estacoes.length > 15);
  assert.ok(linhas.every((l) => /^[0-9A-F]{6}$/i.test(l.cor)));
});

caso("estação: intervalo programado agora e a próxima mudança", () => {
  const faixas = [[240, 299, 480], [300, 359, 240], [360, 419, 240], [420, 479, 420]];   // 4h a 7h59
  const s1 = simples(P.situacaoSentido(faixas, 310));     // 5h10
  assert.deepEqual(s1.atual, [300, 359, 240]);
  assert.deepEqual(s1.proxima, [420, 479, 420]);           // pula a faixa com o mesmo intervalo
  const fechado = simples(P.situacaoSentido(faixas, 100)); // 1h40: fechado, abre às 4h
  assert.equal(fechado.atual, null);
  assert.deepEqual(fechado.proxima, [240, 299, 480]);
  assert.equal(P.textoHora(1440), "0h");
});

caso("trilhos: cada linha traz os dois sentidos com a programação", () => {
  const res = respostaFalsa();
  trilhos({ method: "GET" }, res);
  const l9 = res.corpo.linhas.find((l) => l.id === "CPTM L09");
  assert.equal(l9.sentidos.length, 2);
  assert.ok(l9.sentidos.every((s) => s.faixas.length > 10 && s.destino));
  assert.ok(l9.estacoes.some((e) => e.nome === "Ceasa"));
});

caso("situação das linhas: lê a resposta da fonte (todas as operadoras)", () => {
  const json = { status: true, data: { dataAtualizacao: "2026-11-09T17:16:15", concessoes: [
    { uid: "CCRVQ", nome: "Motiva Linha Quatro", linhas: [
      { numero: "4", nome: "Amarela", statusLinha: { codigo: "OperacaoNormal", status: "Operação Normal", descricao: "" } }] },
    { uid: "METRO", nome: "Metro SP", linhas: [
      { numero: 17, nome: "Ouro", statusLinha: { codigo: "OperacaoTransitoria", status: "Operação Transitória", descricao: "Operação Transitória" } },
      { numero: 1, nome: "Azul", statusLinha: { codigo: "VelocidadeReduzida", status: "Velocidade Reduzida", descricao: "Falha em trem" } }] },
    { uid: "TICTRENS", nome: "TIC Trens", linhas: [
      { numero: 6, nome: "Laranja", statusLinha: { codigo: "OperacaoEncerrada", status: "Operação Encerrada", descricao: null } }] }
  ] } };
  const d = lerSituacao(json);
  assert.deepEqual(d.linhas.map((l) => l.numero), [1, 4, 6, 17]);              // número como texto ou número
  assert.deepEqual(d.linhas.map((l) => l.situacao), ["reduzida", "normal", "encerrada", "parcial"]);
  assert.equal(d.linhas[0].motivo, "Falha em trem");
  assert.equal(d.linhas[3].motivo, null);                                        // detalhe igual ao status: não repete
  assert.equal(d.atualizadoEm, "2026-11-09T17:16:15-03:00");
  assert.equal(lerSituacao({ status: false }).linhas.length, 0);                 // formato diferente: nada (o app esconde)
});

/* ---------- Programação pela tabela (api/programacao), com um GTFS pequeno feito à mão ---------- */
// L1-10: só dias úteis, sai do terminal (parada 1) e leva 10 min até a parada 2.
// N1-11: noturna, todo dia, sai 23:00 e a última 01:30 (25:30 no GTFS); leva 30 min até a parada 2.
const gtfsTeste = montarIndice({
  trips: '"route_id","service_id","trip_id","trip_headsign","direction_id","shape_id"\n' +
    '"L1-10","U__","L1-10-0","Centro","0","1"\n"N1-11","USD","N1-11-1","Jd. Noite","1","2"\n',
  stop_times: '"trip_id","arrival_time","departure_time","stop_id","stop_sequence"\n' +
    '"L1-10-0","05:00:00","05:00:00","1","1"\n"L1-10-0","05:10:00","05:10:00","2","2"\n' +
    '"N1-11-1","23:00:00","23:00:00","9","1"\n"N1-11-1","23:30:00","23:30:00","2","2"\n',
  frequencies: '"trip_id","start_time","end_time","headway_secs"\n' +
    '"L1-10-0","05:00:00","21:59:00","600"\n"L1-10-0","22:00:00","22:59:00","1200"\n"N1-11-1","23:00:00","25:59:00","1800"\n',
  calendar: '"service_id","monday","tuesday","wednesday","thursday","friday","saturday","sunday","start_date","end_date"\n' +
    '"U__","1","1","1","1","1","0","0","20231001","20270601"\n"USD","1","1","1","1","1","1","1","20231001","20270601"\n'
});
const hms = (h, m) => h * 3600 + m * 60;

caso("tabela: próximas passagens e virada da meia-noite (terça 22:21)", () => {
  const linhas = programacaoDaParada(gtfsTeste, "2", "2026-11-10", hms(22, 21));
  const l1 = linhas.find((l) => l.letreiro === "L1-10");
  assert.deepEqual(l1.proximos.map((p) => p.hora), ["22:30", "22:50"]);
  assert.equal(l1.proximos[0].minutos, 9);
  assert.equal(l1.intervaloMin, 20);
  assert.equal(l1.ultimo, true);              // depois das 22:50 só amanhã cedo
  const n1 = linhas.find((l) => l.letreiro === "N1-11");
  assert.equal(n1.sentido, 2);                // direction_id 1 = sentido 2 da Olho Vivo
  assert.deepEqual(n1.proximos.map((p) => p.hora), ["23:30", "00:00"]);
});

caso("tabela: de madrugada usa as viagens da noite anterior e mostra quando a linha volta", () => {
  const linhas = programacaoDaParada(gtfsTeste, "2", "2026-11-11", hms(0, 40));
  assert.deepEqual(linhas.find((l) => l.letreiro === "N1-11").proximos.map((p) => p.hora), ["01:00", "01:30", "02:00"]);
  const l1 = linhas.find((l) => l.letreiro === "L1-10");
  assert.deepEqual(simples(l1.proximos), []);
  assert.deepEqual(l1.volta, { hora: "05:10", amanha: false });
});

caso("tabela: linha só de dias úteis não aparece no sábado", () => {
  const linhas = programacaoDaParada(gtfsTeste, "2", "2026-11-14", hms(10, 0));
  assert.equal(linhas.some((l) => l.letreiro === "L1-10"), false);
  assert.deepEqual(linhas.find((l) => l.letreiro === "N1-11").volta, { hora: "23:30", amanha: false });
});

caso("tabela: some do painel a linha que já tem ônibus ao vivo no mesmo sentido", () => {
  const tabela = [{ letreiro: "647A-10", sentido: 2 }, { letreiro: "647A-10", sentido: 1 }, { letreiro: "809J-10", sentido: 1 }];
  const aoVivo = [{ letreiro: "647A-10", sentido: 2 }];
  assert.deepEqual(simples(P.linhasDaTabela(tabela, aoVivo)), [{ letreiro: "647A-10", sentido: 1 }, { letreiro: "809J-10", sentido: 1 }]);
  assert.equal(P.textoTabela(0), "~agora");
  assert.equal(P.textoTabela(12), "~12 min");
});

caso("tabela: a função recusa parada inválida e responde com o GTFS real", () => {
  const erro = respostaFalsa();
  programacao({ method: "GET", query: { parada: "abc" } }, erro);
  assert.equal(erro.codigo, 400);
  const res = respostaFalsa();
  programacao({ method: "GET", query: { parada: "5507020" } }, res);
  assert.equal(res.codigo, 200);
  assert.ok(res.corpo.linhas.length > 5 && res.corpo.validoAte);
});
