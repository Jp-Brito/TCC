// GET /api/posicao?linha=1273
// Posição dos ônibus de uma linha (use o "codigo" devolvido por /api/linhas).
import { consultarComLogin, enviarJson, tratarErro, exigirGet } from "../lib/olhovivo.js";

export default async function handler(req, res) {
  if (!exigirGet(req, res)) return;

  const linha = String(req.query.linha ?? "");
  if (!/^\d{1,9}$/.test(linha)) {
    return enviarJson(res, 400, { erro: "Informe o parâmetro linha (apenas números)." });
  }

  try {
    const dados = await consultarComLogin(`/Posicao/Linha?codigoLinha=${linha}`);

    const veiculos = (dados?.vs ?? []).map((v) => ({
      prefixo: String(v.p),
      acessivel: Boolean(v.a),
      atualizadoEm: v.ta,   // horário UTC da última posição
      lat: v.py,
      lon: v.px
    }));

    enviarJson(res, 200, { horaReferencia: dados?.hr ?? null, veiculos });
  } catch (erro) {
    tratarErro(res, erro);
  }
}
