// "I got next": the line for a court, and picking a team from it.
//
// - Only checked-in players can get in line; one spot per player per court.
// - The order is the time each player tapped "I got next".
// - Anyone in line can start picking a team: players checked in here who
//   aren't on a confirmed team, or a guest by first name (someone without
//   the app). A player added to someone else's team loses their own spot.
// - "Confirm team" turns on once the roster matches the court's format. The
//   captain can still swap players after confirming; a team below the full
//   count shows as Picking until it's full again.
// - #1 gets the next game: when a game's result locks (or a team confirms on
//   a free court), the next game starts from the line and everyone moves up.
// - Guests fill a roster spot but never earn points or show on a leaderboard:
//   results are only ever saved for app players.
//
// The line lives in next_line (one row per spot, captain_player_id is the
// player who tapped) and next_line_members (players added to that team).
const { db, lastId } = require('./index');
const q = require('./queries');

const DEFAULT_FORMAT = '5v5';
const WINNERS_STAY_MINUTES = 30;

const courtFormat = (court) => court.format || DEFAULT_FORMAT;
const sizeOf = (format) => Number(String(format || DEFAULT_FORMAT).charAt(0)) || 5;
const fail = (error) => ({ ok: false, error });

function guestsOf(nextLineId) {
  return db.prepare('SELECT id, first_name FROM next_line_guests WHERE next_line_id = ? ORDER BY id').all(nextLineId);
}

function membersOf(nextLineId) {
  return db
    .prepare(
      `SELECT p.id, u.name || ' #' || u.tag AS name FROM next_line_members m
       JOIN players p ON p.id = m.player_id JOIN users u ON u.id = p.user_id
       WHERE m.next_line_id = ? ORDER BY m.rowid`
    )
    .all(nextLineId);
}

function nameOf(playerId) {
  const r = db.prepare("SELECT u.name || ' #' || u.tag AS name FROM players p JOIN users u ON u.id = p.user_id WHERE p.id = ?").get(playerId);
  return r ? r.name : 'Player';
}

// Every spot on a court, in order, with its roster.
function spots(courtId) {
  const court = q.getCourtById(courtId);
  const size = sizeOf(courtFormat(court));
  return db
    .prepare("SELECT * FROM next_line WHERE court_id = ? AND status = 'waiting' ORDER BY position ASC, id ASC")
    .all(courtId)
    .map((row, i) => {
      const members = membersOf(row.id);
      const guests = guestsOf(row.id);
      const roster = [
        { kind: 'player', id: row.captain_player_id, name: nameOf(row.captain_player_id), captain: true },
        ...members.map((m) => ({ kind: 'player', id: m.id, name: m.name, captain: false })),
        ...guests.map((g) => ({ kind: 'guest', id: g.id, name: 'Guest: ' + g.first_name, firstName: g.first_name })),
      ];
      const count = roster.length;
      const full = count === size;
      const confirmed = !!row.confirmed && full;
      const status = confirmed ? 'confirmed' : count > 1 ? 'picking' : 'waiting';
      return { id: row.id, number: i + 1, captainId: row.captain_player_id, roster, count, size, full, confirmed, status };
    });
}

const playerIdsOf = (spot) => spot.roster.filter((r) => r.kind === 'player').map((r) => r.id);

function spotOfPlayer(courtId, playerId) {
  return spots(courtId).find((s) => playerIdsOf(s).includes(playerId)) || null;
}

// Removes a player from every line at a park: their own spot goes (and the
// team they were picking with it), and they come off any team they were on.
function removeFromLines(playerId, parkId, exceptSpotId = null) {
  const courtIds = q.getCourtsByPark(parkId).map((c) => c.id);
  if (courtIds.length === 0) return;
  const inCourts = `SELECT id FROM next_line WHERE status = 'waiting' AND court_id IN (${courtIds.map(() => '?').join(',')})`;
  const own = db
    .prepare(`SELECT id FROM next_line WHERE captain_player_id = ? AND id IN (${inCourts}) AND id IS NOT ?`)
    .all(playerId, ...courtIds, exceptSpotId);
  for (const { id } of own) deleteSpot(id);
  db.prepare(`DELETE FROM next_line_members WHERE player_id = ? AND next_line_id IN (${inCourts}) AND next_line_id IS NOT ?`).run(
    playerId,
    ...courtIds,
    exceptSpotId
  );
}

function deleteSpot(spotId) {
  db.prepare('DELETE FROM next_line_members WHERE next_line_id = ?').run(spotId);
  db.prepare('DELETE FROM next_line_guests WHERE next_line_id = ?').run(spotId);
  db.prepare('DELETE FROM next_line WHERE id = ?').run(spotId);
}

function onConfirmedTeam(courtId, playerId) {
  return spots(courtId).some((s) => s.confirmed && playerIdsOf(s).includes(playerId));
}

