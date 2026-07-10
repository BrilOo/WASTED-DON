// Daily watchlist screener for WASTED_DON.
// Runs on a schedule (see vercel.json cron) and on demand via GET /api/watchlist.
//
// PHILOSOPHY: this does NOT rank by biggest gainers/losers (that's the FOMO list —
// those coins already made their move). It screens for coins where a setup may be
// FORMING: price coiling near an un-swept liquidity level, with contracting volatility,
// and explicitly EXCLUDES anything that already ran hard in the last 24h.

const BINANCE = "https://api.binance.com";

// ---- tunables -------------------------------------------------------------
const QUOTE = "USDT";
const MIN_QUOTE_VOL_24H = 20_000_000; // liquidity floor, in USDT
const MAX_ABS_24H_MOVE = 6;           // % — exclude coins that already ran (anti-FOMO)
const KLINE_INTERVAL = "1h";
const KLINES = 100;                   // ~4 days of 1h candles
const SWING_LOOKBACK = 40;            // bars used to find the liquidity pool
const NEAR_LEVEL_PCT = 2.0;           // price must be within this % of the level
const MAX_RESULTS = 8;
const MAX_SCAN = 60;                  // cap how many symbols we pull klines for
// ---------------------------------------------------------------------------

async function j(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Binance " + r.status + " on " + url);
  return r.json();
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
  const tickers = await j(`${BINANCE}/api/v3/ticker/24hr`);

  const universe = tickers
    .filter(t => t.symbol.endsWith(QUOTE))
    .filter(t => !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
    .filter(t => parseFloat(t.quoteVolume) >= MIN_QUOTE_VOL_24H)
    .filter(t => Math.abs(parseFloat(t.priceChangePercent)) <= MAX_ABS_24H_MOVE) // anti-FOMO
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, MAX_SCAN);

  const out = [];
  for (const t of universe) {
    try {
      const kl = await j(
        `${BINANCE}/api/v3/klines?symbol=${t.symbol}&interval=${KLINE_INTERVAL}&limit=${KLINES}`
      );
      if (!Array.isArray(kl) || kl.length < 50) continue;
      const row = screenSymbol(t.symbol, kl, parseFloat(t.priceChangePercent));
      if (row) out.push(row);
    } catch (_) { /* skip symbol on error */ }
  }

  out.sort((a, b) => a.score - b.score);
  return {
    generatedAt: new Date().toISOString(),
    criteria: {
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
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
