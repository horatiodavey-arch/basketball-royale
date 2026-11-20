#!/usr/bin/env node
// Loads South Florida basketball courts from OpenStreetMap into the database.
//
//   npm run import-courts                      fetch from Overpass and save
//   npm run import-courts -- --dry-run         fetch and report, save nothing
//   npm run import-courts -- --file data.json  use a saved {courts, context} response
//   npm run import-courts -- --save data.json  also write the raw response to a file
//
// Uses the same database as the app (DATA_DIR), so on Railway run it in the
// service's shell. Running it again is safe: nothing is duplicated, hidden
// courts stay hidden, and the preset parks are never replaced.
const fs = require('fs');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
};

(async () => {
  const { importCourts } = require('../db/courts-import');
  const file = value('--file');
  const saveTo = value('--save');
  const data = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const dryRun = flag('--dry-run');
  console.log(dryRun ? 'Dry run: nothing will be saved.' : 'Importing courts...');
  const { stats, saved, totals } = await importCourts({ data, dryRun, saveTo });
  console.log(`OSM courts found:              ${stats.found}`);
  console.log(`  left out (schools):          ${stats.schools}`);
  console.log(`  merged into locations:       ${stats.locations} (${stats.indoor} indoor)`);
  console.log(`New locations saved:           ${saved.created}`);
  console.log(`Already imported (updated):    ${saved.updated}`);
  console.log(`Same place as a preset park:   ${saved.skippedPreset}`);
  console.log(`Same place as a player's park: ${saved.skippedNearPlayerPark}`);
  console.log(`Imported locations in the app: ${totals.locations} (${totals.courts} courts, ${totals.indoor || 0} indoor, ${totals.hidden || 0} hidden)`);
  if (saved.samples.length) {
    console.log('\nSample of new locations:');
    for (const s of saved.samples) {
      console.log(`  ${s.name}${s.city ? ' · ' + s.city : ''} — ${s.courts} court${s.courts === 1 ? '' : 's'}, ${s.indoor ? 'indoor' : 'outdoor'} (${s.lat}, ${s.lng})`);
    }
  }
})().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
