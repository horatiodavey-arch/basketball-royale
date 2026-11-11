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

**Demo data is opt-in.** The demo players (Darius Reed and friends, phones
`5550000001`–`5550000005`), the demo "Sunday run" lobby, and their game
history are only created when `SEED_DEMO=true`. Without it, a fresh database
starts with just the two preset parks. An existing database that still has
the demo players loses them once, on the next boot without `SEED_DEMO=true`:
their game history, check-ins, runs and RSVPs, follows, queue and live-game
seats, and the demo lobby go too, while anything a real player did is kept
(`removeDemoData` in `db/index.js`, recorded in `app_meta` so it runs once).

## How it maps to the schema

- **Sign up** creates a `users` row and a matching `players` row (tier
  defaults to `rookie`, per the schema).
- **`/lobbies`** reads real data: record, tier badge, promotion progress
  (paid games played out of `tiers.games_to_promote`), open lobbies at the
  player's tier, and the ladder of locked tiers. (The home screen itself is
  now the King of the Court map — see below.) Each lobby links to a real
  `parks` row via `lobbies.park_id` — the card shows the park's name and
  "Get directions" opens a Google Maps directions link to the park's actual
  lat/lng (the old free-text `location` column is still there but unused for
  display). The demo "Sunday run" lobby is linked to Lauderdale Lakes
  Recreation.
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

## The two preset parks

The app ships with exactly two parks, both organizer-suggested:

- **Lauderdale Lakes Recreation** — 4331 NW 36th St, Lauderdale Lakes (Main
  and Side courts).
- **Sunrise Athletic Complex (SAC)** — 11501 NW 44th St, Sunrise (Court 1–4).
  Searching "SAC" on the Runs tab finds it (the search box matches name,
  city, and address).

Earlier versions seeded Lauderhill Parks & Recreation and Markham Park. On
every boot `consolidatePresetParks()` (`db/index.js`) folds any old copies
into the two above in one transaction — courts, games, check-ins, the
next-line queue, runs, follows, lobbies, and the demo Sunday run all move
with them, and the old park rows are deleted — so existing databases end up
identical to fresh ones and the leaderboard / Double Crown demo still work.
It does nothing once it has run, and leaves parks players created themselves
(from an OpenStreetMap pin or an approved suggestion) alone. A park's city
("Lauderdale Lakes", "Sunrise") shows next to its name wherever parks are
listed.

