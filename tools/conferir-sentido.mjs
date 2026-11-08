// Confere, com ônibus de verdade, qual regra de "destino por sentido" está certa.
// Para cada ônibus que andou entre duas consultas, compara a direção do movimento com
// a direção dos dois traçados da linha (um para cada terminal). Depois diz se o terminal
// que bate com o movimento é o da regra NOVA (sentido 1 -> terminal principal) ou o da
// regra ANTIGA (sentido 1 -> terminal secundário).
//
// Uso:  node tools/conferir-sentido.mjs                      (linhas padrão, site publicado)
//       node tools/conferir-sentido.mjs --termos 5119,8000,N842 --espera 45
//       node tools/conferir-sentido.mjs --base http://localhost:3000
const args = process.argv.slice(2);
const opcao = (nome, padrao) => { const i = args.indexOf("--" + nome); return i >= 0 ? args[i + 1] : padrao; };
const BASE = opcao("base", "https://olhovivobus.vercel.app");
const TERMOS = opcao("termos", "5119,8000,875A,675K,N842,6450,917H,477P,701U,2290,509M,148L").split(",");
const ESPERA_S = Number(opcao("espera", "45"));

const json = async (caminho) => { const r = await fetch(BASE + caminho); if (!r.ok) throw new Error(r.status + " " + caminho); return r.json(); };
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));
const norm = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function decodificar(s) {
  const pts = []; let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    for (let k = 0; k < 2; k++) {
      let r = 0, sh = 0, b;
      do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      const d = r & 1 ? ~(r >> 1) : r >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}
const rumo = (a, b) => { const y = Math.sin((b[1] - a[1]) * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180);
  const x = Math.cos(a[0] * Math.PI / 180) * Math.sin(b[0] * Math.PI / 180) - Math.sin(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.cos((b[1] - a[1]) * Math.PI / 180);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; };
const dif = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const metros = (a, b) => Math.hypot((b[0] - a[0]) * 111320, (b[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180));
// Rumo do trecho do traçado mais próximo (só se estiver a até 40 m)
function rumoTracado(pts, p) {
  let menor = Infinity, r = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.min(metros(p, pts[i]), metros(p, pts[i + 1]), metros(p, [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]));
    if (d < menor) { menor = d; r = rumo(pts[i], pts[i + 1]); }
  }
  return menor <= 40 ? r : null;
}

const codigos = [];
for (const termo of TERMOS) {
  try {
    const { linhas } = await json(`/api/linhas?termo=${encodeURIComponent(termo)}`);
    for (const l of linhas) if (!l.circular && l.terminalPrincipal !== l.terminalSecundario) codigos.push(l);
  } catch (e) { console.log("falhou busca", termo, e.message); }
}
console.log(`${codigos.length} linhas-sentido. Primeira leitura...`);
const primeira = new Map();
await Promise.all(codigos.map(async (l) => { try { primeira.set(l.codigo, (await json(`/api/posicao?linha=${l.codigo}`)).veiculos); } catch {} }));
console.log(`Esperando ${ESPERA_S} s para os ônibus andarem...`);
await dormir(ESPERA_S * 1000);

const tracados = new Map();
async function tracadoPara(letreiro, destino) {
  const chave = letreiro + "|" + destino;
  if (!tracados.has(chave)) {
    try { const d = await json(`/api/tracado?linha=${encodeURIComponent(letreiro)}&destino=${encodeURIComponent(destino)}`);
      tracados.set(chave, d.criterio === "destino" ? decodificar(d.polilinha) : null); } catch { tracados.set(chave, null); }
  }
  return tracados.get(chave);
}

let novo = 0, antigo = 0, indefinido = 0;
const porLinha = {};
for (const l of codigos) {
  let segunda; try { segunda = (await json(`/api/posicao?linha=${l.codigo}`)).veiculos; } catch { continue; }
  const antes = new Map((primeira.get(l.codigo) || []).map((v) => [v.prefixo, v]));
  const tp = await tracadoPara(l.letreiro, l.terminalPrincipal);
  const ts = await tracadoPara(l.letreiro, l.terminalSecundario);
  if (!tp || !ts) continue;
  for (const v of segunda) {
    const a = antes.get(v.prefixo); if (!a) continue;
    const p0 = [a.lat, a.lon], p1 = [v.lat, v.lon];
    if (metros(p0, p1) < 50) continue;                 // andou pouco: direção incerta
    const mov = rumo(p0, p1);
    const rP = rumoTracado(tp, p1), rS = rumoTracado(ts, p1);
    if (rP === null || rS === null) { indefinido++; continue; }
    const bateP = dif(mov, rP) < 60, bateS = dif(mov, rS) < 60;
    if (bateP === bateS) { indefinido++; continue; }
    const vaiPara = bateP ? "principal" : "secundario";
    const regraNova = l.sentido === 1 ? "principal" : "secundario";
    const k = `${l.letreiro} s${l.sentido}`;
    porLinha[k] ??= { novo: 0, antigo: 0 };
    if (vaiPara === regraNova) { novo++; porLinha[k].novo++; } else { antigo++; porLinha[k].antigo++; }
  }
}
console.table(porLinha);
console.log(`\nÔnibus conferidos: ${novo + antigo} (indefinidos: ${indefinido})`);
console.log(`Regra NOVA certa (sentido 1 vai para o terminal principal): ${novo}`);
console.log(`Regra ANTIGA certa (sentido 1 vai para o terminal secundário): ${antigo}`);
