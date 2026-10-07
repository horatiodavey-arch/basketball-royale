import { openDb, migrate } from '../src/db.js';
import { createUser, createLobby, createGame } from '../src/games.js';

export function freshDb() {
  const db = openDb();
  migrate(db);
  return db;
}

// A lobby plus a game with `perTeam` players per side, all rookies.
export function setupGame(db, { perTeam = 5, tier = 'rookie', stakeCents = 500 } = {}) {
  const lobbyId = createLobby(db, { name: 'Sunday Run', startsAt: '2026-10-11T10:00', tier, stakeCents, joinCode: 'SUN24' });
  const make = (prefix) => Array.from({ length: perTeam }, (_, i) => {
    const { playerId } = createUser(db, { name: `${prefix}${i}`, phone: `${prefix}${i}` });
    if (tier !== 'rookie') db.prepare('UPDATE players SET tier = ? WHERE id = ?').run(tier, playerId);
    return playerId;
  });
  const teams = { a: make('a'), b: make('b') };
  return { lobbyId, teams, gameId: createGame(db, lobbyId, teams) };
}
