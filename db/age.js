// Age safety: birth year at sign-up, teen protection, "Show me on the map".
//
// Only the birth year is stored, so a player's exact age isn't known. When
// unsure, the app protects: anyone who could still be 17 gets teen protection
// (this year minus birth year is 18 or less). Sign-up is blocked when the
// player turns 12 or younger this year.
const { db, getMeta, setMeta } = require('./index');

const MIN_AGE = 13;
const TEEN_UNTIL = 18; // this year minus birth year; 18 may still be 17
const VISIBILITY = ['everyone', 'followers', 'nobody'];
const TEEN_VISIBILITY = ['followers', 'nobody'];

const thisYear = () => new Date().getFullYear();
const ageThisYear = (birthYear) => thisYear() - Number(birthYear);

// SQL for "this user (alias u) is a teen". Users with no birth year yet are
// asked before they can use the app, so they aren't treated as teens here.
const TEEN_SQL = `(u.birth_year IS NOT NULL AND CAST(strftime('%Y', 'now') AS INTEGER) - u.birth_year <= ${TEEN_UNTIL})`;
// Shown only as a count to others: teens, and adults who chose followers or nobody.
const PRIVATE_SQL = `(${TEEN_SQL} OR COALESCE(u.map_visibility, 'everyone') != 'everyone')`;

// The years the picker offers: up to 100 years back. Years that would block
// are still offered, so the picker doesn't give away the cut-off.
function yearOptions() {
  const y = thisYear();
  return Array.from({ length: 101 }, (_, i) => y - i);
}

function parseBirthYear(value) {
  const y = Number(value);
  if (!Number.isInteger(y) || y > thisYear() || y < thisYear() - 100) return null;
  return y;
}

const isUnder13 = (birthYear) => ageThisYear(birthYear) < MIN_AGE;
const isTeenYear = (birthYear) => birthYear != null && !isUnder13(birthYear) && ageThisYear(birthYear) <= TEEN_UNTIL;

// A blocked sign-up is counted and nothing else is kept.
function countBlockedSignup() {
  setMeta('signups_blocked_under13', Number(getMeta('signups_blocked_under13') || 0) + 1);
}

function setBirthYear(userId, birthYear) {
  db.prepare('UPDATE users SET birth_year = ? WHERE id = ?').run(birthYear, userId);
}

// An existing account whose owner says they're under 13: wipe the name and
// phone so nothing identifying is kept, and keep it off every list. Game
// results stay so other players' points don't change.
function blockExistingUnder13(userId) {
  db.prepare(
    "UPDATE users SET name = 'Removed player', phone = NULL, birth_year = NULL, blocked_under13 = 1, map_visibility = 'nobody' WHERE id = ?"
  ).run(userId);
  db.prepare('UPDATE players SET hide_presence = 1 WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM check_ins WHERE player_id IN (SELECT id FROM players WHERE user_id = ?)').run(userId);
  db.prepare('DELETE FROM run_rsvps WHERE player_id IN (SELECT id FROM players WHERE user_id = ?)').run(userId);
  db.prepare('DELETE FROM push_subscriptions WHERE player_id IN (SELECT id FROM players WHERE user_id = ?)').run(userId);
  countBlockedSignup();
}

function needsBirthYear(userId) {
  const u = db.prepare('SELECT birth_year, blocked_under13 FROM users WHERE id = ?').get(userId);
  return !!u && !u.blocked_under13 && u.birth_year == null;
}

function isTeenUser(userId) {
  const u = db.prepare('SELECT birth_year FROM users WHERE id = ?').get(userId);
  return !!u && isTeenYear(u.birth_year);
}

function isTeenPlayer(playerId) {
  const u = db.prepare('SELECT u.birth_year FROM players p JOIN users u ON u.id = p.user_id WHERE p.id = ?').get(playerId);
  return !!u && isTeenYear(u.birth_year);
}

// The setting as it applies now: teens can never be "everyone".
function mapVisibility(userId) {
  const u = db.prepare('SELECT birth_year, map_visibility FROM users WHERE id = ?').get(userId);
  if (!u) return 'everyone';
  const teen = isTeenYear(u.birth_year);
  const allowed = teen ? TEEN_VISIBILITY : VISIBILITY;
  if (allowed.includes(u.map_visibility)) return u.map_visibility;
  return teen ? 'followers' : 'everyone';
}

function setMapVisibility(userId, value) {
  const allowed = isTeenUser(userId) ? TEEN_VISIBILITY : VISIBILITY;
  if (!allowed.includes(value)) return false;
  db.prepare('UPDATE users SET map_visibility = ? WHERE id = ?').run(value, userId);
  return true;
}

// Display names ("Name #1234") of every teen. Used to mask names shown next to
// a court (game rosters, the line, the king). The viewer's own name is kept.
function teenDisplayNames({ exceptUserId = null, exceptPlayerId = null } = {}) {
  return new Set(
    db
      .prepare(
        `SELECT u.name || ' #' || u.tag AS name FROM users u
         WHERE ${TEEN_SQL} AND u.id IS NOT ? AND u.id NOT IN (SELECT user_id FROM players WHERE id IS ?)`
      )
      .all(exceptUserId, exceptPlayerId)
      .map((r) => r.name)
  );
}

// /admin: totals only, never anyone's birth year.
function adminAgeCounts() {
  const row = db
    .prepare(
      `SELECT SUM(${TEEN_SQL}) AS teens,
              SUM(u.birth_year IS NOT NULL AND NOT ${TEEN_SQL}) AS adults,
              SUM(u.birth_year IS NULL AND u.blocked_under13 = 0) AS unknown
       FROM users u WHERE u.name NOT GLOB 'TEST*'`
    )
    .get();
  return {
    blocked: Number(getMeta('signups_blocked_under13') || 0),
    teens: row.teens || 0,
    adults: row.adults || 0,
    unknown: row.unknown || 0,
  };
}

module.exports = {
  TEEN_SQL,
  PRIVATE_SQL,
  VISIBILITY,
  TEEN_VISIBILITY,
  yearOptions,
  parseBirthYear,
  isUnder13,
  isTeenYear,
  countBlockedSignup,
  setBirthYear,
  blockExistingUnder13,
  needsBirthYear,
  isTeenUser,
  isTeenPlayer,
  mapVisibility,
  setMapVisibility,
  teenDisplayNames,
  adminAgeCounts,
};
