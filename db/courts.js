// Courts players can't use, and each player's home court.
const { db } = require('./index');
const { getCheckedInPlayers, notTestSql, presentSql } = require('./queries');

const REASONS = ['private', 'locked', 'school'];
const HIDE_AT_REPORTS = 3;
const SCHOOL_WORDS = /\b(school|elementary|middle|high|academy|prep|college|university)\b/i;

// "Can't play here". One report per player per court. At 3 different players
// (counted since the owner last un-hid it), the court is hidden for review.
function reportCourt(parkId, playerId, reason) {
  if (!REASONS.includes(reason)) return { ok: false, error: 'Pick private, locked or school.' };
  const park = db.prepare('SELECT id, hidden, reports_cleared_at FROM parks WHERE id = ?').get(parkId);
  if (!park) return { ok: false, error: 'Court not found.' };
  db.prepare(
    `INSERT INTO court_reports (park_id, player_id, reason) VALUES (?, ?, ?)
     ON CONFLICT (park_id, player_id) DO UPDATE SET reason = excluded.reason, created_at = datetime('now')`
  ).run(parkId, playerId, reason);
  const reports = openReportCount(parkId, park.reports_cleared_at);
  let hidden = !!park.hidden;
  if (!hidden && reports >= HIDE_AT_REPORTS) {
    db.prepare('UPDATE parks SET hidden = 1 WHERE id = ?').run(parkId);
    hidden = true;
  }
  return { ok: true, reports, hidden };
}

function openReportCount(parkId, clearedAt) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM court_reports WHERE park_id = ? AND (? IS NULL OR created_at > ?)')
    .get(parkId, clearedAt || null, clearedAt || null).n;
}

// The owner hides or un-hides a court. Un-hiding clears the reports so far,
// so the same reports don't hide it again straight away.
function setCourtHidden(parkId, hidden) {
  if (hidden) db.prepare('UPDATE parks SET hidden = 1 WHERE id = ?').run(parkId);
  else db.prepare("UPDATE parks SET hidden = 0, reports_cleared_at = datetime('now') WHERE id = ?").run(parkId);
}

// Courts a new player can pick as home: on the map, with a location, never a
// school. The phone works out which are nearest, so no location is sent here.
function homeCourtCandidates() {
  const presentParks = new Set(
    db.prepare(`SELECT DISTINCT ci.park_id AS id FROM check_ins ci WHERE ${presentSql('ci')}`).all().map((r) => r.id)
  );
  const liveParks = new Set(
    db
      .prepare(
        `SELECT DISTINCT c.park_id AS id FROM live_games lg JOIN courts c ON c.id = lg.court_id WHERE lg.status = 'in_progress'`
      )
      .all()
      .map((r) => r.id)
  );
  return db
    .prepare('SELECT id, name, city, lat, lng, is_indoor FROM parks WHERE hidden = 0 AND lat IS NOT NULL AND lng IS NOT NULL')
    .all()
    .filter((p) => !SCHOOL_WORDS.test(p.name))
    .map((p) => {
      const here = presentParks.has(p.id) ? getCheckedInPlayers(p.id).filter((x) => !x.hidden).length : 0;
      const status = liveParks.has(p.id) && here > 0 ? 'Live run' : here > 0 ? `${here} checked in` : 'Nobody here yet';
      return { id: p.id, name: p.name, city: p.city, lat: p.lat, lng: p.lng, isIndoor: !!p.is_indoor, status };
    });
}

function setHomeCourt(userId, parkId) {
  const park = db.prepare('SELECT id FROM parks WHERE id = ? AND hidden = 0').get(parkId);
  if (!park) return { ok: false, error: 'That court is not available.' };
  db.prepare("UPDATE users SET home_court_id = ?, home_court_step = 'done' WHERE id = ?").run(parkId, userId);
  return { ok: true };
}

const SKIP_WAIT_DAYS = 7;

// Should this player be shown "Pick your home court" now? Anyone without a
// home court is asked. One skip waits 7 days; after a second skip, never again
// (unless they open it themselves from their profile).
function homeCourtDue(userId) {
  const u = db
    .prepare('SELECT home_court_id, home_court_step, home_court_skips, home_court_skipped_at FROM users WHERE id = ?')
    .get(userId);
  if (!u || u.home_court_id || u.home_court_step === 'never') return false;
  if (!u.home_court_skips) return true;
  if (u.home_court_skips === 1 && u.home_court_skipped_at) {
    return db.prepare(`SELECT ? <= datetime('now', '-${SKIP_WAIT_DAYS} days') AS due`).get(u.home_court_skipped_at).due === 1;
  }
  return false;
}

