// Guests, play streaks and invites. Display and tracking only: nothing here
// gives King of the Court points. Crowns only come from confirmed games.
const { db } = require('./index');
const { appNowSql, notTestSql } = require('./queries');

// --- Guests
function recordGuestVisit(guestId, path) {
  db.prepare('INSERT OR IGNORE INTO guest_visits (guest_id, day, first_path) VALUES (?, ?, ?)').run(
    guestId,
    appNowSql().slice(0, 10),
    String(path || '').slice(0, 120)
  );
}

function recordGuestSignup(guestId, userId, action) {
  db.prepare('INSERT OR IGNORE INTO guest_signups (guest_id, user_id, action) VALUES (?, ?, ?)').run(guestId, userId, action || 'none');
}

// --- Play streak. A week (Monday to Sunday, app time) counts when the player
// has at least one confirmed game in it. The current streak is the run of
// weeks ending this week, or last week if this week has no game yet: a streak
// only resets once a whole week passes with no game.
const DAY_MS = 24 * 60 * 60 * 1000;
function weekStartOf(localDay) {
  const d = new Date(localDay + 'T00:00:00Z');
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}
const addWeeks = (week, n) => new Date(new Date(week + 'T00:00:00Z').getTime() + n * 7 * DAY_MS).toISOString().slice(0, 10);

function playStreak(playerId) {
  const weeks = new Set(
    db
      .prepare('SELECT DISTINCT date FROM game_results WHERE player_id = ?')
      .all(playerId)
      .map((r) => weekStartOf(appNowSql(new Date(String(r.date).replace(' ', 'T') + 'Z')).slice(0, 10)))
  );
  const thisWeek = weekStartOf(appNowSql().slice(0, 10));
  let current = 0;
  let cursor = weeks.has(thisWeek) ? thisWeek : addWeeks(thisWeek, -1);
  while (weeks.has(cursor)) {
    current++;
    cursor = addWeeks(cursor, -1);
  }
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const w of [...weeks].sort()) {
    run = prev && addWeeks(prev, 1) === w ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = w;
  }
  const stored = (db.prepare('SELECT longest_streak FROM players WHERE id = ?').get(playerId) || {}).longest_streak || 0;
  return { current, longest: Math.max(longest, stored) };
}

// Called when a result locks, so the longest streak is kept even if older games are removed.
function saveLongestStreak(playerId) {
  const { current, longest } = playStreak(playerId);
  db.prepare('UPDATE players SET longest_streak = MAX(longest_streak, ?) WHERE id = ?').run(longest, playerId);
  return current;
}

// --- Invites. An invite counts once the new player signed up with their phone
// (they have an account) AND played a confirmed game. Until then it's pending.
const PLAYED = 'EXISTS (SELECT 1 FROM game_results gr WHERE gr.player_id = p.id)';
function recruitedCount(playerId) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM users u JOIN players p ON p.user_id = u.id WHERE u.referred_by_player_id = ? AND ${PLAYED}`)
    .get(playerId).n;
}

const RECRUITER_AT = 3;

// --- /admin
function adminGrowthSummary() {
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  const weekAgo = new Date(Date.now() - 7 * DAY_MS);
  const players = db.prepare(`SELECT p.id FROM players p JOIN users u ON u.id = p.user_id WHERE u.name NOT GLOB 'TEST*'`).all();
  const streaks = players
    .map((p) => ({ id: p.id, ...playStreak(p.id) }))
    .filter((s) => s.current > 0);
  const names = new Map(
    db.prepare("SELECT p.id, u.name || ' #' || u.tag AS name FROM players p JOIN users u ON u.id = p.user_id").all().map((r) => [r.id, r.name])
  );
  return {
    big: [
      { label: 'Guests (all time)', value: one('SELECT COUNT(DISTINCT guest_id) AS n FROM guest_visits') },
      { label: 'Guests, last 7 days', value: one('SELECT COUNT(DISTINCT guest_id) AS n FROM guest_visits WHERE day >= ?', appNowSql(weekAgo).slice(0, 10)) },
      { label: 'Guest visits (guest-days)', value: one('SELECT COUNT(*) AS n FROM guest_visits') },
      { label: 'Guests who signed up', value: one('SELECT COUNT(DISTINCT guest_id) AS n FROM guest_signups') },
      { label: 'Players on a streak', value: streaks.length },
      { label: 'Invites counted', value: one(`SELECT COUNT(*) AS n FROM users u JOIN players p ON p.user_id = u.id WHERE u.referred_by_player_id IS NOT NULL AND u.name NOT GLOB 'TEST*' AND ${PLAYED}`) },
      { label: 'Invites pending', value: one(`SELECT COUNT(*) AS n FROM users u JOIN players p ON p.user_id = u.id WHERE u.referred_by_player_id IS NOT NULL AND u.name NOT GLOB 'TEST*' AND NOT ${PLAYED}`) },
    ],
    signupActions: db
      .prepare('SELECT action, COUNT(*) AS n FROM guest_signups GROUP BY action ORDER BY n DESC')
      .all()
      .map((r) => [r.action === 'none' ? 'looked around, no action' : r.action, r.n]),
    topStreaks: streaks
      .sort((a, b) => b.current - a.current || b.longest - a.longest)
      .slice(0, 10)
      .map((s) => [names.get(s.id) || 'Unknown', s.current, s.longest]),
    topRecruiters: db
      .prepare(
        `SELECT ref.id AS id, COUNT(*) AS counted FROM users u JOIN players p ON p.user_id = u.id
         JOIN players ref ON ref.id = u.referred_by_player_id
         WHERE ${PLAYED} AND ${notTestSql('ref.id')} GROUP BY ref.id ORDER BY counted DESC LIMIT 10`
      )
      .all()
      .map((r) => [names.get(r.id) || 'Unknown', r.counted]),
  };
}

module.exports = {
  recordGuestVisit,
  recordGuestSignup,
  playStreak,
  saveLongestStreak,
  recruitedCount,
  RECRUITER_AT,
  adminGrowthSummary,
};
