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
    promoted_at   TEXT                      -- when they last moved up
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
    check_in_radius_meters INTEGER NOT NULL DEFAULT 150
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

-- 10. CHECK_INS — a player showing up at a park (screen comes later)
CREATE TABLE IF NOT EXISTS check_ins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id  INTEGER NOT NULL REFERENCES players(id),
    park_id    INTEGER NOT NULL REFERENCES parks(id),
    time_in    TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
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

-- 12. NEXT_LINE — the queue of squads waiting for a court (screen later)
CREATE TABLE IF NOT EXISTS next_line (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    court_id           INTEGER NOT NULL REFERENCES courts(id),
    captain_player_id  INTEGER NOT NULL REFERENCES players(id),
    position           INTEGER NOT NULL
);

-- 13. NEXT_LINE_MEMBERS — the rest of a squad waiting in next_line
CREATE TABLE IF NOT EXISTS next_line_members (
    next_line_id  INTEGER NOT NULL REFERENCES next_line(id),
    player_id     INTEGER NOT NULL REFERENCES players(id),
    PRIMARY KEY (next_line_id, player_id)
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
