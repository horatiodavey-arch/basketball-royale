const { db, formingGameFor, lastId, cityFromAddress, runOnce, newUniqueTag } = require('./index');

function getUserByPhone(phone) {
  return db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
}

function getPlayerByUserId(userId) {
  return db.prepare('SELECT * FROM players WHERE user_id = ?').get(userId);
}

// Shown after every display name, e.g. "Big Sniper #4821".
const DISPLAY_NAME = "(u.name || ' #' || u.tag)";

// Internal test accounts have a display name starting with "TEST". They are
// kept out of the leaderboard, crowns and every admin number.
function notTestSql(column) {
  return `${column} NOT IN (SELECT p.id FROM players p JOIN users u ON u.id = p.user_id WHERE u.name GLOB 'TEST*')`;
}
function testPlayerIds() {
  return new Set(
    db.prepare("SELECT p.id FROM players p JOIN users u ON u.id = p.user_id WHERE u.name GLOB 'TEST*'").all().map((r) => r.id)
  );
}

// Names that would be confused with the tier ladder are reserved. Matched
// ignoring case and spaces, so "Super Star" is blocked too.
const RESERVED_NAMES = ['rookie', 'starter', 'star', 'superstar'];

function displayNameError(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return 'Enter a name.';
  if (trimmed.length > 30) return 'Keep names to 30 characters or fewer.';
  if (RESERVED_NAMES.includes(trimmed.toLowerCase().replace(/\s+/g, ''))) {
    return "That name is reserved. Pick another.";
  }
  return null;
}

// The player id behind an invite tag (e.g. the 4821 in ?ref=4821), or null.
function getPlayerIdByTag(tag) {
  const row = db
    .prepare('SELECT p.id FROM players p JOIN users u ON u.id = p.user_id WHERE u.tag = ?')
    .get(String(tag));
  return row ? row.id : null;
}

// source: where the link came from (?src=), defaulting to 'direct'.
// referrerPlayerId: who invited them (?ref=), or null.
function createUserAndPlayer(name, phone, { source = 'direct', referrerPlayerId = null } = {}) {
  const insertUser = db.prepare(
    'INSERT INTO users (name, phone, tag, source, referred_by_player_id) VALUES (?, ?, ?, ?, ?)'
  );
  insertUser.run(name, phone, newUniqueTag(), source || 'direct', referrerPlayerId);
  const userId = db.prepare('SELECT last_insert_rowid() AS id').get().id;

  db.prepare('INSERT INTO players (user_id) VALUES (?)').run(userId);
  const playerId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  recordMilestone(playerId, 'signup');

  return { userId, playerId };
}

// Player + their user profile + their tier's promotion rules, in one row.
function getPlayerProfile(userId) {
  return db
    .prepare(
      `SELECT u.id AS user_id, u.name AS base_name, ${DISPLAY_NAME} AS name, u.phone, u.tag,
              u.how_it_works_shown_at, u.how_it_works_dismissed_at,
              p.id AS player_id, p.tier, p.wins, p.losses, p.games_played,
              p.is_organizer,
              t.rank AS tier_rank, t.wins_to_promote, t.games_to_promote,
              t.min_stake_cents AS tier_min_stake_cents
       FROM users u
       JOIN players p ON p.user_id = u.id
       JOIN tiers t ON t.name = p.tier
       WHERE u.id = ?`
    )
    .get(userId);
}

// Same shape as getPlayerProfile, but looked up by player id instead of
// user id — for viewing someone else's profile (from the leaderboard).
function getPlayerProfileByPlayerId(playerId) {
  return db
    .prepare(
      `SELECT u.id AS user_id, u.name AS base_name, ${DISPLAY_NAME} AS name, u.phone, u.tag,
              p.id AS player_id, p.tier, p.wins, p.losses, p.games_played,
              p.is_organizer,
              t.rank AS tier_rank, t.wins_to_promote, t.games_to_promote,
              t.min_stake_cents AS tier_min_stake_cents
       FROM users u
       JOIN players p ON p.user_id = u.id
       JOIN tiers t ON t.name = p.tier
       WHERE p.id = ?`
    )
    .get(playerId);
}

// Flags a single account as organizer if its phone is in ORGANIZER_PHONES
// — called on every signup/login (see db/index.js's applyOrganizerPhones
// for the boot-time equivalent, covering accounts that already existed
// before the env var was set).
function syncOrganizerFlag(phone) {
  const phones = (process.env.ORGANIZER_PHONES || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!phones.includes(phone)) return;
  db.prepare(
    `UPDATE players SET is_organizer = 1
     WHERE user_id IN (SELECT id FROM users WHERE phone = ?)`
  ).run(phone);
}

function getTiers() {
  return db.prepare('SELECT * FROM tiers ORDER BY rank ASC').all();
}

function getOpenLobbies() {
  return db
    .prepare(
      `SELECT l.*, p.name AS park_name, p.city AS park_city, p.location AS park_location,
              p.lat AS park_lat, p.lng AS park_lng
       FROM lobbies l
       LEFT JOIN parks p ON p.id = l.park_id
       WHERE l.status = 'open'
       ORDER BY l.starts_at ASC`
    )
    .all();
}

// Names of everyone currently in a lobby's forming game (the roster
// shown on the lobby card, e.g. "6 locked in · Darius, Chris + 4 more").
function getLobbyRoster(lobbyId) {
  const game = formingGameFor(lobbyId);
  if (!game) return { gameId: null, players: [] };

  const players = db
    .prepare(
      `SELECT u.id AS user_id, ${DISPLAY_NAME} AS name
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

// Paid lobby games this player has actually finished — what the ladder's
// "X of 10 paid games" counts. A lobby they've only joined doesn't count
// until its game is locked. (King of the Court games aren't paid games.)
function getPaidGamesPlayed(playerId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM game_players gp
       JOIN games g ON g.id = gp.game_id
       JOIN lobbies l ON l.id = g.lobby_id
       WHERE gp.player_id = ? AND g.status = 'locked' AND l.stake_cents > 0`
    )
    .get(playerId).n;
}

// ============================================================
// KING OF THE COURT
// ============================================================

// cover_filename is the organizer-chosen cover photo's file (served at
// /park-photos/<filename>), or null when the park has no photo yet.
function getParks() {
  return db
    .prepare(
      `SELECT p.*, ph.filename AS cover_filename
       FROM parks p
       LEFT JOIN park_photos ph ON ph.id = p.cover_photo_id
       ORDER BY p.name ASC`
    )
    .all();
}

