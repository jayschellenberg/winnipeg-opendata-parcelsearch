// The percent-per-year market trend on the charts page (lib/salesCharts.js
// logTrend, 2026-11-01): the rate, its 95% range, and the refusal to call a
// trend that the sales cannot tell from zero.
//
// Run: cd web && node test/logTrend.test.js

import assert from 'node:assert/strict';
import { logTrend, logTrendWords, t975 } from '../src/lib/salesCharts.js';

const DAY = 86400000;
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

{
  const pts = Array.from({ length: 12 }, (_, i) => ({ x: i * 120 * DAY, y: 1000 * 1.1 ** ((i * 120) / 365) }));
  const lt = logTrend(pts);
  ok(Math.abs(lt.pctPerYear - 0.1) < 1e-9, 'a clean +10% a year is recovered');
  ok(lt.significant && logTrendWords(lt).startsWith('+10.0%/yr'), 'and stated with its range');
}
{
  let seed = 5;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const pts = Array.from({ length: 30 }, (_, i) => ({ x: i * 30 * DAY, y: 1000 * Math.exp((rnd() - 0.5) * 0.8) }));
  const lt = logTrend(pts);
  ok(!lt.significant && lt.lo < 0 && lt.hi > 0, 'a flat noisy market spans zero');
  ok(logTrendWords(lt).startsWith('no measurable trend'), 'and is not called a trend');
}
ok(logTrend([{ x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }]) === null, 'one date is not a trend');
ok(Math.abs(t975(10) - 2.228) < 1e-9, 't quantile');
console.log(`logTrend: ${n} assertions passed`);
