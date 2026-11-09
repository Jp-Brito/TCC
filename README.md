# JotaBus

Protótipo do TCC (Ciência da Computação, FAMOnline): aplicação web para acompanhar os ônibus
de São Paulo em tempo real. Site em HTML e JavaScript puro com mapa Leaflet, instalável como
aplicativo (PWA), e funções Node.js na Vercel (região `gru1`, São Paulo) que consultam a API
Olho Vivo da SPTrans. O site e as funções ficam no mesmo projeto.

Publicado em: https://olhovivobus.vercel.app

## Funcionalidades
- Mapa claro/escuro, localização do usuário e paradas (a partir do zoom 15)
- Painel da parada: linhas, previsão de chegada e ônibus no mapa, atualizando a cada 12 s
- Busca de linhas (lupa): ônibus em circulação, traçado e paradas da linha
- Ônibus na cor oficial da linha, com a direção pelo traçado e pelo movimento real
- Paradas da linha discretas, que aparecem conforme o zoom
- Caminho a pé pelas ruas até a parada aberta, ou até a parada mais próxima da linha buscada
- Aviso de dados desatualizados (falha, demora ou GPS parado); ônibus mantidos na última
  posição por até 2 min, com etiqueta "⚠ há N s"

## Estrutura
- `index.html`, `css/styles.css`, `js/` — o site (`app.js` mapa e localização, `painel.js` painel,
  ônibus, traçado e caminho a pé, `busca.js` lupa, `paradas.js` índice das paradas, `config.js` ajustes)
- `manifest.webmanifest`, `sw.js`, `icons/` — PWA (o service worker nunca guarda respostas da `/api`)
- `api/` — funções Node.js chamadas pelo site
- `lib/olhovivo.js` (login e consultas à Olho Vivo), `lib/gtfs.js` (cores, traçados e paradas do GTFS), `lib/csv.js`
- `data/` — `stops.json` e `tracados.json` (gerados do GTFS) e `gtfs/*.txt` da SPTrans
  (`shapes.txt`, com 58 MB, fica fora do Git)
- `tools/` — scripts de geração de dados, medições e testes

## Rotas da API
| Rota | O que devolve |
|---|---|
| `GET /api/status` | Confere o login na Olho Vivo e mede o tempo |
| `GET /api/linhas?termo=5119` | Linhas encontradas, uma por sentido (`codigo`, `sentido`, `destino`, cor) |
| `GET /api/posicao?linha=CODIGO` | Posição dos ônibus da linha |
| `GET /api/previsao?parada=ID` | Linhas e previsões de chegada na parada |
| `GET /api/paradas-linha?linha=CODIGO&letreiro=5119-10&sentido=1` | Paradas da linha; campo `fonte`: `paradas`, `previsao`, `gtfs-stop-times` ou `gtfs-proximidade` |
| `GET /api/tracado?linha=5119-10&destino=&sentido=&pos=` | Traçado (polilinha codificada) do sentido certo |
| `GET /api/rota-a-pe?de=lat,lon&para=lat,lon` | Caminho a pé pelas ruas (OpenRouteService), até 3 km |
| `GET /api/trilhos` | Linhas de metrô e trem: cor, traçado, estações e intervalos programados (GTFS) |
| `GET /api/situacao-trilhos` | Situação das linhas de metrô e trem de todas as operadoras (API pública do site da Motiva Trilhos, não oficial; cache de 2 min) |

Sentido: na Olho Vivo, o sentido 1 vai para o terminal principal e o 2 para o secundário
(conferido em 08/11/2026 com ônibus reais; corresponde às direções 0 e 1 do GTFS).

## Variáveis de ambiente (Vercel e `.env.local`, nunca no Git)
- `OLHOVIVO_TOKEN` — token da API Olho Vivo
- `ORS_KEY` — chave da OpenRouteService (rota a pé)

## Scripts
```
npm test                                          # testes automáticos; registra em tools/medicoes/testes.csv
node tools/teste-api.mjs                          # testa a Olho Vivo com o .env.local
node tools/gerar-paradas.mjs                      # data/gtfs/stops.txt -> data/stops.json
node tools/gerar-tracados.mjs                     # shapes.txt + trips.txt -> data/tracados.json
node tools/medir-desempenho.mjs --rodadas 20 --condicao NOME      # tempo de resposta (--resumo)
node tools/medir-paradas-linha.mjs --amostra 80 --rotulo NOME     # linhas sem paradas na API
node tools/medir-precisao-previsao.mjs --termo 5119 --duracao 60 --rotulo NOME   # precisão (--resumo)
node tools/conferir-sentido.mjs                   # confere o sentido com o movimento real dos ônibus
```
As medições são gravadas em `tools/medicoes/*.csv` (fora do Git). Nomes de condição e rótulo
sem espaços nem vírgulas.

Teste de falha no navegador: `?simular=falha` (a primeira atualização funciona e as seguintes
falham) ou `?simular=lento` (as seguintes demoram 15 s e estouram o tempo limite de 10 s).

## Créditos e licenças
- Leaflet 1.9.4 — biblioteca de mapas (licença BSD-2-Clause)
- Mapa: © OpenStreetMap contributors (ODbL), © CARTO
- Rotas a pé: © openrouteservice.org by HeiGIT, com dados do OpenStreetMap
- Dados de ônibus, metrô e trem: API Olho Vivo e GTFS da SPTrans
- Situação das linhas de metrô e trem: API pública usada pelo site da Motiva Trilhos (grupo CCR),
  não documentada oficialmente; ideia inicial inspirada no projeto
  [metro-sp-api](https://github.com/ale-jr/metro-sp-api) de ale-jr (licença MIT)
