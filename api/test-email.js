// One-off test: sends a single email to confirm the Resend wiring works.
// Visit /api/test-email?key=YOUR_CRON_SECRET in a browser.
// Delete this file once you've confirmed a test email arrives.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // reuse the same secret guard as the alerts endpoint
  const secret = process.env.CRON_SECRET;
  const provided = (req.query && req.query.key) || "";
  if (secret && provided !== secret) {
    res.status(401).json({ error: "unauthorized — key does not match CRON_SECRET" });
    return;
  }

  const key = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM || "onboarding@resend.dev";

  if (!key) { res.status(500).json({ error: "RESEND_API_KEY is not set" }); return; }
  if (!to)  { res.status(500).json({ error: "ALERT_EMAIL_TO is not set" }); return; }

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to,
        subject: "✅ WASTED_DON test alert — email is working",
        html: `<div style="font-family:sans-serif">
                 <h2>Your alert email works.</h2>
                 <p>This is a test from WASTED_DON. If you're reading this, the full pipeline is live:
                 Resend is sending, and this address (${to}) is receiving.</p>
                 <p>Real sweep alerts will look like: <i>"⚡ SOL swept 78.40 — watch for a LONG setup."</i></p>
                 <p style="color:#888">You can delete the /api/test-email endpoint now.</p>
               </div>`
      })
    });
    const body = await r.text();
    if (!r.ok) { res.status(502).json({ error: "Resend " + r.status, detail: body }); return; }
    res.status(200).json({ sent: true, to, from, resend: JSON.parse(body || "{}") });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
