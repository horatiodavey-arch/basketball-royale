// Trophies and the tier ladder. A trophy is earned each time a player
// reaches purple (Best Record in the League) in a game format; see
// awardFormatTrophies in db/queries.js. Trophies from the earlier
// end-of-season system are kept and still shown. Rookie -> Starter moves
// on paid games or trophies, and trophies are what move a player up.
const { db } = require('./index');
const { CROWN_LEVELS, getTiers, getPaidGamesPlayed } = require('./queries');

function sqliteToDate(text) {
  return new Date(text.replace(' ', 'T') + 'Z');
}

// A player's trophies, newest first, ready to draw as crown icons. Format
// trophies come first and are labelled with their format; earlier season
// trophies follow, labelled as season crowns.
function getTrophies(playerId) {
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  const formatTrophies = db
    .prepare('SELECT * FROM format_trophies WHERE player_id = ? ORDER BY earned_at DESC, id DESC')
    .all(playerId)
    .map((row) => {
      const crown = CROWN_LEVELS[0];
      const earned = sqliteToDate(row.earned_at);
      return {
        crownName: `${row.format} · ${crown.name}`,
        fill: crown.fill,
        stroke: crown.stroke,
        points: row.points,
        kingParks: [],
        monthLabel: month.format(earned),
        datesLabel: day.format(earned),
      };
    });

  const seasonTrophies = db
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

  return [...formatTrophies, ...seasonTrophies];
}

function getTrophyCount(playerId) {
  const formatCount = db.prepare('SELECT COUNT(*) AS n FROM format_trophies WHERE player_id = ?').get(playerId).n;
  const seasonCount = db.prepare('SELECT COUNT(*) AS n FROM trophies WHERE player_id = ?').get(playerId).n;
  return formatCount + seasonCount;
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
  getTrophies,
  getTrophyCount,
  getTierLadder,
};
