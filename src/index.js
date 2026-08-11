import express from "express";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import { URL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Serve static files from /public (reliable path)
const PUBLIC_DIR = path.join(__dirname, "..", "public");
app.use(express.static(PUBLIC_DIR));

// Always serve homepage
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Health check
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

async function fetchJson(url, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          "User-Agent": "StockSpadeDemo/1.0 (hackathon demo)",
          ...headers
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          if (!ok) {
            return reject(
              new Error(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 500)}`)
            );
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(
              new Error(
                `Failed to parse JSON from ${url}: ${String(e)}; body=${data.slice(0, 300)}`
              )
            );
          }
        });
      }
    );

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
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

// Gemini via Cloud Run proxy (never-crash)
async function geminiBriefFromProxy({ ticker, headlines, sentimentLabel }) {
  const proxyUrl = process.env.GEMINI_PROXY_URL;
  if (!proxyUrl) return { ok: false, brief: null, note: "GEMINI_PROXY_URL not set" };

  try {
    const top = (headlines || []).slice(0, 8).map((h) => ({
      title: h.title,
      source: h.source,
      ts: h.ts,
      url: h.url
    }));

    const prompt = `You are StockSpade, an investor news assistant.
Write a 30-second brief for ticker ${ticker} using ONLY the headlines provided.
Rules:
- 6-10 short bullet lines max
- mention overall tone: ${sentimentLabel}
- do NOT invent facts, numbers, prices, or earnings
- do NOT mention "as an AI"
- end with one line: "Not financial advice."

HEADLINES (JSON):
${JSON.stringify(top, null, 2)}
`;

    const payload = JSON.stringify({ prompt });

    const j = await fetchJson(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });

    const brief = (j?.text || j?.brief || "").trim();
    if (!brief) return { ok: false, brief: null, note: "Proxy returned empty text" };

    return { ok: true, brief, note: "Gemini generated via Cloud Run proxy" };
  } catch (e) {
    return { ok: false, brief: null, note: `Proxy/Gemini error: ${String(e)}` };
  }
}

// --- main API ---

app.get("/api/brief", async (req, res) => {
  const ticker = String(req.query.ticker || "").trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: "Missing ticker. Use ?ticker=AAPL" });

  const now = new Date().toISOString();

  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(
      `${ticker} stock`
    )}&hl=en-US&gl=US&ceid=US:en`;

    const xml = await fetchText(rssUrl);
    const headlines = extractRssItems(xml, 8);

    const headlineText = headlines.map((h) => h.title).join(" • ");
    const sentiment = simpleSentimentLabel(headlineText);

    // fallback brief (always works)
    const topTitles = headlines.slice(0, 4).map((h) => h.title);
    const fallbackBrief30s =
      `30-second brief for ${ticker}:\n` +
      `- Tone: ${sentiment.label} (headline-based)\n` +
      (topTitles.length
        ? topTitles.map((t) => `- ${t}`).join("\n")
        : `- No major headlines found.`);

    // Gemini attempt via proxy (never crashes)
    const gem = await geminiBriefFromProxy({
      ticker,
      headlines,
      sentimentLabel: sentiment.label
    });

    const brief30s = gem.ok ? gem.brief : fallbackBrief30s;

    res.json({
      ticker,
      generatedAt: now,
      brief30s,
      sentiment,
      ai: {
        provider: "gemini",
        used: gem.ok,
        note: gem.note
      },
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
      ai: { provider: "gemini", used: false, note: "News fetch failed before Gemini step" },
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
