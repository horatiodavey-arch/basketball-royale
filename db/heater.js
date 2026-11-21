// "On a Heater": a live tag for win streaks. Nothing is saved and nothing is
// awarded: it's worked out from confirmed results (game_results is only
// written once a result is confirmed) each time a page asks, so it updates on
// every win and disappears the moment a streak ends. No points involved.
const { db } = require('./index');

// Confirmed games on a court today, newest first, each with its winners and losers.
function confirmedCourtGames(courtId, sinceSql) {
  const rows = db
    .prepare(
      `SELECT game_id AS gameId, player_id AS playerId, result, date
       FROM game_results WHERE court_id = ? AND date >= ?
       ORDER BY date DESC, game_id DESC`
    )
    .all(courtId, sinceSql);
  const games = new Map();
  for (const r of rows) {
    if (!games.has(r.gameId)) games.set(r.gameId, { gameId: r.gameId, winners: new Set(), losers: new Set() });
    games.get(r.gameId)[r.result === 'win' ? 'winners' : 'losers'].add(r.playerId);
  }
  return [...games.values()];
}

// More than half of the newer roster was on the earlier winning roster
// (3 of 5, 2 of 3, 2 of 2, 1 of 1).
function keepsCore(newRoster, lastWinners) {
  const ids = [...newRoster];
  if (ids.length === 0) return false;
  return ids.filter((id) => lastWinners.has(id)).length * 2 > ids.length;
}

// The streak of the team that won the last confirmed game on this court:
// how many games in a row that team (its core) has won here today.
function courtStreak(courtId, sinceSql) {
  const games = confirmedCourtGames(courtId, sinceSql);
  if (games.length === 0 || games[0].winners.size === 0) return null;
  let count = 1;
  for (let i = 1; i < games.length; i++) {
    if (!keepsCore(games[i - 1].winners, games[i].winners)) break;
    count++;
  }
  return { count, roster: games[0].winners };
}

function teamLabel(count) {
  if (!count) return null;
  if (count === 1) return 'Streak started';
  if (count === 2) return 'On a Heater · 2 straight';
  return `🔥 On a Heater · ${count} straight`;
}

// For a court page: which team in the live game carries the streak, if any.
// teams = { a: [playerIds], b: [playerIds] }. With a game on and neither team
// keeping the core, the streak is over and nothing shows.
function courtHeater(courtId, sinceSql, teams = null) {
  const streak = courtStreak(courtId, sinceSql);
  if (!streak) return null;
  const label = teamLabel(streak.count);
  if (!teams) return { count: streak.count, label, team: null };
  const team = ['a', 'b'].find((t) => keepsCore(new Set(teams[t] || []), streak.roster)) || null;
  if (!team) return null;
  return { count: streak.count, label, team };
}

// A player's confirmed wins in a row this season (a loss resets it).
function playerStreak(playerId, sinceSql) {
  const rows = db
    .prepare('SELECT result FROM game_results WHERE player_id = ? AND date >= ? ORDER BY date DESC, game_id DESC LIMIT 200')
    .all(playerId, sinceSql);
  let n = 0;
  for (const r of rows) {
    if (r.result !== 'win') break;
    n++;
  }
  return n;
}

function playerLabel(n) {
  if (!n) return null;
  if (n === 1) return 'Streak started';
  if (n === 2) return 'On a Heater';
  return `🔥 ${n}`;
}

module.exports = { keepsCore, courtStreak, courtHeater, teamLabel, playerStreak, playerLabel };
