import { transaction } from './db.js';
import { settleGame } from './settlement.js';

export const CONFIRM_WINDOW_MS = 20 * 60 * 1000;

export function createUser(db, { name, phone = null }) {
  const { lastInsertRowid: userId } = db
    .prepare('INSERT INTO users (name, phone) VALUES (?, ?)').run(name, phone);
  const { lastInsertRowid: playerId } = db
    .prepare('INSERT INTO players (user_id) VALUES (?)').run(userId);
  return { userId: Number(userId), playerId: Number(playerId) };
}

export function createLobby(db, { name, location = null, startsAt, tier, stakeCents, joinCode = null }) {
  const t = db.prepare('SELECT * FROM tiers WHERE name = ?').get(tier);
  if (!t) throw new Error(`unknown tier '${tier}'`);
  if (stakeCents < t.min_stake_cents || (t.max_stake_cents != null && stakeCents > t.max_stake_cents)) {
    throw new Error(`stake ${stakeCents} is outside the ${tier} range`);
  }
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO lobbies (name, location, starts_at, tier, stake_cents, join_code) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(name, location, startsAt, tier, stakeCents, joinCode);
  return Number(lastInsertRowid);
}

export function findLobbyByCode(db, code) {
  return db.prepare('SELECT * FROM lobbies WHERE join_code = ? COLLATE NOCASE').get(code) ?? null;
}

// Creates a game with its roster. teams = { a: [playerId...], b: [playerId...] }.
// Players must be in the lobby's tier. Status starts 'forming'.
export function createGame(db, lobbyId, teams) {
  return transaction(db, () => {
    const lobby = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(lobbyId);
    if (!lobby) throw new Error(`lobby ${lobbyId} not found`);
    if (!teams.a.length || !teams.b.length) throw new Error('both teams need players');
    const { lastInsertRowid } = db.prepare('INSERT INTO games (lobby_id) VALUES (?)').run(lobbyId);
    const gameId = Number(lastInsertRowid);
    const getPlayer = db.prepare('SELECT * FROM players WHERE id = ?');
    const add = db.prepare('INSERT INTO game_players (game_id, player_id, team) VALUES (?, ?, ?)');
    for (const team of ['a', 'b']) {
      for (const playerId of teams[team]) {
        const p = getPlayer.get(playerId);
        if (!p) throw new Error(`player ${playerId} not found`);
        if (p.tier !== lobby.tier) throw new Error(`player ${playerId} is '${p.tier}', lobby is '${lobby.tier}'`);
        add.run(gameId, playerId, team);
      }
    }
    return gameId;
  });
}

// forming -> playing. Writes each player's entry fee (owed in, negative).
export function startGame(db, gameId) {
  return transaction(db, () => {
    const game = requireStatus(db, gameId, 'forming');
    const lobby = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(game.lobby_id);
    const roster = db.prepare('SELECT player_id FROM game_players WHERE game_id = ?').all(gameId);
    const add = db.prepare(
      "INSERT INTO ledger (player_id, game_id, type, amount_cents) VALUES (?, ?, 'entry_fee', ?)");
    for (const { player_id } of roster) add.run(player_id, gameId, -lobby.stake_cents);
    db.prepare("UPDATE games SET status = 'playing' WHERE id = ?").run(gameId);
  });
}

// playing -> pending_confirm. Ties are rejected: someone has to win.
export function reportScore(db, gameId, teamAScore, teamBScore, now = new Date()) {
  return transaction(db, () => {
    requireStatus(db, gameId, 'playing');
    if (!Number.isInteger(teamAScore) || !Number.isInteger(teamBScore) || teamAScore < 0 || teamBScore < 0) {
      throw new Error('scores must be non-negative integers');
    }
    if (teamAScore === teamBScore) throw new Error('scores cannot be tied');
    db.prepare(`UPDATE games SET status = 'pending_confirm', team_a_score = ?, team_b_score = ?,
                winner = ?, confirm_deadline = ? WHERE id = ?`).run(
      teamAScore, teamBScore, teamAScore > teamBScore ? 'a' : 'b',
      new Date(now.getTime() + CONFIRM_WINDOW_MS).toISOString(), gameId);
  });
}

// One player per team confirms. When both teams have, the game settles.
// Returns the settlement result once locked, otherwise null.
export function confirmScore(db, gameId, playerId, now = new Date()) {
  const settle = transaction(db, () => {
    requireStatus(db, gameId, 'pending_confirm');
    const row = db.prepare('SELECT team FROM game_players WHERE game_id = ? AND player_id = ?').get(gameId, playerId);
    if (!row) throw new Error(`player ${playerId} is not in game ${gameId}`);
    const column = row.team === 'a' ? 'confirmed_by_a' : 'confirmed_by_b';
    db.prepare(`UPDATE games SET ${column} = ? WHERE id = ?`).run(playerId, gameId);
    const g = db.prepare('SELECT confirmed_by_a, confirmed_by_b FROM games WHERE id = ?').get(gameId);
    return Boolean(g.confirmed_by_a && g.confirmed_by_b);
  });
  return settle ? settleGame(db, gameId, now) : null;
}

// pending_confirm -> contested. Money is untouched until someone resolves it.
export function contestGame(db, gameId, playerId) {
  return transaction(db, () => {
    requireStatus(db, gameId, 'pending_confirm');
    const row = db.prepare('SELECT 1 FROM game_players WHERE game_id = ? AND player_id = ?').get(gameId, playerId);
    if (!row) throw new Error(`player ${playerId} is not in game ${gameId}`);
    db.prepare("UPDATE games SET status = 'contested' WHERE id = ?").run(gameId);
  });
}

// A balance is just the sum of ledger rows: negative = they owe, positive = owed to them.
export function balanceCents(db, playerId, { unsettledOnly = false } = {}) {
  const sql = `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM ledger
               WHERE player_id = ?${unsettledOnly ? ' AND settled = 0' : ''}`;
  return db.prepare(sql).get(playerId).total;
}

function requireStatus(db, gameId, expected) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!game) throw new Error(`game ${gameId} not found`);
  if (game.status !== expected) throw new Error(`game ${gameId} is '${game.status}', expected '${expected}'`);
  return game;
}