// "Leave line": the captain's spot (and its team) goes; a player on someone
// else's team just comes off it.
function leaveLine(courtId, playerId) {
  const spot = spotOfPlayer(courtId, playerId);
  if (!spot) return fail("You're not in line here.");
  if (spot.captainId === playerId) deleteSpot(spot.id);
  else db.prepare('DELETE FROM next_line_members WHERE next_line_id = ? AND player_id = ?').run(spot.id, playerId);
  return { ok: true };
}

function captainSpot(spotId, actorPlayerId) {
  const row = db.prepare("SELECT * FROM next_line WHERE id = ? AND status = 'waiting'").get(spotId);
  if (!row) return { error: 'That spot is no longer in line.' };
  if (row.captain_player_id !== actorPlayerId) return { error: 'Only the player who holds this spot can pick the team.' };
  const spot = spots(row.court_id).find((s) => s.id === spotId);
  return { row, spot, court: q.getCourtById(row.court_id) };
}

// Players the captain can add: checked in here, not already on this team,
// not on a confirmed team, not on the court in a game.
function candidates(courtId, spotId) {
  const court = q.getCourtById(courtId);
  const all = spots(courtId);
  const mine = all.find((s) => s.id === spotId);
  const taken = new Set([
    ...(mine ? playerIdsOf(mine) : []),
    ...all.filter((s) => s.confirmed).flatMap(playerIdsOf),
  ]);
  return q
    .getCheckedInPlayers(court.park_id)
    .filter((p) => !taken.has(p.id) && !q.isPlayerInActiveLiveGame(courtId, p.id))
    .map((p) => ({ id: p.id, name: p.name }));
}

function addPlayer(spotId, playerId, actorPlayerId) {
  const c = captainSpot(spotId, actorPlayerId);
  if (c.error) return fail(c.error);
  if (c.spot.count >= c.spot.size) return fail(`Your team already has ${c.spot.size}.`);
  if (!candidates(c.row.court_id, spotId).some((p) => p.id === playerId)) {
    return fail('That player is not available. They need to be checked in here and not on a confirmed team.');
  }
  // Added to this team: they come off the line everywhere else at this park.
  removeFromLines(playerId, c.court.park_id, spotId);
  db.prepare('INSERT OR IGNORE INTO next_line_members (next_line_id, player_id) VALUES (?, ?)').run(spotId, playerId);
  return { ok: true };
}

