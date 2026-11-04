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
// its next boot, with no db:reset required.
ensureKingOfTheCourtTables();
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
        check_in_radius_meters INTEGER NOT NULL DEFAULT 150
    );

    CREATE TABLE IF NOT EXISTS courts (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        park_id   INTEGER NOT NULL REFERENCES parks(id),
        number    INTEGER NOT NULL,
        nickname  TEXT,
        UNIQUE (park_id, number)
    );

    CREATE TABLE IF NOT EXISTS check_ins (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id  INTEGER NOT NULL REFERENCES players(id),
        park_id    INTEGER NOT NULL REFERENCES parks(id),
        time_in    TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
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
        position           INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS next_line_members (
        next_line_id  INTEGER NOT NULL REFERENCES next_line(id),
        player_id     INTEGER NOT NULL REFERENCES players(id),
        PRIMARY KEY (next_line_id, player_id)
    );
  `);
}

// Creates a park plus its default Court 1 "Main", unless a park with
// that name already exists. Returns the park's id either way.
function findOrCreatePark(name, location, radiusMeters) {
  const existing = db.prepare('SELECT id FROM parks WHERE name = ?').get(name);
  if (existing) return existing.id;

  db.prepare(
    'INSERT INTO parks (name, location, check_in_radius_meters) VALUES (?, ?, ?)'
  ).run(name, location, radiusMeters);
  const parkId = lastId();

  db.prepare(
    "INSERT INTO courts (park_id, number, nickname) VALUES (?, 1, 'Main')"
  ).run(parkId);

  return parkId;
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
  const lauderdaleLakesId = findOrCreatePark('Lauderdale Lakes Park', 'Lauderdale Lakes, FL', 150);
  const mainCourtId = findOrCreateCourt(lauderdaleLakesId, 1, 'Main');
  findOrCreateCourt(lauderdaleLakesId, 2, 'Side');

  // Second demo park, so the leaderboard has somewhere for a player to
  // earn a Double Crown (king of two parks in the same season).
  const markhamParkId = findOrCreatePark('Markham Park', 'Sunrise, FL', 150);
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

  // Lauderdale Lakes, Main court — Darius plays (and mostly wins) a lot
  // here, which is what makes him king of this park this season.
  playGame(lauderdaleLakesId, mainCourtId, [D, C], [M, T], 60);
  playGame(lauderdaleLakesId, mainCourtId, [D, M], [C, T], 60);
  playGame(lauderdaleLakesId, mainCourtId, [D], [C], 45);
  playGame(lauderdaleLakesId, mainCourtId, [D, T], [C, M], 60);
  playGame(lauderdaleLakesId, mainCourtId, [D], [M], 50);
  playGame(lauderdaleLakesId, mainCourtId, [C, M], [D, J], 55);
  playGame(lauderdaleLakesId, mainCourtId, [D, C], [T, J], 60);

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

module.exports = { db, formingGameFor };
