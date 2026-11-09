// Mede a precisão das previsões de chegada: compara o horário PREVISTO pela Olho Vivo com
// o horário em que o ônibus REALMENTE passou pela parada.
//
// Como funciona:
//   - a cada ciclo, consulta a previsão da parada (/api/previsao) e a posição dos ônibus da
//     linha (/api/posicao);
//   - guarda todas as previsões feitas para cada ônibus;
//   - quando as posições mostram que o ônibus passou pela parada, calcula a hora exata da
//     passagem (interpolando entre duas posições seguidas) e compara com cada previsão
//     anterior. Erro positivo = previsto DEPOIS da chegada real (previu atraso a mais);
//     erro negativo = o ônibus demorou mais do que o previsto.
//
// Uso (na pasta do projeto, com o computador ligado durante toda a coleta):
//   node tools/medir-precisao-previsao.mjs --termo 5119 [--sentido 2] [--duracao 60] [--rotulo tarde]
//       (sem --parada, escolhe 3 paradas do sentido: no começo, no meio e no fim da linha)
//   node tools/medir-precisao-previsao.mjs --linha 32769 --letreiro 5119-10 --parada 5507020,550015969,850011318
//   node tools/medir-precisao-previsao.mjs --linha 3587 --letreiro 5119-10 --parada 480014614 [--duracao 60]
//   node tools/medir-precisao-previsao.mjs --linha 3587 --parada 480014614 --duracao 0
//   node tools/medir-precisao-previsao.mjs --resumo      (junta todas as coletas guardadas)
//
// Opções: --url (padrão: o site publicado) | --intervalo 15 (segundos entre ciclos) |
//         --raio 50 (distância máxima, em metros, do trajeto até a parada para valer como passagem) |
//         --duracao 0 (fica rodando até Ctrl+C)
// Para parar antes do fim, aperte Ctrl+C: o resumo é mostrado e os dados ficam guardados.
//
// Limites que devem ser citados no TCC:
//   - a "verdade" também vem de dados de GPS da SPTrans (não há medição independente);
//   - o GPS informa a posição a cada ~30 s, e a previsão tem resolução de 1 minuto, então
//     erros menores que cerca de 1 minuto não são distinguíveis;
//   - só vale para a linha, a parada e os horários medidos: repita em horários diferentes.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const opcao = (nome, padrao) => { const i = args.indexOf("--" + nome); return i >= 0 ? args[i + 1] : padrao; };
const ARQUIVO = "tools/medicoes/precisao-previsao.csv";
const CABECALHO = "rotulo,parada,linha,prefixo,coletaISO,antecedenciaMin,previstoISO,chegadaRealISO,erroMin\n";
const FAIXAS = [[0, 2], [2, 5], [5, 10], [10, 20], [20, 30]];   // antecedência da previsão, em minutos

/* ---------- estatística ---------- */
const media = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const mediana = (v) => { const o = [...v].sort((a, b) => a - b); return o[Math.floor(o.length / 2)]; };
function resumir(linhas) {   // linhas: [{antecedenciaMin, erroMin}]
  const f = (n, v) => String(typeof v === "number" ? v.toFixed(1) : v).padStart(n);
  console.log("antecedência".padEnd(14), "n".padStart(5), f(8, "erro méd"), f(8, "MAE"), f(10, "med |erro|"), f(9, "≤1 min"), f(9, "≤2 min"));
  const grupos = [...FAIXAS.map(([a, b]) => [`${a}-${b} min`, linhas.filter((l) => l.antecedenciaMin >= a && l.antecedenciaMin < b)]), ["todas", linhas]];
  for (const [nome, v] of grupos) {
    if (!v.length) { console.log(nome.padEnd(14), "0".padStart(5)); continue; }
    const abs = v.map((x) => Math.abs(x.erroMin));
    const pct = (lim) => `${Math.round((100 * abs.filter((x) => x <= lim).length) / abs.length)}%`;
    console.log(nome.padEnd(14), String(v.length).padStart(5), f(8, media(v.map((x) => x.erroMin))), f(8, media(abs)), f(10, mediana(abs)), f(9, pct(1)), f(9, pct(2)));
  }
}

