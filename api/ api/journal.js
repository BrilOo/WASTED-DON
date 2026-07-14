// api/journal.js — cloud save/load of the journal via Upstash KV
// Keyed by a private sync code the user enters in the Journal tab.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.result ?? null;
}

async function kvSet(key, value) {
  const res = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(value)
  });
  return res.ok;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!KV_URL || !KV_TOKEN) {
    return res.status(500).json({ error: "KV not configured (missing env vars)" });
  }

  try {
    if (req.method === "POST") {
      // Save journal
      const { syncCode, journal } = req.body || {};
      if (!syncCode || typeof syncCode !== "string" || syncCode.length < 6) {
        return res.status(400).json({ error: "Sync code required (min 6 characters)" });
      }
      if (!Array.isArray(journal)) {
        return res.status(400).json({ error: "Journal must be an array" });
      }
      const key = `journal:${syncCode}`;
      const payload = JSON.stringify({ journal, savedAt: Date.now() });
      const ok = await kvSet(key, payload);
      if (!ok) return res.status(500).json({ error: "Failed to save to KV" });
      return res.status(200).json({ ok: true, count: journal.length });
    }

    if (req.method === "GET") {
      // Load journal: /api/journal?syncCode=XXXX
      const syncCode = (req.query && req.query.syncCode) || "";
      if (!syncCode || syncCode.length < 6) {
        return res.status(400).json({ error: "Sync code required (min 6 characters)" });
      }
      const key = `journal:${syncCode}`;
      const raw = await kvGet(key);
      if (!raw) return res.status(200).json({ journal: null });
      let parsed;
      try {
        parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch (e) {
        return res.status(500).json({ error: "Stored data corrupted" });
      }
      return res.status(200).json({
        journal: parsed.journal || null,
        savedAt: parsed.savedAt || null
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
};
