// Acesso à API Olho Vivo da SPTrans (versão 2.1).
// Todas as funções da pasta api/ usam este arquivo, então o login e o
// tratamento de erros ficam em um lugar só.
//
// O token vem da variável de ambiente OLHOVIVO_TOKEN (configurada na Vercel).
// Ele nunca aparece no código, no navegador nem no GitHub.

const BASE = "https://api.olhovivo.sptrans.com.br/v2.1";
const TEMPO_LIMITE_MS = 8000;

export class ErroOlhoVivo extends Error {
  constructor(mensagem, status = 502) {
    super(mensagem);
    this.name = "ErroOlhoVivo";
    this.status = status;
  }
}

// Passo 1: autenticar. A API devolve `true` e um cookie de sessão, que
// precisa ser enviado em todas as consultas seguintes.
async function autenticar() {
  const token = process.env.OLHOVIVO_TOKEN;
  if (!token) {
    throw new ErroOlhoVivo("A variável OLHOVIVO_TOKEN não está configurada.", 500);
  }

  let resposta;
  try {
    resposta = await fetch(`${BASE}/Login/Autenticar?token=${encodeURIComponent(token)}`, {
      method: "POST",
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS)
    });
  } catch (erro) {
    throw new ErroOlhoVivo("Não foi possível falar com a Olho Vivo (login).", 504);
  }

  const autenticado = await resposta.json().catch(() => false);
  if (!resposta.ok || autenticado !== true) {
    throw new ErroOlhoVivo("A Olho Vivo recusou o token.", 502);
  }

  // Guarda só "nome=valor" de cada cookie recebido.
  return resposta.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

// Passo 2: consultar um caminho da API usando a sessão.
async function consultar(caminho, cookie) {
  let resposta;
  try {
    resposta = await fetch(`${BASE}${caminho}`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS)
    });
  } catch (erro) {
    throw new ErroOlhoVivo("A Olho Vivo não respondeu a tempo.", 504);
  }
  if (!resposta.ok) {
    throw new ErroOlhoVivo(`A Olho Vivo respondeu com erro ${resposta.status}.`, 502);
  }
  return resposta.json();
}

// Faz login e consulta em uma única chamada.
// Nas funções da Vercel não há memória entre uma chamada e outra,
// por isso cada pedido faz o seu próprio login.
export async function consultarComLogin(caminho) {
  const cookie = await autenticar();
  return consultar(caminho, cookie);
}

// Só testa o login (usado pela rota /api/status).
export async function testarLogin() {
  await autenticar();
  return true;
}

// Resposta padrão das funções: JSON, sem guardar cópia (dados em tempo real).
export function enviarJson(res, status, corpo) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(corpo);
}

export function tratarErro(res, erro) {
  if (erro instanceof ErroOlhoVivo) {
    return enviarJson(res, erro.status, { erro: erro.message });
  }
  console.error("Erro inesperado:", erro);
  return enviarJson(res, 500, { erro: "Erro interno." });
}

// Aceita só GET.
export function exigirGet(req, res) {
  if (req.method !== "GET") {
    enviarJson(res, 405, { erro: "Use o método GET." });
    return false;
  }
  return true;
}
