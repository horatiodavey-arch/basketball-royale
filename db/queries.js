const { db, formingGameFor } = require('./index');

function getUserByPhone(phone) {
  return db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
}

function getPlayerByUserId(userId) {
  return db.prepare('SELECT * FROM players WHERE user_id = ?').get(userId);
}

function createUserAndPlayer(name, phone) {
  const insertUser = db.prepare('INSERT INTO users (name, phone) VALUES (?, ?)');
  insertUser.run(name, phone);
  const userId = db.prepare('SELECT last_insert_rowid() AS id').get().id;

  db.prepare('INSERT INTO players (user_id) VALUES (?)').run(userId);
  const playerId = db.prepare('SELECT last_insert_rowid() AS id').get().id;

  return { userId, playerId };
}

// Player + their user profile + their tier's promotion rules, in one row.
function getPlayerProfile(userId) {
  return db
    .prepare(
      `SELECT u.id AS user_id, u.name, u.phone,
              p.id AS player_id, p.tier, p.wins, p.losses, p.games_played,
              t.rank AS tier_rank, t.wins_to_promote, t.games_to_promote,
              t.min_stake_cents AS tier_min_stake_cents
       FROM users u
       JOIN players p ON p.user_id = u.id
       JOIN tiers t ON t.name = p.tier
       WHERE u.id = ?`
    )
    .get(userId);
}

function getTiers() {
  return db.prepare('SELECT * FROM tiers ORDER BY rank ASC').all();
}

function getOpenLobbies() {
  return db
    .prepare("SELECT * FROM lobbies WHERE status = 'open' ORDER BY starts_at ASC")
    .all();
}

// Names of everyone currently in a lobby's forming game (the roster
// shown on the lobby card, e.g. "6 locked in · Darius, Chris + 4 more").
function getLobbyRoster(lobbyId) {
  const game = formingGameFor(lobbyId);
  if (!game) return { gameId: null, players: [] };

  const players = db
    .prepare(
      `SELECT u.id AS user_id, u.name
       FROM game_players gp
       JOIN players p ON p.id = gp.player_id
       JOIN users u ON u.id = p.user_id
       WHERE gp.game_id = ?
       ORDER BY gp.rowid ASC`
    )
    .all(game.id);

  return { gameId: game.id, players };
}

function isPlayerInGame(gameId, playerId) {
  const row = db
    .prepare('SELECT 1 FROM game_players WHERE game_id = ? AND player_id = ?')
    .get(gameId, playerId);
  return !!row;
}

// Joining a lobby = taking a seat in its forming game's roster, plus
// the ledger entry recording the entry fee owed (cash settles IRL).
function joinLobby(playerId, lobby) {
  const game = formingGameFor(lobby.id);
  if (!game) throw new Error('Lobby has no forming game');

  if (isPlayerInGame(game.id, playerId)) {
    return { alreadyJoined: true };
  }

  db.prepare(
    "INSERT INTO game_players (game_id, player_id, team) VALUES (?, ?, 'unassigned')"
  ).run(game.id, playerId);

  db.prepare(
    "INSERT INTO ledger (player_id, game_id, type, amount_cents, settled) VALUES (?, ?, 'entry_fee', ?, 0)"
  ).run(playerId, game.id, -lobby.stake_cents);

  return { alreadyJoined: false };
}

function getLobbyById(id) {
  return db.prepare('SELECT * FROM lobbies WHERE id = ?').get(id);
}

// ============================================================
// KING OF THE COURT
// ============================================================

function getParks() {
  return db.prepare('SELECT * FROM parks ORDER BY name ASC').all();
}

function getParkById(id) {
  return db.prepare('SELECT * FROM parks WHERE id = ?').get(id);
}

function getCourtsByPark(parkId) {
  return db
    .prepare('SELECT * FROM courts WHERE park_id = ? ORDER BY number ASC')
    .all(parkId);
}

