const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'basketball_royale.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const isNewDb = !fs.existsSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

// The only parks this app ships with. `replaces` lists earlier preset
// parks whose courts, games, and everything else fold into this one on
// boot (see consolidatePresetParks). A preset with no lat/lng gets its
// pin from its address — db/geocode.js looks it up once the server is up.
// (Declared up here, above the boot calls below: a const isn't hoisted
// the way the functions that use it are.)
const PRESET_PARKS = [
  {
    name: 'Lauderdale Lakes Recreation',
    location: '4331 NW 36th St, Lauderdale Lakes, FL 33319',
    lat: 26.17172,
    lng: -80.20678,
    courts: [[1, 'Main'], [2, 'Side']],
    replaces: ['Lauderhill Parks & Recreation', 'Lauderdale Lakes Park'],
  },
  {
    name: 'Sunrise Athletic Complex (SAC)',
    location: '11501 NW 44th St, Sunrise, FL 33323',
    lat: null,
    lng: null,
    courts: [[1, null], [2, null], [3, null], [4, null]],
    replaces: ['Markham Park'],
  },
];

if (isNewDb) {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  seedDemoData();
}

// King of the Court's tables ship via CREATE TABLE IF NOT EXISTS so a
// database created before this feature existed still picks them up on
// its next boot, with no db:reset required. New COLUMNS on a table that
// already exists need an explicit ALTER, since CREATE TABLE IF NOT
// EXISTS is a no-op once the table is there.
ensureKingOfTheCourtTables();
migrateKingOfTheCourtColumns();
consolidatePresetParks();
backfillParkCities();
seedKingOfTheCourtDemoData();
applyOrganizerPhones();

