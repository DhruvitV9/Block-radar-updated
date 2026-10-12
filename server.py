#!/usr/bin/env python3
"""
BlockRadar local server  (Python 3.8+, standard library only - nothing to pip install)

What it does
  * Reads your Upstox *Analytics Token* (read-only: it cannot place or cancel orders).
  * Scans every F&O stock in universe.csv: 5-minute candles + daily context + live quotes.
  * Serves the dashboard at http://127.0.0.1:8765 and exposes a tiny JSON API to it.
  * Stays inside Upstox rate limits (50/s, 500/min, 2000 per 30 min) with a built-in limiter.

Your token never leaves your computer. This server only listens on 127.0.0.1.
"""
import argparse, base64, secrets, html, codecs, collections, csv, datetime as dt, gzip, hmac, io, json, mimetypes, os, sys
import threading, time, traceback, urllib.error, urllib.parse, urllib.request, webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, 'static')
CACHE = os.path.join(ROOT, 'cache')
CONFIG_PATH = os.path.join(ROOT, 'config.json')
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
BASE = os.environ.get('UPSTOX_BASE_URL', 'https://api.upstox.com').rstrip('/')
ASSETS = os.environ.get('UPSTOX_ASSETS_URL', 'https://assets.upstox.com').rstrip('/')
FORCE_MARKET = os.environ.get('BR_FORCE_MARKET', '')          # 'open' / 'closed' (testing only)
SCAN_SECONDS = int(os.environ.get('BR_SCAN_SECONDS', '0'))    # override scan period (testing only)
INDEX_KEYS = ['NSE_INDEX|Nifty 50']
ACCESS_KEY = os.environ.get('BR_ACCESS_KEY', '').strip()   # required when the server is reachable from the internet
PUBLIC_URL = os.environ.get('BR_PUBLIC_URL', '').strip().rstrip('/')   # optional override of this site's public address
PUBLIC_ASSETS = {'/manifest.webmanifest', '/apple-touch-icon.png', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/favicon-32.png'}
PUBLIC = False                                              # set in main(): True when bound to anything but localhost


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


# ------------------------------------------------------------------ config
def load_config():
    cfg = {'access_token': '', 'port': 8765, 'quote_seconds': 5, 'workers': 6}
    try:
        with open(CONFIG_PATH) as f:
            cfg.update(json.load(f))
    except FileNotFoundError:
        pass
    except Exception as e:
        log('config.json unreadable:', e)
    env = os.environ.get('UPSTOX_ACCESS_TOKEN')
    if env:
        cfg['access_token'] = env.strip()
    return cfg


def save_config(**kv):
    cfg = {}
    try:
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
    except Exception:
        pass
    cfg.update(kv)
    with open(CONFIG_PATH, 'w') as f:
        json.dump(cfg, f, indent=2)
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except Exception:
        pass


def save_token(token):
    save_config(access_token=token)


CFG = load_config()


# ------------------------------------------------------------------ time / market
def now_ist():
    return dt.datetime.now(IST)


def market_open(t=None):
    if FORCE_MARKET:
        return FORCE_MARKET == 'open'
    t = t or now_ist()
    if t.weekday() >= 5:
        return False
    m = t.hour * 60 + t.minute
    return 9 * 60 + 15 <= m <= 15 * 60 + 35


# ------------------------------------------------------------------ rate limiter
class RateLimiter:
    """Sliding-window limiter, kept safely under Upstox's 50/s, 500/min, 2000/30min."""

    def __init__(self, per_sec=40, per_min=420, per_30=1750):
        self.limits = [(1.0, per_sec), (60.0, per_min), (1800.0, per_30)]
        self.q = collections.deque()
        self.lock = threading.Lock()

    def acquire(self):
        while True:
            with self.lock:
                now = time.monotonic()
                while self.q and now - self.q[0] > 1800:
                    self.q.popleft()
                arr = list(self.q)
                wait = 0.0
                for win, lim in self.limits:
                    inwin = [t for t in arr if t > now - win]
                    if len(inwin) >= lim:
                        wait = max(wait, inwin[-lim] + win - now)
                if wait <= 0:
                    self.q.append(now)
                    return
            time.sleep(min(wait + 0.01, 5))

    def used_30m(self):
        with self.lock:
            now = time.monotonic()
            return sum(1 for t in self.q if now - t <= 1800)


LIMITER = RateLimiter()


class AuthError(Exception):
    pass


# ------------------------------------------------------------------ upstox client
def upstox_get(path, params=None, token=None, retries=3, timeout=25, auth=True):
    url = BASE + path
    if params:
        url += '?' + urllib.parse.urlencode(params)
    headers = {'Accept': 'application/json', 'Api-Version': '2.0', 'User-Agent': 'BlockRadar/1.0'}
    if auth and token:
        headers['Authorization'] = 'Bearer ' + token
    last = None
    for attempt in range(retries):
        LIMITER.acquire()
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            body = ''
            try:
                body = e.read().decode('utf-8', 'ignore')[:300]
            except Exception:
                pass
            if e.code == 401:
                raise AuthError('Upstox rejected the token (401). Generate a fresh Analytics Token.')
            if e.code == 429:
                time.sleep(2.0 * (attempt + 1))
                last = RuntimeError('rate limited (429)')
                continue
            if e.code >= 500:
                time.sleep(1.0 * (attempt + 1))
                last = RuntimeError('Upstox %s' % e.code)
                continue
            raise RuntimeError('HTTP %s %s' % (e.code, body))
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = e
            time.sleep(1.0 * (attempt + 1))
    raise RuntimeError('request failed: %s' % last)


def to_ms(ts):
    if isinstance(ts, (int, float)):
        return int(ts if ts > 1e11 else ts * 1000)
    s = str(ts).replace('Z', '+00:00')
    return int(dt.datetime.fromisoformat(s).timestamp() * 1000)


def parse_candles(rows):
    out = []
    for r in rows or []:
        try:
            out.append([to_ms(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5] or 0)])
        except Exception:
            continue
    out.sort(key=lambda x: x[0])
    return out


