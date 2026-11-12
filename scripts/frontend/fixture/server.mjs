// The screenshot fixture server: serves the built workbench and answers its API from synthetic data.
// Reads only; a POST answers "rejected" so a stray click never pretends something was written.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { answer } from "./api.mjs";
import { token } from "./common.mjs";

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".json": "application/json" };

/** Starts the server on a free local port. `misses` lists API reads the fixture does not answer (they get an empty page). */
export async function startFixtureServer(dist) {
  const misses = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      // The login page checks the token it was given; every read after that carries it.
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
      if (req.method !== "GET") {
        let body = ""; for await (const chunk of req) body += chunk;
        let operationId = null; try { operationId = JSON.parse(body).operationId ?? null; } catch { /* not JSON */ }
        return send(200, { status: "rejected", operationId, code: "FIXTURE_READ_ONLY", message: "截图夹具不接受写入" });
      }
      const result = answer(decodeURIComponent(url.pathname), url.searchParams);
      if (result === undefined) { misses.add(url.pathname); return send(200, { items: [], nextCursor: null }); }
      return send(result.status, result.value);
    }
    try {
      const file = /^\/(?:$|p\/|ui(?:\/flow)?$)/.test(url.pathname) ? "index.html" : url.pathname;
      const body = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  return {
    base: `http://127.0.0.1:${server.address().port}`, misses,
    close: () => new Promise(done => server.close(() => done())),
  };
}
