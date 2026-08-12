import express from "express";
import path from "path";
import https from "https";
import fs from "fs";
import { fileURLToPath } from "url";
import { URL } from "url";
import { VertexAI } from "@google-cloud/vertexai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// IMPORTANT: change this any time you deploy, so you can prove you're hitting the right build
const BUILD_ID = "KEY-ONLY-2026-08-12-0725";

// Vertex AI config (override with env vars if you want)
const VERTEX_PROJECT = process.env.GCP_PROJECT_ID || "stockspade-gemini";
const VERTEX_LOCATION = process.env.GCP_LOCATION || "us-central1";
const VERTEX_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

// Serve static files from /public (reliable path)
const PUBLIC_DIR = path.join(__dirname, "..", "public");
app.use(express.static(PUBLIC_DIR));

// Always serve homepage
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Health check
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", buildId: BUILD_ID, timestamp: new Date().toISOString() });
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
              new Error(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 800)}`)
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

function buildGeminiPrompt({ ticker, headlines, sentimentLabel }) {
  const top = (headlines || []).slice(0, 8).map((h) => ({
    title: h.title,
    source: h.source,
    ts: h.ts,
    url: h.url
  }));

  return `You are StockSpade, an investor news assistant.
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
}

/**
 * Vertex AI auth for Vercel:
 * Put the entire service account JSON into env var GOOGLE_APPLICATION_CREDENTIALS_JSON.
 * This writes it to /tmp and sets GOOGLE_APPLICATION_CREDENTIALS for the Google SDK.
 */
function ensureVertexCredentials() {
  const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!json) return { ok: true, note: "No GOOGLE_APPLICATION_CREDENTIALS_JSON set (using default Google auth)" };

  const p = "/tmp/gcp-sa.json";
  try {
    if (!fs.existsSync(p)) fs.writeFileSync(p, json, "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = p;
    return { ok: true, note: "Loaded Google credentials from GOOGLE_APPLICATION_CREDENTIALS_JSON" };
  } catch (e) {
    return { ok: false, note: `Failed to write credentials to /tmp: ${String(e)}` };
  }
}

// Gemini via Vertex AI (never-crash)
async function geminiBriefFromVertex({ ticker, headlines, sentimentLabel }) {
  const auth = ensureVertexCredentials();
  if (!auth.ok) return { ok: false, brief: null, note: auth.note };

  const prompt = buildGeminiPrompt({ ticker, headlines, sentimentLabel });

  try {
    const vertex_ai = new VertexAI({ project: VERTEX_PROJECT, location: VERTEX_LOCATION });
    const model = vertex_ai.getGenerativeModel({ model: VERTEX_MODEL });

    const resp = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 300 }
    });

    const brief =
      (resp?.response?.candidates?.[0]?.content?.parts || [])
        .map((p) => p?.text || "")
        .join("")
        .trim();

    if (!brief) return { ok: false, brief: null, note: `Vertex AI returned empty text (${VERTEX_MODEL})` };

    return {
      ok: true,
      brief,
      note: `Gemini generated via Vertex AI (${VERTEX_MODEL}, ${VERTEX_PROJECT}/${VERTEX_LOCATION})`
    };
  } catch (e) {
    return { ok: false, brief: null, note: `Vertex AI error (${VERTEX_MODEL}): ${String(e)}` };
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

    // Vertex AI: call Gemini via service account
    const gem = await geminiBriefFromVertex({
      ticker,
      headlines,
      sentimentLabel: sentiment.label
    });

    const brief30s = gem.ok ? gem.brief : fallbackBrief30s;

    res.json({
      buildId: BUILD_ID,
      ticker,
      generatedAt: now,
      brief30s,
      sentiment,
      ai: {
        provider: "vertexai",
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
      buildId: BUILD_ID,
      ticker,
      generatedAt: now,
      brief30s: `Placeholder 30-second brief for ${ticker}. (News fetch failed.)`,
      sentiment: { label: "Neutral", score: 0 },
      ai: { provider: "vertexai", used: false, note: "News fetch failed before Gemini step" },
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
