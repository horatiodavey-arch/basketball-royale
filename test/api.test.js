import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { freshDb } from './helpers.js';

let server, base;
before(async () => {
  const app = createApp(freshDb(), { adminPhones: ['000'] });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const login = async (name, phone) => (await call('POST', '/auth/login', { body: { name, phone } })).body.token;

test('auth: login required, admin required, phone required', async () => {
  assert.equal((await call('GET', '/me')).status, 401);
  assert.equal((await call('POST', '/auth/login', { body: { name: 'x' } })).status, 400);
  const t = await login('Rook', '111');
  assert.equal((await call('POST', '/lobbies', { token: t, body: {} })).status, 403);
  const me = await call('GET', '/me', { token: t });
  assert.equal(me.body.player.tier, 'rookie');
  assert.equal(me.body.user.isAdmin, false);
});

test('full run over HTTP: lobby, join, game, confirm, settle, cash out', async () => {
  const admin = await login('Coach', '000');
  const made = await call('POST', '/lobbies', {
    token: admin,
    body: { name: 'Sunday Run', startsAt: '2026-10-11T10:00', tier: 'rookie', stakeCents: 500, joinCode: 'SUN24' },
  });
  assert.equal(made.status, 201);
  assert.equal((await call('POST', '/lobbies', { token: admin, body: { name: 'x', startsAt: 't', tier: 'rookie', stakeCents: 900 } })).status, 400);

  const tokens = [];
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const t = await login(`P${i}`, `20${i}`);
    tokens.push(t);
    assert.equal((await call('POST', '/lobbies/sun24/join', { token: t })).status, 201);
    ids.push((await call('GET', '/me', { token: t })).body.player.id);
  }
  assert.equal((await call('GET', '/lobbies/SUN24', { token: admin })).body.players.length, 4);

  // The game can't include someone who never joined.
  const stranger = await login('Stranger', '999');
  const strangerId = (await call('GET', '/me', { token: stranger })).body.player.id;
  const bad = await call('POST', '/lobbies/SUN24/games', { token: admin, body: { teams: { a: [ids[0], strangerId], b: [ids[2], ids[3]] } } });
  assert.equal(bad.status, 400);

  const game = await call('POST', '/lobbies/SUN24/games', { token: admin, body: { teams: { a: [ids[0], ids[1]], b: [ids[2], ids[3]] } } });
  const gid = game.body.id;
  assert.equal(game.body.status, 'forming');
  assert.equal((await call('POST', `/games/${gid}/start`, { token: tokens[0] })).status, 403);
  await call('POST', `/games/${gid}/start`, { token: admin });

  assert.equal((await call('POST', `/games/${gid}/score`, { token: stranger, body: { teamAScore: 21, teamBScore: 10 } })).status, 403);
  assert.equal((await call('POST', `/games/${gid}/score`, { token: tokens[0], body: { teamAScore: 21, teamBScore: 21 } })).status, 400);
  await call('POST', `/games/${gid}/score`, { token: tokens[0], body: { teamAScore: 21, teamBScore: 10 } });

  assert.equal((await call('POST', `/games/${gid}/confirm`, { token: stranger })).status, 403);
  assert.equal((await call('POST', `/games/${gid}/confirm`, { token: tokens[0] })).body.settlement, null);
  const done = await call('POST', `/games/${gid}/confirm`, { token: tokens[2] });
  assert.equal(done.body.game.status, 'locked');
  // pot 4 x 500 = 2000, rake 30% = 600, 1400 / 2 winners = 700 each
  assert.equal(done.body.settlement.perWinner, 700);

  assert.equal((await call('GET', '/me', { token: tokens[0] })).body.balanceCents, 200);
  assert.equal((await call('GET', '/me', { token: tokens[2] })).body.balanceCents, -500);

  // Collector sees who owes what, then marks a payment received.
  const balances = (await call('GET', '/admin/balances', { token: admin })).body;
  assert.equal(balances.length, 4);
  assert.equal((await call('GET', '/admin/balances', { token: tokens[0] })).status, 403);
  const ledger = (await call('GET', '/me/ledger', { token: tokens[2] })).body;
  const settled = await call('POST', '/admin/ledger/settle', { token: admin, body: { ledgerIds: ledger.map((r) => r.id) } });
  assert.equal(settled.body.settled, 1);
  assert.equal((await call('GET', '/me', { token: tokens[2] })).body.owedCents, 0);
});

test('contest and admin resolution over HTTP', async () => {
  const admin = await login('Coach', '000');
  await call('POST', '/lobbies', { token: admin, body: { name: 'Run 2', startsAt: '2026-10-12T10:00', tier: 'rookie', stakeCents: 500, joinCode: 'RUN2' } });
  const t = [], ids = [];
  for (let i = 0; i < 2; i++) {
    const tok = await login(`Q${i}`, `30${i}`);
    t.push(tok);
    await call('POST', '/lobbies/RUN2/join', { token: tok });
    ids.push((await call('GET', '/me', { token: tok })).body.player.id);
  }
  const gid = (await call('POST', '/lobbies/RUN2/games', { token: admin, body: { teams: { a: [ids[0]], b: [ids[1]] } } })).body.id;
  await call('POST', `/games/${gid}/start`, { token: admin });
  await call('POST', `/games/${gid}/score`, { token: t[0], body: { teamAScore: 11, teamBScore: 9 } });
  assert.equal((await call('POST', `/games/${gid}/contest`, { token: t[1] })).body.status, 'contested');
  assert.equal((await call('POST', `/games/${gid}/resolve`, { token: t[1], body: { winner: null } })).status, 403);
  assert.equal((await call('POST', `/games/${gid}/resolve`, { token: admin, body: {} })).status, 400);
  const voided = await call('POST', `/games/${gid}/resolve`, { token: admin, body: { winner: null } });
  assert.equal(voided.body.game.status, 'void');
  assert.equal((await call('GET', '/me', { token: t[0] })).body.balanceCents, 0);
});

test('wrong-tier players cannot join, unknown routes 404', async () => {
  const admin = await login('Coach', '000');
  await call('POST', '/lobbies', { token: admin, body: { name: 'Starters', startsAt: '2026-10-13T10:00', tier: 'starter', stakeCents: 1000, joinCode: 'STAR1' } });
  const t = await login('Newbie', '400');
  const res = await call('POST', '/lobbies/STAR1/join', { token: t });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /starter/);
  assert.equal((await call('GET', '/nope')).status, 404);
});

