"""A tiny fake of the Upstox endpoints BlockRadar uses, with realistic response shapes. For offline testing only."""
import gzip, json, os, random, sys, datetime as dt, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
GOOD = 'TESTTOKENTESTTOKENTESTTOKEN123'
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
CSV = [l.strip().split(',') for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'universe.csv')).read().strip().split('\n')[1:]]
KEY2SYM = {k: s for s, k in CSV}

def candles(key, n=40):
    r = random.Random(key)
    px = r.uniform(100, 3000)
    today = dt.datetime.now(IST).replace(hour=9, minute=15, second=0, microsecond=0)
    out = []
    for i in range(n):
        o = px; c = o * (1 + r.gauss(0, 0.0012)); h = max(o, c) * (1 + r.random() * 0.0008); l = min(o, c) * (1 - r.random() * 0.0008)
        out.append([(today + dt.timedelta(minutes=5 * i)).isoformat(), round(o, 2), round(h, 2), round(l, 2), round(c, 2), r.randint(5000, 90000), 0])
        px = c
    return out[::-1]                      # Upstox returns newest first

def daily(key):
    r = random.Random('d' + key); px = r.uniform(100, 3000); out = []
    d = dt.datetime.now(IST).replace(hour=0, minute=0, second=0, microsecond=0)
    for i in range(30):
        day = d - dt.timedelta(days=i + 1)
        if day.weekday() >= 5: continue
        o = px; c = o * (1 + r.gauss(0, 0.01)); out.append([day.isoformat(), round(o, 2), round(max(o, c) * 1.005, 2), round(min(o, c) * 0.995, 2), round(c, 2), r.randint(10**6, 5 * 10**6), 0]); px = c
    return out

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj, raw=None):
        b = raw if raw is not None else json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); p = urllib.parse.unquote(u.path); qs = urllib.parse.parse_qs(u.query)
        auth = self.headers.get('Authorization', '')
        if p.startswith('/v2/market-quote/quotes'):
            if auth != 'Bearer ' + GOOD: return self.send(401, {'status': 'error'})
            data = {}
            for k in qs['instrument_key'][0].split(','):
                r = random.Random(k + str(dt.datetime.now().second // 5)); base = random.Random(k).uniform(100, 3000); ltp = base * (1 + r.gauss(0, 0.004))
                if k.startswith('NSE_INDEX'):
                    data['NSE_INDEX:Nifty 50'] = {'last_price': 25000.0, 'net_change': 80.5, 'instrument_token': k, 'ohlc': {}, 'depth': {'buy': [], 'sell': []}}
                else:
                    data['NSE_EQ:' + KEY2SYM.get(k, '?')] = {'last_price': ltp, 'net_change': ltp - base, 'instrument_token': k, 'volume': 123456, 'total_buy_quantity': 5000.0, 'total_sell_quantity': 4000.0, 'ohlc': {'open': base, 'high': ltp, 'low': base, 'close': base}, 'depth': {'buy': [], 'sell': []}}
            return self.send(200, {'status': 'success', 'data': data})
        if p.startswith('/v3/historical-candle/intraday/'):
            key = p.split('/')[4] if False else '/'.join(p.split('/')[4:]).rsplit('/minutes/', 1)[0]
            return self.send(200, {'status': 'success', 'data': {'candles': candles(key)}})
        if p.startswith('/v3/historical-candle/') and '/days/1/' in p:
            key = p[len('/v3/historical-candle/'):].split('/days/1/')[0]
            return self.send(200, {'status': 'success', 'data': {'candles': daily(key)}})
        if p.endswith('NSE.json.gz'):
            arr = [{'segment': 'NSE_FO', 'instrument_type': 'FUT', 'underlying_symbol': s, 'expiry': 4102444800000 + i, 'lot_size': 100 + i % 50} for i, (s, k) in enumerate(CSV)]
            arr += [{'segment': 'NSE_FO', 'instrument_type': 'CE', 'underlying_symbol': 'RELIANCE', 'expiry': 1, 'lot_size': 1}]
            return self.send(200, None, raw=gzip.compress(json.dumps(arr, indent=2).encode()))
        self.send(404, {'status': 'error'})

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
