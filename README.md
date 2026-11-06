# Ônibus ao Vivo SP (nome provisório)

Protótipo do TCC: site em HTML e JavaScript puro, com mapa Leaflet e dados da API Olho Vivo (SPTrans), instalável como aplicativo (PWA) e hospedado na Vercel. O site e as funções do back-end ficam no mesmo projeto.

## Estrutura
- `index.html`, `css/styles.css`, `js/` — o site (cabeçalho, mapa, localização, tema)
- `manifest.webmanifest`, `sw.js`, `icons/` — PWA
- `lib/olhovivo.js` — login e consultas à Olho Vivo (compartilhado)
- `api/` — funções Node.js que o site chama:
  - `GET /api/status` — confere o token e mede o tempo do login
  - `GET /api/linhas?termo=8000` — busca linhas (devolve o `codigo` de cada sentido)
  - `GET /api/posicao?linha=1273` — posição dos ônibus de uma linha
  - `GET /api/previsao?parada=700016623` — linhas e previsões de chegada numa parada
- `package.json`, `vercel.json`, `.gitignore`

## Coleta automática da precisão

O coletor de previsões pode ficar rodando continuamente no computador. Em um PowerShell,
execute:

```powershell
node tools/medir-precisao-previsao.mjs --termo 5119 --duracao 0 --intervalo 15 --rotulo coleta-continua
```

`--duracao 0` mantém a coleta ativa até `Ctrl+C`. Para escolher uma parada específica,
use `--linha CODIGO --letreiro LETREIRO --parada ID`. Quando a API de paradas devolve
uma lista incompleta, a aplicação usa a sequência oficial de `trips.txt` e
`stop_times.txt` (fonte `gtfs-stop-times`). O fallback espacial `gtfs-proximidade`
fica reservado para linhas sem uma viagem compatível. Os resultados são acrescentados em
`tools/medicoes/precisao-previsao.csv`; o resumo pode ser consultado com:

```powershell
node tools/medir-precisao-previsao.mjs --resumo
```

Mantenha o computador conectado à internet e evite suspender o sistema durante a coleta.

## Créditos e licenças
- Leaflet — biblioteca de mapas de código aberto.
- Mapa: © OpenStreetMap contributors, © CARTO (atribuição exibida no mapa).
- Dados de ônibus: API Olho Vivo, SPTrans.
