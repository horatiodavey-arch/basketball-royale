// The court sheet's progress tracker, like a package delivery tracker:
//   I'm coming → Checked in → Got next → On the court
// Worked out from the player's real state every time the sheet loads, so it
// always agrees with the orange button (which is the next step).
const { db } = require('./index');
const q = require('./queries');
const line = require('./line');

const STEPS = ['coming', 'here', 'next', 'court'];
const PAYOFF_MINUTES = 10;
const LIVE_AFTER_MINUTES = 180; // a run counts as on until 3 hours after its start

// Said "I'm coming" to a run at this park that hasn't ended or been cancelled.
function isComing(playerId, parkId) {
  const parkLevel = db
    .prepare("SELECT 1 FROM park_coming WHERE player_id = ? AND park_id = ? AND created_at >= datetime('now', '-3 hours')")
    .get(playerId, parkId);
  if (parkLevel) return true;
  return !!db
    .prepare(
      `SELECT 1 FROM run_rsvps rr JOIN runs r ON r.id = rr.run_id JOIN courts c ON c.id = r.court_id
       WHERE rr.player_id = ? AND c.park_id = ? AND r.cancelled_at IS NULL
         AND datetime(r.scheduled_at, '+${LIVE_AFTER_MINUTES} minutes') >= ?`
    )
    .get(playerId, parkId, q.appNowSql());
}

// On a roster in a game on at this park.
function onCourt(playerId, parkId) {
  return !!db
    .prepare(
      `SELECT 1 FROM live_game_players lgp JOIN live_games lg ON lg.id = lgp.live_game_id
       WHERE lgp.player_id = ? AND lg.park_id = ? AND lgp.time_off IS NULL AND lg.status IN ('countdown', 'in_progress')`
    )
    .get(playerId, parkId);
}

// The player's game here that locked in the last few minutes: the payoff.
// Points shown are the win/play points ("+3 toward your crown" or "+1 for playing").
function recentPayoff(playerId, parkId) {
  const r = db
    .prepare(
      `SELECT result, date FROM game_results WHERE player_id = ? AND park_id = ?
         AND date >= datetime('now', '-${PAYOFF_MINUTES} minutes')
       ORDER BY date DESC, game_id DESC LIMIT 1`
    )
    .get(playerId, parkId);
  if (!r) return null;
  return r.result === 'win' ? '+3 pts toward your crown' : '+1 pt for playing';
}

const gamesAhead = (n) => (n <= 1 ? 'You play the next game.' : n === 2 ? 'One game ahead of you.' : `${n - 1} games ahead of you.`);

// { steps: [{key,label,state:'done'|'current'|'todo'|'skipped'}], message, payoff, guest }
function progressFor({ playerId, parkId, courtId, isGuest, checkedIn }) {
  const labels = { coming: "I'm coming", here: 'Checked in', next: 'Got next', court: 'On the court' };
  const build = (reached, skippedComing) =>
    STEPS.map((key, i) => ({
      key,
      label: key === 'next' && reached.inLine ? `#${reached.inLine} in line` : labels[key],
      state: skippedComing && key === 'coming' ? 'skipped' : i < reached.index ? 'done' : i === reached.index ? 'current' : 'todo',
    }));

  if (isGuest || !playerId) {
    return { guest: true, steps: STEPS.map((key) => ({ key, label: labels[key], state: 'todo' })), message: 'Sign up to get on the court.', payoff: null };
  }
  const coming = isComing(playerId, parkId);
  if (onCourt(playerId, parkId)) {
    return { steps: build({ index: 3 }, !coming), message: "You're on the court. Good luck.", payoff: null };
  }
  const mine = line.lineView(courtId, playerId).mine;
  if (mine) {
    return {
      steps: build({ index: 2, inLine: mine.number }, !coming),
      message: `You're #${mine.number} in line. ${gamesAhead(mine.number)}`,
      payoff: null,
    };
  }
  if (checkedIn) {
    // Just played: the payoff, then back to Checked in for the next game.
    const payoff = recentPayoff(playerId, parkId);
    return {
      steps: build({ index: 1 }, !coming),
      message: payoff ? 'Back to checked in. Tap I got next for another game.' : "You're checked in. Tap I got next to get in line.",
      payoff,
    };
  }
  const nearMsg = (lead) => `${lead} Tap Check in, or you'll be checked in after 2 minutes here.`;
  if (coming) {
    return {
      steps: build({ index: 0 }),
      message: "You're coming. Check in when you get to the court.",
      nearMessage: nearMsg('You made it.'),
      payoff: null,
    };
  }
  return {
    steps: STEPS.map((key) => ({ key, label: labels[key], state: 'todo' })),
    message: "On your way? Tap I'm coming so the court knows.",
    nearMessage: nearMsg("You're here."),
    payoff: null,
  };
}

module.exports = { progressFor, isComing };
