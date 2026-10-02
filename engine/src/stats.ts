// Results per model and per speed group (ENGINE_PLAN.md Section 18.7): from
// closed trades (what the engine actually did) and from followed signals
// (every confirmed signal, taken or skipped, tracked to its stop, take-profit
// or max hold). Pure.

export interface ResultRow {
  setup: string;
  speed: string;
  /** Result in multiples of the risk at entry. */
  r: number;
}

export interface ResultLine {
  key: string;
  trades: number;
  wins: number;
  winRate: number;
  avgR: number;
  totalR: number;
}

function line(key: string, rows: ResultRow[]): ResultLine {
  const wins = rows.filter((x) => x.r > 0).length;
  const totalR = rows.reduce((a, x) => a + x.r, 0);
  return { key, trades: rows.length, wins, winRate: rows.length ? wins / rows.length : 0, avgR: rows.length ? totalR / rows.length : 0, totalR };
}

/** All rows, then one line per model and one per speed group, each sorted by key. */
export function summarize(rows: ResultRow[]): { all: ResultLine; byModel: ResultLine[]; bySpeed: ResultLine[] } {
  const by = (pick: (x: ResultRow) => string) =>
    [...new Set(rows.map(pick))].sort().map((k) => line(k, rows.filter((x) => pick(x) === k)));
  return { all: line('all', rows), byModel: by((x) => x.setup), bySpeed: by((x) => x.speed) };
}
