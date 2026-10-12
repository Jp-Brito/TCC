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

## O token da Olho Vivo
É a chave de acesso gerada no portal de desenvolvedores da SPTrans, na área **Meus Aplicativos**. Ele **não** vai para o código nem para o GitHub: fica só na Vercel.

1. Gere (ou renove) o token em Meus Aplicativos, no site da SPTrans.
2. Na Vercel: projeto → **Settings → Environment Variables**.
3. Crie a variável **`OLHOVIVO_TOKEN`** com o token como valor (marque Production, Preview e Development).
4. Faça um novo deploy (variável nova só vale depois de um redeploy).

## Publicar na Vercel
1. Suba esta pasta para um repositório no GitHub.
2. Na Vercel: *Add New → Project*, importe o repositório. Sem framework e sem comando de build.
3. Configure `OLHOVIVO_TOKEN` (acima) e faça o deploy.
4. Abra `https://SEU-PROJETO.vercel.app/api/status`. Deve aparecer `{"ok":true,"loginMs":...}`.

Se aparecer erro de login ou de tempo esgotado, a Olho Vivo pode estar recusando o servidor. Nesse caso, em `vercel.json` dá para escolher a região das funções.

## Testar localmente
- Só o site: `npx serve .`
- Site e funções: `npm i -g vercel`, depois `vercel dev` (cria o arquivo `.env.local` com `OLHOVIVO_TOKEN=...`; ele já é ignorado pelo Git).

## Créditos e licenças
- Leaflet — biblioteca de mapas de código aberto.
- Mapa: © OpenStreetMap contributors, © CARTO (atribuição exibida no mapa).
- Dados de ônibus: API Olho Vivo, SPTrans.
