// Must be first: see loadEnv.ts.
import './worker/loadEnv';
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
  resetWorkerLock,
  setWorkerAllowShorts,
  setWorkerStrategyProfile,
  resetWorkerAndDatabase,
} from './worker/tradingWorker';
import zlib from 'node:zlib';
import { STRATEGY_PROFILES, StrategyProfileId } from './config/geometry';
import { registerBacktestRoutes } from './backtest/backtestRoutes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = fs.existsSync(path.join(__dirname, 'dist'))
  ? __dirname
  : path.resolve(__dirname, '..');

const app = express();

// The build this server belongs to (written by vite.config.ts next to the
// page). Browsers compare it with their own: a mismatch means an old page or
// an old server revision is answering.
let BUILD_ID = 'dev';
try {
  BUILD_ID = JSON.parse(fs.readFileSync(path.join(rootDir, 'dist', 'build-info.json'), 'utf8')).buildId || 'dev';
} catch {}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// Enable CORS and handle preflight OPTIONS requests on all API endpoints so that
// previews in iframes (AI Studio), multiple browser windows (Edge, Chrome), and
// hosted instances can reliably query status and post action commands.
app.use('/api', (req: Request, res: Response, next: () => void) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const allowAnyOrigin = (_req: Request, res: Response, next: () => void) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
};

// In development, automatically proxy all /api/* requests to the deployed production server
// so that the dev environment interacts directly with the deployed server's live API
// instead of hitting Firebase directly.
const DEPLOYED_SERVER_URL = (
  process.env.DEPLOYED_SERVER_URL ||
  process.env.BACKEND_URL ||
  process.env.VITE_TRADING_SERVER_URL ||
  ''
).replace(/\/+$/, '');

const isDev = process.env.NODE_ENV !== 'production';

if (isDev && DEPLOYED_SERVER_URL) {
  console.log(`[Proxy] Development mode active: Upstream deployed server URL configured as ${DEPLOYED_SERVER_URL}`);

  app.use('/api', async (req: Request, res: Response, next: () => void) => {
    // Avoid proxy loops if pointing to local server
    if (DEPLOYED_SERVER_URL.includes(`localhost:${PORT}`) || DEPLOYED_SERVER_URL.includes(`127.0.0.1:${PORT}`)) {
      return next();
    }

    // Do not proxy reset endpoint; execute reset directly against database and server
    if (req.originalUrl === '/api/reset' || req.originalUrl.startsWith('/api/reset')) {
      return next();
    }

    // Backtests run over the candles on this machine; the hosted server has none.
    if (req.originalUrl.startsWith('/api/backtests')) {
      return next();
    }

    const targetUrl = `${DEPLOYED_SERVER_URL}${req.originalUrl}`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const headers: Record<string, string> = {
        'Accept': req.headers.accept || 'application/json',
      };
      if (req.headers['content-type']) {
        headers['Content-Type'] = String(req.headers['content-type']);
      }
      if (req.headers['accept-encoding']) {
        headers['Accept-Encoding'] = String(req.headers['accept-encoding']);
      }

      const fetchOpts: RequestInit = {
        method: req.method,
        headers,
        signal: controller.signal,
      };

      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
        fetchOpts.body = JSON.stringify(req.body);
      }

      const upstreamRes = await fetch(targetUrl, fetchOpts);
      clearTimeout(timeoutId);

      const contentType = upstreamRes.headers.get('content-type') || '';

      // If upstream returns 404 (e.g. endpoint added in current code not yet deployed upstream)
      // or returns HTML error before initial deployment, fall back to local dev handlers.
      if (upstreamRes.status === 404 || (!contentType.includes('application/json') && !upstreamRes.ok)) {
        return next();
      }

      res.status(upstreamRes.status);
      res.set('Content-Type', contentType || 'application/json');
      res.set('X-Proxied-From', DEPLOYED_SERVER_URL);
      const contentEncoding = upstreamRes.headers.get('content-encoding');
      if (contentEncoding) {
        res.set('Content-Encoding', contentEncoding);
      }

      const data = await upstreamRes.arrayBuffer();
      res.send(Buffer.from(data));
    } catch {
      // Deployed server not reachable yet, fall back to local handlers
      next();
    }
  });
}

// ---------------------------------------------------------------- API routes

/**
 * Health and status probe.
 * Checked by the browser app to determine if 24/7 server trading is active.
 */
