// GET /api/paradas-linha?linha=2506
// Paradas por onde uma linha passa (no sentido do código informado).
// Use o "codigo" devolvido por /api/linhas ou /api/previsao.
import { consultarComLogin, enviarJson, tratarErro, exigirGet } from "../lib/olhovivo.js";

export default async function handler(req, res) {
  if (!exigirGet(req, res)) return;

  const linha = String(req.query.linha ?? "");
  if (!/^\d{1,9}$/.test(linha)) {
    return enviarJson(res, 400, { erro: "Informe o parâmetro linha (apenas números)." });
  }

  try {
    const dados = await consultarComLogin(`/Parada/BuscarParadasPorLinha?codigoLinha=${linha}`);

    const paradas = (Array.isArray(dados) ? dados : []).map((p) => ({
      id: p.cp,
      nome: p.np,
      referencia: p.ed,
      lat: p.py,
      lon: p.px
    }));

    enviarJson(res, 200, { paradas });
  } catch (erro) {
    tratarErro(res, erro);
  }
}