/* ---------- modo resumo ---------- */
if (args.includes("--resumo")) {
  if (!existsSync(ARQUIVO)) { console.error("Ainda não há dados em " + ARQUIVO); process.exit(1); }
  const [, ...l] = readFileSync(ARQUIVO, "utf8").trim().split("\n");
  const dados = l.map((x) => { const c = x.split(","); return { rotulo: c[0], parada: c[1], antecedenciaMin: Number(c[5]), erroMin: Number(c[8]), prefixo: c[3], linha: c[2] }; });
  console.log(`\n${dados.length} comparações (previsão x chegada real) em ${ARQUIVO}`);
  console.log(`ônibus distintos: ${new Set(dados.map((d) => d.linha + "/" + d.prefixo)).size}\n`);
  console.log("== Todas as coletas =="); resumir(dados);
  for (const r of [...new Set(dados.map((d) => d.rotulo))]) { console.log(`\n== Rótulo: ${r} ==`); resumir(dados.filter((d) => d.rotulo === r)); }
  for (const p of [...new Set(dados.map((d) => d.parada))]) { console.log(`\n== Parada: ${p} ==`); resumir(dados.filter((d) => d.parada === p)); }
  process.exit(0);
}

/* ---------- configuração da coleta ---------- */
const base = opcao("url", "https://olhovivobus.vercel.app").replace(/\/$/, "");
const duracaoMin = Number(opcao("duracao", 60));
const intervaloS = Number(opcao("intervalo", 15));
const raio = Number(opcao("raio", 50));
const rotulo = opcao("rotulo", "sem-rotulo");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

if (!Number.isFinite(duracaoMin) || duracaoMin < 0) {
  console.error("--duracao deve ser zero ou um número positivo (minutos).");
  process.exit(1);
}
if (!Number.isFinite(intervaloS) || intervaloS <= 0) {
  console.error("--intervalo deve ser um número positivo (segundos).");
  process.exit(1);
}
if (!Number.isFinite(raio) || raio <= 0) {
  console.error("--raio deve ser um número positivo (metros).");
  process.exit(1);
}

async function chamar(caminho) {
  try {
    const r = await fetch(base + caminho, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const corpo = await r.json();
    const data = Date.parse(r.headers.get("date") ?? "");
    return { corpo, agora: Number.isFinite(data) ? data : Date.now() };   // hora do servidor, não do computador
  } catch { return null; }
}

// "HH:MM" (horário de São Paulo, UTC-3) vira instante absoluto, perto do instante de referência
function instante(hhmm, referenciaMs) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? ""); if (!m) return null;
  const sp = new Date(referenciaMs - 3 * 3600e3);
  let t = Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate(), Number(m[1]), Number(m[2])) + 3 * 3600e3;
  if (t < referenciaMs - 12 * 3600e3) t += 24 * 3600e3;
  if (t > referenciaMs + 12 * 3600e3) t -= 24 * 3600e3;
  return t;
}

// Procura, entre as duas últimas posições do ônibus, o momento em que passou pela parada
function passagem(trilha, parada) {
  if (trilha.length < 2) return null;
  const a = trilha.at(-2), b = trilha.at(-1);
  const k = 111320, cos = Math.cos(parada.lat * Math.PI / 180);
  const ax = (a.lon - parada.lon) * k * cos, ay = (a.lat - parada.lat) * k;
  const bx = (b.lon - parada.lon) * k * cos, by = (b.lat - parada.lat) * k;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  if (l2 < 25) return Math.hypot(bx, by) <= raio ? { ts: a.ts, dmin: Math.hypot(bx, by) } : null;   // parado perto da parada
  const u = -(ax * dx + ay * dy) / l2;                    // onde, no trecho, a parada fica mais perto
  if (u < 0 || u > 1) return null;
  const dmin = Math.hypot(ax + u * dx, ay + u * dy);
  return dmin <= raio ? { ts: a.ts + u * (b.ts - a.ts), dmin } : null;
}

