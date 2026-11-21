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
const STALE_MINUTES = 30;

const fail = (error) => ({ ok: false, error });
const gameFor = (id) => db.prepare('SELECT * FROM live_games WHERE id = ?').get(id);
const activeRows = (gameId) =>
  db.prepare('SELECT player_id, team FROM live_game_players WHERE live_game_id = ? AND time_off IS NULL').all(gameId);

// The first player in is on Team A. Nobody picks a side to start.
function startGame(courtId, playerId, format) {
  const court = q.getCourtById(courtId);
  if (!court) return fail('Court not found.');
  if (!q.getCheckIn(playerId, court.park_id)) return fail('Check in at the park first.');
  if (!FORMATS.includes(format)) return fail('Pick a format first.');
  closeStaleGames();
  if (q.getActiveLiveGame(courtId)) return fail('A game is already on this court. Join it, or wait for it to finish.');
  if (q.isPlayerInActiveLiveGame(courtId, playerId)) return fail("You're already in the game on this court.");

  const park = q.getParkById(court.park_id);
  // Started while another game was already on at this park: counted on /admin.
  const alongside = liveGamesAtPark(park.id).length > 0;
  db.prepare(
    "INSERT INTO live_games (court_id, park_id, target, status, started_at, format) VALUES (?, ?, ?, 'in_progress', datetime('now'), ?)"
  ).run(courtId, park.id, park.game_target, format);
  const liveGameId = lastId();
  db.prepare(
    "INSERT INTO live_game_players (live_game_id, player_id, team, captain, time_on) VALUES (?, ?, ?, 1, datetime('now'))"
  ).run(liveGameId, playerId, 'a');
  db.prepare('UPDATE courts SET format = ? WHERE id = ?').run(format, courtId);
  q.logEvent(playerId, 'game_started', null, park.id);
  require('./line').removeFromLines(playerId, park.id);
  if (alongside) q.logEvent(playerId, 'game_started_alongside', null, park.id);
  return { ok: true, liveGameId };
}

const courtLabel = (c) => c.nickname || `Court ${c.number}`;

// Every game on at a park, one entry per game, so two games never read as
// one run: format, court label, players on, and teams waiting next.
function liveGamesAtPark(parkId) {
  return db
    .prepare(
      `SELECT lg.id, lg.court_id AS courtId, lg.format, c.number, c.nickname,
              (SELECT COUNT(*) FROM live_game_players p WHERE p.live_game_id = lg.id AND p.time_off IS NULL)
                + (SELECT COUNT(*) FROM live_game_guests g WHERE g.live_game_id = lg.id) AS onCount,
              (SELECT COUNT(*) FROM next_line nl WHERE nl.court_id = lg.court_id AND nl.status = 'waiting') AS nextCount
       FROM live_games lg JOIN courts c ON c.id = lg.court_id
       WHERE lg.park_id = ? AND lg.status IN ('countdown', 'in_progress')
       ORDER BY lg.started_at ASC, lg.id ASC`
    )
    .all(parkId)
    .map((g) => ({ id: g.id, courtId: g.courtId, format: g.format, courtLabel: courtLabel(g), onCount: g.onCount, nextCount: g.nextCount }));
}

// The confirm screen's court/hoop choices: every court at the park, with the
// ones that already have a game on marked busy.
function courtChoices(parkId) {
  const busy = new Set(liveGamesAtPark(parkId).map((g) => g.courtId));
  return q.getCourtsByPark(parkId).map((c) => ({ id: c.id, label: courtLabel(c), busy: busy.has(c.id) }));
}

