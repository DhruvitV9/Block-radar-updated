# BlockRadar: Order Block & Liquidity scanner for all Indian F&O stocks

Scans every stock in `universe.csv` (213 F&O stocks, with your Upstox instrument keys), finds
order blocks and liquidity levels on live 5-minute candles, ranks the cleanest long and short
setups, and gives each one an entry zone, stop, two targets and a reward-to-risk number.

It is **read-only**. It never places, modifies or cancels an order.

## Run it (3 steps, nothing to install except Python 3.8+)

1. **Get an Upstox Analytics Token** (read-only, valid about a year, no daily login):
   `account.upstox.com/developer/apps` -> create/open an app -> generate the *Analytics Token*.
2. **Start the server**
   - Windows: double-click `start.bat`
   - Mac/Linux: `./start.sh` (or `python3 server.py`)
3. Your browser opens `http://127.0.0.1:8765`. Click the gear icon and paste the token (or use Login with Upstox).
   (Or copy `config.example.json` to `config.json` and paste it there.)

The first scan takes about a minute (it respects Upstox rate limits). After that, rankings refresh
right after every 5-minute candle closes and prices/states refresh every ~5 seconds.
Until a token is connected the dashboard runs on **simulated demo data**, clearly labelled.

Never share your token or paste it into a chat. `config.json` is created with owner-only permissions.
If you use a normal access token instead, it expires around 3:30 AM IST each day.

## Deploy online: GitHub + Render

Deploy mode has **no password by default**: anyone with your link can view the dashboard (no secret is ever shown
on screen). Keep the link private. To require a password, add a `BR_ACCESS_KEY` variable (12+ characters) in Render.
You sign in to Upstox from the dashboard itself (button: **Login with Upstox**). Your API secret and token
never go into GitHub.

1. **Put it on GitHub (use a PRIVATE repo).** Create an empty private repo on github.com (no README), then:
   ```
   cd blockradar
   git init -b main
   git add .
   git commit -m "BlockRadar"
   git remote add origin https://github.com/YOUR_USERNAME/blockradar.git
   git push -u origin main
   ```
   `config.json` and `cache/` are git-ignored. Do not add your token to any file in the repo.
2. **Create the Render service.** On dashboard.render.com choose *New > Blueprint*, connect the repo, and
   Render reads `render.yaml` (it asks for no values).
   (Manual alternative: *New > Web Service*, Runtime Python 3, Build Command `echo ok`,
   Start Command `python server.py --host 0.0.0.0`, Health Check Path `/healthz`.)
3. **Optional but recommended:** in Render > Environment add `UPSTOX_API_KEY` and `UPSTOX_API_SECRET`. This locks the
   key so nobody who finds your link can swap it, and it makes Login with Upstox one click after every restart.
4. **Open your `onrender.com` URL.**
5. **Connect Upstox (once per trading day).** Click the gear icon:
   * Copy the **Redirect URL** shown there (it looks like `https://YOUR-APP.onrender.com/callback`).
   * At `account.upstox.com/developer/apps` open your app, paste it into **Redirect URL**, save, and copy the app's
     **API key** and **API secret**.
   * Back in the dashboard enter the API key and secret (skip if you set them in Render), press **Save and continue**, then **Login with Upstox**
     and sign in on Upstox's own page. You land back on the dashboard and the scan starts.

