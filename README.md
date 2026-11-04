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

## King of the Court

Record a game at a park/court, and the app tallies season points (win = 3,
game = 1, court hour = 1), crown levels, and park "kings" on the `/board`
leaderboard. Seasons are fixed 30-day windows; check-ins and the next-line
queue have tables (`check_ins`, `next_line`, `next_line_members`) but no
screens yet — that's step 2.

New tables are created with `CREATE TABLE IF NOT EXISTS` on every boot, so an
existing database picks them up automatically — no `npm run db:reset` needed.

## Deploying on Railway

- Mount a persistent volume at `/data`.
- Set `DATA_DIR=/data` so the SQLite file lives on the volume instead of the
  repo (the app creates the folder if it doesn't exist).
- Set `SESSION_SECRET` to a fixed random string, so sessions survive restarts
  and deploys instead of invalidating every time the random fallback changes.
