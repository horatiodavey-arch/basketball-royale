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
seedKingOfTheCourtDemoData();

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

// Creates a park plus its default Court 1 "Main", unless a park with
// that name already exists. Returns the park's id either way — and
// backfills lat/lng on an existing row from before check-in needed them.
function findOrCreatePark(name, location, checkInRadiusMeters, leaveRadiusMeters, lat, lng) {
  const existing = db.prepare('SELECT id, lat FROM parks WHERE name = ?').get(name);
  if (existing) {
    if (existing.lat === null) {
      db.prepare('UPDATE parks SET lat = ?, lng = ? WHERE id = ?').run(lat, lng, existing.id);
    }
    return existing.id;
  }

  db.prepare(
    'INSERT INTO parks (name, location, lat, lng, check_in_radius_meters, leave_radius_meters) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, location, lat, lng, checkInRadiusMeters, leaveRadiusMeters);
  const parkId = lastId();

  db.prepare(
    "INSERT INTO courts (park_id, number, nickname) VALUES (?, 1, 'Main')"
  ).run(parkId);

  return parkId;
}

// One-time rename: an earlier version seeded this park under a
// fictional name. Swaps in the real address without losing the park's
// id, so its existing demo game history (which references park_id, not
// the name) stays attached. No-ops once the rename has already happened.
function renameParkIfExists(oldName, newName, newLocation, newLat, newLng) {
  const existing = db.prepare('SELECT id FROM parks WHERE name = ?').get(oldName);
  if (!existing) return;
  db.prepare('UPDATE parks SET name = ?, location = ?, lat = ?, lng = ? WHERE id = ?').run(
    newName,
    newLocation,
    newLat,
    newLng,
    existing.id
  );
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
  renameParkIfExists(
    'Lauderdale Lakes Park',
    'Lauderhill Parks & Recreation',
    '4141 NW 16th St, Lauderhill, FL 33313',
    26.1466558,
    -80.206011
  );
  const lauderhillId = findOrCreatePark(
    'Lauderhill Parks & Recreation',
    '4141 NW 16th St, Lauderhill, FL 33313',
    250,
    400,
    26.1466558,
    -80.206011
  );
  const mainCourtId = findOrCreateCourt(lauderhillId, 1, 'Main');
  findOrCreateCourt(lauderhillId, 2, 'Side');

  // Second demo park, so the leaderboard has somewhere for a player to
  // earn a Double Crown (king of two parks in the same season).
  const markhamParkId = findOrCreatePark('Markham Park', 'Sunrise, FL', 250, 400, 26.1256, -80.3104);
  const markhamMainCourtId = findOrCreateCourt(markhamParkId, 1, 'Main');

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

  // Lauderhill, Main court — Darius plays (and mostly wins) a lot
  // here, which is what makes him king of this park this season.
  playGame(lauderhillId, mainCourtId, [D, C], [M, T], 60);
  playGame(lauderhillId, mainCourtId, [D, M], [C, T], 60);
  playGame(lauderhillId, mainCourtId, [D], [C], 45);
  playGame(lauderhillId, mainCourtId, [D, T], [C, M], 60);
  playGame(lauderhillId, mainCourtId, [D], [M], 50);
  playGame(lauderhillId, mainCourtId, [C, M], [D, J], 55);
  playGame(lauderhillId, mainCourtId, [D, C], [T, J], 60);

  // Markham Park, Main court — Darius shows up here too, earning him a
  // Double Crown (king of both parks in the same season).
  playGame(markhamParkId, markhamMainCourtId, [D, T], [C, M], 60);
  playGame(markhamParkId, markhamMainCourtId, [D], [J], 40);
  playGame(markhamParkId, markhamMainCourtId, [D, C], [M, T], 60);
  playGame(markhamParkId, markhamMainCourtId, [D, C], [M, T], 60);
  playGame(markhamParkId, markhamMainCourtId, [D], [C], 30);
  playGame(markhamParkId, markhamMainCourtId, [M], [T], 45);
  playGame(markhamParkId, markhamMainCourtId, [C, M], [T, J], 60);
}

module.exports = { db, formingGameFor, lastId };