def ist_date_of_ms(ms):
    return dt.datetime.fromtimestamp(ms / 1000, IST).strftime('%Y-%m-%d')


def q(key):
    return urllib.parse.quote(key, safe='')


def fetch_intraday(key, token):
    """Today's 5-minute candles. If none (market closed / holiday), fall back to the latest session in history."""
    rows = []
    try:
        d = upstox_get('/v3/historical-candle/intraday/%s/minutes/5' % q(key), token=token)
        rows = parse_candles((d.get('data') or {}).get('candles'))
    except AuthError:
        # candle endpoints are public per Upstox; retry once without credentials
        d = upstox_get('/v3/historical-candle/intraday/%s/minutes/5' % q(key), token=None, auth=False)
        rows = parse_candles((d.get('data') or {}).get('candles'))
    if rows:
        sess = ist_date_of_ms(rows[-1][0])
        return [r for r in rows if ist_date_of_ms(r[0]) == sess]
    today = now_ist().date()
    frm = (today - dt.timedelta(days=7)).isoformat()
    d = upstox_get('/v3/historical-candle/%s/minutes/5/%s/%s' % (q(key), today.isoformat(), frm), token=token)
    rows = parse_candles((d.get('data') or {}).get('candles'))
    if not rows:
        return []
    sess = ist_date_of_ms(rows[-1][0])
    return [r for r in rows if ist_date_of_ms(r[0]) == sess]


def fetch_daily(key, token):
    today = now_ist().date()
    frm = (today - dt.timedelta(days=45)).isoformat()
    d = upstox_get('/v3/historical-candle/%s/days/1/%s/%s' % (q(key), today.isoformat(), frm), token=token)
    out = []
    for r in (d.get('data') or {}).get('candles') or []:
        try:
            ds = str(r[0])[:10] if isinstance(r[0], str) else ist_date_of_ms(to_ms(r[0]))
            out.append([ds, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5] or 0)])
        except Exception:
            continue
    out.sort(key=lambda x: x[0])
    return out


def fetch_quotes(keys, token):
    d = upstox_get('/v2/market-quote/quotes', params={'instrument_key': ','.join(keys)}, token=token)
    data = d.get('data') or {}
    out, index = {}, {}
    for k, v in data.items():
        key = v.get('instrument_token') or k.replace(':', '|', 1)
        ltp = v.get('last_price')
        if ltp is None:
            continue
        chg = v.get('net_change')
        if chg is None:
            chg = 0.0
        rec = {'ltp': float(ltp), 'chg': float(chg), 'vol': v.get('volume') or 0,
               'bq': v.get('total_buy_quantity') or 0, 'sq': v.get('total_sell_quantity') or 0}
        if key.startswith('NSE_INDEX'):
            pc = rec['ltp'] - rec['chg']
            index[key] = {'ltp': rec['ltp'], 'chg': rec['chg'], 'chgPct': (rec['chg'] / pc * 100) if pc else 0}
        else:
            out[key] = rec
    return out, index


