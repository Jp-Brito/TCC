// Teste local das funções do back-end, sem precisar da Vercel.
//
// Uso (na pasta do projeto):
//   node --env-file=.env.local tools/teste-api.mjs [codigoParada]
//
// O arquivo .env.local deve ter uma linha:  OLHOVIVO_TOKEN=seu_token
// (ele já é ignorado pelo Git, então não vai para o GitHub).

import status from "../api/status.js";
import linhas from "../api/linhas.js";
import posicao from "../api/posicao.js";
import previsao from "../api/previsao.js";
import { consultarComLogin } from "../lib/olhovivo.js";

if (!process.env.OLHOVIVO_TOKEN) {
  console.error('Falta o token. Crie o arquivo .env.local com a linha OLHOVIVO_TOKEN=seu_token e rode com --env-file=.env.local');
  process.exit(1);
}

// Simula o pedido e a resposta que a Vercel entregaria à função.
async function chamar(funcao, query = {}) {
  const inicio = Date.now();
  const res = {
    codigo: 0, corpo: null,
    setHeader() {},
    status(c) { this.codigo = c; return this; },
    json(b) { this.corpo = b; return this; }
  };
  await funcao({ method: "GET", query }, res);
  return { codigo: res.codigo, corpo: res.corpo, ms: Date.now() - inicio };
}

function mostrar(titulo, r, resumo) {
  const marca = r.codigo === 200 ? "OK  " : "FALHA";
  console.log(`[${marca}] ${titulo} — HTTP ${r.codigo} — ${r.ms} ms`);
  console.log("       " + (r.codigo === 200 ? resumo(r.corpo) : JSON.stringify(r.corpo)));
}

// 1) Login
const s = await chamar(status);
mostrar("Login (/api/status)", s, (c) => `loginMs: ${c.loginMs}`);
if (s.codigo !== 200) process.exit(1);

// 2) Busca de linhas
const l = await chamar(linhas, { termo: "8000" });
mostrar("Busca de linhas (termo 8000)", l, (c) =>
  `${c.linhas.length} resultado(s); primeiro: ${JSON.stringify(c.linhas[0])}`);

// 3) Posição dos ônibus da primeira linha encontrada
let codigoLinha = null;
if (l.codigo === 200 && l.corpo.linhas.length > 0) {
  codigoLinha = String(l.corpo.linhas[0].codigo);
  const p = await chamar(posicao, { linha: codigoLinha });
  mostrar(`Posição dos ônibus (linha ${codigoLinha})`, p, (c) =>
    `${c.veiculos.length} veículo(s); primeiro: ${JSON.stringify(c.veiculos[0] ?? null)}`);
}

// 4) Previsão numa parada.
// Se você não informar o código de uma parada na linha de comando, o script
// escolhe sozinho uma parada que a linha encontrada atende.
let parada = process.argv[2];
if (!parada && codigoLinha) {
  try {
    const paradas = await consultarComLogin(`/Parada/BuscarParadasPorLinha?codigoLinha=${codigoLinha}`);
    if (Array.isArray(paradas) && paradas.length > 0) {
      const escolhida = paradas[Math.floor(paradas.length / 2)];
      parada = String(escolhida.cp);
      console.log(`       (parada escolhida automaticamente: ${escolhida.cp} - ${escolhida.np}; a linha atende ${paradas.length} paradas)`);
    }
  } catch (erro) {
    console.log("       (não foi possível escolher uma parada automaticamente: " + erro.message + ")");
  }
}

if (parada) {
  const v = await chamar(previsao, { parada });
  mostrar(`Previsão (parada ${parada})`, v, (c) =>
    `${c.linhas.length} linha(s); primeira: ${JSON.stringify(c.linhas[0] ?? null)}`);
} else {
  console.log("[    ] Previsão não testada: passe o código de uma parada, ex.: node --env-file=.env.local tools/teste-api.mjs 18848");
}
