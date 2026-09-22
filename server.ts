// Must be first: see loadEnv.ts.
import './src/worker/loadEnv';
import express, { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
  startTradingWorker,
  shutdownTradingWorker,
  closeTradeById,
  setTradeExcluded,
  deploySymbol,
  resyncFromFirestore,
  flushNow,
  ActionError,
  executeTradingTick,
  getWorkerStatus,
  setWorkerAutoPilot,
  getTradesFeed,
  getInstanceId,
  syncWithFirestore,
} from './src/worker/tradingWorker';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// The build this server belongs to (written by vite.config.ts next to the
// page). Browsers compare it with their own: a mismatch means an old page or
// an old server revision is answering.
let BUILD_ID = 'dev';
try {
  BUILD_ID = JSON.parse(fs.readFileSync(path.join(__dirname, 'dist', 'build-info.json'), 'utf8')).buildId || 'dev';
} catch {}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// CORS only on the read-only GET endpoints, so a copy of the app hosted
// elsewhere (e.g. a local dev server with VITE_TRADING_SERVER_URL) can follow
// this server. The trade list is already publicly readable in Firestore. The
// control endpoints stay same-origin: other websites must not be able to
// switch the auto-pilot from a visitor's browser.
const allowAnyOrigin = (_req: Request, res: Response, next: () => void) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
};

// ---------------------------------------------------------------- API routes

/**
 * Health and status probe.
 * Checked by the browser app to determine if 24/7 server trading is active.
 */
app.get('/api/status', allowAnyOrigin, (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.json({ serverActive: true, buildId: BUILD_ID, worker: getWorkerStatus() });
});

/**
 * The trade list as this server holds it - what browsers show while it runs.
 * ?since=<version>&boot=<bootId> from the previous response returns only the
 * changes. Gzipped when the caller accepts it (~1 MB of JSON for the full
 * list today, a few KB for a change set).
 */
app.get('/api/trades', allowAnyOrigin, (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  const feed = getTradesFeed(Number(req.query.since) || 0, String(req.query.boot || ''));
  if (!feed) {
    res.status(503).json({ error: 'No confirmed trade list yet' });
    return;
  }
  const body = Buffer.from(JSON.stringify(feed));
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Vary', 'Accept-Encoding');
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.set('Content-Encoding', 'gzip');
    res.send(zlib.gzipSync(body));
  } else {
    res.send(body);
  }
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    serverActive: true,
    time: Date.now(),
  });
});

/**
 * Trigger an immediate trading tick on demand.
 * Enables external cron or uptime pingers (e.g. UptimeRobot, Cloud Scheduler)
 * to keep Cloud Run or serverless instances trading even when sleeping.
 */
const handleTick = async (_req: Request, res: Response) => {
  try {
    const result = await executeTradingTick();
    res.json({
      success: result.success,
      tick: result,
      worker: getWorkerStatus(),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

app.get('/api/tick', handleTick);
app.post('/api/tick', handleTick);

// ---------------------------------------------------------------- actions
//
// The server is the source of truth, so every change a browser makes comes
// through here rather than being written to Firestore by the browser. Same
// origin only (no CORS headers): other websites cannot act on your trades.

type Handler = (req: Request) => Promise<unknown>;
const action = (fn: Handler) => async (req: Request, res: Response) => {
  try {
    res.json({ success: true, result: await fn(req), instanceId: getInstanceId(), buildId: BUILD_ID });
  } catch (err) {
    const status = err instanceof ActionError ? 400 : 500;
    res.status(status).json({ success: false, error: err instanceof Error ? err.message : String(err), instanceId: getInstanceId(), buildId: BUILD_ID });
  }
};

/** Close an open trade at its latest price. Body: {"reason": "manual" | "time_decay"} */
app.post('/api/trades/:id/close', action((req) =>
  closeTradeById(String(req.params.id), req.body?.reason === 'time_decay' ? 'time_decay' : 'manual')));

/** Exclude a trade from statistics, or count it again. Body: {"excluded": true | false} */
app.post('/api/trades/:id/exclude', action(async (req) => {
  if (typeof req.body?.excluded !== 'boolean') throw new ActionError('Expected boolean "excluded"');
  return setTradeExcluded(String(req.params.id), req.body.excluded);
}));

/** Open a position from the server's current scan. Body: {"symbol": "SOL"} */
app.post('/api/deploy', action(async (req) => {
  if (typeof req.body?.symbol !== 'string' || !req.body.symbol) throw new ActionError('Expected "symbol"');
  return deploySymbol(req.body.symbol);
}));

/** Sync with Firestore now instead of at the next minute: write queued changes, pull anything newer there. */
app.post('/api/flush', action(() => syncWithFirestore(false)));

/** Rebuild the list from Firestore (after editing trades directly in Firestore). One read per trade. */
app.post('/api/resync', action(() => resyncFromFirestore()));

/**
 * Remote toggle for auto-pilot state on server. Kept across restarts.
 */
app.post('/api/autopilot', (req: Request, res: Response) => {
  const { enabled } = req.body ?? {};
  if (typeof enabled === 'boolean') {
    setWorkerAutoPilot(enabled);
    res.json({ success: true, isAutoPilot: enabled });
  } else {
    res.status(400).json({ success: false, error: 'Expected boolean "enabled" in request body' });
  }
});

// Any other /api address, any method: a JSON answer saying so, instead of
// Express's bare HTML 404 (which the page could only report as "404").
app.all('/api/*', (req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: `This server has no ${req.method} ${req.path}. It may be an older version than the page (server build ${BUILD_ID}).`,
    instanceId: getInstanceId(),
    buildId: BUILD_ID,
  });
});

// ---------------------------------------------------------------- Static Serving

const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  console.log(`[Server] Serving production frontend from ${distPath}`);
  app.use(express.static(distPath));
  app.get('*', (req: Request, res: Response) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Endpoint not found' });
      return;
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  console.log('[Server] No dist directory found. Running in API server mode.');
  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(`
      <!DOCTYPE html>
      <html>
        <head><title>CryptoStudyLab Server</title></head>
        <body style="font-family: monospace; padding: 2rem; background: #1c1917; color: #f5f5f4;">
          <h2>CryptoStudyLab 24/7 Trading Server</h2>
          <p>Server is running and autonomous trading worker is active.</p>
          <p>Status: <a href="/api/status" style="color: #38bdf8;">/api/status</a></p>
          <p>Manual Tick: <a href="/api/tick" style="color: #38bdf8;">/api/tick</a></p>
          <p><em>To serve the frontend here, run <code>npm run build</code>. For Vite development, access the Vite dev server at port 3000.</em></p>
        </body>
      </html>
    `);
  });
}

// ---------------------------------------------------------------- Start Server

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] CryptoStudyLab server listening on http://0.0.0.0:${PORT}`);
  // Start the background trading loop (every 30 seconds)
  startTradingWorker(30_000);
});

// Graceful shutdown
// Cloud Run allows 10s after SIGTERM: save queued changes to Firestore first.
const shutdown = async () => {
  console.log('[Server] Shutting down gracefully...');
  await shutdownTradingWorker(8000);
  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
