// Configurações centrais do projeto (nome provisório e mapa).
// Para trocar o nome, basta alterar aqui e no <title> do index.html.
window.APP_CONFIG = {
  nome: "Ônibus ao Vivo SP",
  sigla: "OVSP",
  painel: {
    atualizacaoMs: 12000,      // intervalo entre atualizações das previsões
    atualizacaoMaxMs: 60000    // espera máxima quando a API está falhando
  },
  paradas: {
    arquivo: "data/stops.json",
    zoomMinimo: 15,        // abaixo disso as paradas não são desenhadas
    maxMarcadores: 300     // teto de pontos na tela, para não pesar no celular
  },
  mapa: {
    centro: [-23.5505, -46.6333],   // centro da cidade de São Paulo (usado se a localização falhar)
    zoom: 12,
    zoomUsuario: 16,                // zoom ao centralizar na localização do usuário
    zoomMin: 10,
    zoomMax: 19,
    // Mapas da CARTO (raster, com chave de acesso). Estilos: https://carto.com/basemaps
    estilos: { dark: "dark_all", light: "voyager" },
    chave: "cb1_4hfn_1_03e0845c19ceef9c3dbef11d",
    urlTiles: function (tema) {
      var estilo = this.estilos[tema] || this.estilos.dark;
      return "https://basemaps.cartocdn.com/rastertiles/" + estilo +
             "/{z}/{x}/{y}.png?key=" + this.chave;
    },
    atribuicao:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
      '&copy; <a href="https://carto.com/attributions">CARTO</a>'
  }
};