// Retention, cohorts, churn, streaks and the activation funnel for the
// owner's /admin dashboard. Read-only: nothing here writes to the database.
// Names are shown with their tag; phone numbers are never selected.
//
// Definitions (all weeks are Monday-to-Sunday and all months are calendar
// months, in APP_TIMEZONE):
//   - Active = a check-in or a played game that week.
//   - Headline numbers are about right now and ignore the date range.
//   - The date range limits the weeks, months and signups that are shown.
const { db } = require('./index');

const TZ = process.env.APP_TIMEZONE || 'America/New_York';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const DAY = 86400000;
const NAME = "(u.name || ' #' || u.tag)";

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
function weeksBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / (7 * DAY));
}
function pct(part, whole) {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// since: SQL timestamp for the range start, or null for all time.
// sinceWeek: the Monday of that week, or null.
// weeks: the weeks the range shows, oldest first.
function buildRetention({ since, sinceWeek, weeks, now }) {
  const thisWeek = weekOf(now);
  const lastWeek = addWeeks(thisWeek, -1);
  const prevWeek = addWeeks(thisWeek, -2);
  const inRange = (at) => !since || at >= since;
  const inWeekRange = (week) => !sinceWeek || week >= sinceWeek;

  // --- Raw activity. One row per check-in, and one per player per game.
  const rows = db
    .prepare(
      `SELECT player_id AS player, time_in AS at, NULL AS game FROM check_ins
       UNION ALL
       SELECT player_id, date, game_id FROM game_results`
    )
    .all()
    .map((r) => {
      const at = parseSql(r.at);
      return { player: r.player, at, game: r.game, week: weekOf(at), month: localDay(at).slice(0, 7) };
    });

  const signups = db
    .prepare(
      `SELECT p.id AS player, u.created_at AS at, ${NAME} AS name
       FROM players p JOIN users u ON u.id = p.user_id`
    )
    .all()
    .map((r) => ({ player: r.player, at: parseSql(r.at), atSql: r.at, name: r.name }));
  const signupWeek = new Map(signups.map((s) => [s.player, weekOf(s.at)]));
  const names = new Map(signups.map((s) => [s.player, s.name]));

  const weeksOf = new Map(); // player -> Set of active weeks
  const activeWeek = new Map(); // week -> Set of players
  const activeMonth = new Map(); // YYYY-MM -> Set of players
  const gamesWeek = new Map(); // week -> Set of game ids
  const participationsWeek = new Map(); // week -> player-game rows
  const monthGames = new Set(); // game ids played this calendar month
  const thisMonth = localDay(now).slice(0, 7);
  const rolling7 = new Set();
  const rolling30 = new Set();

  const add = (map, key, value) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };
  for (const r of rows) {
    add(weeksOf, r.player, r.week);
    add(activeWeek, r.week, r.player);
    add(activeMonth, r.month, r.player);
    if (r.game !== null) {
      add(gamesWeek, r.week, r.game);
      participationsWeek.set(r.week, (participationsWeek.get(r.week) || 0) + 1);
      if (r.month === thisMonth) monthGames.add(r.game);
    }
    if (r.at >= new Date(now - 7 * DAY)) rolling7.add(r.player);
    if (r.at >= new Date(now - 30 * DAY)) rolling30.add(r.player);
  }
  const activeIn = (week) => activeWeek.get(week) || new Set();

  // --- Headline (not range-dependent)
  const lastWeekActive = activeIn(lastWeek);
  const prevWeekActive = activeIn(prevWeek);
  const stayed = [...prevWeekActive].filter((p) => lastWeekActive.has(p)).length;
  const headline = {
    totalPlayers: signups.length,
    weeklyActive: lastWeekActive.size,
    returnRate: pct(stayed, prevWeekActive.size),
    stickiness: pct(rolling7.size, rolling30.size),
    gamesThisMonth: monthGames.size,
    gamesPerActive:
      lastWeekActive.size > 0 ? ((participationsWeek.get(lastWeek) || 0) / lastWeekActive.size).toFixed(1) : '—',
  };

  // --- Charts over the shown range
  const months = [...activeMonth.keys()]
    .filter((m) => !since || m >= since.slice(0, 7))
    .sort();
  const charts = [
    {
      title: 'Weekly active players',
      labels: weeks,
      values: weeks.map((w) => activeIn(w).size),
    },
    {
      title: 'Monthly active players',
      labels: months,
      values: months.map((m) => activeMonth.get(m).size),
    },
  ];

  // --- New vs returning, per week
  const firstWeek = new Map([...weeksOf].map(([p, set]) => [p, [...set].sort()[0]]));
  const newVsReturning = weeks.map((w) => {
    const active = activeIn(w);
    let fresh = 0;
    let returning = 0;
    for (const p of active) {
      // New = first time this player was active at all.
      if (firstWeek.get(p) === w) fresh += 1;
      else if (firstWeek.get(p) < w) returning += 1;
    }
    return [w, active.size, fresh, returning, pct(returning, active.size)];
  });

  // --- Cohorts: of the players who signed up in each week, the share active k weeks later
  const cohortWeeks = weeks.filter((w) => [...signupWeek.values()].includes(w));
  const cohorts = cohortWeeks.map((cohort) => {
    const members = [...signupWeek].filter(([, w]) => w === cohort).map(([p]) => p);
    const cells = [];
    for (let k = 1; k <= 8; k += 1) {
      const target = addWeeks(cohort, k);
      if (target > thisWeek) {
        cells.push('—');
        continue;
      }
      const back = members.filter((p) => (weeksOf.get(p) || new Set()).has(target)).length;
      cells.push(pct(back, members.length));
    }
    return [cohort, members.length, ...cells];
  });

  // --- Churned: active before, and nothing in the last three weeks.
  // Listed by the last week they were active, within the range.
  const churned = [];
  for (const [player, set] of weeksOf) {
    const last = [...set].sort().pop();
    if (last > addWeeks(thisWeek, -3)) continue;
    if (!inWeekRange(last)) continue;
    churned.push([names.get(player), last, set.size, signupWeek.get(player)]);
  }
  churned.sort((a, b) => (a[1] < b[1] ? 1 : -1));

  // --- Resurrected: back after three or more empty weeks, within the range.
  const resurrected = [];
  for (const [player, set] of weeksOf) {
    const sortedWeeks = [...set].sort();
    for (let i = 1; i < sortedWeeks.length; i += 1) {
      const gap = weeksBetween(sortedWeeks[i - 1], sortedWeeks[i]);
      if (gap >= 4 && inWeekRange(sortedWeeks[i])) {
        resurrected.push([names.get(player), sortedWeeks[i], gap - 1]);
      }
    }
  }
  resurrected.sort((a, b) => (a[1] < b[1] ? 1 : -1));

  // --- Streaks: each player's longest run of consecutive active weeks,
  // counting runs that end within the range.
  const longestRun = new Map();
  for (const [player, set] of weeksOf) {
    const sortedWeeks = [...set].sort();
    let run = 0;
    let best = 0;
    for (let i = 0; i < sortedWeeks.length; i += 1) {
      run = i > 0 && weeksBetween(sortedWeeks[i - 1], sortedWeeks[i]) === 1 ? run + 1 : 1;
      if (inWeekRange(sortedWeeks[i])) best = Math.max(best, run);
    }
    if (best >= 2) longestRun.set(player, best);
  }
  const streakCounts = { 2: 0, 3: 0, '4+': 0 };
  for (const best of longestRun.values()) {
    if (best === 2) streakCounts[2] += 1;
    else if (best === 3) streakCounts[3] += 1;
    else streakCounts['4+'] += 1;
  }
  const streaks = [
    ['2 weeks in a row', streakCounts[2]],
    ['3 weeks in a row', streakCounts[3]],
    ['4 or more weeks in a row', streakCounts['4+']],
  ];

  // --- Activation funnel: players who signed up within the range.
  const milestones = new Map();
  for (const r of db.prepare('SELECT player_id, milestone, at FROM player_milestones').all()) {
    if (!milestones.has(r.player_id)) milestones.set(r.player_id, new Map());
    milestones.get(r.player_id).set(r.milestone, r.at);
  }
  const cohort = signups.filter((s) => inRange(s.atSql));
  const has = (p, key) => milestones.has(p) && milestones.get(p).has(key);
  const steps = [
    ['Opened the app', (p) => has(p.player, 'first_open')],
    ['Signed up', () => true],
    ['First check-in', (p) => has(p.player, 'first_checkin')],
    ['First game played', (p) => has(p.player, 'first_game')],
    ['Came back a second week', (p) => (weeksOf.get(p.player) || new Set()).size >= 2],
  ];
  const stepCounts = steps.map(([, test]) => cohort.filter(test).length);
  const funnel = steps.map(([label], i) => [
    label,
    stepCounts[i],
    i === 0 ? '—' : pct(stepCounts[i], stepCounts[i - 1]),
    pct(stepCounts[i], stepCounts[1]),
  ]);

  const daysToFirstGame = cohort
    .filter((p) => has(p.player, 'first_game'))
    .map((p) => (parseSql(milestones.get(p.player).get('first_game')) - p.at) / DAY);
  const medianDays = median(daysToFirstGame);

  const churnedInRange = churned.length;
  const resurrectedInRange = resurrected.length;
  const latestMonth = months[months.length - 1];

  return {
    headline,
    headlineSection: {
      title: 'Headline',
      big: [
        { label: 'Total players', value: headline.totalPlayers },
        { label: 'Weekly active (last full week)', value: headline.weeklyActive },
        { label: 'Week-over-week return rate', value: headline.returnRate },
        { label: 'Stickiness (7-day ÷ 30-day actives)', value: headline.stickiness },
        { label: 'Games this month', value: headline.gamesThisMonth },
        { label: 'Games per active player, last full week', value: headline.gamesPerActive },
      ],
      note: 'Week-over-week return rate: of the players active the week before last, the share active last week.',
    },
    retentionSection: {
      title: 'Retention',
      big: [
        { label: 'Active last full week', value: lastWeekActive.size },
        { label: 'Active this month', value: latestMonth ? activeMonth.get(latestMonth).size : 0 },
        { label: 'Churned (no activity in 3 weeks)', value: churnedInRange },
        { label: 'Resurrected (back after 3+ weeks)', value: resurrectedInRange },
      ],
      charts,
      tables: ['retention-new-returning', 'cohorts-8w', 'churned', 'resurrected', 'streaks'],
      note: 'Active = checked in or played a game. Churned and resurrected are counted by the week they happened in the chosen range.',
    },
    activationSection: {
      title: 'Activation funnel',
      big: [
        { label: 'Signed up in range', value: cohort.length },
        { label: 'Reached a first game', value: stepCounts[3] },
        {
          label: 'Median days, signup to first game',
          value: medianDays === null ? '—' : medianDays.toFixed(1),
        },
      ],
      tables: ['funnel'],
      note: '"Opened the app" is the first app open. Most players open the app for the first time while signing up.',
    },
    tables: {
      'retention-new-returning': {
        title: 'New vs returning players, per week',
        headers: ['Week of', 'Active', 'New (first time active)', 'Returning', 'Share returning'],
        rows: newVsReturning,
      },
      'cohorts-8w': {
        title: 'Cohorts: share of each signup week still active, weeks 1–8',
        headers: ['Signed up week of', 'Players', 'Week 1', 'Week 2', 'Week 3', 'Week 4', 'Week 5', 'Week 6', 'Week 7', 'Week 8'],
        rows: cohorts,
      },
      churned: {
        title: 'Churned: active before, quiet for 3 weeks',
        headers: ['Player', 'Last active week of', 'Weeks active', 'Signed up week of'],
        rows: churned,
      },
      resurrected: {
        title: 'Resurrected: back after 3+ weeks away',
        headers: ['Player', 'Came back week of', 'Weeks away'],
        rows: resurrected,
      },
      streaks: {
        title: 'Streaks: longest run of active weeks per player',
        headers: ['Streak', 'Players'],
        rows: streaks,
      },
      funnel: {
        title: 'Activation funnel, players who signed up in range',
        headers: ['Step', 'Players', '% of previous step', '% of signups'],
        rows: funnel,
      },
    },
  };
}

module.exports = { buildRetention, parseSql, toSql, localDay, weekOf, addWeeks, pct, TZ, DAY };
