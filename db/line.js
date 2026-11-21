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
      const lead = row.guest_name
        ? { kind: 'guest', id: null, name: row.guest_name + ' (guest)', firstName: row.guest_name, lead: true }
        : { kind: 'player', id: row.captain_player_id, name: nameOf(row.captain_player_id), captain: true };
      const roster = [
        lead,
        ...members.map((m) => ({ kind: 'player', id: m.id, name: m.name, captain: false })),
        ...guests.map((g) => ({ kind: 'guest', id: g.id, name: 'Guest: ' + g.first_name, firstName: g.first_name })),
      ];
      const count = roster.length;
      const full = count === size;
      const confirmed = !!row.confirmed && full;
      const status = confirmed ? 'confirmed' : count > 1 ? 'picking' : 'waiting';
      return {
        id: row.id,
        number: i + 1,
        captainId: row.captain_player_id,
        guestSpot: !!row.guest_name,
        addedBy: row.guest_name ? nameOf(row.captain_player_id) : null,
        roster,
        count,
        size,
        full,
        confirmed,
        status,
      };
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
    .prepare(`SELECT id FROM next_line WHERE captain_player_id = ? AND guest_name IS NULL AND id IN (${inCourts}) AND id IS NOT ?`)
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

// "+ Add someone to the line": any checked-in player adds a person without
// the app by first name. The spot is timestamped now and looked after by the
// player who added them.
function addGuestSpot(courtId, firstName, actorPlayerId) {
  const court = q.getCourtById(courtId);
  if (!court) return fail('Court not found.');
  if (!q.getCheckIn(actorPlayerId, court.park_id)) return fail('Check in at the park first.');
  const name = String(firstName || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  if (!/^[\p{L}][\p{L}' .-]{0,19}$/u.test(name)) return fail('Type their first name.');
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM next_line WHERE court_id = ?').get(courtId).p;
  db.prepare(
    "INSERT INTO next_line (court_id, captain_player_id, position, status, created_at, guest_name) VALUES (?, ?, ?, 'waiting', datetime('now'), ?)"
  ).run(courtId, actorPlayerId, pos, name);
  return { ok: true };
}

// "Let them go ahead": the spot's holder swaps places with the spot right
// behind them. Only the person giving up their spot can do it.
function letAhead(spotId, actorPlayerId) {
  const row = db.prepare("SELECT * FROM next_line WHERE id = ? AND status = 'waiting'").get(spotId);
  if (!row) return fail('That spot is no longer in line.');
  if (row.captain_player_id !== actorPlayerId) return fail('Only the person giving up their spot can let someone go ahead.');
  const line = spots(row.court_id);
  const i = line.findIndex((s) => s.id === spotId);
  const behind = line[i + 1];
  if (!behind) return fail("Nobody's behind you.");
  const b = db.prepare('SELECT position FROM next_line WHERE id = ?').get(behind.id);
  // Positions can tie (ordered by id then); swap both position and order cleanly.
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE next_line SET position = ? WHERE id = ?').run(b.position, spotId);
    db.prepare('UPDATE next_line SET position = ? WHERE id = ?').run(row.position, behind.id);
    if (b.position === row.position) {
      db.prepare('UPDATE next_line SET position = position + 1 WHERE id = ?').run(spotId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { ok: true };
}

// The player who added a guest takes that guest's spot out of the line.
function dropSpot(spotId, actorPlayerId) {
  const row = db.prepare("SELECT * FROM next_line WHERE id = ? AND status = 'waiting'").get(spotId);
  if (!row) return fail('That spot is no longer in line.');
  if (row.captain_player_id !== actorPlayerId) return fail('Only the player who holds or added this spot can remove it.');
  deleteSpot(spotId);
  return { ok: true };
}

// --- "Game on (not in app)": the court is busy with a game nobody's
// tracking. The line holds until someone taps "That game's done", or for
// UNTRACKED_MINUTES, whichever comes first; then the next game comes off the line.
const UNTRACKED_MINUTES = 25;
function untrackedGame(courtId) {
  const row = db
    .prepare('SELECT * FROM court_busy WHERE court_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(courtId);
  if (!row) return null;
  const mins = db.prepare("SELECT (julianday('now') - julianday(?)) * 1440 AS m").get(row.started_at).m;
  if (mins >= UNTRACKED_MINUTES) {
    db.prepare("UPDATE court_busy SET ended_at = datetime(started_at, '+" + UNTRACKED_MINUTES + " minutes') WHERE id = ?").run(row.id);
    startNextGame(courtId);
    return null;
  }
  return { id: row.id, minutes: Math.floor(mins), byName: row.by_player_id ? nameOf(row.by_player_id) : null };
}

function gameOnUntracked(courtId, actorPlayerId) {
  const court = q.getCourtById(courtId);
  if (!court) return fail('Court not found.');
  if (!q.getCheckIn(actorPlayerId, court.park_id)) return fail('Check in at the park first.');
  if (courtBusy(courtId)) return fail('A game is already on this court.');
  db.prepare("INSERT INTO court_busy (court_id, by_player_id, started_at) VALUES (?, ?, datetime('now'))").run(courtId, actorPlayerId);
  q.logEvent(actorPlayerId, 'game_on_untracked', null, court.park_id);
  return { ok: true };
}

function untrackedDone(courtId, actorPlayerId) {
  const court = q.getCourtById(courtId);
  if (!court) return fail('Court not found.');
  if (!q.getCheckIn(actorPlayerId, court.park_id)) return fail('Check in at the park first.');
  const row = db.prepare('SELECT id FROM court_busy WHERE court_id = ? AND ended_at IS NULL').get(courtId);
  if (!row) return { ok: true };
  db.prepare("UPDATE court_busy SET ended_at = datetime('now') WHERE id = ?").run(row.id);
  startNextGame(courtId);
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
  const untracked = db
    .prepare(`SELECT 1 FROM court_busy WHERE court_id = ? AND ended_at IS NULL AND started_at >= datetime('now', '-${UNTRACKED_MINUTES} minutes')`)
    .get(courtId);
  if (untracked) return true;
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

// --- "Scan to claim this game": once a tracked game with guests locks, each
// guest gets a claim code for 24 hours. Signing up (or signing in) with it
// moves that game's result and points onto their profile.
const CLAIM_HOURS = 24;
function prepareGuestClaims(liveGameId) {
  const game = db.prepare("SELECT * FROM live_games WHERE id = ? AND status = 'done' AND team_a_won IS NOT NULL").get(liveGameId);
  if (!game) return 0;
  const guests = db.prepare('SELECT id FROM live_game_guests WHERE live_game_id = ? AND claim_token IS NULL').all(liveGameId);
  if (guests.length === 0) return 0;
  // The saved result's game number: the newest result for this game's players on this court.
  const row = db
    .prepare(
      `SELECT game_id FROM game_results WHERE court_id = ? AND player_id IN
         (SELECT player_id FROM live_game_players WHERE live_game_id = ?) ORDER BY id DESC LIMIT 1`
    )
    .get(game.court_id, liveGameId);
  if (!row) return 0;
  const crypto = require('crypto');
  const set = db.prepare(
    `UPDATE live_game_guests SET claim_token = ?, result_game_id = ?, claim_expires_at = datetime('now', '+${CLAIM_HOURS} hours') WHERE id = ?`
  );
  for (const g of guests) set.run(crypto.randomBytes(12).toString('hex'), row.game_id, g.id);
  return guests.length;
}

function claimByToken(token) {
  return db
    .prepare(
      `SELECT g.*, lg.court_id, lg.park_id, lg.team_a_won, lg.format FROM live_game_guests g
       JOIN live_games lg ON lg.id = g.live_game_id WHERE g.claim_token = ?`
    )
    .get(String(token || ''));
}

function claimStatus(token) {
  const c = claimByToken(token);
  if (!c) return { ok: false, error: "That claim code doesn't exist." };
  if (c.claimed_player_id) return { ok: false, error: 'This game has already been claimed.' };
  if (db.prepare("SELECT ? < datetime('now') AS late").get(c.claim_expires_at).late) {
    return { ok: false, error: 'This claim code has expired (24 hours).' };
  }
  return { ok: true, claim: c };
}

// Moves the guest's result onto the player's profile: the same win or loss,
// minutes and format as their teammates, so points come from the usual rules.
function claimGame(token, playerId) {
  const s = claimStatus(token);
  if (!s.ok) return s;
  const c = s.claim;
  if (db.prepare('SELECT 1 FROM game_results WHERE game_id = ? AND player_id = ?').get(c.result_game_id, playerId)) {
    return { ok: false, error: 'You already have a result for this game.' };
  }
  const winner = c.team_a_won ? 'a' : 'b';
  const result = c.team === winner ? 'win' : 'loss';
  const mates = db
    .prepare('SELECT AVG(minutes_played) AS m FROM game_results WHERE game_id = ? AND result = ?')
    .get(c.result_game_id, result);
  const minutes = Math.round((mates && mates.m) || 0);
  db.exec('BEGIN');
  try {
    q.applyGameResult(c.result_game_id, c.park_id, c.court_id, playerId, result, minutes, c.format);
    db.prepare('UPDATE live_game_guests SET claimed_player_id = ? WHERE id = ?').run(playerId, c.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  q.recordMilestone(playerId, 'first_game');
  q.logEvent(playerId, 'guest_game_claimed', null, c.park_id);
  return { ok: true, result, firstName: c.first_name };
}

// Unclaimed guests from games on this court that locked in the last 24 hours.
function openClaims(courtId) {
  return db
    .prepare(
      `SELECT g.first_name AS name, g.claim_token AS token, g.team, lg.format, lg.id AS liveGameId
       FROM live_game_guests g JOIN live_games lg ON lg.id = g.live_game_id
       WHERE lg.court_id = ? AND g.claim_token IS NOT NULL AND g.claimed_player_id IS NULL
         AND g.claim_expires_at > datetime('now')
       ORDER BY lg.id DESC, g.id LIMIT 10`
    )
    .all(courtId);
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
  const mineSpot = viewerPlayerId ? line.find((s) => !s.guestSpot && playerIdsOf(s).includes(viewerPlayerId)) || null : null;
  const isCaptain = !!mineSpot && mineSpot.captainId === viewerPlayerId;
  const teamCard = (s) => ({
    spotId: s.id,
    number: s.number,
    isCaptain: s.captainId === viewerPlayerId,
    guestSpot: s.guestSpot,
    captainName: s.roster[0].name,
    roster: s.roster,
    count: s.count,
    size: s.size,
    full: s.full,
    confirmed: s.confirmed,
    candidates: s.captainId === viewerPlayerId ? candidates(courtId, s.id) : [],
  });
  // Guest spots this viewer added (they look after them).
  const sponsored = viewerPlayerId ? line.filter((s) => s.guestSpot && s.captainId === viewerPlayerId).map(teamCard) : [];
  return {
    courtId,
    format,
    size: sizeOf(format),
    rows: line.map((s, i) => ({
      spotId: s.id,
      number: s.number,
      name: s.roster[0].name,
      addedBy: s.addedBy,
      isYou: !!mineSpot && s.id === mineSpot.id,
      status: s.status,
      count: s.count,
      size: s.size,
      // "Let them go ahead": only for the spot's holder, and only with someone behind.
      canLetAhead: !!viewerPlayerId && s.captainId === viewerPlayerId && i < line.length - 1,
    })),
    sponsored,
    untracked: untrackedGame(courtId),
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
  addGuestSpot,
  letAhead,
  prepareGuestClaims,
  claimStatus,
  claimGame,
  openClaims,
  dropSpot,
  gameOnUntracked,
  untrackedDone,
  untrackedGame,
  startNextGame,
  liveGuests,
  onConfirmedTeam,
  sizeOf,
  courtFormat,
};
