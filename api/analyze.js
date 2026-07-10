// Serverless proxy for WASTED_DON.
// Holds your Anthropic API key server-side so friends never see it.
// Deploy on Vercel; set ANTHROPIC_API_KEY (and optionally ACCESS_CODE) as env vars.

export default async function handler(req, res) {
  // Basic CORS (same-origin in practice; harmless if served from one domain)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-access-code");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: "Server not configured: missing ANTHROPIC_API_KEY." }); return; }

  // Optional shared access code so a leaked link can't spend your credits.
  const required = process.env.ACCESS_CODE;
  if (required) {
    const provided = req.headers["x-access-code"];
    if (provided !== required) { res.status(401).json({ error: "Wrong or missing access code." }); return; }
  }

  try {
    // Vercel parses JSON bodies automatically; fall back to manual parse just in case.
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const content = body && body.content;
    if (!content) { res.status(400).json({ error: "Missing 'content' in request body." }); return; }

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content }]
      })
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
