// Game now: a checked-in player starts a game on a court that's free, others
// join a side, any player in the game reports it done, and a player from the
// other team confirms. Every 10 minutes the players in a game are asked
// "Did you win?". A Yes from one side and a No from the other settles it.
// Points are still awarded by lockResult, once a result is confirmed.
const { db, lastId } = require('./index');
const q = require('./queries');

const FORMATS = ['5v5', '4v4', '3v3', '2v2', '1v1'];
const SIDES = ['a', 'b'];
const ANSWERS = ['yes', 'no', 'still'];
const POLL_MINUTES = 10;

const fail = (error) => ({ ok: false, error });
const gameFor = (id) => db.prepare('SELECT * FROM live_games WHERE id = ?').get(id);
const activeRows = (gameId) =>
  db.prepare('SELECT player_id, team FROM live_game_players WHERE live_game_id = ? AND time_off IS NULL').all(gameId);

function startGame(courtId, playerId, format, side) {
  const court = q.getCourtById(courtId);
  if (!court) return fail('Court not found.');
  if (!q.getCheckIn(playerId, court.park_id)) return fail('Check in at the park first.');
  if (!FORMATS.includes(format)) return fail('Pick a format first.');
  if (!SIDES.includes(side)) return fail('Pick a side.');
  if (q.getActiveLiveGame(courtId)) return fail('A game is already on this court. Join it, or wait for it to finish.');
  if (q.isPlayerInActiveLiveGame(courtId, playerId)) return fail("You're already in the game on this court.");

  const park = q.getParkById(court.park_id);
  db.prepare(
    "INSERT INTO live_games (court_id, park_id, target, status, started_at, format) VALUES (?, ?, ?, 'in_progress', datetime('now'), ?)"
  ).run(courtId, park.id, park.game_target, format);
  const liveGameId = lastId();
  db.prepare(
    "INSERT INTO live_game_players (live_game_id, player_id, team, captain, time_on) VALUES (?, ?, ?, 1, datetime('now'))"
  ).run(liveGameId, playerId, side);
  db.prepare('UPDATE courts SET format = ? WHERE id = ?').run(format, courtId);
  q.logEvent(playerId, 'game_started', null, park.id);
  return { ok: true, liveGameId };
}

function joinGame(liveGameId, playerId, side) {
  const game = gameFor(liveGameId);
  if (!game || game.status !== 'in_progress') return fail('No game is on right now.');
  if (!q.getCheckIn(playerId, game.park_id)) return fail('Check in at the park first.');
  if (!SIDES.includes(side)) return fail('Pick a side.');
  const rows = activeRows(liveGameId);
  if (rows.some((r) => r.player_id === playerId)) return fail("You're already in this game.");
  const size = q.formatSize(game.format);
  if (size && rows.filter((r) => r.team === side).length >= size) {
    return fail(`Side ${side.toUpperCase()} is full.`);
  }
  db.prepare(
    "INSERT INTO live_game_players (live_game_id, player_id, team, captain, time_on) VALUES (?, ?, ?, 0, datetime('now'))"
  ).run(liveGameId, playerId, side);
  return { ok: true };
}

// Any player in the game reports it done and picks the winning side. The
// court frees right away. The result waits for a player from the other team.
function reportDone(liveGameId, playerId, winningSide) {
  const game = gameFor(liveGameId);
  if (!game || game.status !== 'in_progress') return fail('No game is in progress.');
  const team = q.activeRosterTeam(liveGameId, playerId);
  if (!team) return fail('Only players in this game can report it done.');
  if (!SIDES.includes(winningSide)) return fail('Pick the winning side.');

  db.prepare(
    "UPDATE live_game_players SET time_off = datetime('now') WHERE live_game_id = ? AND time_off IS NULL"
  ).run(liveGameId);
  db.prepare(
    `UPDATE live_games SET status = 'awaiting_confirmation', team_a_won = ?, result_submitted_team = ?,
       result_submitted_by = ?, result_submitted_at = datetime('now'), confirmed_a = ?, confirmed_b = ?, result_note = NULL
     WHERE id = ?`
  ).run(winningSide === 'a' ? 1 : 0, team, playerId, team === 'a' ? 1 : 0, team === 'b' ? 1 : 0, liveGameId);
  q.logEvent(playerId, 'result_submitted', null, game.park_id);
  return { ok: true };
}

// Round n of a game is the question asked after n x 10 minutes.
function roundOf(game, now = Date.now()) {
  const started = Date.parse(game.started_at + 'Z');
  return Math.floor((now - started) / (POLL_MINUTES * 60 * 1000));
}

// The "Did you win?" question this player should answer now, or null.
function pollDueFor(playerId) {
  const game = db
    .prepare(
      `SELECT lg.* FROM live_games lg
       JOIN live_game_players lgp ON lgp.live_game_id = lg.id
       WHERE lg.status = 'in_progress' AND lgp.player_id = ? AND lgp.time_off IS NULL
       ORDER BY lg.id DESC LIMIT 1`
    )
    .get(playerId);
  if (!game) return null;
  const round = roundOf(game);
  if (round < 1) return null;
  const answered = db
    .prepare('SELECT 1 FROM live_game_polls WHERE live_game_id = ? AND round = ? AND player_id = ?')
    .get(game.id, round, playerId);
  if (answered) return null;
  return { liveGameId: game.id, round };
}

