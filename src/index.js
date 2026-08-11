import express from "express";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import { URL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// serve static files from /public
app.use(express.static(path.join(__dirname, "..", "public")));

// health check
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// --- helpers ---

function redditSearchUrl(ticker) {
  const q = `$${ticker} OR ${ticker}`;
  return `https://www.reddit.com/search/?q=${encodeURIComponent(q)}&sort=new`;
}

function simpleSentimentLabel(text) {
  const t = (text || "").toLowerCase();

  const pos = [
    "beat","beats","up","surge","soar","rally","bull","bullish","buy",
    "upgrade","record","profit","growth","strong","tops","raises"
  ];
  const neg = [
    "miss","misses","down","drop","plunge","bear","bearish","sell",
    "downgrade","cut","lawsuit","probe","risk","weak","falls","warning"
  ];

  let score = 0;
  for (const w of pos) if (t.includes(w)) score += 1;
  for (const w of neg) if (t.includes(w)) score -= 1;

  if (score >= 2) return { label: "Bullish", score };
  if (score <= -2) return { label: "Bearish", score };
  return { label: "Neutral", score };
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https
      .get(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: { "User-Agent": "StockSpadeDemo/1.0 (hackathon demo)" }
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        }
      )
      .on("error", reject);
  });
}

function extractRssItems(xml, limit = 8) {
  const items = [];
  const blocks = xml.split("<item>").slice(1);

  for (const b of blocks) {
    const title =
      (b.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
        b.match(/<title>([\s\S]*?)<\/title>/) ||
        [])[1] || "";
    const link = (b.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
    const pubDate = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
    if (!title || !link) continue;

    let ts = new Date().toISOString();
    try {
      if (pubDate) ts = new Date(pubDate).toISOString();
    } catch {}

    items.push({
      title: title.trim(),
      url: link.trim(),
      ts,
      source: "Google News RSS"
    });

    if (items.length >= limit) break;
  }

  return items;
}

// --- main API ---

app.get("/api/brief", async (req, res) => {
  const ticker = String(req.query.ticker || "").trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: "Missing ticker. Use ?ticker=AAPL" });

  const now = new Date().toISOString();

  try {
    // headlines from Google News RSS (no API key)
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(
      `${ticker} stock`
    )}&hl=en-US&gl=US&ceid=US:en`;

    const xml = await fetchText(rssUrl);
    const headlines = extractRssItems(xml, 8);

    // sentiment derived from headlines (reliable)
    const headlineText = (headlines || []).map((h) => h.title).join(" • ");
    const sentiment = simpleSentimentLabel(headlineText);

    // "brief" built from headlines + sentiment (no Gemini, no crashes)
    const topTitles = (headlines || []).slice(0, 4).map((h) => h.title);
    const brief30s =
      `30-second brief for ${ticker}:\n` +
      `- Tone: ${sentiment.label} (headline-based)\n` +
      (topTitles.length
        ? topTitles.map((t) => `- ${t}`).join("\n")
        : `- No major headlines found.`);

    res.json({
      ticker,
      generatedAt: now,
      brief30s,
      sentiment,                 // { label, score }
      reddit: {
        status: "link-only",
        searchUrl: redditSearchUrl(ticker),
        note: "Reddit often blocks server-to-server requests (403). This demo provides a reliable Reddit search link."
      },
      headlines
    });
  } catch (err) {
    res.status(200).json({
      ticker,
      generatedAt: now,
      brief30s: `Placeholder 30-second brief for ${ticker}. (News fetch failed.)`,
      sentiment: { label: "Neutral", score: 0 },
      reddit: {
        status: "link-only",
        searchUrl: redditSearchUrl(ticker),
        note: "Reddit provided as a link to avoid flaky server fetches."
      },
      headlines: [],
      note: `News fetch error: ${String(err)}`
    });
  }
});

export default app;
