// GET /api/rota-a-pe?de=-23.55,-46.63&para=-23.56,-46.64
// Caminho a pé pelas ruas, do usuário até a parada, calculado pela OpenRouteService
// (perfil foot-walking, dados do OpenStreetMap). A chave fica na variável de ambiente
// ORS_KEY (configurada na Vercel) e nunca vai para o navegador.
// Devolve { distanciaM, duracaoS, pontos: [[lat, lon], ...] }.
// Se a rota falhar, o site continua mostrando a linha reta aproximada.
import { enviarJson, exigirGet } from "../lib/olhovivo.js";

const ORS = "https://api.openrouteservice.org/v2/directions/foot-walking";
const TEMPO_LIMITE_MS = 8000;
const DISTANCIA_MAX_M = 3000;   // só rotas curtas, para não gastar a cota gratuita

// "lat,lon" -> [lat, lon], só dentro da Grande São Paulo (folga generosa)
function lerPonto(texto) {
  const m = /^(-?\d{1,2}\.\d{1,7}),(-?\d{1,3}\.\d{1,7})$/.exec(String(texto ?? ""));
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (lat < -24.5 || lat > -23 || lon < -47.5 || lon > -45.8) return null;
  return [lat, lon];
}

function distanciaM(a, b) {
  const dy = (b[0] - a[0]) * 111320;
  const dx = (b[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

export default async function handler(req, res) {
  if (!exigirGet(req, res)) return;

  const de = lerPonto(req.query.de);
  const para = lerPonto(req.query.para);
  if (!de || !para) {
    return enviarJson(res, 400, { erro: "Informe de=lat,lon e para=lat,lon (na região de São Paulo)." });
  }
  if (distanciaM(de, para) > DISTANCIA_MAX_M) {
    return enviarJson(res, 422, { erro: "Distância grande demais para a rota a pé." });
  }
  const chave = process.env.ORS_KEY;
  if (!chave) {
    return enviarJson(res, 503, { erro: "Rota a pé não configurada (falta ORS_KEY)." });
  }

  try {
    // A OpenRouteService usa a ordem lon,lat
    const url = `${ORS}?api_key=${encodeURIComponent(chave)}&start=${de[1]},${de[0]}&end=${para[1]},${para[0]}`;
    const resposta = await fetch(url, {
      headers: { Accept: "application/geo+json" },
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS)
    });
    if (!resposta.ok) {
      console.error("OpenRouteService respondeu", resposta.status);
      return enviarJson(res, 502, { erro: `O serviço de rotas respondeu com erro ${resposta.status}.` });
    }
    const dados = await resposta.json();
    const rota = dados?.features?.[0];
    const coordenadas = rota?.geometry?.coordinates ?? [];
    if (coordenadas.length < 2) {
      return enviarJson(res, 404, { erro: "Nenhuma rota a pé encontrada." });
    }
    const resumo = rota.properties?.summary ?? {};
    enviarJson(res, 200, {
      distanciaM: Math.round(resumo.distance ?? 0),
      duracaoS: Math.round(resumo.duration ?? 0),
      pontos: coordenadas.map(([lon, lat]) => [Number(lat.toFixed(6)), Number(lon.toFixed(6))])
    });
  } catch (erro) {
    console.error("Falha na rota a pé:", erro.message);
    enviarJson(res, 502, { erro: "Não foi possível calcular a rota a pé agora." });
  }
}
