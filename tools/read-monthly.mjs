import { readFileSync } from 'node:fs';

const comp = JSON.parse(readFileSync('data/backtest-comparison-1yr.json', 'utf8'));
console.log('Comparison file loaded.');
