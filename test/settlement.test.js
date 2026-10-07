import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePayouts } from '../src/settlement.js';
import { startGame, reportScore, confirmScore, contestGame, expireGames, resolveContest, balanceCents } from '../src/games.js';
import { freshDb, setupGame } from './helpers.js';

test('computePayouts matches the schema example: 10 x $5 at 30% rake', () => {
  assert.deepEqual(
    computePayouts({ stakeCents: 500, playerCount: 10, winnerCount: 5, rakePercent: 30 }),
    { pot: 5000, rake: 1500, perWinner: 700, houseCents: 1500 });
});

test('computePayouts keeps leftover cents with the house', () => {
  // pot 3 x 500 = 1500, rake 30% = 450, net 1050 split 2 ways = 525 each, no remainder
  // pot 7 x 500 = 3500, rake 30% = 1050, net 2450 split 3 ways = 816 each, 2 cents left over
  const r = computePayouts({ stakeCents: 500, playerCount: 7, winnerCount: 3, rakePercent: 30 });
  assert.equal(r.perWinner, 816);
  assert.equal(r.houseCents, 1050 + 2);
  assert.equal(r.perWinner * 3 + r.houseCents, r.pot); // every cent accounted for
});

test('computePayouts rejects games with no winner or no loser', () => {
  assert.throws(() => computePayouts({ stakeCents: 500, playerCount: 10, winnerCount: 0, rakePercent: 30 }));
  assert.throws(() => computePayouts({ stakeCents: 500, playerCount: 10, winnerCount: 10, rakePercent: 30 }));
});

test('full game: entry fees, payouts, records and balances', () => {
  const db = freshDb();
  const { gameId, teams } = setupGame(db);
  startGame(db, gameId);
  for (const id of [...teams.a, ...teams.b]) assert.equal(balanceCents(db, id), -500);

  reportScore(db, gameId, 21, 15);
  assert.equal(confirmScore(db, gameId, teams.a[0]), null); // one team is not enough
  const result = confirmScore(db, gameId, teams.b[0]);

  assert.equal(result.perWinner, 700);
  for (const id of teams.a) {
    assert.equal(balanceCents(db, id), 200); // -500 + 700
    const p = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
    assert.deepEqual([p.wins, p.losses, p.games_played], [1, 0, 1]);
  }
  for (const id of teams.b) {
    assert.equal(balanceCents(db, id), -500);
    const p = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
    assert.deepEqual([p.wins, p.losses, p.games_played], [0, 1, 1]);
  }
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  assert.equal(g.status, 'locked');
  assert.ok(g.locked_at);
});

test('money conservation: ledger sums to minus the house take', () => {
  const db = freshDb();
  const { gameId, teams } = setupGame(db);
  startGame(db, gameId);
  reportScore(db, gameId, 10, 21);
  confirmScore(db, gameId, teams.a[0]);
  const result = confirmScore(db, gameId, teams.b[0]);
  const total = db.prepare('SELECT SUM(amount_cents) AS t FROM ledger').get().t;
  assert.equal(total, -result.houseCents);
});

