// Service worker mínimo: guarda a "casca" do app para abrir mais rápido.
// Nunca guarda chamadas à API (/api) nem os blocos do mapa.
// v2: guarda todos os scripts do app, para a tela "sem internet" aparecer mesmo offline.
const CACHE = "jotabus-casca-v5";   // trocar a versão força o celular a baixar a casca nova
const CASCA = [
  "./", "index.html", "css/styles.css", "js/config.js", "js/app.js",
  "js/paradas.js", "js/painel.js", "js/busca.js",
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CASCA)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;   // mapa e Leaflet: direto da rede
  if (url.pathname.startsWith("/api/")) return;      // dados em tempo real: sempre da rede

  // Rede primeiro; se falhar (sem internet), usa o que está guardado.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./")))
  );
});
