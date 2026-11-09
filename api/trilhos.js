// GET /api/trilhos
// Linhas de metrô e trem (CPTM) para desenhar no mapa: cor oficial, traçado e estações.
// Tudo vem do GTFS da SPTrans (routes.txt, trips.txt, stop_times.txt) e dos arquivos já
// gerados (tracados.json e stops.json). São dados fixos (sem posição dos trens em tempo
// real, que o Metrô e a CPTM não publicam), por isso a resposta pode ficar em cache.
import { readFileSync } from "node:fs";
import { lerCsv } from "../lib/csv.js";
import { enviarJson, exigirGet } from "../lib/olhovivo.js";

const arquivo = (caminho) => readFileSync(new URL(`../data/${caminho}`, import.meta.url), "utf8").replace(/^﻿/, "");
const ehTrilho = (id) => id.startsWith("METRÔ") || id.startsWith("CPTM");

// Nomes oficiais das linhas (o GTFS traz só o número)
const NOMES = {
  1: "Azul", 2: "Verde", 3: "Vermelha", 4: "Amarela", 5: "Lilás", 6: "Laranja",
  7: "Rubi", 8: "Diamante", 9: "Esmeralda", 10: "Turquesa", 11: "Coral", 12: "Safira",
  13: "Jade", 15: "Prata", 17: "Ouro"
};

let resposta = null;   // montada uma vez por instância da função

function montar() {
  // Só as linhas do GTFS que interessam (os arquivos têm milhares de linhas de ônibus)
  const filtrar = (texto) => texto.split(/\r?\n/).filter((l, i) => i === 0 || /^"?(METRÔ|CPTM)/.test(l)).join("\n");
  const rotas = lerCsv(filtrar(arquivo("gtfs/routes.txt")));
  const viagens = lerCsv(filtrar(arquivo("gtfs/trips.txt")));
  const horarios = lerCsv(filtrar(arquivo("gtfs/stop_times.txt")));
  const tracados = JSON.parse(arquivo("tracados.json"));
  const paradas = JSON.parse(arquivo("stops.json"));
  const col = (cab) => Object.fromEntries(cab.map((n, i) => [n.trim(), i]));

  const indice = new Map(paradas.ids.map((id, i) => [String(id), i]));
  const cr = col(rotas[0]), cv = col(viagens[0]), ch = col(horarios[0]);

  // Viagem da direção 0 de cada linha (as duas direções passam pelos mesmos trilhos)
  const viagemDe = new Map();
  for (const v of viagens.slice(1)) {
    if (v[cv.direction_id] === "0" && !viagemDe.has(v[cv.route_id])) viagemDe.set(v[cv.route_id], v[cv.trip_id]);
  }
  const estacoesDe = new Map();
  for (const h of horarios.slice(1)) {
    const lista = estacoesDe.get(h[ch.trip_id]) ?? [];
    lista.push({ seq: Number(h[ch.stop_sequence]), id: h[ch.stop_id] });
    estacoesDe.set(h[ch.trip_id], lista);
  }

  const linhas = [];
  for (const r of rotas.slice(1)) {
    const id = r[cr.route_id];
    if (!ehTrilho(id)) continue;
    const numero = Number((id.match(/(\d+)\D*$/) || [])[1]);
    const opcoes = tracados.rotas[id] ?? [];
    const forma = (opcoes.find((o) => o[0] === 0) ?? opcoes[0])?.[2];
    const viagem = viagemDe.get(id);
    const estacoes = (estacoesDe.get(viagem) ?? [])
      .sort((a, b) => a.seq - b.seq)
      .map((e) => indice.get(e.id))
      .filter((i) => i !== undefined)
      .map((i) => ({ id: paradas.ids[i], nome: paradas.nomes[i], lat: Number(paradas.lats[i]), lon: Number(paradas.lons[i]) }));
    linhas.push({
      id,
      tipo: id.startsWith("CPTM") ? "trem" : "metro",
      numero,
      // "Trem"/"Metrô" pelo tipo (algumas linhas são de concessionárias, não da CPTM ou do Metrô)
      nome: `${id.startsWith("CPTM") ? "Trem" : "Metrô"} · Linha ${numero}${NOMES[numero] ? " – " + NOMES[numero] : ""}`,
      trecho: r[cr.route_long_name],
      cor: /^[0-9A-F]{6}$/i.test(r[cr.route_color]) ? r[cr.route_color] : "8B5CF6",
      polilinha: forma ? tracados.formas[forma] ?? null : null,
      estacoes
    });
  }
  linhas.sort((a, b) => a.numero - b.numero);
  return { fonte: "GTFS da SPTrans", linhas };
}

export default function handler(req, res) {
  if (!exigirGet(req, res)) return;
  try {
    resposta ??= montar();
    // Dados fixos: o navegador guarda por 1 h e a Vercel por 1 dia
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");
    res.status(200).json(resposta);
  } catch (erro) {
    console.error("Falha ao montar trilhos:", erro.message);
    enviarJson(res, 500, { erro: "Não foi possível carregar as linhas de metrô e trem." });
  }
}
