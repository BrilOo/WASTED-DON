// Daily watchlist screener for WASTED_DON.
// Runs on a schedule (see vercel.json cron) and on demand via GET /api/watchlist.
//
// PHILOSOPHY: this does NOT rank by biggest gainers/losers (that's the FOMO list —
// those coins already made their move). It screens for coins where a setup may be
// FORMING: price coiling near an un-swept liquidity level, with contracting volatility,
// and explicitly EXCLUDES anything that already ran hard in the last 24h.

// NOTE ON HOSTS: Binance returns HTTP 451 ("Unavailable For Legal Reasons") to requests
// originating from restricted regions — which includes the US, where Vercel functions run
// by default. Two mitigations are in place:
//   1. vercel.json pins this function to a European region (fra1).
//   2. We try several hosts in order; data.binance.com is a market-data mirror that
//      generally answers where api.binance.com is blocked.
const HOSTS = [
  "https://data-api.binance.vision",
  "https://data.binance.com",
  "https://api.binance.com",
  "https://api1.binance.com"
];
let ACTIVE_HOST = null;

// ---- tunables -------------------------------------------------------------
const QUOTE = "USDT";
const MIN_QUOTE_VOL_24H = 8_000_000;  // liquidity floor, in USDT (lowered from 20M)
const MAX_ABS_24H_MOVE = 9;           // % — exclude coins that already ran (loosened from 6)
const KLINE_INTERVAL = "1h";
const KLINES = 100;                   // ~4 days of 1h candles
const SWING_LOOKBACK = 40;            // bars used to find the liquidity pool
const NEAR_LEVEL_PCT = 3.5;           // price within this % of the level (widened from 2.0)
const MIN_ATR_PCT = 0.15;             // skip near-dead coins (stables, pegged assets)
const MAX_RESULTS = 15;               // show more candidates (was 8)

// Stablecoins and pegged assets never "coil near a level" in a meaningful way —
// they just sit at their peg. Exclude them outright.
const STABLES = new Set([
  "USDC","USDT","BUSD","TUSD","USDP","DAI","FDUSD","USD1","RLUSD","PYUSD",
  "EURI","AEUR","USDD","GUSD","LUSD","FRAX","SUSD","USTC","EUR","GBP","TRY",
  "BRL","ARS","XUSD","USDS","USDE","SUSDE","BFUSD","WBETH","BNSOL"
]);
const MAX_SCAN = 120;                 // scan far more of the market (was 30)
const BATCH = 10;                     // parallel kline requests per batch (was 6)
const TIME_BUDGET_MS = 45000;         // more time for the wider scan (was 22000)
// ---------------------------------------------------------------------------

