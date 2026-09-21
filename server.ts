// Must be first: see loadEnv.ts.
import './src/worker/loadEnv';
import express, { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
  startTradingWorker,
  stopTradingWorker,
  executeTradingTick,
  getWorkerStatus,
  setWorkerAutoPilot,
} from './src/worker/tradingWorker';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// No CORS headers: the app calls these endpoints from its own origin only, and
// other websites must not be able to switch the auto-pilot from a visitor's
// browser.

// ---------------------------------------------------------------- API routes

/**
 * Health and status probe.
 * Checked by the browser app to determine if 24/7 server trading is active.
 */
app.get('/api/status', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.json({ serverActive: true, worker: getWorkerStatus() });
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

/**
 * Remote toggle for auto-pilot state on server.
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
const shutdown = () => {
  console.log('[Server] Shutting down gracefully...');
  stopTradingWorker();
  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
