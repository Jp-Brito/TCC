// GET /api/tracado?linha=647A-10&destino=PINHEIROS&sentido=1&pos=-23.5,-46.6;-23.6,-46.7
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

  // Posições de ônibus da linha (opcional): "lat,lon;lat,lon" (até 6)
  const posicoes = String(req.query.pos ?? "").slice(0, 400).split(";").slice(0, 6)
    .map((par) => par.split(",").map(Number))
    .filter((v) => v.length === 2 && v.every(Number.isFinite) && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180)
    .map(([lat, lon]) => ({ lat, lon }));

  const tracado = tracadoDaLinha(linha, destino, sentido, posicoes);
  if (!tracado) {
    return enviarJson(res, 404, { erro: "Não há traçado para esta linha." });
  }

  // O traçado só muda quando o GTFS é atualizado: pode ficar guardado por um tempo
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(200).json({ letreiro: linha, ...tracado });
}