import express from "express";
import path from "path";
import https from "https";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { URL } from "url";
import Stripe from "stripe";
import { kv } from "@vercel/kv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Stripe webhook needs raw body (do not use express.json() for this route)
const webhookRawBody = express.raw({ type: "application/json" });

// IMPORTANT: Do NOT use app.use(express.json()) globally, because it breaks Stripe webhook signature verification on Vercel.
// Apply JSON parsing only to routes that need it.
const jsonBody = express.json();

// Change on deploy to verify the running build
const BUILD_ID = "VERTEX-GEMINI-COMPLETE-2026-08-13";

// Stripe (server-side)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

// ---------- simple cookie + free limit (no login) ----------

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const s = part.trim();
    if (!s) return;
    const i = s.indexOf("=");
    if (i === -1) return;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function newId() {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  );
}

function todayKeyUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

function getOrSetBrowserId(req, res) {
  const cookies = parseCookies(req);
  let id = cookies.ss_id;
  if (!id) {
    id = newId();
    res.setHeader(
      "Set-Cookie",
      `ss_id=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`
    );
  }
  return id;
}

// ---------- helpers ----------

function redditSearchUrl(ticker) {
  const q = `$${ticker} OR ${ticker}`;
  return `https://www.reddit.com/search/?q=${encodeURIComponent(q)}&sort=new`;
}

function simpleSentimentLabel(text) {
  const t = (text || "").toLowerCase();

  const pos = [
    "beat",
    "beats",
    "up",
    "surge",
    "soar",
    "rally",
    "bull",
    "bullish",
    "buy",
    "upgrade",
    "record",
    "profit",
    "growth",
    "strong",
    "tops",
    "raises"
  ];
  const neg = [
    "miss",
    "misses",
    "down",
    "drop",
    "plunge",
    "bear",
    "bearish",
    "sell",
    "downgrade",
    "cut",
    "lawsuit",
    "probe",
    "risk",
    "weak",
    "falls",
    "warning"
  ];

  let score = 0;
  for (const w of pos) if (t.includes(w)) score += 1;
  for (const w of neg) if (t.includes(w)) score -= 1;

  if (score >= 2) return { label: "Bullish", score };
  if (score <= -2) return { label: "Bearish", score };
  return { label: "Neutral", score };
}

