// GET /api/programacao?parada=5507020
// Programação das linhas de ônibus numa parada, pela tabela do GTFS da SPTrans (sem GPS).
// Serve de plano B no painel: quando a Olho Vivo não mostra ônibus de uma linha, o app
// mostra a que horas ela deve passar, ou que já encerrou e quando volta.
//
// O GTFS da SPTrans é por frequência, não por horário fixo de cada carro:
//  - trips.txt: uma viagem-modelo por linha e sentido;
//  - stop_times.txt: quanto tempo a viagem-modelo leva do terminal até cada parada;
//  - frequencies.txt: de quanto em quanto tempo sai ônibus em cada faixa do dia;
//  - calendar.txt: em que dias da semana a linha roda.
// Hora de saída + tempo até a parada = hora estimada de passagem. É uma estimativa: o tempo
// de viagem é o de uma viagem-modelo (muitas vezes de pico) e o trânsito real muda.
import { readFileSync } from "node:fs";
import { lerCsv } from "../lib/csv.js";
import { enviarJson, exigirGet } from "../lib/olhovivo.js";
import { corDaLinha } from "../lib/gtfs.js";

const arquivo = (caminho) => readFileSync(new URL(`../data/${caminho}`, import.meta.url), "utf8").replace(/^﻿/, "");
const DIA = 86400;
const JANELA_S = 120 * 60;   // "próximos" = passagens nas próximas 2 horas
const MAX_PROXIMOS = 3;
const DIAS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// "07:01:20" -> segundos desde a meia-noite (o GTFS usa 24:30:00 etc. depois da meia-noite)
const segundos = (hms) => { const [h, m, s] = hms.split(":").map(Number); return h * 3600 + m * 60 + (s || 0); };
const hora = (seg) => {
  const s = ((seg % DIA) + DIA) % DIA;
  return String(Math.floor(s / 3600)).padStart(2, "0") + ":" + String(Math.floor(s % 3600 / 60)).padStart(2, "0");
};
// "2026-11-10" + n dias -> { texto: "20261111", semana: 3 }
function dia(data, n) {
  const [a, m, d] = data.split("-").map(Number);
  const x = new Date(Date.UTC(a, m - 1, d + n));
  return { texto: x.toISOString().slice(0, 10).replace(/-/g, ""), semana: x.getUTCDay() };
}

// Monta os índices a partir do texto dos arquivos (separado da leitura para os testes usarem
// um GTFS pequeno, feito à mão).
export function montarIndice(textos) {
  const tabela = (t) => { const [cab, ...linhas] = lerCsv(t); return { col: Object.fromEntries(cab.map((n, i) => [n.trim(), i])), linhas }; };
  const viagensCsv = tabela(textos.trips), horariosCsv = tabela(textos.stop_times);
  const freqCsv = tabela(textos.frequencies), calCsv = tabela(textos.calendar);

  // Dias em que cada serviço roda
  const servicos = new Map();
  for (const c of calCsv.linhas) {
    const k = calCsv.col;
    servicos.set(c[k.service_id], { dias: DIAS.map((d) => c[k[d]] === "1"), ini: c[k.start_date], fim: c[k.end_date] });
  }
  const validoAte = [...servicos.values()].map((s) => s.fim).filter((x) => /^\d{8}$/.test(x)).sort().at(-1) ?? null;

  // Viagens de ônibus (metrô e trem ficam no api/trilhos)
  const viagens = new Map();
  for (const v of viagensCsv.linhas) {
    const k = viagensCsv.col, linha = v[k.route_id];
    if (/^(METRÔ|CPTM)/.test(linha)) continue;
    viagens.set(v[k.trip_id], {
      linha,
      sentido: Number(v[k.direction_id]) === 1 ? 2 : 1,   // direction_id 0/1 = sentido 1/2 da Olho Vivo
      destino: v[k.trip_headsign] ?? "",
      servico: v[k.service_id]
    });
  }

  // Saídas do terminal: [segundos, intervalo da faixa]
  const partidas = new Map();
  for (const f of freqCsv.linhas) {
    const k = freqCsv.col, viagem = f[k.trip_id];
    if (!viagens.has(viagem)) continue;
    const intervalo = Number(f[k.headway_secs]);
    if (!(intervalo > 0)) continue;
    const lista = partidas.get(viagem) ?? [];
    for (let t = segundos(f[k.start_time]), fim = segundos(f[k.end_time]); t <= fim; t += intervalo) lista.push([t, intervalo]);
    partidas.set(viagem, lista);
  }

  // Tempo do terminal até cada parada, na viagem-modelo
  const porViagem = new Map();
  for (const h of horariosCsv.linhas) {
    const k = horariosCsv.col, viagem = h[k.trip_id];
    if (!viagens.has(viagem)) continue;
    const lista = porViagem.get(viagem) ?? [];
    lista.push({ seq: Number(h[k.stop_sequence]), parada: h[k.stop_id], t: segundos(h[k.departure_time] || h[k.arrival_time]) });
    porViagem.set(viagem, lista);
  }
  const porParada = new Map();
  for (const [viagem, lista] of porViagem) {
    lista.sort((a, b) => a.seq - b.seq);
    const inicio = lista[0].t;
    for (const p of lista) {
      const itens = porParada.get(p.parada) ?? [];
      itens.push({ viagem, ate: p.t - inicio });
      porParada.set(p.parada, itens);
    }
  }
  return { viagens, partidas, porParada, servicos, validoAte };
}

