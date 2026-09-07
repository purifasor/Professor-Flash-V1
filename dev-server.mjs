// Local dev server — mirrors Vercel behavior (static public/ + /api functions).
// Run:  node dev-server.mjs   →   http://localhost:8585
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = process.env.PORT || 8585;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function shimRes(res) {
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (obj) => {
    res.writeHead(res.statusCode || 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  shimRes(res);
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith("/api/")) {
    const name = pathname.slice(5).replace(/\/$/, "") || "index";
    const file = path.join(ROOT, "api", name + ".js");
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    try {
      const mod = await import(pathToFileURL(file).href + "?t=" + Date.now());
      req.query = Object.fromEntries(url.searchParams);
      req.body = null;
      await mod.default(req, res);
    } catch (e) {
      console.error("[api]", e);
      if (!res.headersSent) res.status(500).json({ error: e.message });
      else res.end();
    }
    return;
  }

  // static
  let fp = path.join(PUBLIC, pathname === "/" ? "index.html" : pathname);
  if (!fp.startsWith(PUBLIC)) {
    res.status(403).end();
    return;
  }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    fp = path.join(PUBLIC, "index.html");
  }
  const ext = path.extname(fp).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(fp).pipe(res);
});

server.listen(PORT, () =>
  console.log(`⚡ Professor Flash dev → http://localhost:${PORT}`)
);
