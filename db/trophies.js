// Trophies and the tier ladder. A crown resets every 30-day season; the
// crown a player finished with is kept as a trophy, and trophies (or paid
// games) are what move a player up Rookie -> Starter -> Star -> Superstar.
const { db } = require('./index');
const {
  getSeasonWindow,
  getCityStandings,
  getParkStandings,
  getParks,
  getCrownLevel,
  CROWN_LEVELS,
  getTiers,
  getPaidGamesPlayed,
} = require('./queries');

function sqliteToDate(text) {
  return new Date(text.replace(' ', 'T') + 'Z');
}

// Hands out one season's trophies: every player who finished it with a
// crown gets one, recording the season's dates, the crown, their points,
// and the parks they were king of. Marks the season closed either way, so
// it's never processed twice (and a re-run can't double-award).
function closeSeason(season) {
  db.exec('BEGIN');
  try {
    const kingParks = new Map();
    for (const park of getParks()) {
      const king = getParkStandings(park.id, season.startSql, season.endSql)[0];
      if (!king) continue;
      if (!kingParks.has(king.playerId)) kingParks.set(king.playerId, []);
      kingParks.get(king.playerId).push(park.name);
    }

    const insert = db.prepare(
      `INSERT OR IGNORE INTO trophies (player_id, season_start, season_end, crown_name, points, king_parks)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    let awarded = 0;
    for (const row of getCityStandings(season.startSql, season.endSql)) {
      const crown = getCrownLevel(row.points);
      if (!crown) continue;
      insert.run(
        row.playerId,
        season.startSql,
        season.endSql,
        crown.name,
        Math.round(row.points * 10) / 10,
        JSON.stringify(kingParks.get(row.playerId) || [])
      );
      awarded += 1;
    }

    db.prepare('INSERT INTO closed_seasons (season_start) VALUES (?)').run(season.startSql);
    db.exec('COMMIT');
    return awarded;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Closes every finished season that hasn't been closed yet, oldest first
// — normally just the one that ended, but also any that ended while the
// server was down, and every past season the first time this ever runs.
// Returns how many trophies it handed out.
function closeFinishedSeasons(now = new Date()) {
  const first = db.prepare('SELECT MIN(date) AS at FROM game_results').get().at;
  if (!first) return 0;

  const current = getSeasonWindow(now);
  const isClosed = db.prepare('SELECT 1 FROM closed_seasons WHERE season_start = ?');
  let awarded = 0;
  for (let season = getSeasonWindow(sqliteToDate(first)); season.startSql < current.startSql; season = getSeasonWindow(season.end)) {
    if (!isClosed.get(season.startSql)) awarded += closeSeason(season);
  }
  return awarded;
}

let checkedSeasonStart = null;

// Cheap enough to call on every request: it only does any work the first
// time it's called in a given season (at boot, then again when a season
// rolls over while the server stays up).
function closeFinishedSeasonsIfDue() {
  const { startSql } = getSeasonWindow();
  if (checkedSeasonStart === startSql) return;
  closeFinishedSeasons();
  checkedSeasonStart = startSql;
}

// A player's trophies, newest first, ready to draw as crown icons.
function getTrophies(playerId) {
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  return db
    .prepare('SELECT * FROM trophies WHERE player_id = ? ORDER BY season_start DESC')
    .all(playerId)
    .map((row) => {
      const crown = CROWN_LEVELS.find((level) => level.name === row.crown_name);
      const start = sqliteToDate(row.season_start);
      // A season ends the instant the next one starts, so its last day
      // — and the month it's remembered by — is the day before that.
      const lastDay = new Date(sqliteToDate(row.season_end).getTime() - 1);
      return {
        crownName: row.crown_name,
        fill: crown ? crown.fill : 'none',
        stroke: crown ? crown.stroke : '#9C9A92',
        points: row.points,
        kingParks: JSON.parse(row.king_parks),
        monthLabel: month.format(lastDay),
        datesLabel: `${day.format(start)} – ${day.format(lastDay)}`,
      };
    });
}

function getTrophyCount(playerId) {
  return db.prepare('SELECT COUNT(*) AS n FROM trophies WHERE player_id = ?').get(playerId).n;
}

// The ladder as one player sees it: every tier in order, marked passed /
// current / locked, plus their progress toward the next one. No stakes or
// rake — that's lobby detail, not what the ladder is for.
function getTierLadder(profile) {
  return {
    steps: getTiers().map((tier) => ({
      name: tier.name,
      state: tier.rank < profile.tier_rank ? 'passed' : tier.rank === profile.tier_rank ? 'current' : 'locked',
    })),
    paidGames: getPaidGamesPlayed(profile.player_id),
    paidGamesNeeded: profile.games_to_promote,
    trophyCount: getTrophyCount(profile.player_id),
  };
}

module.exports = {
  closeFinishedSeasons,
  closeFinishedSeasonsIfDue,
  getTrophies,
  getTrophyCount,
  getTierLadder,
};