function getParkById(id) {
  return db
    .prepare(
      `SELECT p.*, ${DISPLAY_NAME} AS added_by_name, ph.filename AS cover_filename
       FROM parks p
       LEFT JOIN players pl ON pl.id = p.added_by_player_id
       LEFT JOIN users u ON u.id = pl.user_id
       LEFT JOIN park_photos ph ON ph.id = p.cover_photo_id
       WHERE p.id = ?`
    )
    .get(id);
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
              ${DISPLAY_NAME} AS name,
              p.tier,
              SUM(CASE WHEN gr.result = 'win' THEN 1 ELSE 0 END) AS wins,
              COUNT(*) AS games,
              SUM(gr.minutes_played) AS minutes
       FROM game_results gr
       JOIN players p ON p.id = gr.player_id
       JOIN users u ON u.id = p.user_id
       WHERE ${whereClause} AND u.name NOT GLOB 'TEST*'
       GROUP BY gr.player_id`
    )
    .all(...params);

  return rows
    .map((row) => {
      const hours = roundTenth(row.minutes / 60);
      const points = row.wins * 3 + row.games * 1 + hours;
      return { playerId: row.playerId, name: row.name, tier: row.tier, wins: row.wins, games: row.games, hours, points };
    })
    .sort((a, b) => b.points - a.points || b.hours - a.hours);
}

// Every caller wanting the current season passes just seasonStart (nothing
// is dated in the future, so no upper bound is needed). seasonEnd is for
// scoring a season that's already over — see db/trophies.js.
function seasonRange(seasonStart, seasonEnd) {
  return seasonEnd
    ? { sql: 'gr.date >= ? AND gr.date < ?', params: [seasonStart, seasonEnd] }
    : { sql: 'gr.date >= ?', params: [seasonStart] };
}

// Standings at one park for a season — also how a park's king is found.
function getParkStandings(parkId, seasonStart, seasonEnd) {
  const range = seasonRange(seasonStart, seasonEnd);
  return standingsFromGameResults(`gr.park_id = ? AND ${range.sql}`, [parkId, ...range.params]);
}

// Standings across every park for a season (the "City" tab).
function getCityStandings(seasonStart, seasonEnd) {
  const range = seasonRange(seasonStart, seasonEnd);
  return standingsFromGameResults(range.sql, range.params);
}

// playerId -> total season points across every park, for crown level.
function getTotalSeasonPointsByPlayer(seasonStart) {
  const map = new Map();
  for (const row of getCityStandings(seasonStart)) {
    map.set(row.playerId, row.points);
  }
  return map;
}

function getPlayerSeasonPoints(playerId, seasonStart) {
  return getTotalSeasonPointsByPlayer(seasonStart).get(playerId) || 0;
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

// --- Per-format crowns and trophies. Each format (1v1..5v5) keeps its own
// points. They restart every season, and again each time the player earns
// a trophy in that format (purple, 55 pts). Trophies never reset. Only
// results recorded with a format count here; legacy results (no format)
// stay in the all-formats view.
const PURPLE_MIN_POINTS = CROWN_LEVELS[0].min;

// A player's points in one format this season, optionally at one park,
// counting only games since their last trophy in that format.
function formatAggregate(playerId, format, seasonStart, parkId = null) {
  const last = db
    .prepare('SELECT MAX(earned_at) AS at FROM format_trophies WHERE player_id = ? AND format = ?')
    .get(playerId, format).at;
  const rows = db
    .prepare(
      `SELECT gr.result, gr.minutes_played FROM game_results gr
       WHERE gr.player_id = ? AND gr.format = ? AND gr.date >= ?
         AND (? IS NULL OR gr.date > ?)
         AND (? IS NULL OR gr.park_id = ?)`
    )
    .all(playerId, format, seasonStart, last, last, parkId, parkId);
  const wins = rows.filter((r) => r.result === 'win').length;
  const games = rows.length;
  const minutes = rows.reduce((sum, r) => sum + r.minutes_played, 0);
  const hours = roundTenth(minutes / 60);
  return { wins, games, hours, points: wins * 3 + games + hours };
}

// Games a player has played since a date (the profile's "Games" card).
function getGameCountSince(playerId, startSql) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM game_results WHERE player_id = ? AND date >= ?')
    .get(playerId, startSql).n;
}

// The "How it works" card: shown once. Recorded here so it never repeats.
function markHowItWorksShown(playerId) {
  const row = db.prepare('SELECT u.how_it_works_shown_at FROM users u JOIN players p ON p.user_id = u.id WHERE p.id = ?').get(playerId);
  if (!row || row.how_it_works_shown_at) return false;
  db.prepare("UPDATE users SET how_it_works_shown_at = datetime('now') WHERE id = (SELECT user_id FROM players WHERE id = ?)").run(playerId);
  logEvent(playerId, 'how_it_works_seen', '/');
  return true;
}

function dismissHowItWorks(playerId) {
  db.prepare("UPDATE users SET how_it_works_dismissed_at = datetime('now') WHERE id = (SELECT user_id FROM players WHERE id = ?)").run(playerId);
  logEvent(playerId, 'how_it_works_dismissed', '/');
}

// Standings for one format this season (optionally at one park).
function formatStandings(format, seasonStart, parkId = null) {
  const players = db
    .prepare(
      `SELECT DISTINCT gr.player_id AS playerId, ${DISPLAY_NAME} AS name, p.tier
       FROM game_results gr
       JOIN players p ON p.id = gr.player_id
       JOIN users u ON u.id = p.user_id
       WHERE gr.format = ? AND gr.date >= ? AND (? IS NULL OR gr.park_id = ?) AND u.name NOT GLOB 'TEST*'`
    )
    .all(format, seasonStart, parkId, parkId);
  return players
    .map((player) => ({ ...player, ...formatAggregate(player.playerId, format, seasonStart, parkId) }))
    .filter((row) => row.games > 0)
    .sort((a, b) => b.points - a.points || b.hours - a.hours);
}

// Every format, with this player's points, crown and trophy count in each.
function getFormatSummary(playerId, seasonStart) {
  return FORMATS.map((format) => {
    const { points } = formatAggregate(playerId, format, seasonStart);
    const crown = getCrownLevel(points);
    const trophies = db
      .prepare('SELECT COUNT(*) AS n FROM format_trophies WHERE player_id = ? AND format = ?')
      .get(playerId, format).n;
    return {
      format,
      points,
      crown,
      pointsToCrown: crown ? null : roundTenth(CROWN_MIN_POINTS - points),
      trophies,
    };
  });
}

// Called after a format game locks: any player who just reached purple in
// that format earns a trophy, and their progress in it starts over. Several
// trophies in one month are possible.
function awardFormatTrophies(playerIds, format) {
  const { startSql } = getSeasonWindow();
  for (const playerId of new Set(playerIds)) {
    for (;;) {
      const { points } = formatAggregate(playerId, format, startSql);
      if (points < PURPLE_MIN_POINTS) break;
      db.prepare('INSERT INTO format_trophies (player_id, format, points) VALUES (?, ?, ?)').run(
        playerId,
        format,
        roundTenth(points)
      );
    }
  }
}

// "4v4 · Court is open", or just "Court is open" for a legacy court.
function courtFormatLabel(court) {
  const live = getActiveLiveGame(court.id);
  const status = !live ? 'Court is open' : live.status === 'countdown' ? 'Next game starting' : 'Game in progress';
  return court.format ? `${court.format} · ${status}` : status;
}

function getCourtLabelsByPark(parkId) {
  return getCourtsByPark(parkId).map((court) => ({
    name: court.nickname || `Court ${court.number}`,
    label: courtFormatLabel(court),
  }));
}

// The full /board page's data: standings for the chosen scope, each
// row carrying its own crown level (always city-wide) and badge. With a
// format, standings and crowns are that format's alone.
function getLeaderboard({ scope, parkId, seasonStart, format }) {
  if (format) {
    const standings = formatStandings(format, seasonStart, scope === 'city' ? null : parkId);
    const badges = getCrownBadges(seasonStart);
    return standings.map((row, index) => {
      const crown = getCrownLevel(row.points);
      return {
        rank: index + 1,
        ...row,
        totalPoints: row.points,
        crown,
        pointsToCrown: crown ? null : roundTenth(CROWN_MIN_POINTS - row.points),
        badge: badges.get(row.playerId) || null,
      };
    });
  }

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

// --- Crown perks: what each crown level (plus "king of a court") gets
// you. Shown to every player, including a brand new player at 0 points,
// so everyone can see the whole ladder — not just what they've reached.
const CROWN_PERK_DESCRIPTIONS = {
  'In the Mix': 'Your crown shows next to your name everywhere. Counts toward Starter.',
  Contender: 'Eligible to be featured in ROYALE game content.',
  'Playoff Bound': 'Priority captain pick on "I got next."',
  'Best Record in the League': "Guaranteed feature in this month's ROYALE content.",
};

// A park's king is its season standings' rank 1 — same rule getCrownBadges
// uses for Double/Triple Crown, just "at least one" instead of "2+".
function isKingOfAnyPark(playerId, seasonStart) {
  return getParks().some((park) => {
    const standings = getParkStandings(park.id, seasonStart);
    return standings.length > 0 && standings[0].playerId === playerId;
  });
}

// Every perk, ascending, each marked earned/locked against this player's
// current season points (and whether they're king of any park).
function getCrownPerks(playerId, seasonStart) {
  const totalPoints = getTotalSeasonPointsByPlayer(seasonStart).get(playerId) || 0;

  const perks = CROWN_LEVELS.slice()
    .reverse()
    .map((level) => {
      const earned = totalPoints >= level.min;
      const pointsNeeded = earned ? null : roundTenth(level.min - totalPoints);
      return {
        name: level.name,
        description: CROWN_PERK_DESCRIPTIONS[level.name],
        fill: level.fill,
        stroke: level.stroke,
        earned,
        pointsNeeded,
        lockedHint: earned ? null : `${pointsNeeded} pts to unlock`,
      };
    });

  const kingOfAny = isKingOfAnyPark(playerId, seasonStart);
  perks.push({
    name: 'King of a Court',
    description: "Your name on that court's map pin. Invite to the monthly Crown Showdown.",
    fill: '#7A45C2',
    stroke: '#4A2580',
    earned: kingOfAny,
    lockedHint: kingOfAny ? null : 'Take a court to unlock',
  });

  return perks;
}

// How many more points to the next crown level, or null if already at
// the top one. Drives the home screen's "X pts to Y" headline.
function getNextCrownProgress(totalPoints) {
  const next = CROWN_LEVELS.slice()
    .reverse()
    .find((level) => level.min > totalPoints);
  if (!next) return null;
  return { name: next.name, pointsNeeded: roundTenth(next.min - totalPoints) };
}

function nameInitials(name) {
  return name
    .replace(/\s#\d{4}$/, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

// ============================================================
// HOME / MAP — park pins and the selected-park bottom sheet
// ============================================================

function getLiveGameCountByPark(parkId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM live_games lg
       JOIN courts c ON c.id = lg.court_id
       WHERE c.park_id = ? AND lg.status != 'done'`
    )
    .get(parkId).n;
}

// A park's king, with their city-wide crown (the color the pin and the
// king card use) — not the park-scope crown, since crown LEVEL is
// always based on total season points, same rule as everywhere else.
function getParkKing(parkId, seasonStart) {
  const standings = getParkStandings(parkId, seasonStart);
  const row = standings[0];
  if (!row) return null;
  return {
    playerId: row.playerId,
    name: row.name,
    points: row.points,
    crown: getCrownLevel(getPlayerSeasonPoints(row.playerId, seasonStart)),
  };
}

// One pin's worth of data per park, for the map.
// The soonest upcoming run across any of a park's courts — for the map
// pin's "Sat 10am · 6 coming" label and the "nearest court with activity"
// pick on the home screen.
function getParkNextRun(parkId) {
  let soonest = null;
  for (const court of getCourtsByPark(parkId)) {
    const runs = getUpcomingRunsForCourt(court.id, 1);
    if (runs.length > 0 && (!soonest || runs[0].scheduledAt < soonest.scheduledAt)) {
      soonest = runs[0];
    }
  }
  return soonest;
}

function getParkMapPins(seasonStart) {
  const liveParks = getLiveParkIds();
  return getParks().map((park) => ({
    id: park.id,
    name: park.name,
    lat: park.lat,
    lng: park.lng,
    checkInRadiusMeters: park.check_in_radius_meters,
    activeCount: getCheckedInPlayers(park.id).length,
    liveCount: getLiveGameCountByPark(park.id),
    king: getParkKing(park.id, seasonStart),
    nextRun: getParkNextRun(park.id),
    live: liveParks.has(park.id),
  }));
}

// Everything the selected park's bottom sheet needs.
function getParkSheetDetail(parkId, seasonStart, viewerPlayerId) {
  const park = getParkById(parkId);
  const king = getParkKing(parkId, seasonStart);
  const pointsByPlayer = new Map(getParkStandings(parkId, seasonStart).map((r) => [r.playerId, r.points]));

  // The current player first, then everyone else by points at this park.
  const hereNow = getCheckedInPlayers(parkId)
    .map((p) => ({
      id: p.id,
      name: p.name,
      initials: nameInitials(p.name),
      points: pointsByPlayer.get(p.id) || 0,
      crown: getCrownLevel(getPlayerSeasonPoints(p.id, seasonStart)),
      ...previewFields(p.id, seasonStart),
    }))
    .sort((a, b) => (b.id === viewerPlayerId) - (a.id === viewerPlayerId) || b.points - a.points);

  // Shown under the avatars, only to a checked-in player.
  let viewerStatus = '';
  if (king && king.playerId === viewerPlayerId) {
    viewerStatus = "You're the King. Defend your crown.";
  } else if (king) {
    const behind = roundTenth(king.points - (pointsByPlayer.get(viewerPlayerId) || 0));
    viewerStatus = `You're ${behind} pts behind the crown.`;
  }

  const firstCourt = getCourtsByPark(parkId)[0] || null;
  const upcomingRuns = firstCourt ? getUpcomingRunsForCourt(firstCourt.id, 3) : [];

  return {
    park,
    activeCount: hereNow.length,
    liveCount: getLiveGameCountByPark(parkId),
    king,
    hereNow,
    viewerStatus,
    checkedIn: !!getCheckIn(viewerPlayerId, parkId),
    firstCourtId: firstCourt ? firstCourt.id : null,
    upcomingRuns,
    isFollowing: firstCourt ? isFollowingCourt(viewerPlayerId, firstCourt.id) : false,
  };
}

// ============================================================
// LIVE PLAY — check-ins, the next-line queue, and live games
// ============================================================

const CHECK_IN_FRESH_MINUTES = 5;
// SQLite date math on the TEXT timestamps everything else in this file
// uses — "fresh" means last_inside (last heartbeat confirmed within the
// park's leave_radius_meters) is within the window, as of right now. A
// player pinging from outside that radius doesn't count as fresh, even
// if their heartbeat itself is recent.
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

// A fix worse than this isn't trusted to say "you're outside" on its own
// — the client retries once for a better one first (public/geo.js), and
// if the best it got is still this rough, the player is told why.
const POOR_GPS_ACCURACY_METERS = 100;

