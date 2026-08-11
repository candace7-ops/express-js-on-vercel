import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// serve your static site
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// safest possible brief endpoint (no external calls, no Gemini, no RSS)
app.get("/api/brief", (req, res) => {
  const ticker = String(req.query.ticker || "").trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: "Missing ticker. Use ?ticker=AAPL" });

  res.json({
    ticker,
    generatedAt: new Date().toISOString(),
    brief30s: `30-second brief placeholder for ${ticker}.`,
    headlines: [],
    note: "Safe mode: external news + Gemini temporarily disabled so the demo does not crash."
  });
});

export default app;
