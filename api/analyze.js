// Serverless proxy for WASTED_DON.
// Holds your Anthropic API key AND your private trading framework server-side,
// so anyone you share the link with never sees the concepts in their browser.
// Deploy on Vercel; set ANTHROPIC_API_KEY (and optionally ACCESS_CODE) as env vars.
//
// TO EDIT YOUR CONCEPTS: edit the HOUSE_RULES text below and commit. Only you
// (the repo owner) can do this — visitors never receive this file's contents.

const HOUSE_RULES = JSON.parse(`{"seed_bagtract_loose": "A flexible SMC/ICT read. ALWAYS give a directional entry and grade it A/B/C — do not refuse.\\n\\nBIAS: Direction from structure (higher highs/lows = long; lower highs/lows = short) and price vs the dominant trend / MA99 if shown.\\n\\nCORE (mainly drive the grade):\\n- Liquidity grab: price swept beyond a clear level (equal highs/lows, prior day/week high/low, or a swing) and closed back inside.\\n- Displacement: a strong impulsive candle/run in the bias direction.\\n- Entry zone: a retracement into a Fair Value Gap, Order Block, or Mitigation Block, ideally in the right half (discount for longs, premium for shorts).\\n\\nSUPPORTING (raise the grade, NOT required):\\n- Break of Structure or CHOCH confirmation.\\n- Inducement (a smaller opposing pool taken out first).\\n\\nGRADING:\\n- A = sweep + displacement + clean entry zone all present, trend agrees.\\n- B = bias clear and an entry zone exists, but one core element is weak/unconfirmed.\\n- C = the SMC sequence is mostly absent — do NOT give an entry. Set grade_block=true and say what is missing and what to wait for.\\n\\nSTOP: beyond the recent swing / grab extreme with a small buffer.\\nTARGETS: TP1 ~2R; TP2 at the next opposing liquidity level (opposing swing / equal highs / equal lows).", "seed_bagtract_strict": "Quality-over-quantity SMC/ICT setup. Be strict; most charts should NOT qualify (grade C and warn when they don't).\\n\\nBIAS: Bullish = higher highs + higher lows; bearish = lower highs + lower lows. If choppy/directionless, lowest grade. Entries must agree with the MA99 (or dominant trend if MAs aren't shown).\\n\\nTHE SEQUENCE (all should be present for a top grade):\\n- B — Break of Structure: a candle CLOSED beyond the prior swing in the bias direction.\\n- A — Accumulation: a tight, low-range contraction phase just before a strong move.\\n- G — Liquidity Grab: price wicked BEYOND a clear level (equal highs/lows, prior day/week high or low, or a major swing) then CLOSED back inside.\\n- Inducement: a smaller opposing liquidity pool between price and target taken out first.\\n\\nCONFIRMATION (need at least one AFTER the grab): Displacement (large-body impulsive candle/run), CHOCH (close beyond last opposing internal swing), or BOS in the intended direction.\\n\\nENTRY: only on a retracement INTO a Fair Value Gap (3-candle imbalance), Order Block (last opposing candle before displacement), or Mitigation Block — in the correct half: discount (lower) for longs, premium (upper) for shorts.\\n\\nSTOP: just beyond the grab / order block extreme, small buffer.\\nTARGETS: TP1 at 2R then breakeven; TP2 at the next opposing major liquidity level.\\n\\nGOLDEN GATE — grade A only if ALL true: (1) sweep occurred, (2) inducement cleared, (3) displacement present, (4) BOS or CHOCH confirmed, (5) retrace into a valid FVG/OB/MB in the correct premium/discount half. Each missing gate lowers the grade.", "seed_sweep_reaction": "Do NOT call a sweep reversal or continuation from the sweep itself or from trend alone. A sweep is only the first half of the picture — the candles AFTER it decide what it actually was. Read the reaction on the chart before committing to a direction.\\n\\nREVERSAL signs (all should be visible before calling reversal):\\n- A rejection candle: a long wick beyond the swept level with a small body closing back inside the range.\\n- A fast, sharp snap back through the level — not a slow grind back.\\n- Momentum visibly dying right at the level (candles contracting into the sweep, not extending).\\n- Most important: price breaking the nearest minor swing structure point in the OPPOSITE direction, after the sweep.\\n\\nCONTINUATION signs (all should be visible before calling continuation):\\n- A solid-bodied candle closing beyond the level and staying there.\\n- A retest of that level holding as new support/resistance.\\n- Consecutive same-direction candles with expanding range and no hesitation.\\n- No genuine liquidity pool (equal highs/lows) was actually swept in the first place — if there was no real pool, this was never a grab, treat it as no-signal rather than continuation.\\n\\nKEY RULE: a rejection wick by itself is only a WARNING sign, never confirmation on its own. The sequence must be complete on the chart — sweep, then rejection candle, then a break of the nearest opposing minor structure point — before reversal can be called. The same applies to continuation: sweep, then a held solid-bodied close, then a held retest, before continuation can be called.\\n\\nIf the chart only shows the sweep itself with no reaction candles yet, say so plainly, set grade_block=true, and say the read is waiting on the reaction — do not guess ahead of the candles.", "seed_atr_vol": "Use ATR (Average True Range) to read volatility and drive a volatility-based stop.\\n\\n- If an ATR value is visible in a provided data screenshot (or on the chart), read it and convert to % of price: ATR% = ATR ÷ price × 100. Put that number in the atr_pct field. If no ATR is shown, estimate ATR% visually from candle size on the execution timeframe and still fill atr_pct.\\n- Classify volatility from atr_pct into the volatility field: under ~1% = low, ~1–4% = medium, over ~4% = high (judge for the timeframe). Add a short volatility_note. If very low, note the setup may lack room; if very high, note larger swings.\\n- The tool will place a stop at 1.5× ATR from entry and size the position from it, so make atr_pct accurate for the execution timeframe.", "seed_exit_rules": "My fixed exit and risk rules — apply to every read and every coaching fix:\\n- SINGLE ENTRY only. Never suggest scaling in or averaging down.\\n- Stop: fixed at the structure level (beyond the liquidity grab / order block).\\n- Move the stop to BREAKEVEN once price is about 1R in my favour.\\n- Take profit: one or more targets (first around 2R); I may scale out across several targets when testing.\\nKeep entry and stop as one clean setup with a single R:R to the first target.", "seed_no_fomo": "Never chase price. Flag as FOMO (set fomo_block=true → no entry, wait for a pullback) when ANY clear sign is present:\\n- Price has already run a long way from the setup origin with no pullback (entering near the top of a long move / bottom of a short move).\\n- The candle at entry is vertical/parabolic — chasing a big impulsive candle instead of the retrace.\\n- The entry would be mid-move, far from a valid FVG / order block / value zone.\\n- R:R is poor because the clean entry was already missed (stop now far, target now close).\\nOnly block CLEAR chases — a normal pullback entry within a trend is fine. When in doubt, wait for a retrace into a valid zone in the correct premium/discount half.", "seed_ma99_trend": "Trade WITH the higher-timeframe trend, read from the MA99 (or the dominant trend if moving averages aren't shown):\\n- Price ABOVE the MA99 and MA99 sloping up = uptrend → favour LONGS. Only take shorts on a clear structure break against it, and grade them lower.\\n- Price BELOW the MA99 and MA99 sloping down = downtrend → favour SHORTS. Only take longs on a clear structure break against it, and grade them lower.\\n- Price hugging a FLAT MA99 = no trend → be very selective; most reads here are grade C (no entry).\\nA sweep that agrees with the trend (e.g. a low swept in an uptrend) is a continuation setup and scores higher. A sweep that fights the trend needs displacement AND a confirmed BOS/CHoCH before it can grade above C. Never call a counter-trend entry a top-grade setup on the sweep alone."}`);

