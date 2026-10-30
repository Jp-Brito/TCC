// Mede o tempo de resposta do protótipo publicado (ou de uma versão local), várias vezes,
// e guarda cada medição num arquivo CSV para análise e para o TCC.
//
// Uso (na pasta do projeto):
//   node tools/medir-desempenho.mjs [--url https://olhovivobus.vercel.app] [--rodadas 20]
//                                   [--intervalo 2000] [--condicao wifi]
//   node tools/medir-desempenho.mjs --resumo        (resume o CSV por endpoint, horário e condição)
//
// Faça a medição em horários diferentes (madrugada, manhã, pico da tarde, noite) e em
// condições diferentes (wifi, 4G), usando --condicao para registrar o que foi.
// Nenhum token é necessário: as chamadas são feitas ao site publicado.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const ARQUIVO = "tools/medicoes/desempenho.csv";
const args = process.argv.slice(2);
const opcao = (nome, padrao) => { const i = args.indexOf("--" + nome); return i >= 0 ? args[i + 1] : padrao; };

/* ---------- estatística ---------- */
const media = (v) => v.reduce((a, b) => a + b, 0) / v.length;
function percentil(v, p) {
  const o = [...v].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.ceil((p / 100) * o.length) - 1)];
}
const mediana = (v) => percentil(v, 50);
function periodo(dataHora) {
  const h = new Date(dataHora).getHours();
  return h < 6 ? "madrugada" : h < 12 ? "manhã" : h < 18 ? "tarde" : "noite";
}
function tabela(linhas) {   // linhas: [{grupo, ms, ok}]
  const grupos = new Map();
  for (const l of linhas) (grupos.get(l.grupo) ?? grupos.set(l.grupo, []).get(l.grupo)).push(l);
  console.log("grupo".padEnd(34), "n".padStart(4), "ok%".padStart(5), "mín".padStart(6), "média".padStart(6), "mediana".padStart(8), "p95".padStart(6), "máx".padStart(6));
  for (const [g, v] of [...grupos].sort()) {
    const tempos = v.filter((x) => x.ok).map((x) => x.ms);
    const okPct = Math.round((100 * tempos.length) / v.length);
    if (tempos.length === 0) { console.log(g.padEnd(34), String(v.length).padStart(4), String(okPct).padStart(5), "  (sem respostas válidas)"); continue; }
    console.log(g.padEnd(34), String(v.length).padStart(4), String(okPct).padStart(5),
      Math.round(Math.min(...tempos)).toString().padStart(6), Math.round(media(tempos)).toString().padStart(6),
      Math.round(mediana(tempos)).toString().padStart(8), Math.round(percentil(tempos, 95)).toString().padStart(6),
      Math.round(Math.max(...tempos)).toString().padStart(6));
  }
}

/* ---------- modo resumo ---------- */
if (args.includes("--resumo")) {
  if (!existsSync(ARQUIVO)) { console.error("Ainda não há medições em " + ARQUIVO); process.exit(1); }
  const [, ...linhas] = readFileSync(ARQUIVO, "utf8").trim().split("\n");
  const dados = linhas.map((l) => { const c = l.split(","); return { dataHora: c[0], condicao: c[1], endpoint: c[2], status: Number(c[3]), ms: Number(c[4]), regiao: c[6] }; });
  // Rodadas de aquecimento (condição começando com "aquecimento") ficam fora das médias
  const validos = dados.filter((d) => !d.condicao.startsWith("aquecimento"));
  console.log(`\n${dados.length} medições em ${ARQUIVO} (${dados.length - validos.length} de aquecimento ficam fora das tabelas abaixo, exceto a de condições)\n`);
  console.log("== Por endpoint e condição (para comparar, por exemplo, iad1 com gru1) ==");
  tabela(validos.map((d) => ({ grupo: `${d.condicao} | ${d.endpoint}`, ms: d.ms, ok: d.status === 200 })));
  console.log("\n== Por endpoint (todas as condições juntas) ==");
  tabela(validos.map((d) => ({ grupo: d.endpoint, ms: d.ms, ok: d.status === 200 })));
  console.log("\n== Por período do dia (previsão, posição e paradas da linha) ==");
  tabela(validos.filter((d) => ["previsao", "posicao", "paradas-linha"].includes(d.endpoint)).map((d) => ({ grupo: periodo(d.dataHora), ms: d.ms, ok: d.status === 200 })));
  console.log("\n== Por condição de acesso (inclui o aquecimento) ==");
  tabela(dados.map((d) => ({ grupo: d.condicao, ms: d.ms, ok: d.status === 200 })));
  console.log("\n== Região de execução registrada pela Vercel ==");
  const reg = {}; for (const d of dados) { const k = `${d.condicao}: ${d.regiao}`; reg[k] = (reg[k] ?? 0) + 1; } console.log(reg);
  process.exit(0);
}

