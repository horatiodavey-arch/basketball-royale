import { transaction } from './db.js';

// Pure money math. All values are integer cents.
//   pot        = stake * players
//   rake       = floor(pot * rake% / 100)
//   per_winner = floor((pot - rake) / winners)
// Any leftover cents that don't split evenly stay with the house (houseCents).
export function computePayouts({ stakeCents, playerCount, winnerCount, rakePercent }) {
  for (const [k, v] of Object.entries({ stakeCents, playerCount, winnerCount, rakePercent })) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`${k} must be a non-negative integer`);
  }
  if (winnerCount < 1 || winnerCount >= playerCount) {
    throw new Error('need at least one winner and at least one loser');
  }
  const pot = stakeCents * playerCount;
  const rake = Math.floor((pot * rakePercent) / 100);
  const perWinner = Math.floor((pot - rake) / winnerCount);
  const houseCents = pot - perWinner * winnerCount; // rake + rounding remainder
  return { pot, rake, perWinner, houseCents };
}

// Returns the tier a player should be promoted to, or null.
// A tier with NULL criteria (starter and up for now) never promotes.
export function promotionTarget(db, player) {
  const tier = db.prepare('SELECT * FROM tiers WHERE name = ?').get(player.tier);
  const byWins = tier.wins_to_promote != null && player.wins >= tier.wins_to_promote;
  const byGames = tier.games_to_promote != null && player.games_played >= tier.games_to_promote;
  if (!byWins && !byGames) return null;
  const next = db.prepare('SELECT name FROM tiers WHERE rank = ?').get(tier.rank + 1);
  return next ? next.name : null;
}

// Settles a game. Runs once: the game must be in 'pending_confirm' (or
// 'contested', when an admin has picked the winner) and ends 'locked'.
// By default both teams must have confirmed; pass requireConfirmations: false
// when the confirm window lapsed unchallenged or an admin resolved a dispute.
// Entry fees were already written when the game started (see games.startGame).
// Promotion credit is the free entry at the new tier: that tier's minimum stake.
export function settleGame(db, gameId, now = new Date(), { requireConfirmations = true } = {}) {
  return transaction(db, () => {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) throw new Error(`game ${gameId} not found`);
    if (game.status !== 'pending_confirm' && game.status !== 'contested') {
      throw new Error(`game ${gameId} is '${game.status}', expected 'pending_confirm'`);
    }
    if (requireConfirmations && (!game.confirmed_by_a || !game.confirmed_by_b)) {
      throw new Error(`game ${gameId} needs confirmation from both teams`);
    }

    const lobby = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(game.lobby_id);
    const tier = db.prepare('SELECT * FROM tiers WHERE name = ?').get(lobby.tier);
    const roster = db.prepare('SELECT player_id, team FROM game_players WHERE game_id = ?').all(gameId);
    const winnerTeam = game.winner;
    const winners = roster.filter((r) => r.team === winnerTeam);

    const money = computePayouts({
      stakeCents: lobby.stake_cents,
      playerCount: roster.length,
      winnerCount: winners.length,
      rakePercent: tier.rake_percent,
    });

    const addLedger = db.prepare(
      'INSERT INTO ledger (player_id, game_id, type, amount_cents) VALUES (?, ?, ?, ?)');
    const bump = db.prepare(
      'UPDATE players SET wins = wins + ?, losses = losses + ?, games_played = games_played + 1 WHERE id = ?');
    const getPlayer = db.prepare('SELECT * FROM players WHERE id = ?');
    const promote = db.prepare('UPDATE players SET tier = ?, promoted_at = ? WHERE id = ?');

    const promotions = [];
    for (const { player_id, team } of roster) {
      const won = team === winnerTeam;
      if (won) addLedger.run(player_id, gameId, 'payout', money.perWinner);
      bump.run(won ? 1 : 0, won ? 0 : 1, player_id);

      const target = promotionTarget(db, getPlayer.get(player_id));
      if (target) {
        promote.run(target, now.toISOString(), player_id);
        const credit = db.prepare('SELECT min_stake_cents FROM tiers WHERE name = ?').get(target);
        addLedger.run(player_id, gameId, 'promo_credit', credit.min_stake_cents);
        promotions.push({ playerId: player_id, to: target });
      }
    }

    db.prepare("UPDATE games SET status = 'locked', locked_at = ? WHERE id = ?")
      .run(now.toISOString(), gameId);
    return { ...money, promotions };
  });
}
