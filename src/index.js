app.get("/api/brief", (req, res) => {
  const raw = String(req.query.ticker || "");
  const ticker = raw.trim().toUpperCase();

  if (!ticker) {
    return res.status(400).json({ error: "Missing ticker. Use /api/brief?ticker=AAPL" });
  }

  const nowIso = new Date().toISOString();

  res.json({
    ticker,
    generatedAt: nowIso,
    brief30s: `Placeholder 30-second brief for ${ticker}. (Next: Gemini)`,
    headlines: [
      {
        title: `${ticker}: Placeholder headline #1`,
        ts: nowIso,
        source: "StockSpade Demo",
        url: "https://stockspade.com/"
      }
    ]
  });
});