# ------------------------------------------------------------------ instruments (lot sizes), streamed
def iter_json_array(fp, chunk=1 << 20):
    """Yield objects from a huge JSON array without loading it all in memory."""
    dec = json.JSONDecoder()
    udec = codecs.getincrementaldecoder('utf-8')()
    buf, pos, started, eof = '', 0, False, False
    while True:
        if not eof:
            data = fp.read(chunk)
            if not data:
                eof = True
            buf = buf[pos:] + udec.decode(data, final=eof)
            pos = 0
        while True:
            while pos < len(buf) and buf[pos] in ' \r\n\t,':
                pos += 1
            if not started:
                if pos < len(buf) and buf[pos] == '[':
                    pos += 1
                    started = True
                    continue
                break
            if pos >= len(buf) or buf[pos] == ']':
                break
            try:
                obj, end = dec.raw_decode(buf, pos)
            except json.JSONDecodeError:
                break
            pos = end
            yield obj
        if eof:
            return


def load_lots(symbols):
    path = os.path.join(CACHE, 'lots_%s.json' % now_ist().strftime('%Y%m%d'))
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    now_ms = int(time.time() * 1000)
    best = {}
    wanted = set(symbols)
    for name in ('NSE.json.gz', 'complete.json.gz'):
        try:
            req = urllib.request.Request('%s/market-quote/instruments/exchange/%s' % (ASSETS, name), headers={'User-Agent': 'BlockRadar/1.0'})
            with urllib.request.urlopen(req, timeout=120) as r, gzip.GzipFile(fileobj=r) as gz:
                for o in iter_json_array(gz):
                    if o.get('segment') != 'NSE_FO' or o.get('instrument_type') != 'FUT':
                        continue
                    u = o.get('underlying_symbol')
                    if u not in wanted:
                        continue
                    exp = o.get('expiry') or 0
                    if isinstance(exp, str):
                        continue
                    if exp < now_ms - 86400000:
                        continue
                    cur = best.get(u)
                    if cur is None or exp < cur[0]:
                        best[u] = (exp, int(o.get('lot_size') or 0))
            if best:
                break
        except Exception as e:
            log('lot size download failed (%s): %s' % (name, e))
    lots = {u: v[1] for u, v in best.items() if v[1] > 0}
    if lots:
        os.makedirs(CACHE, exist_ok=True)
        with open(path, 'w') as f:
            json.dump(lots, f)
    return lots