test('invite flow: generated code, public preview, join by link code, leave, close', async () => {
  const admin = await login('Coach', '000');
  const made = await call('POST', '/lobbies', {
    token: admin, body: { name: 'Invite Run', startsAt: '2026-10-14T10:00', tier: 'rookie', stakeCents: 500 },
  });
  assert.equal(made.status, 201);
  const code = made.body.join_code;
  assert.match(code, /^[A-Z2-9]{5}$/);
  assert.equal(made.body.invitePath, `/join/${code}`);

  // Anyone with the link can preview, no login, no roster leak.
  const preview = await call('GET', `/join/${code.toLowerCase()}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.name, 'Invite Run');
  assert.deepEqual(preview.body.players, []);
  assert.equal((await call('GET', '/join/ZZZZZ')).status, 404);

  const t = await login('Joiner', '500');
  assert.equal((await call('POST', `/lobbies/${code}/join`, { token: t })).status, 201);
  assert.equal((await call('POST', `/lobbies/${code}/join`, { token: t })).status, 200);
  assert.equal((await call('GET', `/join/${code}`)).body.playerCount, 1);
  assert.equal((await call('POST', `/lobbies/${code}/start`, { token: t })).status, 403);
  assert.equal((await call('POST', `/lobbies/${code}/start`, { token: admin })).body.status, 'live');

  assert.equal((await call('POST', `/lobbies/${code}/leave`, { token: t })).body.left, true);
  assert.equal((await call('POST', `/lobbies/${code}/close`, { token: admin })).body.status, 'closed');
  assert.equal((await call('POST', `/lobbies/${code}/join`, { token: t })).status, 400);
  assert.ok(!(await call('GET', '/lobbies', { token: t })).body.some((l) => l.join_code === code));
});

test('home-screen data: lobby list with roster and joined flag, my games, game names', async () => {
  const admin = await login('Coach', '000');
  const code = (await call('POST', '/lobbies', { token: admin, body: { name: 'Home Run', startsAt: '2026-10-15T10:00', tier: 'rookie', stakeCents: 500 } })).body.join_code;
  const a = await login('Darius Jones', '600');
  const b = await login('Chris Lee', '601');
  await call('POST', `/lobbies/${code}/join`, { token: a });
  await call('POST', `/lobbies/${code}/join`, { token: b });

  const list = (await call('GET', '/lobbies', { token: a })).body.find((l) => l.join_code === code);
  assert.equal(list.playerCount, 2);
  assert.deepEqual(list.playerNames, ['Darius', 'Chris']);
  assert.equal(list.joined, true);
  assert.equal((await call('GET', '/lobbies', { token: admin })).body.find((l) => l.join_code === code).joined, false);

  const ids = [(await call('GET', '/me', { token: a })).body.player.id, (await call('GET', '/me', { token: b })).body.player.id];
  const game = (await call('POST', `/lobbies/${code}/games`, { token: admin, body: { teams: { a: [ids[0]], b: [ids[1]] } } })).body;
  assert.deepEqual(game.players.map((p) => p.name), ['Darius Jones', 'Chris Lee']);

  const mine = (await call('GET', '/me/games', { token: a })).body;
  assert.equal(mine[0].id, game.id);
  assert.equal(mine[0].myTeam, 'a');
  assert.equal(mine[0].lobbyCode, code);
  assert.equal((await call('GET', `/lobbies/${code}`, { token: a })).body.games.length, 1);

  await call('POST', `/games/${game.id}/start`, { token: admin });
  const bal = (await call('GET', '/admin/balances', { token: admin })).body.find((r) => r.name === 'Darius Jones');
  assert.equal(bal.owedCents, -500);
  assert.equal(bal.ledgerIds.length, 1);
});

test('the app shell is served, and invite links open it for browsers only', async () => {
  const root = await fetch(`${base}/`);
  assert.match(await root.text(), /Basketball Royale/);
  const link = await fetch(`${base}/join/ANYCODE`, { headers: { accept: 'text/html,application/xhtml+xml' } });
  assert.match(link.headers.get('content-type'), /html/);
  const api = await fetch(`${base}/join/ANYCODE`);
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type'), /json/);
});
