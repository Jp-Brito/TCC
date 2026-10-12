// GET /api/linhas?termo=8000
// Busca linhas pelo número ou nome. Cada linha vem uma vez por sentido,
// e o campo "codigo" é o que as outras rotas pedem.
import { consultarComLogin, enviarJson, tratarErro, exigirGet } from "../lib/olhovivo.js";

export default async function handler(req, res) {
  if (!exigirGet(req, res)) return;

  const termo = String(req.query.termo ?? "").trim();
  if (termo.length < 1 || termo.length > 40) {
    return enviarJson(res, 400, { erro: "Informe o parâmetro termo (até 40 caracteres)." });
  }

  try {
    const dados = await consultarComLogin(`/Linha/Buscar?termosBusca=${encodeURIComponent(termo)}`);

    const linhas = (Array.isArray(dados) ? dados : []).map((l) => ({
      codigo: l.cl,                      // código único da linha (por sentido)
      letreiro: `${l.lt}-${l.tl}`,       // ex.: 8000-10
      sentido: l.sl,                     // 1 = principal -> secundário, 2 = o inverso
      circular: l.lc,
      terminalPrincipal: l.tp,
      terminalSecundario: l.ts,
      destino: l.sl === 1 ? l.ts : l.tp  // derivado: conferir nos testes
    }));

    enviarJson(res, 200, { linhas });
  } catch (erro) {
    tratarErro(res, erro);
  }
}
