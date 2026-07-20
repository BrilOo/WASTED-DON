// Sweep-alert checker for WASTED_DON.
//
// HOW IT WORKS (updated)
//   1. /api/watchlist (or the Watchlist tab's "Arm alerts" button, via /api/arm-alerts)
//      produces coins watching a liquidity level (e.g. TRY sweep of 0.3294).
//   2. An external scheduler (cron-job.org) pings THIS endpoint every ~10-15 minutes.
//   3. On each ping, for every armed level, we now run a THREE-STAGE check instead of
//      firing the moment price touches the level:
//
//        armed  --(sweep: a candle's wick pierces the level)-->  swept, watching
//        swept  --(reaction over the following candles)-->  confirmed reversal
//               --(reaction over the following candles)-->  confirmed continuation
//               --(no clear reaction within REACTION_TIMEOUT_MS)-->  expired, no alert
//
//      We do NOT email at the moment of the sweep anymore. We only email once the
//      reaction is CONFIRMED, and the email says which one happened:
//
//        Reversal signs required (in order):
//          - rejection candle: wick beyond the level, small body, closes back inside
//          - AND a later candle closes beyond the nearest minor swing point on the
//            opposite side of the level (a real break of structure, not just a wick)
//
//        Continuation signs required:
//          - a solid-bodied candle closing beyond the level and staying there
//          - a retest of the level that holds (price returns to it but doesn't
//            close back through it against the move)
//          - at least 2 consecutive same-direction candles with expanding range
//
//      A rejection wick alone is only a warning -- it does NOT fire an alert by itself.
//      The alert only fires once the full sequence (sweep -> reaction -> structure
//      break, OR sweep -> solid close -> held retest -> expansion) has completed.
//
// STATE
//   Pending levels + already-fired levels are kept in Vercel KV (free).
//   This file adds new fields to each pending level object as it progresses through
//   the stages (status, sweptAt, sweptBarTime, structurePoint). Nothing needs to
//   change in arm-alerts.js / watchlist.js -- levels still arrive as
//   { symbol, level, side, coin, ... } and this file fills in the rest itself.
//
// ENV VARS REQUIRED (set in Vercel, then redeploy):
//   RESEND_API_KEY   - from resend.com (free tier)
//   ALERT_EMAIL_TO   - where alerts are sent (your email)
//   ALERT_EMAIL_FROM - a verified sender, e.g. alerts@yourdomain — or use onboarding@resend.dev for testing
//   CRON_SECRET      - any random string; the scheduler must send it (?key=... ) so randoms can't trigger emails
//   KV_REST_API_URL, KV_REST_API_TOKEN - auto-added when you create a Vercel KV store

const HOSTS = [
  "https://data-api.binance.vision",
  "https://data.binance.com",
  "https://api.binance.com",
  "https://api1.binance.com"
];
let ACTIVE_HOST = null;

const KLINE_INTERVAL = "15m";     // candle used for sweep + reaction detection
const KLINE_LIMIT = 120;          // ~30 hours of 15m candles pulled each check

const SWING_ARM = 2;              // candles either side required to qualify as a minor swing point
const STRUCTURE_LOOKBACK = 60;    // how far back (in candles) we look for a minor swing point
const REACTION_TIMEOUT_MS = 6 * 60 * 60 * 1000; // give up watching a sweep after 6 hours if no clear reaction

// ---- tiny KV helpers (Vercel KV REST API) --------------------------------
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOK = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOK}` }
  });
  if (!r.ok) return null;
  const d = await r.json();
  try { return d.result ? JSON.parse(d.result) : null; } catch { return null; }
}
async function kvSet(key, val) {
  if (!KV_URL) return;
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOK}`, "Content-Type": "application/json" },
    body: JSON.stringify(val)
  });
}
// --------------------------------------------------------------------------