Notes
* **Free plan sleeps** after about 15 minutes with no visitors, and the scanner stops while asleep. Waking it takes
  about a minute plus a ~1 minute first scan. Keep the tab open while trading, or run the app on your own computer
  (free, never sleeps). A paid plan stays awake (set `plan: starter` in `render.yaml`; check Render's pricing).
* Render's disk is temporary, so the daily-history cache is rebuilt after each restart. That is normal.
* Upstox logins expire around 3:30 AM IST, so press **Login with Upstox** once at the start of each trading day.
* On Render's free plan a restart wipes the saved API key/secret. To avoid re-typing them, add `UPSTOX_API_KEY` and
  `UPSTOX_API_SECRET` in Render > Environment (they do not change daily). Login is then one click.
* If the Upstox login says the redirect URL does not match, the Redirect URL in your Upstox app differs from the one
  shown in Settings. If Render sits behind a proxy that changes it, set `BR_PUBLIC_URL` to your full site address.
* You can still paste a token instead (Settings > "Or paste a token instead").
* The market-data endpoints used here (quotes, historical candles) do not need a static IP.
* Without a password, anyone who has your URL can see the dashboard and could re-enter an API key before you set
  one. Setting `UPSTOX_API_KEY`/`UPSTOX_API_SECRET` in Render closes that gap. Search engines are told not to index the site.
* Want a password? Add `BR_ACCESS_KEY` in Render (12+ characters) and redeploy. Delete it to go back to open.

## Add it to your iPhone home screen

1. Open your dashboard link in **Safari** (not Chrome).
2. Tap the **Share** button, then **Add to Home Screen**. The name is pre-filled as **BlockRadar**.
3. Tap **Add**. You get the BlockRadar icon, and it opens full screen like an app.

Notes
* The icon and name are read when you add it. If you add it before updating the site, delete the home-screen icon and
  add it again to pick up the new one.
* Do the daily **Login with Upstox** in Safari if the home-screen app misbehaves during the redirect. The login is saved on
  the server, so the home-screen app is connected too.
* iPhone icons need PNG files, which are in `static/` (`apple-touch-icon.png`, `icon-192.png`, `icon-512.png`).
  `static/icon.svg` is the source artwork.

## Screens

| Tab | What it shows |
|---|---|
| Top picks | Best long + best short right now, then ranked cards with chart, order block, stop, T1, T2, R:R |
| Liquidity board | Volume-at-price "bricks" per stock; hatched band = order block; dashed line = live price |
| Market X-ray | Every stock as a dot (bullish right, bearish left, choppy grey) + sector breadth |
| All stocks | Sortable/filterable table of all 213 |
| Rules & method | Survival rules, how the 0-99 score is built, glossary |

Click any stock for the full chart, reasons, nearby liquidity and a **position-size calculator**
(capital, % risk, lot size -> number of lots).

## How a setup is found

* **Order block**: last opposite candle before a displacement move (>= 1.3x ATR, or 1.9x over two
  candles) that also breaks the last 6 candles' structure. Zone = that candle's range. Invalid once a
  candle closes through it.
* **Liquidity**: previous-day high/low, day high/low, equal highs/lows, untouched swing points.
  A *sweep* = wick through a level that closes back inside.
* **Score (0-99)** = Trend 25 + Order-block quality 25 + Liquidity 20 + Flow 15 + Entry readiness 15,
  minus penalties for choppy price (frequent VWAP crossings), target already hit, or stop broken.
* **Plan**: entry = price clamped into the zone, stop = beyond the zone by 0.25 ATR (never less than
  0.5 ATR or 0.15% of price), targets = next real liquidity levels within 6 ATR (else 1.2R / 2.5R).
* All tunables are at the top of `static/engine.js` (`OPTS`).

## Honest limits

* Rule-based and **not back-tested**. It ranks setups; it cannot know what happens next.
* The buy/sell split inside the volume profile is estimated from where each candle closed in its range.
* Live Upstox access could not be exercised from the environment this was built in (no internet), so
  it was tested against a faithful mock of the Upstox responses. If something fails on your first run,
  the terminal window prints the exact error. Fix: usually an expired/typo'd token.
* Rate limits: the server keeps itself under Upstox's published 50/s, 500/min, 2000 per 30 min.
* Lot sizes are read from Upstox's instrument file when available; otherwise type the lot size into the calculator.
* The universe is whatever is in `universe.csv`. Edit it to add/remove stocks (`trading_symbol,instrument_key`).

## Files

```
server.py           local server: Upstox client, rate limiter, scanner, quotes (stdlib only)
universe.csv        F&O stocks + Upstox instrument keys
static/engine.js    order block / liquidity / scoring engine
static/app.js       dashboard logic      static/charts.js  canvas charts
static/demo.js      simulated market     static/style.css, index.html, universe.js
static/icon*.png, apple-touch-icon.png, manifest.webmanifest   logo + home-screen app files
tests/              engine_test.js (node) and fake_upstox.py (offline mock of the API)
render.yaml         Render blueprint (deployment)
```

Educational tool, not investment advice. Derivatives trading carries substantial risk of loss.