// Checks the player's reported lat/lng against the park's radius, then
// upserts check_ins (no DB-level UNIQUE on player+park, so check first).
// `accuracy` is the phone's own estimate of how far off that position
// could be, in meters — optional, and only used to explain a rejection.
function checkIn(playerId, parkId, lat, lng, accuracy) {
  const park = getParkById(parkId);
  if (!park) return { ok: false, error: 'Park not found.' };
  if (park.lat === null || park.lng === null) {
    return { ok: false, error: 'This park has no location set yet.' };
  }

  const distance = haversineMeters(lat, lng, park.lat, park.lng);
  if (distance > park.check_in_radius_meters) {
    const weakSignal =
      typeof accuracy === 'number' && accuracy > POOR_GPS_ACCURACY_METERS
        ? ` Your GPS signal is weak (accurate to about ${Math.round(accuracy)}m) — step into the open and try again.`
        : '';
    return {
      ok: false,
      error: `You're ${Math.round(distance)}m from ${park.name} — get within ${park.check_in_radius_meters}m to check in.${weakSignal}`,
    };
  }

  const existing = db
    .prepare('SELECT id FROM check_ins WHERE player_id = ? AND park_id = ?')
    .get(playerId, parkId);
  if (existing) {
    db.prepare(
      "UPDATE check_ins SET time_in = datetime('now'), last_seen = datetime('now'), last_inside = datetime('now') WHERE id = ?"
    ).run(existing.id);
  } else {
    db.prepare(
      "INSERT INTO check_ins (player_id, park_id, last_inside) VALUES (?, ?, datetime('now'))"
    ).run(playerId, parkId);
  }
  return { ok: true };
}

// Check out: removes the check-in, and takes the player out of any waiting
// squad at this park, so nobody is shown here or queued for it after leaving.
// Refused while they're in a game here: they finish it first.
function checkOut(playerId, parkId) {
  const inGame = db
    .prepare(
      `SELECT 1 FROM live_game_players lgp
       JOIN live_games lg ON lg.id = lgp.live_game_id
       WHERE lgp.player_id = ? AND lg.park_id = ? AND lgp.time_off IS NULL
         AND lg.status IN ('countdown', 'in_progress', 'awaiting_confirmation')`
    )
    .get(playerId, parkId);
  if (inGame) return { ok: false, error: "You're in a game here. Finish it before you check out." };

  const waitingSquads = `SELECT nl.id FROM next_line nl JOIN courts c ON c.id = nl.court_id
                         WHERE c.park_id = ? AND nl.status = 'waiting'`;
  db.prepare(`DELETE FROM next_line_members WHERE player_id = ? AND next_line_id IN (${waitingSquads})`).run(playerId, parkId);
  db.prepare(`DELETE FROM next_line_members WHERE next_line_id IN (${waitingSquads}) AND next_line_id IN (SELECT id FROM next_line WHERE captain_player_id = ?)`).run(parkId, playerId);
  db.prepare(`DELETE FROM next_line WHERE status = 'waiting' AND captain_player_id = ? AND court_id IN (SELECT id FROM courts WHERE park_id = ?)`).run(playerId, parkId);
  db.prepare('DELETE FROM check_ins WHERE player_id = ? AND park_id = ?').run(playerId, parkId);
  logEvent(playerId, 'check_out', `/parks/${parkId}`, parkId);
  return { ok: true };
}

// last_seen always advances (we heard from the client); last_inside only
// advances when their reported position is within the park's
// leave_radius_meters — that's the clock that actually gates presence.
// No position reported (geolocation failed client-side) counts the same
// as being outside: the "inside" clock just doesn't get extended.
function heartbeat(playerId, parkId, lat, lng) {
  const park = getParkById(parkId);
  if (!park) return { ok: false };

  const hasPosition = typeof lat === 'number' && typeof lng === 'number' && park.lat !== null;
  const inside = hasPosition && haversineMeters(lat, lng, park.lat, park.lng) <= park.leave_radius_meters;

  const result = db
    .prepare(
      `UPDATE check_ins SET last_seen = datetime('now')${inside ? ", last_inside = datetime('now')" : ''}
       WHERE player_id = ? AND park_id = ?`
    )
    .run(playerId, parkId);
  return { ok: result.changes > 0, inside };
}

// Fresh (within 5 min, and within the leave radius) check-in for this
// player at this park, or null.
function getCheckIn(playerId, parkId) {
  return db
    .prepare(
      `SELECT * FROM check_ins WHERE player_id = ? AND park_id = ? AND last_inside >= ${FRESH_SINCE_SQL}`
    )
    .get(playerId, parkId);
}

// Everyone currently (freshly) checked in at a park — the pool squads
// and subs get picked from.
function getCheckedInPlayers(parkId) {
  return db
    .prepare(
      `SELECT p.id, ${DISPLAY_NAME} AS name, c.last_seen
       FROM check_ins c
       JOIN players p ON p.id = c.player_id
       JOIN users u ON u.id = p.user_id
       WHERE c.park_id = ? AND c.last_inside >= ${FRESH_SINCE_SQL}
       ORDER BY u.name ASC`
    )
    .all(parkId);
}

// A waiting squad's full roster (captain + members), captain first.
function getSquadRoster(nextLineId) {
  return db
    .prepare(
      `SELECT u.id AS id, ${DISPLAY_NAME} AS name, (p.id = nl.captain_player_id) AS isCaptain
       FROM next_line nl
       JOIN players p ON p.id = nl.captain_player_id
       JOIN users u ON u.id = p.user_id
       WHERE nl.id = ?
       UNION ALL
       SELECT u.id AS id, ${DISPLAY_NAME} AS name, 0 AS isCaptain
       FROM next_line_members nlm
       JOIN players p ON p.id = nlm.player_id
       JOIN users u ON u.id = p.user_id
       WHERE nlm.next_line_id = ?
       ORDER BY isCaptain DESC`
    )
    .all(nextLineId, nextLineId);
}

const FORMATS = ['1v1', '2v2', '3v3', '4v4', '5v5'];

// '4v4' -> 4 players per team. Null for a legacy court (no format set),
// which keeps the old 5-a-side rules.
function formatSize(format) {
  return format ? Number(format.charAt(0)) : null;
}

// The waiting squads for a court, in line order, each with its roster.
// `locked` means the squad can take the court: full for the format and
// confirmed by its captain. Legacy courts have no confirmation step.
function getWaitingSquads(courtId) {
  const court = getCourtById(courtId);
  const size = formatSize(court.format);
  const squads = db
    .prepare(
      `SELECT * FROM next_line WHERE court_id = ? AND status = 'waiting' ORDER BY position ASC`
    )
    .all(courtId);
  return squads.map((squad) => {
    const roster = getSquadRoster(squad.id);
    const ready = size ? roster.length === size : roster.length >= 5;
    const locked = size ? ready && squad.confirmed === 1 : true;
    return { ...squad, roster, count: roster.length, ready, locked, size };
  });
}

// Drops a stale player (outside the park's leave radius for 5+ min) from
// a waiting squad. If they were the captain, the next member in line is
// promoted; if the squad is now empty, it's removed from the queue entirely.
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
           AND ci.last_inside >= ${FRESH_SINCE_SQL}`
      )
      .get(squad.id);

    if (!captainFresh) {
      const nextMember = db
        .prepare('SELECT player_id FROM next_line_members WHERE next_line_id = ? ORDER BY rowid ASC LIMIT 1')
        .get(squad.id);
      if (nextMember) {
        db.prepare('UPDATE next_line SET captain_player_id = ?, confirmed = 0 WHERE id = ?').run(nextMember.player_id, squad.id);
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
         LEFT JOIN check_ins ci ON ci.player_id = nlm.player_id AND ci.park_id = ? AND ci.last_inside >= ${FRESH_SINCE_SQL}
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
  const size = formatSize(court.format) || 5;
  let slotsLeft = size - current.length;

  const insertMember = db.prepare('INSERT OR IGNORE INTO next_line_members (next_line_id, player_id) VALUES (?, ?)');
  let added = 0;
  for (const playerId of playerIds) {
    if (slotsLeft <= 0) break;
    if (currentIds.has(playerId) || !checkedIn.has(playerId)) continue;
    insertMember.run(nextLineId, playerId);
    currentIds.add(playerId);
    slotsLeft -= 1;
    added += 1;
  }
  if (added > 0) clearRosterConfirmation(nextLineId);
  return { ok: true };
}

function clearRosterConfirmation(nextLineId) {
  db.prepare('UPDATE next_line SET confirmed = 0 WHERE id = ?').run(nextLineId);
}

function captainOnly(nextLineId, actorPlayerId) {
  const squad = db.prepare('SELECT * FROM next_line WHERE id = ?').get(nextLineId);
  if (!squad || squad.captain_player_id !== actorPlayerId) {
    return { ok: false, error: 'Only the squad captain can do that.' };
  }
  return { ok: true, squad };
}

// The captain drops a teammate from their squad before confirming.
function removeSquadMember(nextLineId, playerId, actorPlayerId) {
  const check = captainOnly(nextLineId, actorPlayerId);
  if (!check.ok) return check;
  if (playerId === actorPlayerId) return { ok: false, error: "You can't remove yourself as captain." };
  db.prepare('DELETE FROM next_line_members WHERE next_line_id = ? AND player_id = ?').run(nextLineId, playerId);
  clearRosterConfirmation(nextLineId);
  return { ok: true };
}

// The captain confirms the roster. Once both squads are full and
// confirmed, the game can start (see ensureLiveGame).
function confirmSquad(nextLineId, actorPlayerId) {
  const check = captainOnly(nextLineId, actorPlayerId);
  if (!check.ok) return check;
  const court = getCourtById(check.squad.court_id);
  const size = formatSize(court.format);
  const count = getSquadRoster(nextLineId).length;
  if (size && count !== size) return { ok: false, error: `Pick exactly ${size} players before confirming.` };
  db.prepare('UPDATE next_line SET confirmed = 1 WHERE id = ?').run(nextLineId);
  ensureLiveGame(court.id);
  return { ok: true };
}

// The captain hands the role to a teammate. The new captain confirms again.
function handOffCaptain(nextLineId, newCaptainPlayerId, actorPlayerId) {
  const check = captainOnly(nextLineId, actorPlayerId);
  if (!check.ok) return check;
  const isMember = db
    .prepare('SELECT 1 FROM next_line_members WHERE next_line_id = ? AND player_id = ?')
    .get(nextLineId, newCaptainPlayerId);
  if (!isMember) return { ok: false, error: 'Hand the captain role to someone already in your squad.' };
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM next_line_members WHERE next_line_id = ? AND player_id = ?').run(nextLineId, newCaptainPlayerId);
    db.prepare('INSERT OR IGNORE INTO next_line_members (next_line_id, player_id) VALUES (?, ?)').run(nextLineId, actorPlayerId);
    db.prepare('UPDATE next_line SET captain_player_id = ?, confirmed = 0 WHERE id = ?').run(newCaptainPlayerId, nextLineId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
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

// The latest roster changes on a game, newest first, for the court screen.
// Changes the display name only. Tag, stats, crowns and trophies stay with
// the account (tied to the phone number).
function updateDisplayName(userId, name) {
  const error = displayNameError(name);
  if (error) return { ok: false, error };
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(name).trim(), userId);
  return { ok: true };
}

function getRosterEdits(liveGameId) {
  return db
    .prepare(
      `SELECT re.team, re.action, ${DISPLAY_NAME} AS name, re.created_at,
              (SELECT (u2.name || ' #' || u2.tag) FROM users u2 JOIN players p2 ON p2.user_id = u2.id WHERE p2.id = re.by_player_id) AS byName
       FROM roster_edits re
       JOIN players p ON p.id = re.player_id
       JOIN users u ON u.id = p.user_id
       WHERE re.live_game_id = ?
       ORDER BY re.id DESC LIMIT 5`
    )
    .all(liveGameId);
}

function getActiveLiveGame(courtId) {
  return db
    .prepare(`SELECT * FROM live_games WHERE court_id = ? AND status != 'done' ORDER BY id DESC LIMIT 1`)
    .get(courtId);
}

function getLiveGamePlayers(liveGameId) {
  const rows = db
    .prepare(
      `SELECT lgp.id, lgp.player_id AS playerId, ${DISPLAY_NAME} AS name, lgp.team, lgp.captain, lgp.time_on, lgp.time_off
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

  const squads = getWaitingSquads(courtId).filter((squad) => squad.locked);
  if (squads.length < 2) return;

  const [squadA, squadB] = squads;
  const court = getCourtById(courtId);
  const park = getParkById(court.park_id);

  db.prepare(
    `INSERT INTO live_games (court_id, park_id, target, status, started_at, format)
     VALUES (?, ?, ?, 'in_progress', datetime('now'), ?)`
  ).run(courtId, park.id, park.game_target, court.format);
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

  const nextSquad = getWaitingSquads(courtId).find((squad) => squad.locked);
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
    db.prepare('UPDATE next_line SET confirmed = 1 WHERE id = ?').run(nextLineId);
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
  const pending = getActiveLiveGame(courtId);
  if (pending) expireStaleResult(pending);
  tickQueueForCourt(courtId);
  resolveCountdown(courtId);
  ensureLiveGame(courtId);
}

