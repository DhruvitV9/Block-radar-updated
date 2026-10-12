/*
 * Demo market: synthetic, seeded 5-minute sessions for every symbol. NOT real prices.
 * It exists so you can see how the dashboard behaves and so the engine can be tested offline.
 */
(function (root) {
  'use strict';
  const IST_MS = 330 * 60000;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function gauss(r) { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  function lastWeekdayIST(nowMs) {
    let d = new Date(nowMs + IST_MS);
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() - 86400000);
    return d;
  }
  const dstr = (d) => d.toISOString().slice(0, 10);

  function create(stocks, opts) {
    opts = opts || {};
    const nowMs = opts.now || Date.now();
    const day = lastWeekdayIST(nowMs);
    const dayStr = dstr(day);
    const openMs = day.getTime() + (9 * 60 + 15) * 60000 - IST_MS; // 09:15 IST in UTC ms
    const startCandles = opts.startCandles || 46; // 09:15 .. ~13:05
    const maxCandles = 75;

    const M = { sessionDate: dayStr, n: startCandles, stocks: {}, idx: { pct: 0 }, version: 1 };

    stocks.forEach((s) => {
      const r = mulberry32(hashStr(s.sym + dayStr));
      const base = (root.BR_DEMO_PRICE && root.BR_DEMO_PRICE[s.sym]) || 100 + r() * 1500;
      const sigma = base * (0.0009 + r() * 0.0009);            // per-candle volatility
      const regimeR = r();
      const regime = regimeR < 0.13 ? 'upOB' : regimeR < 0.26 ? 'downOB' : regimeR < 0.36 ? 'up' : regimeR < 0.46 ? 'down' : 'chop';
      const gap = gauss(r) * 0.004;
      const pc = base;
      const open = pc * (1 + gap);
      const avgDailyVol = Math.round((200000 + r() * 6000000) * (1500 / Math.max(base, 50)) ** 0.3);
      const baseVol = avgDailyVol / 75;
      const candles = [];
      const impulseAt = 12 + Math.floor(r() * 12);
      let px = open;
      const total = maxCandles;
      const dir0 = regime === 'upOB' || regime === 'up' ? 1 : regime === 'downOB' || regime === 'down' ? -1 : 0;
      const ushape = (i) => 1.9 - 1.5 * Math.sin((Math.PI * (i + 3)) / (total + 6)) + (i > 66 ? 0.5 : 0);
      const pbStart = 28 + Math.floor(r() * 8), pbEnd = 47 + Math.floor(r() * 16);   // pullback window toward the order block
      let obPrice = open;
      const activity = Math.exp(gauss(r) * 0.35) * (regime === 'chop' ? 0.85 : 1.25);
      for (let i = 0; i < total; i++) {
        let drift = 0, vmul = 1;
        if (regime === 'upOB' || regime === 'downOB') {
          if (i < impulseAt) { drift = -dir0 * 0.06 * sigma + (r() - 0.5) * 0.2 * sigma; obPrice = px; }
          else if (i < impulseAt + 2) { drift = dir0 * (3.4 + r() * 1.4) * sigma; vmul = 3.2; }
          else if (i < pbStart) drift = dir0 * 0.16 * sigma;
          else if (i < pbEnd) drift = ((obPrice + dir0 * 0.35 * sigma - px) / (pbEnd - i)) * 0.95;   // glide back into the zone
          else drift = dir0 * 0.28 * sigma;                                                           // bounce off it
        } else if (regime === 'up' || regime === 'down') {
          drift = dir0 * 0.14 * sigma;
          if (i === impulseAt + 6) { drift = dir0 * 2.8 * sigma; vmul = 2.4; }
          if (i > 35 && i % 11 < 3) drift = -dir0 * 0.3 * sigma;
        } else {
          drift = -0.12 * (px - open) / 3 + 0;                  // mean reverting
        }
        const o = px;
        const c = Math.max(o + drift + gauss(r) * sigma * (vmul > 2 ? 0.3 : 0.85), 0.5);
        const wick = sigma * (0.3 + r() * 0.8);
        const h = Math.max(o, c) + wick * r() * (vmul > 2 ? 0.25 : 1);
        const l = Math.min(o, c) - wick * r() * (vmul > 2 ? 0.25 : 1);
        const v = Math.round(baseVol * activity * ushape(i) * vmul * Math.exp(gauss(r) * 0.35));
        candles.push({ t: openMs + i * 300000, o, h, l: Math.max(l, 0.1), c, v });
        px = c;
      }
      // daily context
      const daily = [];
      let dpx = pc * (1 - 0.03 + r() * 0.02);
      for (let k = 24; k >= 1; k--) {
        const dd = new Date(day.getTime() - k * 86400000);
        if (dd.getUTCDay() === 0 || dd.getUTCDay() === 6) continue;
        const o = dpx, c = o * (1 + gauss(r) * 0.012), hh = Math.max(o, c) * (1 + r() * 0.008), ll = Math.min(o, c) * (1 - r() * 0.008);
        daily.push([dstr(dd), o, hh, ll, c, Math.round(avgDailyVol * (0.8 + r() * 0.4))]);
        dpx = c;
      }
      // make last daily close equal prev close pc, and pdh/pdl bracket it
      const ld = daily[daily.length - 1];
      ld[4] = pc; ld[2] = Math.max(ld[2], pc * 1.006); ld[3] = Math.min(ld[3], pc * 0.992);
      M.stocks[s.key] = { sym: s.sym, candles, daily, pc, sigma, regime, r, live: candles[startCandles - 1].c, bias: dir0, avgDailyVol };
    });
    return M;
  }

  // Snapshot of the session as of candle count M.n (last candle is "live", partially formed)
  function snapshot(M, stocks) {
    const candles = {}, daily = {};
    stocks.forEach((s) => {
      const st = M.stocks[s.key];
      candles[s.key] = st.candles.slice(0, M.n).map((x, idx) => {
        if (idx === M.n - 1) return [x.t, x.o, Math.max(x.o, st.live, x.l), Math.min(x.o, st.live, x.h), st.live, Math.round(x.v * 0.5)];
        return [x.t, x.o, x.h, x.l, x.c, x.v];
      });
      daily[s.key] = st.daily;
    });
    return { version: M.version, sessionDate: M.sessionDate, live: true, candles, daily, ts: Date.now(), demo: true };
  }

  function quotes(M, stocks) {
    const q = {};
    let sum = 0, cnt = 0;
    stocks.forEach((s) => {
      const st = M.stocks[s.key];
      const ltp = st.live;
      const chg = ltp - st.pc;
      let vol = 0; for (let i = 0; i < M.n; i++) vol += st.candles[i].v;
      const skew = clamp01(0.5 + st.bias * 0.12 + (st.r() - 0.5) * 0.3);
      const tot = 400000 * (0.6 + st.r());
      q[s.key] = { ltp, chg, vol, bq: tot * skew, sq: tot * (1 - skew) };
      sum += (chg / st.pc) * 100; cnt++;
    });
    M.idx.pct = (sum / Math.max(cnt, 1)) * 0.6;
    return { data: q, index: { chgPct: M.idx.pct, name: 'NIFTY 50 (demo)' } };
  }
  const clamp01 = (x) => Math.max(0.05, Math.min(0.95, x));

  // advance the live price by one tick
  function tick(M, stocks) {
    stocks.forEach((s) => {
      const st = M.stocks[s.key];
      st.live = Math.max(st.live + gauss(st.r) * st.sigma * 0.18 + st.bias * st.sigma * 0.01, 0.5);
    });
  }
  // close the current candle and move to the next (accelerated clock in demo)
  function advance(M, stocks) {
    if (M.n >= 75) return false;
    M.n += 1;
    M.version += 1;
    stocks.forEach((s) => { const st = M.stocks[s.key]; st.live = st.candles[M.n - 1].o; });
    return true;
  }

  const api = { create, snapshot, quotes, tick, advance, mulberry32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Demo = api;
})(typeof window !== 'undefined' ? window : globalThis);
