const { db, formingGameFor, lastId } = require('./index');

function getUserByPhone(phone) {
  return db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
}

function getPlayerByUserId(userId) {
  return db.prepare('SELECT * FROM players WHERE user_id = ?').get(userId);
}

function createUserAndPlayer(name, phone) {
  const insertUser = db.prepare('INSERT INTO users (name, phone) VALUES (?, ?)');
  insertUser.run(name, phone);
  const userId = db.prepare('SELECT last_insert_rowid() AS id').get().id;

  db.prepare('INSERT INTO players (user_id) VALUES (?)').run(userId);
  const playerId = db.prepare('SELECT last_insert_rowid() AS id').get().id;

  return { userId, playerId };
}

// Player + their user profile + their tier's promotion rules, in one row.
function getPlayerProfile(userId) {
  return db
    .prepare(
      `SELECT u.id AS user_id, u.name, u.phone,
              p.id AS player_id, p.tier, p.wins, p.losses, p.games_played,
              t.rank AS tier_rank, t.wins_to_promote, t.games_to_promote,
              t.min_stake_cents AS tier_min_stake_cents
       FROM users u
       JOIN players p ON p.user_id = u.id
       JOIN tiers t ON t.name = p.tier
       WHERE u.id = ?`
    )
    .get(userId);
}

function getTiers() {
  return db.prepare('SELECT * FROM tiers ORDER BY rank ASC').all();
}

function getOpenLobbies() {
  return db
    .prepare("SELECT * FROM lobbies WHERE status = 'open' ORDER BY starts_at ASC")
    .all();
}

// Names of everyone currently in a lobby's forming game (the roster
// shown on the lobby card, e.g. "6 locked in · Darius, Chris + 4 more").
function getLobbyRoster(lobbyId) {
  const game = formingGameFor(lobbyId);
  if (!game) return { gameId: null, players: [] };

  const players = db
    .prepare(
      `SELECT u.id AS user_id, u.name
       FROM game_players gp
       JOIN players p ON p.id = gp.player_id
       JOIN users u ON u.id = p.user_id
       WHERE gp.game_id = ?
       ORDER BY gp.rowid ASC`
    )
    .all(game.id);

  return { gameId: game.id, players };
}

function isPlayerInGame(gameId, playerId) {
  const row = db
    .prepare('SELECT 1 FROM game_players WHERE game_id = ? AND player_id = ?')
    .get(gameId, playerId);
  return !!row;
}

// Joining a lobby = taking a seat in its forming game's roster, plus
// the ledger entry recording the entry fee owed (cash settles IRL).
function joinLobby(playerId, lobby) {
  const game = formingGameFor(lobby.id);
  if (!game) throw new Error('Lobby has no forming game');

  if (isPlayerInGame(game.id, playerId)) {
    return { alreadyJoined: true };
  }

  db.prepare(
    "INSERT INTO game_players (game_id, player_id, team) VALUES (?, ?, 'unassigned')"
  ).run(game.id, playerId);

  db.prepare(
    "INSERT INTO ledger (player_id, game_id, type, amount_cents, settled) VALUES (?, ?, 'entry_fee', ?, 0)"
  ).run(playerId, game.id, -lobby.stake_cents);

  return { alreadyJoined: false };
}

function getLobbyById(id) {
  return db.prepare('SELECT * FROM lobbies WHERE id = ?').get(id);
}

// ============================================================
// KING OF THE COURT
// ============================================================

function getParks() {
  return db.prepare('SELECT * FROM parks ORDER BY name ASC').all();
}

function getParkById(id) {
  return db.prepare('SELECT * FROM parks WHERE id = ?').get(id);
}

function getCourtsByPark(parkId) {
  return db
    .prepare('SELECT * FROM courts WHERE park_id = ? ORDER BY number ASC')
    .all(parkId);
}

function getCourtById(id) {
  return db.prepare('SELECT * FROM courts WHERE id = ?').get(id);
}

function nextGameId() {
  return db.prepare('SELECT COALESCE(MAX(game_id), 0) + 1 AS next FROM game_results').get().next;
}

// --- Seasons: everything resets every 30 days, counted from a fixed
// anchor so the boundary is the same no matter when the server runs.
const SEASON_LENGTH_MS = 30 * 24 * 60 * 60 * 1000;
const SEASON_EPOCH_MS = Date.UTC(2024, 0, 1);

