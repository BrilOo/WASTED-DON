// Arms ONE price alert from an analysis wait-plan (the "🔔 Alert me at this price" button).
// Unlike the watchlist arm, this watches for price simply REACHING a given price
// (crossing it from either side) — a "go look, the wait zone is here" nudge.

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
  if (!KV_URL) throw new Error("KV not configured — create a Vercel KV store and redeploy.");
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOK}`, "Content-Type": "application/json" },
    body: JSON.stringify(val)
  });
}

// turn an asset label like "VELVET/USDT" into a Binance symbol "VELVETUSDT"
function toSymbol(asset) {
  if (!asset) return null;
  const s = String(asset).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/USDT$/.test(s)) return s;
  if (/USD$/.test(s)) return s.replace(/USD$/, "USDT");
  return s + "USDT";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  try {
    const body = req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    const price = Number(body.price);
    const symbol = toSymbol(body.asset);
    const note = String(body.note || "").slice(0, 240);
    const coin = symbol ? symbol.replace(/(USDT|USDC|BUSD|FDUSD|TUSD)$/, "") : (body.asset || "");

    if (!symbol || !isFinite(price)) {
      res.status(400).json({ error: "Need a valid asset and price." });
      return;
    }

    const existing = (await kvGet("wd_price_alerts")) || [];

    // dedup: same symbol + same price (to 6 sig places) already armed and not fired
    const key = `${symbol}|${price}`;
    const alreadyArmed = existing.some(
      a => `${a.symbol}|${a.price}` === key && !a.done
    );
    if (alreadyArmed) {
      res.status(200).json({ armed: 0, note: "Already armed for this price." });
      return;
    }

    const alert = {
      symbol,
      coin,
      price,
      note,
      armedAt: new Date().toISOString(),
      done: false
    };

    // keep recent (drop fired ones older than 24h to stay tidy)
    const keep = existing.filter(
      a => !a.done || Date.now() - new Date(a.firedAt || 0).getTime() < 86400000
    );

    await kvSet("wd_price_alerts", [...keep, alert]);
    res.status(200).json({ armed: 1, coin, price });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
