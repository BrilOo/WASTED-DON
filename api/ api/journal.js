// Cloud storage for the journal (and concepts/settings), so they survive app
// updates, cache clears, and device changes — not just the browser.
//
// GET  /api/journal?code=XXX      -> { data: {...} | null }
// POST /api/journal   body {code, data}  -> { saved: true }
//
// "code" is a per-user key so different people (or your own devices) keep
// separate journals. It uses the same access code the app already has, or any
// label the user sets. Data is stored under wd_journal:<code> in KV.

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

// keep the key safe and bounded
function keyFor(code) {
  const c = String(code || "default").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "default";
  return "wd_journal:" + c;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (!KV_URL) { res.status(500).json({ error: "Cloud storage not configured (KV missing)." }); return; }

  try {
    if (req.method === "GET") {
      const code = (req.query && req.query.code) || "default";
      const data = await kvGet(keyFor(code));
      res.status(200).json({ data: data || null });
      return;
    }
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      const code = body && body.code;
      const data = body && body.data;
      if (data == null) { res.status(400).json({ error: "Missing data." }); return; }
      // guard against oversized payloads (KV value limit)
      const size = JSON.stringify(data).length;
      if (size > 4_500_000) { res.status(413).json({ error: "Journal too large to sync (over ~4.5MB). Export a backup and trim old entries." }); return; }
      await kvSet(keyFor(code), data);
      res.status(200).json({ saved: true });
      return;
    }
    res.status(405).json({ error: "GET or POST only" });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