// Skip (or "I don't hoop at any of these"): counts toward the two asks.
function skipHomeCourt(userId) {
  db.prepare(
    `UPDATE users SET home_court_skips = home_court_skips + 1, home_court_skipped_at = datetime('now'),
       home_court_step = CASE WHEN home_court_skips + 1 >= 2 THEN 'never' ELSE 'done' END
     WHERE id = ?`
  ).run(userId);
}

const MAP_FILTERS = ['all', 'outdoor', 'indoor'];
function getMapFilter(userId) {
  const row = db.prepare('SELECT map_filter FROM users WHERE id = ?').get(userId);
  return row && MAP_FILTERS.includes(row.map_filter) ? row.map_filter : 'all';
}
function setMapFilter(userId, filter) {
  if (!MAP_FILTERS.includes(filter)) return false;
  db.prepare('UPDATE users SET map_filter = ? WHERE id = ?').run(filter, userId);
  return true;
}

function markHomeCourtPending(userId) {
  db.prepare("UPDATE users SET home_court_step = 'pending' WHERE id = ?").run(userId);
}

function finishHomeCourtStep(userId) {
  db.prepare("UPDATE users SET home_court_step = 'done' WHERE id = ? AND home_court_step = 'pending'").run(userId);
}

function homeCourtStepPending(userId) {
  const row = db.prepare('SELECT home_court_step FROM users WHERE id = ?').get(userId);
  return !!row && row.home_court_step === 'pending';
}

function homeCourtFor(userId) {
  return (
    db
      .prepare('SELECT p.id, p.name, p.city FROM users u JOIN parks p ON p.id = u.home_court_id WHERE u.id = ?')
      .get(userId) || null
  );
}

// /admin: home court picks per court, the home-court step's taps, and reports.
function adminCourtsSummary() {
  const events = (name) =>
    db.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_name = ? AND ${notTestSql('player_id')}`).get(name).n;
  const picks = db
    .prepare(
      `SELECT p.id, p.name, p.city, COUNT(*) AS players
       FROM users u JOIN players pl ON pl.user_id = u.id JOIN parks p ON p.id = u.home_court_id
       WHERE u.name NOT GLOB 'TEST*'
       GROUP BY p.id ORDER BY players DESC, p.name LIMIT 50`
    )
    .all();
  const reported = db
    .prepare(
      `SELECT p.id, p.name, p.city, p.hidden, p.source, p.reports_cleared_at,
              COUNT(r.id) AS reports,
              SUM(r.reason = 'private') AS private, SUM(r.reason = 'locked') AS locked, SUM(r.reason = 'school') AS school
       FROM parks p LEFT JOIN court_reports r ON r.park_id = p.id AND (p.reports_cleared_at IS NULL OR r.created_at > p.reports_cleared_at)
       GROUP BY p.id
       HAVING reports > 0 OR p.hidden = 1
       ORDER BY p.hidden DESC, reports DESC, p.name`
    )
    .all();
  return {
    big: [
      { label: 'Home courts picked', value: events('home_court_pick') },
      { label: '"I don\'t hoop at any of these"', value: events('home_court_none') },
      { label: 'Home court skipped', value: events('home_court_skip') },
      { label: '"Can\'t play here" reports', value: events('court_report') },
    ],
    picks,
    reported,
    hiddenCount: db.prepare('SELECT COUNT(*) AS n FROM parks WHERE hidden = 1').get().n,
    importedCount: db.prepare("SELECT COUNT(*) AS n FROM parks WHERE source = 'osm'").get().n,
  };
}

module.exports = {
  REASONS,
  reportCourt,
  setCourtHidden,
  homeCourtCandidates,
  setHomeCourt,
  finishHomeCourtStep,
  homeCourtDue,
  skipHomeCourt,
  getMapFilter,
  setMapFilter,
  markHomeCourtPending,
  homeCourtStepPending,
  homeCourtFor,
  adminCourtsSummary,
};
