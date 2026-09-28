// Entry point for `npm run dev`, `npm start` and AI Studio hosting.
// Production runs the bundle `npm run build` makes from engine/src/main.ts;
// development runs the TypeScript source directly (through tsx).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundled = path.join(here, 'server.js');

if (process.env.NODE_ENV === 'production' && fs.existsSync(bundled)) {
  await import('./server.js');
} else {
  await import('./engine/src/main.ts');
}