function isCaptainOf(liveGameId, playerId) {
  return db
    .prepare('SELECT team FROM live_game_players WHERE live_game_id = ? AND player_id = ? AND captain = 1')
    .get(liveGameId, playerId);
}

// The team a player is on the active roster for (not subbed off), or null.
function activeRosterTeam(liveGameId, playerId) {
  const row = db
    .prepare('SELECT team FROM live_game_players WHERE live_game_id = ? AND player_id = ? AND time_off IS NULL')
    .get(liveGameId, playerId);
  return row ? row.team : null;
}

// Roster can change until the result locks. A change to a result that's
// already waiting on the other team voids that result, so the other team
// has to look at the new roster and submit again.
function rosterCanChange(game) {
  return game.status !== 'done';
}

function logRosterEdit(liveGameId, team, playerId, action, actorPlayerId) {
  db.prepare(
    'INSERT INTO roster_edits (live_game_id, team, player_id, action, by_player_id) VALUES (?, ?, ?, ?, ?)'
  ).run(liveGameId, team, playerId, action, actorPlayerId);
}

function voidPendingResult(game, note) {
  if (game.status !== 'awaiting_confirmation') return;
  if (game.result_submitted_by) logEvent(game.result_submitted_by, 'result_voided', null, game.park_id);
  db.prepare(
    `UPDATE live_games SET status = 'in_progress', team_a_won = NULL, confirmed_a = 0, confirmed_b = 0,
       result_submitted_at = NULL, result_submitted_by = NULL, result_note = ? WHERE id = ?`
  ).run(note, game.id);
}

// A captain marks a player "left": closes their stint if the game has
// started, or just un-seats them if it's still the between-games wait.
function markLeft(liveGameId, playerId, actorPlayerId) {
  const game = db.prepare('SELECT * FROM live_games WHERE id = ?').get(liveGameId);
  const captain = isCaptainOf(liveGameId, actorPlayerId);
  if (!game || !captain) return { ok: false, error: 'Only a captain can do that.' };
  if (!rosterCanChange(game)) return { ok: false, error: 'This result is locked.' };

  const row = db
    .prepare('SELECT * FROM live_game_players WHERE live_game_id = ? AND player_id = ? AND time_off IS NULL')
    .get(liveGameId, playerId);
  if (!row) return { ok: false, error: 'Player not found on court.' };
  if (row.team !== captain.team) return { ok: false, error: "You can only change your own team's roster." };

  if (row.time_on === null) {
    db.prepare('DELETE FROM live_game_players WHERE id = ?').run(row.id);
    logRosterEdit(liveGameId, row.team, playerId, 'removed', actorPlayerId);
  } else {
    db.prepare("UPDATE live_game_players SET time_off = datetime('now') WHERE id = ?").run(row.id);
    logRosterEdit(liveGameId, row.team, playerId, 'left', actorPlayerId);
  }
  voidPendingResult(game, 'The roster changed after the result was submitted. Check the roster and submit the result again.');
  return { ok: true };
}

// A captain adds a sub from who's checked in — fills a short roster
// during the countdown, or swaps in mid-game.
function addSub(liveGameId, team, playerId, actorPlayerId) {
  const game = db.prepare('SELECT * FROM live_games WHERE id = ?').get(liveGameId);
  const captain = isCaptainOf(liveGameId, actorPlayerId);
  if (!game || !captain) return { ok: false, error: 'Only a captain can do that.' };
  if (!rosterCanChange(game)) return { ok: false, error: 'This result is locked.' };
  if (team !== captain.team) return { ok: false, error: "You can only change your own team's roster." };

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
  logRosterEdit(liveGameId, team, playerId, 'added', actorPlayerId);
  voidPendingResult(game, 'The roster changed after the result was submitted. Check the roster and submit the result again.');
  return { ok: true };
}

// A player on the roster says their team won. No score is entered. The
// other team then has 20 minutes to confirm or dispute it.
const RESULT_WINDOW_MINUTES = 20;

function declareWinner(liveGameId, actorPlayerId) {
  const game = db.prepare('SELECT * FROM live_games WHERE id = ?').get(liveGameId);
  if (!game || game.status !== 'in_progress') return { ok: false, error: 'No game in progress to score.' };
  const team = activeRosterTeam(liveGameId, actorPlayerId);
  if (!team) return { ok: false, error: 'Only players on this game can submit a result.' };

  db.prepare(
    `UPDATE live_games SET status = 'awaiting_confirmation', team_a_won = ?, confirmed_a = ?, confirmed_b = ?,
       result_submitted_at = datetime('now'), result_submitted_by = ?, result_note = NULL WHERE id = ?`
  ).run(team === 'a' ? 1 : 0, team === 'a' ? 1 : 0, team === 'b' ? 1 : 0, actorPlayerId, liveGameId);
  logEvent(actorPlayerId, 'result_submitted', null, game.park_id);
  return { ok: true };
}

// The other team confirms the submitted result. Both sides agreeing locks it.
function confirmResult(liveGameId, actorPlayerId) {
  const game = db.prepare('SELECT * FROM live_games WHERE id = ?').get(liveGameId);
  if (!game || game.status !== 'awaiting_confirmation') return { ok: false, error: 'Nothing to confirm.' };
  const team = activeRosterTeam(liveGameId, actorPlayerId);
  if (!team) return { ok: false, error: 'Only players on this game can confirm a result.' };

  const declaringTeam = game.team_a_won ? 'a' : 'b';
  if (team === declaringTeam) return { ok: false, error: 'Waiting on the other team to confirm.' };

  const column = team === 'a' ? 'confirmed_a' : 'confirmed_b';
  db.prepare(`UPDATE live_games SET ${column} = 1 WHERE id = ?`).run(liveGameId);
  logEvent(actorPlayerId, 'result_confirmed', null, game.park_id);

  const updated = db.prepare('SELECT * FROM live_games WHERE id = ?').get(liveGameId);
  if (updated.confirmed_a && updated.confirmed_b) {
    lockResult(updated);
  }
  return { ok: true };
}

// The other team disputes: the result is voided and nothing is saved.
function disputeResult(liveGameId, actorPlayerId) {
  const game = db.prepare('SELECT * FROM live_games WHERE id = ?').get(liveGameId);
  if (!game || game.status !== 'awaiting_confirmation') return { ok: false, error: 'Nothing to dispute.' };
  const team = activeRosterTeam(liveGameId, actorPlayerId);
  if (!team) return { ok: false, error: 'Only players on this game can dispute a result.' };
  if (team === (game.team_a_won ? 'a' : 'b')) return { ok: false, error: 'Only the other team can dispute.' };
  logEvent(actorPlayerId, 'result_disputed', null, game.park_id);
  voidPendingResult(game, 'Disputed. The result was voided. Submit it again once both teams agree.');
  return { ok: true };
}

// A submitted result nobody answers within the window is voided.
function expireStaleResult(game) {
  if (game.status !== 'awaiting_confirmation' || !game.result_submitted_at) return;
  const submittedAt = new Date(game.result_submitted_at + 'Z').getTime();
  if (Date.now() - submittedAt > RESULT_WINDOW_MINUTES * 60 * 1000) {
    voidPendingResult(game, 'No answer within 20 minutes, so the result was voided. Submit it again.');
  }
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
    applyGameResult(gameId, game.park_id, game.court_id, playerId, info.team === winningTeam ? 'win' : 'loss', Math.max(info.minutes, 0), game.format);
    recordMilestone(playerId, 'first_game');
  }
  if (game.format) awardFormatTrophies([...byPlayer.keys()], game.format);

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
  const nextSquad = getWaitingSquads(game.court_id).find((squad) => squad.locked);

  db.prepare(
    `INSERT INTO live_games (court_id, park_id, target, status, countdown_seconds, countdown_ends_at, format)
     VALUES (?, ?, ?, 'countdown', ?, datetime('now', '+' || ? || ' seconds'), ?)`
  ).run(game.court_id, game.park_id, park.game_target, park.between_games_seconds, park.between_games_seconds, game.format);
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
    db.prepare('UPDATE next_line SET confirmed = 1 WHERE id = ?').run(nextLineId);
    for (const [playerId] of winners) {
      if (playerId !== captainEntry[0]) {
        db.prepare('INSERT INTO next_line_members (next_line_id, player_id) VALUES (?, ?)').run(nextLineId, playerId);
      }
    }
  }
}

