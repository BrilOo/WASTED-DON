// Arms sweep alerts: takes the current watchlist levels and stores them in KV
// as "pending" so /api/alerts can watch them. Called by the "Arm alerts" button.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOK = process.env.KV_REST_API_TOKEN;

async function kvSet(key, val) {
  if (!KV_URL) throw new Error("KV not configured — create a Vercel KV store and redeploy.");
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOK}`, "Content-Type": "application/json" },
    body: JSON.stringify(val)
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  try {
    const body = req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    const items = Array.isArray(body.items) ? body.items : [];
    // Always derive the coin from its own symbol (TRYUSDT -> TRY) so each level
    // carries its own correct name — never trust a possibly-missing coin field.
    const coinFromSymbol = s => String(s || "").replace(/(USDT|USDC|BUSD|FDUSD|TUSD)$/, "");
    const levels = items
      .filter(i => i.symbol && i.level != null && (i.levelSide === "highs" || i.levelSide === "lows"))
      .map(i => ({
        symbol: i.symbol,
        coin: coinFromSymbol(i.symbol) || i.coin || i.symbol,
        level: i.level,
        side: i.levelSide,
        armedAt: new Date().toISOString(),
        done: false
      }));

    if (!levels.length) { res.status(400).json({ error: "No valid levels to arm." }); return; }

    await kvSet("wd_alert_levels", levels);
    res.status(200).json({ armed: levels.length });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
