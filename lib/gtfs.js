// Dados do GTFS da SPTrans usados pelo servidor.
//
// A cor de cada linha vem direto do arquivo data/gtfs/routes.txt, o mesmo
// arquivo oficial da SPTrans. Não existe cópia gerada: quando o GTFS for
// atualizado, basta trocar o arquivo.
//
// O "letreiro" que a Olho Vivo devolve (ex.: 647A-10) é o route_id do routes.txt.
import { readFileSync } from "node:fs";
import { lerCsv } from "./csv.js";

const ARQUIVO_ROTAS = new URL("../data/gtfs/routes.txt", import.meta.url);
const HEX = /^[0-9A-Fa-f]{6}$/;

let cores = null;   // route_id -> cor de fundo (hexadecimal, sem #); lido uma vez por servidor ligado

function carregarCores() {
  const mapa = new Map();
  try {
    const texto = readFileSync(ARQUIVO_ROTAS, "utf8").replace(/^\uFEFF/, "");
    const [cabecalho, ...linhas] = lerCsv(texto);
    const col = Object.fromEntries(cabecalho.map((nome, i) => [nome.trim(), i]));
    for (const l of linhas) {
      const id = (l[col.route_id] ?? "").trim();
      const cor = (l[col.route_color] ?? "").trim();
      if (id && HEX.test(cor)) mapa.set(id, cor.toUpperCase());
    }
  } catch (erro) {
    // Sem o arquivo, o app continua funcionando, só que sem as cores
    console.error("Não foi possível ler o routes.txt:", erro.message);
  }
  return mapa;
}

// Cor de fundo da linha (ex.: "782F40") ou null se não houver
export function corDaLinha(idLinha) {
  cores ??= carregarCores();
  return cores.get(idLinha) ?? null;
}

/* ---------- Traçados (shapes) ---------- */

// data/tracados.json é gerado por tools/gerar-tracados.mjs a partir do shapes.txt
// e do trips.txt (o shapes.txt original é grande demais para o servidor ler).
const ARQUIVO_TRACADOS = new URL("../data/tracados.json", import.meta.url);
let tracados = null;

function carregarTracados() {
  try {
    return JSON.parse(readFileSync(ARQUIVO_TRACADOS, "utf8"));
  } catch (erro) {
    console.error("Não foi possível ler o tracados.json:", erro.message);
    return { rotas: {}, formas: {} };
  }
}

// Minúsculas, sem acentos e sem pontuação: "TERM. LAPA" e "Term. Lapa" ficam iguais
function normalizar(texto) {
  return String(texto ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Traçado de uma linha. Cada linha tem um traçado por sentido; para escolher o certo:
//   1) compara o destino que a Olho Vivo informa com o destino da viagem no GTFS;
//   2) se a linha só tem um traçado, usa ele;
//   3) por último, usa o número do sentido (1 = direção 0, 2 = direção 1).
// Devolve { polilinha, direcao, destino, criterio } ou null.
export function tracadoDaLinha(letreiro, destino, sentido) {
  tracados ??= carregarTracados();
  const opcoes = tracados.rotas[letreiro];
  if (!opcoes || opcoes.length === 0) return null;

  let escolhida = null, criterio = null;
  const alvo = normalizar(destino);
  if (alvo) {
    escolhida = opcoes.find((o) => normalizar(o[1]) === alvo) ?? null;
    if (escolhida) criterio = "destino";
  }
  if (!escolhida && opcoes.length === 1) { escolhida = opcoes[0]; criterio = "unico"; }
  if (!escolhida && (sentido === 1 || sentido === 2)) {
    escolhida = opcoes.find((o) => o[0] === sentido - 1) ?? null;
    if (escolhida) criterio = "sentido";
  }
  if (!escolhida) return null;

  const polilinha = tracados.formas[escolhida[2]];
  return polilinha ? { polilinha, direcao: escolhida[0], destino: escolhida[1], criterio } : null;
}