function applyGameResult(gameId, parkId, courtId, playerId, result, minutes, format) {
  db.prepare(
    `INSERT INTO game_results (game_id, player_id, park_id, court_id, result, minutes_played, format)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(gameId, playerId, parkId, courtId, result, minutes, format || null);
  db.prepare(
    `UPDATE players SET ${result === 'win' ? 'wins' : 'losses'} = ${result === 'win' ? 'wins' : 'losses'} + 1, games_played = games_played + 1 WHERE id = ?`
  ).run(playerId);
}

function updateParkSettings(parkId, { gameTarget, betweenGamesSeconds, checkInRadiusMeters, leaveRadiusMeters }) {
  db.prepare(
    `UPDATE parks SET game_target = ?, between_games_seconds = ?, check_in_radius_meters = ?, leave_radius_meters = ? WHERE id = ?`
  ).run(gameTarget, betweenGamesSeconds, checkInRadiusMeters, leaveRadiusMeters, parkId);
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
      viewerTeam: activeRosterTeam(game.id, viewerPlayerId),
      edits: getRosterEdits(game.id),
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
    upcomingRuns: getUpcomingRunsForCourt(courtId),
    isFollowing: isFollowingCourt(viewerPlayerId, courtId),
  };
}

// Every court, across every park, with its current timer status — the
// /admin/timer tracking page. Ticks each court first so countdowns that
// have already expired (and the queue/live-game transitions that follow)
// are resolved before reporting status, not left showing stale state.
function getAllCourtsTimerStatus() {
  const courts = db
    .prepare(
      `SELECT c.id, c.number, c.nickname, p.id AS park_id, p.name AS park_name, p.city AS park_city,
              p.between_games_seconds
       FROM courts c
       JOIN parks p ON p.id = c.park_id
       ORDER BY p.name ASC, c.number ASC`
    )
    .all();

  return courts.map((court) => {
    tickCourt(court.id);
    const game = getActiveLiveGame(court.id);

    let status = 'idle';
    let countdownEndsAtIso = null;
    if (game && game.status === 'countdown') {
      status = 'countdown';
      countdownEndsAtIso = new Date(game.countdown_ends_at + 'Z').toISOString();
    } else if (game) {
      status = 'live';
    }

    return {
      courtId: court.id,
      courtName: court.nickname || `Court ${court.number}`,
      parkId: court.park_id,
      parkName: court.park_name,
      parkCity: court.park_city,
      betweenGamesMinutes: Math.round(court.between_games_seconds / 60),
      status,
      countdownEndsAtIso,
    };
  });
}

// Click tracking — one row per tracked tap. Logged regardless of whether
// the underlying action (e.g. a check-in outside the radius) succeeds,
// since this measures taps, not outcomes.
// The first time a player does one of these, it also marks a funnel milestone.
const MILESTONE_BY_EVENT = {
  app_open: 'first_open',
  check_in: 'first_checkin',
  result_confirmed: 'first_result_confirmed',
};

// Written once per player per milestone; later calls change nothing.
function recordMilestone(playerId, milestone) {
  db.prepare('INSERT OR IGNORE INTO player_milestones (player_id, milestone) VALUES (?, ?)').run(
    playerId,
    milestone
  );
}

function logEvent(playerId, eventName, page, parkId = null) {
  db.prepare('INSERT INTO events (player_id, event_name, page, park_id) VALUES (?, ?, ?, ?)').run(
    playerId,
    eventName,
    page || null,
    parkId
  );
  if (MILESTONE_BY_EVENT[eventName]) recordMilestone(playerId, MILESTONE_BY_EVENT[eventName]);
}

const TRACKED_EVENTS = [
  { name: 'app_open', label: 'App open (once a day)' },
  { name: 'check_in', label: 'Check in' },
  { name: 'i_got_next', label: 'I got next' },
  { name: 'start_a_run', label: 'Start a run' },
  { name: 'im_coming', label: "I'm coming" },
  { name: 'invite_friends', label: 'Invite friends' },
  { name: 'follow_court', label: 'Follow a court' },
  { name: 'suggest_court', label: 'Suggest a court' },
  { name: 'add_park_photo', label: 'Add a park photo' },
  { name: 'view_lobbies', label: 'View lobbies' },
  { name: 'lobby_join_try', label: 'Try to join a lobby (paid)' },
  { name: 'run_cancelled', label: 'Run cancelled' },
  { name: 'run_edited', label: 'Run edited' },
  { name: 'check_out', label: 'Check out' },
  { name: 'how_it_works_seen', label: 'How it works: shown' },
  { name: 'how_it_works_dismissed', label: 'How it works: Got it' },
  { name: 'how_it_works_reopened', label: 'How it works: reopened' },
  { name: 'empty_view_live_run', label: 'Empty state: view live run' },
  { name: 'empty_create_run', label: 'Empty state: create your own run' },
  { name: 'empty_follow_park', label: 'Empty state: follow a park' },
  { name: 'result_confirmed', label: 'Confirm a result' },
  { name: 'leaderboard_view', label: 'View leaderboard' },
  { name: 'leaderboard_player_tap', label: 'Tapped a player (leaderboard)' },
  { name: 'profile_view', label: 'View a profile' },
  { name: 'how_it_works', label: 'How it works' },
];

// Events a page reports itself (POST /api/events) because the tap never
// reaches a route of its own — an Invite button only opens the phone's
// share sheet. A fixed list, so that endpoint can't be used to write
// arbitrary event names.
const CLIENT_REPORTED_EVENTS = [
  'invite_friends',
  'empty_view_live_run',
  'empty_create_run',
  'empty_follow_park',
];

// For /admin/stats: total taps, unique players, and an average taps/day
// rate (total taps over the days since the event's first tap) per
// tracked event.
function getEventStats() {
  return TRACKED_EVENTS.map(({ name, label }) => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT player_id) AS uniquePlayers, MIN(created_at) AS firstAt
         FROM events WHERE event_name = ? AND ${notTestSql('player_id')}`
      )
      .get(name);

    const days = row.firstAt
      ? Math.max(1, Math.ceil((Date.now() - new Date(row.firstAt + 'Z').getTime()) / 86400000))
      : 1;

    return {
      name,
      label,
      totalTaps: row.total,
      uniquePlayers: row.uniquePlayers,
      tapsPerDay: row.total > 0 ? Math.round((row.total / days) * 10) / 10 : 0,
    };
  });
}

// --- Funnel: signed up -> checked in -> played a game -> came back
// another day. "Came back" needs to know which days a player opened the
// app at all, which taps alone don't capture — hence player_active_days.

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/New_York';
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// The calendar day (YYYY-MM-DD) an instant falls on where the app is
// played — not UTC, where one evening at the park straddles two "days"
// and would count as coming back.
function appDay(date = new Date()) {
  return dayFormatter.format(date);
}

const recordedToday = new Map(); // userId -> the day already written this process

// Marks today as a day this player opened the app. Runs on every signed-in
// request, so it only touches the database the first time each day.
function recordActiveDay(userId) {
  const today = appDay();
  if (recordedToday.get(userId) === today) return;
  const player = db.prepare('SELECT id FROM players WHERE user_id = ?').get(userId);
  if (!player) return;
  const inserted = db
    .prepare('INSERT OR IGNORE INTO player_active_days (player_id, day) VALUES (?, ?)')
    .run(player.id, today);
  // The first open of the day is an "app open" event.
  if (inserted.changes > 0) logEvent(player.id, 'app_open', null);
  recordedToday.set(userId, today);
}

// Players were active before this table existed — seed it from every
// dated thing they've already done, so the funnel isn't empty on day one.
runOnce('active_days_backfill', () => {
  const insert = db.prepare('INSERT OR IGNORE INTO player_active_days (player_id, day) VALUES (?, ?)');
  const sources = [
    'SELECT p.id AS playerId, u.created_at AS at FROM players p JOIN users u ON u.id = p.user_id',
    'SELECT player_id AS playerId, created_at AS at FROM events',
    'SELECT player_id AS playerId, time_in AS at FROM check_ins',
    'SELECT player_id AS playerId, date AS at FROM game_results',
  ];
  for (const sql of sources) {
    for (const row of db.prepare(sql).all()) {
      if (row.at) insert.run(row.playerId, appDay(new Date(row.at.replace(' ', 'T') + 'Z')));
    }
  }
});

// Each step counts only players who also made the step before it, so the
// numbers can only go down — which also keeps the seeded demo players
// (who have games on record but never checked in) out of "played a game".
// The tracking check on /admin: how many players, how many reached each
// funnel milestone, and every tracked event's totals.
const MILESTONE_LABELS = [
  ['first_open', 'Opened the app'],
  ['signup', 'Signed up'],
  ['first_checkin', 'First check-in'],
  ['first_game', 'First game played'],
  ['first_result_confirmed', 'First result confirmed'],
];

function getTrackingCheck() {
  const totalPlayers = db.prepare(`SELECT COUNT(*) AS n FROM players WHERE ${notTestSql('id')}`).get().n;
  const milestones = MILESTONE_LABELS.map(([key, label]) => ({
    label,
    players: db
      .prepare(`SELECT COUNT(*) AS n FROM player_milestones WHERE milestone = ? AND ${notTestSql('player_id')}`)
      .get(key).n,
  }));
  const bySource = db
    .prepare(
      `SELECT COALESCE(source, 'direct') AS source, COUNT(*) AS players
       FROM users WHERE name NOT GLOB 'TEST*' GROUP BY COALESCE(source, 'direct') ORDER BY players DESC`
    )
    .all();
  return { totalPlayers, milestones, bySource, events: getEventStats() };
}

function getFunnel() {
  const count = (sql) => db.prepare(sql).get().n;
  const counts = [
    ['Signed up', count(`SELECT COUNT(*) AS n FROM players WHERE ${notTestSql('id')}`)],
    ['Checked in', count(`SELECT COUNT(DISTINCT player_id) AS n FROM check_ins WHERE ${notTestSql('player_id')}`)],
    [
      'Played a game',
      count(
        `SELECT COUNT(DISTINCT player_id) AS n FROM game_results
         WHERE player_id IN (SELECT player_id FROM check_ins WHERE ${notTestSql('player_id')})`
      ),
    ],
    [
      'Came back another day',
      count(
        `SELECT COUNT(*) AS n FROM (
           SELECT player_id FROM player_active_days
           WHERE player_id IN (SELECT player_id FROM check_ins WHERE ${notTestSql('player_id')})
             AND player_id IN (SELECT player_id FROM game_results)
           GROUP BY player_id HAVING COUNT(*) >= 2
         )`
      ),
    ],
  ];

  const top = counts[0][1];
  return counts.map(([label, n], i) => {
    const previous = i === 0 ? n : counts[i - 1][1];
    return {
      label,
      count: n,
      percentOfSignups: top > 0 ? Math.round((n / top) * 100) : 0,
      percentOfPrevious: i === 0 ? null : previous > 0 ? Math.round((n / previous) * 100) : 0,
    };
  });
}

