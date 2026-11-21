#!/usr/bin/env node
// Downloads basketball courts from OpenStreetMap (Overpass API, with mirror
// fallback) and adds them to data/courts-south-florida.json, which the server
// loads on start.
//
//   npm run fetch-courts                                   South Florida (Broward, Miami-Dade, Palm Beach)
//   npm run fetch-courts -- "Orange County, FL"            one county
//   npm run fetch-courts -- "Orange County, FL" "Duval County, FL"
//   npm run fetch-courts -- FL                             a whole state ("Florida" works too)
//
// Each area is added to the file. Courts already in the file are never added
// twice, and downloading an area again replaces that area's courts with the
// fresh ones. It only writes the file; it doesn't touch the database.
const fs = require('fs');
const path = require('path');

(async () => {
  const { fetchFromOverpass, buildLocations, mergeIntoCourtsFile, parseArea, DEFAULT_AREA, COURTS_FILE } =
    require('../db/courts-import');
  const args = process.argv.slice(2).filter((a) => a.trim());
  // Read every name first, so a typo stops the run before any downloading.
  const areas = args.length ? args.map(parseArea) : [DEFAULT_AREA];

  let file = fs.existsSync(COURTS_FILE) ? JSON.parse(fs.readFileSync(COURTS_FILE, 'utf8')) : null;
  let failed = 0;
  for (const area of areas) {
    console.log(`\n${area.label}: asking Overpass for basketball courts...`);
    try {
      const raw = await fetchFromOverpass(area);
      console.log(`  Courts: ${raw.courts.length}. Schools, parks and buildings around them: ${raw.context.length}.`);
      if (raw.courts.length === 0) {
        throw new Error('No courts found. Check the spelling, e.g. "Orange County, FL" (OpenStreetMap uses the full county name).');
      }
      // Without the second answer no school can be left out and no court gets
      // its park's name. Never write a file like that.
      if (raw.context.length === 0) {
        throw new Error('Overpass sent no schools, parks or buildings around the courts. Nothing was written for this area; run it again in a few minutes.');
      }
      const { locations, stats } = buildLocations(raw);
      const merged = mergeIntoCourtsFile(file, locations, stats, area);
      file = merged.file;
      // Save after each area, so one failure doesn't lose the others.
      fs.mkdirSync(path.dirname(COURTS_FILE), { recursive: true });
      fs.writeFileSync(COURTS_FILE, JSON.stringify(file, null, 1) + '\n');
      console.log(`  Schools left out: ${stats.schools}. Locations after merging nearby courts: ${stats.locations} (${stats.indoor} indoor).`);
      console.log(`  Added: ${merged.added}. Replaced from an earlier download of this area: ${merged.replaced}. Already in the file (skipped): ${merged.duplicates}.`);
      const added = file.locations.filter((l) => l.area === area.label);
      for (const l of added.filter((l) => l.name !== 'Basketball court').slice(0, 5)) {
        console.log(`    ${l.name}${l.city ? ' · ' + l.city : ''}: ${l.courtCount} court${l.courtCount === 1 ? '' : 's'}, ${l.indoor ? 'indoor' : 'outdoor'}`);
      }
    } catch (err) {
      failed++;
      console.error(`  Failed: ${err.message}`);
    }
    if (areas.length > 1) await new Promise((r) => setTimeout(r, 5000));
  }
  if (file) {
    console.log(`\n${path.relative(process.cwd(), COURTS_FILE)}: ${file.stats.locations} locations, ${file.stats.courts} courts, ${file.stats.indoor} indoor.`);
    console.log(`Areas in the file: ${Object.keys(file.areas || {}).join('; ')}`);
  }
  if (failed) process.exit(1);
})().catch((err) => {
  console.error('Fetch failed:', err.message);
  process.exit(1);
});
