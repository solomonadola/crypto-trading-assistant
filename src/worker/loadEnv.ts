/**
 * Loads .env.local then .env into process.env. Imported first by server.ts:
 * static imports run before the importing module's own code, so calling
 * dotenv.config() in server.ts itself would run after lib/firebase.ts had
 * already read VITE_FIRESTORE_WRITES. .env.local is where that switch lives,
 * and a server that missed it would trade into the shared production database.
 */
import dotenv from 'dotenv';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

export {};
