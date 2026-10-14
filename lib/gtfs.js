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
