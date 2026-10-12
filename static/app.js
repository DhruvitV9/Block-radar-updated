(function () {
  'use strict';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const E = window.Engine, Ch = window.Charts;

  // ------------------------------------------------------------------ state
  const BR = {
    mode: 'boot',               // boot | demo | live
    serverUp: false, status: {}, stocks: [], scan: null, quotes: {}, index: { chgPct: 0 },
    res: null, bySym: {}, tab: 'picks', n: { bull: 8, bear: 8 }, sort: { k: 'score', d: -1 }, filter: 'all', q: '', sector: '',
    open: null, nextAt: 0, demo: null, scanVersion: 0, hover: null, lastAnalysisAt: 0,
  };
  const SET = { capital: 100000, riskPct: 1, hideDead: true, theme: 'auto' };

  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  Object.assign(SET, store('br_settings') || {});
  const saveSet = () => store('br_settings', SET);

  const fmt = (p) => Ch.fmt(p);
  const sgn = (x, d) => (x >= 0 ? '+' : '') + x.toFixed(d === undefined ? 2 : d);
  const rrTxt = (x) => '1:' + x.toFixed(1);
  const inr = (x) => '\u20B9' + Math.round(x).toLocaleString('en-IN');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATE = { 'in-zone': 'In zone', approaching: 'Approaching', extended: 'Extended', missed: 'Target hit', stopped: 'Stopped out' };
  const istNow = () => new Date(Date.now() + 330 * 60000).toISOString().slice(11, 19);
  const dead = (r) => r.state === 'stopped' || r.state === 'missed';

  async function getJSON(url, ms, opts) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 8000);
    try { const r = await fetch(url, Object.assign({ signal: ctl.signal, cache: 'no-store' }, opts || {})); if (!r.ok && r.status !== 202) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); }
  }

  // ------------------------------------------------------------------ theme
  function applyTheme() {
    const root = document.documentElement;
    if (SET.theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', SET.theme);
    Ch.refreshColors();
  }
  function toggleTheme() {
    const dark = SET.theme === 'dark' || (SET.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    SET.theme = dark ? 'light' : 'dark'; saveSet(); applyTheme(); redrawAll();
  }

  // ------------------------------------------------------------------ analysis
  function buildStocks() {
    BR.stocks = window.BR_UNIVERSE.map(([sym, key]) => ({ sym, key, sector: window.BR_SECTORS[sym] || 'OTHERS', lot: 0, name: sym }));
  }
  function runAnalysis() {
    if (!BR.scan) return;
    const t0 = performance.now();
    BR.res = E.analyzeUniverse(BR.stocks, BR.scan, BR.quotes, BR.index, { nowMs: BR.mode === 'live' ? Date.now() : undefined });
    BR.bySym = {}; BR.res.results.forEach((r) => { BR.bySym[r.sym] = r; });
    BR.lastAnalysisAt = Date.now();
    BR.analysisMs = performance.now() - t0;
    renderActive();
    if (BR.open) renderDetail(true);
    renderHeader();
  }
  function applyTick() {
    if (!BR.res) return;
    for (const r of BR.res.results) E.liveUpdate(r, BR.quotes[r.key]);
    updateLiveFields();
    redrawVisible();
    if (BR.open) renderDetail(false);
    if (BR.tab === 'all') renderTable();
    renderHeader();
  }

  // ------------------------------------------------------------------ header / banner
  function renderHeader() {
    const live = $('#live'), lt = $('#live-text'), st = BR.status || {};
    let state = 'demo', text = 'Demo data';
    if (BR.mode === 'live') {
      if (st.tokenOk === false) { state = 'error'; text = 'Reconnect Upstox'; }
      else if (BR.scan && !BR.scan.live) { state = 'closed'; text = 'Market closed \u00B7 ' + (BR.scan.sessionDate || ''); }
      else { state = 'live'; text = 'Live \u00B7 ' + istNow() + ' IST'; }
    } else if (BR.mode === 'demo') text = 'Demo \u00B7 simulated data';
    live.dataset.state = state; lt.textContent = text;

    const b = $('#banner'); let html = '';
    if (BR.mode === 'demo') {
      html = '<div class="banner-in"><span><b>Demo mode.</b> Every price here is simulated. Do not trade off this screen.</span><button class="btn small primary" data-act="settings">Login with Upstox</button></div>';
      b.className = 'banner';
    } else if (BR.mode === 'live' && st.tokenOk === false) {
      html = '<div class="banner-in"><span><b>Please log in to Upstox again.</b> Logins expire around 3:30 AM IST each day.</span><button class="btn small primary" data-act="relogin">Login with Upstox</button></div>';
      b.className = 'banner err';
    } else if (BR.mode === 'live' && BR.scan && !BR.scan.live) {
      html = '<div class="banner-in"><span><b>Market is closed.</b> Showing the last session (' + esc(BR.scan.sessionDate) + '). Signals refresh when NSE opens at 09:15 IST.</span></div>';
      b.className = 'banner';
    } else if (BR.res && BR.res.meta.early > BR.res.meta.ranked * 0.5) {
      html = '<div class="banner-in"><span><b>Early session.</b> Signals use only the first few 5-minute candles, so treat them as a watchlist, not entries. They firm up from about 09:55 IST.</span></div>';
      b.className = 'banner';
    }
    if (b.dataset.h !== html) { b.innerHTML = html; b.dataset.h = html; }
    // pulse strip
    if (BR.res && $('#pulse')) {
      const m = BR.res.meta, act = (a) => a.filter((r) => !dead(r)).length;
      const nx = Math.max(0, Math.round((BR.nextAt - Date.now()) / 1000));
      const items = [
        ['Stocks scanned', m.scanned, m.ranked + ' ranked'],
        ['Long setups', act(BR.res.bull), m.bullCount + ' with a zone'],
        ['Short setups', act(BR.res.bear), m.bearCount + ' with a zone'],
        ['Skipped as choppy', m.chop, 'no clean zone'],
        ['Nifty 50', sgn(m.indexPct) + '%', m.adv + ' up, ' + m.dec + ' down'],
        ['Next scan', nx ? Math.floor(nx / 60) + ':' + String(nx % 60).padStart(2, '0') : 'now', BR.mode === 'demo' ? 'demo clock runs fast' : 'after each 5-min candle'],
      ];
      const h = items.map((x, i) => '<div class="stat"><div class="k">' + x[0] + '</div><div class="v ' + (i === 4 ? (m.indexPct >= 0 ? 'bull' : 'bear') : '') + '">' + x[1] + '</div><div class="s">' + x[2] + '</div></div>').join('');
      if ($('#pulse').dataset.h !== h) { $('#pulse').innerHTML = h; $('#pulse').dataset.h = h; }
    }
  }

  // ------------------------------------------------------------------ views
  function renderActive() {
    ({ picks: renderPicks, liquidity: renderLiquidity, xray: renderXray, all: renderAllView, rules: () => {} }[BR.tab] || (() => {}))();
    redrawVisible();
  }
  function setTab(t, push) {
    if (!$('#view-' + t)) t = 'picks';
    BR.tab = t;
    $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + t));
    if (push !== false) history.replaceState(null, '', '#' + t);
    renderActive(); window.scrollTo({ top: 0 });
  }

  function ladder(r) {
    const p = r.plan; if (!p) return '';
    const span = p.t2 - p.stop || 1e-9, pos = (v) => Math.max(0, Math.min(100, ((v - p.stop) / span) * 100));
    return '<div class="ladder" aria-hidden="true"><div class="fill" data-f="fill" style="width:' + pos(r.ltp).toFixed(1) + '%"></div><i style="left:' + pos(p.entry).toFixed(1) + '%"></i><i style="left:' + pos(p.t1).toFixed(1) + '%"></i><i class="now" data-f="now" style="left:' + pos(r.ltp).toFixed(1) + '%"></i></div>';
  }
  function cardHTML(r) {
    const cls = r.dir, p = r.plan, ob = r.ob;
    return '<article class="card ' + cls + '" data-sym="' + esc(r.sym) + '" tabindex="0" role="button" aria-label="Open ' + esc(r.sym) + ' analysis">' +
      '<div class="card-grid"><div>' +
      '<div class="head"><span class="chip-sym">' + esc(r.sym.slice(0, 2)) + '</span><div><div class="sym">' + esc(r.sym) + '</div><div class="name">' + esc(r.sector) + ' \u00B7 #' + r.rank + ' of ' + r.rankOf + '</div></div></div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin:10px 0 8px;flex-wrap:wrap"><span class="pill ' + cls + '">' + (r.dir === 'bull' ? 'BULLISH' : 'BEARISH') + '</span><span class="ring" style="--p:' + r.score + '" title="Score ' + r.score + ' of 100"><span>' + r.score + '</span></span><span class="state" data-f="state" data-s="' + r.state + '">' + STATE[r.state] + '</span>' + (r.early ? '<span class="state" style="border-style:dashed" title="Fewer than 8 candles so far, so less reliable">Early</span>' : '') + '</div>' +
      '<div class="pct ' + (r.chgPct >= 0 ? 'bull' : 'bear') + '" data-f="pct">' + sgn(r.chgPct) + '%</div>' +
      '<div class="px"><span data-f="ltp">\u20B9' + fmt(r.ltp) + '</span> <span data-f="chg" class="' + (r.chg >= 0 ? 'bull' : 'bear') + '">' + sgn(r.chg) + '</span></div></div>' +
      '<canvas class="mini" data-kind="mini" data-sym="' + esc(r.sym) + '" role="img" aria-label="' + esc(r.sym) + ' five minute chart with order block"></canvas></div>' +
      '<div class="metrics">' +
      '<div><small>Stop</small><b>' + fmt(p.stop) + '</b></div><div><small>Entry zone</small><b>' + fmt(ob.lo) + '-' + fmt(ob.hi) + '</b></div><div><small>Target 1</small><b>' + fmt(p.t1) + '</b></div><div><small>Target 2</small><b>' + fmt(p.t2) + '</b></div><div><small>Risk</small><b>' + p.riskPct.toFixed(2) + '%</b></div><div><small>Reward:risk</small><b>' + rrTxt(p.rr) + '</b></div></div>' +
      ladder(r) + '</article>';
  }
  function featureHTML(r, title) {
    if (!r) return '<div class="empty">No clean ' + title.toLowerCase() + ' setup right now. Skipping a trade is a valid decision.</div>';
    const p = r.plan, cls = r.dir;
    return '<section class="feature ' + cls + '" data-sym="' + esc(r.sym) + '">' +
      '<div class="feature-top"><div><div class="muted" style="font-weight:700;font-size:13px">' + title + '</div><div class="big" style="margin-top:6px">' + esc(r.sym) + '</div><div class="name">' + esc(r.sector) + ' \u00B7 score ' + r.score + ' \u00B7 <span data-f="state-txt">' + STATE[r.state] + '</span>' + (r.early ? ' \u00B7 early' : '') + '</div></div>' +
      '<div style="text-align:right"><div class="pct ' + (r.chgPct >= 0 ? 'bull' : 'bear') + '" data-f="pct">' + sgn(r.chgPct) + '%</div><div class="px" data-f="ltp">\u20B9' + fmt(r.ltp) + '</div></div></div>' +
      '<canvas data-kind="feature" data-sym="' + esc(r.sym) + '" role="img" aria-label="' + esc(r.sym) + ' chart"></canvas>' +
      '<div class="plan-row"><div><small>Stop</small><b>' + fmt(p.stop) + '</b></div><div><small>Entry</small><b>' + fmt(p.entry) + '</b></div><div><small>Target 1</small><b>' + fmt(p.t1) + '</b></div><div><small>Target 2</small><b>' + fmt(p.t2) + '</b></div><div><small>Reward:risk</small><b>' + rrTxt(p.rr) + '</b></div></div></section>';
  }
  function renderPicks() {
    const R = BR.res; if (!R) return;
    const keep = (a) => (SET.hideDead ? a.filter((r) => !dead(r)) : a);
    const bull = keep(R.bull), bear = keep(R.bear);
    const pickBest = (a) => a.find((r) => r.state === 'in-zone' || r.state === 'approaching') || a[0];
    $('#feature').innerHTML = featureHTML(pickBest(bull), 'Best long right now') + featureHTML(pickBest(bear), 'Best short right now');
    const col = (a, k, label, cls) => {
      const shown = a.slice(0, BR.n[k]);
      return '<div><div class="col-h"><h3 class="' + cls + '">' + label + ' <span class="faint" style="font-weight:600;font-size:14px">' + a.length + ' setups</span></h3></div>' +
        (shown.length ? shown.map(cardHTML).join('') : '<div class="empty">No ' + label.toLowerCase() + ' setups pass the filters right now.</div>') +
        (a.length > BR.n[k] ? '<button class="more" data-more="' + k + '">Show ' + Math.min(10, a.length - BR.n[k]) + ' more</button>' : '') + '</div>';
    };
    $('#lists').innerHTML = col(bull, 'bull', 'Bullish', 'bull') + col(bear, 'bear', 'Bearish', 'bear');
    $('#hide-dead').checked = SET.hideDead;
  }
  function renderLiquidity() {
    const R = BR.res; if (!R) return;
    const keep = (a) => (SET.hideDead ? a.filter((r) => !dead(r)) : a);
    const tile = (r, i) => '<div class="tile ' + r.dir + '" data-sym="' + esc(r.sym) + '" tabindex="0" role="button" aria-label="Open ' + esc(r.sym) + '"><canvas data-kind="brick" data-sym="' + esc(r.sym) + '"></canvas>' +
      '<div class="lab"><b>' + esc(r.sym) + '</b><span class="' + (r.chgPct >= 0 ? 'bull' : 'bear') + '" data-f="pct">' + sgn(r.chgPct) + '%</span></div><div class="rk">' + String(i + 1).padStart(2, '0') + '</div>' +
      '<div class="dots">' + [1, 2, 3, 4, 5].map((d) => '<i class="' + (d <= r.conv ? 'on' : '') + '"></i>').join('') + '</div></div>';
    const b = keep(R.bull).slice(0, 12), s = keep(R.bear).slice(0, 12);
    $('#tiles').innerHTML = (b.length ? b.map(tile).join('') : '') + '<div class="divider">Bearish side</div>' + (s.length ? s.map(tile).join('') : '<div class="empty" style="grid-column:1/-1">No bearish setups right now.</div>');
  }
  function renderXray() {
    const R = BR.res; if (!R) return;
    const secs = R.sectors, lead = secs[0], lag = secs[secs.length - 1];
    $('#xray-l').innerHTML = '<span class="bear">Bearish side' + (lag ? ' \u00B7 weakest sector ' + esc(lag.name) + ' ' + sgn(lag.chg) + '%' : '') + '</span><span class="bull">' + (lead ? 'Strongest sector ' + esc(lead.name) + ' ' + sgn(lead.chg) + '%' : '') + ' \u00B7 Bullish side</span>';
    $('#secs').innerHTML = secs.map((s) => {
      const t = s.adv + s.dec || 1;
      return '<div class="sec"><div class="sec-top"><span>' + esc(s.name) + '</span><span class="num ' + (s.chg >= 0 ? 'bull' : 'bear') + '">' + sgn(s.chg) + '%</span></div>' +
        '<div class="sec-bar" title="' + s.adv + ' advancing, ' + s.dec + ' declining"><i class="a" style="width:' + ((s.adv / t) * 100).toFixed(1) + '%"></i><i class="d" style="width:' + ((s.dec / t) * 100).toFixed(1) + '%"></i></div>' +
        '<small>' + s.n + ' stocks \u00B7 ' + s.bull + ' long \u00B7 ' + s.bear + ' short setups</small></div>';
    }).join('');
  }
  function sortVal(r, k) {
    switch (k) {
      case 'sym': return r.sym; case 'sector': return r.sector; case 'ltp': return r.ltp; case 'chgPct': return r.chgPct; case 'score': return r.score;
      case 'dir': return r.dir === 'bull' ? 1 : r.dir === 'bear' ? -1 : 0; case 'rr': return r.plan ? r.plan.rr : -1; case 'rv': return r.rv || 0;
      case 'state': return ['in-zone', 'approaching', 'extended', 'missed', 'stopped'].indexOf(r.state); default: return 0;
    }
  }
  function renderAllView() {
    const sel = $('#sec-filter');
    if (sel && !sel.dataset.ok && BR.res) { sel.innerHTML = '<option value="">All sectors</option>' + BR.res.sectors.map((s) => '<option>' + esc(s.name) + '</option>').join(''); sel.dataset.ok = 1; }
    renderTable();
  }
  function renderTable() {
    const R = BR.res; if (!R || BR.tab !== 'all') return;
    let rows = R.results.filter((r) => r.status === 'ok');
    if (BR.filter === 'bull') rows = rows.filter((r) => r.dir === 'bull'); else if (BR.filter === 'bear') rows = rows.filter((r) => r.dir === 'bear'); else if (BR.filter === 'chop') rows = rows.filter((r) => r.dir === 'chop');
    if (BR.sector) rows = rows.filter((r) => r.sector === BR.sector);
    if (BR.q) rows = rows.filter((r) => r.sym.toLowerCase().includes(BR.q.toLowerCase()));
    const k = BR.sort.k, d = BR.sort.d;
    rows.sort((a, b) => { const x = sortVal(a, k), y = sortVal(b, k); return (x < y ? -1 : x > y ? 1 : 0) * d; });
    $$('#tbl th').forEach((th) => { th.removeAttribute('aria-sort'); if (th.dataset.k === k) th.setAttribute('aria-sort', d > 0 ? 'ascending' : 'descending'); });
    $('#tbody').innerHTML = rows.map((r) => '<tr data-sym="' + esc(r.sym) + '"><td class="sym-c">' + esc(r.sym) + '</td><td>' + esc(r.sector) + '</td><td class="num">' + fmt(r.ltp) + '</td><td class="num ' + (r.chgPct >= 0 ? 'bull' : 'bear') + '">' + sgn(r.chgPct) + '%</td>' +
      '<td><span class="tag ' + r.dir + '">' + (r.dir === 'bull' ? 'LONG' : r.dir === 'bear' ? 'SHORT' : 'CHOPPY') + '</span></td><td class="num">' + r.score + '</td><td>' + (r.plan && r.dir !== 'chop' ? STATE[r.state] + (r.early ? ' (early)' : '') : '') + '</td>' +
      '<td class="num">' + (r.ob && r.dir !== 'chop' ? fmt(r.ob.lo) + '-' + fmt(r.ob.hi) : '') + '</td><td class="num">' + (r.plan && r.dir !== 'chop' ? fmt(r.plan.stop) : '') + '</td><td class="num">' + (r.plan && r.dir !== 'chop' ? fmt(r.plan.t2) : '') + '</td><td class="num">' + (r.plan && r.dir !== 'chop' ? rrTxt(r.plan.rr) : '') + '</td><td class="num">' + (r.rv ? r.rv.toFixed(1) + 'x' : '') + '</td></tr>').join('');
    $('#row-count').textContent = rows.length + ' stocks';
  }

  // ------------------------------------------------------------------ live field updates (no DOM rebuild)
  function updateLiveFields() {
    $$('[data-sym]').forEach((el) => {
      if (el.tagName === 'CANVAS' || el.tagName === 'TR') return;
      const r = BR.bySym[el.dataset.sym]; if (!r || r.status !== 'ok') return;
      const set = (f, txt, cls) => { const x = $('[data-f="' + f + '"]', el); if (!x) return; if (x.textContent !== txt) x.textContent = txt; if (cls) x.className = cls; };
      const pc = r.chgPct >= 0 ? 'bull' : 'bear';
      const pctEl = $('[data-f="pct"]', el);
      if (pctEl) { pctEl.textContent = sgn(r.chgPct) + '%'; pctEl.className = (pctEl.className.includes('pct') ? 'pct ' : '') + pc; }
      set('ltp', '\u20B9' + fmt(r.ltp));
      const chg = $('[data-f="chg"]', el); if (chg) { chg.textContent = sgn(r.chg); chg.className = pc; }
      const st = $('[data-f="state"]', el); if (st) { st.textContent = STATE[r.state]; st.dataset.s = r.state; }
      set('state-txt', STATE[r.state]);
      if (r.plan) {
        const span = r.plan.t2 - r.plan.stop || 1e-9, pos = Math.max(0, Math.min(100, ((r.ltp - r.plan.stop) / span) * 100));
        const now = $('[data-f="now"]', el), fill = $('[data-f="fill"]', el);
        if (now) now.style.left = pos.toFixed(1) + '%'; if (fill) fill.style.width = pos.toFixed(1) + '%';
      }
    });
  }
  function inView(el) { const b = el.getBoundingClientRect(); return b.bottom > -50 && b.top < innerHeight + 50 && b.width > 0; }
  function drawCanvas(cv) {
    const r = BR.bySym[cv.dataset.sym]; if (!r || r.status !== 'ok') return;
    const raw = BR.scan.candles[r.key]; const k = cv.dataset.kind;
    if (k === 'mini') Ch.drawChart(cv, r, raw, {}); else if (k === 'feature') Ch.drawChart(cv, r, raw, { big: true, noProfile: false }); else if (k === 'brick') Ch.drawBricks(cv, r);
  }
  function redrawVisible() {
    if (!BR.res) return;
    $$('canvas[data-kind]').forEach((cv) => { if (cv.offsetParent !== null && inView(cv)) drawCanvas(cv); });
    const sw = $('#swarm'); if (sw && sw.offsetParent !== null) Ch.drawSwarm(sw, BR.res.results);
  }
  function redrawAll() { renderActive(); if (BR.open) renderDetail(true); }

  // ------------------------------------------------------------------ detail dialog
  function openStock(sym) {
    const r = BR.bySym[sym]; if (!r) return;
    BR.open = sym; BR.hover = null;
    const d = $('#dlg-stock'); renderDetail(true);
    if (!d.open) d.showModal();
    setTimeout(() => renderDetail(false), 30);
  }
  function renderDetail(full) {
    const r = BR.bySym[BR.open]; if (!r) return;
    const d = $('#dlg-stock');
    if (full || !$('#dlg-body').dataset.sym || $('#dlg-body').dataset.sym !== r.sym) {
      const p = r.plan, ob = r.ob, dirTxt = r.dir === 'bull' ? 'Bullish' : r.dir === 'bear' ? 'Bearish' : 'No clean setup';
      const pools = (r.pools || []).filter((q) => Math.abs(q.p - r.ltp) < r.atr * 8).sort((a, b) => b.p - a.p);
      $('#dlg-body').dataset.sym = r.sym;
      $('#dlg-body').innerHTML = '<div class="dlg-top"><div><div class="head"><span class="chip-sym" style="background:' + (r.dir === 'bear' ? 'var(--bear)' : r.dir === 'bull' ? 'var(--bull)' : 'var(--ink3)') + '">' + esc(r.sym.slice(0, 2)) + '</span><div><div class="sym" style="font-size:28px">' + esc(r.sym) + '</div><div class="name">' + esc(r.sector) + (r.lot ? ' \u00B7 lot ' + r.lot : '') + '</div></div></div></div>' +
        '<div style="text-align:right;padding-right:44px"><div class="pct ' + (r.chgPct >= 0 ? 'bull' : 'bear') + '" id="d-pct">' + sgn(r.chgPct) + '%</div><div class="px" id="d-ltp">\u20B9' + fmt(r.ltp) + '</div></div></div>' +
        '<button class="icon-btn x" data-act="close-dlg" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
        '<canvas id="d-chart" role="img" aria-label="Detailed chart"></canvas>' +
        '<div class="dlg-grid"><div>' +
        '<h3>' + dirTxt + ' \u00B7 score ' + r.score + '/100 <span class="state" id="d-state" data-s="' + r.state + '" style="vertical-align:middle">' + (r.plan ? STATE[r.state] : '') + '</span></h3>' +
        (p && r.dir !== 'chop' ? '<div class="kv" style="margin-top:12px"><span>Entry zone</span><b>' + fmt(ob.lo) + ' - ' + fmt(ob.hi) + '</b><span>Planned entry</span><b>' + fmt(p.entry) + '</b><span>Stop loss</span><b class="bear">' + fmt(p.stop) + '</b><span>Target 1 (' + esc(p.t1Label) + ')</span><b class="bull">' + fmt(p.t1) + '</b><span>Target 2 (' + esc(p.t2Label) + ')</span><b class="bull">' + fmt(p.t2) + '</b><span>Risk per share</span><b>' + fmt(p.risk) + ' (' + p.riskPct.toFixed(2) + '%)</b><span>Reward to risk (T2)</span><b>' + rrTxt(p.rr) + '</b><span>VWAP</span><b>' + fmt(r.vwap) + '</b><span>Relative volume</span><b>' + (r.rv ? r.rv.toFixed(1) + 'x' : 'n/a') + '</b><span>Money inside zone</span><b>' + (r.obVolShare * 100).toFixed(0) + '% of day volume</b></div>' : '<p class="muted">This stock has no clean order block with room to run. Better to look elsewhere.</p>') +
        '<h3 style="margin-top:18px;font-size:16px">Why it ranks here</h3><ul class="reasons">' + (r.reasons || []).map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' +
        (r.warnings && r.warnings.length ? '<div class="warn"><b>Watch out:</b> ' + r.warnings.map(esc).join(' ') + '</div>' : '') +
        (pools.length ? '<h3 style="margin-top:18px;font-size:16px">Nearby liquidity</h3><div class="kv" style="margin-top:8px">' + pools.slice(0, 7).map((q) => '<span>' + esc(q.label) + '</span><b class="' + (q.p > r.ltp ? 'bull' : 'bear') + '">' + fmt(q.p) + '</b>').join('') + '</div>' : '') +
        '</div><div>' + (p && r.dir !== 'chop' ? calcHTML(r) : '') + '<p class="faint" style="font-size:12.5px;margin-top:12px">Rule-based analysis of 5-minute candles. It ranks setups; it does not know what happens next. Always place the stop.</p></div></div>';
      bindCalc(r);
      const cv = $('#d-chart');
      cv.onmousemove = (e) => { const b = cv.getBoundingClientRect(); BR.hover = e.clientX - b.left; drawDetailChart(); };
      cv.onmouseleave = () => { BR.hover = null; drawDetailChart(); };
      cv.ontouchmove = (e) => { const b = cv.getBoundingClientRect(); BR.hover = e.touches[0].clientX - b.left; drawDetailChart(); };
    } else {
      const pc = $('#d-pct'); if (pc) { pc.textContent = sgn(r.chgPct) + '%'; pc.className = 'pct ' + (r.chgPct >= 0 ? 'bull' : 'bear'); }
      const lt = $('#d-ltp'); if (lt) lt.textContent = '\u20B9' + fmt(r.ltp);
      const st = $('#d-state'); if (st && r.plan) { st.textContent = STATE[r.state]; st.dataset.s = r.state; }
    }
    drawDetailChart();
  }
  function drawDetailChart() {
    const r = BR.bySym[BR.open]; const cv = $('#d-chart'); if (!r || !cv || !BR.scan) return;
    Ch.drawChart(cv, r, BR.scan.candles[r.key], { big: true, pools: true, hoverX: BR.hover });
  }
  function calcHTML(r) {
    return '<div class="calc"><h3 style="font-size:16px">Size the trade before you take it</h3>' +
      '<label for="c-cap">Trading capital (\u20B9)</label><input id="c-cap" type="number" min="0" step="1000" value="' + SET.capital + '">' +
      '<label for="c-risk">Maximum loss on this trade (% of capital)</label><input id="c-risk" type="number" min="0.1" max="5" step="0.1" value="' + SET.riskPct + '">' +
      '<label for="c-lot">Lot size (F&amp;O contract)</label><input id="c-lot" type="number" min="1" step="1" value="' + (r.lot || '') + '" placeholder="' + (r.lot ? '' : 'enter lot size from Upstox') + '">' +
      '<div class="res" id="c-res"></div><button class="btn small" style="margin-top:10px" data-act="copy-plan">Copy plan</button></div>';
  }
  function bindCalc(r) {
    const upd = () => {
      const cap = +$('#c-cap').value || 0, rk = +$('#c-risk').value || 0, lot = Math.round(+$('#c-lot').value || 0);
      SET.capital = cap; SET.riskPct = rk; saveSet();
      const maxLoss = cap * rk / 100, per = r.plan.risk, qty = Math.floor(maxLoss / per);
      let html = 'You accept losing at most <b>' + inr(maxLoss) + '</b>. Risk per share is <b>' + fmt(per) + '</b>.<br>';
      if (lot) {
        const lots = Math.floor(qty / lot), lossLot = per * lot;
        if (lots >= 1) html += 'You can take <b>' + lots + ' lot' + (lots > 1 ? 's' : '') + '</b> (' + (lots * lot) + ' qty). If the stop hits you lose about <b>' + inr(lots * lossLot) + '</b>; at Target 2 you make about <b>' + inr(lots * lot * Math.abs(r.plan.t2 - r.plan.entry)) + '</b>.';
        else html += '<span class="bear"><b>One lot risks ' + inr(lossLot) + '</b>, above your limit. Skip this stock, or pick one with a smaller lot value.</span>';
        html += '<br><span class="faint">1 lot is worth about ' + inr(r.plan.entry * lot) + '. Check required margin in Upstox.</span>';
      } else html += 'That is about <b>' + qty + ' shares</b>. Enter the lot size to see lots.';
      $('#c-res').innerHTML = html;
    };
    ['c-cap', 'c-risk', 'c-lot'].forEach((id) => $('#' + id).addEventListener('input', upd)); upd();
  }
  function copyPlan() {
    const r = BR.bySym[BR.open]; if (!r || !r.plan) return;
    const p = r.plan, t = r.sym + ' ' + (r.dir === 'bull' ? 'LONG' : 'SHORT') + ' | zone ' + fmt(r.ob.lo) + '-' + fmt(r.ob.hi) + ' | entry ' + fmt(p.entry) + ' | stop ' + fmt(p.stop) + ' | T1 ' + fmt(p.t1) + ' | T2 ' + fmt(p.t2) + ' | R:R ' + rrTxt(p.rr);
    try { navigator.clipboard.writeText(t); toast('Plan copied'); } catch (e) { toast('Copy not available here'); }
  }
  function toast(msg) {
    const t = document.createElement('div'); t.className = 'tip'; t.textContent = msg; t.style.left = '50%'; t.style.bottom = '30px'; t.style.transform = 'translateX(-50%)'; document.body.appendChild(t); setTimeout(() => t.remove(), 1600);
  }

  // ------------------------------------------------------------------ settings dialog
  function renderConn() {
    const st = BR.status || {}, conn = $('#conn');
    if (!BR.serverUp) {
      conn.innerHTML = '<p class="muted" style="margin:0">This page is running without the BlockRadar server, so it can only show demo data. Run the app (see README) or open your deployed link, and this panel will let you log in to Upstox.</p>';
      return;
    }
    const status = st.hasToken ? (st.tokenOk === false ? '<b class="bear">Your Upstox login expired or was rejected.</b> ' + esc(st.error || '') : '<b class="bull">Connected to Upstox.</b>') : 'Not connected yet.';
    let h = '<p class="muted" style="margin:0 0 12px">' + status + ' Upstox logins last until about 3:30 AM IST, so log in once each trading day.</p>';
    h += '<div class="calc" style="margin-bottom:12px"><div class="faint" style="font-size:12.5px;font-weight:700">Redirect URL for your Upstox app (copy it exactly)</div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:6px"><code id="ruri" style="flex:1;overflow-wrap:anywhere;padding:6px 8px">' + esc(st.redirectUri || '') + '</code><button class="btn small" data-act="copy-redirect">Copy</button></div>' +
      '<div class="faint" style="font-size:12.5px;margin-top:6px">At account.upstox.com/developer/apps open your app, paste this into <b>Redirect URL</b>, and save.</div></div>';
    if (st.oauthReady) {
      h += '<button class="btn primary" data-act="oauth-login" style="width:100%;padding:12px">Login with Upstox</button><div class="faint" style="font-size:12.5px;margin-top:6px">Using API key ' + esc(st.apiKeyHint) + '.' + (st.keysLocked ? ' (set by the server)' : ' <a href="#" data-act="change-keys">Change API key or secret</a>') + '</div>';
    } else {
      h += oauthForm();
    }
    h += '<details style="margin-top:14px"><summary style="cursor:pointer;font-weight:600">Or paste a token instead</summary><div style="display:flex;gap:8px;margin-top:8px"><input id="tok" type="password" autocomplete="off" placeholder="Paste Analytics Token or access token" style="flex:1"><button class="btn" data-act="save-token">Connect</button></div><div id="tok-msg" class="faint" style="margin-top:6px;font-size:13px"></div></details>';
    conn.innerHTML = h;
  }
  function oauthForm() {
    return '<div class="calc"><label for="ak" style="margin-top:0">API key (from your Upstox app)</label><input id="ak" type="text" autocomplete="off" spellcheck="false">' +
      '<label for="as">API secret</label><input id="as" type="password" autocomplete="off">' +
      '<button class="btn primary" data-act="save-oauth" style="margin-top:12px;width:100%">Save and continue</button><div id="ak-msg" class="faint" style="margin-top:6px;font-size:13px"></div></div>';
  }
  function openSettings() {
    $('#set-theme').value = SET.theme;
    $('#set-hide').checked = SET.hideDead;
    renderConn();
    $('#dlg-settings').showModal();
  }
  function oauthLogin() { location.href = '/login'; }
  async function saveOauth() {
    const msg = $('#ak-msg'); msg.textContent = 'Saving...'; msg.className = 'faint';
    try {
      const r = await fetch('/api/oauth/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: $('#ak').value.trim(), api_secret: $('#as').value.trim() }) });
      const j = await r.json();
      if (!j.ok) { msg.textContent = j.error || 'Could not save.'; msg.className = 'bear'; return; }
      BR.status = await getJSON('/api/status', 4000); renderConn();
    } catch (e) { msg.textContent = 'Could not reach the server.'; msg.className = 'bear'; }
  }
  function copyRedirect() {
    const t = $('#ruri').textContent;
    try { navigator.clipboard.writeText(t); toast('Redirect URL copied'); } catch (e) { toast('Select and copy it manually'); }
  }
  async function saveToken() {
    const tok = $('#tok').value.trim(), msg = $('#tok-msg');
    msg.textContent = 'Checking token with Upstox...'; msg.className = 'faint';
    try {
      const r = await fetch('/api/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok }) });
      const j = await r.json();
      if (j.ok) { msg.textContent = 'Connected. Scanning all F&O stocks now.'; msg.className = 'bull'; setTimeout(() => { $('#dlg-settings').close(); start(true); }, 900); }
      else { msg.textContent = j.error || 'Could not connect.'; msg.className = 'bear'; }
    } catch (e) { msg.textContent = 'Could not reach the local server.'; msg.className = 'bear'; }
  }

  // ------------------------------------------------------------------ data loops
  let timers = [];
  function clearTimers() { timers.forEach(clearInterval); timers = []; }
  function nextBoundary() { const t = new Date(Date.now() + 330 * 60000); const m = t.getUTCMinutes() % 5; return Date.now() + ((5 - m) * 60 - t.getUTCSeconds() + 8) * 1000; }

  function startDemo() {
    clearTimers(); BR.mode = 'demo'; $('#loading').classList.remove('on');
    buildStocks();
    const cq = parseInt(new URLSearchParams(location.search).get('candles'), 10);
    BR.demo = window.Demo.create(BR.stocks, cq > 0 ? { startCandles: Math.min(cq, 74) } : {});
    BR.scan = window.Demo.snapshot(BR.demo, BR.stocks);
    const q = window.Demo.quotes(BR.demo, BR.stocks); BR.quotes = q.data; BR.index = q.index;
    BR.nextAt = Date.now() + 30000;
    runAnalysis();
    timers.push(setInterval(() => {
      window.Demo.tick(BR.demo, BR.stocks);
      const q2 = window.Demo.quotes(BR.demo, BR.stocks); BR.quotes = q2.data; BR.index = q2.index;
      if (Date.now() >= BR.nextAt) {
        if (window.Demo.advance(BR.demo, BR.stocks)) { BR.scan = window.Demo.snapshot(BR.demo, BR.stocks); const q3 = window.Demo.quotes(BR.demo, BR.stocks); BR.quotes = q3.data; BR.index = q3.index; runAnalysis(); }
        BR.nextAt = Date.now() + 30000;
      } else applyTick();
    }, 2000));
    timers.push(setInterval(renderHeader, 1000));
  }

  async function liveLoop() {
    try {
      const L = await getJSON('/api/live', 8000);
      BR.status = L; BR.quotes = L.quotes || {}; if (L.index && L.index.chgPct !== undefined) BR.index = L.index;
      if (L.tokenOk === false) { $('#loading').classList.remove('on'); renderHeader(); return; }
      if (L.scanVersion > 0 && L.scanVersion !== BR.scanVersion) {
        const scan = await getJSON('/api/scan', 60000);
        if (scan && scan.candles) { BR.scan = scan; BR.scanVersion = scan.version; BR.nextAt = nextBoundary(); runAnalysis(); $('#loading').classList.remove('on'); }
      } else if (BR.res) applyTick();
      if (!BR.scan) {
        const p = L.progress || {};
        $('#loading').classList.add('on');
        $('#load-txt').textContent = p.phase === 'daily' ? 'Reading daily history: ' + p.done + ' of ' + p.total : p.phase === 'scan' ? 'Scanning 5-minute candles: ' + p.done + ' of ' + p.total : 'Connecting to Upstox...';
        $('#load-bar').style.width = (p.total ? Math.round((p.done / p.total) * 100) : 5) + '%';
      }
    } catch (e) { /* server briefly unavailable; keep last data */ }
  }

  async function start(force) {
    clearTimers(); buildStocks();
    let st = null;
    try { st = await getJSON('/api/status', 2500); BR.serverUp = !!(st && st.server); } catch (e) { BR.serverUp = false; }
    BR.status = st || {};
    if (BR.serverUp && st.hasToken && st.tokenOk !== false) {
      BR.mode = 'live';
      try { const u = await getJSON('/api/universe', 5000); const m = {}; u.forEach((x) => { m[x.sym] = x; }); BR.stocks = u.map((x) => ({ sym: x.sym, key: x.key, lot: x.lot || 0, sector: window.BR_SECTORS[x.sym] || 'OTHERS', name: x.sym })); } catch (e) { /* use built-in list */ }
      renderHeader(); await liveLoop();
      timers.push(setInterval(liveLoop, 3000));
      timers.push(setInterval(renderHeader, 1000));
      timers.push(setInterval(async () => { try { const u = await getJSON('/api/universe', 5000); u.forEach((x) => { const s = BR.stocks.find((y) => y.sym === x.sym); if (s && x.lot) s.lot = x.lot; }); if (BR.res) BR.res.results.forEach((r) => { const s = BR.stocks.find((y) => y.sym === r.sym); if (s) r.lot = s.lot; }); } catch (e) { /* ignore */ } }, 120000));
    } else {
      startDemo();
      if (BR.serverUp && st.hasToken && st.tokenOk === false) BR.status = st;
    }
  }

  // ------------------------------------------------------------------ events
  document.addEventListener('click', (e) => {
    const t = e.target;
    const act = t.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'settings') openSettings();
      else if (a === 'close-dlg') act.closest('dialog').close();
      else if (a === 'save-token') saveToken();
      else if (a === 'oauth-login') oauthLogin();
      else if (a === 'save-oauth') saveOauth();
      else if (a === 'copy-redirect') copyRedirect();
      else if (a === 'change-keys') { e.preventDefault(); $('#conn').insertAdjacentHTML('beforeend', oauthForm()); act.remove(); }
      else if (a === 'relogin') { (BR.status && BR.status.oauthReady) ? oauthLogin() : openSettings(); }
      else if (a === 'copy-plan') copyPlan();
      else if (a === 'theme') toggleTheme();
      return;
    }
    const tab = t.closest('.tab'); if (tab) return setTab(tab.dataset.tab);
    const more = t.closest('[data-more]'); if (more) { BR.n[more.dataset.more] += 10; return renderPicks(), redrawVisible(); }
    const th = t.closest('#tbl th'); if (th) { const k = th.dataset.k; BR.sort = BR.sort.k === k ? { k, d: -BR.sort.d } : { k, d: k === 'sym' || k === 'sector' ? 1 : -1 }; return renderTable(); }
    const seg = t.closest('[data-filter]'); if (seg) { BR.filter = seg.dataset.filter; $$('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b === seg))); return renderTable(); }
    const row = t.closest('article[data-sym], .tile[data-sym], .feature[data-sym], tr[data-sym]'); if (row) return openStock(row.dataset.sym);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches && e.target.matches('.card, .tile')) openStock(e.target.dataset.sym); });
  $('#hide-dead').addEventListener('change', (e) => { SET.hideDead = e.target.checked; saveSet(); renderActive(); });
  $('#set-hide').addEventListener('change', (e) => { SET.hideDead = e.target.checked; saveSet(); renderActive(); });
  $('#set-theme').addEventListener('change', (e) => { SET.theme = e.target.value; saveSet(); applyTheme(); redrawAll(); });
  $('#q').addEventListener('input', (e) => { BR.q = e.target.value; renderTable(); });
  $('#sec-filter').addEventListener('change', (e) => { BR.sector = e.target.value; renderTable(); });
  $('#dlg-stock').addEventListener('close', () => { BR.open = null; $('#dlg-body').dataset.sym = ''; });
  $('#dlg-stock').addEventListener('click', (e) => { if (e.target === $('#dlg-stock')) $('#dlg-stock').close(); });
  $('#dlg-settings').addEventListener('click', (e) => { if (e.target === $('#dlg-settings')) $('#dlg-settings').close(); });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { redrawVisible(); if (BR.open) drawDetailChart(); }, 120); });
  let sc; window.addEventListener('scroll', () => { clearTimeout(sc); sc = setTimeout(redrawVisible, 80); }, { passive: true });
  window.addEventListener('hashchange', () => setTab(location.hash.slice(1), false));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { Ch.refreshColors(); redrawAll(); });

  // swarm tooltip + click
  const sw = $('#swarm');
  sw.addEventListener('mousemove', (e) => {
    const b = sw.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top; let best = null, bd = 1e9;
    (sw._hits || []).forEach((h) => { const d = Math.hypot(h.x - x, h.y - y); if (d < h.r + 3 && d < bd) { bd = d; best = h; } });
    const tip = $('#tip');
    if (best) { const r = best.res; tip.textContent = r.sym + ' \u00B7 ' + (r.dir === 'bull' ? 'long' : r.dir === 'bear' ? 'short' : 'choppy') + ' \u00B7 score ' + r.score + ' \u00B7 ' + sgn(r.chgPct) + '%'; tip.style.display = 'block'; tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY + 12 + 'px'; sw.style.cursor = 'pointer'; sw._sym = r.sym; }
    else { tip.style.display = 'none'; sw.style.cursor = 'default'; sw._sym = null; }
  });
  sw.addEventListener('mouseleave', () => { $('#tip').style.display = 'none'; });
  sw.addEventListener('click', () => { if (sw._sym) openStock(sw._sym); });

  // ------------------------------------------------------------------ boot
  applyTheme();
  setTab((location.hash || '#picks').slice(1), false);
  if (/[?&]login=ok/.test(location.search)) { history.replaceState(null, '', location.pathname + location.hash); setTimeout(() => toast('Logged in to Upstox. Scanning now.'), 600); }
  start();
  window.BlockRadar = BR; // for debugging in the console
})();