test('a game cannot be settled twice', () => {
  const db = freshDb();
  const { gameId, teams } = setupGame(db);
  startGame(db, gameId);
  reportScore(db, gameId, 21, 15);
  confirmScore(db, gameId, teams.a[0]);
  confirmScore(db, gameId, teams.b[0]);
  assert.throws(() => confirmScore(db, gameId, teams.b[0]), /expected 'pending_confirm'/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type = 'payout'").get().n, 5);
});

test('rookies promote after 5 wins, with a promo credit', () => {
  const db = freshDb();
  const { gameId, teams, lobbyId } = setupGame(db);
  // Give team a four prior wins so this game is their fifth.
  db.prepare(`UPDATE players SET wins = 4, games_played = 4 WHERE id IN (${teams.a.join(',')})`).run();
  startGame(db, gameId);
  reportScore(db, gameId, 21, 15);
  confirmScore(db, gameId, teams.a[0]);
  const result = confirmScore(db, gameId, teams.b[0]);

  assert.equal(result.promotions.length, 5);
  for (const id of teams.a) {
    const p = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
    assert.equal(p.tier, 'starter');
    assert.ok(p.promoted_at);
    assert.equal(balanceCents(db, id), -500 + 700 + 1000); // promo credit = starter minimum stake
  }
  // Losers had 0 wins and 1 game, so they stay rookies.
  for (const id of teams.b) {
    assert.equal(db.prepare('SELECT tier FROM players WHERE id = ?').get(id).tier, 'rookie');
  }
  assert.ok(lobbyId);
});

test('rookies also promote on games played, win or lose', () => {
  const db = freshDb();
  const { gameId, teams } = setupGame(db);
  db.prepare(`UPDATE players SET losses = 9, games_played = 9 WHERE id IN (${teams.b.join(',')})`).run();
  startGame(db, gameId);
  reportScore(db, gameId, 21, 15);
  confirmScore(db, gameId, teams.a[0]);
  confirmScore(db, gameId, teams.b[0]);
  for (const id of teams.b) {
    assert.equal(db.prepare('SELECT tier FROM players WHERE id = ?').get(id).tier, 'starter');
  }
});

test('starter promotes to star at 10 wins, star is capped by superstar criteria', () => {
  const db = freshDb();
  const { gameId, teams } = setupGame(db, { tier: 'starter', stakeCents: 1000 });
  db.prepare(`UPDATE players SET wins = 9, games_played = 9`).run();
  startGame(db, gameId);
  reportScore(db, gameId, 21, 15);
  confirmScore(db, gameId, teams.a[0]);
  const result = confirmScore(db, gameId, teams.b[0]);
  assert.equal(result.promotions.length, 5);
  assert.ok(result.promotions.every((p) => p.to === 'star'));
  assert.equal(balanceCents(db, teams.a[0]), -1000 + result.perWinner + 1500);
});

test('superstar is the top: nobody promotes past it', () => {
  const db = freshDb();
  const { gameId, teams } = setupGame(db, { tier: 'superstar', stakeCents: 2500 });
  db.prepare(`UPDATE players SET wins = 99, games_played = 99`).run();
  startGame(db, gameId);
  reportScore(db, gameId, 21, 15);
  confirmScore(db, gameId, teams.a[0]);
  assert.deepEqual(confirmScore(db, gameId, teams.b[0]).promotions, []);
});

test('contested games hold their money: no payouts, no record changes', () => {
  const db = freshDb();
  const { gameId, teams } = setupGame(db);
  startGame(db, gameId);
  reportScore(db, gameId, 21, 15);
  contestGame(db, gameId, teams.b[0]);
  assert.equal(db.prepare('SELECT status FROM games WHERE id = ?').get(gameId).status, 'contested');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type = 'payout'").get().n, 0);
  assert.throws(() => confirmScore(db, gameId, teams.a[0]));
});

test('an uncontested score locks and settles when the window lapses', () => {
  const db = freshDb();
  const { gameId, teams } = setupGame(db);
  startGame(db, gameId);
  const t0 = new Date('2026-10-11T10:00:00Z');
  reportScore(db, gameId, 21, 15, t0);
  assert.deepEqual(expireGames(db, new Date(t0.getTime() + 19 * 60000)), []);
  assert.deepEqual(expireGames(db, new Date(t0.getTime() + 20 * 60000)), [gameId]);
  assert.equal(db.prepare('SELECT status FROM games WHERE id = ?').get(gameId).status, 'locked');
  assert.equal(balanceCents(db, teams.a[0]), 200);
  assert.deepEqual(expireGames(db, new Date(t0.getTime() + 60 * 60000)), []); // not again
});

test('a contested game is not auto-settled by the window', () => {
  const db = freshDb();
  const { gameId, teams } = setupGame(db);
  startGame(db, gameId);
  const t0 = new Date('2026-10-11T10:00:00Z');
  reportScore(db, gameId, 21, 15, t0);
  contestGame(db, gameId, teams.b[0]);
  assert.deepEqual(expireGames(db, new Date(t0.getTime() + 60 * 60000)), []);
});

test('admin can resolve a contest by naming the winner', () => {
  const db = freshDb();
  const { gameId, teams } = setupGame(db);
  startGame(db, gameId);
  reportScore(db, gameId, 21, 15);
  contestGame(db, gameId, teams.b[0]);
  resolveContest(db, gameId, 'b'); // overturn: b actually won
  assert.equal(balanceCents(db, teams.b[0]), 200);
  assert.equal(balanceCents(db, teams.a[0]), -500);
  assert.equal(db.prepare('SELECT status FROM games WHERE id = ?').get(gameId).status, 'locked');
});

test('voiding a contest refunds entry fees and leaves records alone', () => {
  const db = freshDb();
  const { gameId, teams } = setupGame(db);
  startGame(db, gameId);
  reportScore(db, gameId, 21, 15);
  contestGame(db, gameId, teams.a[0]);
  resolveContest(db, gameId, null);
  for (const id of [...teams.a, ...teams.b]) {
    assert.equal(balanceCents(db, id), 0);
    assert.equal(db.prepare('SELECT games_played FROM players WHERE id = ?').get(id).games_played, 0);
  }
  assert.equal(db.prepare('SELECT status FROM games WHERE id = ?').get(gameId).status, 'void');
  assert.throws(() => resolveContest(db, gameId, 'a'), /expected 'contested'/);
});