// A player joins by tapping the team his teammate is on. While the game is on he
// can tap the other team to fix a wrong tap. Teams lock at Game done.
function joinGame(liveGameId, playerId, side) {
  const game = gameFor(liveGameId);
  if (!game || game.status !== 'in_progress') return fail('No game is on right now.');
  if (!q.getCheckIn(playerId, game.park_id)) return fail('Check in at the park first.');
  if (!SIDES.includes(side)) return fail('Tap the team your teammate is on.');
  const rows = activeRows(liveGameId);
  const size = q.formatSize(game.format);
  const guests = require('./line').liveGuests(liveGameId);
  const onSide = (s) => rows.filter((r) => r.team === s).length + guests[s].length;
  const mine = rows.find((r) => r.player_id === playerId);
  if (mine) {
    if (mine.team === side) return { ok: true };
    if (size && onSide(side) >= size) return fail(`Team ${side.toUpperCase()} is full.`);
    db.prepare(
      "UPDATE live_game_players SET team = ? WHERE live_game_id = ? AND player_id = ? AND time_off IS NULL"
    ).run(side, liveGameId, playerId);
    return { ok: true };
  }
  if (size && onSide(side) >= size) {
    return fail(`Team ${side.toUpperCase()} is full.`);
  }
  db.prepare(
    "INSERT INTO live_game_players (live_game_id, player_id, team, captain, time_on) VALUES (?, ?, ?, 0, datetime('now'))"
  ).run(liveGameId, playerId, side);
  // On a team now: off the "I got next" line at this park.
  require('./line').removeFromLines(playerId, game.park_id);
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

// An answer to "Did you win?". Only players in the game can answer.
// - Still playing: recorded, and keeps the game open.
// - Yes or No while the game is on: creates a pending result only (the same as
//   Game done). It counts once a player from the other team confirms.
// - Yes or No from the other team once a result is pending: agreeing confirms
//   it, and a conflicting claim marks the game disputed, with no points.
function answerPoll(liveGameId, playerId, round, answer) {
  const game = gameFor(liveGameId);
  if (!game) return fail('Game not found.');
  if (!ANSWERS.includes(answer)) return fail('Pick Yes, No or Still playing.');
  const team = q.playerTeamInGame(liveGameId, playerId);
  if (!team) return fail('Only players in this game can answer.');
  const other = team === 'a' ? 'b' : 'a';
  const claimedWinner = answer === 'yes' ? team : other;

  if (game.status === 'in_progress') {
    if (!q.activeRosterTeam(liveGameId, playerId)) return fail('Only players in this game can answer.');
    if (Number(round) !== roundOf(game)) return fail('That question has expired.');
    db.prepare(
      'INSERT OR REPLACE INTO live_game_polls (live_game_id, round, player_id, answer) VALUES (?, ?, ?, ?)'
    ).run(liveGameId, round, playerId, answer);
    if (answer === 'still') return { ok: true, state: 'playing' };
    const done = reportDone(liveGameId, playerId, claimedWinner);
    return done.ok ? { ok: true, state: 'pending' } : done;
  }

  if (game.status === 'awaiting_confirmation') {
    if (answer === 'still') return { ok: true, state: 'pending' };
    // Teammates of the player who reported it cannot confirm or dispute.
    if (team === game.result_submitted_team) return { ok: true, state: 'pending' };
    const pendingWinner = game.team_a_won ? 'a' : 'b';
    if (claimedWinner === pendingWinner) {
      const confirmed = q.confirmResult(liveGameId, playerId);
      return confirmed.ok ? { ok: true, state: 'confirmed' } : confirmed;
    }
    q.markDisputed(game, playerId);
    return { ok: true, state: 'disputed' };
  }
  return fail('This game is already closed.');
}

// A game nobody has touched for 30 minutes (no Game done, and no answer to
// "Did you win?", Still playing included) closes with no result. The court
// frees up and nobody gets points.
function closeStaleGames() {
  const stale = db
    .prepare(
      `SELECT lg.id FROM live_games lg
       WHERE lg.status = 'in_progress'
         AND lg.started_at <= datetime('now', '-${STALE_MINUTES} minutes')
         AND NOT EXISTS (
           SELECT 1 FROM live_game_polls lp
           WHERE lp.live_game_id = lg.id AND lp.created_at > datetime('now', '-${STALE_MINUTES} minutes')
         )`
    )
    .all();
  for (const { id } of stale) {
    db.prepare("UPDATE live_game_players SET time_off = datetime('now') WHERE live_game_id = ? AND time_off IS NULL").run(id);
    db.prepare(
      `UPDATE live_games SET status = 'done', outcome = 'no_result', locked_at = datetime('now'),
         result_note = 'Closed with no result: nobody reported it for 30 minutes.' WHERE id = ?`
    ).run(id);
  }
  return stale.length;
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

// The players on each team of a game, for the confirm screen.
function rosterByTeam(liveGameId) {
  const rows = db
    .prepare(
      `SELECT lgp.team, u.name || ' #' || u.tag AS name
       FROM live_game_players lgp JOIN players p ON p.id = lgp.player_id JOIN users u ON u.id = p.user_id
       WHERE lgp.live_game_id = ? ORDER BY lgp.id`
    )
    .all(liveGameId);
  return {
    a: rows.filter((r) => r.team === 'a').map((r) => r.name),
    b: rows.filter((r) => r.team === 'b').map((r) => r.name),
  };
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
  liveGamesAtPark,
  courtChoices,
  joinGame,
  rosterByTeam,
  reportDone,
  pollDueFor,
  answerPoll,
  closeStaleGames,
  upNextFor,
  pendingGamesFor,
  pendingGameForCourt,
};
