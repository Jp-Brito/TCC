// GET /api/tracado?linha=647A-10&destino=PINHEIROS&sentido=1
// Traçado (o caminho que o ônibus faz) de uma linha, em "polilinha codificada".
// O destino e o sentido (ambos opcionais) servem para escolher o traçado certo
// entre os dois sentidos da linha. Esses dados vêm do GTFS e não precisam da Olho Vivo.
import { enviarJson, exigirGet } from "../lib/olhovivo.js";
import { tracadoDaLinha } from "../lib/gtfs.js";

export default function handler(req, res) {
  if (!exigirGet(req, res)) return;

  const linha = String(req.query.linha ?? "").trim();
  if (!/^[0-9A-Za-z]{1,8}-\d{1,3}$/.test(linha)) {
    return enviarJson(res, 400, { erro: "Informe o parâmetro linha, no formato 647A-10." });
  }
  const destino = String(req.query.destino ?? "").slice(0, 80);
  const sentido = Number(req.query.sentido);

  const tracado = tracadoDaLinha(linha, destino, sentido);
  if (!tracado) {
    return enviarJson(res, 404, { erro: "Não há traçado para esta linha." });
  }

  // O traçado só muda quando o GTFS é atualizado: pode ficar guardado por um tempo
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(200).json({ letreiro: linha, ...tracado });
}
