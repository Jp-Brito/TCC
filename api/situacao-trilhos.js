// GET /api/situacao-trilhos
// Situação atual das linhas de metrô e trem (operação normal, velocidade reduzida,
// paralisada, encerrada), lida do quadro de situação do site da ViaMobilidade, que mostra
// todas as linhas (Metrô, CPTM, ViaQuatro e ViaMobilidade).
//
// Fonte NÃO oficial: não é uma API, é a leitura da página. Ideia baseada no projeto
// metro-sp-api, de ale-jr (https://github.com/ale-jr/metro-sp-api, licença MIT).
// Se o site mudar o layout, a leitura falha e o app simplesmente não mostra a situação.
//
// A resposta fica 2 min em cache na Vercel: o site de origem é consultado no máximo
// uma vez a cada 2 minutos, não importa quantas pessoas usem o app.
import { enviarJson, exigirGet } from "../lib/olhovivo.js";

const ORIGEM = "https://www.viamobilidade.com.br/";
const TEMPO_LIMITE_MS = 8000;

// Entidades HTML mais comuns em português
const ENTIDADES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aacute: "á", agrave: "à", acirc: "â", atilde: "ã", eacute: "é", ecirc: "ê", iacute: "í",
  oacute: "ó", ocirc: "ô", otilde: "õ", uacute: "ú", ccedil: "ç",
  Aacute: "Á", Agrave: "À", Acirc: "Â", Atilde: "Ã", Eacute: "É", Ecirc: "Ê", Iacute: "Í",
  Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Uacute: "Ú", Ccedil: "Ç"
};

// Tira as tags, troca as entidades e junta os espaços
function texto(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, nome) => ENTIDADES[nome] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

// Classifica pelo texto da situação (mais estável que as cores do site)
function classificar(descricao) {
  const t = descricao.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (t.includes("normal")) return "normal";
  if (t.includes("reduzida") || t.includes("lenta")) return "reduzida";
  if (t.includes("paralis") || t.includes("interromp")) return "paralisada";
  if (t.includes("encerrad") || t.includes("fechad")) return "encerrada";
  return "outra";
}

// Lê o HTML da página e devolve { linhas: [...], atualizadoEm }. Exportada para os testes.
export function lerSituacao(html) {
  const linhas = [];
  const vistas = new Set();
  const itens = /<li\b[^>]*\bclass\s*=\s*"([^"]*\bline-(\d+)\b[^"]*)"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = itens.exec(html))) {
    const numero = Number(m[2]);
    const corpo = m[3];
    const status = /<[a-z]+\b[^>]*\bclass\s*=\s*"[^"]*\bstatus\b[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(corpo);
    if (!status || vistas.has(numero)) continue;
    const descricao = texto(status[1]);
    if (!descricao) continue;
    vistas.add(numero);
    const nome = /<span\b[^>]*\btitle\s*=\s*"([^"]+)"/i.exec(corpo);
    const motivo = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(corpo);
    linhas.push({
      numero,
      nome: nome ? texto(nome[1]) : null,
      situacao: classificar(descricao),
      descricao,
      motivo: motivo ? texto(motivo[1]) || null : null
    });
  }
  // Data e hora da atualização mostradas pelo site (dd/mm/aaaa hh:mm[:ss], horário de Brasília)
  const d = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/.exec(html);
  const atualizadoEm = d ? `${d[3]}-${d[2]}-${d[1]}T${d[4]}:${d[5]}:${d[6] ?? "00"}-03:00` : null;
  return { linhas: linhas.sort((a, b) => a.numero - b.numero), atualizadoEm };
}

export default async function handler(req, res) {
  if (!exigirGet(req, res)) return;
  try {
    const resposta = await fetch(ORIGEM, {
      headers: { Accept: "text/html", "User-Agent": "OnibusAoVivoSP/0.1 (prototipo de TCC; olhovivobus.vercel.app)" },
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS)
    });
    if (!resposta.ok) {
      console.error("ViaMobilidade respondeu", resposta.status);
      return enviarJson(res, 502, { erro: "O site de origem respondeu com erro." });
    }
    const dados = lerSituacao(await resposta.text());
    if (dados.linhas.length === 0) {
      console.error("Situação das linhas: nada encontrado (o layout do site pode ter mudado).");
      return enviarJson(res, 502, { erro: "Não foi possível ler a situação das linhas." });
    }
    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
    res.status(200).json({ fonte: "ViaMobilidade (leitura do site)", consultadoEm: new Date().toISOString(), ...dados });
  } catch (erro) {
    console.error("Falha ao ler a situação das linhas:", erro.message);
    enviarJson(res, 502, { erro: "Não foi possível consultar a situação das linhas agora." });
  }
}
