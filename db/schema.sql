-- ============================================================
-- BASKETBALL ROYALE — v1 "Demo Mode" Database Schema
-- App records everything; cash stays physical at the run.
-- Written for SQLite (easiest to start with; upgrades to
-- Postgres later with almost no changes).
-- ============================================================

-- 1. USERS — who you are (login identity)
CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    phone         TEXT UNIQUE,              -- login via phone for v1 (simple)
    photo_url     TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
);

-- 2. PLAYERS — your basketball identity (the engine's core)
-- Everyone starts as a rookie. Nobody picks their tier.
CREATE TABLE players (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id),
    tier          TEXT NOT NULL DEFAULT 'rookie',
                  -- rookie -> starter -> star -> superstar
    wins          INTEGER NOT NULL DEFAULT 0,
    losses        INTEGER NOT NULL DEFAULT 0,
    games_played  INTEGER NOT NULL DEFAULT 0,
    promoted_at   TEXT,                     -- when they last moved up
    is_organizer  INTEGER NOT NULL DEFAULT 0 -- can see /admin/* pages
);

-- 3. TIERS — the rules of the ladder, as data (not code!)
-- Change a number here, the whole app follows. No redeploy.
CREATE TABLE tiers (
    name            TEXT PRIMARY KEY,
    rank            INTEGER NOT NULL,        -- 1,2,3,4 for ordering
    min_stake_cents INTEGER NOT NULL,
    max_stake_cents INTEGER,                 -- NULL = no ceiling
    rake_percent    INTEGER NOT NULL,
    wins_to_promote  INTEGER,                -- promotion: wins OR games
    games_to_promote INTEGER                 -- NULL = criteria TBD / top tier
);

INSERT INTO tiers VALUES
    ('rookie',    1,  500,  500, 30, 5,  10),   -- $5 flat, 30% rake
    ('starter',   2,  500, 1500, 25, NULL, NULL), -- criteria TBD
    ('star',      3, 1500, 2500, 20, NULL, NULL), -- criteria TBD
    ('superstar', 4, 2500, NULL, 12, NULL, NULL); -- top of the ladder
    -- NOTE: all money is stored in CENTS (500 = $5.00).
    -- Never store money as decimals — rounding errors are real.

-- 4. LOBBIES — a run (your Sunday session is one lobby)
CREATE TABLE lobbies (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,             -- "Sunday Run @ [court]"
    location      TEXT,
    starts_at     TEXT NOT NULL,
    tier          TEXT NOT NULL REFERENCES tiers(name),
    stake_cents   INTEGER NOT NULL,          -- entry fee for games here
    join_code     TEXT UNIQUE,               -- short code (e.g. 'SUN24') called out
                                             -- courtside; invite links carry it too
    status        TEXT NOT NULL DEFAULT 'open'  -- open / live / closed
);

-- 5. GAMES — one game inside a lobby
CREATE TABLE games (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    lobby_id      INTEGER NOT NULL REFERENCES lobbies(id),
    status        TEXT NOT NULL DEFAULT 'forming',
                  -- forming -> playing -> pending_confirm -> locked / contested
    team_a_score  INTEGER,
    team_b_score  INTEGER,
    winner        TEXT,                      -- 'a' or 'b' once locked
    confirmed_by_a INTEGER REFERENCES players(id),  -- one player per team
    confirmed_by_b INTEGER REFERENCES players(id),  -- must confirm the score
    confirm_deadline TEXT,                   -- 20-min contest window
    locked_at     TEXT
);

-- 6. GAME_PLAYERS — who played, on which team (the roster)
CREATE TABLE game_players (
    game_id       INTEGER NOT NULL REFERENCES games(id),
    player_id     INTEGER NOT NULL REFERENCES players(id),
    team          TEXT NOT NULL,             -- 'a' or 'b'
    PRIMARY KEY (game_id, player_id)
);

-- 7. LEDGER — every money event, owed or settled, one row each
-- v1 = demo mode: this tracks what's OWED; cash moves by hand.
-- You never edit a balance. A balance is just SUM(amount_cents).
CREATE TABLE ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id     INTEGER NOT NULL REFERENCES players(id),
    game_id       INTEGER REFERENCES games(id),
    type          TEXT NOT NULL,
                  -- 'entry_fee' (negative) / 'payout' (positive)
                  -- / 'promo_credit' (free entry on promotion)
    amount_cents  INTEGER NOT NULL,          -- negative = owed in, positive = owed out
    settled       INTEGER NOT NULL DEFAULT 0, -- 1 once cash changed hands IRL
    created_at    TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- KING OF THE COURT — v1 additions (parks, courts, check-ins,
-- game results, and the "next line" queue for a court).
-- Check-ins and next-line get their own screens in step 2; for
-- now they just need tables so later work doesn't need a migration.
-- ============================================================

-- 8. PARKS — a physical court location
CREATE TABLE IF NOT EXISTS parks (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    name                   TEXT NOT NULL,
    location               TEXT,
    lat                    REAL,               -- for check-in geofencing
    lng                    REAL,
    check_in_radius_meters INTEGER NOT NULL DEFAULT 250,  -- must be within this to check in
    leave_radius_meters    INTEGER NOT NULL DEFAULT 400,  -- must be outside this 5+ min to lose your spot
    game_target            INTEGER NOT NULL DEFAULT 16,   -- "first to 16"
    between_games_seconds  INTEGER NOT NULL DEFAULT 180,  -- winners-stay-on countdown
    osm_id                 TEXT,               -- set when auto-created from an Overpass court
    added_by_player_id     INTEGER REFERENCES players(id), -- set when created from an approved suggestion
    is_suggested           INTEGER NOT NULL DEFAULT 0 -- organizer-curated pick, shown atop /runs
);

-- 9. COURTS — a park can have more than one court (e.g. Main, Side)
-- Every park gets a Court 1 "Main" by default when it's created.
CREATE TABLE IF NOT EXISTS courts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    park_id   INTEGER NOT NULL REFERENCES parks(id),
    number    INTEGER NOT NULL,
    nickname  TEXT,
    UNIQUE (park_id, number)
);

-- 10. CHECK_INS — a player showing up at a park
CREATE TABLE IF NOT EXISTS check_ins (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id   INTEGER NOT NULL REFERENCES players(id),
    park_id     INTEGER NOT NULL REFERENCES parks(id),
    time_in     TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT NOT NULL DEFAULT (datetime('now')),  -- last heartbeat received, regardless of position
    last_inside TEXT                                      -- last heartbeat confirmed within leave_radius_meters
);

-- 11. GAME_RESULTS — one row per player per game.
-- game_id links every row from the same game together; it is not
-- a foreign key into the (lobby-based) games table above — King of
-- the Court games are recorded directly, outside the lobby flow.
CREATE TABLE IF NOT EXISTS game_results (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id         INTEGER NOT NULL,
    player_id       INTEGER NOT NULL REFERENCES players(id),
    park_id         INTEGER NOT NULL REFERENCES parks(id),
    court_id        INTEGER NOT NULL REFERENCES courts(id),
    result          TEXT NOT NULL CHECK (result IN ('win', 'loss')),
    minutes_played  INTEGER NOT NULL,
    date            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 12. NEXT_LINE — the queue of squads waiting for a court
CREATE TABLE IF NOT EXISTS next_line (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    court_id           INTEGER NOT NULL REFERENCES courts(id),
    captain_player_id  INTEGER NOT NULL REFERENCES players(id),
    position           INTEGER NOT NULL,
    status             TEXT NOT NULL DEFAULT 'waiting',  -- a squad leaves this table once it starts playing
    created_at         TEXT
);

-- 13. NEXT_LINE_MEMBERS — the rest of a squad waiting in next_line
CREATE TABLE IF NOT EXISTS next_line_members (
    next_line_id  INTEGER NOT NULL REFERENCES next_line(id),
    player_id     INTEGER NOT NULL REFERENCES players(id),
    PRIMARY KEY (next_line_id, player_id)
);

-- 14. LIVE_GAMES — the game currently on a court, or the between-games
-- countdown holding the next matchup before it starts.
CREATE TABLE IF NOT EXISTS live_games (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    court_id           INTEGER NOT NULL REFERENCES courts(id),
    park_id            INTEGER NOT NULL REFERENCES parks(id),
    target             INTEGER NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('countdown', 'in_progress', 'awaiting_confirmation', 'done')),
    team_a_won         INTEGER,            -- NULL until a captain declares
    confirmed_a        INTEGER NOT NULL DEFAULT 0,
    confirmed_b        INTEGER NOT NULL DEFAULT 0,
    countdown_seconds  INTEGER,
    countdown_ends_at  TEXT,
    started_at         TEXT,
    locked_at          TEXT
);

-- 15. LIVE_GAME_PLAYERS — each player's own stint on the court. A sub
-- adds a new row rather than overwriting the player who left, so both
-- their time_on/time_off stay on the record.
CREATE TABLE IF NOT EXISTS live_game_players (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    live_game_id   INTEGER NOT NULL REFERENCES live_games(id),
    player_id      INTEGER NOT NULL REFERENCES players(id),
    team           TEXT NOT NULL CHECK (team IN ('a', 'b')),
    captain        INTEGER NOT NULL DEFAULT 0,
    time_on        TEXT,              -- set when the game actually starts, not when seated for countdown
    time_off       TEXT
);

-- 16. EVENTS — one row per tracked tap (click tracking for /admin/stats)
CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id   INTEGER NOT NULL REFERENCES players(id),
    event_name  TEXT NOT NULL,              -- e.g. 'check_in', 'i_got_next'
    page        TEXT,                       -- path the tap happened on
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 17. COURT_SUGGESTIONS — a player-dropped pin awaiting organizer review
CREATE TABLE IF NOT EXISTS court_suggestions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id             INTEGER NOT NULL REFERENCES players(id),
    name                  TEXT NOT NULL,
    lat                   REAL NOT NULL,
    lng                   REAL NOT NULL,
    status                TEXT NOT NULL DEFAULT 'pending', -- pending / approved / rejected
    park_id               INTEGER REFERENCES parks(id),    -- set once approved
    reviewed_by_player_id INTEGER REFERENCES players(id),
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at           TEXT
);

-- 18. OVERPASS_CACHE — one row per ~0.1deg area bucket, so repeated map
-- loads from the same area reuse results instead of hitting Overpass.
CREATE TABLE IF NOT EXISTS overpass_cache (
    bucket_key    TEXT PRIMARY KEY,
    lat           REAL NOT NULL,
    lng           REAL NOT NULL,
    response_json TEXT NOT NULL,
    fetched_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 19. RUNS — a scheduled pickup run at a court, open to anyone with the
-- link. scheduled_at is stored as the organizer's own local wall-clock
-- time (no timezone math) — fine for this app's single-area usage, same
-- demo-mode simplicity as the rest of this schema.
CREATE TABLE IF NOT EXISTS runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    court_id             INTEGER NOT NULL REFERENCES courts(id),
    organizer_player_id  INTEGER NOT NULL REFERENCES players(id),
    scheduled_at         TEXT NOT NULL,
    note                 TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 20. RUN_RSVPS — "I'm coming" taps on a run, one row per player
CREATE TABLE IF NOT EXISTS run_rsvps (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     INTEGER NOT NULL REFERENCES runs(id),
    player_id  INTEGER NOT NULL REFERENCES players(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (run_id, player_id)
);

-- 21. COURT_FOLLOWS — a player following a court for its runs and king
CREATE TABLE IF NOT EXISTS court_follows (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id  INTEGER NOT NULL REFERENCES players(id),
    court_id   INTEGER NOT NULL REFERENCES courts(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (player_id, court_id)
);

-- ============================================================
-- THE SETTLEMENT FUNCTION (pseudocode — this becomes real code)
-- Runs ONCE when a game's score is confirmed by both teams:
--
--   pot        = stake * number_of_players          (10 x $5 = $50)
--   rake       = pot * tier.rake_percent / 100      ($15 at rookie)
--   per_winner = (pot - rake) / winners_count       ($7 each)
--
--   for each winner:  ledger += payout(+700), player.wins += 1
--   for each loser:   player.losses += 1
--   for everyone:     player.games_played += 1
--
--   then check promotion (rookie example):
--   if wins >= 5 OR games_played >= 10:
--       tier = 'starter'
--       ledger += promo_credit(+500)   -- the free entry
-- ============================================================
