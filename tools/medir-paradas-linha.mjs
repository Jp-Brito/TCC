// Mede em quantas linhas a consulta de paradas por linha da Olho Vivo funciona, e quanto o
// plano B (previsão da linha) ajuda. Responde à pergunta: "quão grave é a limitação?".
//
// Uso (na pasta do projeto):
//   node tools/medir-paradas-linha.mjs [--url https://olhovivobus.vercel.app] [--amostra 80]
//                                      [--semente 1] [--pausa 150] [--rotulo dia]
//
// Sorteia números de linha do data/gtfs/routes.txt (com semente fixa, para dar para repetir),
// busca cada um em /api/linhas e testa /api/paradas-linha para cada sentido encontrado.
// Cada teste vira uma linha em tools/medicoes/paradas-linha.csv. Rode em horários
// diferentes (o plano B depende dos ônibus em circulação): use --rotulo dia, noite...
// Nenhum token é necessário: as chamadas são feitas ao site publicado.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { lerCsv } from "../lib/csv.js";

const args = process.argv.slice(2);
const opcao = (nome, padrao) => { const i = args.indexOf("--" + nome); return i >= 0 ? args[i + 1] : padrao; };
const base = opcao("url", "https://olhovivobus.vercel.app").replace(/\/$/, "");
const amostra = Number(opcao("amostra", 80));
const semente = Number(opcao("semente", 1));
const pausa = Number(opcao("pausa", 150));
const rotulo = opcao("rotulo", "sem-rotulo");
const ARQUIVO = "tools/medicoes/paradas-linha.csv";
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Sorteio com semente (mesma semente = mesma amostra)
function gerador(s) { return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function chamar(caminho) {
  const inicio = performance.now();
  try {
    const r = await fetch(base + caminho, { signal: AbortSignal.timeout(20000) });
    const corpo = r.ok ? await r.json() : null;
    return { ok: r.ok, corpo, ms: performance.now() - inicio };
  } catch { return { ok: false, corpo: null, ms: performance.now() - inicio }; }
}

const mediana = (v) => { const o = [...v].sort((a, b) => a - b); return o.length ? o[Math.floor(o.length / 2)] : 0; };

/* 1) números de linha do GTFS (parte antes do hífen, sem repetir) */
const [cab, ...linhasCsv] = lerCsv(readFileSync("data/gtfs/routes.txt", "utf8").replace(/^\uFEFF/, ""));
const col = cab.map((c) => c.trim()).indexOf("route_id");
const numeros = [...new Set(linhasCsv.map((l) => (l[col] ?? "").split("-")[0]).filter(Boolean))];
const rand = gerador(semente);
const sorteados = [...numeros].sort(() => rand() - 0.5).slice(0, amostra);
console.log(`Testando ${base} | amostra de ${sorteados.length} números de linha (de ${numeros.length}) | semente ${semente} | rótulo: ${rotulo}\n`);

/* 2) busca na API: junta todos os sentidos encontrados, sem repetir */
const linhas = new Map();
let semResultado = 0;
for (const n of sorteados) {
  const r = await chamar("/api/linhas?termo=" + encodeURIComponent(n));
  const achadas = r.corpo?.linhas ?? [];
  if (achadas.length === 0) semResultado++;
  for (const l of achadas) if (!linhas.has(l.codigo)) linhas.set(l.codigo, l);
  await dormir(pausa);
}

/* 3) testa as paradas de cada linha/sentido */
mkdirSync(dirname(ARQUIVO), { recursive: true });
if (!existsSync(ARQUIVO)) appendFileSync(ARQUIVO, "dataHora,rotulo,letreiro,codigo,sentido,fonte,total,ms,erro\n");
const resultados = [];
let feitas = 0;
for (const l of linhas.values()) {
  const parametros = new URLSearchParams({
    linha: String(l.codigo),
    letreiro: l.letreiro,
    sentido: String(l.sentido)
  });
  const r = await chamar("/api/paradas-linha?" + parametros);
  const fonte = r.corpo?.fonte ?? "erro";
  const total = r.corpo?.paradas?.length ?? 0;
  resultados.push({ letreiro: l.letreiro, codigo: l.codigo, fonte, total, erro: !r.ok });
  appendFileSync(ARQUIVO, [new Date().toISOString(), rotulo, l.letreiro, l.codigo, l.sentido, fonte, total, r.ms.toFixed(0), r.ok ? 0 : 1].join(",") + "\n");
  process.stdout.write(`\r${++feitas}/${linhas.size} linhas/sentidos testados`);
  await dormir(pausa);
}
console.log("\n");

/* 4) resumo */
const n = resultados.length;
const erros = resultados.filter((r) => r.erro).length;
const validos = resultados.filter((r) => !r.erro);
const principal = validos.filter((r) => r.fonte === "paradas" && r.total > 0);
const alternativo = validos.filter((r) => r.fonte === "previsao" && r.total > 0);
const vazias = validos.filter((r) => r.total === 0);
const pct = (x) => `${x.length} (${Math.round((100 * x.length) / Math.max(validos.length, 1))}%)`;
console.log(`Números de linha sorteados: ${sorteados.length} | sem resultado na busca: ${semResultado}`);
console.log(`Linhas/sentidos testados: ${n} | falhas de comunicação: ${erros}\n`);
console.log(`Paradas devolvidas pela consulta principal da API ........ ${pct(principal)}   mediana: ${mediana(principal.map((r) => r.total))} paradas`);
console.log(`Só pelo plano B (previsão da linha) ...................... ${pct(alternativo)}   mediana: ${mediana(alternativo.map((r) => r.total))} paradas`);
console.log(`Nenhuma parada nem pelo plano B ......................... ${pct(vazias)}`);
if (vazias.length) console.log("   exemplos sem paradas:", vazias.slice(0, 10).map((r) => r.letreiro).join(", "));
console.log(`\nDados guardados em ${ARQUIVO}. Repita em outro horário com outro --rotulo para comparar.`);