function addGuest(spotId, firstName, actorPlayerId) {
  const c = captainSpot(spotId, actorPlayerId);
  if (c.error) return fail(c.error);
  const name = String(firstName || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  if (!/^[\p{L}][\p{L}' .-]{0,19}$/u.test(name)) return fail("Type the guest's first name.");
  if (c.spot.count >= c.spot.size) return fail(`Your team already has ${c.spot.size}.`);
  db.prepare("INSERT INTO next_line_guests (next_line_id, first_name, created_at) VALUES (?, ?, datetime('now'))").run(spotId, name);
  return { ok: true };
}

// Swapping is allowed after confirming: the team stays confirmed, and shows
// as Picking until it's full again.
function removeFromTeam(spotId, kind, id, actorPlayerId) {
  const c = captainSpot(spotId, actorPlayerId);
  if (c.error) return fail(c.error);
  if (kind === 'guest') db.prepare('DELETE FROM next_line_guests WHERE id = ? AND next_line_id = ?').run(id, spotId);
  else if (id === actorPlayerId) return fail('Use Leave line to give up your spot.');
  else db.prepare('DELETE FROM next_line_members WHERE next_line_id = ? AND player_id = ?').run(spotId, id);
  return { ok: true };
}

function confirmTeam(spotId, actorPlayerId) {
  const c = captainSpot(spotId, actorPlayerId);
  if (c.error) return fail(c.error);
  if (!c.spot.full) return fail(`Pick ${c.spot.size} players before confirming.`);
  db.prepare('UPDATE next_line SET confirmed = 1 WHERE id = ?').run(spotId);
  startNextGame(c.row.court_id);
  return { ok: true };
}

// --- The next game, from the line.
function courtBusy(courtId) {
  return !!db
    .prepare("SELECT 1 FROM live_games WHERE court_id = ? AND status IN ('countdown', 'in_progress', 'awaiting_confirmation')")
    .get(courtId);
}

// The winners of this court's last locked game, if it locked recently: they
// hold the court for the next game (players still checked in, and guests).
function stayingWinners(courtId, parkId) {
  const game = db
    .prepare(
      `SELECT * FROM live_games WHERE court_id = ? AND status = 'done' AND team_a_won IS NOT NULL
         AND locked_at >= datetime('now', '-${WINNERS_STAY_MINUTES} minutes')
         AND COALESCE(outcome, '') NOT IN ('no_result', 'disputed', 'voided')
       ORDER BY locked_at DESC, id DESC LIMIT 1`
    )
    .get(courtId);
  if (!game) return null;
  if (db.prepare('SELECT 1 FROM live_games WHERE court_id = ? AND id > ?').get(courtId, game.id)) return null;
  const team = game.team_a_won ? 'a' : 'b';
  const players = db
    .prepare('SELECT DISTINCT player_id FROM live_game_players WHERE live_game_id = ? AND team = ?')
    .all(game.id, team)
    .map((r) => r.player_id)
    .filter((pid) => q.getCheckIn(pid, parkId));
  const guests = db.prepare('SELECT first_name FROM live_game_guests WHERE live_game_id = ? AND team = ?').all(game.id, team).map((g) => g.first_name);
  if (players.length === 0) return null;
  return { players, guests };
}

function seat(liveGameId, team, players, guests) {
  const insert = db.prepare(
    "INSERT INTO live_game_players (live_game_id, player_id, team, captain, time_on) VALUES (?, ?, ?, ?, datetime('now'))"
  );
  players.forEach((pid, i) => insert.run(liveGameId, pid, team, i === 0 ? 1 : 0));
  const g = db.prepare('INSERT INTO live_game_guests (live_game_id, team, first_name) VALUES (?, ?, ?)');
  guests.forEach((name) => g.run(liveGameId, team, name));
}

const spotPlayers = (s) => playerIdsOf(s);
const spotGuests = (s) => s.roster.filter((r) => r.kind === 'guest').map((r) => r.firstName);

// #1 in line gets the next game once the court is free: against the winners
// who hold the court, or (nobody holding it) against #2. Both teams must be
// full and confirmed. Returns the new game's id, or null.
function startNextGame(courtId) {
  if (courtBusy(courtId)) return null;
  const court = q.getCourtById(courtId);
  const park = q.getParkById(court.park_id);
  const line = spots(courtId);
  const first = line[0];
  if (!first || !first.confirmed) return null;
  const holders = stayingWinners(courtId, park.id);
  let teamA;
  let teamB = first;
  if (holders) {
    teamA = { players: holders.players, guests: holders.guests };
  } else {
    const second = line[1];
    if (!second || !second.confirmed) return null;
    teamA = { players: spotPlayers(first), guests: spotGuests(first) };
    teamB = second;
  }
  const format = courtFormat(court);
  db.exec('BEGIN');
  try {
    db.prepare(
      "INSERT INTO live_games (court_id, park_id, target, status, started_at, format) VALUES (?, ?, ?, 'in_progress', datetime('now'), ?)"
    ).run(courtId, park.id, park.game_target, format);
    const gameId = lastId();
    seat(gameId, 'a', teamA.players, teamA.guests);
    seat(gameId, 'b', spotPlayers(teamB), spotGuests(teamB));
    if (!holders) deleteSpot(first.id);
    deleteSpot(teamB.id);
    db.prepare('UPDATE courts SET format = ? WHERE id = ?').run(format, courtId);
    db.exec('COMMIT');
    q.logEvent(first.captainId, 'game_started_from_line', null, park.id);
    return gameId;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Guests on a live game's teams, for the game card and the team counts.
function liveGuests(liveGameId) {
  const rows = db.prepare('SELECT id, team, first_name FROM live_game_guests WHERE live_game_id = ? ORDER BY id').all(liveGameId);
  return { a: rows.filter((r) => r.team === 'a'), b: rows.filter((r) => r.team === 'b') };
}

// Everything the court sheet / court page shows about the line.
function lineView(courtId, viewerPlayerId) {
  const court = q.getCourtById(courtId);
  const format = courtFormat(court);
  const line = spots(courtId);
  const mineSpot = viewerPlayerId ? line.find((s) => playerIdsOf(s).includes(viewerPlayerId)) || null : null;
  const isCaptain = !!mineSpot && mineSpot.captainId === viewerPlayerId;
  return {
    courtId,
    format,
    size: sizeOf(format),
    rows: line.map((s) => ({
      number: s.number,
      name: s.roster[0].name,
      isYou: !!mineSpot && s.id === mineSpot.id,
      status: s.status,
      count: s.count,
      size: s.size,
    })),
    mine: mineSpot
      ? {
          spotId: mineSpot.id,
          number: mineSpot.number,
          isCaptain,
          captainName: mineSpot.roster[0].name,
          roster: mineSpot.roster,
          count: mineSpot.count,
          size: mineSpot.size,
          full: mineSpot.full,
          confirmed: mineSpot.confirmed,
          candidates: isCaptain ? candidates(courtId, mineSpot.id) : [],
        }
      : null,
  };
}

module.exports = {
  spots,
  lineView,
  leaveLine,
  addPlayer,
  addGuest,
  removeFromTeam,
  confirmTeam,
  removeFromLines,
  startNextGame,
  liveGuests,
  onConfirmedTeam,
  sizeOf,
  courtFormat,
};
