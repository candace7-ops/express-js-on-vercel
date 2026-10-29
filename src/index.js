import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Change on deploy to verify the running build
const BUILD_ID = "SAFE-MODE-BRIEF-2026-10-29-01";

const PUBLIC_DIR = path.join(__dirname, "..", "public");
app.use(express.static(PUBLIC_DIR));

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/healthz", (_req, res) => {
  res.status(200).json({
    status: "ok",
    buildId: BUILD_ID,
    timestamp: new Date().toISOString()
  });
});

function simpleSentimentLabel(text) {
  const t = (text || "").toLowerCase();
  const pos = ["beat", "surge", "soar", "rally", "bull", "bullish", "upgrade", "profit", "growth", "strong"];
  const neg = ["miss", "drop", "plunge", "bear", "bearish", "downgrade", "lawsuit", "probe", "risk", "weak"];

  let score = 0;
  for (const w of pos) if (t.includes(w)) score += 1;
  for (const w of neg) if (t.includes(w)) score -= 1;

  if (score >= 2) return { label: "Bullish", score };
  if (score <= -2) return { label: "Bearish", score };
  return { label: "Neutral", score };
}

app.get("/api/brief", async (req, res) => {
  try {
    const ticker = String(req.query.ticker || "").trim().toUpperCase();
    if (!ticker) return res.status(400).json({ error: "Missing ticker. Use ?ticker=AAPL" });

    const now = new Date().toISOString();
    const sentiment = simpleSentimentLabel(ticker);

    // Always return instantly; no external calls; cannot hang.
    const brief30s =
      `- Tone: ${sentiment.label}\n` +
      `- ${ticker}: Brief temporarily running in SAFE MODE (no AI calls).\n` +
      `- If you just deployed changes, wait 1–2 minutes for Vercel to finish deploying.\n` +
      `- Next step: we’ll re-enable Gemini with proper timeouts + error logs.\n` +
      `- Not financial advice.`;

    res.json({
      buildId: BUILD_ID,
      ticker,
      generatedAt: now,
      brief30s,
      sentiment,
      ai: { provider: "none", used: false, note: "SAFE MODE" },
      headlines: []
    });
  } catch (e) {
    // Never throw; always respond.
    res.status(200).json({
      buildId: BUILD_ID,
      brief30s: "- Tone: Neutral\n- SAFE MODE error fallback.\n- Not financial advice."
    });
  }
});

export default app;
