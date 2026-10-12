/*
 * BlockRadar engine: Order Block + Liquidity scoring for intraday 5-minute candles.
 *
 * Concepts (Smart-Money-style, rule based, fully transparent):
 *  - Order block (OB): the last opposite-coloured candle before a displacement move (a strong candle
 *    that also breaks recent structure). Bullish OB = last down candle before an up-impulse.
 *  - Liquidity pool: price levels where stop orders likely rest - prior day high/low, day high/low,
 *    equal highs/lows and untouched swing highs/lows.
 *  - Sweep: wick through a pool that closes back inside (stop hunt) - often precedes reversals.
 *  - Volume profile: volume traded at each price today, split buy/sell by where each candle closed.
 *
 * Nothing here predicts the future. It ranks which stocks currently show the cleanest setup,
 * with a defined entry zone, stop and targets, so risk can be sized before entering.
 */
(function (root) {
  'use strict';

  const IST_MS = 330 * 60000;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

  function istParts(ms) {
    const d = new Date(ms + IST_MS);
    return { date: d.toISOString().slice(0, 10), h: d.getUTCHours(), m: d.getUTCMinutes() };
  }
  function fmtTime(ms) {
    const p = istParts(ms);
    return String(p.h).padStart(2, '0') + ':' + String(p.m).padStart(2, '0');
  }

  // Approximate cumulative share of a day's volume traded by N minutes after the 09:15 open (U-shaped).
  const VOL_CURVE = [[0, 0], [15, 0.10], [30, 0.17], [60, 0.28], [120, 0.44], [180, 0.58], [240, 0.72], [300, 0.87], [375, 1]];
  function expectedVolFrac(mins) {
    if (mins <= 0) return 0.02;
    if (mins >= 375) return 1;
    for (let i = 1; i < VOL_CURVE.length; i++) {
      const [m1, f1] = VOL_CURVE[i];
      if (mins <= m1) {
        const [m0, f0] = VOL_CURVE[i - 1];
        return f0 + ((mins - m0) / (m1 - m0)) * (f1 - f0);
      }
    }
    return 1;
  }

  const OPTS = {
    minCandles: 1,        // rank from the very first candle (09:15)
    fullCandles: 8,       // below this many candles (40 min) a setup is flagged EARLY and scored more cautiously
    earlyCap: 72,         // early setups can never score above this
    earlyMinScore: 34,    // early scores are mechanically lower (no swing structure yet), so the bar is lower
    earlyTop: 25,         // ...and while the session is young only the strongest N per side are kept
    swingK: 2,            // fractal width for swing points
    dispAtr1: 1.3,        // single candle displacement, in ATR
    dispAtr2: 1.9,        // two candle displacement, in ATR
    bosLookback: 6,
    obMaxWidthAtr: 1.2,
    obMinWidthAtr: 0.3,
    stopBufferAtr: 0.25,   // stop sits this far beyond the zone edge
    minRiskAtr: 0.5,       // never risk less than half an ATR (noise would stop you out)
    minRiskPct: 0.0015,    // ...or less than 0.15% of price
    maxTargetAtr: 6,       // ignore liquidity further than 6 ATR away for intraday targets
    minScore: 50,
  };

  // ---------- candle helpers ----------
  function toCandles(arr) {
    return arr.map((x) => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] || 0 }));
  }
  function trueRanges(c) {
    return c.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)) : x.h - x.l));
  }
  function atrAt(tr, i, n) {
    n = n || 14;
    const s = Math.max(0, i - n + 1);
    let sum = 0;
    for (let k = s; k <= i; k++) sum += tr[k];
    return sum / (i - s + 1);
  }
  // Early in the session there are few candles, so blend observed ATR with a daily-ATR-based estimate.
  function blendAtr(tr, i, hint) {
    const a = atrAt(tr, i);
    if (!hint) return a;
    const w = Math.min(1, (i + 1) / OPTS.fullCandles);
    return w * a + (1 - w) * hint;
  }
  function vwapSeries(c) {
    let pv = 0, vv = 0;
    return c.map((x) => {
      const tp = (x.h + x.l + x.c) / 3;
      const v = x.v > 0 ? x.v : 1;
      pv += tp * v; vv += v;
      return pv / vv;
    });
  }
  function swings(c, k) {
    const sh = [], sl = [];
    for (let p = k; p < c.length - k; p++) {
      let isH = true, isL = true;
      for (let q = 1; q <= k; q++) {
        if (!(c[p].h > c[p - q].h)) isH = false;
        if (!(c[p].h >= c[p + q].h)) isH = false;
        if (!(c[p].l < c[p - q].l)) isL = false;
        if (!(c[p].l <= c[p + q].l)) isL = false;
      }
      if (isH) sh.push({ i: p, p: c[p].h });
      if (isL) sl.push({ i: p, p: c[p].l });
    }
    return { sh, sl };
  }

  // ---------- order blocks ----------
  function findOrderBlocks(c, tr, hint) {
    const n = c.length, found = new Map();
    for (let j = 2; j < n; j++) {
      const atr = blendAtr(tr, j - 1, hint);
      if (!(atr > 0)) continue;
      for (const dir of [1, -1]) {
        let best = null;
        for (const m of [1, 2]) {
          const a = j - m + 1;
          if (a < 1) continue;
          let ok = true;
          for (let k = a; k <= j; k++) if (sign(c[k].c - c[k].o) !== dir) { ok = false; break; }
          if (!ok) continue;
          const move = dir === 1 ? c[j].c - c[a].o : c[a].o - c[j].c;
          if (move < (m === 1 ? OPTS.dispAtr1 : OPTS.dispAtr2) * atr) continue;
          const lb = Math.max(0, a - OPTS.bosLookback);
          let broke = true;
          if (dir === 1) { let hh = -Infinity; for (let k = lb; k < a; k++) hh = Math.max(hh, c[k].h); broke = a === lb ? true : c[j].c > hh; }
          else { let ll = Infinity; for (let k = lb; k < a; k++) ll = Math.min(ll, c[k].l); broke = a === lb ? true : c[j].c < ll; }
          if (!broke) continue;
          if (Math.abs(c[j].c - c[j].o) < 0.5 * (c[j].h - c[j].l)) continue; // body must dominate
          best = { a, m, move };
          break;
        }
        if (!best) continue;
        let o = -1;
        for (let i = best.a - 1; i >= Math.max(0, best.a - 6); i--) {
          if (sign(c[i].c - c[i].o) === -dir) { o = i; break; }
        }
        if (o < 0) continue;
        let lo, hi;
        lo = c[o].l; hi = c[o].h;                         // full range of the origin candle
        const minW = OPTS.obMinWidthAtr * atr, maxW = OPTS.obMaxWidthAtr * atr;
        if (hi - lo < minW) { if (dir === 1) hi = lo + minW; else lo = hi - minW; }
        if (hi - lo > maxW) { if (dir === 1) lo = hi - maxW; else hi = lo + maxW; }
        // mitigation / touches over completed candles after the displacement
        let valid = true, touches = 0, inTouch = false;
        for (let k = j + 1; k < n; k++) {
          if (dir === 1 && c[k].c < lo) { valid = false; break; }
          if (dir === -1 && c[k].c > hi) { valid = false; break; }
          if (k < n - 1) {
            const hit = c[k].l <= hi && c[k].h >= lo;
            if (hit && !inTouch) touches++;
            inTouch = hit;
          }
        }
        let vsum = 0, vcnt = 0;
        for (let k = Math.max(0, best.a - 12); k < best.a; k++) { vsum += c[k].v; vcnt++; }
        let dv = 0;
        for (let k = best.a; k <= j; k++) dv += c[k].v;
        const volRatio = vcnt && vsum > 0 ? dv / best.m / (vsum / vcnt) : 1;
        const ob = {
          dir, i: o, a: best.a, j, lo, hi, atr, strength: best.move / atr, volRatio,
          touches, valid, age: n - 1 - j, t: c[o].t,
        };
        const key = dir + ':' + o;
        const prev = found.get(key);
        if (!prev || ob.strength > prev.strength) found.set(key, ob);
      }
    }
    return Array.from(found.values());
  }

  function pickOB(obs, dir, ltp, atr) {
    let bestOb = null, bestCost = Infinity;
    for (const ob of obs) {
      if (ob.dir !== dir || !ob.valid) continue;
      let dist;
      if (dir === 1) dist = ltp >= ob.hi ? (ltp - ob.hi) / atr : ltp >= ob.lo ? 0 : -(ob.lo - ltp) / atr;
      else dist = ltp <= ob.lo ? (ob.lo - ltp) / atr : ltp <= ob.hi ? 0 : -(ltp - ob.hi) / atr;
      if (dist < -0.6 || dist > 7) continue;
      const cost = Math.max(dist, 0) + 0.45 * ob.touches - 0.3 * Math.min(ob.strength, 3) + ob.age * 0.01;
      if (cost < bestCost) { bestCost = cost; bestOb = ob; }
    }
    return bestOb;
  }

  // ---------- liquidity ----------
  function liquidityPools(c, sw, daily, atr) {
    const pools = [];
    const n = c.length;
    const last = c[n - 1].c;
    let dh = -Infinity, dl = Infinity;
    for (const x of c) { dh = Math.max(dh, x.h); dl = Math.min(dl, x.l); }
    if (daily && daily.pdh) pools.push({ p: daily.pdh, label: 'PDH', kind: 'prior', w: 3 });
    if (daily && daily.pdl) pools.push({ p: daily.pdl, label: 'PDL', kind: 'prior', w: 3 });
    pools.push({ p: dh, label: 'Day high', kind: 'day', w: 2 });
    pools.push({ p: dl, label: 'Day low', kind: 'day', w: 2 });
    const tol = Math.max(last * 0.0008, 0.2 * atr);
    const unsweptH = sw.sh.filter((s) => { for (let k = s.i + 1; k < n; k++) if (c[k].h > s.p) return false; return true; });
    const unsweptL = sw.sl.filter((s) => { for (let k = s.i + 1; k < n; k++) if (c[k].l < s.p) return false; return true; });
    const cluster = (arr, hi) => {
      const s = arr.map((x) => x.p).sort((a, b) => a - b);
      const groups = [];
      for (const p of s) {
        const g = groups[groups.length - 1];
        if (g && Math.abs(p - g[g.length - 1]) <= tol) g.push(p); else groups.push([p]);
      }
      for (const g of groups) {
        if (g.length >= 2) pools.push({ p: hi ? Math.max(...g) : Math.min(...g), label: hi ? 'Equal highs' : 'Equal lows', kind: 'equal', w: 2.5 });
        else pools.push({ p: g[0], label: hi ? 'Swing high' : 'Swing low', kind: 'swing', w: 1 });
      }
    };
    cluster(unsweptH, true);
    cluster(unsweptL, false);
    return pools.filter((x) => isFinite(x.p) && x.p > 0);
  }

  function findSweeps(c, sw, daily) {
    const n = c.length, out = { sell: null, buy: null }; // sell-side swept => bullish; buy-side swept => bearish
    for (let k = Math.max(3, n - 24); k < n; k++) {
      const cd = c[k], rng = cd.h - cd.l || 1e-9;
      const lows = sw.sl.filter((s) => s.i < k - 2).map((s) => s.p);
      if (daily && daily.pdl) lows.push(daily.pdl);
      let mn = Infinity; for (let q = 0; q < k; q++) mn = Math.min(mn, c[q].l);
      lows.push(mn);
      for (const L of lows) {
        if (cd.l < L && cd.c > L && (cd.c - cd.l) / rng >= 0.5) { out.sell = { k, level: L, age: n - 1 - k }; }
      }
      const highs = sw.sh.filter((s) => s.i < k - 2).map((s) => s.p);
      if (daily && daily.pdh) highs.push(daily.pdh);
      let mx = -Infinity; for (let q = 0; q < k; q++) mx = Math.max(mx, c[q].h);
      highs.push(mx);
      for (const H of highs) {
        if (cd.h > H && cd.c < H && (cd.h - cd.c) / rng >= 0.5) { out.buy = { k, level: H, age: n - 1 - k }; }
      }
    }
    return out;
  }

  // ---------- volume profile ----------
  function volumeProfile(c, bins) {
    bins = bins || 32;
    let lo = Infinity, hi = -Infinity;
    for (const x of c) { lo = Math.min(lo, x.l); hi = Math.max(hi, x.h); }
    if (!(hi > lo)) hi = lo + 0.01;
    const step = (hi - lo) / bins;
    const buy = new Array(bins).fill(0), sell = new Array(bins).fill(0);
    for (const x of c) {
      const v = x.v > 0 ? x.v : 1;
      const rng = x.h - x.l;
      const bf = rng > 0 ? clamp((x.c - x.l) / rng, 0.05, 0.95) : 0.5;
      const b0 = clamp(Math.floor((x.l - lo) / step), 0, bins - 1);
      const b1 = clamp(Math.floor((x.h - lo) / step - 1e-9), 0, bins - 1);
      const span = b1 - b0 + 1;
      for (let b = b0; b <= b1; b++) { buy[b] += (v / span) * bf; sell[b] += (v / span) * (1 - bf); }
    }
    let poc = 0, mx = 0, tot = 0;
    for (let b = 0; b < bins; b++) { const t = buy[b] + sell[b]; tot += t; if (t > mx) { mx = t; poc = b; } }
    return { lo, hi, step, bins, buy, sell, max: mx, total: tot, poc, pocPrice: lo + (poc + 0.5) * step };
  }
  function volumeInZone(prof, zlo, zhi) {
    let s = 0;
    for (let b = 0; b < prof.bins; b++) {
      const bl = prof.lo + b * prof.step, bh = bl + prof.step;
      const ov = Math.max(0, Math.min(bh, zhi) - Math.max(bl, zlo));
      if (ov > 0) s += ((prof.buy[b] + prof.sell[b]) * ov) / prof.step;
    }
    return prof.total ? s / prof.total : 0;
  }

  // ---------- main per-stock analysis ----------
  function dailyStats(dailyArr, sessionDate) {
    if (!dailyArr || !dailyArr.length) return null;
    const prior = dailyArr.filter((d) => d[0] < sessionDate);
    if (!prior.length) return null;
    const last = prior[prior.length - 1];
    const vols = prior.slice(-20).map((d) => d[5]).filter((v) => v > 0);
    const trs = prior.slice(-15).map((d, i, a) => (i ? Math.max(d[2] - d[3], Math.abs(d[2] - a[i - 1][4]), Math.abs(d[3] - a[i - 1][4])) : d[2] - d[3])).slice(1);
    return { pdh: last[2], pdl: last[3], pc: last[4], avgVol: mean(vols), atrD: mean(trs), date: last[0] };
  }

  function analyzeStock(stock, rawCandles, dailyArr, quote, ctx) {
    ctx = ctx || {};
    const out = {
      sym: stock.sym, key: stock.key, name: stock.name || stock.sym, sector: stock.sector || 'OTHERS', lot: stock.lot || 0,
      status: 'ok', dir: 'none', score: 0, bullScore: 0, bearScore: 0,
    };
    if (!rawCandles || rawCandles.length < OPTS.minCandles) { out.status = 'warming'; out.n = rawCandles ? rawCandles.length : 0; return out; }
    const c = toCandles(rawCandles);
    const n = c.length;
    const sessionDate = istParts(c[0].t).date;
    const dstat = dailyStats(dailyArr, sessionDate);
    const ltp = quote && quote.ltp > 0 ? quote.ltp : c[n - 1].c;
    let pc = dstat ? dstat.pc : 0;
    if (quote && quote.ltp > 0 && isFinite(quote.chg)) pc = quote.ltp - quote.chg;
    if (!(pc > 0)) pc = c[0].o;
    const chg = ltp - pc, chgPct = (chg / pc) * 100;

    const early = n < OPTS.fullCandles;
    const tr = trueRanges(c);
    const atrHint = early && dstat && dstat.atrD > 0 ? dstat.atrD * 0.115 : 0;   // typical 5-min range is ~1/sqrt(75) of the daily range
    const atr = blendAtr(tr, n - 1, atrHint);
    if (!(atr > 0) || atr / ltp < 0.0006) { out.status = 'flat'; out.ltp = ltp; out.chg = chg; out.chgPct = chgPct; return out; }
    const vw = vwapSeries(c);
    const vwap = vw[n - 1];
    const dayOpen = c[0].o;
    const sw = swings(c, OPTS.swingK);
    const obs = findOrderBlocks(c, tr, atrHint);
    const pools = liquidityPools(c, sw, dstat, atr);
    const sweeps = findSweeps(c, sw, dstat);
    const prof = volumeProfile(c, 32);

    // volume & strength context
    let cumVol = 0; for (const x of c) cumVol += x.v;
    const p0 = istParts(c[0].t), pN = istParts(c[n - 1].t);
    let minsSinceOpen = clamp((pN.h * 60 + pN.m + 5) - (9 * 60 + 15), 5, 375);
    if (ctx.nowMs && ctx.nowMs - c[n - 1].t >= 0 && ctx.nowMs - c[n - 1].t < 6 * 60000) minsSinceOpen = clamp((ctx.nowMs - c[0].t) / 60000, 1, 375);   // live: real elapsed time
    const expected = dstat && dstat.avgVol > 0 ? dstat.avgVol * expectedVolFrac(minsSinceOpen) : 0;
    const rv = expected > 0 ? clamp(cumVol / expected, 0, 6) : 1;
    const idxPct = ctx.indexPct || 0;
    const sectorChg = ctx.sectorChg && ctx.sectorChg[out.sector] !== undefined ? ctx.sectorChg[out.sector] : 0;
    const bq = quote && quote.bq ? quote.bq : 0, sq = quote && quote.sq ? quote.sq : 0;
    const imb = bq + sq > 0 ? (bq - sq) / (bq + sq) : 0;

    // chop detection
    const w = Math.min(n - 1, 24);
    let path = 0; for (let i = n - w; i < n; i++) path += Math.abs(c[i].c - c[i - 1].c);
    const er = path > 0 ? Math.abs(c[n - 1].c - c[n - 1 - w].c) / path : 0;   // efficiency ratio, last ~2 hours
    let cross = 0;
    for (let i = Math.max(1, n - 24); i < n; i++) if (sign(c[i].c - vw[i]) !== sign(c[i - 1].c - vw[i - 1]) && sign(c[i].c - vw[i]) !== 0) cross++;
    const choppy = !early && (cross >= 6 || er < 0.07);   // not enough candles to call chop early on

    const lastSH = sw.sh.slice(-2), lastSL = sw.sl.slice(-2);
    const HH = lastSH.length === 2 && lastSH[1].p > lastSH[0].p, LH = lastSH.length === 2 && lastSH[1].p < lastSH[0].p;
    const HL = lastSL.length === 2 && lastSL[1].p > lastSL[0].p, LL = lastSL.length === 2 && lastSL[1].p < lastSL[0].p;
    const vwapUp = vw[n - 1] > vw[Math.max(0, n - 7)], vwapDn = vw[n - 1] < vw[Math.max(0, n - 7)];

    function evaluate(dir) {
      const d = dir;
      const sc = { trend: 0, ob: 0, liq: 0, flow: 0, entry: 0 };
      const reasons = [];
      // trend (25)
      if (d * (ltp - vwap) > 0) sc.trend += 7;
      if (d * (ltp - dayOpen) > 0) sc.trend += 4;
      const s1 = d === 1 ? HH : LL, s2 = d === 1 ? HL : LH;
      sc.trend += s1 && s2 ? 7 : s1 || s2 ? 3 : 0;
      if (d === 1 ? vwapUp : vwapDn) sc.trend += 4;
      sc.trend += clamp((d * chgPct) / 1.0, 0, 1) * 3;

      let ob = pickOB(obs, d, ltp, atr);
      if (!ob && early) {
        // Before a real order block exists, use the first 5-minute candle as an "opening block":
        // upper half for longs (breakout retest), lower half for shorts.
        const c0 = c[0], mid = (c0.h + c0.l) / 2;
        let lo = d === 1 ? mid : c0.l, hi = d === 1 ? c0.h : mid;
        const minW = OPTS.obMinWidthAtr * atr, maxW = OPTS.obMaxWidthAtr * atr;
        if (hi - lo < minW) { if (d === 1) hi = lo + minW; else lo = hi - minW; }
        if (hi - lo > maxW) { if (d === 1) lo = hi - maxW; else hi = lo + maxW; }
        ob = { dir: d, i: 0, a: 0, j: 0, lo, hi, atr, strength: 1, volRatio: Math.max(0.6, rv), touches: 0, valid: true, age: n - 1, t: c0.t, kind: 'opening' };
      }
      let plan = null, state = 'none';
      if (ob) {
        // OB quality (25)
        sc.ob += clamp(ob.strength / 3, 0, 1) * 10 + clamp((ob.volRatio - 0.8) / 2, 0, 1) * 6;
        sc.ob += ob.touches === 0 ? 5 : ob.touches === 1 ? 3 : 1;
        sc.ob += ob.age <= 12 ? 4 : ob.age <= 30 ? 2 : 1;
        // trade plan
        const entry = clamp(ltp, ob.lo, ob.hi);
        let stop = d === 1 ? ob.lo - OPTS.stopBufferAtr * atr : ob.hi + OPTS.stopBufferAtr * atr;
        let risk = d === 1 ? entry - stop : stop - entry;
        const riskFloor = Math.max(OPTS.minRiskAtr * atr, OPTS.minRiskPct * entry);
        if (risk < riskFloor) { risk = riskFloor; stop = d === 1 ? entry - risk : entry + risk; }
        const gainMin = Math.max(0.8 * risk, 0.3 * atr);
        const ahead = pools.filter((x) => d * (x.p - entry) >= gainMin && d * (x.p - entry) <= OPTS.maxTargetAtr * atr).sort((a, b) => d * (a.p - b.p));
        let t1 = ahead[0] || null, t2 = null, t1Syn = false, t2Syn = false;
        if (!t1) { t1 = { p: entry + d * 1.2 * risk, label: '1.2R', kind: 'synthetic' }; t1Syn = true; }
        for (const x of ahead) { if (x !== t1 && d * (x.p - t1.p) >= 0.4 * atr && d * (x.p - entry) >= 1.8 * risk) { t2 = x; break; } }
        if (!t2) {
          const p25 = entry + d * 2.5 * risk, beyond = t1.p + d * 0.6 * risk;
          t2 = { p: d === 1 ? Math.max(p25, beyond) : Math.min(p25, beyond), label: '2.5R', kind: 'synthetic' }; t2Syn = true;
        }
        const rr = (d * (t2.p - entry)) / risk;
        const dist = (d * (ltp - entry)) / atr;
        state = dist <= 0.12 ? 'in-zone' : dist <= 1.5 ? 'approaching' : 'extended';
        if (d * (ltp - stop) <= 0) state = 'stopped';
        else if (d * (ltp - t1.p) >= 0) state = 'missed';
        plan = { entry, stop, t1: t1.p, t1Label: t1.label, t2: t2.p, t2Label: t2.label, t1Syn, t2Syn, rr, risk, riskPct: (risk / entry) * 100, distAtr: dist };
        // entry readiness (15)
        sc.entry += state === 'in-zone' ? 8 : dist <= 0.5 ? 6 : dist <= 1 ? 4 : dist <= 2 ? 2 : 0;
        sc.entry += clamp((rr - 1) / 2.5, 0, 1) * 7;
        // liquidity (20)
        const sw_ = d === 1 ? sweeps.sell : sweeps.buy;
        if (sw_) sc.liq += sw_.age <= 12 ? 9 : 5;
        sc.liq += clamp(((d * (t2.p - entry)) / atr) / 4, 0, 1) * 8;
        if (!t2Syn) sc.liq += 3;
        // reasons
        const nm = d === 1 ? 'Bullish' : 'Bearish';
        if (ob.kind === 'opening') reasons.push(nm + ' opening block ' + ob.lo.toFixed(2) + '-' + ob.hi.toFixed(2) + ' (from the first 5-minute candle). Not a confirmed order block yet.');
        else reasons.push(nm + ' order block ' + ob.lo.toFixed(2) + '-' + ob.hi.toFixed(2) + ': ' + ob.strength.toFixed(1) + 'x ATR impulse on ' + ob.volRatio.toFixed(1) + 'x volume, ' + (ob.touches === 0 ? 'untested' : 'tested ' + ob.touches + 'x') + '.');
        if (sw_) reasons.push((d === 1 ? 'Sell-side' : 'Buy-side') + ' liquidity at ' + sw_.level.toFixed(2) + ' was swept ' + sw_.age + ' candles ago, then price reclaimed it.');
        reasons.push('Next liquidity target ' + t1.p.toFixed(2) + (t1Syn ? ' (1.2R)' : ' (' + t1.label + ')') + ', then ' + t2.p.toFixed(2) + (t2Syn ? ' (2.5R)' : ' (' + t2.label + ')') + '.');
      }
      // flow (15)
      sc.flow += clamp((rv - 0.8) / 1.6, 0, 1) * 7;
      sc.flow += clamp((d * (chgPct - idxPct)) / 1.5, 0, 1) * 4;
      sc.flow += clamp((d * sectorChg) / 1.0, 0, 1) * 2;
      sc.flow += clamp(d * imb, 0, 1) * 2;
      if (d * (ltp - vwap) > 0) reasons.unshift('Price ' + (d === 1 ? 'above' : 'below') + ' VWAP ' + vwap.toFixed(2) + (s1 && s2 ? ' with ' + (d === 1 ? 'higher highs and higher lows' : 'lower highs and lower lows') + '.' : '.'));
      if (rv >= 1.3) reasons.push('Volume running at ' + rv.toFixed(1) + 'x normal for this time of day.');
      if (d * (chgPct - idxPct) > 0.5) reasons.push((d === 1 ? 'Outperforming' : 'Underperforming') + ' Nifty by ' + Math.abs(chgPct - idxPct).toFixed(1) + '%.');

      let total = sc.trend + sc.ob + sc.liq + sc.flow + sc.entry;
      if (choppy) total -= 12;
      if (early) total = Math.min(total, OPTS.earlyCap);       // thin data: never rate an early setup as top conviction
      if (!ob) total = Math.min(total, 40);
      if (state === 'stopped') total = Math.min(total, 30);
      else if (state === 'missed') total -= 15;
      else if (state === 'extended') total -= 4;
      return { total: clamp(Math.round(total), 0, 99), sc, ob, plan, state, reasons };
    }

    const B = evaluate(1), S = evaluate(-1);
    const best = B.total >= S.total ? B : S;
    const dir = best === B ? 'bull' : 'bear';
    out.bullScore = B.total; out.bearScore = S.total;
    out.dir = best.total >= (early ? OPTS.earlyMinScore : OPTS.minScore) && best.ob ? dir : 'chop';
    out.score = best.total;
    out.parts = best.sc;
    out.ob = best.ob; out.plan = best.plan; out.state = best.state; out.reasons = best.reasons;
    out.ltp = ltp; out.chg = chg; out.chgPct = chgPct; out.pc = pc;
    out.vwap = vwap; out.atr = atr; out.rv = rv; out.rs = chgPct - idxPct; out.choppy = choppy; out.er = er; out.crossings = cross;
    out.pools = pools; out.sweeps = sweeps; out.profile = prof; out.pdh = dstat ? dstat.pdh : null; out.pdl = dstat ? dstat.pdl : null;
    out.obVolShare = best.ob ? volumeInZone(prof, best.ob.lo, best.ob.hi) : 0;
    out.sessionDate = sessionDate; out.lastT = c[n - 1].t; out.n = n; out.imb = imb;
    out.conv = clamp(Math.round(out.score / 20), 1, 5);
    out.early = early; out.opening = !!(best.ob && best.ob.kind === 'opening');
    out.warnings = [];
    if (early) out.warnings.push('Early session: only ' + n + ' candle' + (n > 1 ? 's' : '') + ' so far, so this is less reliable. Treat it as a watchlist and wait for about 09:55 IST to confirm.');
    if (best.plan && best.plan.rr < 1.5) out.warnings.push('Reward to risk is below 1:1.5. Consider skipping.');
    if (choppy) out.warnings.push('Price keeps crossing VWAP. This stock is choppy right now.');
    if (rv < 0.6 && dstat) out.warnings.push('Volume is thin versus normal.');
    if (best.state === 'extended') out.warnings.push('Price already ran away from the zone. Wait for a pullback.');
    if (best.state === 'missed') out.warnings.push('First target already reached. The easy part of the move is done.');
    if (best.state === 'stopped') out.warnings.push('Price is beyond the stop. Setup is invalid.');
    return out;
  }

  // ---------- universe level ----------
  function analyzeUniverse(stocks, scan, quotes, indexQuote, opts) {
    const idxPct = indexQuote && isFinite(indexQuote.chgPct) ? indexQuote.chgPct : 0;
    // first pass: sector average change from quotes (needs pc = ltp - net_change)
    const secAgg = {};
    for (const s of stocks) {
      const q = quotes && quotes[s.key];
      if (q && q.ltp > 0 && isFinite(q.chg)) {
        const pc = q.ltp - q.chg;
        if (pc > 0) { const a = (secAgg[s.sector] = secAgg[s.sector] || { sum: 0, n: 0 }); a.sum += (q.chg / pc) * 100; a.n++; }
      }
    }
    const sectorChg = {};
    for (const k in secAgg) sectorChg[k] = secAgg[k].sum / secAgg[k].n;
    const ctx = { indexPct: idxPct, sectorChg, nowMs: opts && opts.nowMs };

    const results = [];
    for (const s of stocks) {
      const cand = scan.candles[s.key];
      results.push(analyzeStock(s, cand, scan.daily ? scan.daily[s.key] : null, quotes ? quotes[s.key] : null, ctx));
    }
    // Early in the session scores are compressed, so stay selective by rank rather than by absolute score.
    for (const side of ['bull', 'bear']) {
      results.filter((r) => r.status === 'ok' && r.early && r.dir === side).sort((a, b) => b.score - a.score).slice(OPTS.earlyTop).forEach((r) => { r.dir = 'chop'; });
    }
    const ok = results.filter((r) => r.status === 'ok');
    const bull = ok.filter((r) => r.dir === 'bull').sort((a, b) => b.score - a.score);
    const bear = ok.filter((r) => r.dir === 'bear').sort((a, b) => b.score - a.score);
    const sorted = ok.slice().sort((a, b) => b.score - a.score);
    sorted.forEach((r, i) => { r.pctile = ok.length > 1 ? (1 - i / (ok.length - 1)) * 100 : 100; });
    bull.forEach((r, i) => { r.rank = i + 1; r.rankOf = bull.length; });
    bear.forEach((r, i) => { r.rank = i + 1; r.rankOf = bear.length; });

    // sector board
    const secMap = {};
    for (const r of results) {
      if (r.ltp === undefined) continue;
      const a = (secMap[r.sector] = secMap[r.sector] || { name: r.sector, n: 0, sum: 0, adv: 0, dec: 0, bull: 0, bear: 0, best: null });
      a.n++; a.sum += r.chgPct; if (r.chgPct > 0) a.adv++; else if (r.chgPct < 0) a.dec++;
      if (r.dir === 'bull') a.bull++; if (r.dir === 'bear') a.bear++;
      if (!a.best || Math.abs(r.chgPct) > Math.abs(a.best.chgPct)) a.best = r;
    }
    const sectors = Object.values(secMap).map((a) => ({ name: a.name, n: a.n, chg: a.sum / a.n, adv: a.adv, dec: a.dec, bull: a.bull, bear: a.bear, best: a.best && a.best.sym })).sort((a, b) => b.chg - a.chg);

    return {
      results, bull, bear, sectors,
      meta: {
        scanned: results.length, ranked: ok.length, warming: results.filter((r) => r.status === 'warming').length,
        flat: results.filter((r) => r.status === 'flat').length, bullCount: bull.length, bearCount: bear.length,
        chop: ok.length - bull.length - bear.length, indexPct: idxPct, early: ok.filter((r) => r.early).length,
        adv: results.filter((r) => r.chgPct > 0).length, dec: results.filter((r) => r.chgPct < 0).length,
      },
    };
  }

  // light per-tick refresh: keeps ranks stable between scans, updates price-dependent fields only
  function liveUpdate(r, quote) {
    if (!quote || !(quote.ltp > 0) || r.status !== 'ok') return r;
    r.ltp = quote.ltp;
    if (isFinite(quote.chg)) { r.chg = quote.chg; const pc = quote.ltp - quote.chg; if (pc > 0) { r.pc = pc; r.chgPct = (quote.chg / pc) * 100; } }
    if (r.plan && r.atr) {
      const d = r.dir === 'bear' ? -1 : 1;
      const dist = (d * (r.ltp - r.plan.entry)) / r.atr;
      r.plan.distAtr = dist;
      let st = dist <= 0.12 ? 'in-zone' : dist <= 1.5 ? 'approaching' : 'extended';
      if (d * (r.ltp - r.plan.stop) <= 0) st = 'stopped';
      else if (d * (r.ltp - r.plan.t1) >= 0) st = 'missed';
      r.state = st;
    }
    return r;
  }

  const api = { OPTS, analyzeStock, analyzeUniverse, liveUpdate, toCandles, vwapSeries, volumeProfile, fmtTime, istParts, expectedVolFrac, dailyStats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