// Which concepts are applied when the app doesn't specify (e.g. coaching calls).
const DEFAULT_ON = ["seed_bagtract_strict","seed_sweep_reaction","seed_atr_vol","seed_exit_rules","seed_no_fomo","seed_ma99_trend"];

function frameworkText(ids) {
  const use = (Array.isArray(ids) && ids.length) ? ids : DEFAULT_ON;
  const parts = [];
  let n = 1;
  for (const id of use) {
    if (HOUSE_RULES[id]) parts.push(`${n++}. ${HOUSE_RULES[id]}`);
  }
  if (!parts.length) return "";
  return "TRADER'S FRAMEWORK / CONCEPTS (apply these strictly):\n" + parts.join("\n\n");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-access-code");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: "Server not configured: missing ANTHROPIC_API_KEY." }); return; }

  const required = process.env.ACCESS_CODE;
  if (required) {
    const provided = req.headers["x-access-code"];
    if (provided !== required) { res.status(401).json({ error: "Wrong or missing access code." }); return; }
  }

  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    let content = body && body.content;
    if (!content) { res.status(400).json({ error: "Missing 'content' in request body." }); return; }
    if (!Array.isArray(content)) content = [content];

    // Inject the private framework SERVER-SIDE so it never lives in any browser.
    const fw = frameworkText(body && body.conceptIds);
    if (fw) {
      // place the framework right after the first text block (the instructions),
      // matching the app's "framework below" wording.
      const firstTextIdx = content.findIndex(b => b && b.type === "text");
      const fwBlock = { type: "text", text: fw };
      if (firstTextIdx >= 0) content.splice(firstTextIdx + 1, 0, fwBlock);
      else content.unshift(fwBlock);
    }

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content }]
      })
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
