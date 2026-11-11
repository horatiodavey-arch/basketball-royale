// Numbers for the owner's private dashboard at /admin. Read-only: nothing
// here writes to the database. Names are shown with their tag and phone
// numbers are never selected.
const { db } = require('./index');
const { formatAggregate, FORMATS, CROWN_LEVELS, getCrownLevel, getSeasonWindow } = require('./queries');

const TZ = process.env.APP_TIMEZONE || 'America/New_York';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
const NAME = "(u.name || ' #' || u.tag)";
const RANGE_DAYS = { 7: 7, 30: 30, all: null };
const DAY = 86400000;

function parseSql(text) {
  return new Date(text.replace(' ', 'T') + 'Z');
}
function toSql(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
function localDay(date) {
  return dayFmt.format(date);
}
// The Monday (YYYY-MM-DD) of the week a moment falls in, in the app's timezone.
function weekOf(date) {
  const d = new Date(localDay(date) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function addWeeks(week, n) {
  const d = new Date(week + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10);
}
function pct(part, whole) {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}

function resolveRange(range) {
  const key = Object.prototype.hasOwnProperty.call(RANGE_DAYS, range) ? range : '30';
  const days = RANGE_DAYS[key];
  const since = days ? toSql(new Date(Date.now() - days * DAY)) : null;
  return { key, since, sinceWeek: since ? weekOf(parseSql(since)) : null };
}

// Everything the dashboard shows, computed for one date range.
function buildDashboard(range) {
  const { key, since, sinceWeek } = resolveRange(range);
  const now = new Date();
  const thisWeek = weekOf(now);
  const inRange = (at) => !since || at >= since;

  // --- Raw activity: a check-in or a played game counts as "active".
  const activity = db
    .prepare(
      `SELECT player_id AS player, time_in AS at, park_id AS park, NULL AS game, NULL AS format FROM check_ins
       UNION ALL
       SELECT player_id, date, park_id, game_id, format FROM game_results`
    )
    .all();

  const signupRows = db
    .prepare(
      `SELECT p.id AS player, u.created_at AS at, ${NAME} AS name
       FROM players p JOIN users u ON u.id = p.user_id`
    )
    .all();
  const signupWeek = new Map(signupRows.map((r) => [r.player, weekOf(parseSql(r.at))]));
  const names = new Map(signupRows.map((r) => [r.player, r.name]));

  const weeksByPlayer = new Map();
  const activeByWeek = new Map();
  for (const row of activity) {
    const week = weekOf(parseSql(row.at));
    if (!activeByWeek.has(week)) activeByWeek.set(week, new Set());
    activeByWeek.get(week).add(row.player);
    if (!weeksByPlayer.has(row.player)) weeksByPlayer.set(row.player, new Set());
    weeksByPlayer.get(row.player).add(week);
  }

  // Weeks to show: the range's weeks, or every week with data for "all time".
  const allWeeks = [...new Set([...activeByWeek.keys(), ...signupWeek.values()])].sort();
  const shownWeeks = sinceWeek
    ? Array.from({ length: Math.round((new Date(thisWeek) - new Date(sinceWeek)) / (7 * DAY)) + 1 }, (_, i) =>
        addWeeks(sinceWeek, i)
      )
    : allWeeks;

  // --- Growth
  const signupsInRange = signupRows.filter((r) => inRange(r.at));
  const signupsByWeek = new Map();
  for (const r of signupsInRange) {
    const w = weekOf(parseSql(r.at));
    signupsByWeek.set(w, (signupsByWeek.get(w) || 0) + 1);
  }
  const firstPark = new Map();
  for (const row of db.prepare('SELECT player_id, park_id FROM check_ins ORDER BY time_in ASC, id ASC').all()) {
    if (!firstPark.has(row.player_id)) firstPark.set(row.player_id, row.park_id);
  }
  const parkNames = new Map(db.prepare('SELECT id, name FROM parks').all().map((p) => [p.id, p.name]));
  const signupsByPark = new Map();
  for (const r of signupsInRange) {
    const park = firstPark.get(r.player);
    const label = park ? parkNames.get(park) : 'No check-in yet';
    signupsByPark.set(label, (signupsByPark.get(label) || 0) + 1);
  }

  // --- Retention
  const retentionRows = shownWeeks.map((week) => {
    const active = activeByWeek.get(week) || new Set();
    let fresh = 0;
    for (const player of active) if (signupWeek.get(player) === week) fresh += 1;
    const next = activeByWeek.get(addWeeks(week, 1)) || new Set();
    const cameBack = week === thisWeek ? null : [...active].filter((p) => next.has(p)).length;
    return {
      week,
      active: active.size,
      fresh,
      returning: active.size - fresh,
      returnRate: cameBack === null ? '—' : pct(cameBack, active.size),
    };
  });

  const cohortWeeks = shownWeeks.filter((w) => signupWeek && [...signupWeek.values()].includes(w));
  const cohortRows = cohortWeeks.map((cohort) => {
    const members = [...signupWeek.entries()].filter(([, w]) => w === cohort).map(([p]) => p);
    const cells = [1, 2, 3, 4].map((k) => {
      const target = addWeeks(cohort, k);
      if (target > thisWeek) return '—';
      const back = members.filter((p) => (weeksByPlayer.get(p) || new Set()).has(target)).length;
      return pct(back, members.length);
    });
    return { cohort, size: members.length, cells };
  });

  // --- Activity
  const checkinsInRange = activity.filter((r) => r.game === null && inRange(r.at));
  const gamesInRange = activity.filter((r) => r.game !== null && inRange(r.at));
  const checkinsByPark = new Map();
  for (const r of checkinsInRange) {
    const label = parkNames.get(r.park) || 'Unknown';
    checkinsByPark.set(label, (checkinsByPark.get(label) || 0) + 1);
  }
  const gamesByPark = new Map();
  const gamesByFormat = new Map();
  const seenGame = new Set();
  for (const r of gamesInRange) {
    if (seenGame.has(r.game)) continue;
    seenGame.add(r.game);
    const park = parkNames.get(r.park) || 'Unknown';
    gamesByPark.set(park, (gamesByPark.get(park) || 0) + 1);
    const format = r.format || 'Legacy (no format)';
    gamesByFormat.set(format, (gamesByFormat.get(format) || 0) + 1);
  }
  const dayCounts = new Map();
  const hourCounts = new Map();
  for (const r of activity.filter((x) => inRange(x.at))) {
    const at = parseSql(r.at);
    const day = weekdayFmt.format(at);
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
    const hour = Number(hourFmt.format(at));
    hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
  }
  const appOpens = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE event_name = 'app_open' AND (? IS NULL OR created_at >= ?)")
    .get(since, since).n;

  // --- Competition
  const season = getSeasonWindow(now);
  const crownRows = CROWN_LEVELS.map((level) => ({ level, byFormat: {} }));
  for (const format of FORMATS) {
    const players = db
      .prepare('SELECT DISTINCT player_id AS p FROM game_results WHERE format = ? AND date >= ?')
      .all(format, season.startSql)
      .map((r) => r.p);
    for (const player of players) {
      const { points } = formatAggregate(player, format, season.startSql);
      const crown = getCrownLevel(points);
      if (!crown) continue;
      const row = crownRows.find((r) => r.level.name === crown.name);
      row.byFormat[format] = (row.byFormat[format] || 0) + 1;
    }
  }
  const trophiesByFormat = new Map();
  for (const row of db
    .prepare('SELECT format, earned_at AS at FROM format_trophies')
    .all()
    .filter((r) => inRange(r.at))) {
    trophiesByFormat.set(row.format, (trophiesByFormat.get(row.format) || 0) + 1);
  }
  const seasonTrophies = db
    .prepare('SELECT created_at AS at FROM trophies')
    .all()
    .filter((r) => inRange(r.at)).length;

  const topPlayers = db
    .prepare(
      `SELECT gr.player_id AS player, ${NAME} AS name,
              SUM(CASE WHEN gr.result = 'win' THEN 1 ELSE 0 END) AS wins,
              COUNT(*) AS games, SUM(gr.minutes_played) AS minutes
       FROM game_results gr JOIN players p ON p.id = gr.player_id JOIN users u ON u.id = p.user_id
       WHERE (? IS NULL OR gr.date >= ?)
       GROUP BY gr.player_id`
    )
    .all(since, since)
    .map((r) => {
      const hours = Math.round((r.minutes / 60) * 10) / 10;
      return { name: r.name, wins: r.wins, games: r.games, points: Math.round((r.wins * 3 + r.games + hours) * 10) / 10 };
    })
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);

  // --- Integrity
  const eventCount = (name) =>
    db
      .prepare('SELECT created_at AS at FROM events WHERE event_name = ?')
      .all(name)
      .filter((r) => inRange(r.at)).length;
  const locked = db
    .prepare("SELECT locked_at AS at FROM live_games WHERE status = 'done' AND locked_at IS NOT NULL")
    .all()
    .filter((r) => inRange(r.at)).length;
  const editsAfterStart = db
    .prepare(
      `SELECT re.created_at AS at FROM roster_edits re
       JOIN live_games lg ON lg.id = re.live_game_id
       WHERE lg.started_at IS NOT NULL AND re.created_at > lg.started_at`
    )
    .all()
    .filter((r) => inRange(r.at)).length;

  // --- Curiosity
  const lobbyTaps = db
    .prepare(
      `SELECT e.created_at AS at, ${NAME} AS name FROM events e
       JOIN players p ON p.id = e.player_id JOIN users u ON u.id = p.user_id
       WHERE e.event_name = 'view_lobbies'`
    )
    .all()
    .filter((r) => inRange(r.at));
  const lobbyByPlayer = new Map();
  for (const r of lobbyTaps) lobbyByPlayer.set(r.name, (lobbyByPlayer.get(r.name) || 0) + 1);
  const suggestions = db
    .prepare(
      `SELECT cs.created_at AS at, cs.name AS court, cs.status, ${NAME} AS name
       FROM court_suggestions cs JOIN players p ON p.id = cs.player_id JOIN users u ON u.id = p.user_id
       ORDER BY cs.created_at DESC`
    )
    .all()
    .filter((r) => inRange(r.at));

  const newSignups = signupsInRange.length;
  const thisWeekActive = (activeByWeek.get(thisWeek) || new Set()).size;
  const lastFullWeek = addWeeks(thisWeek, -1);
  const lastRate = retentionRows.find((r) => r.week === lastFullWeek);

  return {
    range: key,
    rangeLabel: key === 'all' ? 'All time' : `Last ${key} days`,
    generatedAt: toSql(now),
    tables: {
      'signups-weekly': {
        title: 'New signups per week',
        headers: ['Week of', 'New signups'],
        rows: shownWeeks.map((w) => [w, signupsByWeek.get(w) || 0]),
      },
      'signups-park': {
        title: 'Signups by park (first park checked in at)',
        headers: ['Park', 'Players'],
        rows: [...signupsByPark.entries()].sort((a, b) => b[1] - a[1]),
      },
      'retention-weekly': {
        title: 'Weekly activity and return rate',
        headers: ['Week of', 'Active players', 'New', 'Returning', 'Came back the next week'],
        rows: retentionRows.map((r) => [r.week, r.active, r.fresh, r.returning, r.returnRate]),
      },
      cohorts: {
        title: 'Cohorts: share of each signup week still active',
        headers: ['Signed up week of', 'Players', 'Week 1', 'Week 2', 'Week 3', 'Week 4'],
        rows: cohortRows.map((c) => [c.cohort, c.size, ...c.cells]),
      },
      'checkins-park': {
        title: 'Check-ins per park',
        headers: ['Park', 'Check-ins'],
        rows: [...checkinsByPark.entries()].sort((a, b) => b[1] - a[1]),
      },
      'games-park': {
        title: 'Games per park',
        headers: ['Park', 'Games'],
        rows: [...gamesByPark.entries()].sort((a, b) => b[1] - a[1]),
      },
      'games-format': {
        title: 'Games by format',
        headers: ['Format', 'Games'],
        rows: [...gamesByFormat.entries()].sort((a, b) => b[1] - a[1]),
      },
      'busy-days': {
        title: 'Busiest days',
        headers: ['Day', 'Check-ins and games'],
        rows: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => [d, dayCounts.get(d) || 0]),
      },
      'busy-hours': {
        title: 'Busiest hours',
        headers: ['Hour', 'Check-ins and games'],
        rows: [...hourCounts.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([h, n]) => [`${h}:00`, n]),
      },
      'crowns-level': {
        title: 'Crowns held this season, by level and format',
        headers: ['Crown', ...FORMATS],
        rows: crownRows.map((r) => [r.level.name, ...FORMATS.map((f) => r.byFormat[f] || 0)]),
      },
      trophies: {
        title: 'Trophies earned',
        headers: ['Format', 'Trophies'],
        rows: [...FORMATS.map((f) => [f, trophiesByFormat.get(f) || 0]), ['Earlier season crowns', seasonTrophies]],
      },
      'top-players': {
        title: 'Top players by points',
        headers: ['Player', 'Points', 'Wins', 'Games'],
        rows: topPlayers.map((p) => [p.name, p.points, p.wins, p.games]),
      },
      integrity: {
        title: 'Results and roster changes',
        headers: ['Measure', 'Count'],
        rows: [
          ['Results submitted', eventCount('result_submitted')],
          ['Results disputed', eventCount('result_disputed')],
          ['Results voided (incl. disputes and timeouts)', eventCount('result_voided')],
          ['Results locked', locked],
          ['Roster edits after the game started', editsAfterStart],
        ],
      },
      'curiosity-lobbies': {
        title: '"View lobbies" taps by player',
        headers: ['Player', 'Taps'],
        rows: [...lobbyByPlayer.entries()].sort((a, b) => b[1] - a[1]),
      },
      'curiosity-suggestions': {
        title: '"Suggest a court" submissions',
        headers: ['When (UTC)', 'Court', 'Suggested by', 'Status'],
        rows: suggestions.map((s) => [s.at, s.court, s.name, s.status]),
      },
    },
    sections: [
      {
        title: 'Growth',
        big: [
          { label: 'New signups', value: newSignups },
          { label: 'Players in total', value: signupRows.length },
        ],
        tables: ['signups-weekly', 'signups-park'],
      },
      {
        title: 'Retention',
        big: [
          { label: 'Active this week', value: thisWeekActive },
          { label: 'Came back, last full week', value: lastRate ? lastRate.returnRate : '—' },
        ],
        tables: ['retention-weekly', 'cohorts'],
        note: 'Active = checked in or played a game. A week counts as "came back" when the player is active the following week.',
      },
      {
        title: 'Activity',
        big: [
          { label: 'App opens', value: appOpens },
          { label: 'Check-ins', value: checkinsInRange.length },
          { label: 'Games', value: seenGame.size },
        ],
        tables: ['checkins-park', 'games-park', 'games-format', 'busy-days', 'busy-hours'],
      },
      {
        title: 'Competition',
        big: [
          { label: 'Trophies earned', value: [...trophiesByFormat.values()].reduce((a, b) => a + b, 0) + seasonTrophies },
          { label: 'Players with a crown this season', value: crownRows.reduce((n, r) => n + Object.values(r.byFormat).reduce((a, b) => a + b, 0), 0) },
        ],
        tables: ['crowns-level', 'trophies', 'top-players'],
        note: 'Crowns are this season only. Trophies and top players follow the chosen date range.',
      },
      {
        title: 'Integrity',
        big: [
          { label: 'Results submitted', value: eventCount('result_submitted') },
          { label: 'Disputed', value: eventCount('result_disputed') },
          { label: 'Voided', value: eventCount('result_voided') },
        ],
        tables: ['integrity'],
        note: 'Result events are recorded from the day this shipped, so earlier games show zero here.',
      },
      {
        title: 'Curiosity',
        big: [
          { label: '"View lobbies" taps', value: lobbyTaps.length },
          { label: 'Court suggestions', value: suggestions.length },
        ],
        tables: ['curiosity-lobbies', 'curiosity-suggestions'],
      },
    ],
  };
}

module.exports = { buildDashboard, resolveRange };
