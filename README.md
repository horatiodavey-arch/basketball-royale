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
green/gray dot, and the king's name) plus a blue dot at the player's own
real location. It asks for that location on load, centers there and opens
the bottom sheet on the nearest park *with current activity* — checked-in
players or a live game — falling back to the nearest park overall if none
have any (and to a fixed Fort Lauderdale center plus a "Turn on location to
see courts near you." banner if location is denied). Before location
resolves, the server's own blind guess for which park to render first is
the same activity-aware pick, not a fixed park — see
[Runs](#runs-from-anywhere) below for why "anywhere" matters here. The map
can be freely panned and zoomed, and draws a faint circle around the
selected park showing its check-in radius. Every pin — and the bottom
sheet — shows the player's distance to it once their location is known
(e.g. "1.2 mi away"), and a pin with an upcoming run shows it too ("Sat
10am · 6 coming"). Tapping a pin selects that park (`/?park=ID`) and shows
its bottom sheet: King of the Court card, who's "Here now" (with their own
crowns and points), how far the viewer is from that park's crown (or that
they already hold it), and Check in / I got next buttons wired straight
into the existing check-in and next-line flow.

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

## Runs, from anywhere

Check-in, the next-line queue, and live games still require being
physically at the court — that's the geofenced part of this app and stays
that way. Everything else now works from anywhere, no location needed:

- **Start a run.** Tap a court (a real park's, or an OSM "Open court" pin —
  tapping Start a run there materializes the real park first, the same as
  an open-court check-in does) and pick a date/time plus an optional note.
  `GET /runs/new` renders the form, `POST /runs` creates it (`runs` table)
  and redirects to the run's own page.
- **Its own shareable link.** `GET /runs/:id` works for anyone, signed in
  or not — it shows the court, time, note, who's coming, and an "I'm
  coming" button. Signed out, that button becomes "Sign up to say you're
  coming" instead, carrying a `returnTo` back to the run (validated as a
  same-site relative path only, so it can't be turned into an open
  redirect) so finishing signup lands back on the run, not the home map.
- **"I'm coming."** `POST /runs/:id/coming` RSVPs (`run_rsvps`, one row
  per player per run). The run's own page, the court screen, the map's
  bottom sheet, and a court's map pin all show the count; the run's own
  page also shows initials for who's coming.
- **Follow a court.** `POST /courts/:courtId/follow` toggles it
  (`court_follows`); for an OSM-only court, `POST /open-courts/follow`
  materializes the park first, then follows (always follows, not a
  toggle — unfollowing happens from the now-real court's own screen).
  Followed courts show at the top of `/runs`, each with its current king
  and soonest upcoming run.
- **Invite friends.** A button on the map (shares the selected park) and
  on every run's own page (shares that run) — [Web Share
  API](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share)
  with a clipboard-copy fallback, the same pattern `/lobbies` already
  used for its own invite link.
- **Empty states.** `/runs` fetches `GET /api/nearby-runs?lat=&lng=`
  client-side once it has the player's location; with nothing nearby it
  shows "No runs near you yet. Start one and be the first King of
  \<nearest park\>." with a Start a run button pointed at that park.
  Outside a park's own check-in radius, its Check in button is replaced
  with "You're X mi away. Check in opens when you get to the court." plus
  I'm coming (if a run's already scheduled there) — computed client-side
  from the same geolocation the map already has, so there's no extra
  round trip just to learn you're too far away.

**Known simplification**: a run's time is stored as the organizer's own
local wall-clock text, not a timezone-aware instant — fine for this app's
single-area usage, not something that would hold up across timezones.

## Nearby courts, from OpenStreetMap

Once the player's location is known, the map also fetches real basketball
courts near them from OpenStreetMap's data (`leisure=pitch` +
`sport=basketball`, within 10 miles) via the free
[Overpass API](https://overpass-api.de/) — shown as lighter "Open court ·
No king yet" pins, distinct from this app's own parks. The lookup runs
server-side (`GET /api/nearby-courts`), not from the browser, so the
Overpass endpoint never sees a player's IP directly, and its response is
cached per ~0.1°×0.1° area (`overpass_cache`) for 7 days — a second player
loading the map from roughly the same area reuses that result instead of
triggering a fresh Overpass call. If Overpass is unreachable (as in this
sandbox, whose network policy blocks it — confirmed via a direct request;
it's reachable normally from Codespaces/Railway), the lookup just returns
no pins rather than failing the page.

Tapping an "Open court" pin and checking in creates a real park for it on
the spot — name, location, the standard default radii, and a "Main"
court — keyed to the OSM court's id so a second player's first check-in
there reuses that same park instead of creating a duplicate. From then on
it's a park like any other, with its own leaderboard and king.

## Suggest a court

The "+ Suggest a court" button on the map lets a player drop a pin
anywhere and name it — for a real court that isn't on OpenStreetMap yet.
That goes to `court_suggestions` as `pending` and shows up on
`/admin/courts` (organizer-only, linked from `/runs`) for an organizer to
approve or reject. Approving creates a real park the same way an Overpass
check-in does, and that park's court screen then shows "Court added by
\<player name\>" so the credit sticks.

## Timer tracking

`/admin/timer` (linked from `/runs`, organizers only) lists every court
across every park with its live between-games status at a glance — idle, a
game in progress, or a countdown with a live ticking "M:SS" clock to the
next game. Each court also shows its configured "Time between games" in
minutes, which is how organizers set it from the court screen's "Game
settings" (stored as seconds internally, converted at the form boundary).

## Organizers & click tracking

`players.is_organizer` gates three pages, all linked from `/runs` only when
the signed-in player is an organizer, and redirecting to `/runs` for anyone
else who hits the URL directly:

- `/admin/timer` — the between-games timer board above.
- `/admin/stats` — total taps, unique players, and an average taps/day rate
  for each of five tracked taps: Check in, I got next, View lobbies, How it
  works, and tapping a player from the leaderboard. Every tap writes one row
  to the `events` table (`player_id`, `event_name`, `page`, `created_at`);
  `/admin/stats` aggregates it live, nothing is pre-computed.
- `/admin/courts` — pending player-suggested courts (see above) to approve
  or reject.

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
  comma-separated) so those accounts can see `/admin/timer`, `/admin/stats`,
  and `/admin/courts`.
- No extra config needed for nearby courts — Railway's normal outbound
  internet access reaches the Overpass API and CARTO's tiles fine; both
  are blocked only by this dev sandbox's own network policy.