**Addresses to pins.** A park with an address but no coordinates (SAC, out of
the box) is looked up on the server with OpenStreetMap's
[Nominatim](https://nominatim.org/) geocoder (`db/geocode.js`) shortly after
the server starts. It sends an identifying `User-Agent` (override with
`GEOCODER_USER_AGENT`), makes at most one request a second, and caches every
answer in `geocode_cache`, so an address is only ever asked about once. If
Nominatim can't be reached the app starts and runs normally, retries a few
times, and the organizer can place the pin by hand. In the Organizer Courts
tab, typing an address (or tapping "Find on map") drops the pin there, and
you drag it onto the actual courts and Save.

## Park photos

Each park's page and bottom sheet has a small camera button that opens the
phone's camera (organizers get the photo picker instead). Only players
currently checked in at that park can add a photo; organizers can from
anywhere (`POST /parks/:id/photos`, enforced on the server, not just by
hiding the button).

Photos are resized to at most 1600px wide and re-encoded as JPEG with
[`sharp`](https://sharp.pixelplumbing.com/) — which also strips the phone's
embedded GPS and device metadata — then stored under `DATA_DIR/park-photos/`
(the persistent volume on Railway), with a row in `park_photos`. A new photo
is invisible to everyone but organizers and the person who took it until an
organizer approves it in the Organizer Courts tab; the first approved photo
becomes the park's cover, and "Set as cover" switches it. Rejecting a photo
deletes it. The cover shows at the top of the park page and as a thumbnail on
park cards in Runs; with none, it says "No photo yet. Be the first to add
one."

## Location accuracy

Every place the app reads the phone's location goes through `public/geo.js`:
`enableHighAccuracy: true`, a 10-second timeout, and a 15-second
`maximumAge`. Distances are straight-line and labeled so ("2.0 mi away
(straight line)" in the bottom sheet and on Runs cards, "~2 mi" on map
pins). On check-in, a position the phone itself says is worse than 100m
accurate shows "Getting a better GPS signal…" and takes one fresh reading
before the app decides the player is outside the radius (and a rough reading
never hides the Check in button as "too far"). Every Organizer tab shows a
"My location" line with your latitude, longitude, and accuracy, for telling a
misplaced pin apart from a weak signal.

## Game formats, captains, and per-format crowns

**Formats.** Creating a run means picking a format: 1v1, 2v2, 3v3, 4v4 or
5v5. It's stored on the run and becomes the court's format (`courts.format`),
so Runs shows e.g. "Main · 4v4 · Court is open". A court with no format
(`NULL`, all courts before this change) shows no label and keeps the old
rules: any two squads start a game, up to 5 a side.

**Rosters and captains.** A squad fills to exactly the format's size. Its
captain is whoever tapped "I got next", and the captain alone adds,
removes, confirms, or hands the role to a teammate (any roster or captain
change clears the confirmation). A game starts only when two squads are
both full and confirmed (`next_line.confirmed`). Result entry is unchanged.

**Crowns and trophies per format.** Each format keeps its own points (3 per
win, 1 per game, court hours as the tiebreaker), with the same crown levels.
Points restart every 30-day season, and again each time a player reaches
purple in that format, which earns a trophy tagged with that format
(`format_trophies`). Trophies never reset, and several in a month are
possible. Only results recorded with a format count toward these; legacy
results appear in the "All" board view only. The profile lists the crown and
trophy count per format, and the leaderboard has a format filter.

Migrations (additive, run on boot): `courts.format`, `live_games.format`,
`runs.format`, `game_results.format`, `next_line.confirmed`, and the new
`format_trophies` table. Nothing is dropped.

## Result entry, roster edits, and names

**Who can act on a game.** Only players on a game's active roster (not
subbed off) can submit or confirm a result, so a checked-in player who isn't
on the roster can't. A rostered player on either team submits "Our team
won". The other team confirms or disputes. No score is entered.

**Timing.** The other team has 20 minutes to answer. If nobody answers, the
result is voided automatically, and so is a disputed result. A result locks
only when both teams agree, and then the game is saved.

**Roster edits.** A captain can change only their own team's roster
(mark a player left, or add a sub), during play or while a result is
pending, but never after the result locks. Any change voids a pending
result, so the other team has to look at the roster again before confirming.
Every change is logged in `roster_edits` (who, what, which team, when) and
shown on the court screen.

**Names.** Every account has a unique 4-digit tag shown after its name (e.g.
"Big Sniper #4821"), assigned at signup and backfilled for existing accounts.
Players can change their display name on their own profile. The tag, phone
login, stats, crowns and trophies stay with the account. Names that match
Rookie, Starter, Star or Superstar (any case or spacing) are reserved.

Migrations (additive, run on boot): `users.tag` with a unique index
(backfilled once), `live_games.result_submitted_at`, `result_submitted_by`
and `result_note`, and the `roster_edits` table. Nothing is dropped.

## Owner dashboard (/admin)

A private, read-only dashboard for tracking usage and retention. It needs the
`ADMIN_PASSWORD` environment variable (set it in Railway). With it unset,
`/admin` returns 503 and nothing is reachable. The organizer tools keep their
own URLs (`/admin/stats`, `/admin/timer`, `/admin/courts`).

Sections, with a 7-day / 30-day / all-time range: **Growth** (signups per
week, signups by the park where a player first checked in), **Retention**
(weekly active players, new vs. returning, the week-over-week return rate, and
a cohort table of who's still active in weeks 1–4), **Activity** (check-ins
and games per park, games by format, busiest days and hours), **Competition**
(crowns this season by level and format, trophies, top players by points),
**Integrity** (results submitted, disputed and voided, locked results, roster
edits after a game started), and **Curiosity** ("View lobbies" taps and
"Suggest a court" submissions). Every table exports to CSV. Players appear
by display name and tag; phone numbers are never shown.

Activity counted for retention is a check-in or a played game. App opens
(the first open of each day), result events and park tags on events are
recorded from this change on, so older history shows zero for those.

**Tracking check** (top of /admin): total players, how many reached each
funnel milestone (opened the app, signed up, first check-in, first game,
first confirmed result), where players came from (`?src=` on their first
visit, "direct" otherwise), and every tracked event with total taps, unique
players and taps per day. Each milestone counts a player once, ever.

**Invites and sources.** A link with `?src=instagram` (or any short name)
saves that source on the account at signup. `?ref=<tag>` saves who invited
them. Players get an "Invite a hooper" button on their own profile that copies
`/?ref=<their tag>`.

**Download backup** (/admin, or `/admin/backup`) downloads a full copy of the
database named `br-backup-YYYY-MM-DD.db`, made with SQLite's `VACUUM INTO`
while the app runs. The copy includes player phone numbers, so keep it private.

**Retention, headline and funnel** (/admin, range filter 7 days / 30 days /
all time). Weeks run Monday to Sunday and months are calendar months, in
`APP_TIMEZONE`. A player is *active* in a week with a check-in or a played game.
- **Headline** (ignores the range): total players, weekly active (last full
  week), week-over-week return rate (of players active the week before last,
  the share active last week), stickiness (players active in the last 7 days ÷
  the last 30 days), games this month, and games per active player last week.
- **Retention**: weekly and monthly active charts, new (first time active) vs
  returning per week, cohorts by signup week with the share still active in
  weeks 1–8, churned (quiet for 3 weeks), resurrected (back after 3+ weeks
  away), and the longest streak of active weeks per player (2, 3, 4+).
- **Activation funnel** for players who signed up in range: opened the app →
  signed up → first check-in → first game → active in a second week, with the
  share who make each step and the median days from signup to first game.

Every table has an Export CSV button. Read-only, and names are shown with tags.

Migrations (additive, run on boot): `events.park_id`, `users.source`,
`users.referred_by_player_id`, and the `player_milestones` table (backfilled
once from existing data). No tables are dropped.

## Live leaderboard and profiles

When a result locks, the leaderboard, crowns and player profiles update on
open screens without a reload. Each open page checks every 15 seconds (the
same cadence the court and timer screens already use, but fetching the
changed data rather than reloading the page). It only checks while the page
is visible. The server first compares a cheap version number (results and
trophies recorded); the HTML for a section is rendered only when that version
has changed. A row whose rank moves is highlighted briefly. Shared partials
(`partials/board-live`, `partials/profile-header-live`,
`partials/profile-body-live`) render both the first page load and the live
updates, so the two always match.

## Tiers and trophies

The ladder is Rookie → Starter → Star → Superstar. Rookie → Starter is **10
paid lobby games played, or trophies** (this replaced "5 wins or 10 games";
existing databases are updated once on boot). How many trophies it takes
isn't decided yet, so it's stored (`tiers.trophies_to_promote`, empty) but
never shown — players see "Rank up with 10 paid games or by earning
trophies." A paid game counts once its lobby game is locked, and the app
can't lock a lobby game yet, so everyone shows "0 of 10 paid games" for now;
nobody is promoted automatically this round.

When a 30-day season ends, `db/trophies.js` saves every player who finished
it with a crown as a trophy (`trophies`: season dates, crown level, points,
and the parks they were king of). Each season is closed exactly once
(`closed_seasons`) — at boot, and again if a season rolls over while the
server is up — including any that ended while it was down. Profiles show
trophies as crown icons with the month (hover for details), or "Finish the
month with a crown to earn your first trophy." Your own Profile and How it
works show the shadowed ladder: your tier in full color with "You are here",
"X of 10 paid games" and "X trophies earned", higher tiers grayed out with a
lock, and no rake or prices. The tier badge shows next to names on
Profile, player profiles, and the leaderboard.

## ROYALE header

The ROYALE bar (logo plus "Crowns reset in N days.") is at the top of every
page, including sign-up, and the logo links back to the map (`/`).

## Home screen (the map)

`/` is now the King of the Court map, not the old lobby list. It leads with
the player's own standing (crown level or "No crown yet", season points, and
either "X pts to \<next level\>" or a note that they've already got the top
crown), then a real, interactive map — [Leaflet](https://leafletjs.com/)
for markers/circles/pan/zoom, with
[MapLibre GL](https://maplibre.org/)'s vector tiles (via the
[`@maplibre/maplibre-gl-leaflet`](https://github.com/maplibre/maplibre-gl-leaflet)
bridge layer) rendering [OpenFreeMap](https://openfreemap.org/)'s free,
no-API-key "Positron" style underneath — with one custom pin per park (the king's crown color, the active-now count with a
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

Leaflet, MapLibre GL, and the `maplibre-gl-leaflet` bridge are all vendored
into `public/vendor/` at pinned versions (served by this app, not pulled
from a CDN at runtime), so the *libraries* aren't a point of failure in
network-restricted environments. The tile *imagery* itself still loads live
from OpenFreeMap's `tiles.openfreemap.org` and needs normal outbound
internet access — in a sandboxed/offline environment the map renders and is
fully interactive (pins, pan/zoom, the bottom sheet all still work), just
without street imagery (a plain background instead). OpenFreeMap replaced
an earlier CARTO basemap that started requiring an API key; OpenFreeMap's
Positron style is free and keyless. Leaflet still owns every marker, the
check-in radius circle, and all click handling exactly as before —
MapLibre GL only renders the base tiles underneath, dropped in via the
bridge layer's `L.maplibreGL(...)` adapter so nothing else about the map
changed. `/how-it-works`
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
anywhere, name it, and optionally attach a photo — for a real court that
isn't on OpenStreetMap yet. The photo is read client-side (`FileReader`,
capped at 5MB) and sent as a `data:` URI, not a file upload — no
multer/storage plumbing needed for a "demo mode" app, though a real
deployment would want a proper object store and image processing instead
of storing it as TEXT. Only an `image/*` MIME type the browser itself
produced from the picked file is accepted server-side (never an arbitrary
URL or string), so this can't be turned into a stored-XSS or
server-side-request vector.

That suggestion goes to `court_suggestions` as `pending` and shows up on
`/admin/courts` (organizer-only, linked from `/runs`) for an organizer to
approve or reject, photo included. Approving creates a real park the same
way an Overpass check-in does, and that park's court screen then shows
"Court added by \<player name\>" so the credit sticks.

## /admin/courts — park management

Beyond reviewing suggestions, `/admin/courts` lists every park (preset,
player-suggested, or auto-created from a first Overpass check-in — each
labeled as such) with its own editable card: name, address, both radii,
and a small Leaflet map with a draggable marker for the pin itself — drag
it onto the actual courts rather than wherever the street address
happens to geocode to, then Save. Each card also has a "Suggested"
checkbox (`parks.is_suggested`) that curates it onto `/runs` — see below.

## Suggested parks (Runs tab)

The top of `/runs` shows "Suggested parks" — organizer-picked parks
(`is_suggested = 1`, toggled from `/admin/courts` above), each as a card
with distance (filled in client-side from the same geolocation `/runs`
already gathers for nearby runs — no second permission prompt), the
current king, the soonest upcoming run, and Check in / I got next buttons
wired straight into the normal check-in flow (still radius-gated, same as
everywhere else).

## Timer tracking

`/admin/timer` (linked from `/runs`, organizers only) lists every court
across every park with its live between-games status at a glance — idle, a
game in progress, or a countdown with a live ticking "M:SS" clock to the
next game. Each court also shows its configured "Time between games" in
minutes, which is how organizers set it from the court screen's "Game
settings" (stored as seconds internally, converted at the form boundary).

## Organizers & click tracking

`players.is_organizer` gates three pages behind a single **Organizer** link
on `/runs` (visible only to organizers; `/admin` itself, and each tab's own
URL, redirects to `/runs` for anyone else who hits them directly). `/admin`
redirects to `/admin/stats`; all three share a `Stats | Timer | Courts` tab
bar (the same pill-tab component `/board`'s Court/City switch uses) so
they read as one Organizer section instead of three unrelated pages:

- `/admin/stats` (Stats tab) — total taps, unique players, and an average
  taps/day rate for each tracked tap — Check in, I got next, Start a run, I'm coming, Invite
  friends, Follow a court, Suggest a court, Add a park photo, View
  lobbies, How it works, and tapping a player from the leaderboard. Every
  tap writes one row to the `events` table (`player_id`, `event_name`,
  `page`, `created_at`); `/admin/stats` aggregates it live, nothing is
  pre-computed. Above the taps is a funnel — signed up → checked in →
  played a game → came back another day — where each step counts only
  players who also made the step before it. "Came back" uses
  `player_active_days` (one row per player per day they open the app, by
  Eastern calendar day — override with `APP_TIMEZONE`), seeded once from
  existing activity. Invite buttons report themselves through
  `POST /api/events`, which only accepts `invite_friends`; unfollowing a
  court isn't counted as "Follow a court".
- `/admin/timer` (Timer tab) — the between-games timer board above.
- `/admin/courts` (Courts tab) — suggestions to approve/reject, and every
  park's own editable settings, name, address, and pin (see above).

To make an account an organizer, set `ORGANIZER_PHONES` to a comma-separated
list of phone numbers (matching how that player signs in). It's applied both
at boot (covering a phone added to the list after that account already
exists) and on every signup/login (covering a fresh account created after
the list is set) — so there's no manual DB edit needed either way.

## Deploying on Railway

- Mount a persistent volume at `/data`.
- Set `DATA_DIR=/data` so the SQLite file and uploaded park photos live on the volume instead of the
  repo (the app creates the folder if it doesn't exist).
- Leave `SEED_DEMO` unset in production, so no demo players, games, runs or
  lobbies are created (see *Run it* above).
- Set `SESSION_SECRET` to a fixed random string, so sessions survive restarts
  and deploys instead of invalidating every time the random fallback changes.
- Set `ORGANIZER_PHONES` to your own phone number (and any other organizers',
  comma-separated) so those accounts can see the **Organizer** link and its
  `/admin` tabs (Stats, Timer, Courts).
- No extra config needed for nearby courts or map tiles — Railway's normal
  outbound internet access reaches the Overpass API and OpenFreeMap's tiles
  fine; both
  are blocked only by this dev sandbox's own network policy.