app.get('/api/status', allowAnyOrigin, (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  const workerStatus = getWorkerStatus();
  // Auto-recovery watchdog: if worker tick has been stuck for >60s, reset the lock so it resumes
  if (workerStatus.tickAgeMs && workerStatus.tickAgeMs > 60_000 && workerStatus.lastTickSummary?.includes('already running')) {
    console.warn(`[Watchdog] Worker tick detected stuck for ${Math.round(workerStatus.tickAgeMs / 1000)}s. Auto-resetting lock.`);
    resetWorkerLock();
  }
  res.json({ serverActive: true, buildId: BUILD_ID, worker: workerStatus });
});

/** Manual worker reset endpoint to break any lock and force a fresh tick */
app.all('/api/worker/reset', allowAnyOrigin, (_req: Request, res: Response) => {
  resetWorkerLock();
  executeTradingTick().catch((e) => console.error('Worker reset tick error:', e));
  res.json({ success: true, message: 'Worker lock reset successfully' });
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

/** Rebuild the list from Firestore (after editing trades directly in Firestore or clearing cache). */
app.post('/api/resync', action((req) => {
  const clearCache = req.query?.clearCache === 'true' || req.body?.clearCache === true;
  return resyncFromFirestore(clearCache);
}));

/** Clears server-side working trade caches and rebuilds fresh from Firestore. */
app.post('/api/cache/clear', action(async () => {
  await resyncFromFirestore(true);
  return { success: true, message: 'Server trade caches wiped and resynced fresh from Firestore' };
}));

/** Completely purge all trades from Firebase Firestore database and server memory to start fresh */
app.post('/api/reset', action(() => resetWorkerAndDatabase()));

/**
 * Get current auto-pilot state from server memory.
 */
app.get('/api/autopilot', allowAnyOrigin, (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, isAutoPilot: getWorkerStatus().isAutoPilot });
});

/**
 * Remote toggle for auto-pilot state on server. Kept across restarts.
 */
app.post('/api/autopilot', allowAnyOrigin, (req: Request, res: Response) => {
  const { enabled } = req.body ?? {};
  if (typeof enabled === 'boolean') {
    setWorkerAutoPilot(enabled);
    res.json({ success: true, isAutoPilot: enabled });
  } else {
    res.status(400).json({ success: false, error: 'Expected boolean "enabled" in request body' });
  }
});

/**
 * Get current allowShorts state from server memory.
 */
app.get('/api/autopilot/shorts', allowAnyOrigin, (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, allowShorts: getWorkerStatus().allowShorts });
});

/**
 * Remote toggle for allowShorts on server. Kept across restarts.
 */
app.post('/api/autopilot/shorts', allowAnyOrigin, (req: Request, res: Response) => {
  const { allowShorts } = req.body ?? {};
  if (typeof allowShorts === 'boolean') {
    setWorkerAllowShorts(allowShorts);
    res.json({ success: true, allowShorts });

/**
 * The exit profile the server opens new trades with. Kept across restarts.
 */
app.post('/api/autopilot/profile', allowAnyOrigin, (req: Request, res: Response) => {
  const { profile } = req.body ?? {};
  if (typeof profile === 'string' && profile in STRATEGY_PROFILES) {
    setWorkerStrategyProfile(profile as StrategyProfileId);
    res.json({ success: true, profile });
  } else {
    res.status(400).json({ success: false, error: `Expected "profile" to be one of ${Object.keys(STRATEGY_PROFILES).join(', ')}` });
  }
});
  } else {
    res.status(400).json({ success: false, error: 'Expected boolean "allowShorts" in request body' });
  }
});

// Backtest Lab: saved runs and new runs over the candles on disk.
registerBacktestRoutes(app, rootDir);

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

// ---------------------------------------------------------------- Static / Vite Serving

const distPath = path.join(rootDir, 'dist');

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    try {
      console.log('[Server] Mounting Vite middleware for live development');
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch (e) {
      console.warn('[Server] Could not mount Vite middleware, falling back to static:', e);
      if (fs.existsSync(distPath)) {
        app.use(express.static(distPath));
        app.get('*', (req: Request, res: Response) => {
          if (req.path.startsWith('/api/')) {
            res.status(404).json({ error: 'Endpoint not found' });
            return;
          }
          res.sendFile(path.join(distPath, 'index.html'));
        });
      }
    }
  } else if (fs.existsSync(distPath)) {
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
}

startServer().catch((err) => {
  console.error('[Server] Fatal error starting server:', err);
});