// ============================================================
// NEARBY COURTS — Overpass-sourced basketball courts the player hasn't
// checked into yet, and player-suggested courts awaiting review.
// ============================================================

const OVERPASS_RADIUS_METERS = 16093; // 10 miles
const OVERPASS_CACHE_DAYS = 7;

// Buckets to ~0.1 degree (~7-11km depending on latitude) so repeated
// loads from roughly the same area reuse one Overpass call instead of
// firing a fresh one per exact coordinate.
function overpassBucketKey(lat, lng) {
  return `${Math.round(lat * 10) / 10},${Math.round(lng * 10) / 10}`;
}

// Talks to the free Overpass API for OSM basketball courts (leisure=pitch
// + sport=basketball) within OVERPASS_RADIUS_METERS of (lat, lng).
// Returns null (not []) on any network/parse failure, so the caller can
// tell "nothing out there" apart from "couldn't ask" and degrade quietly
// rather than caching an empty result from a down endpoint.
async function fetchOverpassBasketballCourts(lat, lng) {
  const query =
    `[out:json][timeout:20];(` +
    `node["leisure"="pitch"]["sport"="basketball"](around:${OVERPASS_RADIUS_METERS},${lat},${lng});` +
    `way["leisure"="pitch"]["sport"="basketball"](around:${OVERPASS_RADIUS_METERS},${lat},${lng});` +
    `);out center;`;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.elements) ? data.elements : [];
  } catch (err) {
    return null;
  }
}

// Nearby OSM-sourced courts the player hasn't already checked into (those
// show up as normal park pins instead). Served from a 7-day area cache;
// only re-queries Overpass once that cache has gone stale.
async function getNearbyOpenCourts(lat, lng) {
  const key = overpassBucketKey(lat, lng);
  const cached = db
    .prepare(
      `SELECT response_json FROM overpass_cache
       WHERE bucket_key = ? AND fetched_at >= datetime('now', '-${OVERPASS_CACHE_DAYS} days')`
    )
    .get(key);

  let elements;
  if (cached) {
    elements = JSON.parse(cached.response_json);
  } else {
    elements = await fetchOverpassBasketballCourts(lat, lng);
    if (elements === null) return []; // Overpass unreachable — nothing to show, nothing to cache
    db.prepare(
      `INSERT INTO overpass_cache (bucket_key, lat, lng, response_json, fetched_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(bucket_key) DO UPDATE SET lat = excluded.lat, lng = excluded.lng,
         response_json = excluded.response_json, fetched_at = excluded.fetched_at`
    ).run(key, lat, lng, JSON.stringify(elements));
  }

  const claimedOsmIds = new Set(
    db.prepare('SELECT osm_id FROM parks WHERE osm_id IS NOT NULL').all().map((r) => r.osm_id)
  );

  return elements
    .map((el) => {
      const elLat = el.lat != null ? el.lat : el.center && el.center.lat;
      const elLng = el.lon != null ? el.lon : el.center && el.center.lon;
      if (elLat == null || elLng == null) return null;
      return {
        osmId: `${el.type}/${el.id}`,
        name: (el.tags && el.tags.name) || 'Open court',
        lat: elLat,
        lng: elLng,
      };
    })
    .filter((c) => c && !claimedOsmIds.has(c.osmId) && haversineMeters(lat, lng, c.lat, c.lng) <= OVERPASS_RADIUS_METERS);
}

// Materializes a real park + "Main" court from an Overpass court the first
// time anyone interacts with it (check in, start a run, or follow it) —
// idempotent on osm_id, so a second player's first interaction reuses the
// park the first player's created instead of duplicating it.
// Two parks can't sit within 150 m of each other.
const PARK_DUPLICATE_METERS = 150;
// A player this close to a dropped pin can add the park right away.
const AT_SPOT_METERS = 250;

function findParkNear(lat, lng, meters) {
  let nearest = null;
  for (const park of db.prepare('SELECT id, name, lat, lng FROM parks WHERE lat IS NOT NULL').all()) {
    const d = haversineMeters(lat, lng, park.lat, park.lng);
    if (d <= meters && (!nearest || d < nearest.distance)) nearest = { ...park, distance: d };
  }
  return nearest;
}

// A park a player created at the spot: one court, added by them.
function createParkFromSpot(name, lat, lng, playerId) {
  db.prepare('INSERT INTO parks (name, lat, lng, added_by_player_id) VALUES (?, ?, ?, ?)').run(name, lat, lng, playerId);
  const parkId = lastId();
  db.prepare("INSERT INTO courts (park_id, number, nickname) VALUES (?, 1, 'Main')").run(parkId);
  return parkId;
}

// A park a player added is "New" until three different players have checked in.
function isNewPark(parkId) {
  const row = db
    .prepare(
      `SELECT p.added_by_player_id AS addedBy,
              (SELECT COUNT(DISTINCT ci.player_id) FROM check_ins ci
               WHERE ci.park_id = p.id) AS checkedIn
       FROM parks p WHERE p.id = ?`
    )
    .get(parkId);
  return !!row && row.addedBy !== null && row.checkedIn < 3;
}

function findOrCreateParkAndCourtFromOsm(osmId, name, lat, lng) {
  const existingPark = db.prepare('SELECT id FROM parks WHERE osm_id = ?').get(osmId);
  let parkId;
  // Already a park within 150 m (say, one made from another pin): use it rather than a duplicate.
  const nearby = !existingPark && Number.isFinite(lat) && Number.isFinite(lng) ? findParkNear(lat, lng, PARK_DUPLICATE_METERS) : null;
  if (existingPark) {
    parkId = existingPark.id;
  } else if (nearby) {
    parkId = nearby.id;
  } else {
    db.prepare('INSERT INTO parks (name, lat, lng, osm_id) VALUES (?, ?, ?, ?)').run(
      name || 'Open court',
      lat,
      lng,
      osmId
    );
    parkId = lastId();
    db.prepare("INSERT INTO courts (park_id, number, nickname) VALUES (?, 1, 'Main')").run(parkId);
  }
  const court = db.prepare('SELECT id FROM courts WHERE park_id = ? ORDER BY number ASC LIMIT 1').get(parkId);
  return { parkId, courtId: court.id };
}

// First check-in at an Overpass-sourced court creates a real park for it,
// then checks the player in normally.
function checkInAtOpenCourt(playerId, osmId, name, lat, lng, playerLat, playerLng, accuracy) {
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return { ok: false, error: 'This court has no location.' };
  }
  const { parkId } = findOrCreateParkAndCourtFromOsm(osmId, name, lat, lng);
  return { ...checkIn(playerId, parkId, playerLat, playerLng, accuracy), parkId };
}

function createCourtSuggestion(playerId, name, lat, lng, photoUrl) {
  db.prepare('INSERT INTO court_suggestions (player_id, name, lat, lng, photo_url) VALUES (?, ?, ?, ?, ?)').run(
    playerId,
    name,
    lat,
    lng,
    photoUrl || null
  );
  return { ok: true };
}

// Pending first, then newest — what /admin/courts wants to triage.
function getCourtSuggestions() {
  return db
    .prepare(
      `SELECT cs.*, ${DISPLAY_NAME} AS suggested_by_name
       FROM court_suggestions cs
       JOIN players p ON p.id = cs.player_id
       JOIN users u ON u.id = p.user_id
       ORDER BY (cs.status = 'pending') DESC, cs.created_at DESC`
    )
    .all();
}

function approveCourtSuggestion(suggestionId, organizerPlayerId) {
  const suggestion = db.prepare('SELECT * FROM court_suggestions WHERE id = ?').get(suggestionId);
  if (!suggestion || suggestion.status !== 'pending') return { ok: false, error: 'Nothing to approve.' };

  db.prepare('INSERT INTO parks (name, lat, lng, added_by_player_id) VALUES (?, ?, ?, ?)').run(
    suggestion.name,
    suggestion.lat,
    suggestion.lng,
    suggestion.player_id
  );
  const parkId = lastId();
  db.prepare("INSERT INTO courts (park_id, number, nickname) VALUES (?, 1, 'Main')").run(parkId);

  db.prepare(
    `UPDATE court_suggestions SET status = 'approved', park_id = ?, reviewed_by_player_id = ?, reviewed_at = datetime('now')
     WHERE id = ?`
  ).run(parkId, organizerPlayerId, suggestionId);

  return { ok: true, parkId };
}

function rejectCourtSuggestion(suggestionId, organizerPlayerId) {
  const result = db
    .prepare(
      `UPDATE court_suggestions SET status = 'rejected', reviewed_by_player_id = ?, reviewed_at = datetime('now')
       WHERE id = ? AND status = 'pending'`
    )
    .run(organizerPlayerId, suggestionId);
  return { ok: result.changes > 0 };
}

// 'auto' (materialized from an Overpass court on first check-in/run/follow),
// 'suggested' (created by approving a player's court_suggestions row), or
// 'preset' (seeded at boot — neither of the above).
function parkSource(park) {
  if (park.osm_id) return 'auto';
  if (park.added_by_player_id) return 'suggested';
  return 'preset';
}

// Every park, for /admin/courts' park-management list — name/address, pin,
// radii, how it was added, and whether it's organizer-curated as
// "Suggested" on the Runs tab.
function getAllParksForAdmin() {
  return db
    .prepare(
      `SELECT p.*, ${DISPLAY_NAME} AS added_by_name
       FROM parks p
       LEFT JOIN players pl ON pl.id = p.added_by_player_id
       LEFT JOIN users u ON u.id = pl.user_id
       ORDER BY p.name ASC`
    )
    .all()
    .map((park) => ({ ...park, source: parkSource(park) }));
}

// The admin park editor: name, address, city, pin location, both radii,
// and the organizer-curated "Suggested" flag — a superset of
// updateParkSettings above, which only the court screen's own "Game
// settings" form uses. lat/lng may be null (a park with an address whose
// pin hasn't been placed yet); a blank city falls back to the one in the
// address.
function updateParkAdmin(parkId, { name, location, city, lat, lng, checkInRadiusMeters, leaveRadiusMeters, isSuggested }) {
  db.prepare(
    `UPDATE parks SET name = ?, location = ?, city = ?, lat = ?, lng = ?,
       check_in_radius_meters = ?, leave_radius_meters = ?, is_suggested = ?
     WHERE id = ?`
  ).run(
    name,
    location || null,
    city || cityFromAddress(location),
    lat,
    lng,
    checkInRadiusMeters,
    leaveRadiusMeters,
    isSuggested ? 1 : 0,
    parkId
  );
  return { ok: true };
}

// Organizer-curated parks for the top of /runs — same shape as
// getParkSheetDetail (king, upcoming runs, the viewer's own checked-in
// state, firstCourtId for Check in / I got next) plus the park's own
// lat/lng so the client can fill in a distance once it has one.
function getSuggestedParks(seasonStart, viewerPlayerId) {
  const parks = db.prepare('SELECT id FROM parks WHERE is_suggested = 1 ORDER BY name ASC').all();
  return parks.map((p) => getParkSheetDetail(p.id, seasonStart, viewerPlayerId));
}

