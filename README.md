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
- `src/games.js` is the game lifecycle: `createLobby`, `createGame`, `startGame` (writes entry fees), `reportScore`, `confirmScore`, `contestGame`, `balanceCents`.
- `src/settlement.js` has `computePayouts` (pure money math), `settleGame` and promotion.

## Rules as implemented
- Money is integer cents. A balance is the sum of ledger rows: negative means owed in, positive means owed out.
- Game flow: `forming` -> `playing` -> `pending_confirm` -> `locked` (or `contested`).
- Entry fees are written when the game starts. Payouts, win/loss records and promotions happen once, when one player per team has confirmed the score.
- `rake = floor(pot * rake% / 100)`. Cents that don't split evenly between winners go to the house.
- Promotion adds a $5 `promo_credit`. Only rookie has criteria so far; starter and above never promote.

## Open decisions
- What happens when the 20-minute confirm window passes with no confirmation or contest. `confirm_deadline` is stored but nothing acts on it.
- How a `contested` game gets resolved.
- Promotion criteria for starter, star and superstar.
