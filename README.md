# Basketball Royale

Sign up, see your home screen, and join a lobby. Cash stays physical at the
run — the app only records what's owed (the `ledger` table), never moves money.

## Stack

- Node.js (built-in `node:sqlite`, no native module to compile)
- Express + EJS (server-rendered, matches the mockup's phone-frame layout)
- SQLite, initialized straight from `db/schema.sql` on first run

## Run it

```
npm install
npm start
```

Visit `http://localhost:3000`. The database is created at
`db/basketball_royale.db` on first boot, seeded with the Sunday rookie lobby
and five demo players already "locked in" (matching the mockup's roster).

To wipe and reseed: `npm run db:reset`.

## How it maps to the schema

- **Sign up** creates a `users` row and a matching `players` row (tier
  defaults to `rookie`, per the schema).
- **Home screen** reads real data: record, tier badge, promotion progress
  (from `tiers.wins_to_promote` / `games_to_promote`), open lobbies at the
  player's tier, and the ladder of locked tiers.
- **Join a lobby**: the schema has no separate "lobby roster" table — a
  lobby's roster before teams are drafted is the `game_players` for its one
  `forming`-status game (auto-created per lobby). Joining inserts a
  `game_players` row (`team = 'unassigned'`, since teams aren't split yet)
  and a `ledger` row (`type = 'entry_fee'`, negative, `settled = 0`) — money
  owed, not money moved.

## Out of scope (not asked for yet)

Team drafting, score confirmation, the settlement function (payouts, win/loss
tallies, promotion), and the invite-link lobby-preview landing page are all
described in the schema/mockup but weren't part of this build — sign up,
view home, join a lobby.