# ------------------------------------------------------------------ Upstox login (OAuth)
def exchange_code(code, redirect_uri):
    """Server-to-server call: swap the one-time login code for today's access token."""
    body = urllib.parse.urlencode({'code': code, 'client_id': S.api_key, 'client_secret': S.api_secret,
                                   'redirect_uri': redirect_uri, 'grant_type': 'authorization_code'}).encode()
    req = urllib.request.Request(BASE + '/v2/login/authorization/token', data=body, method='POST',
                                 headers={'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
                                          'User-Agent': 'BlockRadar/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            j = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = ''
        try:
            j = json.loads(e.read().decode('utf-8', 'ignore'))
            detail = ((j.get('errors') or [{}])[0].get('message')) or ''
        except Exception:
            pass
        raise RuntimeError('Upstox refused the login (%s). %s Check the API key, API secret and that the Redirect URL in your Upstox app matches exactly.' % (e.code, detail))
    tok = j.get('access_token')
    if not tok:
        raise RuntimeError('Upstox did not return a token.')
    return tok


def page(title, body_html, code=200):
    h = ('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
         '<title>%s</title><body style="font-family:system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:0 20px;line-height:1.5">'
         '<h2>%s</h2>%s<p><a href="/">Back to the dashboard</a></p></body>') % (html.escape(title), html.escape(title), body_html)
    return code, h.encode('utf-8')


# ------------------------------------------------------------------ state
def read_universe():
    out = []
    with open(os.path.join(ROOT, 'universe.csv'), newline='') as f:
        for r in csv.DictReader(f):
            sym = (r.get('trading_symbol') or '').strip()
            key = (r.get('instrument_key') or '').strip()
            if sym and key:
                out.append({'sym': sym, 'key': key})
    return out


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.token = CFG.get('access_token', '')
        self.api_key = (os.environ.get('UPSTOX_API_KEY') or CFG.get('api_key') or '').strip()
        self.api_secret = (os.environ.get('UPSTOX_API_SECRET') or CFG.get('api_secret') or '').strip()
        self.oauth = {}                # state nonce -> (expiry, redirect_uri)
        self.keys_locked = bool(os.environ.get('UPSTOX_API_KEY') and os.environ.get('UPSTOX_API_SECRET'))
        self.last_refresh = 0.0
        self.token_ok = None           # None unknown, True ok, False rejected
        self.error = ''
        self.universe = read_universe()
        self.lots = {}
        self.scan_version = 0
        self.scan_ts = 0
        self.scan_json = b''
        self.scan_gz = b''
        self.scan_meta = {}
        self.quotes = {}
        self.index = {}
        self.quote_ts = 0
        self.progress = {'phase': 'idle', 'done': 0, 'total': 0}
        self.refresh_flag = threading.Event()
        self.token_event = threading.Event()


S = State()


def daily_cache_load():
    path = os.path.join(CACHE, 'daily_%s.json' % now_ist().strftime('%Y%m%d'))
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def daily_cache_save(d):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, 'daily_%s.json' % now_ist().strftime('%Y%m%d'))
    with open(path, 'w') as f:
        json.dump(d, f)


def run_scan():
    token = S.token
    keys = [u['key'] for u in S.universe]
    workers = int(CFG.get('workers', 6))
    fetch_quotes([keys[0]], token)          # fail fast (AuthError) before spending the rate-limit budget
    abort = threading.Event()
    daily = daily_cache_load()
    need = [k for k in keys if k not in daily]
    if need:
        S.progress = {'phase': 'daily', 'done': 0, 'total': len(need)}
        done = [0]

        def dtask(k):
            if abort.is_set():
                return
            try:
                daily[k] = fetch_daily(k, token)
            except AuthError:
                abort.set()
                return
            except Exception as e:
                log('daily failed', k, e)
            done[0] += 1
            S.progress = {'phase': 'daily', 'done': done[0], 'total': len(need)}

        with ThreadPoolExecutor(workers) as ex:
            list(ex.map(dtask, need))
        if abort.is_set():
            raise AuthError('Upstox rejected the token while loading history.')
        daily_cache_save(daily)

    candles, failed = {}, 0
    S.progress = {'phase': 'scan', 'done': 0, 'total': len(keys)}
    done = [0]

    def ctask(k):
        nonlocal failed
        if abort.is_set():
            return
        try:
            candles[k] = fetch_intraday(k, token)
        except AuthError:
            abort.set()
            return
        except Exception as e:
            failed += 1
            log('intraday failed', k, e)
        done[0] += 1
        S.progress = {'phase': 'scan', 'done': done[0], 'total': len(keys)}

    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(ctask, keys))
    if abort.is_set():
        raise AuthError('Upstox rejected the token while scanning.')

    dates = collections.Counter(ist_date_of_ms(v[-1][0]) for v in candles.values() if v)
    session = dates.most_common(1)[0][0] if dates else ''
    payload = {'version': S.scan_version + 1, 'sessionDate': session, 'live': market_open() and session == now_ist().strftime('%Y-%m-%d'),
               'ts': int(time.time() * 1000), 'candles': candles, 'daily': {k: daily.get(k, []) for k in keys}, 'failed': failed}
    raw = json.dumps(payload, separators=(',', ':')).encode()
    gz = gzip.compress(raw, 4)
    with S.lock:
        S.scan_json, S.scan_gz = raw, gz
        S.scan_version = payload['version']
        S.scan_ts = payload['ts']
        S.scan_meta = {'sessionDate': session, 'live': payload['live'], 'failed': failed, 'stocks': len(candles)}
    S.progress = {'phase': 'idle', 'done': len(keys), 'total': len(keys)}
    log('scan %d done: %d stocks, session %s, %d failed, API calls last 30m: %d' % (S.scan_version, len(candles), session, failed, LIMITER.used_30m()))


def next_scan_delay():
    if SCAN_SECONDS:
        return SCAN_SECONDS
    t = now_ist()
    m = t.minute % 5
    return (5 - m) * 60 - t.second + 8      # 8 seconds after the next 5-minute candle closes


