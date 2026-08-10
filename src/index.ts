```ts
import express, { type Express } from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

// Serve static files from /public
app.use(express.static(path.join(__dirname, "..", "public")));

// Homepage -> serve public/index.html
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/about", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "components", "about.htm"));
});

// Example API endpoint - JSON
app.get("/api-data", (_req, res) => {
  res.json({
    message: "Here is some sample API data",
    items: ["apple", "banana", "cherry"],
  });
});

// Health check
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

export default app;
```