function answerPoll(liveGameId, playerId, round, answer) {
  const game = gameFor(liveGameId);
  if (!game || game.status !== 'in_progress') return fail('This game is not in progress.');
  if (!q.activeRosterTeam(liveGameId, playerId)) return fail('Only players in this game can answer.');
  if (!ANSWERS.includes(answer)) return fail('Pick Yes, No or Still playing.');
  if (Number(round) !== roundOf(game)) return fail('That question has expired.');

  db.prepare(
    'INSERT OR REPLACE INTO live_game_polls (live_game_id, round, player_id, answer) VALUES (?, ?, ?, ?)'
  ).run(liveGameId, round, playerId, answer);
  const settled = settlePoll(liveGameId, Number(round));
  return { ok: true, settled };
}

// A Yes from one side and a No from the other creates and confirms the result,
// which then locks and awards points.
function settlePoll(liveGameId, round) {
  const answers = db
    .prepare(
      `SELECT lgp.team, lp.answer FROM live_game_polls lp
       JOIN live_game_players lgp ON lgp.live_game_id = lp.live_game_id AND lgp.player_id = lp.player_id
       WHERE lp.live_game_id = ? AND lp.round = ? AND lgp.time_off IS NULL`
    )
    .all(liveGameId, round);
  const yes = new Set(answers.filter((a) => a.answer === 'yes').map((a) => a.team));
  const no = new Set(answers.filter((a) => a.answer === 'no').map((a) => a.team));
  const winner = ['a', 'b'].find((side) => yes.has(side) && no.has(side === 'a' ? 'b' : 'a'));
  if (!winner) return false;

  const loser = winner === 'a' ? 'b' : 'a';
  db.prepare("UPDATE live_game_players SET time_off = datetime('now') WHERE live_game_id = ? AND time_off IS NULL").run(liveGameId);
  db.prepare(
    `UPDATE live_games SET status = 'awaiting_confirmation', team_a_won = ?, result_submitted_team = ?,
       result_submitted_by = NULL, result_submitted_at = datetime('now'), confirmed_a = 1, confirmed_b = 1, result_note = NULL
     WHERE id = ?`
  ).run(winner === 'a' ? 1 : 0, loser, liveGameId);
  q.lockResult(gameFor(liveGameId));
  return true;
}

// "You're up": the court is free and this player is on the first squad in line.
function upNextFor(playerId) {
  const courts = db
    .prepare(
      `SELECT DISTINCT nl.court_id FROM next_line nl
       WHERE nl.status = 'waiting' AND (nl.captain_player_id = ? OR EXISTS
         (SELECT 1 FROM next_line_members m WHERE m.next_line_id = nl.id AND m.player_id = ?))`
    )
    .all(playerId, playerId);
  for (const { court_id: courtId } of courts) {
    if (q.getActiveLiveGame(courtId)) continue;
    const first = q.getWaitingSquads(courtId)[0];
    if (!first) continue;
    const ids = db
      .prepare(
        `SELECT captain_player_id AS id FROM next_line WHERE id = ?
         UNION SELECT player_id AS id FROM next_line_members WHERE next_line_id = ?`
      )
      .all(first.id, first.id)
      .map((r) => r.id);
    if (ids.includes(playerId)) return { courtId, nextLineId: first.id };
  }
  return null;
}

// Games this player was in that are waiting for the other team to confirm.
function pendingGamesFor(playerId) {
  return db
    .prepare(
      `SELECT lg.id, lg.court_id, lg.format, lg.team_a_won, lg.result_submitted_team, lgp.team,
              (julianday(lgp.time_off) - julianday(lgp.time_on)) * 24 AS hours
       FROM live_games lg
       JOIN live_game_players lgp ON lgp.live_game_id = lg.id AND lgp.player_id = ?
       WHERE lg.status = 'awaiting_confirmation'
       ORDER BY lg.id DESC`
    )
    .all(playerId)
    .map((g) => {
      const won = (g.team_a_won ? 'a' : 'b') === g.team;
      const hours = Math.max(g.hours || 0, 0);
      const points = (won ? 3 : 0) + 1 + Math.round(hours * 10) / 10;
      return { ...g, won, points: Math.round(points * 10) / 10 };
    });
}

// A pending game on a court, for the court screen.
function pendingGameForCourt(courtId) {
  return db
    .prepare(`SELECT * FROM live_games WHERE court_id = ? AND status = 'awaiting_confirmation' ORDER BY id DESC LIMIT 1`)
    .get(courtId);
}

// Where a game is, for its QR link.
function gameLocation(liveGameId) {
  return db.prepare('SELECT id, court_id, park_id FROM live_games WHERE id = ?').get(liveGameId) || null;
}

module.exports = {
  gameLocation,
  FORMATS,
  POLL_MINUTES,
  startGame,
  joinGame,
  reportDone,
  pollDueFor,
  answerPoll,
  upNextFor,
  pendingGamesFor,
  pendingGameForCourt,
};
