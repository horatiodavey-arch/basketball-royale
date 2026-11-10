// Address <-> coordinates via OpenStreetMap's free Nominatim geocoder.
// Their usage policy (https://operations.osmfoundation.org/policies/nominatim/)
// asks for three things, all handled here: a User-Agent that identifies
// the app, no more than one request a second, and caching of results.
const { db } = require('./index');

const NOMINATIM_URL = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const USER_AGENT =
  process.env.GEOCODER_USER_AGENT ||
  'BasketballRoyale/1.0 (+https://github.com/horatiodavey-arch/basketball-royale)';
const MIN_INTERVAL_MS = 1100;
const REQUEST_TIMEOUT_MS = 10000;
const NOT_FOUND_CACHE_DAYS = 7;

let queue = Promise.resolve();
let lastRequestAt = 0;

// One request at a time, each at least MIN_INTERVAL_MS after the last.
function throttled(fn) {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await fn();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  queue = run.catch(() => {});
  return run;
}

// Parsed JSON, or undefined when Nominatim couldn't be asked at all
// (offline, blocked, timed out, rate-limited) — which callers must not
// confuse with "asked, and there's nothing at that address".
async function nominatim(path, params) {
  const query = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', ...params });
  try {
    const res = await throttled(() =>
      fetch(`${NOMINATIM_URL}${path}?${query}`, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    );
    if (!res.ok) return undefined;
    return await res.json();
  } catch (err) {
    return undefined;
  }
}

function cityOf(address) {
  if (!address) return null;
  return address.city || address.town || address.village || address.municipality || address.hamlet || null;
}

function cacheKey(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Serves `key` from geocode_cache, or runs `ask` and remembers its answer.
// `ask` resolves to a result object, null (nothing there), or undefined
// (couldn't ask — not cached, so the next call tries again).
async function cachedLookup(key, ask) {
  const cached = db.prepare('SELECT * FROM geocode_cache WHERE query = ?').get(key);
  if (cached && cached.found) {
    return { ok: true, lat: cached.lat, lng: cached.lng, city: cached.city };
  }
  const notFoundIsFresh =
    cached && Date.now() - new Date(cached.fetched_at + 'Z').getTime() < NOT_FOUND_CACHE_DAYS * 86400000;
  if (notFoundIsFresh) return { ok: false, reason: 'not_found' };

  const result = await ask();
  if (result === undefined) return { ok: false, reason: 'unavailable' };

  db.prepare(
    `INSERT INTO geocode_cache (query, lat, lng, city, found, fetched_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(query) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, city = excluded.city,
       found = excluded.found, fetched_at = excluded.fetched_at`
  ).run(key, result ? result.lat : null, result ? result.lng : null, result ? result.city : null, result ? 1 : 0);

  return result ? { ok: true, ...result } : { ok: false, reason: 'not_found' };
}

// { ok: true, lat, lng, city } or { ok: false, reason: 'not_found' | 'unavailable' }.
function geocodeAddress(address) {
  const key = cacheKey(address);
  if (!key) return Promise.resolve({ ok: false, reason: 'not_found' });

  return cachedLookup(key, async () => {
    const rows = await nominatim('/search', { q: String(address).trim(), limit: '1' });
    if (rows === undefined) return undefined;
    const hit = Array.isArray(rows) ? rows[0] : null;
    const lat = hit ? Number(hit.lat) : NaN;
    const lng = hit ? Number(hit.lon) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, city: cityOf(hit.address) };
  });
}

// Which city a point is in. Rounded to ~100m for the cache key, which is
// far finer than a city boundary and keeps nearby courts on one lookup.
function reverseGeocodeCity(lat, lng) {
  return cachedLookup(`rev:${lat.toFixed(3)},${lng.toFixed(3)}`, async () => {
    const body = await nominatim('/reverse', { lat: String(lat), lon: String(lng), zoom: '10' });
    if (body === undefined) return undefined;
    const city = cityOf(body && body.address);
    return city ? { lat, lng, city } : null;
  });
}

let fillInFlight = null;

// Gives every park that can have them a pin and a city: a park with an
// address but no coordinates is geocoded (its address first, then its
// name plus the "City, ST ZIP" tail of that address), and a park with
// coordinates but no city gets one from a reverse lookup. Never moves a
// pin that's already set. Resolves to { unavailable } — true when
// Nominatim couldn't be reached, so the caller knows to try again later.
function fillMissingParkLocations() {
  if (fillInFlight) return fillInFlight;

  fillInFlight = (async () => {
    let unavailable = false;

    const needPin = db
      .prepare(
        `SELECT id, name, location FROM parks
         WHERE (lat IS NULL OR lng IS NULL) AND location IS NOT NULL AND TRIM(location) != ''`
      )
      .all();
    for (const park of needPin) {
      let result = await geocodeAddress(park.location);
      if (!result.ok && result.reason === 'not_found') {
        const plainName = park.name.replace(/\s*\([^)]*\)/g, '').trim();
        const cityAndState = park.location.split(',').slice(1).join(',').trim();
        result = await geocodeAddress([plainName, cityAndState].filter(Boolean).join(', '));
      }
      if (result.ok) {
        db.prepare(
          'UPDATE parks SET lat = ?, lng = ?, city = COALESCE(city, ?) WHERE id = ? AND (lat IS NULL OR lng IS NULL)'
        ).run(result.lat, result.lng, result.city, park.id);
      } else if (result.reason === 'unavailable') {
        unavailable = true;
      }
    }

    const needCity = db.prepare('SELECT id, lat, lng FROM parks WHERE city IS NULL AND lat IS NOT NULL AND lng IS NOT NULL').all();
    for (const park of needCity) {
      const result = await reverseGeocodeCity(park.lat, park.lng);
      if (result.ok) {
        db.prepare('UPDATE parks SET city = ? WHERE id = ? AND city IS NULL').run(result.city, park.id);
      } else if (result.reason === 'unavailable') {
        unavailable = true;
      }
    }

    return { unavailable };
  })().finally(() => {
    fillInFlight = null;
  });

  return fillInFlight;
}

const RETRY_MINUTES = 5;
const MAX_ATTEMPTS = 6;

// Kicked off once the server is listening — never blocks boot. If
// Nominatim can't be reached it tries again a few times, then gives up
// until the next restart (an organizer can still place the pin by hand).
function startBackgroundGeocoding() {
  let attempts = 0;
  const run = async () => {
    attempts += 1;
    const { unavailable } = await fillMissingParkLocations().catch(() => ({ unavailable: true }));
    if (unavailable && attempts < MAX_ATTEMPTS) {
      setTimeout(run, RETRY_MINUTES * 60 * 1000).unref();
    }
  };
  run();
}

module.exports = {
  geocodeAddress,
  reverseGeocodeCity,
  fillMissingParkLocations,
  startBackgroundGeocoding,
  USER_AGENT,
};