async function fetchWithTimeout(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

async function j(path) {
  if (ACTIVE_HOST) {
    const r = await fetchWithTimeout(ACTIVE_HOST + path);
    if (!r.ok) throw new Error("Binance " + r.status);
    return r.json();
  }
  for (const host of HOSTS) {
    try {
      const r = await fetchWithTimeout(host + path);
      if (r.ok) { ACTIVE_HOST = host; return r.json(); }
    } catch (_) {}
  }
  throw new Error("All Binance hosts unreachable");
}

// candle helper: kl[i] = [openTime, open, high, low, close, volume, closeTime, ...]
function candle(kl, i) {
  return {
    time: kl[i][0],
    open: parseFloat(kl[i][1]),
    high: parseFloat(kl[i][2]),
    low: parseFloat(kl[i][3]),
    close: parseFloat(kl[i][4])
  };
}

// Simple moving average of the closes over the last n candles.
function sma(closes, n) {
  if (closes.length < n) return null;
  const s = closes.slice(-n);
  return s.reduce((a, b) => a + b, 0) / n;
}

// Read the trend from stacked moving averages, same idea as MA(7)/MA(25)/MA(99).
function trendOf(closes) {
  const fast = sma(closes, 7);
  const mid = sma(closes, 25);
  const slow = sma(closes, 99) || sma(closes, Math.min(50, closes.length - 1));
  if (fast == null || mid == null || slow == null) return "flat";
  if (fast > mid && mid > slow) return "up";
  if (fast < mid && mid < slow) return "down";
  return "flat";
}

// ---- STAGE 1: has the level been swept (wick pierced it)? ---------------
// Returns the index of the first bar (searching from `fromIndex` onward) whose
// wick pierces the level, or null if no sweep yet.
function findSweepIndex(kl, level, side, fromIndex) {
  for (let i = Math.max(fromIndex, 0); i < kl.length; i++) {
    const c = candle(kl, i);
    if (side === "highs" && c.high > level) return i;
    if (side === "lows" && c.low < level) return i;
  }
  return null;
}

// ---- minor swing point detection (fractal: N candles lower/higher on both sides) --
function findSwingPoints(kl, endIndex) {
  const highs = [], lows = [];
  const start = Math.max(SWING_ARM, endIndex - STRUCTURE_LOOKBACK);
  for (let i = start; i < Math.min(endIndex, kl.length - SWING_ARM); i++) {
    if (i - SWING_ARM < 0) continue;
    const h = parseFloat(kl[i][2]);
    const l = parseFloat(kl[i][3]);
    let isHigh = true, isLow = true;
    for (let off = -SWING_ARM; off <= SWING_ARM; off++) {
      if (off === 0) continue;
      const n = i + off;
      if (n < 0 || n >= kl.length) continue;
      if (parseFloat(kl[n][2]) >= h) isHigh = false;
      if (parseFloat(kl[n][3]) <= l) isLow = false;
    }
    if (isHigh) highs.push({ price: h, time: kl[i][0], index: i });
    if (isLow) lows.push({ price: l, time: kl[i][0], index: i });
  }
  return { highs, lows };
}

// The nearest minor structure point on the OPPOSITE side of the sweep, found using
// only candles that closed before the sweep happened (so we're not looking into the future).
function nearestOpposingStructure(kl, sweepIndex, side) {
  const { highs, lows } = findSwingPoints(kl, sweepIndex);
  // side "highs" swept (top pool taken) -> reversal needs a break DOWN through a minor swing LOW
  // side "lows" swept (bottom pool taken) -> reversal needs a break UP through a minor swing HIGH
  const arr = side === "highs" ? lows : highs;
  if (!arr.length) return null;
  return arr[arr.length - 1]; // most recent one before the sweep
}

// ---- STAGE 2: has the reaction confirmed a reversal or a continuation? ----
// Scans every candle from the sweep bar onward. Returns:
//   { type: "reversal", structurePoint }
//   { type: "continuation" }
//   null  -> no confirmation yet, keep watching
function checkReaction(kl, level, side, sweepIndex, structurePoint) {
  // --- REVERSAL: rejection candle, THEN a later close breaking the opposing structure ---
  let rejectionSeenAt = -1;
  for (let i = sweepIndex; i < kl.length; i++) {
    const c = candle(kl, i);
    const range = (c.high - c.low) || 1e-9;
    const body = Math.abs(c.close - c.open);
    const beyondLevel = side === "highs" ? c.high > level : c.low < level;
    const closedBackInside = side === "highs" ? c.close < level : c.close > level;
    const smallBody = (body / range) <= 0.4;

    if (rejectionSeenAt === -1 && beyondLevel && closedBackInside && smallBody) {
      rejectionSeenAt = i; // warning sign only -- do not alert yet
    }

    // once we've seen a rejection candle, watch every candle AFTER it for a structure break
    if (rejectionSeenAt !== -1 && i > rejectionSeenAt && structurePoint) {
      const brokeDown = side === "highs" && c.close < structurePoint.price;
      const brokeUp = side === "lows" && c.close > structurePoint.price;
      if (brokeDown || brokeUp) {
        return { type: "reversal", structurePoint };
      }
    }
  }

  // --- CONTINUATION: solid close beyond level, retest holds, expanding same-direction candles ---
  let breakoutIdx = -1;
  for (let i = sweepIndex; i < kl.length; i++) {
    const c = candle(kl, i);
    const range = (c.high - c.low) || 1e-9;
    const body = Math.abs(c.close - c.open);
    const beyondLevel = side === "highs" ? c.close > level : c.close < level;
    const solidBody = (body / range) >= 0.6;
    if (beyondLevel && solidBody) { breakoutIdx = i; break; }
  }
  if (breakoutIdx !== -1) {
    let sameDirCount = 0;
    let lastRange = 0;
    let expanding = true;
    let retestHeld = true;
    for (let j = breakoutIdx + 1; j < kl.length; j++) {
      const c = candle(kl, j);
      const range = (c.high - c.low) || 1e-9;
      const sameDir = side === "highs" ? c.close > c.open : c.close < c.open;
      if (sameDir) {
        sameDirCount++;
        if (lastRange && range < lastRange) expanding = false;
        lastRange = range;
      }
      const touchesLevel = side === "highs" ? c.low <= level * 1.0015 : c.high >= level * 0.9985;
      if (touchesLevel) {
        const held = side === "highs" ? c.close > level : c.close < level;
        if (!held) retestHeld = false;
      }
    }
    if (sameDirCount >= 2 && expanding && retestHeld) {
      return { type: "continuation" };
    }
  }

  return null; // still just watching
}

function readSetup(side, trend, reactionType) {
  // reactionType is now "reversal" or "continuation" -- confirmed by candle behaviour,
  // trend is kept only as supporting context in the email, not as the decider anymore.
  if (reactionType === "reversal") {
    return side === "highs"
      ? { dir: "SHORT (reversal confirmed)", conf: "price swept the highs, rejected, and broke the nearest minor structure to the downside" }
      : { dir: "LONG (reversal confirmed)", conf: "price swept the lows, rejected, and broke the nearest minor structure to the upside" };
  }
  // continuation
  return side === "highs"
    ? { dir: "LONG continuation (confirmed)", conf: "price swept the highs and pushed on through with a solid close, a held retest, and expanding candles" }
    : { dir: "SHORT continuation (confirmed)", conf: "price swept the lows and pushed on through with a solid close, a held retest, and expanding candles" };
}

async function sendEmail(subject, html) {
  const key = process.env.RESEND_API_KEY;
  const to = (process.env.ALERT_EMAIL_TO || "").split(",").map(s => s.trim()).filter(Boolean);
  const from = process.env.ALERT_EMAIL_FROM || "onboarding@resend.dev";
  if (!key || !to.length) return { skipped: "missing RESEND_API_KEY or ALERT_EMAIL_TO" };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html })
  });
  return r.ok ? { sent: true } : { error: "Resend " + r.status + " " + (await r.text()) };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // simple shared-secret guard so strangers can't trigger email sends
  const secret = process.env.CRON_SECRET;
  const provided = (req.query && req.query.key) || "";
  if (secret && provided !== secret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const pending = (await kvGet("wd_alert_levels")) || [];
    if (!pending.length) {
      res.status(200).json({ checked: 0, fired: 0, note: "No pending levels. Open the Watchlist and press 'Arm alerts'." });
      return;
    }

    const fired = [];
    const stillPending = [];

    for (const p of pending) {
      if (p.done) continue;
      if (!p.status) p.status = "armed"; // back-compat for levels armed before this update

      try {
        const kl = await j(`/api/v3/klines?symbol=${p.symbol}&interval=${KLINE_INTERVAL}&limit=${KLINE_LIMIT}`);
        if (!kl || kl.length < SWING_ARM * 2 + 5) { stillPending.push(p); continue; }

        // ---- STAGE 1: not swept yet -> look for the sweep ----
        if (p.status === "armed") {
          const idx = findSweepIndex(kl, p.level, p.side, 0);
          if (idx !== null) {
            p.status = "swept";
            p.sweptAt = new Date().toISOString();
            p.sweptBarTime = kl[idx][0];
            const structurePoint = nearestOpposingStructure(kl, idx, p.side);
            p.structurePoint = structurePoint ? { price: structurePoint.price, time: structurePoint.time } : null;
          }
          stillPending.push(p);
          continue; // never alert on the sweep itself -- wait for next check
        }

        // ---- STAGE 2: swept, watching for confirmed reaction ----
        if (p.status === "swept") {
          // give up watching if it's dragged on too long with no clear reaction
          if (Date.now() - new Date(p.sweptAt).getTime() > REACTION_TIMEOUT_MS) {
            p.status = "expired";
            p.done = true;
            p.firedAt = new Date().toISOString();
            stillPending.push(p);
            continue;
          }

          // relocate the sweep bar in this run's candle set (falls back to 0 if it rolled off)
          let sweepIndex = kl.findIndex(k => k[0] === p.sweptBarTime);
          if (sweepIndex === -1) sweepIndex = 0;

          const reaction = checkReaction(kl, p.level, p.side, sweepIndex, p.structurePoint);
          if (reaction) {
            const closes = kl.map(k => parseFloat(k[4]));
            const trend = trendOf(closes);
            const setup = readSetup(p.side, trend, reaction.type);
            const coin = String(p.symbol || "").replace(/(USDT|USDC|BUSD|FDUSD|TUSD)$/, "") || p.coin || p.symbol;
            const trendLabel = trend === "up" ? "uptrend" : trend === "down" ? "downtrend" : "no clear trend";
            const label = reaction.type === "reversal" ? "Reversal confirmed" : "Continuation confirmed";

            const r = await sendEmail(
              `⚡ ${coin} sweep of ${p.level} — ${label}`,
              `<div style="font-family:sans-serif">
                 <h2>${coin}: ${label}</h2>
                 <p><b>Pair:</b> ${p.symbol} &nbsp;·&nbsp; <b>Trend:</b> ${trendLabel}</p>
                 <p>Price swept the ${p.side === "lows" ? "un-swept lows" : "un-swept highs"} at <b>${p.level}</b>,
                 and the candle reaction since then has now confirmed a <b>${label.toLowerCase()}</b>.</p>
                 <p><b>Likely read: ${setup.dir}.</b> ${setup.conf}.</p>
                 <p>Now pull the ${coin} chart and run it through WASTED_DON to confirm.
                 The alert says <i>go look</i> — not <i>enter</i>. Let the analysis settle the direction.</p>
               </div>`
            );
            fired.push({ coin, symbol: p.symbol, level: p.level, trend, read: setup.dir, type: reaction.type, email: r });
            p.status = "confirmed";
            p.done = true;
            p.firedAt = new Date().toISOString();
          }
          stillPending.push(p);
          continue;
        }

        // unknown status (shouldn't happen) -- keep it, don't alert
        stillPending.push(p);
      } catch (e) {
        stillPending.push(p); // keep it, try next ping
      }
    }

    // keep fired/expired ones (marked done) for a day so we don't re-arm the same level
    const keep = pending.filter(p => p.done && Date.now() - new Date(p.firedAt || Date.now()).getTime() < 86400000);
    await kvSet("wd_alert_levels", [...stillPending, ...keep]);

    // ---- also check single PRICE alerts (from the analysis "Alert me at this price" button) ----
    // unchanged: these are a direct price target, not a sweep, so no reaction logic applies.
    let priceFired = 0;
    try {
      const priceAlerts = (await kvGet("wd_price_alerts")) || [];
      if (priceAlerts.length) {
        const stillP = [];
        const keepP = [];
        for (const a of priceAlerts) {
          if (a.done) {
            if (Date.now() - new Date(a.firedAt || 0).getTime() < 86400000) keepP.push(a);
            continue;
          }
          try {
            const t = await j(`/api/v3/ticker/price?symbol=${a.symbol}`);
            const last = parseFloat(t.price);
            // fire when price is within 0.15% of the target (reached the level)
            if (isFinite(last) && Math.abs(last - a.price) / a.price <= 0.0015) {
              await sendEmail(
                `🔔 ${a.coin} reached ${a.price} — time to look`,
                `<div style="font-family:sans-serif">
                   <h2>${a.coin} hit your alert price</h2>
                   <p><b>Pair:</b> ${a.symbol} &nbsp;·&nbsp; <b>Now:</b> ${last}</p>
                   <p>Price reached <b>${a.price}</b>, the level WASTED_DON told you to wait for.</p>
                   ${a.note ? `<p>${a.note}</p>` : ""}
                   <p>Pull the ${a.coin} chart and re-run it through WASTED_DON. Go look — don't enter blind.</p>
                 </div>`
              );
              a.done = true; a.firedAt = new Date().toISOString();
              keepP.push(a); priceFired++;
            } else {
              stillP.push(a);
            }
          } catch (_) { stillP.push(a); }
        }
        await kvSet("wd_price_alerts", [...stillP, ...keepP]);
      }
    } catch (_) { /* price alerts optional */ }

    res.status(200).json({ checked: pending.length, fired: fired.length, priceFired, details: fired });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
