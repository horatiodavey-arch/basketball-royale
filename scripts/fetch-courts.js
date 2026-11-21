#!/usr/bin/env node
// Fetches South Florida basketball courts from OpenStreetMap (Overpass API,
// with mirror fallback) and writes data/courts-south-florida.json, which the
// server seeds from on start. Run it again any time to refresh the file:
//
//   npm run fetch-courts
//
// It only writes the file; it doesn't touch the database.
const fs = require('fs');
const path = require('path');

(async () => {
  const { fetchFromOverpass, buildLocations, toCourtsFile, COURTS_FILE } = require('../db/courts-import');
  console.log('Asking Overpass for basketball courts in Broward, Miami-Dade and Palm Beach...');
  const raw = await fetchFromOverpass();
  const { locations, stats } = buildLocations(raw);
  const file = toCourtsFile(locations, stats);
  fs.mkdirSync(path.dirname(COURTS_FILE), { recursive: true });
  fs.writeFileSync(COURTS_FILE, JSON.stringify(file, null, 1) + '\n');
  console.log(`OSM courts found: ${stats.found}, schools left out: ${stats.schools}`);
  console.log(`Locations after merging: ${stats.locations} (${stats.indoor} indoor)`);
  console.log(`Wrote ${path.relative(process.cwd(), COURTS_FILE)}`);
  for (const l of file.locations.slice(0, 8)) {
    console.log(`  ${l.name}${l.city ? ' · ' + l.city : ''}: ${l.courtCount} court${l.courtCount === 1 ? '' : 's'}, ${l.indoor ? 'indoor' : 'outdoor'}`);
  }
})().catch((err) => {
  console.error('Fetch failed:', err.message);
  process.exit(1);
});
