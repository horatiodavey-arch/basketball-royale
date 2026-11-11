// Part 3 of the owner's /admin dashboard: engagement, growth detail, parks,
// the crown picture, and an event lookup with paid-play interest.
// Read-only: nothing here writes to the database. Players are shown by
// display name and tag. Phone numbers are never selected.
const { db } = require('./index');
const { formatAggregate, FORMATS, getCrownLevel, getSeasonWindow, TRACKED_EVENTS } = require('./queries');
const { parseSql, weekOf, pct, TZ } = require('./retention');

const NAME = "(u.name || ' #' || u.tag)";
// The "Join" button on a paid lobby logs this event on every tap.
const PAID_EVENT = 'lobby_join_try';
const LOOKUP_LIMIT = 500;
const whenFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// since: SQL timestamp for the range start, or null for all time.
// weeks: the weeks the range shows, oldest first.
function buildPartThree({ since, weeks, now, event }) {
  const inRange = (at) => !since || at >= since;

  const parks = new Map(db.prepare('SELECT id, name, city FROM parks').all().map((p) => [p.id, p]));
  const parkLabel = (id) => {
    const park = parks.get(id);
    if (!park) return 'Unknown';
    return park.city ? `${park.name} · ${park.city}` : park.name;
  };
  const names = new Map(
    db.prepare(`SELECT p.id, ${NAME} AS name FROM players p JOIN users u ON u.id = p.user_id`).all().map((r) => [r.id, r.name])
  );

  // --- Raw activity in range
  const checkins = db
    .prepare('SELECT player_id, park_id, time_in AS at FROM check_ins')
    .all()
    .filter((r) => inRange(r.at));
  const games = db
    .prepare('SELECT player_id, park_id, minutes_played, date AS at FROM game_results')
    .all()
    .filter((r) => inRange(r.at));
  const activity = [...checkins, ...games];
  const activePlayers = new Set(activity.map((r) => r.player_id));
  const checkinPlayers = new Set(checkins.map((r) => r.player_id));
  const gamePlayers = new Set(games.map((r) => r.player_id));

  // --- Engagement
  const weekly = new Map(weeks.map((w) => [w, { active: new Set(), games: 0 }]));
  for (const r of checkins) {
    const bucket = weekly.get(weekOf(parseSql(r.at)));
    if (bucket) bucket.active.add(r.player_id);
  }
  for (const r of games) {
    const bucket = weekly.get(weekOf(parseSql(r.at)));
    if (bucket) {
      bucket.active.add(r.player_id);
      bucket.games += 1;
    }
  }
  const engagementWeekly = weeks.map((w) => {
    const { active, games: gamesThisWeek } = weekly.get(w);
    return [w, active.size, gamesThisWeek, active.size ? (gamesThisWeek / active.size).toFixed(1) : '—'];
  });
  const weeklyActiveTotal = [...weekly.values()].reduce((n, b) => n + b.active.size, 0);
  const weeklyGamesTotal = games.length;
  const minutesTotal = games.reduce((n, r) => n + (r.minutes_played || 0), 0);

  const parksByPlayer = new Map();
  for (const r of activity) {
    if (!parksByPlayer.has(r.player_id)) parksByPlayer.set(r.player_id, new Set());
    parksByPlayer.get(r.player_id).add(r.park_id);
  }
  const multiPark = [...parksByPlayer.values()].filter((s) => s.size >= 2).length;

  // --- Growth detail
  const signups = db
    .prepare(
      `SELECT u.created_at AS at, COALESCE(u.source, 'direct') AS source,
              u.referred_by_player_id AS referrer, p.id AS player
       FROM users u JOIN players p ON p.user_id = u.id`
    )
    .all()
    .filter((r) => inRange(r.at));
  const fromReferral = signups.filter((r) => r.referrer !== null);
  const sourceRows = [...countBy(signups, (r) => r.source).entries()].sort((a, b) => b[1] - a[1]);
  const referrerRows = [...countBy(fromReferral, (r) => r.referrer).entries()]
    .map(([player, invited]) => [names.get(player) || 'Unknown', invited])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  // --- Parks
  const parkStats = new Map();
  const statFor = (id) => {
    if (!parkStats.has(id)) parkStats.set(id, { checkins: 0, games: 0, players: new Set() });
    return parkStats.get(id);
  };
  for (const r of checkins) {
    const s = statFor(r.park_id);
    s.checkins += 1;
    s.players.add(r.player_id);
  }
  for (const r of games) {
    const s = statFor(r.park_id);
    s.games += 1;
    s.players.add(r.player_id);
  }
  const parkRows = [...parkStats.entries()]
    .map(([id, s]) => {
      const park = parks.get(id);
      return [park ? park.name : 'Unknown', park ? park.city || '' : '', s.checkins, s.games, s.players.size];
    })
    .sort((a, b) => b[2] + b[3] - (a[2] + a[3]));
  const createdByPlayers = db
    .prepare(
      `SELECT p.name AS park, p.city AS city, ${NAME} AS addedBy
       FROM parks p
       LEFT JOIN players pl ON pl.id = p.added_by_player_id
       LEFT JOIN users u ON u.id = pl.user_id
       WHERE p.added_by_player_id IS NOT NULL
       ORDER BY p.id DESC`
    )
    .all()
    .map((r) => [r.park, r.city || '', r.addedBy || 'Unknown']);

  // --- Competition detail: crowns this season, for players active in range
  const season = getSeasonWindow(now);
  const crownPlayers = new Set();
  for (const format of FORMATS) {
    const players = db
      .prepare('SELECT DISTINCT player_id AS p FROM game_results WHERE format = ? AND date >= ?')
      .all(format, season.startSql)
      .map((r) => r.p);
    for (const player of players) {
      const { points } = formatAggregate(player, format, season.startSql);
      if (getCrownLevel(points)) crownPlayers.add(player);
    }
  }
  const activeWithCrown = [...activePlayers].filter((p) => crownPlayers.has(p)).length;

  const suggestions = db
    .prepare('SELECT created_at AS at FROM court_suggestions')
    .all()
    .filter((r) => inRange(r.at)).length;

  // --- Event lookup and paid-play interest
  const eventNames = db
    .prepare('SELECT DISTINCT event_name AS name FROM events ORDER BY event_name')
    .all()
    .map((r) => r.name);
  const labelOf = new Map(TRACKED_EVENTS.map((e) => [e.name, e.label]));
  const options = eventNames.map((name) => ({ name, label: labelOf.get(name) || name }));
  const fallback = eventNames.includes('check_in') ? 'check_in' : eventNames[0] || null;
  const chosen = eventNames.includes(event) ? event : fallback;

  const eventRows = (name) =>
    db
      .prepare(
        `SELECT e.player_id, e.park_id, e.created_at AS at, ${NAME} AS name
         FROM events e JOIN players p ON p.id = e.player_id JOIN users u ON u.id = p.user_id
         WHERE e.event_name = ?
         ORDER BY e.created_at DESC, e.id DESC`
      )
      .all(name)
      .filter((r) => inRange(r.at));

  const chosenRows = chosen ? eventRows(chosen) : [];
  const chosenPlayers = new Set(chosenRows.map((r) => r.player_id));
  const eventTaps = chosenRows.slice(0, LOOKUP_LIMIT).map((r) => [
    r.name,
    parkLabel(r.park_id),
    whenFmt.format(parseSql(r.at)),
  ]);

  const paidRows = eventRows(PAID_EVENT);
  const paidTapsByPlayer = countBy(paidRows, (r) => r.player_id);
  const paidNames = new Map(paidRows.map((r) => [r.player_id, r.name]));
  const paidInterest = [...paidTapsByPlayer.entries()]
    .map(([player, taps]) => [paidNames.get(player), taps])
    .sort((a, b) => b[1] - a[1]);

  return {
    tables: {
      'engagement-weekly': {
        title: 'Games per active player, per week',
        headers: ['Week of', 'Active players', 'Games', 'Games per active player'],
        rows: engagementWeekly,
      },
      'parks-activity': {
        title: 'Parks: check-ins and games',
        headers: ['Park', 'City', 'Check-ins', 'Games', 'Unique players'],
        rows: parkRows,
      },
      'parks-by-players': {
        title: 'Parks created by players',
        headers: ['Park', 'City', 'Added by'],
        rows: createdByPlayers,
      },
      'signups-source': {
        title: 'Signups by source',
        headers: ['Source', 'Players'],
        rows: sourceRows,
      },
      'top-referrers': {
        title: 'Top referrers',
        headers: ['Player', 'Players invited'],
        rows: referrerRows,
      },
      'event-taps': {
        title: `"${labelOf.get(chosen) || chosen || 'No events yet'}": who tapped, newest first`,
        headers: ['Player', 'Park', 'When'],
        rows: eventTaps,
      },
      'paid-interest': {
        title: 'Paid game button: taps per player',
        headers: ['Player', 'Taps'],
        rows: paidInterest,
      },
    },
    engagement: {
      title: 'Engagement',
      big: [
        {
          label: 'Games per active player per week',
          value: weeklyActiveTotal ? (weeklyGamesTotal / weeklyActiveTotal).toFixed(1) : '—',
        },
        {
          label: 'Average court time per player',
          value: gamePlayers.size ? `${Math.round(minutesTotal / gamePlayers.size)} min` : '—',
        },
        {
          label: 'Check-ins per player',
          value: checkinPlayers.size ? (checkins.length / checkinPlayers.size).toFixed(1) : '—',
        },
        { label: 'Players active at 2+ parks', value: multiPark },
      ],
      tables: ['engagement-weekly', 'busy-days', 'busy-hours'],
      note: 'Busiest days and hours are check-ins and games combined, in the app timezone.',
    },
    parks: {
      title: 'Parks',
      big: [
        { label: 'Active parks', value: parkStats.size },
        { label: 'Parks created by players', value: createdByPlayers.length },
        { label: '"Suggest a court" submissions', value: suggestions },
      ],
      tables: ['parks-activity', 'parks-by-players', 'curiosity-suggestions'],
      note: 'Parks have no created date, so "parks created by players" counts all time. Suggestions follow the date range.',
    },
    lookup: {
      title: 'Event lookup and paid play',
      big: [
        { label: 'Taps for this event', value: chosenRows.length },
        { label: 'Unique players for this event', value: chosenPlayers.size },
        { label: 'Players who tapped a paid game button', value: paidTapsByPlayer.size },
        {
          label: 'Paid button: players who tapped it more than once',
          value: [...paidTapsByPlayer.values()].filter((n) => n > 1).length,
        },
      ],
      tables: ['event-taps', 'paid-interest'],
      eventPicker: { options, selected: chosen },
      note: 'Pick any event above. Paid game interest is the "Join" button on paid lobbies.',
    },
    growthBig: [
      { label: 'Signups from referrals', value: fromReferral.length },
      { label: 'Referral rate', value: pct(fromReferral.length, signups.length) },
    ],
    growthTables: ['signups-source', 'top-referrers'],
    competitionBig: [
      {
        label: 'Active players with a crown (bronze or better)',
        value: pct(activeWithCrown, activePlayers.size),
      },
    ],
  };
}

module.exports = { buildPartThree };
