// Sweep-alert checker for WASTED_DON.
//
// HOW IT WORKS
//   1. /api/watchlist produces coins watching a liquidity level (e.g. TRY sweep of 0.3294).
//   2. An external scheduler (cron-job.org) pings THIS endpoint every ~10 minutes.
//   3. On each ping we pull recent candles for the watched coins and look for a
//      CONFIRMED sweep: price wicked through the level, then a candle CLOSED back on
//      the original side (a real sweep + rejection, not just a touch/wick).
//   4. When that happens we email the user once for that level, then mark it fired
//      so it doesn't spam.
//
// STATE
//   Pending levels + already-fired levels are kept in Vercel KV (free).
//   The watchlist endpoint writes the pending levels; this endpoint reads and updates them.
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

const KLINE_INTERVAL = "15m"; // candle used to confirm the close-back
const CONFIRM_BARS = 3;       // how many recent closed candles to inspect

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

// A confirmed sweep of an un-swept HIGH (pool above): a recent candle's HIGH pierced
// the level, and a candle then CLOSED back BELOW it -> failed breakout / liquidity grab.
// For an un-swept LOW (pool below): a candle's LOW pierced under, then CLOSED back ABOVE.
function confirmedSweep(kl, level, side) {
  const bars = kl.slice(-CONFIRM_BARS);
  for (let i = 0; i < bars.length; i++) {
    const high = parseFloat(bars[i][2]);
    const low = parseFloat(bars[i][3]);
    const close = parseFloat(bars[i][4]);
    if (side === "highs" && high > level && close < level) return { at: close, bar: i };
    if (side === "lows" && low < level && close > level) return { at: close, bar: i };
  }
  return null;
}

async function sendEmail(subject, html) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM || "onboarding@resend.dev";
  if (!key || !to) return { skipped: "missing RESEND_API_KEY or ALERT_EMAIL_TO" };
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
      try {
        const kl = await j(`/api/v3/klines?symbol=${p.symbol}&interval=${KLINE_INTERVAL}&limit=${CONFIRM_BARS + 2}`);
        const hit = confirmedSweep(kl, p.level, p.side);
        if (hit) {
          const dir = p.side === "lows" ? "LONG setup" : "SHORT setup";
          const coin = String(p.symbol || "").replace(/(USDT|USDC|BUSD|FDUSD|TUSD)$/, "") || p.coin || p.symbol;
          const r = await sendEmail(
            `⚡ ${coin} swept ${p.level} — watch for a ${dir}`,
            `<div style="font-family:sans-serif">
               <h2>${coin} confirmed sweep</h2>
               <p><b>Pair:</b> ${p.symbol}</p>
               <p>Price swept the ${p.side === "lows" ? "un-swept lows" : "un-swept highs"} at
               <b>${p.level}</b> and closed back (${hit.at}).</p>
               <p>Now pull the ${coin} chart and run it through WASTED_DON to confirm the ${dir}.
               The alert says <i>go look</i> — not <i>enter</i>.</p>
             </div>`
          );
          fired.push({ coin, symbol: p.symbol, level: p.level, email: r });
          p.done = true;
          p.firedAt = new Date().toISOString();
        } else {
          stillPending.push(p);
        }
      } catch (e) {
        stillPending.push(p); // keep it, try next ping
      }
    }

    // keep fired ones (marked done) for a day so we don't re-arm the same sweep
    const keep = pending.filter(p => p.done && Date.now() - new Date(p.firedAt || Date.now()).getTime() < 86400000);
    await kvSet("wd_alert_levels", [...stillPending, ...keep]);

    res.status(200).json({ checked: pending.length, fired: fired.length, details: fired });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