// SQLite's datetime('now') (used as game_results.date's default) is
// "YYYY-MM-DD HH:MM:SS" in UTC, with a space, not a "T", and no
// milliseconds. Comparing against anything else breaks right at a
// season boundary, since SQLite dates are compared as plain text.
function toSqliteDateTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function getSeasonWindow(now = new Date()) {
  const nowMs = now.getTime();
  const index = Math.floor((nowMs - SEASON_EPOCH_MS) / SEASON_LENGTH_MS);
  const startMs = SEASON_EPOCH_MS + index * SEASON_LENGTH_MS;
  const endMs = startMs + SEASON_LENGTH_MS;
  const daysLeft = Math.ceil((endMs - nowMs) / (24 * 60 * 60 * 1000));
  const start = new Date(startMs);
  const end = new Date(endMs);
  return { start, end, daysLeft, startSql: toSqliteDateTime(start), endSql: toSqliteDateTime(end) };
}

// --- Crown levels: based on a player's TOTAL season points across
// every park, not the points at any one park. Checked highest-first.
const CROWN_LEVELS = [
  { name: 'Best Record in the League', min: 55, tier: 'purple', fill: '#7A45C2', stroke: '#4A2580' },
  { name: 'Playoff Bound', min: 50, tier: 'gold', fill: '#D9A520', stroke: '#8A6408' },
  { name: 'Contender', min: 35, tier: 'silver', fill: '#AEB3BA', stroke: '#5F656D' },
  { name: 'In the Mix', min: 20, tier: 'bronze', fill: '#B06A3B', stroke: '#6E3F1F' },
];
const CROWN_MIN_POINTS = CROWN_LEVELS[CROWN_LEVELS.length - 1].min;

function getCrownLevel(totalPoints) {
  for (const level of CROWN_LEVELS) {
    if (totalPoints >= level.min) return level;
  }
  return null;
}

function roundTenth(n) {
  return Math.round(n * 10) / 10;
}

// Points = wins x 3 + games x 1 + court hours (minutes / 60, rounded
// to a tenth). One row per (player_id, name, wins, games, hours, points).
function standingsFromGameResults(whereClause, params) {
  const rows = db
    .prepare(
      `SELECT gr.player_id AS playerId,
              u.name,
              SUM(CASE WHEN gr.result = 'win' THEN 1 ELSE 0 END) AS wins,
              COUNT(*) AS games,
              SUM(gr.minutes_played) AS minutes
       FROM game_results gr
       JOIN players p ON p.id = gr.player_id
       JOIN users u ON u.id = p.user_id
       WHERE ${whereClause}
       GROUP BY gr.player_id`
    )
    .all(...params);

  return rows
    .map((row) => {
      const hours = roundTenth(row.minutes / 60);
      const points = row.wins * 3 + row.games * 1 + hours;
      return { playerId: row.playerId, name: row.name, wins: row.wins, games: row.games, hours, points };
    })
    .sort((a, b) => b.points - a.points || b.hours - a.hours);
}

// Standings at one park, this season — also how a park's king is found.
function getParkStandings(parkId, seasonStart) {
  return standingsFromGameResults('gr.park_id = ? AND gr.date >= ?', [parkId, seasonStart]);
}

// Standings across every park, this season (the "City" tab).
function getCityStandings(seasonStart) {
  return standingsFromGameResults('gr.date >= ?', [seasonStart]);
}

// playerId -> total season points across every park, for crown level.
function getTotalSeasonPointsByPlayer(seasonStart) {
  const map = new Map();
  for (const row of getCityStandings(seasonStart)) {
    map.set(row.playerId, row.points);
  }
  return map;
}

// playerId -> 'Double Crown' | 'Triple Crown', for players who are king
// of 2 or 3+ parks this season. King of a park = most points there,
// ties broken by most court time there.
function getCrownBadges(seasonStart) {
  const kingCounts = new Map();
  for (const park of getParks()) {
    const standings = getParkStandings(park.id, seasonStart);
    if (standings.length === 0) continue;
    const kingId = standings[0].playerId;
    kingCounts.set(kingId, (kingCounts.get(kingId) || 0) + 1);
  }

  const badges = new Map();
  for (const [playerId, count] of kingCounts) {
    if (count >= 3) badges.set(playerId, 'Triple Crown');
    else if (count === 2) badges.set(playerId, 'Double Crown');
  }
  return badges;
}

// The full /board page's data: standings for the chosen scope, each
// row carrying its own crown level (always city-wide) and badge.
function getLeaderboard({ scope, parkId, seasonStart }) {
  const standings = scope === 'city' ? getCityStandings(seasonStart) : getParkStandings(parkId, seasonStart);
  const totalPointsByPlayer = getTotalSeasonPointsByPlayer(seasonStart);
  const badges = getCrownBadges(seasonStart);

  return standings.map((row, index) => {
    const totalPoints = totalPointsByPlayer.get(row.playerId) ?? row.points;
    const crown = getCrownLevel(totalPoints);
    return {
      rank: index + 1,
      ...row,
      totalPoints,
      crown,
      pointsToCrown: crown ? null : roundTenth(CROWN_MIN_POINTS - totalPoints),
      badge: badges.get(row.playerId) || null,
    };
  });
}

