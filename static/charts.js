/* Canvas renderers. All colours come from CSS variables so light/dark themes just work. */
(function (root) {
  'use strict';
  let C = {};
  function refreshColors() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    C = { bull: g('--bull'), bear: g('--bear'), ink: g('--ink'), ink2: g('--ink2'), ink3: g('--ink3'), line: g('--line'), line2: g('--line2'), card: g('--card'), amber: g('--amber'), blue: g('--blue'), bg: g('--bg') };
  }
  const fmt = (p) => (p >= 1000 ? p.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p.toFixed(2));
  const FONT = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';

  function setup(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return null;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function alpha(hex, a) {
    // hex like #rrggbb or rgb(); returns rgba string
    if (hex[0] === '#') {
      let h = hex.slice(1); if (h.length === 3) h = h.split('').map((x) => x + x).join('');
      const n = parseInt(h, 16); return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
    const m = hex.match(/\d+(\.\d+)?/g); return m ? 'rgba(' + m[0] + ',' + m[1] + ',' + m[2] + ',' + a + ')' : hex;
  }

  // ---------------------------------------------------------------- candles + order block + plan
  function drawChart(canvas, res, raw, opt) {
    opt = opt || {};
    const big = !!opt.big;
    const s = setup(canvas); if (!s || !raw || !raw.length) return;
    const { ctx, w, h } = s;
    const k = raw.map((x) => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] || 0 }));
    const lastC = k[k.length - 1];
    if (res.ltp > 0) { lastC.c = res.ltp; lastC.h = Math.max(lastC.h, res.ltp); lastC.l = Math.min(lastC.l, res.ltp); }
    const n = k.length;
    const priceTxtLen = fmt(Math.max(res.ltp || 0, res.plan ? Math.max(res.plan.t2, res.plan.stop) : 0, 1)).length;
    const padL = big ? 10 : 4, padR = Math.ceil((priceTxtLen + 3) * (big ? 7 : 6.2) + 12), padT = big ? 16 : 8, padB = big ? 22 : 15;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const slots = Math.max(n + (big ? 14 : 9), 44);
    const cw = plotW / slots;
    let lo = Infinity, hi = -Infinity;
    for (const c of k) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
    const p = res.plan, ob = res.ob;
    if (p) { lo = Math.min(lo, p.stop, p.entry); hi = Math.max(hi, p.entry, p.t1, p.t2); lo = Math.min(lo, p.t2); }
    if (big && res.pools) for (const q of res.pools) { if (q.p > lo - (hi - lo) * 0.08 && q.p < hi + (hi - lo) * 0.08) { lo = Math.min(lo, q.p); hi = Math.max(hi, q.p); } }
    const pad = (hi - lo) * 0.07 || 0.5; lo -= pad; hi += pad;
    const Y = (v) => padT + ((hi - v) / (hi - lo)) * plotH;
    const X = (i) => padL + (i + 0.5) * cw;
    const right = padL + plotW;

    // grid
    ctx.font = '10.5px ' + FONT; ctx.textBaseline = 'middle';
    ctx.strokeStyle = alpha(C.line, 0.7); ctx.lineWidth = 1;
    const gridN = big ? 5 : 3;
    for (let i = 0; i <= gridN; i++) {
      const v = lo + ((hi - lo) * i) / gridN, y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(right, y); ctx.stroke();
      if (big) { ctx.fillStyle = C.ink3; ctx.textAlign = 'left'; ctx.fillText(fmt(v), right + 6, y); }
    }
    // volume profile (left, thin)
    const pr = res.profile;
    if (pr && !opt.noProfile) {
      const maxW = plotW * (big ? 0.14 : 0.16);
      for (let b = 0; b < pr.bins; b++) {
        const pl = pr.lo + b * pr.step, ph = pl + pr.step;
        const y1 = Y(ph), y2 = Y(pl), t = pr.buy[b] + pr.sell[b], bw = (t / pr.max) * maxW;
        ctx.fillStyle = alpha(pr.buy[b] >= pr.sell[b] ? C.bull : C.bear, t / pr.max > 0.7 ? 0.38 : 0.2);
        ctx.fillRect(padL, y1 + 0.5, bw, Math.max(1, y2 - y1 - 1));
      }
    }
    // order block zone
    if (ob) {
      const x0 = X(ob.i) - cw / 2, y1 = Y(ob.hi), y2 = Y(ob.lo);
      const col = ob.dir === 1 ? C.bull : C.bear;
      ctx.fillStyle = alpha(col, 0.17); ctx.fillRect(x0, y1, right - x0, Math.max(2, y2 - y1));
      ctx.strokeStyle = alpha(col, 0.65); ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y1 + 0.5, right - x0, Math.max(2, y2 - y1));
      ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.font = '700 10px ' + FONT;
      ctx.fillText(ob.kind === 'opening' ? 'OR' : 'OB', x0 + 4, (ob.dir === 1 ? y2 + 8 : y1 - 8));
      ctx.font = '10.5px ' + FONT;
    }
    // VWAP
    if (res.vwap && !opt.noVwap) {
      const Engine = root.Engine; const vw = Engine.vwapSeries(k);
      ctx.strokeStyle = alpha(C.blue, 0.85); ctx.lineWidth = 1.3; ctx.setLineDash([4, 3]); ctx.beginPath();
      vw.forEach((v, i) => { const x = X(i), y = Y(v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]);
      if (big) { ctx.fillStyle = C.blue; ctx.textAlign = 'left'; ctx.fillText('VWAP', X(n - 1) + 8, Y(vw[n - 1]) + (res.ltp > vw[n - 1] ? 11 : -11)); }
    }
    // liquidity pools (detail view only)
    const labels = [];
    if (big && opt.pools && res.pools) {
      const vis = res.pools.filter((q) => q.p >= lo && q.p <= hi).sort((a, b) => a.p - b.p);
      const merged = [];
      for (const q of vis) {
        const m = merged[merged.length - 1];
        if (m && Math.abs(Y(q.p) - Y(m.p)) < 5) { if (q.w > m.w) merged[merged.length - 1] = q; } else merged.push(q);
      }
      let lastY = -99;
      for (const q of merged.sort((a, b) => Y(a.p) - Y(b.p))) {
        const y = Y(q.p);
        ctx.strokeStyle = alpha(C.amber, 0.55); ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(right, y); ctx.stroke(); ctx.setLineDash([]);
        const ty = Math.max(y - 6, lastY + 11); lastY = ty;
        ctx.fillStyle = C.amber; ctx.textAlign = 'left'; ctx.font = '600 10px ' + FONT;
        ctx.fillText(q.label, padL + plotW * 0.15 + 4, ty); ctx.font = '10.5px ' + FONT;
      }
    }
    // candles
    const bw = Math.max(1.4, cw * 0.62);
    for (let i = 0; i < n; i++) {
      const c = k[i], up = c.c >= c.o, col = up ? C.bull : C.bear, x = X(i);
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, Y(c.h)); ctx.lineTo(Math.round(x) + 0.5, Y(c.l)); ctx.stroke();
      const y1 = Y(Math.max(c.o, c.c)), y2 = Y(Math.min(c.o, c.c));
      ctx.fillStyle = col; ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
    }
    // plan lines
    if (p) {
      const lines = [
        { v: p.stop, t: 'SL', c: C.bear, dash: [5, 3] },
        { v: p.entry, t: 'EN', c: C.ink2, dash: [1, 3] },
        { v: p.t1, t: 'T1', c: C.bull, dash: [5, 3] },
        { v: p.t2, t: 'T2', c: C.bull, dash: [5, 3] },
      ];
      for (const L of lines) {
        const y = Y(L.v);
        ctx.strokeStyle = alpha(L.c, 0.8); ctx.lineWidth = 1; ctx.setLineDash(L.dash);
        ctx.beginPath(); ctx.moveTo(padL + plotW * 0.12, y); ctx.lineTo(right, y); ctx.stroke(); ctx.setLineDash([]);
        labels.push({ y, text: L.t + ' ' + fmt(L.v), color: L.c });
      }
    }
    // price tag
    const ly = Y(lastC.c);
    ctx.strokeStyle = alpha(C.ink, 0.45); ctx.setLineDash([1, 3]); ctx.beginPath(); ctx.moveTo(X(n - 1), ly); ctx.lineTo(right, ly); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = C.card; ctx.strokeStyle = C.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(n - 1), ly, 4, 0, 6.3); ctx.fill(); ctx.stroke();
    labels.push({ y: ly, text: fmt(lastC.c), color: C.ink, tag: true });
    // label layout (avoid overlap)
    labels.sort((a, b) => a.y - b.y);
    const gap = big ? 14 : 12;
    for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < gap) labels[i].y = labels[i - 1].y + gap;
    ctx.font = '600 ' + (big ? 11 : 10) + 'px ' + FONT; ctx.textAlign = 'left';
    for (const L of labels) {
      if (L.tag) {
        const tw = ctx.measureText(L.text).width + 10;
        ctx.fillStyle = C.ink; rr(ctx, right + 3, L.y - 8, tw, 16, 5); ctx.fill();
        ctx.fillStyle = C.bg; ctx.fillText(L.text, right + 8, L.y + 0.5);
      } else { ctx.fillStyle = L.color; ctx.fillText(L.text, right + 5, L.y + 0.5); }
    }
    // time axis
    ctx.font = '10px ' + FONT; ctx.fillStyle = C.ink3; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    let lastX = -99;
    for (let i = 0; i < n; i++) {
      const pt = root.Engine.istParts(k[i].t);
      if (pt.m === 0 && (big || pt.h % 2 === 0 || n < 40)) { const x = X(i); if (x - lastX > 46) { ctx.fillText(String(pt.h).padStart(2, '0') + ':00', x, h - 4); lastX = x; } }
    }
    // crosshair (big)
    if (big && opt.hoverX != null && opt.hoverX > padL && opt.hoverX < right) {
      const i = Math.max(0, Math.min(n - 1, Math.floor((opt.hoverX - padL) / cw)));
      const c = k[i], x = X(i);
      ctx.strokeStyle = alpha(C.ink, 0.35); ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke(); ctx.setLineDash([]);
      const txt = root.Engine.fmtTime(c.t) + '  O ' + fmt(c.o) + '  H ' + fmt(c.h) + '  L ' + fmt(c.l) + '  C ' + fmt(c.c) + '  V ' + Math.round(c.v).toLocaleString('en-IN');
      ctx.font = '600 11px ' + FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(txt).width + 14;
      ctx.fillStyle = alpha(C.card, 0.94); rr(ctx, padL + 6, 4, tw, 20, 6); ctx.fill();
      ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = C.ink; ctx.fillText(txt, padL + 13, 14.5);
    }
  }

  // ---------------------------------------------------------------- liquidity bricks
  function drawBricks(canvas, res) {
    const s = setup(canvas); if (!s) return;
    const { ctx, w, h } = s;
    const pr = res.profile; if (!pr) return;
    const bins = pr.bins, rowH = h / bins;
    const unit = 5, gap = 1.5, maxB = Math.floor((w - 10) / (unit + gap));
    for (let b = 0; b < bins; b++) {
      const y = h - (b + 1) * rowH;
      const t = pr.buy[b] + pr.sell[b]; if (t <= 0) continue;
      const frac = t / pr.max, nb = Math.max(1, Math.round(frac * maxB));
      const dom = pr.buy[b] >= pr.sell[b], share = Math.max(pr.buy[b], pr.sell[b]) / t;
      const major = Math.max(1, Math.round(nb * share)), minor = nb - major;
      const col = dom ? C.bull : C.bear, ocol = dom ? C.bear : C.bull;
      const a = 0.28 + 0.72 * Math.pow(frac, 1.4);
      const bh = Math.max(1.5, rowH - 1.6);
      for (let i = 0; i < major; i++) { ctx.fillStyle = alpha(col, a); ctx.fillRect(w - 5 - (i + 1) * (unit + gap) + gap, y + 0.8, unit, bh); }
      for (let i = 0; i < minor; i++) { ctx.fillStyle = alpha(ocol, 0.45); ctx.fillRect(5 + i * (unit + gap), y + 0.8, unit, bh); }
    }
    const Yp = (v) => h - ((Math.max(pr.lo, Math.min(pr.hi, v)) - pr.lo) / (pr.hi - pr.lo)) * h;
    if (res.ob) {
      const y1 = Yp(res.ob.hi), y2 = Yp(res.ob.lo), hh = Math.max(3, y2 - y1);
      ctx.save(); ctx.beginPath(); ctx.rect(0, y1, w, hh); ctx.clip();
      ctx.fillStyle = alpha(C.ink, 0.07); ctx.fillRect(0, y1, w, hh);
      ctx.strokeStyle = alpha(C.ink, 0.25); ctx.lineWidth = 1;
      for (let x = -hh; x < w + hh; x += 6) { ctx.beginPath(); ctx.moveTo(x, y1 + hh); ctx.lineTo(x + hh, y1); ctx.stroke(); }
      ctx.restore();
    }
    const ly = Yp(res.ltp);
    ctx.strokeStyle = alpha(C.ink, 0.8); ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(w, ly); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '600 11px ' + FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const txt = fmt(res.ltp), tw = ctx.measureText(txt).width + 12;
    ctx.fillStyle = C.ink; const ty = Math.max(30, Math.min(h - 20, ly - 9));
    rr(ctx, w - tw - 6, ty, tw, 18, 5); ctx.fill();
    ctx.fillStyle = C.bg; ctx.fillText(txt, w - tw, ty + 9.5);
  }

  // ---------------------------------------------------------------- swarm (all stocks)
  function drawSwarm(canvas, results) {
    const s = setup(canvas); if (!s) return;
    const { ctx, w, h } = s;
    const ok = results.filter((r) => r.status === 'ok');
    const mid = h * 0.55, padX = 20, plotW = w - padX * 2, r0 = Math.max(3, Math.min(5, w / 170));
    const colW = r0 * 2 + 1.2;
    ctx.strokeStyle = alpha(C.ink3, 0.5); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(padX, mid); ctx.lineTo(w - padX, mid); ctx.stroke();
    ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(w / 2, 8); ctx.lineTo(w / 2, h - 8); ctx.stroke(); ctx.setLineDash([]);
    const sv = (r) => (r.dir === 'bull' ? r.score : r.dir === 'bear' ? -r.score : Math.sign(r.bullScore - r.bearScore) * r.score * 0.45);
    const xOf = (v) => padX + ((v + 100) / 200) * plotW;
    const cols = {}, hits = [];
    const strong = new Set();
    const tops = [results.filter((r) => r.dir === 'bull' && r.status === 'ok').sort((a, b) => b.score - a.score).slice(0, 8), results.filter((r) => r.dir === 'bear' && r.status === 'ok').sort((a, b) => b.score - a.score).slice(0, 8)];
    tops.forEach((arr) => arr.forEach((r) => strong.add(r.sym)));
    const list = ok.filter((r) => !strong.has(r.sym)).sort((a, b) => Math.abs(sv(a)) - Math.abs(sv(b)));
    for (const r of list) {
      const v = sv(r), x0 = xOf(v), ci = Math.round(x0 / colW);
      const cnt = (cols[ci] = (cols[ci] || 0) + 1);
      const up = v >= 0 ? (cnt % 2 === 1 || r.dir === 'bull') : (r.dir === 'chop' ? cnt % 2 === 1 : false);
      const yy = mid + (up ? -1 : 1) * (Math.ceil(cnt / (r.dir === 'chop' ? 2 : 1)) * colW * 0.92 - colW * 0.2);
      const x = ci * colW;
      ctx.fillStyle = r.dir === 'bull' ? alpha(C.bull, 0.82) : r.dir === 'bear' ? alpha(C.bear, 0.82) : alpha(C.ink3, 0.42);
      ctx.beginPath(); ctx.arc(x, yy, r0, 0, 6.3); ctx.fill();
      hits.push({ x, y: yy, r: r0 + 2, res: r });
    }
    // strongest: ringed dots along the baseline at each end
    tops.forEach((arr, side) => {
      arr.forEach((r, i) => {
        const x = side === 0 ? w - padX - 6 - i * (r0 * 3.6) : padX + 6 + i * (r0 * 3.6), y = mid;
        const col = side === 0 ? C.bull : C.bear;
        ctx.strokeStyle = alpha(col, 0.65); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r0 * 1.7, 0, 6.3); ctx.stroke();
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r0 * 0.9, 0, 6.3); ctx.fill();
        hits.push({ x, y, r: r0 * 1.9, res: r });
      });
    });
    canvas._hits = hits;
  }

  root.Charts = { refreshColors, drawChart, drawBricks, drawSwarm, fmt };
})(typeof window !== 'undefined' ? window : globalThis);
