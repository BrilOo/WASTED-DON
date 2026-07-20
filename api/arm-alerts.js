// Arms sweep alerts: takes the current watchlist levels and stores them in KV
// as "pending" so /api/alerts can watch them. Called by the "Arm alerts" button.
//
// IMPORTANT: this used to overwrite the whole pending list every time you pressed
// "Arm alerts". Now that /api/alerts can leave a level sitting in a "swept, watching
// for reaction" state for a few hours, an overwrite would have silently thrown away
// an in-progress sweep watch the moment you armed a different coin. So this now
// MERGES: any level currently mid-watch (already swept, not yet confirmed) is left
// alone; only the not-yet-swept "armed" levels get replaced with your latest picks.
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
    const newLevels = items
      .filter(i => i.symbol && i.level != null && (i.levelSide === "highs" || i.levelSide === "lows"))
      .map(i => ({
        symbol: i.symbol,
        coin: coinFromSymbol(i.symbol) || i.coin || i.symbol,
        level: i.level,
        side: i.levelSide,
        armedAt: new Date().toISOString(),
        status: "armed",
        done: false
      }));
    if (!newLevels.length) { res.status(400).json({ error: "No valid levels to arm." }); return; }

    const keyOf = l => `${l.symbol}|${l.level}|${l.side}`;

    // levels /api/alerts already has mid-watch (swept, waiting to see if it confirms) —
    // these keep their sweptAt / sweptBarTime / structurePoint and are left untouched.
    const existing = (await kvGet("wd_alert_levels")) || [];
    const preserved = existing.filter(l => !l.done && l.status === "swept");
    const preservedKeys = new Set(preserved.map(keyOf));

    // don't re-add a fresh "armed" copy of something already mid-watch under the same key
    const freshLevels = newLevels.filter(l => !preservedKeys.has(keyOf(l)));

    const merged = [...preserved, ...freshLevels];
    await kvSet("wd_alert_levels", merged);
    res.status(200).json({ armed: freshLevels.length, watching: preserved.length });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
