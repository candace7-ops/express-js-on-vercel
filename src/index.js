import express from "express";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import { URL } from "url";
import Stripe from "stripe";
import { kv } from "@vercel/kv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Change on deploy to verify the running build
const BUILD_ID = "KEY-ONLY-2026-08-12-0725";

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

// ---------- cookie helpers (no login) ----------

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
  return out;
}

function httpsRequestText(
  url,
  { method = "GET", headers = {}, body = null, maxRedirects = 3 } = {}
) {
