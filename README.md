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

Season points (win = 3, game = 1, court hour = 1), crown levels, and park
"kings" show up on the `/board` leaderboard. Seasons are fixed 30-day windows.

Games are no longer entered by hand. `/runs` lists the parks; open one to
check in and reach its court screen (Court 1 / Court 2 tabs, same as the
mockup):

- **Check in** uses the browser's location and only succeeds within the
  park's `check_in_radius_meters`. While the court screen is open, a
  heartbeat updates your `last_seen` every 60 seconds; if it goes stale for
  5+ minutes you drop out of your squad (and lose your spot as captain, if
  you were one).
- **"I got next"** makes you a squad captain in `next_line`; "Pick from
  who's here" adds up to 4 more from who's currently checked in. Once two
  squads are in line, they fill onto the court automatically — no typing
  names.
- **Live game**: a captain can mark a teammate "left" or add a sub from
  who's checked in. Each player's own time on/off court is tracked
  (`live_game_players`), which is where `game_results.minutes_played`
  comes from once the game locks.
- **Ending a game**: no score entry — a captain taps which team won, the
  other captain confirms, and the result locks: winners get a win, everyone
  gets a game played, minutes come from actual time on court. Winners stay
  on; the next team in line moves up after a between-games countdown
  (default 3 minutes, editable per park, same as the game target).
- If the next team isn't ready when the countdown hits zero, they drop to
  the back of the line and whoever's next moves up instead. If the winning
  squad's short players, their captain can pick up subs during the
  countdown.

New tables are created with `CREATE TABLE IF NOT EXISTS`, and new columns on
existing tables (like `parks.lat`/`lng`/`game_target`) are added with an
`ALTER TABLE` migration — both run automatically on every boot, so an
existing database picks them up with no `npm run db:reset` needed.

**Known simplification**: state changes (countdown expiring, a new squad
joining) show up via a 15-second auto-refresh and your own action redirects,
not a live push — fine for a single-court demo, worth revisiting for a real
multi-user deploy.

## Deploying on Railway

- Mount a persistent volume at `/data`.
- Set `DATA_DIR=/data` so the SQLite file lives on the volume instead of the
  repo (the app creates the folder if it doesn't exist).
- Set `SESSION_SECRET` to a fixed random string, so sessions survive restarts
  and deploys instead of invalidating every time the random fallback changes.
