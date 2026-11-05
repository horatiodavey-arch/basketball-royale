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
- **`/lobbies`** reads real data: record, tier badge, promotion progress
  (from `tiers.wins_to_promote` / `games_to_promote`), open lobbies at the
  player's tier, and the ladder of locked tiers. (The home screen itself is
  now the King of the Court map — see below.)
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
  park's `check_in_radius_meters` (default 250m). Once in, a heartbeat
  reports your position every 60 seconds; as long as it's within the park's
  (wider) `leave_radius_meters` (default 400m) you stay "inside" — step
  outside that for 5+ minutes and you drop out of your squad (and lose your
  spot as captain, if you were one). Both radii are editable per park from
  the court screen's "Game settings".
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

## Home screen (the map)

`/` is now the King of the Court map, not the old lobby list. It leads with
the player's own standing (crown level or "No crown yet", season points, and
either "X pts to \<next level\>" or a note that they've already got the top
crown), then a real, interactive map — [Leaflet](https://leafletjs.com/) +
[CARTO](https://carto.com/basemaps) light tiles, no API key — with one
custom pin per park (the king's crown color, the active-now count with a
green/gray dot, and the king's name) plus a "You" marker at the player's own
location. It starts zoomed to the player's location if they share it
(falling back to a fixed Fort Lauderdale center otherwise, rather than
fitting the seeded parks in view), can be freely panned and zoomed, and
draws a faint circle around the selected park showing its check-in radius.
Tapping a pin selects that park (`/?park=ID`) and shows its bottom sheet:
King of the Court card, who's "Here now" (with their own crowns and
points), how far the viewer is from that park's crown (or that they
already hold it), and Check in / I got next buttons wired straight into
the existing check-in and next-line flow.

The Leaflet *library* is vendored into `public/vendor/leaflet/` (served by
this app, not pulled from a CDN at runtime), so it isn't a point of failure
in network-restricted environments. The tile *imagery* itself still loads
live from CARTO's `basemaps.cartocdn.com` and needs normal outbound
internet access — in a sandboxed/offline environment the map renders and is
fully interactive, just without street imagery (a plain background
instead). CARTO's tiles replaced a direct `tile.openstreetmap.org` embed,
whose usage policy blocks unregistered/automated hotlinking (403s) — CARTO
is a free, no-API-key basemap CDN built for exactly this. `/how-it-works`
(linked from the top of the map) holds the point breakdown, crown levels,
and the Crown Perks checklist that used to have no home of their own;
`/profile` keeps its own personalized copy of the perks. The old
lobby/tier-ladder screen moved to `/lobbies`, linked from the bottom of
`/runs`.

**Known simplification**: selecting a different pin does a full page
navigation (consistent with the rest of this server-rendered app), so the
map's pan/zoom position resets to the new park's view rather than staying
put — a minor rough edge, not a live client-side map update.

## Timer tracking

`/admin/timer` (linked from `/runs`, organizers only) lists every court
across every park with its live between-games status at a glance — idle, a
game in progress, or a countdown with a live ticking "M:SS" clock to the
next game. Each court also shows its configured "Time between games" in
minutes, which is how organizers set it from the court screen's "Game
settings" (stored as seconds internally, converted at the form boundary).

## Organizers & click tracking

`players.is_organizer` gates two pages, both linked from `/runs` only when
the signed-in player is an organizer, and redirecting to `/runs` for anyone
else who hits the URL directly:

- `/admin/timer` — the between-games timer board above.
- `/admin/stats` — total taps, unique players, and an average taps/day rate
  for each of five tracked taps: Check in, I got next, View lobbies, How it
  works, and tapping a player from the leaderboard. Every tap writes one row
  to the `events` table (`player_id`, `event_name`, `page`, `created_at`);
  `/admin/stats` aggregates it live, nothing is pre-computed.

To make an account an organizer, set `ORGANIZER_PHONES` to a comma-separated
list of phone numbers (matching how that player signs in). It's applied both
at boot (covering a phone added to the list after that account already
exists) and on every signup/login (covering a fresh account created after
the list is set) — so there's no manual DB edit needed either way.

## Deploying on Railway

- Mount a persistent volume at `/data`.
- Set `DATA_DIR=/data` so the SQLite file lives on the volume instead of the
  repo (the app creates the folder if it doesn't exist).
- Set `SESSION_SECRET` to a fixed random string, so sessions survive restarts
  and deploys instead of invalidating every time the random fallback changes.
- Set `ORGANIZER_PHONES` to your own phone number (and any other organizers',
  comma-separated) so those accounts can see `/admin/timer` and `/admin/stats`.
