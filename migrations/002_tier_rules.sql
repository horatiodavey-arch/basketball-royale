-- Fill in promotion criteria (cumulative wins OR games played) and make the
-- stake ranges non-overlapping. All money in cents.
UPDATE tiers SET min_stake_cents = 1000, max_stake_cents = 1499, wins_to_promote = 10, games_to_promote = 20 WHERE name = 'starter';
UPDATE tiers SET min_stake_cents = 1500, max_stake_cents = 2499, wins_to_promote = 15, games_to_promote = 30 WHERE name = 'star';
UPDATE tiers SET min_stake_cents = 2500 WHERE name = 'superstar';
