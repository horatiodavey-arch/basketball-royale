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

const COURT_FILTER = `
  nwr["leisure"="pitch"]["sport"~"(^|;)basketball(;|$)"](${BBOX});
  nwr["leisure"="sports_centre"]["sport"~"(^|;)basketball(;|$)"](${BBOX});`;

const COURTS_QUERY = `[out:json][timeout:180];(${COURT_FILTER});out tags center;`;

// Schools, parks and buildings that touch a court. Classified by their tags.
const CONTEXT_QUERY = `[out:json][timeout:180];(${COURT_FILTER})->.c;
(
  wr["amenity"~"^(school|college|university)$"](around.c:0);
  wr["leisure"="park"](around.c:0);
  way["building"](around.c:0);
);
out tags geom;`;

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
        signal: AbortSignal.timeout(240 * 1000),
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
async function fetchFromOverpass() {
  const courts = await overpass(COURTS_QUERY);
  await new Promise((r) => setTimeout(r, 2000));
  const context = await overpass(CONTEXT_QUERY);
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

// What goes in data/courts-south-florida.json: the merged locations, ready to save.
function toCourtsFile(locations, stats) {
  return {
    generatedAt: new Date().toISOString(),
    source: 'OpenStreetMap contributors, via the Overpass API (ODbL)',
    area: 'Broward, Miami-Dade and Palm Beach counties, Florida (bbox ' + BBOX + ')',
    rules: 'Basketball pitches and sports centres; schools left out; courts within 100 m merged; indoor = indoor=yes, inside a building, or a sports centre.',
    stats,
    locations: locations.map((l) => ({
      name: l.name,
      city: l.city,
      address: l.address,
      lat: Number(l.lat.toFixed(6)),
      lng: Number(l.lng.toFixed(6)),
      indoor: !!l.indoor,
      courtCount: l.courtCount,
      osmIds: l.keys,
    })),
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

// On start: if there are no OpenStreetMap courts yet, save them from the
// committed file. No network. Returns null when there's nothing to do.
function seedFromFile(filePath = COURTS_FILE) {
  const fs = require('fs');
  const existing = db.prepare("SELECT COUNT(*) AS n FROM parks WHERE source = 'osm'").get().n;
  if (existing > 0 || !fs.existsSync(filePath)) return null;
  const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const saved = saveLocations(locationsFromFile(file));
  const totals = db
    .prepare("SELECT COUNT(*) AS locations, COALESCE(SUM(court_count), 0) AS courts, SUM(is_indoor) AS indoor FROM parks WHERE source = 'osm'")
    .get();
  return { saved, totals, generatedAt: file.generatedAt };
}

module.exports = { importCourts, toCourtsFile, locationsFromFile, seedFromFile, fetchFromOverpass, COURTS_FILE, buildLocations, saveLocations, COURTS_QUERY, CONTEXT_QUERY, SCHOOL_WORDS };