// ============================================================
// LIVE PLAY — check-ins, the next-line queue, and live games
// ============================================================

const CHECK_IN_FRESH_MINUTES = 5;
// SQLite date math on the TEXT timestamps everything else in this file
// uses — "fresh" means last_seen is within the window, as of right now.
const FRESH_SINCE_SQL = `datetime('now', '-${CHECK_IN_FRESH_MINUTES} minutes')`;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Checks the player's reported lat/lng against the park's radius, then
// upserts check_ins (no DB-level UNIQUE on player+park, so check first).
function checkIn(playerId, parkId, lat, lng) {
  const park = getParkById(parkId);
  if (!park) return { ok: false, error: 'Park not found.' };
  if (park.lat === null || park.lng === null) {
    return { ok: false, error: 'This park has no location set yet.' };
  }

  const distance = haversineMeters(lat, lng, park.lat, park.lng);
  if (distance > park.check_in_radius_meters) {
    return { ok: false, error: `You're ${Math.round(distance)}m from ${park.name} — get within ${park.check_in_radius_meters}m to check in.` };
  }

  const existing = db
    .prepare('SELECT id FROM check_ins WHERE player_id = ? AND park_id = ?')
    .get(playerId, parkId);
  if (existing) {
    db.prepare(
      "UPDATE check_ins SET time_in = datetime('now'), last_seen = datetime('now') WHERE id = ?"
    ).run(existing.id);
  } else {
    db.prepare('INSERT INTO check_ins (player_id, park_id) VALUES (?, ?)').run(playerId, parkId);
  }
  return { ok: true };
}

function heartbeat(playerId, parkId) {
  const result = db
    .prepare("UPDATE check_ins SET last_seen = datetime('now') WHERE player_id = ? AND park_id = ?")
    .run(playerId, parkId);
  return result.changes > 0;
}

// Fresh (within 5 min) check-in for this player at this park, or null.
function getCheckIn(playerId, parkId) {
  return db
    .prepare(
      `SELECT * FROM check_ins WHERE player_id = ? AND park_id = ? AND last_seen >= ${FRESH_SINCE_SQL}`
    )
    .get(playerId, parkId);
}

// Everyone currently (freshly) checked in at a park — the pool squads
// and subs get picked from.
function getCheckedInPlayers(parkId) {
  return db
    .prepare(
      `SELECT p.id, u.name, c.last_seen
       FROM check_ins c
       JOIN players p ON p.id = c.player_id
       JOIN users u ON u.id = p.user_id
       WHERE c.park_id = ? AND c.last_seen >= ${FRESH_SINCE_SQL}
       ORDER BY u.name ASC`
    )
    .all(parkId);
}

// A waiting squad's full roster (captain + members), captain first.
function getSquadRoster(nextLineId) {
  return db
    .prepare(
      `SELECT u.id AS id, u.name AS name, (p.id = nl.captain_player_id) AS isCaptain
       FROM next_line nl
       JOIN players p ON p.id = nl.captain_player_id
       JOIN users u ON u.id = p.user_id
       WHERE nl.id = ?
       UNION ALL
       SELECT u.id AS id, u.name AS name, 0 AS isCaptain
       FROM next_line_members nlm
       JOIN players p ON p.id = nlm.player_id
       JOIN users u ON u.id = p.user_id
       WHERE nlm.next_line_id = ?
       ORDER BY isCaptain DESC`
    )
    .all(nextLineId, nextLineId);
}

// The waiting squads for a court, in line order, each with its roster.
function getWaitingSquads(courtId) {
  const squads = db
    .prepare(
      `SELECT * FROM next_line WHERE court_id = ? AND status = 'waiting' ORDER BY position ASC`
    )
    .all(courtId);
  return squads.map((squad) => {
    const roster = getSquadRoster(squad.id);
    return { ...squad, roster, count: roster.length, ready: roster.length >= 5 };
  });
}