// ============================================================
// RUNS — scheduled pickup games, "I'm coming", and following a court.
// Everything here works from anywhere; only check-in/next-line/live-game
// (above) are gated to being physically at the court.
// ============================================================

// A <input type="datetime-local"> value ("YYYY-MM-DDTHH:MM") stored as
// the organizer's own local wall-clock time — no timezone conversion,
// same demo-mode simplicity as the rest of this schema.
// Run times are wall-clock times in the app's timezone (APP_TIMEZONE), stored
// as 'YYYY-MM-DD HH:MM:00' with no offset. "Now" has to be read in that same
// timezone, not the server's (UTC on Railway), or runs get hidden or accepted
// at the wrong time.
const RUN_TZ = process.env.APP_TIMEZONE || 'America/New_York';
const runClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: RUN_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// Now in the app's timezone, as 'YYYY-MM-DD HH:MM:00'.
function appNowSql(date = new Date()) {
  const parts = Object.fromEntries(runClock.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:00`;
}

// A stored UTC timestamp (SQLite datetime('now')) in the app's timezone.
function utcSqlToAppSql(utcSql) {
  return appNowSql(new Date(utcSql.replace(' ', 'T') + 'Z'));
}

function addMinutesSql(sql, minutes) {
  const d = new Date(sql.replace(' ', 'T') + 'Z');
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// The next half hour after now (e.g. 6:10 -> 6:30, 6:40 -> 7:00), and the
// earliest quarter hour today a time can be, for the time picker.
function runTimeDefaults() {
  const now = appNowSql();
  const next = new Date(now.replace(' ', 'T') + 'Z');
  const minute = next.getUTCMinutes();
  next.setUTCMinutes(minute < 30 ? 30 : 60, 0, 0);
  const quarter = new Date(now.replace(' ', 'T') + 'Z');
  quarter.setUTCMinutes(Math.ceil(quarter.getUTCMinutes() / 15) * 15, 0, 0);
  const iso = next.toISOString();
  return {
    todayDate: now.slice(0, 10),
    nowTime: quarter.toISOString().slice(11, 16),
    defaultDate: iso.slice(0, 10),
    defaultTime: iso.slice(11, 16),
  };
}

// The date and time from the form, checked: real date, 15-minute steps, and
// not in the past. Returns { scheduledAt } or { error }.
function checkRunTimeFields(date, time) {
  const dateMatch = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const timeMatch = typeof time === 'string' && time.match(/^(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) {
    return { error: 'Pick a date and time.' };
  }
  if (Number(timeMatch[1]) > 23 || Number(timeMatch[2]) % 15 !== 0) {
    return { error: 'Pick a time in 15-minute steps.' };
  }
  const scheduledAt = `${date} ${time}:00`;
  if (scheduledAt < appNowSql()) return { error: 'That time has already passed. Pick a later time.' };
  return { scheduledAt };
}

// A run is "started" once a live game starts at its court between an hour
// before and four hours after its scheduled time. From then on it can't be
// edited or cancelled.
function runLockState(run) {
  const from = addMinutesSql(run.scheduled_at, -60);
  const to = addMinutesSql(run.scheduled_at, 240);
  const started = db
    .prepare('SELECT started_at FROM live_games WHERE court_id = ? AND started_at IS NOT NULL')
    .all(run.court_id)
    .some((g) => {
      const local = utcSqlToAppSql(g.started_at);
      return local >= from && local <= to;
    });
  return { cancelled: !!run.cancelled_at, started };
}

function loadRunForChange(runId) {
  return db
    .prepare(
      `SELECT r.id, r.court_id, r.scheduled_at, r.cancelled_at, r.organizer_player_id, c.park_id
       FROM runs r JOIN courts c ON c.id = r.court_id WHERE r.id = ?`
    )
    .get(runId);
}

// Only the organizer, only before a game starts, and only to a time that
// hasn't passed. Players who said they're coming keep their place.
function changeRunTime(runId, playerId, scheduledAt) {
  const run = loadRunForChange(runId);
  if (!run) return { ok: false, error: 'Run not found.' };
  if (run.organizer_player_id !== playerId) return { ok: false, error: 'Only the person who started this run can change it.' };
  const state = runLockState(run);
  if (state.cancelled) return { ok: false, error: 'This run was cancelled.' };
  if (state.started) return { ok: false, error: "A game at this court has started, so the time can't be changed." };
  if (scheduledAt < appNowSql()) return { ok: false, error: 'That time has already passed. Pick a later time.' };
  db.prepare('UPDATE runs SET scheduled_at = ? WHERE id = ?').run(scheduledAt, runId);
  logEvent(playerId, 'run_edited', `/runs/${runId}`, run.park_id);
  return { ok: true };
}

function cancelRun(runId, playerId) {
  const run = loadRunForChange(runId);
  if (!run) return { ok: false, error: 'Run not found.' };
  if (run.organizer_player_id !== playerId) return { ok: false, error: 'Only the person who started this run can cancel it.' };
  const state = runLockState(run);
  if (state.cancelled) return { ok: false, error: 'This run is already cancelled.' };
  if (state.started) return { ok: false, error: "A game at this court has started, so the run can't be cancelled." };
  db.prepare("UPDATE runs SET cancelled_at = datetime('now') WHERE id = ?").run(runId);
  logEvent(playerId, 'run_cancelled', `/runs/${runId}`, run.park_id);
  return { ok: true };
}

// Runs this player said they were coming to that were cancelled recently,
// so the Runs page can say so.
function getCancelledRunsForPlayer(playerId) {
  return db
    .prepare(
      `SELECT r.id, r.scheduled_at, r.cancelled_at, c.number, c.nickname, p.name AS park_name, p.city AS park_city
       FROM run_rsvps rr
       JOIN runs r ON r.id = rr.run_id
       JOIN courts c ON c.id = r.court_id
       JOIN parks p ON p.id = c.park_id
       WHERE rr.player_id = ? AND r.cancelled_at IS NOT NULL AND r.cancelled_at >= datetime('now', '-7 days')
       ORDER BY r.cancelled_at DESC`
    )
    .all(playerId)
    .map((r) => ({
      id: r.id,
      scheduledAt: r.scheduled_at,
      courtName: r.nickname || `Court ${r.number}`,
      parkName: r.park_name,
      parkCity: r.park_city,
    }));
}

function parseScheduledAt(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  if (!match) return null;
  return `${match[1]} ${match[2]}:00`;
}

function createRun(courtId, organizerPlayerId, scheduledAt, note, format) {
  db.prepare(
    'INSERT INTO runs (court_id, organizer_player_id, scheduled_at, note, format) VALUES (?, ?, ?, ?, ?)'
  ).run(courtId, organizerPlayerId, scheduledAt, (note || '').trim() || null, format || null);
  // The court's next game takes the format the run was created with.
  if (format) db.prepare('UPDATE courts SET format = ? WHERE id = ?').run(format, courtId);
  return lastId();
}

function getRunById(runId, viewerPlayerId) {
  const run = db
    .prepare(
      `SELECT r.id, r.scheduled_at, r.note, r.court_id, r.organizer_player_id, r.cancelled_at,
              c.number AS court_number, c.nickname AS court_nickname,
              p.id AS park_id, p.name AS park_name, p.city AS park_city, p.location AS park_location,
              ${DISPLAY_NAME} AS organizer_name
       FROM runs r
       JOIN courts c ON c.id = r.court_id
       JOIN parks p ON p.id = c.park_id
       JOIN players pl ON pl.id = r.organizer_player_id
       JOIN users u ON u.id = pl.user_id
       WHERE r.id = ?`
    )
    .get(runId);
  if (!run) return null;
  const state = runLockState(run);

  const rsvps = db
    .prepare(
      `SELECT pl.id, ${DISPLAY_NAME} AS name, rr.created_at
       FROM run_rsvps rr
       JOIN players pl ON pl.id = rr.player_id
       JOIN users u ON u.id = pl.user_id
       WHERE rr.run_id = ?
       ORDER BY rr.created_at ASC`
    )
    .all(runId)
    .map((r) => ({ id: r.id, name: r.name, initials: nameInitials(r.name), ...previewFields(r.id) }));

  return {
    id: run.id,
    scheduledAt: run.scheduled_at,
    note: run.note,
    courtId: run.court_id,
    courtName: run.court_nickname || `Court ${run.court_number}`,
    parkId: run.park_id,
    parkName: run.park_name,
    parkCity: run.park_city,
    parkLocation: run.park_location,
    organizerName: run.organizer_name,
    rsvps,
    rsvpCount: rsvps.length,
    viewerComing: viewerPlayerId ? rsvps.some((r) => r.id === viewerPlayerId) : false,
    organizerPlayerId: run.organizer_player_id,
    cancelled: state.cancelled,
    started: state.started,
    canChange: !state.cancelled && !state.started,
    scheduledDate: run.scheduled_at.slice(0, 10),
    scheduledTime: run.scheduled_at.slice(11, 16),
  };
}

// Soonest-first upcoming runs at one court — court pin labels, the court
// screen, and the "too far to check in" empty state.
function getUpcomingRunsForCourt(courtId, limit = 5) {
  const runs = db
    .prepare(
      `SELECT r.id, r.scheduled_at, r.note
       FROM runs r
       WHERE r.court_id = ? AND r.scheduled_at >= ? AND r.cancelled_at IS NULL
       ORDER BY r.scheduled_at ASC
       LIMIT ?`
    )
    .all(courtId, appNowSql(), limit);
  const rsvpCount = db.prepare('SELECT COUNT(*) AS c FROM run_rsvps WHERE run_id = ?');
  return runs.map((r) => ({
    id: r.id,
    scheduledAt: r.scheduled_at,
    note: r.note,
    rsvpCount: rsvpCount.get(r.id).c,
  }));
}

// A run lasts about this long; two runs closer together than this overlap,
// and nobody can be in two places at once.
const RUN_LENGTH_MINUTES = 180;

// Saying "I'm coming" to a run that overlaps one you're already on: you stay
// on the earlier one. Coming to an earlier run drops you from the later one.
function rsvpToRun(runId, playerId) {
  const run = db.prepare('SELECT id, cancelled_at, scheduled_at FROM runs WHERE id = ?').get(runId);
  if (!run) return { ok: false, error: 'Run not found.' };
  if (run.cancelled_at) return { ok: false, error: 'This run was cancelled.' };

  const mine = db
    .prepare(
      `SELECT r.id, r.scheduled_at FROM run_rsvps rr JOIN runs r ON r.id = rr.run_id
       WHERE rr.player_id = ? AND r.id != ? AND r.cancelled_at IS NULL AND r.scheduled_at >= ?`
    )
    .all(playerId, runId, appNowSql());
  const overlaps = (other) =>
    Math.abs(new Date(other.scheduled_at.replace(' ', 'T')) - new Date(run.scheduled_at.replace(' ', 'T'))) <
    RUN_LENGTH_MINUTES * 60000;
  const clashes = mine.filter(overlaps);

  const earlier = clashes.find((other) => other.scheduled_at < run.scheduled_at);
  if (earlier) {
    const time = new Date(earlier.scheduled_at.replace(' ', 'T')).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return { ok: false, error: `You're already coming to a run at ${time} that overlaps this one. You can only be in one place at a time.` };
  }
  for (const later of clashes) {
    db.prepare('DELETE FROM run_rsvps WHERE run_id = ? AND player_id = ?').run(later.id, playerId);
  }
  db.prepare('INSERT OR IGNORE INTO run_rsvps (run_id, player_id) VALUES (?, ?)').run(runId, playerId);
  return { ok: true };
}

