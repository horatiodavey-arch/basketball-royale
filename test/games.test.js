import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLobby, createGame, createUser, findLobbyByCode, startGame, reportScore, confirmScore } from '../src/games.js';
import { openDb, migrate } from '../src/db.js';
import { freshDb, setupGame } from './helpers.js';

test('migrate is idempotent and records what it applied', () => {
  const db = openDb();
  assert.deepEqual(migrate(db), ['001_init.sql']);
  assert.deepEqual(migrate(db), []);
});

test('foreign keys are enforced', () => {
  const db = freshDb();
  assert.throws(() => db.prepare('INSERT INTO players (user_id) VALUES (999)').run());
});

test('lobby stake must fit the tier range', () => {
  const db = freshDb();
  assert.throws(() => createLobby(db, { name: 'x', startsAt: 't', tier: 'rookie', stakeCents: 1000 }), /outside/);
  assert.throws(() => createLobby(db, { name: 'x', startsAt: 't', tier: 'nope', stakeCents: 500 }), /unknown tier/);
});

test('join codes are found case-insensitively', () => {
  const db = freshDb();
  const { lobbyId } = setupGame(db);
  assert.equal(findLobbyByCode(db, 'sun24').id, lobbyId);
  assert.equal(findLobbyByCode(db, 'NOPE'), null);
});

test('players must match the lobby tier', () => {
  const db = freshDb();
  const lobbyId = createLobby(db, { name: 'x', startsAt: 't', tier: 'starter', stakeCents: 1000 });
  const { playerId } = createUser(db, { name: 'Rook' });
  assert.throws(() => createGame(db, lobbyId, { a: [playerId], b: [] }));
  const { playerId: p2 } = createUser(db, { name: 'Rook2' });
  assert.throws(() => createGame(db, lobbyId, { a: [playerId], b: [p2] }), /is 'rookie'/);
});

test('state machine rejects out-of-order moves', () => {
  const db = freshDb();
  const { gameId, teams } = setupGame(db);
  assert.throws(() => reportScore(db, gameId, 21, 15), /expected 'playing'/);
  assert.throws(() => confirmScore(db, gameId, teams.a[0]), /expected 'pending_confirm'/);
  startGame(db, gameId);
  assert.throws(() => startGame(db, gameId), /expected 'forming'/);
  assert.throws(() => reportScore(db, gameId, 15, 15), /tied/);
});

test('only rostered players can confirm', () => {
  const db = freshDb();
  const { gameId } = setupGame(db);
  const { playerId: outsider } = createUser(db, { name: 'Fan' });
  startGame(db, gameId);
  reportScore(db, gameId, 21, 15);
  assert.throws(() => confirmScore(db, gameId, outsider), /not in game/);
});
