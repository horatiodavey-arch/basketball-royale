import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLobby, generateJoinCode, joinLobby, leaveLobby, startLobby, closeLobby,
  lobbyPlayers, lobbyPreview, findLobbyByCode,
} from '../src/lobbies.js';
import { createUser, createGame, startGame, reportScore, confirmScore } from '../src/games.js';
import { freshDb, setupGame } from './helpers.js';

const lobbyArgs = { name: 'Run', startsAt: '2026-10-11T10:00', tier: 'rookie', stakeCents: 500 };

test('a join code is generated when none is given, from the unambiguous alphabet', () => {
  const db = freshDb();
  const codes = new Set();
  for (let i = 0; i < 25; i++) codes.add(createLobby(db, lobbyArgs).joinCode);
  assert.equal(codes.size, 25);
  for (const c of codes) assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
});

test('custom codes are normalised, validated and unique', () => {
  const db = freshDb();
  assert.equal(createLobby(db, { ...lobbyArgs, joinCode: ' sun24 ' }).joinCode, 'SUN24');
  assert.throws(() => createLobby(db, { ...lobbyArgs, joinCode: 'sun24' }), /already in use/);
  assert.throws(() => createLobby(db, { ...lobbyArgs, joinCode: 'ab' }), /4-10/);
  assert.throws(() => createLobby(db, { ...lobbyArgs, joinCode: 'no spaces!' }), /4-10/);
  assert.equal(findLobbyByCode(db, 'Sun24').join_code, 'SUN24');
});

test('lobby creation validates its fields', () => {
  const db = freshDb();
  assert.throws(() => createLobby(db, { ...lobbyArgs, name: '  ' }), /name/);
  assert.throws(() => createLobby(db, { ...lobbyArgs, startsAt: undefined }), /startsAt/);
  assert.throws(() => createLobby(db, { ...lobbyArgs, stakeCents: 5.5 }), /outside/);
});

test('joining is idempotent and tier-checked; leaving removes you', () => {
  const db = freshDb();
  const { joinCode, id } = createLobby(db, lobbyArgs);
  const { playerId } = createUser(db, { name: 'A' });
  assert.equal(joinLobby(db, joinCode.toLowerCase(), playerId).alreadyJoined, false);
  assert.equal(joinLobby(db, joinCode, playerId).alreadyJoined, true);
  assert.equal(lobbyPlayers(db, id).length, 1);

  const star = createLobby(db, { ...lobbyArgs, tier: 'star', stakeCents: 1500 });
  assert.throws(() => joinLobby(db, star.joinCode, playerId), /star players, you are rookie/);
  assert.throws(() => joinLobby(db, 'NOPE9', playerId), /no lobby/);

  assert.equal(leaveLobby(db, joinCode, playerId), true);
  assert.equal(leaveLobby(db, joinCode, playerId), false);
  assert.equal(lobbyPlayers(db, id).length, 0);
});

test('lobby lifecycle: open -> live -> closed, and closed lobbies refuse joiners', () => {
  const db = freshDb();
  const { joinCode } = createLobby(db, lobbyArgs);
  const { playerId } = createUser(db, { name: 'A' });
  assert.equal(startLobby(db, joinCode).status, 'live');
  assert.throws(() => startLobby(db, joinCode), /expected 'open'/);
  assert.equal(joinLobby(db, joinCode, playerId).alreadyJoined, false); // late arrivals welcome
  assert.equal(closeLobby(db, joinCode).status, 'closed');
  assert.throws(() => closeLobby(db, joinCode), /already closed/);
  const { playerId: late } = createUser(db, { name: 'Late' });
  assert.throws(() => joinLobby(db, joinCode, late), /closed/);
});

test('the first game makes the lobby live; closed lobbies take no games', () => {
  const db = freshDb();
  const { lobbyId, teams } = setupGame(db);
  assert.equal(db.prepare('SELECT status FROM lobbies WHERE id = ?').get(lobbyId).status, 'live');
  const other = createLobby(db, lobbyArgs);
  closeLobby(db, other.joinCode);
  assert.throws(() => createGame(db, other.id, teams), /closed/);
});

test('a lobby cannot close, and a player cannot leave, mid-game', () => {
  const db = freshDb();
  const { gameId, teams } = setupGame(db);
  for (const id of [...teams.a, ...teams.b]) joinLobby(db, 'SUN24', id);
  assert.throws(() => closeLobby(db, 'SUN24'), /not finished/);
  assert.throws(() => leaveLobby(db, 'SUN24', teams.a[0]), /not finished/);

  startGame(db, gameId);
  reportScore(db, gameId, 21, 15);
  confirmScore(db, gameId, teams.a[0]);
  confirmScore(db, gameId, teams.b[0]);

  assert.equal(leaveLobby(db, 'SUN24', teams.a[0]), true);
  assert.equal(closeLobby(db, 'SUN24').status, 'closed');
});

test('invite preview exposes the lobby and the first names of who is locked in', () => {
  const db = freshDb();
  const { joinCode } = createLobby(db, { ...lobbyArgs, location: 'Rucker Park', joinCode: 'SUN24' });
  const { playerId } = createUser(db, { name: 'Darius Jones' });
  joinLobby(db, joinCode, playerId);
  const preview = lobbyPreview(db, 'sun24', 'https://royale.example');
  assert.deepEqual(preview, {
    name: 'Run', location: 'Rucker Park', startsAt: '2026-10-11T10:00', tier: 'rookie',
    stakeCents: 500, status: 'open', joinCode: 'SUN24', playerCount: 1, players: ['Darius'],
    invitePath: '/join/SUN24', inviteUrl: 'https://royale.example/join/SUN24',
  });
  assert.equal(lobbyPreview(db, 'SUN24').inviteUrl, null);
});

test('generateJoinCode never repeats an existing code', () => {
  const db = freshDb();
  const { joinCode } = createLobby(db, lobbyArgs);
  for (let i = 0; i < 100; i++) assert.notEqual(generateJoinCode(db, 4), joinCode);
});
