// Pulls the trade feed from Firestore via the REST API and writes it as plain
// JSON for tools/diagnose-trades.mjs.
//
//   node tools/fetch-firestore-trades.mjs [--out data/firestore-trades.json]
//
// NOTE ON ACCESS: this works with nothing but the projectId and the public
// client apiKey, because the deployed rules still allow unauthenticated reads.
// That is the hole firestore.rules now closes - but rules only take effect once
// deployed (`firebase deploy --only firestore:rules`). Once they are, this
// script stops working without a token, which is the correct outcome.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const OUT = arg('out', 'data/firestore-trades.json');
const COLLECTION = 'crypto_automated_trades';

const cfg = JSON.parse(readFileSync('firebase-applet-config.json', 'utf8'));
const dbId = cfg.firestoreDatabaseId || '(default)';
console.log(`project ${cfg.projectId} | database ${dbId} | collection ${COLLECTION}`);

// Firestore REST returns values wrapped by type; unwrap to plain JS.
function unwrap(v) {
  if (v == null) return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return unwrapFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(unwrap);
  return null;
}
const unwrapFields = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, unwrap(v)]));

const base = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/${encodeURIComponent(dbId)}/documents/${COLLECTION}`;
const docs = [];
let pageToken = null;

do {
  const url = new URL(base);
  url.searchParams.set('pageSize', '300');
  if (cfg.apiKey) url.searchParams.set('key', cfg.apiKey);
  if (pageToken) url.searchParams.set('pageToken', pageToken);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    console.error(`\nHTTP ${res.status}`);
    if (res.status === 403 || res.status === 401) {
      console.error('Permission denied. If firestore.rules has been deployed, this is expected:');
      console.error('reads now require authentication. Export from the browser console instead:');
      console.error("  copy(localStorage.getItem('crypto_automated_trades_local_fallback'))");
    } else {
      console.error(body.slice(0, 500));
    }
    process.exit(1);
  }
  const json = await res.json();
  for (const d of json.documents || []) docs.push(unwrapFields(d.fields || {}));
  pageToken = json.nextPageToken || null;
  process.stdout.write(`  fetched ${docs.length}\r`);
} while (pageToken);

mkdirSync(OUT.replace(/\/[^/]*$/, ''), { recursive: true });
writeFileSync(OUT, JSON.stringify(docs, null, 2));
console.log(`\n${docs.length} trades -> ${OUT}`);
if (docs.length === 0) console.log('Collection is empty - the feed may only exist in localStorage.');
