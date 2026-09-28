/**
 * Backtest Lab API: lists the saved runs in data/backtests/ and starts new
 * ones by running tools/backtest.mjs, one at a time. The candles are read from
 * disk, so this only works where they were downloaded (tools/fetch-klines.mjs);
 * a hosted server without them says so instead of failing.
 */
import type { Express, Request, Response } from 'express';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { STRATEGY_PROFILES } from '../config/geometry';

interface Job {
  id: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  fraction: number;
  /** simulated time reached */
  t: number | null;
  trades: number;
  equityUSD: number | null;
  log: string[];
  resultId: string | null;
  error: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function registerBacktestRoutes(app: Express, rootDir: string): void {
  const resultsDir = path.join(rootDir, 'data', 'backtests');
  const script = path.join(rootDir, 'tools', 'backtest.mjs');
  // The wide download (tools/fetch-klines.mjs --out data/klines-wide) holds every coin; else the original two.
  const dataDirs = fs.existsSync(path.join(rootDir, 'data', 'klines-wide'))
    ? ['data/klines-wide']
    : ['data/klines2024', 'data/klines'].filter((d) => fs.existsSync(path.join(rootDir, d)));
  let job: Job | null = null;
  let child: ChildProcess | null = null;

  const readResult = (id: string) => {
    if (!/^[\w.-]+$/.test(id)) return null;
    const file = path.join(resultsDir, `${id}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  };

  /** Saved runs, newest first, without the heavy arrays. */
  app.get('/api/backtests', (_req: Request, res: Response) => {
    const runs = fs.existsSync(resultsDir)
      ? fs.readdirSync(resultsDir).filter((f) => f.endsWith('.json')).map((f) => {
          try {
            const r = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
            return { id: r.id || f.replace(/\.json$/, ''), createdAt: r.createdAt, settings: r.settings, summary: r.summary };
          } catch {
            return null;
          }
        }).filter(Boolean).sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0))
      : [];
    res.json({
      success: true,
      runs,
      canRun: fs.existsSync(script) && dataDirs.length > 0,
      dataDirs,
      profiles: [
        { id: 'TREND_PULLBACK_DEMAND', name: 'Supply & Demand Trend Pullback (new)' },
        ...Object.values(STRATEGY_PROFILES).map((p) => ({ id: p.id, name: `${p.name} (live engine)` })),
      ],
      job,
    });
  });

  app.get('/api/backtests/job', (_req: Request, res: Response) => {
    res.json({ success: true, job });
  });

  app.get('/api/backtests/:id', (req: Request, res: Response) => {
    const r = readResult(req.params.id);
    if (!r) { res.status(404).json({ success: false, error: `No saved backtest ${req.params.id}` }); return; }
    res.json({ success: true, result: r });
  });

  /** Body: { profile, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', shorts: boolean, capital: number } */
  app.post('/api/backtests/run', (req: Request, res: Response) => {
    if (job?.status === 'running') {
      res.status(409).json({ success: false, error: 'A backtest is already running.', job });
      return;
    }
    if (!fs.existsSync(script) || !dataDirs.length) {
      res.status(409).json({ success: false, error: 'No candle history on this server. Run node tools/fetch-klines.mjs where the app runs, then try again.' });
      return;
    }
    const { profile, from, to, shorts, capital, rules } = req.body ?? {};
    const cap = Number(capital);
    const isStrategy = profile === 'TREND_PULLBACK_DEMAND';
    if (typeof profile !== 'string' || !(isStrategy || profile in STRATEGY_PROFILES)) {
      res.status(400).json({ success: false, error: `profile must be one of TREND_PULLBACK_DEMAND, ${Object.keys(STRATEGY_PROFILES).join(', ')}` });
      return;
    }
    if (!DATE.test(String(from)) || !DATE.test(String(to)) || !(Date.parse(from) < Date.parse(to))) {
      res.status(400).json({ success: false, error: 'from and to must be dates (YYYY-MM-DD), from before to' });
      return;
    }
    if (!(cap >= 10 && cap <= 10_000_000)) {
      res.status(400).json({ success: false, error: 'capital must be between 10 and 10,000,000' });
      return;
    }

    const args = [script, '--progress-json', '--from', from, '--to', to, '--capital', String(cap), '--dir', dataDirs.join(',')];
    if (isStrategy) {
      args.push('--strategy', 'trend-pullback');
      // Only known switches become flags; anything else is ignored.
      const allowed = ['btc-rising', 'breadth', 'rel-strength', 'loss-pause', 'bos', 'target-prior-high', 'key-level', 'ltf-break', 'inducement', 'ltf-trail', 'no-btc', 'no-trend', 'no-zone'];
      if (shorts === true) args.push('--shorts');
      if (Array.isArray(rules)) for (const r of rules) if (allowed.includes(r)) args.push(`--${r}`);
      // Timeframes: swing (4h zones, 1h entry), intraday (1h/15m) or scalp (15m/5m).
      const tf = ({ swing: null, intraday: ['60', '15', '18'], scalp: ['15', '5', '6'] } as Record<string, string[] | null>)[String(req.body?.timeframes || 'swing')];
      if (tf) args.push('--zone-tf', tf[0], '--trigger-tf', tf[1], '--max-hold', tf[2]);
      const cost = Number(req.body?.costPct);
      if (cost >= 0.01 && cost <= 1) args.push('--cost', String(cost));
      const vol = Number(req.body?.minVolumeM);
      if (vol >= 1 && vol <= 10_000) args.push('--min-volume', String(vol));
    }
    else {
      args.push('--profile', profile);
      if (shorts === true) args.push('--shorts');
    }
    job = {
      id: Math.random().toString(36).slice(2, 10), status: 'running', startedAt: Date.now(),
      fraction: 0, t: null, trades: 0, equityUSD: null, log: [], resultId: null, error: null,
    };
    const current = job;
    // Scalp runs build 5-minute candles for every coin: give the run room.
    child = spawn(process.execPath, ['--max-old-space-size=7000', ...args], { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'progress') Object.assign(current, { fraction: msg.fraction, t: msg.t, trades: msg.trades, equityUSD: msg.equityUSD });
          else if (msg.type === 'log') current.log.push(msg.message);
          else if (msg.type === 'done') { current.resultId = msg.id; current.fraction = 1; }
        } catch {
          if (line.trim()) current.log.push(line.slice(0, 300));
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => { current.log.push(chunk.toString().slice(0, 300)); });
    child.on('close', (code, signal) => {
      child = null;
      if (code === 0 && current.resultId) current.status = 'done';
      else {
        current.status = 'failed';
        const why = signal ? `stopped by ${signal}` : `exited with code ${code}`;
        current.error = `Backtest ${why}. ${current.log.slice(-3).join(' ')}`.slice(0, 600);
      }
      current.log = current.log.slice(-20);
    });
    res.json({ success: true, job });
  });

  app.post('/api/backtests/cancel', (_req: Request, res: Response) => {
    if (child && job?.status === 'running') {
      child.kill();
      job.status = 'failed';
      job.error = 'Cancelled';
    }
    res.json({ success: true, job });
  });
}