// Drops a stale player (last_seen > 5 min old) from a waiting squad. If
// they were the captain, the next member in line is promoted; if the
// squad is now empty, it's removed from the queue entirely.
function tickQueueForCourt(courtId) {
  const squads = db
    .prepare(`SELECT * FROM next_line WHERE court_id = ? AND status = 'waiting'`)
    .all(courtId);

  for (const squad of squads) {
    const captainFresh = db
      .prepare(
        `SELECT 1 FROM check_ins ci
         JOIN next_line nl ON nl.id = ?
         WHERE ci.player_id = nl.captain_player_id AND ci.park_id = (SELECT park_id FROM courts WHERE id = nl.court_id)
           AND ci.last_seen >= ${FRESH_SINCE_SQL}`
      )
      .get(squad.id);

    if (!captainFresh) {
      const nextMember = db
        .prepare('SELECT player_id FROM next_line_members WHERE next_line_id = ? ORDER BY rowid ASC LIMIT 1')
        .get(squad.id);
      if (nextMember) {
        db.prepare('UPDATE next_line SET captain_player_id = ? WHERE id = ?').run(nextMember.player_id, squad.id);
        db.prepare('DELETE FROM next_line_members WHERE next_line_id = ? AND player_id = ?').run(squad.id, nextMember.player_id);
      } else {
        db.prepare('DELETE FROM next_line WHERE id = ?').run(squad.id);
        continue;
      }
    }

    const parkId = db.prepare('SELECT park_id FROM courts WHERE id = ?').get(squad.court_id).park_id;
    const staleMembers = db
      .prepare(
        `SELECT nlm.player_id FROM next_line_members nlm
         LEFT JOIN check_ins ci ON ci.player_id = nlm.player_id AND ci.park_id = ? AND ci.last_seen >= ${FRESH_SINCE_SQL}
         WHERE nlm.next_line_id = ? AND ci.id IS NULL`
      )
      .all(parkId, squad.id);
    for (const { player_id } of staleMembers) {
      db.prepare('DELETE FROM next_line_members WHERE next_line_id = ? AND player_id = ?').run(squad.id, player_id);
    }
  }
}

function nextQueuePosition(courtId) {
  const row = db.prepare('SELECT COALESCE(MAX(position), 0) AS max FROM next_line WHERE court_id = ?').get(courtId);
  return row.max + 1;
}

// "I got next" — only if checked in at the park, and not already queued
// or playing on this court.
function iGotNext(courtId, playerId) {
  const court = getCourtById(courtId);
  if (!court) return { ok: false, error: 'Court not found.' };
  if (!getCheckIn(playerId, court.park_id)) return { ok: false, error: 'Check in at the park first.' };

  const alreadyQueued = db
    .prepare(
      `SELECT 1 FROM next_line nl
       WHERE nl.court_id = ? AND nl.status = 'waiting'
         AND (nl.captain_player_id = ? OR EXISTS (SELECT 1 FROM next_line_members WHERE next_line_id = nl.id AND player_id = ?))`
    )
    .get(courtId, playerId, playerId);
  if (alreadyQueued) return { ok: false, error: "You're already in line on this court." };

  const alreadyPlaying = isPlayerInActiveLiveGame(courtId, playerId);
  if (alreadyPlaying) return { ok: false, error: "You're already in the game on this court." };

  db.prepare(
    `INSERT INTO next_line (court_id, captain_player_id, position, status, created_at)
     VALUES (?, ?, ?, 'waiting', datetime('now'))`
  ).run(courtId, playerId, nextQueuePosition(courtId));

  // Two squads up on an idle court start playing immediately — don't
  // wait for someone to load the court screen to notice.
  ensureLiveGame(courtId);
  return { ok: true };
}

// Captain adds checked-in players to their own squad, up to 5 total.
function addSquadMembers(nextLineId, playerIds, actorPlayerId) {
  const squad = db.prepare('SELECT * FROM next_line WHERE id = ?').get(nextLineId);
  if (!squad || squad.captain_player_id !== actorPlayerId) {
    return { ok: false, error: 'Only the squad captain can do that.' };
  }

  const court = getCourtById(squad.court_id);
  const checkedIn = new Set(getCheckedInPlayers(court.park_id).map((p) => p.id));
  const current = getSquadRoster(nextLineId);
  const currentIds = new Set(current.map((p) => p.id));
  let slotsLeft = 5 - current.length;

  const insertMember = db.prepare('INSERT OR IGNORE INTO next_line_members (next_line_id, player_id) VALUES (?, ?)');
  for (const playerId of playerIds) {
    if (slotsLeft <= 0) break;
    if (currentIds.has(playerId) || !checkedIn.has(playerId)) continue;
    insertMember.run(nextLineId, playerId);
    currentIds.add(playerId);
    slotsLeft -= 1;
  }
  return { ok: true };
}

