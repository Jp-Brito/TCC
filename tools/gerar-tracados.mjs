// Gera data/tracados.json a partir do shapes.txt e do trips.txt do GTFS.
//
// Uso (na pasta do projeto):
//   node tools/gerar-tracados.mjs [shapes.txt] [trips.txt]
//
// Padrões de entrada: data/gtfs/shapes.txt e data/gtfs/trips.txt
//
// O shapes.txt tem mais de 1 milhão de pontos (58 MB). Para o app ele fica leve assim:
//   1. Guardamos só os traçados que alguma viagem (trips.txt) usa.
//   2. Simplificamos cada traçado (Douglas-Peucker): pontos que ficam a menos de
//      TOLERANCIA_M metros da reta entre os vizinhos são descartados.
//   3. Codificamos os pontos que sobram no formato "polilinha codificada" (cada ponto
//      guarda só a diferença para o anterior, em texto compacto).
//
// Saída:
//   {
//     "rotas":  { "647A-10": [ [direcao, "destino", "idDoTracado"], ... ] },
//     "formas": { "idDoTracado": "polilinha codificada", ... }
//   }

import { createReadStream, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { lerCsv } from "../lib/csv.js";

const TOLERANCIA_M = 3;   // quanto menor, mais fiel (e maior o arquivo)
const arquivoShapes = process.argv[2] ?? "data/gtfs/shapes.txt";
const arquivoTrips = process.argv[3] ?? "data/gtfs/trips.txt";
const saida = "data/tracados.json";

/* ---------- 1. trips.txt: qual traçado cada linha e sentido usa ---------- */
const [cabTrips, ...linhasTrips] = lerCsv(readFileSync(arquivoTrips, "utf8").replace(/^\uFEFF/, ""));
const t = Object.fromEntries(cabTrips.map((n, i) => [n.trim(), i]));
for (const c of ["route_id", "trip_headsign", "direction_id", "shape_id"]) {
  if (!(c in t)) throw new Error(`Coluna ausente no trips.txt: ${c}`);
}

// Se uma linha/sentido tiver várias viagens com traçados diferentes, vale o mais usado.
const contagem = new Map();   // "rota|direcao|idDoTracado" -> { vezes, destino }
for (const l of linhasTrips) {
  const chave = `${l[t.route_id]}|${l[t.direction_id]}|${l[t.shape_id]}`;
  const atual = contagem.get(chave) ?? { vezes: 0, destino: (l[t.trip_headsign] ?? "").trim() };
  atual.vezes++;
  contagem.set(chave, atual);
}
const melhor = new Map();     // "rota|direcao" -> { idDoTracado, destino, vezes }
for (const [chave, v] of contagem) {
  const [rota, direcao, forma] = chave.split("|");
  const k = `${rota}|${direcao}`;
  if (!melhor.has(k) || v.vezes > melhor.get(k).vezes) melhor.set(k, { forma, destino: v.destino, vezes: v.vezes });
}
const usados = new Set([...melhor.values()].map((v) => v.forma));

/* ---------- 2. shapes.txt: lido linha a linha (arquivo grande) ---------- */
const formasBrutas = new Map();   // idDoTracado -> [[sequencia, lat, lon], ...]
let pontosLidos = 0;
let cabShapes = null;
const leitor = createInterface({ input: createReadStream(arquivoShapes, "utf8"), crlfDelay: Infinity });
for await (const linha of leitor) {
  if (!linha.trim()) continue;
  const campos = lerCsv(linha.replace(/^\uFEFF/, ""))[0];
  if (!cabShapes) {
    cabShapes = Object.fromEntries(campos.map((n, i) => [n.trim(), i]));
    for (const c of ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"]) {
      if (!(c in cabShapes)) throw new Error(`Coluna ausente no shapes.txt: ${c}`);
    }
    continue;
  }
  pontosLidos++;
  const id = campos[cabShapes.shape_id];
  if (!usados.has(id)) continue;
  let pontos = formasBrutas.get(id);
  if (!pontos) formasBrutas.set(id, (pontos = []));
  pontos.push([Number(campos[cabShapes.shape_pt_sequence]), Number(campos[cabShapes.shape_pt_lat]), Number(campos[cabShapes.shape_pt_lon])]);
}

/* ---------- 3. simplificar e codificar ---------- */

// Douglas-Peucker: distância em metros (aproximação plana, boa para distâncias curtas)
function simplificar(pontos, toleranciaM) {
  const k = 111320, cos = Math.cos(pontos[0][1] * Math.PI / 180);
  const X = (p) => p[2] * k * cos, Y = (p) => p[1] * k;
  const manter = new Uint8Array(pontos.length);
  manter[0] = manter[pontos.length - 1] = 1;
  const pilha = [[0, pontos.length - 1]];
  while (pilha.length) {
    const [a, b] = pilha.pop();
    const ax = X(pontos[a]), ay = Y(pontos[a]), dx = X(pontos[b]) - ax, dy = Y(pontos[b]) - ay;
    const comprimento2 = dx * dx + dy * dy;
    let maior = 0, indice = -1;
    for (let i = a + 1; i < b; i++) {
      const px = X(pontos[i]) - ax, py = Y(pontos[i]) - ay;
      const u = comprimento2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / comprimento2)) : 0;
      const d = Math.hypot(px - u * dx, py - u * dy);
      if (d > maior) { maior = d; indice = i; }
    }
    if (maior > toleranciaM) { manter[indice] = 1; pilha.push([a, indice], [indice, b]); }
  }
  return pontos.filter((_, i) => manter[i]);
}

// Polilinha codificada (algoritmo público do Google): cada número é a diferença
// para o anterior, em unidades de 0,00001 grau (~1 m), escrita em caracteres ASCII.
function codificarNumero(n) {
  n = n < 0 ? ~(n << 1) : n << 1;
  let texto = "";
  while (n >= 0x20) { texto += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
  return texto + String.fromCharCode(n + 63);
}
function codificar(pontos) {
  let texto = "", lat0 = 0, lon0 = 0;
  for (const [, lat, lon] of pontos) {
    const la = Math.round(lat * 1e5), lo = Math.round(lon * 1e5);
    texto += codificarNumero(la - lat0) + codificarNumero(lo - lon0);
    lat0 = la; lon0 = lo;
  }
  return texto;
}

const formas = {};
let pontosFinais = 0, semTracado = 0;
for (const id of usados) {
  const brutos = formasBrutas.get(id);
  if (!brutos) { semTracado++; continue; }
  brutos.sort((a, b) => a[0] - b[0]);
  const simples = simplificar(brutos, TOLERANCIA_M);
  pontosFinais += simples.length;
  formas[id] = codificar(simples);
}

/* ---------- 4. ligar as linhas aos traçados ---------- */
const rotas = {};
for (const [k, v] of melhor) {
  if (!formas[v.forma]) continue;
  const [rota, direcao] = k.split("|");
  (rotas[rota] ??= []).push([Number(direcao), v.destino, v.forma]);
}
for (const lista of Object.values(rotas)) lista.sort((a, b) => a[0] - b[0]);

mkdirSync(dirname(saida), { recursive: true });
writeFileSync(saida, JSON.stringify({
  fonte: "GTFS da SPTrans (shapes.txt e trips.txt)",
  geradoEm: new Date().toISOString(),
  toleranciaM: TOLERANCIA_M,
  rotas,
  formas
}));
console.log(`${pontosLidos} pontos lidos -> ${pontosFinais} pontos guardados, ${Object.keys(formas).length} traçados, ${Object.keys(rotas).length} linhas (${semTracado} sem traçado) em ${saida}`);
