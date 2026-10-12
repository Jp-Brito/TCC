// Paradas de ônibus: carrega o stops.json e organiza as paradas numa grade,
// para achar rápido as que estão na área visível do mapa.
//
// Por que uma grade? O mapa muda a todo momento (arrastar, zoom). Em vez de
// olhar as ~22 mil paradas a cada movimento, agrupamos todas em quadradinhos
// de ~500 m. Para saber o que está na tela, só consultamos os quadradinhos
// que ela cobre.
(function () {
  "use strict";

  var CELULA = 0.005; // tamanho do quadradinho em graus (≈ 500 m)

  function chave(lat, lon) {
    return Math.floor(lat / CELULA) + ":" + Math.floor(lon / CELULA);
  }

  function IndiceParadas(dados) {
    this.total = dados.total;
    this.celulas = {};
    for (var i = 0; i < dados.ids.length; i++) {
      var parada = {
        id: dados.ids[i],
        nome: dados.nomes[i],
        referencia: dados.enderecos[i],
        lat: dados.lats[i],
        lon: dados.lons[i]
      };
      var k = chave(parada.lat, parada.lon);
      (this.celulas[k] = this.celulas[k] || []).push(parada);
    }
  }

  // Paradas dentro de um retângulo (sul, oeste, norte, leste).
  IndiceParadas.prototype.emRetangulo = function (sul, oeste, norte, leste) {
    var resultado = [];
    var y0 = Math.floor(sul / CELULA), y1 = Math.floor(norte / CELULA);
    var x0 = Math.floor(oeste / CELULA), x1 = Math.floor(leste / CELULA);
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var grupo = this.celulas[y + ":" + x];
        if (!grupo) continue;
        for (var j = 0; j < grupo.length; j++) {
          var p = grupo[j];
          if (p.lat >= sul && p.lat <= norte && p.lon >= oeste && p.lon <= leste) {
            resultado.push(p);
          }
        }
      }
    }
    return resultado;
  };

  function carregar(url) {
    return fetch(url).then(function (resposta) {
      if (!resposta.ok) throw new Error("Não foi possível carregar " + url);
      return resposta.json();
    }).then(function (dados) {
      return new IndiceParadas(dados);
    });
  }

  window.Paradas = { carregar: carregar };
})();
