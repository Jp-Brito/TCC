// Gera data/stops.json a partir do stops.txt do GTFS da SPTrans.
//
// Uso (na pasta do projeto):
//   node tools/gerar-paradas.mjs [caminho/do/stops.txt]
//
// Padrão de entrada: tools/gtfs/stops.txt
// Saída: data/stops.json (formato "colunar": uma lista para cada campo,
// o que deixa o arquivo menor do que uma lista de objetos).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const entrada = process.argv[2] ?? "tools/gtfs/stops.txt";
const saida = "data/stops.json";

// Leitor de CSV simples: aceita campos entre aspas, com vírgulas dentro.
function lerCsv(texto) {
  const linhas = [];
  let campo = "", linha = [], entreAspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (entreAspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') entreAspas = false;
      else campo += c;
    } else if (c === '"') entreAspas = true;
    else if (c === ",") { linha.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      linha.push(campo); campo = "";
      if (linha.length > 1 || linha[0] !== "") linhas.push(linha);
      linha = [];
    } else campo += c;
  }
  if (campo !== "" || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

const texto = readFileSync(entrada, "utf8").replace(/^\uFEFF/, "");
const [cabecalho, ...linhas] = lerCsv(texto);
const col = Object.fromEntries(cabecalho.map((nome, i) => [nome.trim(), i]));
for (const obrigatoria of ["stop_id", "stop_name", "stop_lat", "stop_lon"]) {
  if (!(obrigatoria in col)) throw new Error(`Coluna ausente no stops.txt: ${obrigatoria}`);
}

const dados = { ids: [], nomes: [], enderecos: [], lats: [], lons: [] };
let descartadas = 0;
for (const l of linhas) {
  const id = Number(l[col.stop_id]);
  const lat = Number(l[col.stop_lat]);
  const lon = Number(l[col.stop_lon]);
  if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lon)) { descartadas++; continue; }
  dados.ids.push(id);
  dados.nomes.push((l[col.stop_name] ?? "").trim());
  dados.enderecos.push((l[col.stop_desc] ?? "").trim());
  dados.lats.push(lat);
  dados.lons.push(lon);
}

const resultado = {
  fonte: "GTFS da SPTrans (stops.txt)",
  geradoEm: new Date().toISOString(),
  total: dados.ids.length,
  ...dados
};

mkdirSync(dirname(saida), { recursive: true });
writeFileSync(saida, JSON.stringify(resultado));
console.log(`${resultado.total} paradas gravadas em ${saida} (${descartadas} linhas descartadas).`);
