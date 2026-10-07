import express from 'express';
import { randomBytes } from 'node:crypto';
import {
  createUser, createLobby, findLobbyByCode, createGame, startGame, reportScore,
  confirmScore, contestGame, resolveContest, markSettled, balanceCents,
} from './games.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const need = (cond, status, message) => { if (!cond) throw new HttpError(status, message); };

// adminPhones: phone numbers that get admin rights when they log in.
export function createApp(db, { adminPhones = [] } = {}) {
  const app = express();
  app.use(express.json());

  const q = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);

  function auth(req, _res, next) {
    const token = (req.get('authorization') ?? '').replace(/^Bearer /, '');
    const row = token && q(`SELECT u.*, p.id AS player_id FROM sessions s
                            JOIN users u ON u.id = s.user_id
                            JOIN players p ON p.user_id = u.id WHERE s.token = ?`, token);
    need(row, 401, 'login required');
    req.user = row;
    next();
  }
  const admin = (req, _res, next) => { need(req.user.is_admin, 403, 'admin only'); next(); };
  const inGame = (gameId, playerId) =>
    q('SELECT 1 AS ok FROM game_players WHERE game_id = ? AND player_id = ?', gameId, playerId);
  const loadGame = (id) => {
    const game = q('SELECT * FROM games WHERE id = ?', id);
    need(game, 404, 'game not found');
    return game;
  };
  const gameView = (id) => ({
    ...loadGame(id),
    players: all('SELECT player_id, team FROM game_players WHERE game_id = ?', id),
  });

  // --- auth -------------------------------------------------------------
  // v1: phone + name, no SMS verification. Anyone who knows a phone can log in as it.
  app.post('/auth/login', (req, res) => {
    const { name, phone } = req.body ?? {};
    need(typeof phone === 'string' && phone.trim(), 400, 'phone is required');
    let user = q('SELECT * FROM users WHERE phone = ?', phone);
    if (!user) {
      need(typeof name === 'string' && name.trim(), 400, 'name is required for a new account');
      createUser(db, { name: name.trim(), phone });
      user = q('SELECT * FROM users WHERE phone = ?', phone);
    }
    if (adminPhones.includes(phone) && !user.is_admin) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
    }
    const token = randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
    res.json({ token });
  });

  app.get('/me', auth, (req, res) => {
    const player = q('SELECT * FROM players WHERE id = ?', req.user.player_id);
    res.json({
      user: { id: req.user.id, name: req.user.name, isAdmin: Boolean(req.user.is_admin) },
      player,
      balanceCents: balanceCents(db, player.id),
      owedCents: balanceCents(db, player.id, { unsettledOnly: true }),
    });
  });

  app.get('/me/ledger', auth, (req, res) => {
    res.json(all('SELECT * FROM ledger WHERE player_id = ? ORDER BY id', req.user.player_id));
  });

  // --- lobbies ----------------------------------------------------------
  app.get('/tiers', (_req, res) => res.json(all('SELECT * FROM tiers ORDER BY rank')));

  app.post('/lobbies', auth, admin, (req, res) => {
    res.status(201).json({ id: createLobby(db, req.body ?? {}) });
  });

  app.get('/lobbies', auth, (_req, res) => {
    res.json(all("SELECT * FROM lobbies WHERE status != 'closed' ORDER BY starts_at"));
  });

  app.get('/lobbies/:code', auth, (req, res) => {
    const lobby = findLobbyByCode(db, req.params.code);
    need(lobby, 404, 'lobby not found');
    res.json({
      ...lobby,
      players: all(`SELECT p.id, u.name, p.tier FROM lobby_players lp
                    JOIN players p ON p.id = lp.player_id JOIN users u ON u.id = p.user_id
                    WHERE lp.lobby_id = ?`, lobby.id),
    });
  });

  app.post('/lobbies/:code/join', auth, (req, res) => {
    const lobby = findLobbyByCode(db, req.params.code);
    need(lobby, 404, 'lobby not found');
    need(lobby.status !== 'closed', 400, 'lobby is closed');
    const player = q('SELECT * FROM players WHERE id = ?', req.user.player_id);
    need(player.tier === lobby.tier, 400, `this lobby is for ${lobby.tier} players, you are ${player.tier}`);
    db.prepare('INSERT OR IGNORE INTO lobby_players (lobby_id, player_id) VALUES (?, ?)').run(lobby.id, player.id);
    res.json({ lobbyId: lobby.id });
  });

  // --- games ------------------------------------------------------------
  app.post('/lobbies/:code/games', auth, admin, (req, res) => {
    const lobby = findLobbyByCode(db, req.params.code);
    need(lobby, 404, 'lobby not found');
    const { teams } = req.body ?? {};
    need(Array.isArray(teams?.a) && Array.isArray(teams?.b), 400, 'teams.a and teams.b are required');
    const joined = new Set(all('SELECT player_id FROM lobby_players WHERE lobby_id = ?', lobby.id).map((r) => r.player_id));
    for (const id of [...teams.a, ...teams.b]) need(joined.has(id), 400, `player ${id} has not joined this lobby`);
    res.status(201).json(gameView(createGame(db, lobby.id, teams)));
  });

  app.get('/games/:id', auth, (req, res) => res.json(gameView(Number(req.params.id))));

  app.post('/games/:id/start', auth, admin, (req, res) => {
    startGame(db, Number(req.params.id));
    res.json(gameView(Number(req.params.id)));
  });

  // A rostered player or an admin reports the final score.
  app.post('/games/:id/score', auth, (req, res) => {
    const id = Number(req.params.id);
    loadGame(id);
    need(req.user.is_admin || inGame(id, req.user.player_id), 403, 'only players in the game can report the score');
    reportScore(db, id, req.body?.teamAScore, req.body?.teamBScore);
    res.json(gameView(id));
  });

  app.post('/games/:id/confirm', auth, (req, res) => {
    const id = Number(req.params.id);
    loadGame(id);
    need(inGame(id, req.user.player_id), 403, 'only players in the game can confirm');
    const settlement = confirmScore(db, id, req.user.player_id);
    res.json({ game: gameView(id), settlement });
  });

  app.post('/games/:id/contest', auth, (req, res) => {
    const id = Number(req.params.id);
    loadGame(id);
    need(inGame(id, req.user.player_id), 403, 'only players in the game can contest');
    contestGame(db, id, req.user.player_id);
    res.json(gameView(id));
  });

  // Body: { winner: 'a' | 'b' | null }. null voids the game and refunds entry fees.
  app.post('/games/:id/resolve', auth, admin, (req, res) => {
    const id = Number(req.params.id);
    need(req.body && 'winner' in req.body, 400, "winner is required ('a', 'b' or null)");
    const settlement = resolveContest(db, id, req.body.winner);
    res.json({ game: gameView(id), settlement });
  });

  // --- cash -------------------------------------------------------------
  // Everyone's outstanding balances, for the person collecting at the run.
  app.get('/admin/balances', auth, admin, (_req, res) => {
    res.json(all(`SELECT p.id AS playerId, u.name, SUM(l.amount_cents) AS owedCents
                  FROM ledger l JOIN players p ON p.id = l.player_id JOIN users u ON u.id = p.user_id
                  WHERE l.settled = 0 GROUP BY p.id HAVING owedCents != 0 ORDER BY owedCents`));
  });

  app.post('/admin/ledger/settle', auth, admin, (req, res) => {
    const { ledgerIds } = req.body ?? {};
    need(Array.isArray(ledgerIds) && ledgerIds.every(Number.isInteger), 400, 'ledgerIds must be an array of ids');
    res.json({ settled: markSettled(db, ledgerIds) });
  });

  // --- errors -----------------------------------------------------------
  app.use((_req, _res, next) => next(new HttpError(404, 'not found')));
  // Domain rules (bad state, bad input, constraint violations) are thrown as plain
  // Errors by the game layer and surface as 400s.
  app.use((err, _req, res, _next) => {
    const status = err.status ?? (err instanceof SyntaxError ? 400 : err instanceof Error ? 400 : 500);
    res.status(status).json({ error: err.message });
  });

  return app;
}
