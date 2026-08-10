import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Serve static files from /public
app.use(express.static(path.join(__dirname, "..", "public")));

// Home page
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// Simple routes
app.get("/about", (_req, res) => {
  res.type("html").send("<h1>About</h1><p>Coming soon.</p>");
});

app.get("/api-data", (_req, res) => {
  res.json({ message: "ok", items: ["apple", "banana", "cherry"] });
});
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});
app.get("/api/brief", (req, res) => {
  const ticker = String(req.query.ticker || "").trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: "Missing ticker. Use ?ticker=AAPL" });

  const now = new Date().toISOString();

  res.json({
    ticker,
    generatedAt: now,
    brief30s: `Placeholder 30-second brief for ${ticker}.`,
    headlines: [
      {
        title: `${ticker}: Placeholder headline`,
        ts: now,
        source: "StockSpade Demo",
        url: "https://stockspade.com/"
      }
    ]
  });
});
export default app;