/* ---------- descoberta da linha e das paradas ---------- */
let linhaCodigo = opcao("linha", null);
let letreiro = opcao("letreiro", "");
let sentido = Number(opcao("sentido", 0)) || null;
let paradaIds = (opcao("parada", "") || "").split(",").map((x) => x.trim()).filter(Boolean);
if (!linhaCodigo) {
  const termo = opcao("termo", null);
  if (!termo) { console.error("Informe --termo (ex.: 5119) ou --linha CODIGO --parada ID[,ID,...]."); process.exit(1); }
  const busca = await chamar("/api/linhas?termo=" + encodeURIComponent(termo));
  const opcoes = busca?.corpo?.linhas ?? [];
  const l = opcoes.find((x) => !sentido || x.sentido === sentido) ?? opcoes[0];
  if (!l) { console.error("Linha não encontrada para o termo " + termo); process.exit(1); }
  linhaCodigo = String(l.codigo); letreiro = l.letreiro; sentido = l.sentido;
} else if (letreiro && !sentido) {
  // descobre o sentido do código informado (as paradas do GTFS dependem dele)
  const busca = await chamar("/api/linhas?termo=" + encodeURIComponent(letreiro.split("-")[0]));
  sentido = (busca?.corpo?.linhas ?? []).find((x) => String(x.codigo) === String(linhaCodigo))?.sentido ?? null;
}
if (!paradaIds.length) {
  // 3 paradas do sentido: a 25%, 50% e 75% do trajeto
  const params = new URLSearchParams({ linha: linhaCodigo });
  if (letreiro) params.set("letreiro", letreiro);
  if (sentido) params.set("sentido", String(sentido));
  const p = await chamar("/api/paradas-linha?" + params);
  const lista = p?.corpo?.paradas ?? [];
  if (!lista.length) { console.error("A API não devolveu paradas para a linha " + linhaCodigo + ". Informe --parada ID."); process.exit(1); }
  const escolhidas = lista.length < 3 ? lista : [0.25, 0.5, 0.75].map((f) => lista[Math.floor((lista.length - 1) * f)]);
  paradaIds = [...new Set(escolhidas.map((x) => String(x.id)))];
}

mkdirSync(dirname(ARQUIVO), { recursive: true });
if (!existsSync(ARQUIVO)) appendFileSync(ARQUIVO, CABECALHO);

const descricaoDuracao = duracaoMin === 0 ? "contínua" : `${duracaoMin} min`;
console.log(`Medindo ${base}\nlinha ${letreiro || ""} (código ${linhaCodigo}${sentido ? ", sentido " + sentido : ""}) | paradas ${paradaIds.join(", ")} | ${descricaoDuracao} | ciclo de ${intervaloS} s | raio ${raio} m | rótulo: ${rotulo}`);
console.log("Aperte Ctrl+C para encerrar antes e ver o resumo.\n");

/* ---------- coleta ---------- */
// Cada ciclo: previsão de cada parada + posição dos ônibus da linha (uma vez só).
const previsoes = new Map();   // "parada|prefixo" -> [{ coleta, previsto }]
const trilhas = new Map();     // prefixo -> [{ ts, lat, lon }]
const ultimaPassagem = new Map();   // "parada|prefixo" -> instante (evita contar a mesma passagem duas vezes)
const infoParada = new Map();  // id -> { lat, lon, nome }
const resultados = [];
let parar = false;
process.on("SIGINT", () => { parar = true; });
const fim = duracaoMin === 0 ? Infinity : Date.now() + duracaoMin * 60e3;
let ciclos = 0;
const semPrevisao = Object.fromEntries(paradaIds.map((id) => [id, 0]));

