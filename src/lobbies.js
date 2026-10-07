import { randomInt } from 'node:crypto';
import { transaction } from './db.js';

// No 0/O/1/I so a code shouted across a court can't be misheard or mistyped.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = /^[A-Z0-9]{4,10}$/;
const UNFINISHED = "('forming', 'playing', 'pending_confirm', 'contested')";

export const normalizeCode = (code) => String(code ?? '').trim().toUpperCase();

export function generateJoinCode(db, length = 5) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    if (!findLobbyByCode(db, code)) return code;
  }
  throw new Error('could not generate a unique join code');
}

export function findLobbyByCode(db, code) {
  return db.prepare('SELECT * FROM lobbies WHERE join_code = ?').get(normalizeCode(code)) ?? null;
}

// joinCode is optional: leave it out and one is generated.
export function createLobby(db, { name, location = null, startsAt, tier, stakeCents, joinCode = null }) {
  if (!name?.trim()) throw new Error('name is required');
  if (!startsAt) throw new Error('startsAt is required');
  const t = db.prepare('SELECT * FROM tiers WHERE name = ?').get(tier);
  if (!t) throw new Error(`unknown tier '${tier}'`);
  if (!Number.isInteger(stakeCents) || stakeCents < t.min_stake_cents ||
      (t.max_stake_cents != null && stakeCents > t.max_stake_cents)) {
    throw new Error(`stake ${stakeCents} is outside the ${tier} range`);
  }
  let code;
  if (joinCode == null || joinCode === '') {
    code = generateJoinCode(db);
  } else {
    code = normalizeCode(joinCode);
    if (!CODE_PATTERN.test(code)) throw new Error('join code must be 4-10 letters or digits');
    if (findLobbyByCode(db, code)) throw new Error(`join code ${code} is already in use`);
  }
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO lobbies (name, location, starts_at, tier, stake_cents, join_code) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(name.trim(), location, startsAt, tier, stakeCents, code);
  return { id: Number(lastInsertRowid), joinCode: code };
}

function requireLobby(db, code) {
  const lobby = findLobbyByCode(db, code);
  if (!lobby) throw new Error(`no lobby with code ${normalizeCode(code)}`);
  return lobby;
}

const hasUnfinishedGame = (db, lobbyId, playerId) => db.prepare(
  `SELECT 1 AS x FROM games g JOIN game_players gp ON gp.game_id = g.id
   WHERE g.lobby_id = ? AND gp.player_id = ? AND g.status IN ${UNFINISHED}`).get(lobbyId, playerId);

// Open and live lobbies take joiners (people turn up late to a run).
// Joining twice is harmless. Returns { lobby, alreadyJoined }.
export function joinLobby(db, code, playerId) {
  const lobby = requireLobby(db, code);
  if (lobby.status === 'closed') throw new Error('this lobby is closed');
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (player.tier !== lobby.tier) {
    throw new Error(`this lobby is for ${lobby.tier} players, you are ${player.tier}`);
  }
  const { changes } = db.prepare(
    'INSERT OR IGNORE INTO lobby_players (lobby_id, player_id) VALUES (?, ?)').run(lobby.id, playerId);
  return { lobby, alreadyJoined: Number(changes) === 0 };
}

// A player can't walk out of a game that's still being played or settled.
export function leaveLobby(db, code, playerId) {
  const lobby = requireLobby(db, code);
  if (hasUnfinishedGame(db, lobby.id, playerId)) throw new Error('you are in a game that has not finished');
  const { changes } = db.prepare(
    'DELETE FROM lobby_players WHERE lobby_id = ? AND player_id = ?').run(lobby.id, playerId);
  return Number(changes) > 0;
}

// open -> live. Creating the first game does this automatically too.
export function startLobby(db, code) {
  const lobby = requireLobby(db, code);
  if (lobby.status !== 'open') throw new Error(`lobby is '${lobby.status}', expected 'open'`);
  db.prepare("UPDATE lobbies SET status = 'live' WHERE id = ?").run(lobby.id);
  return requireLobby(db, code);
}

// open/live -> closed. Refused while any game is unfinished, so no money is left hanging.
export function closeLobby(db, code) {
  return transaction(db, () => {
    const lobby = requireLobby(db, code);
    if (lobby.status === 'closed') throw new Error('lobby is already closed');
    const open = db.prepare(
      `SELECT COUNT(*) AS n FROM games WHERE lobby_id = ? AND status IN ${UNFINISHED}`).get(lobby.id).n;
    if (open) throw new Error(`${open} game(s) in this lobby have not finished`);
    db.prepare("UPDATE lobbies SET status = 'closed' WHERE id = ?").run(lobby.id);
    return requireLobby(db, code);
  });
}

export function lobbyPlayers(db, lobbyId) {
  return db.prepare(`SELECT p.id, u.name, p.tier FROM lobby_players lp
                     JOIN players p ON p.id = lp.player_id JOIN users u ON u.id = p.user_id
                     WHERE lp.lobby_id = ? ORDER BY lp.joined_at, p.id`).all(lobbyId);
}

// What someone holding an invite link may see before logging in.
export function lobbyPreview(db, code, publicUrl = '') {
  const lobby = requireLobby(db, code);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM lobby_players WHERE lobby_id = ?').get(lobby.id);
  return {
    name: lobby.name, location: lobby.location, startsAt: lobby.starts_at, tier: lobby.tier,
    stakeCents: lobby.stake_cents, status: lobby.status, joinCode: lobby.join_code,
    playerCount: n, invitePath: `/join/${lobby.join_code}`, inviteUrl: publicUrl ? `${publicUrl}/join/${lobby.join_code}` : null,
  };
}
