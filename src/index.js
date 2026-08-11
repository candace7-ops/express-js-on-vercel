import express from "express";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import { URL } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";
function simpleSentimentLabel(text) {
  const t = (text || "").toLowerCase();

  const posWords = ["beat", "beats", "up", "surge", "soar", "bull", "bullish", "buy", "upgrade", "record", "profit"];
  const negWords = ["miss", "misses", "down", "drop", "plunge", "bear", "bearish", "sell", "downgrade", "lawsuit", "risk"];

  let score = 0;
  for (const w of posWords) if (t.includes(w)) score += 1;
  for (const w of negWords) if (t.includes(w)) score -= 1;

  if (score >= 1) return "Positive";
  if (score <= -1) return "Negative";
  return "Neutral";
}

async function fetchRedditPosts(ticker) {
  const q = encodeURIComponent(`$${ticker} OR ${ticker}`);
  const url = `https://www.reddit.com/search.json?q=${q}&sort=new&limit=8`;

  const resp = await fetch(url, {
    headers: { "User-Agent": "StockSpadeDemo/1.0 (hackathon demo)" }
  });

  if (!resp.ok) throw new Error(`Reddit HTTP ${resp.status}`);

  const json = await resp.json();
  const children = json?.data?.children || [];

  return children
    .map((c) => {
      const p = c?.data || {};
      return {
        title: p.title,
        subreddit: p.subreddit_name_prefixed || `r/${p.subreddit}`,
        url: p.permalink ? `https://www.reddit.com${p.permalink}` : p.url,
        ts: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
        score: p.score,
        comments: p.num_comments
      };
    })
    .filter((p) => p.title && p.url);
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Serve static files from /public
app.use(express.static(path.join(__dirname, "..", "public")));

// Home page
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/about", (_req, res) => {
  res.type("html").send("<h1>About</h1><p>Coming soon.</p>");
});

app.get("/api-data", (_req, res) => {
  res.json({ message: "ok", items: ["apple", "banana", "cherry"] });
});

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https
      .get(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: { "User-Agent": "StockSpadeDemo/1.0" }
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

    const ts = pubDate
      ? new Date(pubDate).toISOString()
      : new Date().toISOString();

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

async function getGeminiBrief30s(ticker, headlines) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const top = (headlines || [])
    .slice(0, 8)
    .map((h) => `- ${h.title}`)
    .join("\n");

  const prompt =
`Write a "30-second stock brief" for a demo app.

Ticker: ${ticker}

Use ONLY these headlines:
${top || "(none)"}

Return 3–5 short bullet points in plain English.
No financial advice. No price predictions. No price targets.
If there are no headlines, say: "No major headlines found."`;

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.();
  return text ? text.trim() : null;
}

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

    let brief30s = await getGeminiBrief30s(ticker, headlines);
    if (!brief30s) {
      brief30s = `Headlines summary placeholder for ${ticker}. (Gemini unavailable.)`;
    }

    res.json({
      ticker,
      generatedAt: now,
      brief30s,
      headlines
    });
  } catch (err) {
    res.status(200).json({
      ticker,
      generatedAt: now,
      brief30s: `Placeholder 30-second brief for ${ticker}. (News fetch failed.)`,
      headlines: [],
      note: `News fetch error: ${String(err)}`
    });
  }
});

export default app;
