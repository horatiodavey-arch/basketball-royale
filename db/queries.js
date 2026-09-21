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
};
