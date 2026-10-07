import { openDb, migrate } from '../src/db.js';

const path = process.argv[2] ?? process.env.DB_PATH ?? 'basketball_royale.db';
const db = openDb(path);
const applied = migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
console.log(`Database: ${path}`);