function getCourtById(id) {
  return db.prepare('SELECT * FROM courts WHERE id = ?').get(id);
}

// Court dropdown for "record a game": every court, grouped by park.
function getCourtsWithParks() {
  return db
    .prepare(
      `SELECT c.id, c.number, c.nickname, p.id AS park_id, p.name AS park_name
       FROM courts c
       JOIN parks p ON p.id = c.park_id
       ORDER BY p.name ASC, c.number ASC`
    )
    .all();
}

// Every player, for the team pickers on "record a game".
function getAllPlayers() {
  return db
    .prepare(
      `SELECT p.id, u.name
       FROM players p
       JOIN users u ON u.id = p.user_id
       ORDER BY u.name ASC`
    )
    .all();
}

function nextGameId() {
  return db.prepare('SELECT COALESCE(MAX(game_id), 0) + 1 AS next FROM game_results').get().next;
}

// Saves one game_results row per player (everyone gets the same
// minutes) and bumps wins/losses/games_played on the players table.
function recordGame({ parkId, courtId, teamA, teamB, scoreA, scoreB, minutes }) {
  const gameId = nextGameId();
  const winners = scoreA > scoreB ? teamA : teamB;
  const losers = scoreA > scoreB ? teamB : teamA;

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

  for (const playerId of winners) {
    insertResult.run(gameId, playerId, parkId, courtId, 'win', minutes);
    bumpWin.run(playerId);
  }
  for (const playerId of losers) {
    insertResult.run(gameId, playerId, parkId, courtId, 'loss', minutes);
    bumpLoss.run(playerId);
  }

  return { gameId };
}

// --- Seasons: everything resets every 30 days, counted from a fixed
// anchor so the boundary is the same no matter when the server runs.
const SEASON_LENGTH_MS = 30 * 24 * 60 * 60 * 1000;
const SEASON_EPOCH_MS = Date.UTC(2024, 0, 1);

// SQLite's datetime('now') (used as game_results.date's default) is
// "YYYY-MM-DD HH:MM:SS" in UTC, with a space, not a "T", and no
// milliseconds. Comparing against anything else breaks right at a
// season boundary, since SQLite dates are compared as plain text.
function toSqliteDateTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function getSeasonWindow(now = new Date()) {
  const nowMs = now.getTime();
  const index = Math.floor((nowMs - SEASON_EPOCH_MS) / SEASON_LENGTH_MS);
  const startMs = SEASON_EPOCH_MS + index * SEASON_LENGTH_MS;
  const endMs = startMs + SEASON_LENGTH_MS;
  const daysLeft = Math.ceil((endMs - nowMs) / (24 * 60 * 60 * 1000));
  const start = new Date(startMs);
  const end = new Date(endMs);
  return { start, end, daysLeft, startSql: toSqliteDateTime(start), endSql: toSqliteDateTime(end) };
}

// --- Crown levels: based on a player's TOTAL season points across
// every park, not the points at any one park. Checked highest-first.
const CROWN_LEVELS = [
  { name: 'Best Record in the League', min: 55, tier: 'purple', fill: '#7A45C2', stroke: '#4A2580' },
  { name: 'Playoff Bound', min: 50, tier: 'gold', fill: '#D9A520', stroke: '#8A6408' },
  { name: 'Contender', min: 35, tier: 'silver', fill: '#AEB3BA', stroke: '#5F656D' },
  { name: 'In the Mix', min: 20, tier: 'bronze', fill: '#B06A3B', stroke: '#6E3F1F' },
];
const CROWN_MIN_POINTS = CROWN_LEVELS[CROWN_LEVELS.length - 1].min;

function getCrownLevel(totalPoints) {
  for (const level of CROWN_LEVELS) {
    if (totalPoints >= level.min) return level;
  }
  return null;
}

function roundTenth(n) {
  return Math.round(n * 10) / 10;
}