while (!parar && Date.now() < fim) {
  const respostas = await Promise.all([chamar("/api/posicao?linha=" + linhaCodigo),
    ...paradaIds.map((id) => chamar("/api/previsao?parada=" + id))]);
  const po = respostas[0];
  ciclos++;

  paradaIds.forEach((id, i) => {   // guarda as previsões de cada parada
    const pr = respostas[i + 1];
    if (!pr) return;
    if (pr.corpo.parada && !infoParada.has(id)) infoParada.set(id, pr.corpo.parada);
    const entrada = (pr.corpo.linhas ?? []).find((l) => String(l.codigo) === String(linhaCodigo));
    if (!entrada || !entrada.veiculos?.length) { semPrevisao[id]++; return; }
    for (const v of entrada.veiculos) {
      const previsto = instante(v.chegada, pr.agora);
      if (previsto === null) continue;
      const chave = id + "|" + v.prefixo;
      (previsoes.get(chave) ?? previsoes.set(chave, []).get(chave)).push({ coleta: pr.agora, previsto });
    }
  });

  for (const v of po?.corpo?.veiculos ?? []) {   // guarda as posições e procura passagens pelas paradas
    const ts = Date.parse(v.atualizadoEm);
    if (!Number.isFinite(ts) || !Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
    const trilha = trilhas.get(v.prefixo) ?? trilhas.set(v.prefixo, []).get(v.prefixo);
    if (trilha.length && trilha.at(-1).ts === ts) continue;   // posição repetida
    trilha.push({ ts, lat: v.lat, lon: v.lon });
    if (trilha.length > 40) trilha.shift();

    for (const id of paradaIds) {
      const parada = infoParada.get(id);
      const p = parada && passagem(trilha, parada);
      const chave = id + "|" + v.prefixo;
      if (!p || (ultimaPassagem.get(chave) ?? -Infinity) > p.ts - 5 * 60e3) continue;
      const lista = previsoes.get(chave) ?? [];
      if (!lista.length) continue;
      ultimaPassagem.set(chave, p.ts);
      const comparaveis = lista.filter((x) => x.coleta <= p.ts && p.ts - x.coleta <= 30 * 60e3);
      for (const x of comparaveis) {
        const linhaCsv = { antecedenciaMin: (p.ts - x.coleta) / 60e3, erroMin: (x.previsto - p.ts) / 60e3 };
        resultados.push(linhaCsv);
        appendFileSync(ARQUIVO, [rotulo, id, linhaCodigo, v.prefixo, new Date(x.coleta).toISOString(), linhaCsv.antecedenciaMin.toFixed(2),
          new Date(x.previsto).toISOString(), new Date(p.ts).toISOString(), linhaCsv.erroMin.toFixed(2)].join(",") + "\n");
      }
      console.log(`ônibus ${v.prefixo} passou pela parada ${id} às ${new Date(p.ts - 3 * 3600e3).toISOString().slice(11, 19)} (a ${p.dmin.toFixed(0)} m do ponto): ${comparaveis.length} previsões comparadas`);
      previsoes.delete(chave);
    }
  }
  if (!parar) await dormir(intervaloS * 1000);
}

console.log(`\nFim da coleta: ${ciclos} ciclos | comparações: ${resultados.length}`);
console.log("ciclos sem previsão da linha, por parada: " + paradaIds.map((id) => `${id}: ${semPrevisao[id]}`).join(" | ") + "\n");
if (resultados.length) resumir(resultados);
else console.log("Nenhum ônibus passou pela parada durante a coleta (ou nenhuma previsão foi comparável). Tente uma parada mais movimentada ou deixe rodando por mais tempo.");
console.log(`\nDados guardados em ${ARQUIVO}. Para o resumo de todas as coletas: node tools/medir-precisao-previsao.mjs --resumo`);
process.exit(0);