/* ---------- modo medição ---------- */
const base = opcao("url", "https://olhovivobus.vercel.app").replace(/\/$/, "");
const rodadas = Number(opcao("rodadas", 20));
const intervalo = Number(opcao("intervalo", 2000));
const condicao = opcao("condicao", "nao-informada");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function medir(nome, caminho) {
  const inicio = performance.now();
  let status = 0, bytes = 0, regiao = "", corpo = null;
  try {
    const r = await fetch(base + caminho, { signal: AbortSignal.timeout(20000) });
    status = r.status;
    const texto = await r.text();
    bytes = Buffer.byteLength(texto);
    regiao = (r.headers.get("x-vercel-id") ?? "").split("::").slice(0, 2).join(">");   // ex.: gru1>iad1
    try { corpo = JSON.parse(texto); } catch { /* resposta que não é JSON */ }
  } catch { status = 0; }
  return { nome, status, ms: performance.now() - inicio, bytes, regiao, corpo };
}

mkdirSync(dirname(ARQUIVO), { recursive: true });
if (!existsSync(ARQUIVO)) appendFileSync(ARQUIVO, "dataHora,condicao,endpoint,status,ms,bytes,regiaoVercel\n");

// Descobre uma linha e uma parada reais para usar nas consultas
const busca = await medir("linhas", "/api/linhas?termo=8000");
const linha = busca.corpo?.linhas?.[0];
if (!linha) { console.error("Não foi possível obter uma linha de teste. O site está no ar? (" + base + ")"); process.exit(1); }
const paradasLinha = await medir("paradas-linha", `/api/paradas-linha?linha=${linha.codigo}`);
const paradas = paradasLinha.corpo?.paradas ?? [];
const parada = paradas.length ? paradas[Math.floor(paradas.length / 2)].id : null;

const alvos = [
  ["status", "/api/status"],
  ["linhas", "/api/linhas?termo=8000"],
  ["posicao", `/api/posicao?linha=${linha.codigo}`],
  ["paradas-linha", `/api/paradas-linha?linha=${linha.codigo}`],
  ...(parada ? [["previsao", `/api/previsao?parada=${parada}`]] : []),
  ["tracado", `/api/tracado?linha=${encodeURIComponent(linha.letreiro)}&destino=${encodeURIComponent(linha.destino ?? "")}&sentido=${linha.sentido}`],
  ["stops.json (estático)", "/data/stops.json"]
];

console.log(`Medindo ${base} | ${rodadas} rodadas | intervalo ${intervalo} ms | condição: ${condicao}`);
console.log(`Linha de teste: ${linha.letreiro} (código ${linha.codigo}) | parada de teste: ${parada ?? "nenhuma"}\n`);

const resultados = [];
for (let i = 1; i <= rodadas; i++) {
  for (const [nome, caminho] of alvos) {
    const r = await medir(nome, caminho);
    resultados.push({ grupo: nome, ms: r.ms, ok: r.status === 200 });
    appendFileSync(ARQUIVO, [new Date().toISOString(), condicao, nome, r.status, r.ms.toFixed(1), r.bytes, r.regiao].join(",") + "\n");
  }
  process.stdout.write(`\rrodada ${i}/${rodadas}`);
  if (i < rodadas) await dormir(intervalo);
}
console.log("\n");
tabela(resultados);
console.log(`\nMedições guardadas em ${ARQUIVO}. Para o resumo geral: node tools/medir-desempenho.mjs --resumo`);