function isPlayerInActiveLiveGame(courtId, playerId) {
  return !!db
    .prepare(
      `SELECT 1 FROM live_game_players lgp
       JOIN live_games lg ON lg.id = lgp.live_game_id
       WHERE lg.court_id = ? AND lg.status != 'done' AND lgp.player_id = ? AND lgp.time_off IS NULL`
    )
    .get(courtId, playerId);
}

function getActiveLiveGame(courtId) {
  return db
    .prepare(`SELECT * FROM live_games WHERE court_id = ? AND status != 'done' ORDER BY id DESC LIMIT 1`)
    .get(courtId);
}

function getLiveGamePlayers(liveGameId) {
  const rows = db
    .prepare(
      `SELECT lgp.id, lgp.player_id AS playerId, u.name, lgp.team, lgp.captain, lgp.time_on, lgp.time_off
       FROM live_game_players lgp
       JOIN players p ON p.id = lgp.player_id
       JOIN users u ON u.id = p.user_id
       WHERE lgp.live_game_id = ? AND lgp.time_off IS NULL
       ORDER BY lgp.captain DESC, lgp.id ASC`
    )
    .all(liveGameId);
  return {
    a: rows.filter((r) => r.team === 'a'),
    b: rows.filter((r) => r.team === 'b'),
  };
}

// Pulls the first two waiting squads on an idle court straight onto the
// court — teams fill in automatically, game starts right away (no
// between-games wait, since the court wasn't playing anything before).
function ensureLiveGame(courtId) {
  if (getActiveLiveGame(courtId)) return;

  const squads = getWaitingSquads(courtId);
  if (squads.length < 2) return;

  const [squadA, squadB] = squads;
  const court = getCourtById(courtId);
  const park = getParkById(court.park_id);

  db.prepare(
    `INSERT INTO live_games (court_id, park_id, target, status, started_at)
     VALUES (?, ?, ?, 'in_progress', datetime('now'))`
  ).run(courtId, park.id, park.game_target);
  const liveGameId = lastId();

  seatSquad(liveGameId, squadA, 'a', true);
  seatSquad(liveGameId, squadB, 'b', true);

  db.prepare('DELETE FROM next_line_members WHERE next_line_id IN (?, ?)').run(squadA.id, squadB.id);
  db.prepare('DELETE FROM next_line WHERE id IN (?, ?)').run(squadA.id, squadB.id);
}