// Points = wins x 3 + games x 1 + court hours (minutes / 60, rounded
// to a tenth). One row per (player_id, name, wins, games, hours, points).
function standingsFromGameResults(whereClause, params) {
  const rows = db
    .prepare(
      `SELECT gr.player_id AS playerId,
              u.name,
              SUM(CASE WHEN gr.result = 'win' THEN 1 ELSE 0 END) AS wins,
              COUNT(*) AS games,
              SUM(gr.minutes_played) AS minutes
       FROM game_results gr
       JOIN players p ON p.id = gr.player_id
       JOIN users u ON u.id = p.user_id
       WHERE ${whereClause}
       GROUP BY gr.player_id`
    )
    .all(...params);

  return rows
    .map((row) => {
      const hours = roundTenth(row.minutes / 60);
      const points = row.wins * 3 + row.games * 1 + hours;
      return { playerId: row.playerId, name: row.name, wins: row.wins, games: row.games, hours, points };
    })
    .sort((a, b) => b.points - a.points || b.hours - a.hours);
}

// Standings at one park, this season — also how a park's king is found.
function getParkStandings(parkId, seasonStart) {
  return standingsFromGameResults('gr.park_id = ? AND gr.date >= ?', [parkId, seasonStart]);
}

// Standings across every park, this season (the "City" tab).
function getCityStandings(seasonStart) {
  return standingsFromGameResults('gr.date >= ?', [seasonStart]);
}

// playerId -> total season points across every park, for crown level.
function getTotalSeasonPointsByPlayer(seasonStart) {
  const map = new Map();
  for (const row of getCityStandings(seasonStart)) {
    map.set(row.playerId, row.points);
  }
  return map;
}

// playerId -> 'Double Crown' | 'Triple Crown', for players who are king
// of 2 or 3+ parks this season. King of a park = most points there,
// ties broken by most court time there.
function getCrownBadges(seasonStart) {
  const kingCounts = new Map();
  for (const park of getParks()) {
    const standings = getParkStandings(park.id, seasonStart);
    if (standings.length === 0) continue;
    const kingId = standings[0].playerId;
    kingCounts.set(kingId, (kingCounts.get(kingId) || 0) + 1);
  }

  const badges = new Map();
  for (const [playerId, count] of kingCounts) {
    if (count >= 3) badges.set(playerId, 'Triple Crown');
    else if (count === 2) badges.set(playerId, 'Double Crown');
  }
  return badges;
}

// The full /board page's data: standings for the chosen scope, each
// row carrying its own crown level (always city-wide) and badge.
function getLeaderboard({ scope, parkId, seasonStart }) {
  const standings = scope === 'city' ? getCityStandings(seasonStart) : getParkStandings(parkId, seasonStart);
  const totalPointsByPlayer = getTotalSeasonPointsByPlayer(seasonStart);
  const badges = getCrownBadges(seasonStart);

  return standings.map((row, index) => {
    const totalPoints = totalPointsByPlayer.get(row.playerId) ?? row.points;
    const crown = getCrownLevel(totalPoints);
    return {
      rank: index + 1,
      ...row,
      totalPoints,
      crown,
      pointsToCrown: crown ? null : roundTenth(CROWN_MIN_POINTS - totalPoints),
      badge: badges.get(row.playerId) || null,
    };
  });
}

module.exports = {
  getUserByPhone,
  getPlayerByUserId,
  createUserAndPlayer,
  getPlayerProfile,
  getTiers,
  getOpenLobbies,
  getLobbyRoster,
  isPlayerInGame,
  joinLobby,
  getLobbyById,
  getParks,
  getParkById,
  getCourtsByPark,
  getCourtById,
  getCourtsWithParks,
  getAllPlayers,
  recordGame,
  getSeasonWindow,
  CROWN_LEVELS,
  getCrownLevel,
  getParkStandings,
  getCityStandings,
  getLeaderboard,
};
