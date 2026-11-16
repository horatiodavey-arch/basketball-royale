// The "Today" summary on /admin: one day's sign-ups, check-ins and games, in
// the app's timezone. Read-only. Test accounts are left out. Games are counted
// on the day they started, so the game numbers for a day always add up.
const { db } = require('./index');
const { appNowSql, notTestSql } = require('./queries');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const toSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// The UTC instant of midnight, app time, at the start of the given day.
function dayStartUtc(day) {
  const guess = new Date(day + 'T00:00:00Z');
  const offsetMs = new Date(appNowSql(guess).replace(' ', 'T') + 'Z') - guess;
  return new Date(guess.getTime() - offsetMs);
}

function buildToday(dayParam) {
  const today = appNowSql().slice(0, 10);
  const day = DAY_RE.test(dayParam || '') && dayParam <= today ? dayParam : today;
  const start = dayStartUtc(day);
  const from = toSql(start);
  const to = toSql(new Date(start.getTime() + 24 * 60 * 60 * 1000));
  const one = (sql, ...args) => db.prepare(sql).get(...args).n;

  // A game counts when at least one real (non-test) player was in it.
  const realGame = `EXISTS (SELECT 1 FROM live_game_players lgp WHERE lgp.live_game_id = lg.id AND ${notTestSql('lgp.player_id')})`;
  const games = (extra) =>
    one(`SELECT COUNT(*) AS n FROM live_games lg WHERE lg.started_at >= ? AND lg.started_at < ? AND ${realGame} ${extra}`, from, to);

  return {
    day,
    isToday: day === today,
    maxDay: today,
    stats: [
      { label: 'Sign-ups', value: one("SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ? AND name NOT GLOB 'TEST*'", from, to) },
      {
        label: 'Players checked in',
        value: one(
          `SELECT COUNT(DISTINCT player_id) AS n FROM events WHERE event_name = 'checked_in' AND created_at >= ? AND created_at < ? AND ${notTestSql('player_id')}`,
          from,
          to
        ),
      },
      { label: 'Games started', value: games('') },
      { label: 'Games done', value: games('AND lg.result_submitted_at IS NOT NULL') },
      { label: 'Games confirmed', value: games("AND lg.status = 'done' AND lg.outcome IS NULL") },
      { label: 'Games still pending', value: games("AND lg.status = 'awaiting_confirmation'") },
      { label: 'Games disputed', value: games("AND lg.outcome = 'disputed'") },
      { label: 'Games unfinished', value: games("AND lg.outcome = 'no_result'") },
    ],
  };
}

module.exports = { buildToday };
