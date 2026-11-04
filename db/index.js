const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = path.join(__dirname, 'basketball_royale.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const isNewDb = !fs.existsSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

if (isNewDb) {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  seedDemoData();
}

// Reused as the lobby's shared "roster" before teams are drafted.
// Joining a lobby = joining this forming game with team left unassigned.
function formingGameFor(lobbyId) {
  return db
    .prepare("SELECT id FROM games WHERE lobby_id = ? AND status = 'forming'")
    .get(lobbyId);
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
  const lobbyId = db.prepare('SELECT last_insert_rowid() AS id').get().id;

  db.prepare(`INSERT INTO games (lobby_id, status) VALUES (?, 'forming')`).run(lobbyId);
  const gameId = db.prepare('SELECT last_insert_rowid() AS id').get().id;

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
    const userId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    insertPlayer.run(userId, 0, 0, 0);
    const playerId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
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

module.exports = { db, formingGameFor };
