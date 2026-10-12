// node tests/engine_test.js  -> sanity checks the engine on the synthetic market
global.window = global;
require('../static/universe.js');
const Engine = require('../static/engine.js');
const Demo = require('../static/demo.js');
const stocks = window.BR_UNIVERSE.map(([sym, key]) => ({ sym, key, sector: window.BR_SECTORS[sym] || 'OTHERS', lot: 0 }));
const M = Demo.create(stocks, { now: Date.parse('2026-10-09T08:00:00Z') });
let t0 = Date.now();
const scan = Demo.snapshot(M, stocks);
const q = Demo.quotes(M, stocks);
const res = Engine.analyzeUniverse(stocks, scan, q.data, q.index);
console.log('analysis ms', Date.now() - t0);
console.log(res.meta);
const bad = res.results.filter(r => r.status === 'ok' && [r.score, r.ltp, r.chgPct, r.vwap, r.atr].some(x => !isFinite(x)));
console.log('NaN results:', bad.length);
const planBad = res.results.filter(r => r.plan && [r.plan.entry, r.plan.stop, r.plan.t1, r.plan.t2, r.plan.rr].some(x => !isFinite(x)));
console.log('bad plans:', planBad.length);
const show = (r) => `${r.sym.padEnd(11)} ${r.dir} sc=${r.score} ${r.state} ltp=${r.ltp.toFixed(2)} chg=${r.chgPct.toFixed(2)}% zone=${r.ob.lo.toFixed(2)}-${r.ob.hi.toFixed(2)} stop=${r.plan.stop.toFixed(2)} t1=${r.plan.t1.toFixed(2)} t2=${r.plan.t2.toFixed(2)} rr=${r.plan.rr.toFixed(1)} risk=${r.plan.riskPct.toFixed(2)}% rv=${r.rv.toFixed(1)}`;
console.log('--- top bull'); res.bull.slice(0, 8).forEach(r => console.log(show(r)));
console.log('--- top bear'); res.bear.slice(0, 8).forEach(r => console.log(show(r)));
const regimes = {}; res.results.forEach(r => { if (r.status !== 'ok') return; const st = M.stocks[r.key].regime; (regimes[st] = regimes[st] || { n: 0, bull: 0, bear: 0, chop: 0 }); regimes[st].n++; regimes[st][r.dir]++; });
console.log('regime vs detection', regimes);
console.log('sectors', res.sectors.slice(0, 3).map(s => s.name + ' ' + s.chg.toFixed(2)), '...', res.sectors.slice(-2).map(s => s.name + ' ' + s.chg.toFixed(2)));
// advance several candles and verify stability
for (let i = 0; i < 5; i++) { Demo.advance(M, stocks); Demo.tick(M, stocks); }
const r2 = Engine.analyzeUniverse(stocks, Demo.snapshot(M, stocks), Demo.quotes(M, stocks).data, { chgPct: 0 });
console.log('after advance: bull', r2.meta.bullCount, 'bear', r2.meta.bearCount, 'chop', r2.meta.chop);
// early-session behaviour
const M2 = Demo.create(stocks, { now: Date.parse('2026-10-09T08:00:00Z'), startCandles: 5 });
const r3 = Engine.analyzeUniverse(stocks, Demo.snapshot(M2, stocks), Demo.quotes(M2, stocks).data, null);
console.log('5 candles -> warming', r3.meta.warming, 'ranked', r3.meta.ranked);