def wait_for_next_scan():
    """Block until the next scan is due: just after each 5-minute candle while the market is open,
    once at open/close transitions, on manual refresh, and every 30 minutes while closed."""
    was_open = market_open()
    deadline = time.time() + (next_scan_delay() if was_open else 1800)
    while True:
        if S.refresh_flag.wait(1):
            S.refresh_flag.clear()
            return
        now_open = market_open()
        if now_open != was_open:
            if now_open:
                time.sleep(25)          # market just opened: let the first 5-minute candle start forming, then scan
            return
        if time.time() >= deadline:
            return


def scanner_loop():
    while True:
        try:
            if not S.token:
                S.token_event.wait(2)
                continue
            S.token_event.clear()
            run_scan()
            S.token_ok = True
            S.error = ''
        except AuthError as e:
            S.token_ok = False
            S.error = str(e)
            S.token_event.wait(30)
            continue
        except Exception as e:
            S.error = 'Scan error: %s' % e
            log(traceback.format_exc())
        wait_for_next_scan()


def quoter_loop():
    while True:
        try:
            if not S.token or S.token_ok is False:
                time.sleep(2)
                continue
            keys = [u['key'] for u in S.universe] + INDEX_KEYS
            quotes, index = fetch_quotes(keys, S.token)
            S.quotes = quotes
            S.index = index
            S.quote_ts = int(time.time() * 1000)
            S.token_ok = True
        except AuthError as e:
            S.token_ok = False
            S.error = str(e)
        except Exception as e:
            log('quote error:', e)
        time.sleep(float(CFG.get('quote_seconds', 5)) if market_open() else 60)


def lots_loop():
    try:
        S.lots = load_lots([u['sym'] for u in S.universe])
        log('lot sizes loaded for %d stocks' % len(S.lots))
    except Exception as e:
        log('lot sizes unavailable:', e)


