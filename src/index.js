app.get("/api/brief", async (req, res) => {
  const ticker = String(req.query.ticker || "").trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: "Missing ticker. Use ?ticker=AAPL" });

  const now = new Date().toISOString();

  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(
      ticker + " stock"
    )}&hl=en-US&gl=US&ceid=US:en`;

    const xml = await fetchText(rssUrl);
    const headlines = extractRssItems(xml, 8);

    // reliable sentiment derived from headlines (no Reddit calls)
    const headlineText = (headlines || []).map(h => h.title).join(" • ");
    const headlineSentiment = simpleSentimentLabel(headlineText);

    let brief30s = await getGeminiBrief30s(ticker, headlines);
    if (!brief30s) {
      brief30s = `Headlines summary placeholder for ${ticker}. (Gemini unavailable.)`;
    }

    res.json({
      ticker,
      generatedAt: now,
      brief30s,
      sentiment: { source: "headlines", label: headlineSentiment },
      headlines
    });
  } catch (err) {
    res.status(200).json({
      ticker,
      generatedAt: now,
      brief30s: `Placeholder 30-second brief for ${ticker}. (News fetch failed.)`,
      sentiment: { source: "headlines", label: "Neutral" },
      headlines: [],
      note: `News fetch error: ${String(err)}`
    });
  }
});
