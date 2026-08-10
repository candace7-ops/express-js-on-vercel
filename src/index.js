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

export default app;