// Fetch a Binance path, trying each host until one answers.
// Once a host works we stick with it for the rest of the run.
async function fetchWithTimeout(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function j(path) {
  if (ACTIVE_HOST) {
    const r = await fetchWithTimeout(ACTIVE_HOST + path);
    if (!r.ok) throw new Error("Binance " + r.status + " on " + path);
    return r.json();
  }
  let lastErr = null;
  for (const host of HOSTS) {
    try {
      const r = await fetchWithTimeout(host + path);
      if (r.ok) { ACTIVE_HOST = host; return r.json(); }
      lastErr = new Error("Binance " + r.status + " from " + host);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All Binance hosts unreachable");
}

// True Range based ATR (Wilder-lite: simple mean of TR, enough for ranking)
function atr(highs, lows, closes, n) {
  const trs = [];
  for (let i = highs.length - n; i < highs.length; i++) {
    if (i <= 0) continue;
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  return trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : null;
}

function screenSymbol(sym, kl, move24) {
  const highs = kl.map(k => parseFloat(k[2]));
  const lows = kl.map(k => parseFloat(k[3]));
  const closes = kl.map(k => parseFloat(k[4]));
  const price = closes[closes.length - 1];
  if (!price) return null;

  // liquidity pools: the highest high / lowest low of the lookback window,
  // EXCLUDING the last few bars (so we're measuring a level price hasn't just taken)
  const win = kl.slice(-SWING_LOOKBACK, -3);
  if (win.length < 10) return null;
  const swingHigh = Math.max(...win.map(k => parseFloat(k[2])));
  const swingLow = Math.min(...win.map(k => parseFloat(k[3])));

  // has it already been swept in the last 3 bars? if so, the pool is gone
  const recent = kl.slice(-3);
  const sweptHigh = recent.some(k => parseFloat(k[2]) > swingHigh);
  const sweptLow = recent.some(k => parseFloat(k[3]) < swingLow);

  const distHigh = ((swingHigh - price) / price) * 100; // + = level above
  const distLow = ((price - swingLow) / price) * 100;   // + = level below

  // volatility contraction: recent ATR vs earlier ATR (<1 means coiling)
  const atrNow = atr(highs, lows, closes, 14);
  const atrPrev = atr(highs.slice(0, -14), lows.slice(0, -14), closes.slice(0, -14), 14);
  if (!atrNow || !atrPrev) return null;
  const compression = atrNow / atrPrev;
  const atrPct = (atrNow / price) * 100;

  // a coin that barely moves cannot produce a tradeable setup
  if (atrPct < MIN_ATR_PCT) return null;

  // candidate levels: un-swept, and price is close to them
  const cands = [];
  if (!sweptHigh && distHigh >= 0 && distHigh <= NEAR_LEVEL_PCT)
    cands.push({ side: "highs", level: swingHigh, dist: distHigh });
  if (!sweptLow && distLow >= 0 && distLow <= NEAR_LEVEL_PCT)
    cands.push({ side: "lows", level: swingLow, dist: distLow });
  if (!cands.length) return null;

  const best = cands.sort((a, b) => a.dist - b.dist)[0];

  // score: closer to the level + more compression = better. Lower is better.
  const score = best.dist * 1.0 + compression * 2.0 + Math.abs(move24) * 0.15;

  return {
    symbol: sym,
    coin: sym.replace(new RegExp(QUOTE + "$"), ""),
    price,
    move24: +move24.toFixed(2),
    level: best.level,
    levelSide: best.side,               // "highs" = pool above, "lows" = pool below
    distPct: +best.dist.toFixed(2),
    compression: +compression.toFixed(2),
    atrPct: +atrPct.toFixed(2),
    score: +score.toFixed(3),
    note:
      best.side === "highs"
        ? `Price ${best.dist.toFixed(2)}% under un-swept highs (${best.level}). Watch for the sweep, then a short setup — or a reclaim.`
        : `Price ${best.dist.toFixed(2)}% above un-swept lows (${best.level}). Watch for the sweep, then a long setup.`
  };
}

async function buildWatchlist() {
  const tickers = await j("/api/v3/ticker/24hr");

  const universe = tickers
    .filter(t => t.symbol.endsWith(QUOTE))
    .filter(t => !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
    .filter(t => !STABLES.has(t.symbol.replace(new RegExp(QUOTE + "$"), ""))) // no stables
    .filter(t => parseFloat(t.quoteVolume) >= MIN_QUOTE_VOL_24H)
    .filter(t => Math.abs(parseFloat(t.priceChangePercent)) <= MAX_ABS_24H_MOVE) // anti-FOMO
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, MAX_SCAN);

  const started = Date.now();
  const out = [];
  let scanned = 0;

  // Fetch klines in small parallel batches. Sequential requests are too slow
  // for a serverless timeout once latency is added.
  for (let i = 0; i < universe.length; i += BATCH) {
    if (Date.now() - started > TIME_BUDGET_MS) break; // return what we have

    const batch = universe.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(t =>
        j(`/api/v3/klines?symbol=${t.symbol}&interval=${KLINE_INTERVAL}&limit=${KLINES}`)
          .then(kl => ({ t, kl }))
      )
    );

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const { t, kl } = r.value;
      scanned++;
      if (!Array.isArray(kl) || kl.length < 50) continue;
      try {
        const row = screenSymbol(t.symbol, kl, parseFloat(t.priceChangePercent));
        if (row) out.push(row);
      } catch (_) { /* skip symbol on error */ }
    }
  }

  out.sort((a, b) => a.score - b.score);
  return {
    generatedAt: new Date().toISOString(),
    source: ACTIVE_HOST,
    scanned,
    criteria: {
      excludedStablecoins: true,
      minAtrPct: MIN_ATR_PCT,
      excludedMoveOver: MAX_ABS_24H_MOVE,
      minQuoteVol24h: MIN_QUOTE_VOL_24H,
      nearLevelWithinPct: NEAR_LEVEL_PCT,
      interval: KLINE_INTERVAL
    },
    items: out.slice(0, MAX_RESULTS)
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  try {
    const data = await buildWatchlist();
    // cache at the edge for an hour so repeat opens are instant
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json(data);
  } catch (e) {
    const msg = String((e && e.message) || e);
    const hint = msg.includes("451")
      ? "Binance is blocking this server's region. Check that vercel.json pins this function to a non-restricted region (fra1)."
      : "";
    res.status(500).json({ error: msg, hint });
  }
}
