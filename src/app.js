import express from 'express';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLobby, findLobbyByCode, joinLobby, leaveLobby, startLobby, closeLobby, lobbyPlayers, lobbyPreview } from './lobbies.js';
import {
  createUser, createGame, startGame, reportScore,
  confirmScore, contestGame, resolveContest, markSettled, balanceCents,
} from './games.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const need = (cond, status, message) => { if (!cond) throw new HttpError(status, message); };

// adminPhones: phone numbers that get admin rights when they log in.
// publicUrl: site root used to build shareable invite links, e.g. https://royale.example.
export function createApp(db, { adminPhones = [], publicUrl = '' } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

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
    players: all(`SELECT gp.player_id, gp.team, u.name FROM game_players gp
                  JOIN players p ON p.id = gp.player_id JOIN users u ON u.id = p.user_id
                  WHERE gp.game_id = ? ORDER BY gp.team, u.name`, id),
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

  // Games you are in, newest first, with the lobby they belong to.
  app.get('/me/games', auth, (req, res) => {
    const rows = all(`SELECT g.id FROM games g JOIN game_players gp ON gp.game_id = g.id
                      WHERE gp.player_id = ? ORDER BY g.id DESC LIMIT 20`, req.user.player_id);
    res.json(rows.map((r) => {
      const game = gameView(r.id);
      const lobby = q('SELECT name, join_code FROM lobbies WHERE id = ?', game.lobby_id);
      return { ...game, lobbyName: lobby.name, lobbyCode: lobby.join_code,
               myTeam: game.players.find((p) => p.player_id === req.user.player_id)?.team };
    }));
  });

  // --- lobbies ----------------------------------------------------------
  app.get('/tiers', (_req, res) => res.json(all('SELECT * FROM tiers ORDER BY rank')));

  const lobbyOr404 = (code) => {
    const lobby = findLobbyByCode(db, code);
    need(lobby, 404, 'lobby not found');
    return lobby;
  };
  const lobbyView = (lobby) => ({
    ...lobby, ...lobbyPreviewLinks(lobby), players: lobbyPlayers(db, lobby.id),
    games: all('SELECT id FROM games WHERE lobby_id = ? ORDER BY id', lobby.id).map((g) => gameView(g.id)),
  });
  const lobbyPreviewLinks = (lobby) => {
    const { invitePath, inviteUrl } = lobbyPreview(db, lobby.join_code, publicUrl);
    return { invitePath, inviteUrl };
  };

  app.post('/lobbies', auth, admin, (req, res) => {
    const { id, joinCode } = createLobby(db, req.body ?? {});
    res.status(201).json(lobbyView(q('SELECT * FROM lobbies WHERE id = ?', id)));
  });

  // Open and live lobbies, each with how many are locked in, a few names, and whether you are one of them.
  app.get('/lobbies', auth, (req, res) => {
    const lobbies = all("SELECT * FROM lobbies WHERE status != 'closed' ORDER BY starts_at");
    res.json(lobbies.map((l) => {
      const players = lobbyPlayers(db, l.id);
      return {
        ...l, ...lobbyPreviewLinks(l), playerCount: players.length,
        playerNames: players.map((p) => p.name.trim().split(/\s+/)[0]),
        joined: players.some((p) => p.id === req.user.player_id),
      };
    }));
  });

  // Public: what an invite link shows before the person logs in.
  // Browsers following an invite link get the app; API clients get the JSON.
  app.get('/join/:code', (req, res, next) => {
    if (req.accepts(['json', 'html']) === 'html') return res.sendFile(join(PUBLIC_DIR, 'index.html'));
    next();
  }, (req, res) => {
    need(findLobbyByCode(db, req.params.code), 404, 'no lobby with that code');
    res.json(lobbyPreview(db, req.params.code, publicUrl));
  });

  app.get('/lobbies/:code', auth, (req, res) => res.json(lobbyView(lobbyOr404(req.params.code))));

  app.post('/lobbies/:code/join', auth, (req, res) => {
    lobbyOr404(req.params.code);
    const { lobby, alreadyJoined } = joinLobby(db, req.params.code, req.user.player_id);
    res.status(alreadyJoined ? 200 : 201).json({ alreadyJoined, lobby: lobbyView(lobby) });
  });

  app.post('/lobbies/:code/leave', auth, (req, res) => {
    lobbyOr404(req.params.code);
    res.json({ left: leaveLobby(db, req.params.code, req.user.player_id) });
  });

  app.post('/lobbies/:code/start', auth, admin, (req, res) => {
    lobbyOr404(req.params.code);
    res.json(lobbyView(startLobby(db, req.params.code)));
  });

  app.post('/lobbies/:code/close', auth, admin, (req, res) => {
    lobbyOr404(req.params.code);
    res.json(lobbyView(closeLobby(db, req.params.code)));
  });

  // --- games ------------------------------------------------------------
  app.post('/lobbies/:code/games', auth, admin, (req, res) => {
    const lobby = lobbyOr404(req.params.code);
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
    const rows = all(`SELECT p.id AS playerId, u.name, SUM(l.amount_cents) AS owedCents,
                             GROUP_CONCAT(l.id) AS ids
                      FROM ledger l JOIN players p ON p.id = l.player_id JOIN users u ON u.id = p.user_id
                      WHERE l.settled = 0 GROUP BY p.id HAVING owedCents != 0 ORDER BY owedCents`);
    res.json(rows.map(({ ids, ...r }) => ({ ...r, ledgerIds: ids.split(',').map(Number) })));
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