function seatSquad(liveGameId, squad, team, startNow) {
  const insert = db.prepare(
    `INSERT INTO live_game_players (live_game_id, player_id, team, captain, time_on)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const player of squad.roster) {
    insert.run(liveGameId, player.id, team, player.isCaptain ? 1 : 0, startNow ? sqliteNow() : null);
  }
}

function sqliteNow() {
  return toSqliteDateTime(new Date());
}

// Resolves a finished between-games countdown: if the next team is
// still fully present, the game starts; otherwise they drop to the
// back of the line and whoever's now at the front gets a fresh countdown.
function resolveCountdown(courtId) {
  const game = getActiveLiveGame(courtId);
  if (!game || game.status !== 'countdown') return;
  if (new Date(game.countdown_ends_at + 'Z').getTime() > Date.now()) return;

  const teamB = db.prepare(`SELECT * FROM live_game_players WHERE live_game_id = ? AND team = 'b'`).all(game.id);
  const park = getParkById(game.park_id);
  const allFresh = teamB.length > 0 && teamB.every((p) => getCheckIn(p.player_id, park.id));

  if (allFresh) {
    db.prepare(`UPDATE live_games SET status = 'in_progress', started_at = datetime('now') WHERE id = ?`).run(game.id);
    db.prepare(`UPDATE live_game_players SET time_on = datetime('now') WHERE live_game_id = ? AND time_on IS NULL`).run(game.id);
    return;
  }

  // Not ready — drop team B to the back of the line (if anyone's left
  // to requeue), then try to pull in whoever's now at the front.
  if (teamB.length > 0) {
    const captain = teamB.find((p) => p.captain) || teamB[0];
    db.prepare(
      `INSERT INTO next_line (court_id, captain_player_id, position, status, created_at)
       VALUES (?, ?, ?, 'waiting', datetime('now'))`
    ).run(courtId, captain.player_id, nextQueuePosition(courtId));
    const nextLineId = lastId();
    for (const p of teamB) {
      if (p.player_id !== captain.player_id) {
        db.prepare('INSERT INTO next_line_members (next_line_id, player_id) VALUES (?, ?)').run(nextLineId, p.player_id);
      }
    }
  }
  db.prepare(`DELETE FROM live_game_players WHERE live_game_id = ? AND team = 'b'`).run(game.id);

  const nextSquad = getWaitingSquads(courtId)[0];
  if (nextSquad) {
    seatSquad(game.id, nextSquad, 'b', false);
    db.prepare('DELETE FROM next_line_members WHERE next_line_id = ?').run(nextSquad.id);
    db.prepare('DELETE FROM next_line WHERE id = ?').run(nextSquad.id);
    db.prepare(
      `UPDATE live_games SET countdown_ends_at = datetime('now', '+' || countdown_seconds || ' seconds') WHERE id = ?`
    ).run(game.id);
  } else {
    // Nobody else waiting — put the court back to idle with the
    // (still-seated) winners re-queued at the front so they show up
    // as "next up" again once a new squad arrives.
    const teamA = db.prepare(`SELECT * FROM live_game_players WHERE live_game_id = ? AND team = 'a'`).all(game.id);
    const captain = teamA.find((p) => p.captain) || teamA[0];
    const frontPosition = db.prepare('SELECT COALESCE(MIN(position), 1) AS min FROM next_line WHERE court_id = ?').get(courtId).min - 1;
    db.prepare(
      `INSERT INTO next_line (court_id, captain_player_id, position, status, created_at)
       VALUES (?, ?, ?, 'waiting', datetime('now'))`
    ).run(courtId, captain.player_id, frontPosition);
    const nextLineId = lastId();
    for (const p of teamA) {
      if (p.player_id !== captain.player_id) {
        db.prepare('INSERT INTO next_line_members (next_line_id, player_id) VALUES (?, ?)').run(nextLineId, p.player_id);
      }
    }
    db.prepare('DELETE FROM live_game_players WHERE live_game_id = ?').run(game.id);
    db.prepare('DELETE FROM live_games WHERE id = ?').run(game.id);
  }
}

// Runs everything time-based for a court: expire stale queue members,
// resolve a finished countdown, then start a game if two squads are up.
function tickCourt(courtId) {
  tickQueueForCourt(courtId);
  resolveCountdown(courtId);
  ensureLiveGame(courtId);
}

function isCaptainOf(liveGameId, playerId) {
  return db
    .prepare('SELECT team FROM live_game_players WHERE live_game_id = ? AND player_id = ? AND captain = 1')
    .get(liveGameId, playerId);
}

// A captain marks a player "left": closes their stint if the game has
// started, or just un-seats them if it's still the between-games wait.
function markLeft(liveGameId, playerId, actorPlayerId) {
  const game = db.prepare('SELECT * FROM live_games WHERE id = ?').get(liveGameId);
  if (!game || !isCaptainOf(liveGameId, actorPlayerId)) return { ok: false, error: 'Only a captain can do that.' };

  const row = db
    .prepare('SELECT * FROM live_game_players WHERE live_game_id = ? AND player_id = ? AND time_off IS NULL')
    .get(liveGameId, playerId);
  if (!row) return { ok: false, error: 'Player not found on court.' };

  if (row.time_on === null) {
    db.prepare('DELETE FROM live_game_players WHERE id = ?').run(row.id);
  } else {
    db.prepare("UPDATE live_game_players SET time_off = datetime('now') WHERE id = ?").run(row.id);
  }
  return { ok: true };
}

// A captain adds a sub from who's checked in — fills a short roster
// during the countdown, or swaps in mid-game.
function addSub(liveGameId, team, playerId, actorPlayerId) {
  const game = db.prepare('SELECT * FROM live_games WHERE id = ?').get(liveGameId);
  if (!game || !isCaptainOf(liveGameId, actorPlayerId)) return { ok: false, error: 'Only a captain can do that.' };

  if (!getCheckIn(playerId, game.park_id)) return { ok: false, error: 'That player is not checked in.' };
  if (isPlayerInActiveLiveGame(game.court_id, playerId)) return { ok: false, error: 'That player is already on the court.' };
  const queued = db
    .prepare(
      `SELECT 1 FROM next_line nl
       WHERE nl.status = 'waiting'
         AND (nl.captain_player_id = ? OR EXISTS (SELECT 1 FROM next_line_members WHERE next_line_id = nl.id AND player_id = ?))`
    )
    .get(playerId, playerId);
  if (queued) return { ok: false, error: "That player is already in line somewhere." };

  db.prepare(
    `INSERT INTO live_game_players (live_game_id, player_id, team, captain, time_on)
     VALUES (?, ?, ?, 0, ?)`
  ).run(liveGameId, playerId, team, game.status === 'in_progress' ? sqliteNow() : null);
  return { ok: true };
}

// A captain taps which team won; the other captain's confirm locks it.
function declareWinner(liveGameId, team, actorPlayerId) {
  const game = db.prepare('SELECT * FROM live_games WHERE id = ?').get(liveGameId);
  if (!game || game.status !== 'in_progress') return { ok: false, error: 'No game in progress to score.' };
  const captainTeam = isCaptainOf(liveGameId, actorPlayerId);
  if (!captainTeam) return { ok: false, error: 'Only a captain can declare a winner.' };

  db.prepare(
    `UPDATE live_games SET status = 'awaiting_confirmation', team_a_won = ?, confirmed_a = ?, confirmed_b = ? WHERE id = ?`
  ).run(team === 'a' ? 1 : 0, captainTeam.team === 'a' ? 1 : 0, captainTeam.team === 'b' ? 1 : 0, liveGameId);
  return { ok: true };
}

function confirmResult(liveGameId, actorPlayerId) {
  const game = db.prepare('SELECT * FROM live_games WHERE id = ?').get(liveGameId);
  if (!game || game.status !== 'awaiting_confirmation') return { ok: false, error: 'Nothing to confirm.' };
  const captainTeam = isCaptainOf(liveGameId, actorPlayerId);
  if (!captainTeam) return { ok: false, error: 'Only a captain can confirm.' };

  const declaringTeam = game.team_a_won ? 'a' : 'b';
  if (captainTeam.team === declaringTeam) return { ok: false, error: 'Waiting on the other captain to confirm.' };

  const column = captainTeam.team === 'a' ? 'confirmed_a' : 'confirmed_b';
  db.prepare(`UPDATE live_games SET ${column} = 1 WHERE id = ?`).run(liveGameId);

  const updated = db.prepare('SELECT * FROM live_games WHERE id = ?').get(liveGameId);
  if (updated.confirmed_a && updated.confirmed_b) {
    lockResult(updated);
  }
  return { ok: true };
}

// Saves game_results for every player who took the court, starts the
// between-games countdown (winners stay on vs. whoever's next in line),
// or — if nobody's waiting — re-queues the winners at the front.
function lockResult(game) {
  // Capture who was still actually on the court BEFORE the final sweep
  // closes everyone out — a player already subbed/marked-left earlier
  // in this game shouldn't be treated as "stayed on" for the next one.
  const stillOnCourt = new Set(
    db
      .prepare(`SELECT player_id FROM live_game_players WHERE live_game_id = ? AND time_off IS NULL`)
      .all(game.id)
      .map((r) => r.player_id)
  );

  db.prepare(`UPDATE live_game_players SET time_off = datetime('now') WHERE live_game_id = ? AND time_off IS NULL`).run(game.id);

  const players = db.prepare('SELECT * FROM live_game_players WHERE live_game_id = ?').all(game.id);
  const byPlayer = new Map();
  for (const row of players) {
    const minutes = row.time_on
      ? Math.round((new Date(row.time_off + 'Z') - new Date(row.time_on + 'Z')) / 60000)
      : 0;
    const prior = byPlayer.get(row.player_id) || { team: row.team, captain: row.captain, minutes: 0 };
    prior.minutes += minutes;
    byPlayer.set(row.player_id, prior);
  }

  const winningTeam = game.team_a_won ? 'a' : 'b';
  const gameId = nextGameId();
  for (const [playerId, info] of byPlayer) {
    applyGameResult(gameId, game.park_id, game.court_id, playerId, info.team === winningTeam ? 'win' : 'loss', Math.max(info.minutes, 0));
  }

  db.prepare(`UPDATE live_games SET status = 'done', locked_at = datetime('now') WHERE id = ?`).run(game.id);

  const winners = [...byPlayer.entries()].filter(
    ([playerId, info]) => info.team === winningTeam && stillOnCourt.has(playerId)
  );
  // Nobody from the winning team is still around to stay on (everyone
  // subbed out or left) — the court just goes idle; whoever's queued
  // stays queued for the normal two-squads auto-start.
  if (winners.length === 0) return;

  const captainEntry = winners.find(([, info]) => info.captain) || winners[0];
  const park = getParkById(game.park_id);
  const nextSquad = getWaitingSquads(game.court_id)[0];

  db.prepare(
    `INSERT INTO live_games (court_id, park_id, target, status, countdown_seconds, countdown_ends_at)
     VALUES (?, ?, ?, 'countdown', ?, datetime('now', '+' || ? || ' seconds'))`
  ).run(game.court_id, game.park_id, park.game_target, park.between_games_seconds, park.between_games_seconds);
  const newGameId = lastId();

  const insertPlayer = db.prepare(
    `INSERT INTO live_game_players (live_game_id, player_id, team, captain, time_on) VALUES (?, ?, 'a', ?, NULL)`
  );
  for (const [playerId, info] of winners) {
    insertPlayer.run(newGameId, playerId, info.captain ? 1 : 0);
  }

  if (nextSquad) {
    seatSquad(newGameId, nextSquad, 'b', false);
    db.prepare('DELETE FROM next_line_members WHERE next_line_id = ?').run(nextSquad.id);
    db.prepare('DELETE FROM next_line WHERE id = ?').run(nextSquad.id);
  } else {
    // No one waiting — skip the countdown; the court shows the winners
    // as "next up" until a new squad arrives. Delete the child rows
    // first — live_game_players.live_game_id has no ON DELETE CASCADE.
    db.prepare('DELETE FROM live_game_players WHERE live_game_id = ?').run(newGameId);
    db.prepare('DELETE FROM live_games WHERE id = ?').run(newGameId);
    const frontPosition = db.prepare('SELECT COALESCE(MIN(position), 1) AS min FROM next_line WHERE court_id = ?').get(game.court_id).min - 1;
    db.prepare(
      `INSERT INTO next_line (court_id, captain_player_id, position, status, created_at)
       VALUES (?, ?, ?, 'waiting', datetime('now'))`
    ).run(game.court_id, captainEntry[0], frontPosition);
    const nextLineId = lastId();
    for (const [playerId] of winners) {
      if (playerId !== captainEntry[0]) {
        db.prepare('INSERT INTO next_line_members (next_line_id, player_id) VALUES (?, ?)').run(nextLineId, playerId);
      }
    }
  }
}

function applyGameResult(gameId, parkId, courtId, playerId, result, minutes) {
  db.prepare(
    `INSERT INTO game_results (game_id, player_id, park_id, court_id, result, minutes_played)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(gameId, playerId, parkId, courtId, result, minutes);
  db.prepare(
    `UPDATE players SET ${result === 'win' ? 'wins' : 'losses'} = ${result === 'win' ? 'wins' : 'losses'} + 1, games_played = games_played + 1 WHERE id = ?`
  ).run(playerId);
}

function updateParkSettings(parkId, { gameTarget, betweenGamesSeconds }) {
  db.prepare('UPDATE parks SET game_target = ?, between_games_seconds = ? WHERE id = ?').run(gameTarget, betweenGamesSeconds, parkId);
}

// Everything the court screen needs, assembled from the pieces above.
function getCourtScreen(courtId, viewerPlayerId) {
  tickCourt(courtId);

  const court = getCourtById(courtId);
  const park = getParkById(court.park_id);
  const courts = getCourtsByPark(park.id);

  const checkIn = getCheckIn(viewerPlayerId, park.id);
  const queue = getWaitingSquads(courtId);

  const game = getActiveLiveGame(courtId);
  let liveGame = null;
  if (game) {
    const teams = getLiveGamePlayers(game.id);
    liveGame = {
      ...game,
      teamA: teams.a,
      teamB: teams.b,
      viewerCaptainTeam: (isCaptainOf(game.id, viewerPlayerId) || {}).team || null,
    };
  }

  const viewerSquad = queue.find((s) => s.roster.some((p) => p.id === viewerPlayerId)) || null;
  const viewerIsCaptain = viewerSquad && viewerSquad.captain_player_id === viewerPlayerId;
  const viewerPlaying = isPlayerInActiveLiveGame(courtId, viewerPlayerId);

  const takenIds = new Set([
    ...queue.flatMap((s) => s.roster.map((p) => p.id)),
    ...(liveGame ? [...liveGame.teamA, ...liveGame.teamB].map((p) => p.playerId) : []),
  ]);
  const availablePlayers = getCheckedInPlayers(park.id).filter((p) => !takenIds.has(p.id));

  return {
    court,
    park,
    courts,
    checkedIn: !!checkIn,
    queue,
    liveGame,
    viewerSquad,
    viewerIsCaptain,
    viewerPlaying,
    availablePlayers,
  };
}

module.exports = {
  getUserByPhone,
  getPlayerByUserId,
  createUserAndPlayer,
  getPlayerProfile,
  getTiers,
  getOpenLobbies,
  getLobbyRoster,
  isPlayerInGame,
  joinLobby,
  getLobbyById,
  getParks,
  getParkById,
  getCourtsByPark,
  getCourtById,
  getSeasonWindow,
  CROWN_LEVELS,
  getCrownLevel,
  getParkStandings,
  getCityStandings,
  getLeaderboard,
  checkIn,
  heartbeat,
  getCheckIn,
  getCheckedInPlayers,
  getCourtScreen,
  iGotNext,
  addSquadMembers,
  markLeft,
  addSub,
  declareWinner,
  confirmResult,
  updateParkSettings,
  CHECK_IN_FRESH_MINUTES,
};
