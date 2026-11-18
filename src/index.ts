import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, trackMcpSession } from "./mcp.js";
import { isActionPath, handleAction } from "./rest.js";
import { getReview } from "./actions.js";
import { openApiSpec, pluginManifest } from "./openapi.js";
import { trackEvent, analyticsEnabled } from "./analytics.js";
import { TRANSACT_ENABLED } from "./features.js";
import { retryAfterSeconds, rateLimitPerMinute } from "./ratelimit.js";
import { getTransaction, markSigning, markSent, markRejected, setWallets, type DetectedWallet, type UpdateResult } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIGN_DIST = path.resolve(__dirname, "..", "sign-dist");
const ASSETS_DIR = path.resolve(__dirname, "..", "assets");

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const WC_PROJECT_ID = process.env.WALLETCONNECT_PROJECT_ID;
const AUTH_TOKEN = process.env.PLUGIN_AUTH_TOKEN;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// sessionId → transport (stateful streamable HTTP)
const sessions = new Map<string, StreamableHTTPServerTransport>();

// Generous enough for multi-file compile requests; anything larger is refused.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

async function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Drain the rest without buffering so the 413 response can still be sent.
        req.removeAllListeners("data");
        req.resume();
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function cors(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Mcp-Session-Id");
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Returns true when the caller is over the request limit; writes a 429 in that case. */
function rateLimited(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const wait = retryAfterSeconds(req);
  if (wait === undefined) return false;
  res.setHeader("Retry-After", String(wait));
  json(res, 429, { error: "Too many requests", retryAfterSeconds: wait });
  trackEvent({ category: "rate_limit", action: "blocked" });
  return true;
}

/** Returns true when the request may proceed; writes a 401 and returns false otherwise. */
function authorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const ok =
    token.length === AUTH_TOKEN.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(AUTH_TOKEN));
  if (!ok) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="remix-solidity"');
    json(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // -------------------------------------------------------------------------
  // MCP Streamable HTTP transport  →  POST|GET|DELETE /mcp
  // Used by Claude connectors / the Claude Code plugin and ChatGPT connectors.
  // -------------------------------------------------------------------------

  if (url.pathname === "/mcp") {
    if (rateLimited(req, res)) return;
    if (!authorized(req, res)) return;

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // A session this process does not hold: already closed, or from before a restart.
    if (sessionId && !sessions.has(sessionId)) {
      trackEvent({ category: "session", action: "not_found", visitorKey: sessionId });
    }

    // DELETE — client tears down the session
    if (req.method === "DELETE") {
      if (sessionId) {
        const t = sessions.get(sessionId);
        if (t) { await t.close(); sessions.delete(sessionId); }
      }
      res.writeHead(200); res.end();
      return;
    }

    // GET — optional server-initiated SSE stream
    if (req.method === "GET") {
      if (!sessionId || !sessions.has(sessionId)) {
        json(res, 400, { error: "Mcp-Session-Id header required for GET" });
        return;
      }
      await sessions.get(sessionId)!.handleRequest(req, res);
      return;
    }

    // POST — all client→server JSON-RPC messages
    if (req.method === "POST") {
      let body: unknown;
      try { body = await parseBody(req); }
      catch (err: any) { json(res, err.status ?? 400, { error: err.message }); return; }

      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.handleRequest(req, res, body);
      } else if (!sessionId) {
        if ((body as any)?.method !== "initialize") {
          json(res, 400, { error: "Expected initialize request for new session" });
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        const mcp = createMcpServer();
        await mcp.connect(transport);
        trackMcpSession(mcp, transport);
        await transport.handleRequest(req, res, body);
        // sessionId is set after handleRequest processes the initialize message
        if (transport.sessionId) sessions.set(transport.sessionId, transport);
      } else {
        json(res, 404, { error: "Session not found" });
      }
      return;
    }

    json(res, 405, { error: "Method not allowed" });
    return;
  }

  // -------------------------------------------------------------------------
  // REST actions  →  POST /actions/*
  // Used by custom GPTs importing /openapi.json as an Action.
  // -------------------------------------------------------------------------

  if (isActionPath(url.pathname)) {
    if (req.method !== "POST") { json(res, 405, { error: "Method not allowed" }); return; }
    if (rateLimited(req, res)) return;
    if (!authorized(req, res)) return;
    let body: unknown;
    try { body = await parseBody(req); }
    catch { json(res, 400, { error: "Invalid JSON body" }); return; }
    const result = await handleAction(url.pathname, body, req.headers["user-agent"]);
    json(res, result.status, result.body);
    return;
  }

  // -------------------------------------------------------------------------
  // Plugin discovery documents
  // -------------------------------------------------------------------------

  if (url.pathname === "/.well-known/ai-plugin.json" && req.method === "GET") {
    json(res, 200, pluginManifest(BASE_URL, Boolean(AUTH_TOKEN)));
    return;
  }

  if ((url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") && req.method === "GET") {
    json(res, 200, openApiSpec(BASE_URL, Boolean(AUTH_TOKEN)));
    return;
  }

  if (url.pathname === "/logo.png" && req.method === "GET") {
    try {
      const png = fs.readFileSync(path.join(ASSETS_DIR, "logo.png"));
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      res.end(png);
    } catch {
      json(res, 404, { error: "Logo not found" });
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Runtime config for the React sign app
  // -------------------------------------------------------------------------

  if (TRANSACT_ENABLED && url.pathname === "/api/config" && req.method === "GET") {
    json(res, 200, { wcProjectId: WC_PROJECT_ID ?? null });
    return;
  }

  // -------------------------------------------------------------------------
  // Transaction signing page — serve the React app with injected config
  // -------------------------------------------------------------------------

  const signMatch = url.pathname.match(/^\/sign\/([a-f0-9-]{36})$/);
  if (TRANSACT_ENABLED && signMatch && req.method === "GET") {
    try {
      let html = fs.readFileSync(path.join(SIGN_DIST, "index.html"), "utf-8");
      const config = JSON.stringify({ wcProjectId: WC_PROJECT_ID ?? null });
      html = html.replace("<head>", `<head><script>window.__CONFIG__ = ${config};</script>`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Sign app not built. Run: npm run build:sign");
    }
    return;
  }

  // Static assets for the React app (JS, CSS, etc.)
  if (TRANSACT_ENABLED && url.pathname.startsWith("/assets/") && req.method === "GET") {
    const assetPath = path.join(SIGN_DIST, url.pathname);
    if (!assetPath.startsWith(SIGN_DIST)) { json(res, 403, { error: "Forbidden" }); return; }
    try {
      const content = fs.readFileSync(assetPath);
      const ext = path.extname(url.pathname);
      const mime: Record<string, string> = {
        ".js": "application/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".png": "image/png",
        ".woff2": "font/woff2",
      };
      res.writeHead(200, { "Content-Type": mime[ext] ?? "application/octet-stream" });
      res.end(content);
    } catch {
      json(res, 404, { error: "Asset not found" });
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Transaction API used by the signing page (never called by the model)
  // -------------------------------------------------------------------------

  const apiGetMatch = url.pathname.match(/^\/api\/tx\/([a-f0-9-]{36})$/);
  if (TRANSACT_ENABLED && apiGetMatch && req.method === "GET") {
    const tx = getTransaction(apiGetMatch[1]!);
    if (!tx) { json(res, 404, { error: "Not found" }); return; }
    json(res, 200, tx);
    return;
  }

  const apiReviewMatch = url.pathname.match(/^\/api\/tx\/([a-f0-9-]{36})\/review$/);
  if (TRANSACT_ENABLED && apiReviewMatch && req.method === "GET") {
    if (!getTransaction(apiReviewMatch[1]!)) { json(res, 404, { error: "Not found" }); return; }
    const review = await getReview(apiReviewMatch[1]!);
    if (!review) { json(res, 503, { error: "Review unavailable" }); return; }
    json(res, 200, review);
    return;
  }

  const apiCompleteMatch = url.pathname.match(/^\/api\/tx\/([a-f0-9-]{36})\/complete$/);
  if (TRANSACT_ENABLED && apiCompleteMatch && req.method === "POST") {
    const id = apiCompleteMatch[1]!;
    let body: any;
    try { body = await parseBody(req); }
    catch { json(res, 400, { error: "Invalid JSON body" }); return; }
    // "failed" is what signing pages built before the rejected status report.
    const status = body?.status === "failed" ? "rejected" : body?.status;
    const wallet = typeof body?.wallet === "string" ? body.wallet.slice(0, 32) : undefined;
    let result: UpdateResult;
    if (status === "signing") {
      result = markSigning(id, wallet);
    } else if (status === "sent" && typeof body.txHash === "string") {
      result = markSent(id, body.txHash, wallet);
    } else if (status === "rejected") {
      result = markRejected(id, typeof body.error === "string" ? body.error.slice(0, 2000) : "unknown", wallet);
    } else {
      json(res, 400, { error: "Invalid payload" });
      return;
    }
    if (!result.ok) {
      json(res, result.reason === "not_found" ? 404 : 409, { error: result.reason, status: result.status });
      return;
    }
    trackEvent({ category: "signing", action: status, name: wallet, value: getTransaction(id)!.chainId, visitorKey: id });
    json(res, 200, { ok: true });
    return;
  }

  const apiWalletsMatch = url.pathname.match(/^\/api\/tx\/([a-f0-9-]{36})\/wallets$/);
  if (TRANSACT_ENABLED && apiWalletsMatch && req.method === "POST") {
    let body: any;
    try { body = await parseBody(req); }
    catch { json(res, 400, { error: "Invalid JSON body" }); return; }
    if (!Array.isArray(body?.wallets)) { json(res, 400, { error: "wallets must be an array" }); return; }
    const detected: DetectedWallet[] = body.wallets
      .filter((w: any) => typeof w?.name === "string" && w.name.trim())
      .slice(0, 20)
      .map((w: any) => ({
        name: w.name.trim().slice(0, 64),
        ...(typeof w.rdns === "string" ? { rdns: w.rdns.slice(0, 128) } : {}),
      }));
    if (!setWallets(apiWalletsMatch[1]!, detected)) { json(res, 404, { error: "Not found" }); return; }
    trackEvent({
      category: "signing",
      action: "page_opened",
      name: detected.length ? "wallet_detected" : "no_wallet",
      value: detected.length,
      visitorKey: apiWalletsMatch[1],
    });
    json(res, 200, { ok: true });
    return;
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  if (url.pathname === "/" || url.pathname === "/health") {
    json(res, 200, {
      name: "remix-solidity AI plugin",
      clients: ["claude", "openai"],
      version: "1.0.0",
      auth: AUTH_TOKEN ? "bearer" : "none",
      analytics: analyticsEnabled ? "matomo" : "off",
      rateLimitPerMinute: rateLimitPerMinute ?? "off",
      mode: TRANSACT_ENABLED ? "transact" : "simulate-only",
      endpoints: {
        mcp:       "POST|GET|DELETE /mcp",
        manifest:  "GET  /.well-known/ai-plugin.json",
        openapi:   "GET  /openapi.json",
        actions:   TRANSACT_ENABLED
          ? "POST /actions/{compile,simulate,encode-call,read-contract,transact,check-transaction}"
          : "POST /actions/{compile,simulate,encode-call,read-contract}",
        ...(TRANSACT_ENABLED
          ? {
              signPage:  "GET  /sign/:id",
              txApi:     "GET  /api/tx/:id",
              review:    "GET  /api/tx/:id/review",
              complete:  "POST /api/tx/:id/complete",
              wallets:   "POST /api/tx/:id/wallets",
            }
          : {}),
      },
      tools: [
        "compile_solidity", "encode_call", "read_contract", "simulate",
        ...(TRANSACT_ENABLED ? ["transact", "check_transaction"] : []),
      ],
    });
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`remix-solidity AI plugin  →  ${BASE_URL}`);
  console.log(`  MCP connector : POST ${BASE_URL}/mcp  (Claude + ChatGPT)`);
  console.log(`  GPT Action    : GET  ${BASE_URL}/openapi.json`);
  console.log(`  Manifest      : GET  ${BASE_URL}/.well-known/ai-plugin.json`);
  console.log(TRANSACT_ENABLED ? `  Sign page     : GET  ${BASE_URL}/sign/:id` : "  Mode          : simulate-only (ENABLE_TRANSACT=false) — nothing can be signed or sent");
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") console.error(`Port ${PORT} already in use`);
  else console.error("Server error:", err);
  process.exit(1);
});
