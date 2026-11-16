// Park milestones: when a park reaches 20 unique players who have checked in
// there, the admin dashboard shows a banner and the organizer accounts with
// notifications on get a push. Each park is announced once.
// Counts successful check-ins from when this shipped on. Test accounts are not counted.
const { db, runOnce } = require('./index');
const { notTestSql, getParkById } = require('./queries');

const MILESTONE_PLAYERS = 20;

// Called on a successful check-in.
function recordVisit(playerId, parkId) {
  db.prepare('INSERT OR IGNORE INTO park_visitors (park_id, player_id) VALUES (?, ?)').run(parkId, playerId);
}

function visitorCount(parkId) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM park_visitors WHERE park_id = ? AND ${notTestSql('player_id')}`)
    .get(parkId).n;
}

// Returns the park when this call is the one that reached the milestone, else null.
function reachMilestone(parkId) {
  if (db.prepare('SELECT 1 FROM park_milestones WHERE park_id = ?').get(parkId)) return null;
  if (visitorCount(parkId) < MILESTONE_PLAYERS) return null;
  db.prepare("INSERT INTO park_milestones (park_id, reached_at) VALUES (?, datetime('now'))").run(parkId);
  return getParkById(parkId);
}

function markPushed(parkId) {
  db.prepare("UPDATE park_milestones SET pushed_at = datetime('now') WHERE park_id = ?").run(parkId);
}

// Parks that reached the milestone, newest first, for the admin banner.
function reachedMilestones() {
  return db
    .prepare(
      `SELECT p.id, p.name, p.city, m.reached_at
       FROM park_milestones m JOIN parks p ON p.id = m.park_id
       ORDER BY m.reached_at DESC`
    )
    .all();
}

// One time, when this ships: fill the visitor table from the check-ins that
// exist now, and mark parks already at the milestone as reached without a push,
// so nothing fires on deploy.
function backfillMilestones() {
  runOnce('park_milestones_backfill_v1', () => {
    db.exec(
      'INSERT OR IGNORE INTO park_visitors (park_id, player_id, first_at) SELECT park_id, player_id, time_in FROM check_ins'
    );
    const parks = db.prepare('SELECT id FROM parks').all();
    for (const { id } of parks) {
      if (visitorCount(id) >= MILESTONE_PLAYERS) {
        db.prepare(
          "INSERT OR IGNORE INTO park_milestones (park_id, reached_at, pushed_at) VALUES (?, datetime('now'), datetime('now'))"
        ).run(id);
      }
    }
  });
}

module.exports = {
  MILESTONE_PLAYERS,
  recordVisit,
  reachMilestone,
  markPushed,
  reachedMilestones,
  backfillMilestones,
};