# ------------------------------------------------------------------ http
class Handler(BaseHTTPRequestHandler):
    server_version = 'BlockRadar/1.0'

    def log_message(self, fmt, *args):
        pass

    def _host_ok(self):
        """Local mode: only localhost Host headers (blocks DNS-rebinding).
        Public mode: open to anyone with the link, unless BR_ACCESS_KEY is set (then a password is required)."""
        if not PUBLIC:
            h = (self.headers.get('Host') or '').split(':')[0].lower()
            return h in ('127.0.0.1', 'localhost', '[::1]')
        if not ACCESS_KEY:
            return True
        pth = self.path.split('?')[0]
        if pth in ('/healthz', '/callback', '/robots.txt') or pth in PUBLIC_ASSETS:   # /callback is protected by a single-use state nonce; icons are not secret
            return True
        auth = self.headers.get('Authorization') or ''
        if auth.startswith('Basic '):
            try:
                pw = base64.b64decode(auth[6:]).decode('utf-8', 'ignore').split(':', 1)[1]
                if hmac.compare_digest(pw.encode(), ACCESS_KEY.encode()):
                    return True
            except Exception:
                pass
            time.sleep(1.0)                     # slow down password guessing
        return False

    def _deny(self):
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="BlockRadar", charset="UTF-8"')
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', '12')
        self.end_headers()
        self.wfile.write(b'Login needed')

    def _send(self, code, body, ctype='application/json', gz=False):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Robots-Tag', 'noindex, nofollow')
        if gz:
            self.send_header('Content-Encoding', 'gzip')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, separators=(',', ':')).encode())

    def redirect_uri(self):
        if PUBLIC_URL:
            return PUBLIC_URL + '/callback'
        proto = (self.headers.get('X-Forwarded-Proto') or ('https' if PUBLIC else 'http')).split(',')[0].strip()
        return '%s://%s/callback' % (proto, self.headers.get('Host') or '127.0.0.1')

    def status_obj(self):
        o = {
            'oauthReady': bool(S.api_key and S.api_secret), 'apiKeyHint': ('...' + S.api_key[-4:]) if S.api_key else '',
            'redirectUri': self.redirect_uri(),
            'server': True, 'hasToken': bool(S.token), 'tokenOk': S.token_ok, 'error': S.error,
            'marketOpen': market_open(), 'istNow': now_ist().strftime('%Y-%m-%d %H:%M:%S'),
            'scanVersion': S.scan_version, 'scanTs': S.scan_ts, 'quoteTs': S.quote_ts,
            'progress': S.progress, 'apiCalls30m': LIMITER.used_30m(), 'universe': len(S.universe),
            'scanMeta': S.scan_meta, 'publicMode': PUBLIC, 'authOn': bool(PUBLIC and ACCESS_KEY), 'keysLocked': S.keys_locked,
        }
        return o

    def do_GET(self):
        if not self._host_ok():
            return self._deny() if PUBLIC else self._send(403, b'forbidden', 'text/plain')
        u = urllib.parse.urlparse(self.path)
        p = u.path
        if p == '/healthz':
            return self._send(200, b'ok', 'text/plain')
        if p == '/robots.txt':
            return self._send(200, b'User-agent: *\nDisallow: /\n', 'text/plain')
        if p == '/login':
            if not (S.api_key and S.api_secret):
                c, b = page('Add your Upstox API key first', '<p>Open Settings in the dashboard and enter your Upstox <b>API key</b> and <b>API secret</b>, then try again.</p>', 400)
                return self._send(c, b, 'text/html; charset=utf-8')
            now = time.time()
            for k in [k for k, v in S.oauth.items() if v[0] < now]:
                S.oauth.pop(k, None)
            nonce = secrets.token_urlsafe(18)
            ruri = self.redirect_uri()
            S.oauth[nonce] = (now + 600, ruri)
            q_ = urllib.parse.urlencode({'response_type': 'code', 'client_id': S.api_key, 'redirect_uri': ruri, 'state': nonce})
            self.send_response(302)
            self.send_header('Location', BASE + '/v2/login/authorization/dialog?' + q_)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if p == '/callback':
            qs = urllib.parse.parse_qs(u.query)
            code = (qs.get('code') or [''])[0]
            nonce = (qs.get('state') or [''])[0]
            rec = S.oauth.pop(nonce, None)
            if not rec or rec[0] < time.time():
                c, b = page('Login expired', '<p>This login link is no longer valid. Go back to the dashboard and press <b>Login with Upstox</b> again.</p>', 400)
                return self._send(c, b, 'text/html; charset=utf-8')
            if not code:
                msg = (qs.get('error_description') or qs.get('error') or ['Upstox did not send a login code.'])[0]
                c, b = page('Upstox login was not completed', '<p>%s</p>' % html.escape(msg), 400)
                return self._send(c, b, 'text/html; charset=utf-8')
            try:
                tok = exchange_code(code, rec[1])
            except Exception as e:
                c, b = page('Upstox login failed', '<p>%s</p>' % html.escape(str(e)), 502)
                return self._send(c, b, 'text/html; charset=utf-8')
            S.token, S.token_ok, S.error = tok, True, ''
            save_token(tok)
            S.token_event.set()
            S.refresh_flag.set()
            log('Logged in to Upstox via OAuth - scanning...')
            self.send_response(302)
            self.send_header('Location', '/?login=ok#picks')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if p == '/api/status':
            return self._json(self.status_obj())
        if p == '/api/live':
            o = self.status_obj()
            o['quotes'] = S.quotes
            o['index'] = S.index.get(INDEX_KEYS[0], {})
            return self._json(o)
        if p == '/api/scan':
            if not S.scan_json:
                return self._json({'error': 'no scan yet', 'progress': S.progress}, 202)
            if 'gzip' in (self.headers.get('Accept-Encoding') or ''):
                return self._send(200, S.scan_gz, gz=True)
            return self._send(200, S.scan_json)
        if p == '/api/universe':
            return self._json([{'sym': x['sym'], 'key': x['key'], 'lot': S.lots.get(x['sym'], 0)} for x in S.universe])
        # static files
        if p in ('/', ''):
            p = '/index.html'
        fp = os.path.normpath(os.path.join(STATIC, p.lstrip('/')))
        if not fp.startswith(STATIC) or not os.path.isfile(fp):
            return self._send(404, b'not found', 'text/plain')
        ctype = mimetypes.guess_type(fp)[0] or 'application/octet-stream'
        if fp.endswith('.webmanifest'):
            ctype = 'application/manifest+json'
        elif fp.endswith('.js'):
            ctype = 'text/javascript; charset=utf-8'
        elif fp.endswith('.html') or fp.endswith('.css'):
            ctype += '; charset=utf-8'
        with open(fp, 'rb') as f:
            self._send(200, f.read(), ctype)

    def do_POST(self):
        if not self._host_ok():
            return self._deny() if PUBLIC else self._send(403, b'forbidden', 'text/plain')
        origin = self.headers.get('Origin')
        if origin:
            oh = urllib.parse.urlparse(origin).hostname
            if PUBLIC:
                if oh != (self.headers.get('Host') or '').split(':')[0]:
                    return self._send(403, b'forbidden', 'text/plain')
            elif oh not in ('127.0.0.1', 'localhost', '::1'):
                return self._send(403, b'forbidden', 'text/plain')
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else b''
        if self.path == '/api/oauth/config':
            if S.keys_locked:
                return self._json({'ok': False, 'error': 'The API key and secret are fixed by the server settings (UPSTOX_API_KEY / UPSTOX_API_SECRET).'}, 403)
            try:
                j = json.loads(body or b'{}')
                key, sec = (j.get('api_key') or '').strip(), (j.get('api_secret') or '').strip()
            except Exception:
                key = sec = ''
            if len(key) < 8 or len(sec) < 6 or ' ' in key or ' ' in sec:
                return self._json({'ok': False, 'error': 'Enter the API key and API secret exactly as shown in your Upstox app.'}, 400)
            S.api_key, S.api_secret = key, sec
            save_config(api_key=key, api_secret=sec)
            return self._json({'ok': True})
        if self.path == '/api/token':
            try:
                tok = (json.loads(body or b'{}').get('token') or '').strip()
            except Exception:
                tok = ''
            if len(tok) < 20:
                return self._json({'ok': False, 'error': 'That does not look like an Upstox token.'}, 400)
            try:
                fetch_quotes([S.universe[0]['key']], tok)
            except AuthError:
                return self._json({'ok': False, 'error': 'Upstox rejected this token. Make sure you copied the whole Analytics Token.'}, 401)
            except Exception as e:
                return self._json({'ok': False, 'error': 'Could not verify the token: %s' % e}, 502)
            S.token = tok
            S.token_ok = True
            S.error = ''
            save_token(tok)
            S.token_event.set()
            S.refresh_flag.set()
            return self._json({'ok': True})
        if self.path == '/api/refresh':
            if time.time() - S.last_refresh < 60:
                return self._json({'ok': True, 'throttled': True})
            S.last_refresh = time.time()
            S.refresh_flag.set()
            return self._json({'ok': True})
        return self._send(404, b'not found', 'text/plain')


