-- API support: login sessions, admin flag, and who has joined which lobby.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

CREATE TABLE sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE lobby_players (
    lobby_id   INTEGER NOT NULL REFERENCES lobbies(id),
    player_id  INTEGER NOT NULL REFERENCES players(id),
    joined_at  TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (lobby_id, player_id)
);