function roda(servico, d) {
  return Boolean(servico && servico.dias[d.semana] && (!servico.ini || d.texto >= servico.ini) && (!servico.fim || d.texto <= servico.fim));
}

// Linhas da parada com as próximas passagens. data = "AAAA-MM-DD" e agora = segundos desde a
// meia-noite, os dois no horário de São Paulo.
export function programacaoDaParada(indice, parada, data, agora) {
  const grupos = new Map();   // "linha|sentido" -> { viagem, passagens: [[t, intervalo]] }
  for (const { viagem, ate } of indice.porParada.get(String(parada)) ?? []) {
    const v = indice.viagens.get(viagem);
    const chave = v.linha + "|" + v.sentido;
    const grupo = grupos.get(chave) ?? { v, passagens: [] };
    // Serviço de ontem (viagens que passam da meia-noite), de hoje e de amanhã
    for (const n of [-1, 0, 1]) {
      if (!roda(indice.servicos.get(v.servico), dia(data, n))) continue;
      for (const [saida, intervalo] of indice.partidas.get(viagem) ?? []) {
        const t = saida + ate + n * DIA;
        if (t >= agora) grupo.passagens.push([t, intervalo]);
      }
    }
    grupos.set(chave, grupo);
  }

  const linhas = [];
  for (const { v, passagens } of grupos.values()) {
    if (!passagens.length) continue;   // não roda nestes dias (ex.: linha só de dias úteis no sábado)
    passagens.sort((a, b) => a[0] - b[0]);
    const unicas = passagens.filter((p, i) => i === 0 || p[0] - passagens[i - 1][0] >= 60);
    const proximas = unicas.filter((p) => p[0] - agora <= JANELA_S).slice(0, MAX_PROXIMOS);
    const item = { letreiro: v.linha, sentido: v.sentido, destino: v.destino, cor: corDaLinha(v.linha) };
    if (proximas.length) {
      item.proximos = proximas.map(([t]) => ({ hora: hora(t), minutos: Math.round((t - agora) / 60) }));
      item.intervaloMin = Math.round(proximas[0][1] / 60);
      item.volta = null;
      // Último do dia: depois da última mostrada, nada nas próximas 3 horas
      const seguinte = unicas[proximas.length];
      item.ultimo = !seguinte || seguinte[0] - proximas.at(-1)[0] > 3 * 3600;
    } else {
      item.proximos = [];
      item.intervaloMin = null;
      item.ultimo = false;
      item.volta = { hora: hora(unicas[0][0]), amanha: unicas[0][0] >= DIA };
    }
    item._ordem = unicas[0][0];
    linhas.push(item);
  }
  linhas.sort((a, b) => a._ordem - b._ordem);
  linhas.forEach((l) => delete l._ordem);
  return linhas;
}

// Data e hora atuais em São Paulo
export function agoraSP(quando = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(quando).map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, segundos: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) };
}

let indice = null;   // montado uma vez por instância da função

export default function handler(req, res) {
  if (!exigirGet(req, res)) return;
  const parada = String(req.query?.parada ?? "");
  if (!/^\d{1,12}$/.test(parada)) {
    return enviarJson(res, 400, { erro: "Informe o parâmetro parada (apenas números)." });
  }
  try {
    indice ??= montarIndice({
      trips: arquivo("gtfs/trips.txt"), stop_times: arquivo("gtfs/stop_times.txt"),
      frequencies: arquivo("gtfs/frequencies.txt"), calendar: arquivo("gtfs/calendar.txt")
    });
    const agora = agoraSP();
    const v = indice.validoAte;
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60");
    res.status(200).json({
      fonte: "GTFS da SPTrans (programação, sem GPS)",
      validoAte: v ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null,
      agora: hora(agora.segundos),
      linhas: programacaoDaParada(indice, parada, agora.data, agora.segundos)
    });
  } catch (erro) {
    console.error("Falha ao montar a programação:", erro.message);
    enviarJson(res, 500, { erro: "Não foi possível carregar a programação desta parada." });
  }
}
