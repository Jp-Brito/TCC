// Atualiza o GTFS da SPTrans e gera de novo os arquivos do app (paradas e traçados).
// Roda sozinho toda terça no GitHub (.github/workflows/atualizar-gtfs.yml); também dá para
// rodar no PC, se quiser forçar:  node tools/atualizar-gtfs.mjs
//
// De onde vem o GTFS, nesta ordem:
//   1. GTFS_URL (variável de ambiente ou --url): link direto para um .zip (para testes);
//   2. Mobility Database (mobilitydatabase.org): precisa de MDB_REFRESH_TOKEN; o feed da SPTrans
//      é descoberto na hora (ou fixado com MDB_FEED_ID). Não baixamos do site da SPTrans porque
//      o download de lá exige login pelo navegador.
//
// Segurança: antes de trocar qualquer arquivo, confere se o feed tem tudo o que o app usa e se
// as quantidades fazem sentido (pelo menos 80% das paradas, linhas e viagens atuais). Se algo
// estiver estranho, para sem mexer em nada. Se o feed for o mesmo da última vez (mesmo hash),
// também não mexe em nada.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = "https://api.mobilitydatabase.org/v1";
const PASTA = "data/gtfs";
const VERSAO = "data/gtfs-versao.json";
const OBRIGATORIOS = ["routes.txt", "trips.txt", "stop_times.txt", "stops.txt", "shapes.txt", "frequencies.txt", "calendar.txt"];
const MINIMO = 0.8;   // o feed novo precisa ter pelo menos 80% do que o atual tem

const args = process.argv.slice(2);
const opcao = (nome) => { const i = args.indexOf("--" + nome); return i >= 0 ? args[i + 1] : null; };
const falhar = (msg) => { console.error("ERRO: " + msg); process.exit(1); };
const saida = (nome, valor) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${nome}=${valor}\n`); };
const contarLinhas = (arquivo) => existsSync(arquivo) ? readFileSync(arquivo, "utf8").split(/\r?\n/).filter(Boolean).length - 1 : 0;

async function json(url, opcoes = {}) {
  const r = await fetch(url, { ...opcoes, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${r.status} em ${url.replace(/\?.*/, "")}`);
  return r.json();
}

/* ---------- 1. Descobrir de onde baixar ---------- */
async function origemMobilityDatabase() {
  const refresh = process.env.MDB_REFRESH_TOKEN;
  if (!refresh) return null;
  // O refresh token (que dura) vira um access token (que expira rápido) a cada execução
  const { access_token: token } = await json(`${API}/tokens`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: refresh })
  });
  if (!token) throw new Error("a Mobility Database não devolveu o access token");
  const cabecalho = { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } };

  let id = process.env.MDB_FEED_ID;
  if (!id) {
    // Os ids mudam quando um feed é substituído: procurar na hora é mais confiável
    const lista = await json(`${API}/gtfs_feeds?provider=${encodeURIComponent("SPTrans")}&limit=50`, cabecalho);
    const candidatos = (Array.isArray(lista) ? lista : []).filter((f) =>
      /sptrans/i.test(f.provider ?? "") && f.status !== "deprecated" &&
      (!(f.locations ?? []).length || f.locations.some((l) => l.country_code === "BR")));
    console.log("Feeds encontrados na Mobility Database:");
    for (const f of candidatos) console.log(`  ${f.id} | ${f.provider} | ${f.feed_name ?? ""} | ${f.status ?? ""}`);
    const escolhido = candidatos.find((f) => f.status === "active") ?? candidatos[0];
    if (!escolhido) throw new Error("nenhum feed da SPTrans encontrado (defina MDB_FEED_ID)");
    id = escolhido.id;
  }
  const feed = await json(`${API}/gtfs_feeds/${encodeURIComponent(id)}`, cabecalho);
  const d = feed.latest_dataset;
  if (!d?.hosted_url) throw new Error(`o feed ${id} não tem versão hospedada`);
  console.log(`Usando o feed ${id} (${feed.provider}), versão baixada pela Mobility Database em ${d.downloaded_at ?? "?"}`);
  return { url: d.hosted_url, fonte: `Mobility Database (${id})`, validoAteInformado: d.service_date_range_end ?? null };
}

async function origem() {
  const direta = opcao("url") || process.env.GTFS_URL;
  if (direta) return { url: direta, fonte: "URL informada" };
  const mdb = await origemMobilityDatabase();
  if (mdb) return mdb;
  falhar("informe GTFS_URL ou configure o segredo MDB_REFRESH_TOKEN.");
}

/* ---------- 2. Baixar e descompactar ---------- */
function descompactar(zip, destino) {
  try { execFileSync("unzip", ["-o", "-q", zip, "-d", destino], { stdio: "ignore" }); return; } catch {}
  execFileSync("tar", ["-xf", zip, "-C", destino], { stdio: "ignore" });   // Windows 10+ e macOS
}

