# WASTED_DON — Crypto Chart Desk

An AI chart-analysis tool for crypto perps. Upload chart screenshots across timeframes,
apply your own SMC/ICT concepts (BAGTRACT is built in), add funding + net-inflow context,
and get a graded trade ticket with entry, stop, targets, risk:reward and position size.

This is the **public-app** build: a static front end plus a small serverless backend that
holds your Anthropic API key, so friends can use it in any browser without a Claude account
and without ever seeing your key.

---

## What's in here

```
wasted-don/
├── index.html        the app (front end)
├── api/
│   ├── analyze.js    serverless proxy → Anthropic API (keeps your key secret)
│   └── watchlist.js  daily screener → Binance API (setup-forming coins)
├── vercel.json       deploy config + 4am cron
└── README.md         this file
```

---

## The daily watchlist

Runs automatically every morning at **04:00 Africa/Nairobi** (01:00 UTC) and appears in the
**Watchlist** tab. You can also hit **Refresh now** any time.

**It does not list top gainers and losers.** Those coins already made their move — that's the
chase, and it's the exact trade the FOMO gate exists to block. Instead it screens for setups that
may be *forming*:

- **Liquidity floor** — only pairs with real 24h volume.
- **Anti-FOMO filter** — anything that moved more than ~6% in 24h is *excluded*.
- **Near an un-swept level** — price sitting within ~2% of a recent swing high/low that has *not*
  yet been taken out.
- **Volatility contracting** — recent ATR below the prior window's ATR (coiling before expansion).

Each row tells you whether the liquidity pool sits **above** (watch for a sweep, then a short) or
**below** (watch for a sweep, then a long), how far away it is, current ATR%, and the 24h move.
If your journal shows a poor record on that coin, the row says so.

Tune the screen at the top of `api/watchlist.js` (`MAX_ABS_24H_MOVE`, `NEAR_LEVEL_PCT`, etc.).
Note: the cron only runs on the deployed Vercel app, not when you open the file locally.

---

## Deploy it (free, ~10 minutes)

You'll use **Vercel**. It hosts the page and runs the backend function for free.

### 1. Get an Anthropic API key
- Go to <https://console.anthropic.com> → **API Keys** → create a key.
- Add a little credit (Billing). Each chart analysis costs a fraction of a cent.
- Copy the key (starts with `sk-ant-...`). Keep it private.

### 2. Put this folder on GitHub
- Create a new GitHub repo and upload these files (or use `git`).

### 3. Deploy on Vercel
- Go to <https://vercel.com>, sign in with GitHub, click **Add New → Project**.
- Import your repo and click **Deploy**. (No build settings needed — it's static + a function.)

### 4. Add your secrets
In the Vercel project → **Settings → Environment Variables**, add:

| Name | Value | Required |
|------|-------|----------|
| `ANTHROPIC_API_KEY` | your `sk-ant-...` key | yes |
| `ACCESS_CODE` | any password you choose (e.g. `bagtract2026`) | recommended |

Then **redeploy** (Deployments → ⋯ → Redeploy) so the variables take effect.

### 5. Share it
- Vercel gives you a link like `https://wasted-don.vercel.app`.
- Send it to your friends. They open it, enter the **access code** you set, and use it.

---

## The access code (read this)

Because the backend uses **your** API key, every analysis your friends run is billed to you.
The `ACCESS_CODE` is your safety valve: only people who know it can run an analysis, so if the
link leaks publicly, strangers can't drain your credits. Tell your friends the code privately.
Anyone using the app enters it once in the **Access code** field (it's remembered on their device).

To cap spending, set a **monthly budget / spend limit** on your key in the Anthropic console.

---

## Using the app

1. **Concepts tab** — your BAGTRACT concepts are preloaded (loose + strict). Edit or add your own.
2. **Analyze tab**
   - Drop in up to **6 price charts**; label each timeframe (4H, 1H, 15m…).
   - Optionally add **funding rate** and **net exchange flow** (type them, or paste/drop a data screenshot).
   - Set **account balance** and **risk %** for position sizing.
   - Pick which **concepts** to apply.
   - Hit **Analyze charts** → you get a graded ticket (A/B/C), entry/stop/targets, R:R, size.

---

## Honest limits

- **This is not a backtester.** It reads the charts you give it right now and gives a graded
  opinion. It does not replay historical bars or produce win-rate / drawdown statistics. For real
  backtesting of BAGTRACT, code it as a TradingView Pine Script and use the Strategy Tester.
- **It's an analysis aid, not financial advice.** It applies your framework; it cannot predict
  markets. A grade-C entry is a weak setup — the grade exists so you can skip or size down.
- **Vercel request size:** very large image payloads can exceed limits. The app already compresses
  images; if you hit an error, send fewer/smaller screenshots.

---

## Customizing

- The analysis prompt lives in `index.html` (search for `const sys=` and `const userText=`).
- The model is set in `api/analyze.js` (`model: "claude-sonnet-4-6"`).
- All styling is in the `<style>` block at the top of `index.html`.
