// GET /api/paradas-linha?linha=2506
// Paradas por onde uma linha passa (no sentido do código informado).
// Use o "codigo" devolvido por /api/linhas ou /api/previsao.
//
// A consulta BuscarParadasPorLinha da Olho Vivo só cobre paradas de corredores
// (segundo a documentação) e vem vazia para muitas linhas. Nesses casos usamos
// a consulta Previsao/Linha, que lista as paradas que a linha atende com os
// ônibus previstos. O campo "fonte" informa de onde veio a lista.
import { consultarComLogin, enviarJson, tratarErro, exigirGet } from "../lib/olhovivo.js";

export default async function handler(req, res) {
  if (!exigirGet(req, res)) return;

  const linha = String(req.query.linha ?? "");
  if (!/^\d{1,9}$/.test(linha)) {
    return enviarJson(res, 400, { erro: "Informe o parâmetro linha (apenas números)." });
  }

  try {
    const dados = await consultarComLogin(`/Parada/BuscarParadasPorLinha?codigoLinha=${linha}`);

    let paradas = (Array.isArray(dados) ? dados : []).map((p) => ({
      id: p.cp,
      nome: p.np,
      referencia: p.ed,
      lat: p.py,
      lon: p.px
    }));
    let fonte = "paradas";

    if (paradas.length === 0) {
      // Plano B: paradas que aparecem na previsão de chegada da linha
      const previsao = await consultarComLogin(`/Previsao/Linha?codigoLinha=${linha}`);
      const vistas = new Set();
      paradas = [];
      for (const p of previsao?.ps ?? []) {
        if (vistas.has(p.cp)) continue;
        vistas.add(p.cp);
        paradas.push({ id: p.cp, nome: p.np, referencia: "", lat: p.py, lon: p.px });
      }
      fonte = "previsao";
    }

    enviarJson(res, 200, { paradas, fonte });
  } catch (erro) {
    tratarErro(res, erro);
  }
}