// What a tap on someone's avatar previews: tier, this season's crown and games played.
function previewFields(playerId, seasonStart = getSeasonWindow().startSql) {
  const row = db.prepare('SELECT tier, games_played FROM players WHERE id = ?').get(playerId);
  return {
    tierLabel: row ? row.tier.charAt(0).toUpperCase() + row.tier.slice(1) : '',
    gamesPlayed: row ? row.games_played : 0,
    crown: getCrownLevel(getPlayerSeasonPoints(playerId, seasonStart)),
  };
}

// Take yourself off a run you said you were coming to.
function notComingToRun(runId, playerId) {
  db.prepare('DELETE FROM run_rsvps WHERE run_id = ? AND player_id = ?').run(runId, playerId);
  return { ok: true };
}

function isFollowingCourt(playerId, courtId) {
  return !!db.prepare('SELECT 1 FROM court_follows WHERE player_id = ? AND court_id = ?').get(playerId, courtId);
}

// Toggles follow for a real court, returning the new state.
function toggleFollowCourt(playerId, courtId) {
  if (isFollowingCourt(playerId, courtId)) {
    db.prepare('DELETE FROM court_follows WHERE player_id = ? AND court_id = ?').run(playerId, courtId);
    return { ok: true, following: false };
  }
  db.prepare('INSERT INTO court_follows (player_id, court_id) VALUES (?, ?)').run(playerId, courtId);
  return { ok: true, following: true };
}

// Always follows (never unfollows) — for the map's "open court" panel,
// where materializing the court and following it is one action.
function followCourt(playerId, courtId) {
  db.prepare('INSERT OR IGNORE INTO court_follows (player_id, court_id) VALUES (?, ?)').run(playerId, courtId);
  return { ok: true };
}

// Followed courts for the top of the Runs tab: park/court name, current
// king, and the soonest upcoming run (if any).
function getFollowedCourtsForPlayer(playerId, seasonStart) {
  const courts = db
    .prepare(
      `SELECT c.id AS court_id, c.number, c.nickname, p.id AS park_id, p.name AS park_name, p.city AS park_city
       FROM court_follows cf
       JOIN courts c ON c.id = cf.court_id
       JOIN parks p ON p.id = c.park_id
       WHERE cf.player_id = ?
       ORDER BY cf.created_at DESC`
    )
    .all(playerId);

  return courts.map((c) => {
    const nextRun = db
      .prepare(
        `SELECT id, scheduled_at FROM runs
         WHERE court_id = ? AND scheduled_at >= ? AND cancelled_at IS NULL
         ORDER BY scheduled_at ASC LIMIT 1`
      )
      .get(c.court_id, appNowSql());
    return {
      courtId: c.court_id,
      courtName: c.nickname || `Court ${c.number}`,
      parkId: c.park_id,
      parkName: c.park_name,
      parkCity: c.park_city,
      king: getParkKing(c.park_id, seasonStart),
      nextRun: nextRun ? { id: nextRun.id, scheduledAt: nextRun.scheduled_at } : null,
    };
  });
}

// A run is live from 15 minutes before its start until three hours after.
const LIVE_BEFORE_MINUTES = 15;
const LIVE_AFTER_MINUTES = 180;

function isRunLive(scheduledAt, nowSql = appNowSql()) {
  return addMinutesSql(scheduledAt, -LIVE_BEFORE_MINUTES) <= nowSql && nowSql <= addMinutesSql(scheduledAt, LIVE_AFTER_MINUTES);
}

// Courts with a live run right now, or a game in progress there.
function getLiveCourtIds() {
  const now = appNowSql();
  const ids = new Set();
  for (const r of db
    .prepare('SELECT court_id, scheduled_at FROM runs WHERE cancelled_at IS NULL AND scheduled_at BETWEEN ? AND ?')
    .all(addMinutesSql(now, -LIVE_AFTER_MINUTES), addMinutesSql(now, LIVE_BEFORE_MINUTES))) {
    if (isRunLive(r.scheduled_at, now)) ids.add(r.court_id);
  }
  for (const g of db.prepare("SELECT DISTINCT court_id FROM live_games WHERE status = 'in_progress'").all()) {
    ids.add(g.court_id);
  }
  return ids;
}

// Parks where something is live right now.
function getLiveParkIds() {
  const courtIds = getLiveCourtIds();
  if (courtIds.size === 0) return new Set();
  const parkIds = new Set();
  for (const c of db.prepare('SELECT id, park_id FROM courts').all()) {
    if (courtIds.has(c.id)) parkIds.add(c.park_id);
  }
  return parkIds;
}

// Upcoming runs within radiusMeters of (lat, lng), soonest first, plus
// the single nearest park/court overall (for the "No runs near you yet —
// be the first King of X" empty state) regardless of whether it has a run.
function getNearbyUpcomingRuns(lat, lng, radiusMeters) {
  const candidates = db
    .prepare(
      `SELECT r.id, r.scheduled_at, r.note, c.id AS court_id, c.number, c.nickname,
              p.id AS park_id, p.name AS park_name, p.city AS park_city, p.lat, p.lng
       FROM runs r
       JOIN courts c ON c.id = r.court_id
       JOIN parks p ON p.id = c.park_id
       WHERE r.scheduled_at >= ? AND r.cancelled_at IS NULL AND p.lat IS NOT NULL`
    )
    .all(addMinutesSql(appNowSql(), -LIVE_AFTER_MINUTES));
  const rsvpCount = db.prepare('SELECT COUNT(*) AS c FROM run_rsvps WHERE run_id = ?');

  const runs = candidates
    .map((r) => ({
      id: r.id,
      scheduledAt: r.scheduled_at,
      note: r.note,
      courtId: r.court_id,
      courtName: r.nickname || `Court ${r.number}`,
      parkId: r.park_id,
      parkName: r.park_name,
      parkCity: r.park_city,
      distanceMeters: haversineMeters(lat, lng, r.lat, r.lng),
      rsvpCount: rsvpCount.get(r.id).c,
    }))
    .filter((r) => r.distanceMeters <= radiusMeters)
    .map((r) => ({ ...r, live: isRunLive(r.scheduledAt) }))
    .sort((a, b) => (b.live - a.live) || new Date(a.scheduledAt) - new Date(b.scheduledAt));
  const liveNearby = runs.filter((r) => r.live).sort((a, b) => a.distanceMeters - b.distanceMeters)[0] || null;

  const parks = getParks().filter((p) => p.lat !== null);
  let nearestPark = null;
  for (const p of parks) {
    const d = haversineMeters(lat, lng, p.lat, p.lng);
    if (!nearestPark || d < nearestPark.distanceMeters) nearestPark = { park: p, distanceMeters: d };
  }
  let nearestCourt = null;
  if (nearestPark) {
    const court = getCourtsByPark(nearestPark.park.id)[0];
    if (court) {
      nearestCourt = {
        id: court.id,
        name: court.nickname || `Court ${court.number}`,
        parkId: nearestPark.park.id,
        parkName: nearestPark.park.name,
      };
    }
  }

  return { runs, nearestCourt, liveNearby };
}

// Changes whenever a result or a trophy is recorded. The live pages ask this
// first, so they only re-render when something has actually moved.
function getLiveVersion() {
  const results = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM game_results').get();
  const formatTrophies = db.prepare('SELECT COUNT(*) AS n FROM format_trophies').get().n;
  const seasonTrophies = db.prepare('SELECT COUNT(*) AS n FROM trophies').get().n;
  return [results.n, results.m, formatTrophies, seasonTrophies].join(':');
}

module.exports = {
  getLiveVersion,
  formatAggregate,
  notTestSql,
  testPlayerIds,
  findParkNear,
  createParkFromSpot,
  haversineMeters,
  checkOut,
  isNewPark,
  isFollowingCourt,
  PARK_DUPLICATE_METERS,
  AT_SPOT_METERS,
  nameInitials,
  displayNameError,
  updateDisplayName,
  getUserByPhone,
  getPlayerByUserId,
  createUserAndPlayer,
  getPlayerProfile,
  getLiveParkIds,
  getParkKing,
  getLiveCourtIds,
  isRunLive,
  markHowItWorksShown,
  dismissHowItWorks,
  getPlayerProfileByPlayerId,
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
  getCrownPerks,
  getPlayerSeasonPoints,
  getNextCrownProgress,
  getFormatSummary,
  getCourtLabelsByPark,
  courtFormatLabel,
  formatSize,
  removeSquadMember,
  confirmSquad,
  handOffCaptain,
  FORMATS,
  getAllCourtsTimerStatus,
  getParkMapPins,
  getParkSheetDetail,
  checkIn,
  heartbeat,
  getCheckIn,
  getCheckedInPlayers,
  getCourtScreen,
  disputeResult,
  iGotNext,
  addSquadMembers,
  markLeft,
  addSub,
  declareWinner,
  confirmResult,
  updateParkSettings,
  CHECK_IN_FRESH_MINUTES,
  syncOrganizerFlag,
  logEvent,
  getEventStats,
  getNearbyOpenCourts,
  checkInAtOpenCourt,
  createCourtSuggestion,
  getCourtSuggestions,
  approveCourtSuggestion,
  rejectCourtSuggestion,
  findOrCreateParkAndCourtFromOsm,
  parseScheduledAt,
  createRun,
  getRunById,
  getUpcomingRunsForCourt,
  rsvpToRun,
  notComingToRun,
  isFollowingCourt,
  toggleFollowCourt,
  followCourt,
  getFollowedCourtsForPlayer,
  getNearbyUpcomingRuns,
  OVERPASS_RADIUS_METERS,
  getAllParksForAdmin,
  updateParkAdmin,
  getSuggestedParks,
  getPaidGamesPlayed,
  CLIENT_REPORTED_EVENTS,
  recordActiveDay,
  getFunnel,
  getPlayerIdByTag,
  getTrackingCheck,
  TRACKED_EVENTS,
  runTimeDefaults,
  getGameCountSince,
  checkRunTimeFields,
  changeRunTime,
  cancelRun,
  getCancelledRunsForPlayer,
  appNowSql,
};
