// GET /api/situacao-trilhos
// Situação atual das linhas de metrô e trem de São Paulo (operação normal, velocidade
// reduzida, paralisada, encerrada...), de todas as operadoras: Metrô, CPTM, Motiva
// (linhas 4, 5, 8 e 9), TIC Trens e Trivia Trens.
//
// Fonte: API pública usada pelo site da Motiva Trilhos (grupo CCR). Não é documentada
// oficialmente; se mudar ou sair do ar, o app simplesmente não mostra a situação.
// Ideia inicial inspirada no projeto metro-sp-api, de ale-jr (licença MIT).
//
// A resposta fica 2 min em cache na Vercel: a fonte é consultada no máximo uma vez a
// cada 2 minutos, não importa quantas pessoas usem o app.
import { enviarJson, exigirGet } from "../lib/olhovivo.js";

const ORIGEM = "https://webapi.grupoccr.com.br/v1/mobility/public/line-status/current/state/SP";
const TEMPO_LIMITE_MS = 8000;

// Agrupa as situações em poucos tipos (para a cor da bolinha). O texto mostrado é o da fonte.
function classificar(codigo, texto) {
  const t = `${codigo} ${texto}`.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (t.includes("normal")) return "normal";
  if (t.includes("paralis") || t.includes("interromp")) return "paralisada";
  if (t.includes("encerrad") || t.includes("fechad")) return "encerrada";
  if (t.includes("reduzida") || t.includes("lenta")) return "reduzida";
  if (t.includes("parcial") || t.includes("transitori") || t.includes("diferenciad")) return "parcial";
  return "outra";
}

// Transforma a resposta da fonte em { linhas: [...], atualizadoEm }. Exportada para os testes.
export function lerSituacao(json) {
  const linhas = [];
  for (const concessao of json?.data?.concessoes ?? []) {
    for (const l of concessao.linhas ?? []) {
      const numero = Number(l.numero);
      const s = l.statusLinha ?? {};
      if (!Number.isFinite(numero) || !s.status) continue;
      const detalhe = String(s.descricao ?? "").trim();
      linhas.push({
        numero,
        nome: l.nome ?? null,
        operadora: concessao.nome ?? null,
        situacao: classificar(s.codigo ?? "", s.status),
        descricao: s.status,
        motivo: detalhe && detalhe.toLowerCase() !== String(s.status).toLowerCase() ? detalhe : null
      });
    }
  }
  // "2026-11-09T17:16:15" vem sem fuso: é horário de Brasília
  const data = json?.data?.dataAtualizacao;
  const atualizadoEm = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(data ?? "") ? `${data}-03:00` : null;
  return { linhas: linhas.sort((a, b) => a.numero - b.numero), atualizadoEm };
}

export default async function handler(req, res) {
  if (!exigirGet(req, res)) return;
  try {
    const resposta = await fetch(ORIGEM, {
      headers: { Accept: "application/json", "User-Agent": "JotaBus/0.1 (prototipo de TCC; jotabus.vercel.app)" },
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS)
    });
    if (!resposta.ok) {
      console.error("Fonte da situação respondeu", resposta.status);
      return enviarJson(res, 502, { erro: "A fonte da situação das linhas respondeu com erro." });
    }
    const dados = lerSituacao(await resposta.json());
    if (dados.linhas.length === 0) {
      console.error("Situação das linhas: resposta sem linhas (o formato pode ter mudado).");
      return enviarJson(res, 502, { erro: "Não foi possível ler a situação das linhas." });
    }
    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
    res.status(200).json({ fonte: "Motiva Trilhos (API pública do site)", consultadoEm: new Date().toISOString(), ...dados });
  } catch (erro) {
    console.error("Falha ao ler a situação das linhas:", erro.message);
    enviarJson(res, 502, { erro: "Não foi possível consultar a situação das linhas agora." });
  }
}
