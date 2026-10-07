# Basketball Royale

v1 "Demo Mode": the app records lobbies, games and who owes what. Cash stays physical at the run.

## Stack
Node (>= 22.13), Express 5, and SQLite via the built-in `node:sqlite`. Tests use `node:test`. Run `npm install` once.

## Commands
- `npm start` runs the API (`PORT` default 3000, `PUBLIC_URL` site root for invite links, `DB_PATH` default `basketball_royale.db`, `ADMIN_PHONES` comma-separated phones that become admins on login). It migrates on boot and auto-locks lapsed games every 30s.
- `npm run migrate [path]` creates or updates the SQLite database (default `basketball_royale.db`, or `$DB_PATH`).
- `npm test` runs the test suite.

## Layout
- `migrations/` numbered SQL files, applied in order and recorded in `schema_migrations`.
- `src/db.js` opens the database (foreign keys on) and runs migrations and transactions.
- `src/lobbies.js` is lobbies and join codes: `createLobby`, `joinLobby`, `leaveLobby`, `startLobby`, `closeLobby`, `lobbyPreview`.
- `src/games.js` is the game lifecycle: `createGame`, `startGame` (writes entry fees), `reportScore`, `confirmScore`, `contestGame`, `expireGames`, `resolveContest`, `balanceCents`.
- `src/settlement.js` has `computePayouts` (pure money math), `settleGame` and promotion.

## API
Send `Authorization: Bearer <token>` on everything except `/auth/login` and `/tiers`.

| Route | Who | Does |
|---|---|---|
| `POST /auth/login` `{name, phone}` | anyone | log in, creating the account on first use; returns `{token}` |
| `GET /me`, `GET /me/ledger` | player | profile, tier, balance, owed cash, ledger |
| `GET /tiers` | anyone | the ladder rules |
| `POST /lobbies` | admin | create a lobby (`name, startsAt, tier, stakeCents`, optional `location`, `joinCode`); a code is generated if omitted |
| `GET /join/:code` | anyone | public invite preview: name, place, time, tier, stake, player count (no roster) |
| `GET /lobbies`, `GET /lobbies/:code` | player | browse open lobbies; one lobby with its joined players and invite link |
| `POST /lobbies/:code/join`, `/leave` | player | join by code (tier must match, repeat joins are harmless); leave unless mid-game |
| `POST /lobbies/:code/start`, `/close` | admin | open -> live; live -> closed (refused while games are unfinished) |
| `POST /lobbies/:code/games` `{teams:{a:[ids],b:[ids]}}` | admin | form a game from joined players |
| `GET /games/:id` | player | game and roster |
| `POST /games/:id/start` | admin | writes entry fees |
| `POST /games/:id/score` `{teamAScore, teamBScore}` | rostered player or admin | report the score |
| `POST /games/:id/confirm`, `/contest` | rostered player | confirm (settles once both teams have) or dispute |
| `POST /games/:id/resolve` `{winner: 'a', 'b' or null}` | admin | settle a contested game, or void it |
| `GET /admin/balances`, `POST /admin/ledger/settle` `{ledgerIds}` | admin | who owes what; mark cash received |

Errors come back as `{error}`: 401 not logged in, 403 not allowed, 404 not found, 400 any rule violation.

## Lobbies and join codes
- Codes are 5 characters from an alphabet without 0/O/1/I, so they survive being shouted across a court. Admins may pick their own (4-10 letters/digits). Codes are stored uppercase and matched case-insensitively.
- Share `PUBLIC_URL/join/CODE`. Opening it shows the preview before login; after login the app joins with the code.
- Lobby status: `open` -> `live` (manually, or automatically when the first game is formed) -> `closed`. Open and live lobbies accept joiners, since people arrive late. Closed lobbies accept no one and no games.
- A game can only be formed from players who joined the lobby.

## Rules as implemented
- Money is integer cents. A balance is the sum of ledger rows: negative means owed in, positive means owed out.
- Game flow: `forming` -> `playing` -> `pending_confirm` -> `locked` (or `contested`).
- Entry fees are written when the game starts. Payouts, win/loss records and promotions happen once, when one player per team has confirmed the score.
- `rake = floor(pot * rake% / 100)`. Cents that don't split evenly between winners go to the house.
- Promotion adds a `promo_credit` equal to the new tier's minimum stake (the free entry). Criteria are cumulative wins OR games played: rookie 5/10, starter 10/20, star 15/30. Superstar is the top.
- Stake ranges: rookie $5 flat, starter $10-14.99, star $15-24.99, superstar $25+ (migration 002).
- The 20-minute window is a contest window. `expireGames(db, now)` locks and settles any pending game past its deadline, so an uncontested score stands. Run it on a timer.
- A contested game holds its money until an admin calls `resolveContest`: name the winner (`'a'`/`'b'`) to settle it, or `null` to void it. A void game refunds entry fees (`refund` ledger rows), changes no records and ends `void`.

## Still open
- Login has no SMS verification: anyone who knows a phone number can log in as it. Fine for a demo run, not for real money.
- No front end yet.
