// GET /api/previsao?parada=700016623
// Linhas que passam numa parada, com a previsão de chegada de cada ônibus.
import { consultarComLogin, enviarJson, tratarErro, exigirGet } from "../lib/olhovivo.js";
import { corDaLinha } from "../lib/gtfs.js";   // cor da linha, lida do routes.txt

export default async function handler(req, res) {
  if (!exigirGet(req, res)) return;

  const parada = String(req.query.parada ?? "");
  if (!/^\d{1,12}$/.test(parada)) {
    return enviarJson(res, 400, { erro: "Informe o parâmetro parada (apenas números)." });
  }

  try {
    const dados = await consultarComLogin(`/Previsao/Parada?codigoParada=${parada}`);
    const p = dados?.p;

    const linhas = (p?.l ?? []).map((l) => ({
      codigo: l.cl,
      letreiro: l.c,
      cor: corDaLinha(l.c),    // cor de fundo em hexadecimal, ou null
      sentido: l.sl,
      // lt0 e lt1 são fixos por linha (principal e secundário), não mudam com o sentido.
      // Sentido 1 vai para lt0; sentido 2 vai para lt1 (conferido em 08/11/2026).
      destino: l.sl === 1 ? l.lt0 : l.lt1,
      origem: l.sl === 1 ? l.lt1 : l.lt0,
      veiculos: (l.vs ?? []).map((v) => ({
        prefixo: String(v.p),
        chegada: v.t,          // horário previsto, "HH:MM"
        acessivel: Boolean(v.a),
        atualizadoEm: v.ta,
        lat: v.py,
        lon: v.px
      }))
    }));

    enviarJson(res, 200, {
      horaReferencia: dados?.hr ?? null,
      parada: p ? { codigo: p.cp, nome: p.np, lat: p.py, lon: p.px } : null,
      linhas
    });
  } catch (erro) {
    tratarErro(res, erro);
  }
}