function getMeta(key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare(
    'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// For a change that must happen once per database, ever — as opposed to
// the idempotent every-boot checks around it. Used where re-running would
// undo something an organizer has since changed by hand.
function runOnce(key, fn) {
  if (getMeta(key)) return;
  fn();
  setMeta(key, new Date().toISOString());
}

// Reused as the lobby's shared "roster" before teams are drafted.
// Joining a lobby = joining this forming game with team left unassigned.
function formingGameFor(lobbyId) {
  return db
    .prepare("SELECT id FROM games WHERE lobby_id = ? AND status = 'forming'")
    .get(lobbyId);
}

function lastId() {
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

function seedDemoData() {
  db.prepare(
    `INSERT INTO lobbies (name, location, starts_at, tier, stake_cents, join_code, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'Sunday run',
    'Home court',
    nextSunday10am(),
    'rookie',
    500,
    'SUN24',
    'open'
  );
  const lobbyId = lastId();

  db.prepare(`INSERT INTO games (lobby_id, status) VALUES (?, 'forming')`).run(lobbyId);
  const gameId = lastId();

  // A handful of already-locked-in players, matching the mockup's
  // "6 locked in · Darius, Chris + 4 more" social-proof roster.
  const demoPlayers = [
    ['Darius Reed', '5550000001'],
    ['Chris Lawal', '5550000002'],
    ['Marcus Bell', '5550000003'],
    ['Trey Osei', '5550000004'],
    ['Jamal Price', '5550000005'],
  ];

  const insertUser = db.prepare(
    'INSERT INTO users (name, phone) VALUES (?, ?)'
  );
  const insertPlayer = db.prepare(
    'INSERT INTO players (user_id, wins, losses, games_played) VALUES (?, ?, ?, ?)'
  );
  const insertRoster = db.prepare(
    "INSERT INTO game_players (game_id, player_id, team) VALUES (?, ?, 'unassigned')"
  );

  for (const [name, phone] of demoPlayers) {
    insertUser.run(name, phone);
    const userId = lastId();
    insertPlayer.run(userId, 0, 0, 0);
    const playerId = lastId();
    insertRoster.run(gameId, playerId);
  }
}

function nextSunday10am() {
  const d = new Date();
  const day = d.getDay();
  const daysUntilSunday = (7 - day) % 7 || 7;
  d.setDate(d.getDate() + daysUntilSunday);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

function ensureKingOfTheCourtTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS parks (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        name                   TEXT NOT NULL,
        location               TEXT,
        lat                    REAL,
        lng                    REAL,
        check_in_radius_meters INTEGER NOT NULL DEFAULT 250,
        leave_radius_meters    INTEGER NOT NULL DEFAULT 400,
        game_target            INTEGER NOT NULL DEFAULT 16,
        between_games_seconds  INTEGER NOT NULL DEFAULT 180
    );

    CREATE TABLE IF NOT EXISTS courts (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        park_id   INTEGER NOT NULL REFERENCES parks(id),
        number    INTEGER NOT NULL,
        nickname  TEXT,
        UNIQUE (park_id, number)
    );

    CREATE TABLE IF NOT EXISTS check_ins (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id   INTEGER NOT NULL REFERENCES players(id),
        park_id     INTEGER NOT NULL REFERENCES parks(id),
        time_in     TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
        last_inside TEXT
    );

    CREATE TABLE IF NOT EXISTS game_results (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id         INTEGER NOT NULL,
        player_id       INTEGER NOT NULL REFERENCES players(id),
        park_id         INTEGER NOT NULL REFERENCES parks(id),
        court_id        INTEGER NOT NULL REFERENCES courts(id),
        result          TEXT NOT NULL CHECK (result IN ('win', 'loss')),
        minutes_played  INTEGER NOT NULL,
        date            TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS next_line (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        court_id           INTEGER NOT NULL REFERENCES courts(id),
        captain_player_id  INTEGER NOT NULL REFERENCES players(id),
        position           INTEGER NOT NULL,
        status             TEXT NOT NULL DEFAULT 'waiting',
        created_at         TEXT
    );

    CREATE TABLE IF NOT EXISTS next_line_members (
        next_line_id  INTEGER NOT NULL REFERENCES next_line(id),
        player_id     INTEGER NOT NULL REFERENCES players(id),
        PRIMARY KEY (next_line_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS live_games (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        court_id           INTEGER NOT NULL REFERENCES courts(id),
        park_id            INTEGER NOT NULL REFERENCES parks(id),
        target             INTEGER NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('countdown', 'in_progress', 'awaiting_confirmation', 'done')),
        team_a_won         INTEGER,
        confirmed_a        INTEGER NOT NULL DEFAULT 0,
        confirmed_b        INTEGER NOT NULL DEFAULT 0,
        countdown_seconds  INTEGER,
        countdown_ends_at  TEXT,
        started_at         TEXT,
        locked_at          TEXT
    );

    CREATE TABLE IF NOT EXISTS live_game_players (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        live_game_id   INTEGER NOT NULL REFERENCES live_games(id),
        player_id      INTEGER NOT NULL REFERENCES players(id),
        team           TEXT NOT NULL CHECK (team IN ('a', 'b')),
        captain        INTEGER NOT NULL DEFAULT 0,
        time_on        TEXT,
        time_off       TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id   INTEGER NOT NULL REFERENCES players(id),
        event_name  TEXT NOT NULL,
        page        TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS court_suggestions (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id             INTEGER NOT NULL REFERENCES players(id),
        name                  TEXT NOT NULL,
        lat                   REAL NOT NULL,
        lng                   REAL NOT NULL,
        photo_url             TEXT,
        status                TEXT NOT NULL DEFAULT 'pending',
        park_id               INTEGER REFERENCES parks(id),
        reviewed_by_player_id INTEGER REFERENCES players(id),
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_at           TEXT
    );

    CREATE TABLE IF NOT EXISTS overpass_cache (
        bucket_key    TEXT PRIMARY KEY,
        lat           REAL NOT NULL,
        lng           REAL NOT NULL,
        response_json TEXT NOT NULL,
        fetched_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS runs (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        court_id             INTEGER NOT NULL REFERENCES courts(id),
        organizer_player_id  INTEGER NOT NULL REFERENCES players(id),
        scheduled_at         TEXT NOT NULL,
        note                 TEXT,
        created_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS run_rsvps (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id     INTEGER NOT NULL REFERENCES runs(id),
        player_id  INTEGER NOT NULL REFERENCES players(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (run_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS court_follows (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id  INTEGER NOT NULL REFERENCES players(id),
        court_id   INTEGER NOT NULL REFERENCES courts(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (player_id, court_id)
    );

    CREATE TABLE IF NOT EXISTS app_meta (
        key    TEXT PRIMARY KEY,
        value  TEXT
    );

    CREATE TABLE IF NOT EXISTS geocode_cache (
        query       TEXT PRIMARY KEY,
        lat         REAL,
        lng         REAL,
        city        TEXT,
        found       INTEGER NOT NULL DEFAULT 1,
        fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS park_photos (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        park_id               INTEGER NOT NULL REFERENCES parks(id),
        player_id             INTEGER NOT NULL REFERENCES players(id),
        filename              TEXT NOT NULL UNIQUE,
        status                TEXT NOT NULL DEFAULT 'pending',
        reviewed_by_player_id INTEGER REFERENCES players(id),
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_at           TEXT
    );
  `);
}

// SQLite's ALTER TABLE ADD COLUMN can't add a UNIQUE/PRIMARY KEY, and a
// NOT NULL column needs a constant default — fine for everything we add.
function addColumnIfMissing(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function migrateKingOfTheCourtColumns() {
  addColumnIfMissing('parks', 'lat', 'REAL');
  addColumnIfMissing('parks', 'lng', 'REAL');
  addColumnIfMissing('parks', 'game_target', 'INTEGER NOT NULL DEFAULT 16');
  addColumnIfMissing('parks', 'between_games_seconds', 'INTEGER NOT NULL DEFAULT 180');
  addColumnIfMissing('parks', 'check_in_radius_meters', 'INTEGER NOT NULL DEFAULT 250');
  addColumnIfMissing('parks', 'leave_radius_meters', 'INTEGER NOT NULL DEFAULT 400');
  addColumnIfMissing('next_line', 'status', "TEXT NOT NULL DEFAULT 'waiting'");
  addColumnIfMissing('next_line', 'created_at', 'TEXT');
  addColumnIfMissing('check_ins', 'last_inside', 'TEXT');
  addColumnIfMissing('players', 'is_organizer', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('parks', 'osm_id', 'TEXT');
  addColumnIfMissing('parks', 'added_by_player_id', 'INTEGER REFERENCES players(id)');
  addColumnIfMissing('parks', 'is_suggested', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('court_suggestions', 'photo_url', 'TEXT');
  addColumnIfMissing('lobbies', 'park_id', 'INTEGER REFERENCES parks(id)');
  addColumnIfMissing('parks', 'city', 'TEXT');
  addColumnIfMissing('parks', 'cover_photo_id', 'INTEGER REFERENCES park_photos(id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_parks_osm_id ON parks(osm_id)');

  // The check-in radius default changed 150 -> 250. Any park still sitting
  // at the old factory default (never customized by an organizer) picks up
  // the new one; a deliberately-customized value is left alone.
  db.prepare('UPDATE parks SET check_in_radius_meters = 250 WHERE check_in_radius_meters = 150').run();
  // Backfill last_inside for existing fresh check-ins so nobody is wrongly
  // treated as "outside" the moment this migration runs. (5 minutes here
  // matches CHECK_IN_FRESH_MINUTES in db/queries.js — inlined since this
  // runs at boot, before that module's constant is necessarily available.)
  db.prepare(
    `UPDATE check_ins SET last_inside = last_seen WHERE last_inside IS NULL AND last_seen >= datetime('now', '-5 minutes')`
  ).run();
}

// "4331 NW 36th St, Lauderdale Lakes, FL 33319" -> "Lauderdale Lakes";
// "Sunrise, FL" -> "Sunrise". Null when the text has no "City, ST" in it.
function cityFromAddress(location) {
  if (!location) return null;
  const parts = location.split(',').map((part) => part.trim()).filter(Boolean);
  const stateIndex = parts.findIndex((part) => /^[A-Za-z]{2}(\s+\d{5}(-\d{4})?)?$/.test(part));
  return stateIndex >= 1 ? parts[stateIndex - 1] : null;
}

function parkIdByName(name) {
  const row = db.prepare('SELECT id FROM parks WHERE name = ? ORDER BY id ASC LIMIT 1').get(name);
  return row ? row.id : null;
}

// Folds one park into another without losing anything attached to it:
// games, check-ins, the next-line queue, runs, follows, lobbies, photos.
// A court whose number the target already has is merged into that court;
// one it doesn't have just moves across.
function mergePark(fromId, toId) {
  const fromCourts = db.prepare('SELECT id, number FROM courts WHERE park_id = ? ORDER BY number ASC').all(fromId);
  for (const court of fromCourts) {
    const target = db.prepare('SELECT id FROM courts WHERE park_id = ? AND number = ?').get(toId, court.number);
    if (!target) {
      db.prepare('UPDATE courts SET park_id = ? WHERE id = ?').run(toId, court.id);
      continue;
    }
    for (const table of ['game_results', 'next_line', 'live_games', 'runs']) {
      db.prepare(`UPDATE ${table} SET court_id = ? WHERE court_id = ?`).run(target.id, court.id);
    }
    // court_follows is UNIQUE (player_id, court_id) — a player following
    // both courts keeps one follow, not a constraint error.
    db.prepare('UPDATE OR IGNORE court_follows SET court_id = ? WHERE court_id = ?').run(target.id, court.id);
    db.prepare('DELETE FROM court_follows WHERE court_id = ?').run(court.id);
    db.prepare('DELETE FROM courts WHERE id = ?').run(court.id);
  }

  for (const table of ['game_results', 'live_games', 'court_suggestions', 'lobbies', 'park_photos']) {
    db.prepare(`UPDATE ${table} SET park_id = ? WHERE park_id = ?`).run(toId, fromId);
  }
  // One check-in row per player per park is what checkIn() maintains.
  db.prepare(
    'DELETE FROM check_ins WHERE park_id = ? AND player_id IN (SELECT player_id FROM check_ins WHERE park_id = ?)'
  ).run(fromId, toId);
  db.prepare('UPDATE check_ins SET park_id = ? WHERE park_id = ?').run(toId, fromId);

  // Whatever the target doesn't have yet, it inherits: a cover photo, and
  // the OSM id (so the map doesn't offer that same court as "open" again).
  db.prepare(
    `UPDATE parks SET
       cover_photo_id = COALESCE(cover_photo_id, (SELECT cover_photo_id FROM parks WHERE id = ?)),
       osm_id = COALESCE(osm_id, (SELECT osm_id FROM parks WHERE id = ?))
     WHERE id = ?`
  ).run(fromId, fromId, toId);
  db.prepare('DELETE FROM parks WHERE id = ?').run(fromId);
}

// Leaves exactly the PRESET_PARKS as this app's preset parks, on a fresh
// database and an existing one alike: creates any that are missing, folds
// the presets they replace into them, and folds in same-name duplicates.
// Parks players created themselves (from an OpenStreetMap pin or an
// approved suggestion) are never touched. A no-op once it has run.
function consolidatePresetParks() {
  db.exec('BEGIN');
  try {
    for (const preset of PRESET_PARKS) {
      let parkId = parkIdByName(preset.name);
      if (!parkId) {
        db.prepare(
          'INSERT INTO parks (name, location, city, lat, lng, is_suggested) VALUES (?, ?, ?, ?, ?, 1)'
        ).run(preset.name, preset.location, cityFromAddress(preset.location), preset.lat, preset.lng);
        parkId = lastId();
      }
      // Before merging, so a replaced park's "Main" court lands in this
      // park's own Court 1 rather than moving across under its old name.
      for (const [number, nickname] of preset.courts) findOrCreateCourt(parkId, number, nickname);

      const replaced = db
        .prepare(
          `SELECT id FROM parks
           WHERE id != ? AND osm_id IS NULL AND added_by_player_id IS NULL
             AND name IN (${preset.replaces.map(() => '?').join(', ')})`
        )
        .all(parkId, ...preset.replaces);
      const duplicates = db
        .prepare('SELECT id FROM parks WHERE id != ? AND name = ? COLLATE NOCASE')
        .all(parkId, preset.name);
      for (const { id } of [...replaced, ...duplicates]) mergePark(id, parkId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Both presets are organizer-suggested out of the box. Once only — an
  // organizer who later un-ticks one in /admin/courts keeps that choice.
  runOnce('preset_parks_suggested', () => {
    const flag = db.prepare('UPDATE parks SET is_suggested = 1 WHERE name = ?');
    for (const preset of PRESET_PARKS) flag.run(preset.name);
  });
}

// Fills in a park's city from its address wherever that's possible
// without asking anyone — a park with coordinates but no address gets
// its city from the geocoder instead (db/geocode.js).
function backfillParkCities() {
  const parks = db.prepare("SELECT id, location FROM parks WHERE city IS NULL AND location IS NOT NULL").all();
  const setCity = db.prepare('UPDATE parks SET city = ? WHERE id = ?');
  for (const park of parks) {
    const city = cityFromAddress(park.location);
    if (city) setCity.run(city, park.id);
  }
}

// Flags any account whose phone is in ORGANIZER_PHONES (comma-separated)
// as an organizer. Runs at boot, so a phone added to the env var after an
// account already exists still takes effect on the next restart — and
// again from server.js on every signup/login, for the common case of an
// account that's created or logged into fresh after the env var is set.
function applyOrganizerPhones() {
  const phones = (process.env.ORGANIZER_PHONES || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (phones.length === 0) return;

  const flag = db.prepare(
    `UPDATE players SET is_organizer = 1
     WHERE user_id IN (SELECT id FROM users WHERE phone = ?)`
  );
  for (const phone of phones) flag.run(phone);
}

function findOrCreateCourt(parkId, number, nickname) {
  const existing = db
    .prepare('SELECT id FROM courts WHERE park_id = ? AND number = ?')
    .get(parkId, number);
  if (existing) return existing.id;

  db.prepare(
    'INSERT INTO courts (park_id, number, nickname) VALUES (?, ?, ?)'
  ).run(parkId, number, nickname);
  return lastId();
}

function seedKingOfTheCourtDemoData() {
  // Both parks already exist by now — consolidatePresetParks() runs first.
  const lakesId = parkIdByName('Lauderdale Lakes Recreation');
  const lakesMainCourtId = findOrCreateCourt(lakesId, 1, 'Main');
  const sacId = parkIdByName('Sunrise Athletic Complex (SAC)');
  const sacCourtOneId = findOrCreateCourt(sacId, 1, null);

  // The demo Sunday run lobby plays at Lauderdale Lakes — linked here
  // (rather than at lobby-creation time in seedDemoData(), which runs
  // before any park exists) so /lobbies can show its real name and
  // directions. On an existing database the lobby already followed its
  // old park here when that park was merged.
  db.prepare(
    `UPDATE lobbies SET park_id = ? WHERE name = 'Sunday run' AND park_id IS NULL`
  ).run(lakesId);

  const alreadySeeded = db.prepare('SELECT 1 FROM game_results LIMIT 1').get();
  if (alreadySeeded) return;

  const playerIdByPhone = (phone) =>
    db
      .prepare(
        `SELECT p.id FROM players p JOIN users u ON u.id = p.user_id WHERE u.phone = ?`
      )
      .get(phone)?.id;

  const D = playerIdByPhone('5550000001'); // Darius Reed
  const C = playerIdByPhone('5550000002'); // Chris Lawal
  const M = playerIdByPhone('5550000003'); // Marcus Bell
  const T = playerIdByPhone('5550000004'); // Trey Osei
  const J = playerIdByPhone('5550000005'); // Jamal Price

  if (!D || !C || !M || !T || !J) return; // demo players not seeded (shouldn't happen)

  const insertResult = db.prepare(
    `INSERT INTO game_results (game_id, player_id, park_id, court_id, result, minutes_played)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const bumpWin = db.prepare(
    'UPDATE players SET wins = wins + 1, games_played = games_played + 1 WHERE id = ?'
  );
  const bumpLoss = db.prepare(
    'UPDATE players SET losses = losses + 1, games_played = games_played + 1 WHERE id = ?'
  );

  let nextGameId = 1;

  function playGame(parkId, courtId, winners, losers, minutes) {
    const gameId = nextGameId++;
    for (const playerId of winners) {
      insertResult.run(gameId, playerId, parkId, courtId, 'win', minutes);
      bumpWin.run(playerId);
    }
    for (const playerId of losers) {
      insertResult.run(gameId, playerId, parkId, courtId, 'loss', minutes);
      bumpLoss.run(playerId);
    }
  }

  // Lauderdale Lakes, Main court — Darius plays (and mostly wins) a lot
  // here, which is what makes him king of this park this season.
  playGame(lakesId, lakesMainCourtId, [D, C], [M, T], 60);
  playGame(lakesId, lakesMainCourtId, [D, M], [C, T], 60);
  playGame(lakesId, lakesMainCourtId, [D], [C], 45);
  playGame(lakesId, lakesMainCourtId, [D, T], [C, M], 60);
  playGame(lakesId, lakesMainCourtId, [D], [M], 50);
  playGame(lakesId, lakesMainCourtId, [C, M], [D, J], 55);
  playGame(lakesId, lakesMainCourtId, [D, C], [T, J], 60);

  // SAC, Court 1 — Darius shows up here too, earning him a Double Crown
  // (king of both parks in the same season).
  playGame(sacId, sacCourtOneId, [D, T], [C, M], 60);
  playGame(sacId, sacCourtOneId, [D], [J], 40);
  playGame(sacId, sacCourtOneId, [D, C], [M, T], 60);
  playGame(sacId, sacCourtOneId, [D, C], [M, T], 60);
  playGame(sacId, sacCourtOneId, [D], [C], 30);
  playGame(sacId, sacCourtOneId, [M], [T], 45);
  playGame(sacId, sacCourtOneId, [C, M], [T, J], 60);
}

module.exports = { db, formingGameFor, lastId, DATA_DIR, cityFromAddress, runOnce };
