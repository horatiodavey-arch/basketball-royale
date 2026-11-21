// Imports basketball courts in South Florida (Broward, Miami-Dade, Palm Beach)
// from OpenStreetMap's Overpass API into parks + courts, so the map has courts
// on day one. Safe to run again: every OSM court is remembered by its osm id
// (parks.osm_id and parks.osm_members), so a second run updates instead of
// duplicating. Hidden courts stay hidden, and the two preset parks always win.
const { db, lastId } = require('./index');

// Broward, Miami-Dade and Palm Beach counties (south, west, north, east).
const BBOX = '25.13,-80.88,26.98,-80.03';
// The main Overpass server first, then public mirrors if it fails.
const OVERPASS_URLS = [
  ...(process.env.OVERPASS_URL ? [process.env.OVERPASS_URL] : []),
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const USER_AGENT = 'BasketballRoyale-court-import/1.1 (+https://github.com/horatiodavey-arch/basketball-royale)';
// The courts file committed to the repo: the server seeds from it, no network needed.
const COURTS_FILE = require('path').join(__dirname, '..', 'data', 'courts-south-florida.json');
const MERGE_METERS = 100; // courts this close become one location
const PRESET_METERS = 150; // an OSM location this close to a preset is the preset
const PARK_NEAR_METERS = 100; // ...or this close to a park a player added
const MAX_COURT_ROWS = 6; // court rows created per location (the count is stored in full)

// Which places to download. The default is the three South Florida counties
// (a bounding box); a named county or state uses its OpenStreetMap boundary.
const DEFAULT_AREA = { label: 'Broward, Miami-Dade and Palm Beach counties, FL', setup: '', scope: `(${BBOX})` };

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

function stateCode(text) {
  const t = String(text || '').trim();
  if (STATES[t.toUpperCase()]) return t.toUpperCase();
  return Object.keys(STATES).find((k) => STATES[k].toLowerCase() === t.toLowerCase()) || null;
}

// "Orange County, FL", "Orange County, Florida", "FL" or "Florida".
function parseArea(text) {
  const parts = String(text || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length === 1 && stateCode(parts[0])) {
    const code = stateCode(parts[0]);
    return {
      label: STATES[code],
      setup: `area["ISO3166-2"="US-${code}"]["admin_level"="4"]->.a;`,
      scope: '(area.a)',
    };
  }
  if (parts.length === 2 && stateCode(parts[1])) {
    const code = stateCode(parts[1]);
    const county = parts[0].replace(/"/g, '');
    return {
      label: `${county}, ${code}`,
      setup:
        `area["ISO3166-2"="US-${code}"]["admin_level"="4"]->.st;` +
        `rel(area.st)["boundary"="administrative"]["admin_level"="6"]["name"="${county}"];map_to_area->.a;`,
      scope: '(area.a)',
    };
  }
  throw new Error(`Couldn't read "${text}". Use a county and state like "Orange County, FL", or a state like "FL" or "Florida".`);
}

const courtFilter = (area) => `
  nwr["leisure"="pitch"]["sport"~"(^|;)basketball(;|$)"]${area.scope};
  nwr["leisure"="sports_centre"]["sport"~"(^|;)basketball(;|$)"]${area.scope};`;

const courtsQuery = (area) => `[out:json][timeout:600];${area.setup}(${courtFilter(area)});out tags center;`;

// Schools, parks and buildings that touch a court. Classified by their tags.
const contextQuery = (area) => `[out:json][timeout:600];${area.setup}(${courtFilter(area)})->.c;
(
  wr["amenity"~"^(school|college|university)$"](around.c:0);
  wr["leisure"="park"](around.c:0);
  way["building"](around.c:0);
);
out tags geom;`;
const COURTS_QUERY = courtsQuery(DEFAULT_AREA);
const CONTEXT_QUERY = contextQuery(DEFAULT_AREA);

const SCHOOL_WORDS = /\b(school|elementary|middle|high|academy|prep|college|university)\b/i;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function overpass(query) {
  const errors = [];
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': USER_AGENT,
          accept: 'application/json',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(660 * 1000),
      });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const json = await res.json();
      // Overpass can answer 200 with a "remark" and no data when the query
      // runs out of time or memory. That's a failure, not an empty answer.
      if (json.remark && /error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark.trim());
      return json.elements || [];
    } catch (err) {
      errors.push(`${new URL(url).host}: ${err.message}`);
    }
  }
  throw new Error('Every Overpass server failed (' + errors.join('; ') + ')');
}