function redactSecrets(str) {
  const s = String(str || "");
  let out = s.replace(/([?&]key=)[^&\s)"]+/gi, "$1[REDACTED]");
  out = out.replace(/\bAIza[0-9A-Za-z\-_]{10,}\b/g, "[REDACTED]");
  out = out.replace(/\bsk-[0-9A-Za-z\-_]{10,}\b/g, "[REDACTED]");
  out = out.replace(/\bya29\.[0-9A-Za-z\-_]+\b/g, "[REDACTED]");
  return out;
}

function httpsRequestText(
  url,
  { method = "GET", headers = {}, body = null, maxRedirects = 3 } = {}
) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);

    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          "User-Agent": "StockSpadeDemo/1.0 (hackathon demo)",
          Accept: "*/*",
          ...headers
        }
      },
      (res) => {
        const status = res.statusCode || 0;

        if (
          [301, 302, 303, 307, 308].includes(status) &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          const nextUrl = new URL(res.headers.location, u).toString();
          res.resume();
          return resolve(
            httpsRequestText(nextUrl, {
              method: "GET",
              headers,
              body: null,
              maxRedirects: maxRedirects - 1
            })
          );
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const ok = status >= 200 && status < 300;
          if (!ok) {
            return reject(
              new Error(
                `HTTP ${status} from ${u.hostname}${u.pathname}: ${redactSecrets(
                  data.slice(0, 900)
                )}`
              )
            );
          }
          resolve(data);
        });
      }
    );

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchJson(url, opts = {}) {
  const txt = await httpsRequestText(url, opts);
  try {
    return JSON.parse(txt);
  } catch (e) {
    throw new Error(
      `Failed to parse JSON from ${redactSecrets(url)}: ${String(
        e
      )}; body=${redactSecrets(txt.slice(0, 300))}`
    );
  }
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
// ---------- Vertex auth + Gemini (Google Cloud) ----------

function readServiceAccountFromEnv() {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON");
  }
}

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signJwtRS256({ header, payload, privateKeyPem }) {
  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encHeader}.${encPayload}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  sign.end();
  const signature = sign.sign(privateKeyPem);

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function getGoogleAccessToken() {
  const sa = readServiceAccountFromEnv();
  if (!sa) return { ok: false, token: null, note: "GOOGLE_APPLICATION_CREDENTIALS_JSON not set" };

  if (!sa.client_email || !sa.private_key) {
    return { ok: false, token: null, note: "Service account JSON missing client_email/private_key" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const jwt = signJwtRS256({
    header: { alg: "RS256", typ: "JWT" },
    payload: {
      iss: sa.client_email,
      sub: sa.client_email,
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSec,
      exp: nowSec + 3600,
      scope: "https://www.googleapis.com/auth/cloud-platform"
    },
    privateKeyPem: sa.private_key
  });

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt
  }).toString();

  try {
    const txt = await httpsRequestText("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const j = JSON.parse(txt);
    if (!j.access_token) return { ok: false, token: null, note: "No access_token in token response" };
    return { ok: true, token: j.access_token, note: "Got access token" };
  } catch (e) {
    return { ok: false, token: null, note: redactSecrets(`Token error: ${String(e?.message || e)}`) };
  }
}

async function geminiBriefFromVertex({ ticker, headlines, sentimentLabel }) {
  const sa = readServiceAccountFromEnv();
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || sa?.project_id || null;
  const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

  if (!projectId) {
    return {
      ok: false,
      brief: null,
      note: "Missing project id (set GOOGLE_CLOUD_PROJECT or use credentials JSON with project_id)"
    };
  }

  const tok = await getGoogleAccessToken();
  if (!tok.ok) return { ok: false, brief: null, note: tok.note };

  const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
  const prompt = buildGeminiPrompt({ ticker, headlines, sentimentLabel });

  const url =
    `https://${location}-aiplatform.googleapis.com/v1/` +
    `projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/` +
    `publishers/google/models/${encodeURIComponent(model)}:generateContent`;

  try {
    const payload = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 300 }
    });

    const j = await fetchJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tok.token}`
      },
      body: payload
    });

    const brief =
      (j?.candidates?.[0]?.content?.parts || [])
        .map((p) => p?.text || "")
        .join("")
        .trim();

    if (!brief) return { ok: false, brief: null, note: "Vertex Gemini returned empty response" };
    return { ok: true, brief, note: `Vertex Gemini generated (${model})` };
  } catch (e) {
    return { ok: false, brief: null, note: redactSecrets(`Vertex Gemini error: ${String(e?.message || e)}`) };
  }
}

// ---------- AI Studio (API key) fallback ----------

async function geminiBriefFromApiKey({ ticker, headlines, sentimentLabel }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, brief: null, note: "GEMINI_API_KEY not set" };

  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const prompt = buildGeminiPrompt({ ticker, headlines, sentimentLabel });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
    key
  )}`;

  try {
    const payload = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 300 }
    });

    const j = await fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });

    const brief =
      (j?.candidates?.[0]?.content?.parts || [])
        .map((p) => p?.text || "")
        .join("")
        .trim();

    if (!brief) return { ok: false, brief: null, note: "Gemini returned empty response" };
    return { ok: true, brief, note: `AI Studio Gemini generated (${model})` };
  } catch (e) {
    return { ok: false, brief: null, note: redactSecrets(`AI Studio Gemini error: ${String(e?.message || e)}`) };
  }
}

// ---------- status endpoint (safe) ----------

app.get("/api/ai-status", async (_req, res) => {
  try {
    const sa = readServiceAccountFromEnv();
    const hasCreds = !!sa?.client_email && !!sa?.private_key;
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || sa?.project_id || null;

    const tok = hasCreds ? await getGoogleAccessToken() : { ok: false, token: null, note: "No creds" };

    res.json({
      buildId: BUILD_ID,
      vertex: {
        hasCreds,
        projectId,
        location: process.env.GOOGLE_CLOUD_LOCATION || null,
        model: process.env.GEMINI_MODEL || null,
        tokenOk: !!tok.ok,
        note: tok.note
      },
      aiStudio: {
        hasApiKey: !!process.env.GEMINI_API_KEY
      }
    });
  } catch (e) {
    res.status(500).json({ error: redactSecrets(String(e?.message || e)) });
  }
});
// ---------- Stripe (create Checkout session) ----------

app.post("/api/create-checkout-session", jsonBody, async (req, res) => {
  try {
    const browserId = getOrSetBrowserId(req, res);

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: "STRIPE_SECRET_KEY not set" });
    }
    if (!process.env.STRIPE_PRICE_ID) {
      return res.status(500).json({ error: "STRIPE_PRICE_ID not set" });
    }
    if (!process.env.APP_URL) {
      return res.status(500).json({ error: "APP_URL not set" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "
