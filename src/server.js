import { openDb, migrate } from './db.js';
import { createApp } from './app.js';
import { expireGames } from './games.js';

const db = openDb(process.env.DB_PATH ?? 'basketball_royale.db');
migrate(db);

const adminPhones = (process.env.ADMIN_PHONES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const port = Number(process.env.PORT ?? 3000);
createApp(db, { adminPhones, publicUrl: process.env.PUBLIC_URL ?? '' }).listen(port, () => console.log(`Basketball Royale listening on :${port}`));

// Uncontested scores lock when their 20-minute window lapses.
setInterval(() => {
  try {
    const locked = expireGames(db);
    if (locked.length) console.log(`Auto-locked games: ${locked.join(', ')}`);
  } catch (err) {
    console.error('expireGames failed:', err);
  }
}, 30_000).unref();
