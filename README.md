# Basketball Royale

v1 "Demo Mode": the app records lobbies, games and who owes what. Cash stays physical at the run.

## Stack
Plain Node (>= 22.13) with the built-in `node:sqlite` and `node:test`. No dependencies to install.

## Commands
- `npm run migrate [path]` creates or updates the SQLite database (default `basketball_royale.db`, or `$DB_PATH`).
- `npm test` runs the test suite.

## Layout
- `migrations/` numbered SQL files, applied in order and recorded in `schema_migrations`.
- `src/db.js` opens the database (foreign keys on) and runs migrations and transactions.
- `src/games.js` is the game lifecycle: `createLobby`, `createGame`, `startGame` (writes entry fees), `reportScore`, `confirmScore`, `contestGame`, `expireGames`, `resolveContest`, `balanceCents`.
- `src/settlement.js` has `computePayouts` (pure money math), `settleGame` and promotion.

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
- Nothing calls `expireGames` yet; there is no scheduler or API.
- Who counts as an admin is not modelled; `resolveContest` is unrestricted.