/* ---------- 3. Validar ---------- */
function validar(pasta) {
  for (const f of OBRIGATORIOS) if (!existsSync(join(pasta, f))) falhar(`o feed não tem ${f}; nada foi alterado.`);
  const comparar = ["stops.txt", "routes.txt", "trips.txt"].map((f) => {
    const novo = contarLinhas(join(pasta, f)), atual = contarLinhas(join(PASTA, f));
    return { f, novo, atual };
  });
  for (const c of comparar) {
    console.log(`  ${c.f.padEnd(15)} atual: ${String(c.atual).padStart(7)}  novo: ${String(c.novo).padStart(7)}`);
    if (c.atual > 0 && c.novo < c.atual * MINIMO) falhar(`${c.f} encolheu demais (${c.atual} -> ${c.novo}); nada foi alterado.`);
  }
}

// Até quando a programação vale: maior end_date do calendar.txt (AAAAMMDD -> AAAA-MM-DD)
function validoAte(pasta) {
  const [cab, ...linhas] = readFileSync(join(pasta, "calendar.txt"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const i = cab.split(",").map((c) => c.replace(/"/g, "").trim()).indexOf("end_date");
  const fim = linhas.map((l) => l.split(",")[i]?.replace(/"/g, "").trim()).filter((x) => /^\d{8}$/.test(x)).sort().at(-1);
  return fim ? `${fim.slice(0, 4)}-${fim.slice(4, 6)}-${fim.slice(6, 8)}` : null;
}

// Linhas (route_id) e paradas (stop_id) que entraram ou saíram
function ids(arquivo) {
  if (!existsSync(arquivo)) return new Set();
  return new Set(readFileSync(arquivo, "utf8").split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(",")[0].replace(/"/g, "")));
}

/* ---------- execução ---------- */
const { url, fonte, validoAteInformado } = await origem();
console.log(`Baixando ${fonte}...`);
const resposta = await fetch(url, { signal: AbortSignal.timeout(180000) });
if (!resposta.ok) falhar(`download respondeu ${resposta.status}.`);
const bytes = Buffer.from(await resposta.arrayBuffer());
const hash = createHash("sha256").update(bytes).digest("hex");
console.log(`Baixado: ${(bytes.length / 1048576).toFixed(1)} MB (sha256 ${hash.slice(0, 12)}...)`);

const anterior = existsSync(VERSAO) ? JSON.parse(readFileSync(VERSAO, "utf8")) : null;
if (anterior?.hash === hash && !args.includes("--forcar")) {
  console.log("Mesmo feed da última atualização: nada a fazer.");
  saida("mudou", "nao");
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), "gtfs-"));
try {
  const zip = join(temp, "gtfs.zip");
  writeFileSync(zip, bytes);
  const pasta = join(temp, "feed");
  mkdirSync(pasta, { recursive: true });
  descompactar(zip, pasta);
  console.log("Conferindo o feed:");
  validar(pasta);

  const linhasAntes = ids(join(PASTA, "routes.txt")), paradasAntes = ids(join(PASTA, "stops.txt"));
  for (const f of readdirSync(pasta).filter((f) => f.endsWith(".txt"))) copyFileSync(join(pasta, f), join(PASTA, f));
  const linhasDepois = ids(join(PASTA, "routes.txt")), paradasDepois = ids(join(PASTA, "stops.txt"));

  console.log("Gerando paradas e traçados...");
  execFileSync(process.execPath, ["tools/gerar-paradas.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["tools/gerar-tracados.mjs"], { stdio: "inherit" });

  const novas = [...linhasDepois].filter((x) => !linhasAntes.has(x));
  const removidas = [...linhasAntes].filter((x) => !linhasDepois.has(x));
  const versao = {
    fonte,
    baixadoEm: new Date().toISOString(),
    hash,
    validoAte: validoAte(PASTA) ?? validoAteInformado ?? null,
    totais: { linhas: linhasDepois.size, paradas: paradasDepois.size, viagens: contarLinhas(join(PASTA, "trips.txt")) }
  };
  writeFileSync(VERSAO, JSON.stringify(versao, null, 2) + "\n");

  console.log(`\nResumo: ${versao.totais.linhas} linhas (${novas.length} novas, ${removidas.length} removidas), ` +
    `${versao.totais.paradas} paradas (${paradasDepois.size - paradasAntes.size >= 0 ? "+" : ""}${paradasDepois.size - paradasAntes.size}). ` +
    `Programação válida até ${versao.validoAte ?? "?"}.`);
  if (novas.length) console.log("Linhas novas: " + novas.slice(0, 30).join(", "));
  if (removidas.length) console.log("Linhas removidas: " + removidas.slice(0, 30).join(", "));
  saida("mudou", "sim");
  saida("versao", `${versao.baixadoEm.slice(0, 10)} (${versao.totais.linhas} linhas, válido até ${versao.validoAte ?? "?"})`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