// Both queries, a short pause apart (Overpass asks clients not to hammer it).
async function fetchFromOverpass(area = DEFAULT_AREA) {
  const courts = await overpass(courtsQuery(area));
  await new Promise((r) => setTimeout(r, 2000));
  const context = courts.length ? await overpass(contextQuery(area)) : [];
  return { courts, context };
}

// --- Geometry: polygons as rings of [lat, lng]; point-in-polygon by ray casting.
function ringsOf(el) {
  if (el.type === 'way' && Array.isArray(el.geometry)) return [el.geometry.map((p) => [p.lat, p.lon])];
  if (el.type === 'relation' && Array.isArray(el.members)) {
    return el.members
      .filter((m) => (m.role === 'outer' || m.role === '') && Array.isArray(m.geometry) && m.geometry.length > 2)
      .map((m) => m.geometry.map((p) => [p.lat, p.lon]));
  }
  return [];
}

function inRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const insideAny = (lat, lng, polys) => polys.find((p) => p.rings.some((r) => inRing(lat, lng, r))) || null;

// --- Turn raw OSM elements into locations.
function buildLocations({ courts, context }) {
  const polys = (pred) =>
    context.filter((el) => pred(el.tags || {})).map((el) => ({ tags: el.tags || {}, rings: ringsOf(el) }));
  const schools = polys((t) => /^(school|college|university)$/.test(t.amenity || ''));
  const parks = polys((t) => t.leisure === 'park');
  const buildings = polys((t) => t.building && t.building !== 'roof');

  const stats = { found: 0, schools: 0, noLocation: 0 };
  const points = [];
  for (const el of courts) {
    const lat = el.lat != null ? el.lat : el.center && el.center.lat;
    const lng = el.lon != null ? el.lon : el.center && el.center.lon;
    if (lat == null || lng == null) {
      stats.noLocation++;
      continue;
    }
    stats.found++;
    const tags = el.tags || {};
    const park = insideAny(lat, lng, parks);
    const parkName = park && park.tags.name ? park.tags.name : null;
    const school =
      !!insideAny(lat, lng, schools) || SCHOOL_WORDS.test(tags.name || '') || SCHOOL_WORDS.test(parkName || '');
    if (school) {
      stats.schools++;
      continue;
    }
    const indoor =
      tags.indoor === 'yes' ||
      tags.leisure === 'sports_centre' ||
      (!!tags.building && tags.building !== 'roof') ||
      !!insideAny(lat, lng, buildings);
    points.push({ key: `${el.type}/${el.id}`, lat, lng, tags, parkName, indoor });
  }

  // Greedy merge: a court joins the first location whose centre is within 100 m.
  const locations = [];
  for (const p of points) {
    const near = locations.find((l) => haversineMeters(l.lat, l.lng, p.lat, p.lng) <= MERGE_METERS);
    if (near) {
      near.members.push(p);
      near.lat = near.members.reduce((s, m) => s + m.lat, 0) / near.members.length;
      near.lng = near.members.reduce((s, m) => s + m.lng, 0) / near.members.length;
    } else {
      locations.push({ lat: p.lat, lng: p.lng, members: [p] });
    }
  }

  for (const loc of locations) {
    const counts = new Map();
    for (const m of loc.members) if (m.parkName) counts.set(m.parkName, (counts.get(m.parkName) || 0) + 1);
    const parkName = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const ownName = loc.members.map((m) => m.tags.name).find(Boolean);
    loc.indoor = loc.members.every((m) => m.indoor);
    loc.name = (parkName && parkName[0]) || ownName || (loc.indoor ? 'Indoor basketball court' : 'Basketball court');
    loc.city = loc.members.map((m) => m.tags['addr:city']).find(Boolean) || null;
    const street = loc.members.map((m) => m.tags).find((t) => t['addr:street']);
    loc.address = street
      ? [[street['addr:housenumber'], street['addr:street']].filter(Boolean).join(' '), street['addr:city']].filter(Boolean).join(', ')
      : null;
    loc.keys = loc.members.map((m) => m.key).sort();
    loc.courtCount = loc.members.length;
  }
  stats.locations = locations.length;
  stats.indoor = locations.filter((l) => l.indoor).length;
  return { locations, stats };
}

