// The base map every Leaflet map in this app sits on: OpenFreeMap's free,
// no-key "Bright" vector style (coloured parks, water and roads), drawn by MapLibre GL and dropped into
// Leaflet by the maplibre-gl-leaflet bridge. Leaflet still owns markers,
// circles, clicks, and pan/zoom — this is only the streets underneath.
// Needs leaflet.js, maplibre-gl.js and leaflet-maplibre-gl.js loaded first.
var CREDIT_HTML =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>' +
  ' &middot; <a href="https://openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a>' +
  ' &middot; Map by <a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a>';

window.RoyaleMap = {
  // The map credit, always on the page: a small faded (i) in the bottom-left
  // corner. Tap it to show the full credit; tap again to hide it.
  addCredits: function (map) {
    var Credits = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd: function () {
        var box = L.DomUtil.create('div', 'map-credit');
        var btn = L.DomUtil.create('button', 'map-credit-btn', box);
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Map credits');
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = 'i';
        var text = L.DomUtil.create('div', 'map-credit-text', box);
        text.innerHTML = CREDIT_HTML;
        text.hidden = true;
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.on(btn, 'click', function () {
          text.hidden = !text.hidden;
          btn.setAttribute('aria-expanded', text.hidden ? 'false' : 'true');
          box.classList.toggle('is-open', !text.hidden);
        });
        return box;
      },
    });
    return new Credits().addTo(map);
  },
  addBaseLayer: function (map) {
    return L.maplibreGL({
      style: 'https://tiles.openfreemap.org/styles/bright',
      attributionControl: false,
    }).addTo(map);
  },
};