def main():
    global PUBLIC
    ap = argparse.ArgumentParser(description='BlockRadar - Order Block & Liquidity scanner for Indian F&O stocks')
    ap.add_argument('--host', default=os.environ.get('BR_HOST', '127.0.0.1'),
                    help='127.0.0.1 (default, this computer only) or 0.0.0.0 to deploy online (optional password: BR_ACCESS_KEY)')
    ap.add_argument('--port', type=int, default=int(os.environ.get('PORT') or CFG.get('port', 8765)))
    ap.add_argument('--no-browser', action='store_true')
    args = ap.parse_args()
    PUBLIC = args.host not in ('127.0.0.1', 'localhost', '::1')
    if PUBLIC:
        if ACCESS_KEY and len(ACCESS_KEY) < 12:
            sys.exit('BR_ACCESS_KEY is too short. Use 12+ random characters, or delete the variable to run without a password.')
        if not ACCESS_KEY:
            log('OPEN MODE: no password. Anyone with this link can view the dashboard (no secrets are ever shown).')
        if not S.token:
            log('Not logged in to Upstox yet - the dashboard shows demo data until you press Login with Upstox.')
    threading.Thread(target=scanner_loop, daemon=True).start()
    threading.Thread(target=quoter_loop, daemon=True).start()
    threading.Thread(target=lots_loop, daemon=True).start()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    url = 'http://127.0.0.1:%d' % args.port
    log('BlockRadar running on %s:%d%s' % (args.host, args.port, (' (public mode, password protected)' if ACCESS_KEY else ' (public mode, no password)') if PUBLIC else ' -> ' + url))
    if S.token:
        log('Upstox token found - scanning %d F&O stocks...' % len(S.universe))
    elif not PUBLIC:
        log('No Upstox token yet - the dashboard will run in DEMO mode until you paste one (see README).')
    if not args.no_browser and not PUBLIC:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log('bye')


if __name__ == '__main__':
    main()