const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// --- Save locations. Returns what happened, for the summary.
function saveLocations(locations, { dryRun = false } = {}) {
  const existing = db
    .prepare('SELECT id, name, lat, lng, source, osm_id, osm_members FROM parks')
    .all();
  const presets = existing.filter((p) => p.source === 'preset');
  const playerParks = existing.filter((p) => p.source === 'player');
  const parkByOsmKey = new Map();
  for (const p of existing) {
    for (const k of [p.osm_id, ...String(p.osm_members || '').split(',')]) if (k) parkByOsmKey.set(k, p);
  }
  // "Sunrise Athletic Complex (SAC)" -> "sunrise athletic complex"
  const presetNames = presets.map((p) => normalize(p.name.replace(/\(.*?\)/g, '')));

  const result = { created: 0, updated: 0, skippedPreset: 0, skippedNearPlayerPark: 0, samples: [] };
  const insertPark = db.prepare(
    `INSERT INTO parks (name, location, city, lat, lng, source, osm_id, osm_members, is_indoor, hidden, court_count)
     VALUES (?, ?, ?, ?, ?, 'osm', ?, ?, ?, 0, ?)`
  );
  const insertCourt = db.prepare('INSERT OR IGNORE INTO courts (park_id, number, nickname) VALUES (?, ?, ?)');
  const addCourts = (parkId, count) => {
    const rows = Math.min(Math.max(count, 1), MAX_COURT_ROWS);
    for (let n = 1; n <= rows; n++) insertCourt.run(parkId, n, rows === 1 ? 'Main' : `Court ${n}`);
  };

  const run = () => {
    for (const loc of locations) {
      const isPreset =
        presets.some((p) => p.lat != null && haversineMeters(p.lat, p.lng, loc.lat, loc.lng) <= PRESET_METERS) ||
        presetNames.some((n) => n && normalize(loc.name).includes(n));
      if (isPreset) {
        result.skippedPreset++;
        continue;
      }
      const known = loc.keys.map((k) => parkByOsmKey.get(k)).find(Boolean);
      if (known) {
        const keys = new Set([...String(known.osm_members || '').split(','), ...loc.keys].filter(Boolean));
        if (!dryRun) {
          db.prepare(
            `UPDATE parks SET source = 'osm', osm_members = ?, is_indoor = ?, court_count = ?,
               osm_id = COALESCE(osm_id, ?) WHERE id = ?`
          ).run([...keys].sort().join(','), loc.indoor ? 1 : 0, loc.courtCount, loc.keys[0], known.id);
          addCourts(known.id, loc.courtCount);
        }
        result.updated++;
        continue;
      }
      if (playerParks.some((p) => p.lat != null && haversineMeters(p.lat, p.lng, loc.lat, loc.lng) <= PARK_NEAR_METERS)) {
        result.skippedNearPlayerPark++;
        continue;
      }
      if (!dryRun) {
        insertPark.run(loc.name, loc.address, loc.city, loc.lat, loc.lng, loc.keys[0], loc.keys.join(','), loc.indoor ? 1 : 0, loc.courtCount);
        addCourts(lastId(), loc.courtCount);
      }
      result.created++;
      if (result.samples.length < 10) {
        result.samples.push({ name: loc.name, city: loc.city, indoor: loc.indoor, courts: loc.courtCount, lat: +loc.lat.toFixed(5), lng: +loc.lng.toFixed(5) });
      }
    }
  };
  if (dryRun) {
    run();
  } else {
    db.exec('BEGIN');
    try {
      run();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return result;
}

async function importCourts({ data = null, dryRun = false, saveTo = null } = {}) {
  const raw = data || (await fetchFromOverpass());
  if (saveTo) require('fs').writeFileSync(saveTo, JSON.stringify(raw));
  const { locations, stats } = buildLocations(raw);
  const saved = saveLocations(locations, { dryRun });
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS locations, COALESCE(SUM(court_count), 0) AS courts,
              SUM(is_indoor) AS indoor, SUM(hidden) AS hidden
       FROM parks WHERE source = 'osm'`
    )
    .get();
  return { stats, saved, totals };
}

const fileLocation = (l, areaLabel) => ({
  name: l.name,
  city: l.city,
  address: l.address,
  lat: Number(l.lat.toFixed(6)),
  lng: Number(l.lng.toFixed(6)),
  indoor: !!l.indoor,
  courtCount: l.courtCount,
  osmIds: l.keys,
  area: areaLabel,
});

const FILE_RULES =
  'Basketball pitches and sports centres; schools left out; courts within 100 m merged; indoor = indoor=yes, inside a building, or a sports centre.';

// What goes in data/courts-south-florida.json: the merged locations, ready to save.
function toCourtsFile(locations, stats, area = DEFAULT_AREA) {
  return mergeIntoCourtsFile(null, locations, stats, area).file;
}

// Adds one area's locations to the courts file (or starts one). Downloading
// an area again replaces that area's locations, so fixes in OpenStreetMap come
// through. A court already in the file under another area is never added twice.
function mergeIntoCourtsFile(existing, locations, stats, area = DEFAULT_AREA) {
  const old = (existing && existing.locations) || [];
  // Files from before areas were tracked hold only the South Florida default.
  const areaOf = (l) => l.area || DEFAULT_AREA.label;
  const kept = old.filter((l) => areaOf(l) !== area.label).map((l) => ({ ...l, area: areaOf(l) }));
  const taken = new Set(kept.flatMap((l) => l.osmIds || []));
  let duplicates = 0;
  const added = [];
  for (const l of locations) {
    if (l.keys.some((k) => taken.has(k))) {
      duplicates++;
      continue;
    }
    l.keys.forEach((k) => taken.add(k));
    added.push(fileLocation(l, area.label));
  }
  const areas = { ...((existing && existing.areas) || {}) };
  if (existing && !existing.areas && old.length) {
    areas[DEFAULT_AREA.label] = { generatedAt: existing.generatedAt, stats: existing.stats };
  }
  areas[area.label] = { generatedAt: new Date().toISOString(), stats: { ...stats, locations: added.length, duplicatesSkipped: duplicates } };
  const all = [...kept, ...added];
  return {
    file: {
      generatedAt: new Date().toISOString(),
      source: 'OpenStreetMap contributors, via the Overpass API (ODbL)',
      area: Object.keys(areas).join('; '),
      rules: FILE_RULES,
      areas,
      stats: { locations: all.length, courts: all.reduce((a, l) => a + (l.courtCount || 1), 0), indoor: all.filter((l) => l.indoor).length },
      locations: all,
    },
    added: added.length,
    replaced: old.length - kept.length,
    duplicates,
  };
}

function locationsFromFile(file) {
  return (file.locations || []).map((l) => ({
    name: l.name,
    city: l.city || null,
    address: l.address || null,
    lat: l.lat,
    lng: l.lng,
    indoor: !!l.indoor,
    courtCount: l.courtCount || 1,
    keys: [...(l.osmIds || [])].sort(),
  }));
}

// On start: save any location in the committed file whose OpenStreetMap ids
// aren't in the database yet. No network. Courts already saved are left as
// they are (names, hidden), so nothing is duplicated or undone. Returns null
// when there's nothing new.
function seedFromFile(filePath = COURTS_FILE) {
  const fs = require('fs');
  if (!fs.existsSync(filePath)) return null;
  const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const known = new Set();
  for (const p of db.prepare('SELECT osm_id, osm_members FROM parks').all()) {
    for (const k of [p.osm_id, ...String(p.osm_members || '').split(',')]) if (k) known.add(k);
  }
  const fresh = locationsFromFile(file).filter((l) => !l.keys.some((k) => known.has(k)));
  if (fresh.length === 0) return null;
  const saved = saveLocations(fresh);
  if (saved.created === 0) return null;
  const totals = db
    .prepare("SELECT COUNT(*) AS locations, COALESCE(SUM(court_count), 0) AS courts, SUM(is_indoor) AS indoor FROM parks WHERE source = 'osm'")
    .get();
  return { saved, totals, generatedAt: file.generatedAt };
}

module.exports = { importCourts, toCourtsFile, mergeIntoCourtsFile, parseArea, DEFAULT_AREA, locationsFromFile, seedFromFile, fetchFromOverpass, COURTS_FILE, buildLocations, saveLocations, COURTS_QUERY, CONTEXT_QUERY, SCHOOL_WORDS };
