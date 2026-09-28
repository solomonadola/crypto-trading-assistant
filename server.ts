// Entry point for AI Studio Full-Stack hosting
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const bundledServer = path.join(__dirname, 'server.js');

if (process.env.NODE_ENV === 'production' && fs.existsSync(bundledServer)) {
  // In production, execute the pre-built, bundled Node.js server
  await import('./server.js');
} else {
  // In development, execute src/server.ts directly via tsx / Node
  await import('./src/server.js').catch(async () => {
    await import('./src/server.ts');
  });
}
