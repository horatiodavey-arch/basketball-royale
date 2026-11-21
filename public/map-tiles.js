// The base map every Leaflet map in this app sits on: OpenFreeMap's free,
// no-key "Bright" vector style, restyled here to BR's look (see
// mockups/br-map-mockup.html): a light, clean base with bright green parks,
// light blue water and plain gray roads; no road numbers or shields, no
// neighborhood names, small street labels, airport or POI icons. City names
// and major road names stay. Drawn by MapLibre GL and dropped into Leaflet by
// the maplibre-gl-leaflet bridge. Leaflet still owns markers, circles, clicks,
// and pan/zoom; this is only the streets underneath.
// Needs leaflet.js, maplibre-gl.js and leaflet-maplibre-gl.js loaded first.
(function () {
  var CREDIT_HTML =
    '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>' +
    ' &middot; <a href="https://openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a>' +
    ' &middot; Map by <a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a>';

  // window.ROYALE_STYLE_URL lets a local test point at a stand-in style.
  var STYLE_URL = window.ROYALE_STYLE_URL || 'https://tiles.openfreemap.org/styles/bright';
  var COLORS = {
    background: '#F4F3EE',
    park: '#A8DB82',
    water: '#8CC8EE',
    building: '#E9E7E0',
    roadMajor: '#9A9993',
    roadMinor: '#C9C7BF',
    roadCasing: '#E2E0D9',
    label: '#5F5E5A',
    labelHalo: '#F4F3EE',
  };
  // Symbol layers that are hidden: road numbers and shields, POI and airport
  // icons, neighborhood/suburb/hamlet names, small street and path names.
  var HIDE = /shield|poi|airport|aerodrome|aeroway|housenumber|mountain|road_oneway|oneway|highway-name-path|highway-name-minor|place-other|place-suburb|place-neighbou?rhood|place-hamlet|place-quarter|railway|water-name|waterway-name|landuse-.*label/i;
  var HIDE_SOURCE_LAYERS = { poi: 1, aerodrome_label: 1, housenumber: 1, mountain_peak: 1 };
  var MAJOR = /motorway|trunk|primary/i;

  function set(layer, group, key, value) {
    layer[group] = layer[group] || {};
    layer[group][key] = value;
  }

  // Returns a copy of the Bright style with BR's colors and labels.
  function restyle(style) {
    var s = JSON.parse(JSON.stringify(style));
    s.layers = (s.layers || []).filter(function (layer) {
      var id = layer.id || '';
      var src = layer['source-layer'] || '';
      if (layer.type === 'symbol' && (HIDE.test(id) || HIDE_SOURCE_LAYERS[src])) return false;
      // Place names: cities and towns only (no neighborhoods, suburbs, hamlets).
      if (layer.type === 'symbol' && src === 'place' && !/city|town|village|state|country|continent/i.test(id)) return false;
      // Road names: major roads only.
      if (layer.type === 'symbol' && src === 'transportation_name' && !MAJOR.test(id) && !/major/i.test(id)) return false;
      // The busy residential/commercial/industrial tints go; the base stays clean.
      if (layer.type === 'fill' && (src === 'landuse' || /^landuse-/.test(id)) && !/park|grass|pitch|playground|recreation/i.test(id)) return false;
      if (/pattern/i.test(id)) return false;
      return true;
    });
    s.layers.forEach(function (layer) {
      var id = layer.id || '';
      var src = layer['source-layer'] || '';
      if (layer.type === 'background') set(layer, 'paint', 'background-color', COLORS.background);
      if (layer.type === 'fill') {
        if (src === 'park' || /park|grass|wood|landcover-wood|pitch|playground|recreation/i.test(id)) {
          set(layer, 'paint', 'fill-color', COLORS.park);
          set(layer, 'paint', 'fill-opacity', 1);
          if (layer.paint) delete layer.paint['fill-pattern'];
        } else if (src === 'water' || /^water/.test(id)) {
          set(layer, 'paint', 'fill-color', COLORS.water);
          set(layer, 'paint', 'fill-opacity', 1);
          if (layer.paint) delete layer.paint['fill-pattern'];
        } else if (src === 'building' || /building/.test(id)) {
          set(layer, 'paint', 'fill-color', COLORS.building);
          if (layer.paint) delete layer.paint['fill-outline-color'];
        }
      }
      if (layer.type === 'line') {
        if (src === 'park' || /park-outline/.test(id)) set(layer, 'paint', 'line-color', COLORS.park);
        else if (src === 'waterway' || /waterway/.test(id)) set(layer, 'paint', 'line-color', COLORS.water);
        else if (src === 'transportation' || /highway|road|bridge|tunnel/.test(id)) {
          if (/casing/.test(id)) set(layer, 'paint', 'line-color', COLORS.roadCasing);
          else set(layer, 'paint', 'line-color', MAJOR.test(id) ? COLORS.roadMajor : COLORS.roadMinor);
          if (layer.paint) delete layer.paint['line-dasharray'];
        }
      }
      if (layer.type === 'symbol') {
        set(layer, 'paint', 'text-color', COLORS.label);
        set(layer, 'paint', 'text-halo-color', COLORS.labelHalo);
        set(layer, 'paint', 'text-halo-width', 1.5);
        if (layer.layout) delete layer.layout['icon-image'];
      }
    });
    return s;
  }

  // The style is fetched once per page and restyled. If that fails, the plain
  // Bright style still loads, so the map always shows.
  var stylePromise = null;
  function brStyle() {
    if (!stylePromise) {
      stylePromise = fetch(STYLE_URL)
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(restyle)
        .catch(function () { return STYLE_URL; });
    }
    return stylePromise;
  }

  // The hoop every court gets (same size as before): white backboard, rim and
  // net in orange for outdoor or blue for indoor, light blue pole.
  function hoopSvg(isIndoor) {
    var c = isIndoor ? '#378ADD' : '#E8662A';
    return '<svg class="hoop-icon" width="26" height="30" viewBox="0 0 26 30" aria-hidden="true">' +
      '<rect x="2" y="1" width="22" height="15" rx="2" fill="#FFFFFF" stroke="#D3D1C7" stroke-width="1"/>' +
      '<rect x="8" y="4" width="10" height="7" fill="none" stroke="' + c + '" stroke-width="1.6"/>' +
      '<rect x="7" y="16" width="12" height="2.5" rx="0.5" fill="' + c + '"/>' +
      '<rect x="11.5" y="18" width="3" height="11.5" rx="1" fill="#85B7EB"/>' +
      '</svg>';
  }

  // The King's crown, drawn above the hoop.
  function crownSvg() {
    return '<svg class="hoop-crown" width="20" height="12" viewBox="-10 -34 20 12" aria-hidden="true">' +
      '<path d="M-10 -32 L-10 -22 L10 -22 L10 -32 L5 -26 L0 -34 L-5 -26 Z" fill="#7F77DD" stroke="#534AB7" stroke-width="1"/></svg>';
  }

  window.RoyaleMap = {
    restyle: restyle,
    hoopSvg: hoopSvg,
    crownSvg: crownSvg,
    COLORS: COLORS,
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
      // Added straight away with the plain style so the map is never empty;
      // swapped to BR's style as soon as it's ready.
      var layer = L.maplibreGL({ style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': COLORS.background } }] }, attributionControl: false }).addTo(map);
      brStyle().then(function (style) {
        var gl = layer.getMaplibreMap && layer.getMaplibreMap();
        if (gl) gl.setStyle(style);
      });
      return layer;
    },
  };
})();
