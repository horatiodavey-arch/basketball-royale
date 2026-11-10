// The base map every Leaflet map in this app sits on: OpenFreeMap's free,
// no-key "Positron" vector style, drawn by MapLibre GL and dropped into
// Leaflet by the maplibre-gl-leaflet bridge. Leaflet still owns markers,
// circles, clicks, and pan/zoom — this is only the streets underneath.
// Needs leaflet.js, maplibre-gl.js and leaflet-maplibre-gl.js loaded first.
window.RoyaleMap = {
  addBaseLayer: function (map) {
    return L.maplibreGL({
      style: 'https://tiles.openfreemap.org/styles/positron',
      attributionControl: { customAttribution: 'OpenFreeMap &copy; OpenMapTiles Data from OpenStreetMap' },
    }).addTo(map);
  },
};
