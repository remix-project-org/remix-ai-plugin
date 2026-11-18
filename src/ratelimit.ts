// ---------------------------------------------------------------------------
// Per-client request limit for the public endpoints (/mcp and /actions/*).
//
// Off unless RATE_LIMIT_PER_MINUTE is a positive number. Counters live in memory
// only, keyed by IP address, and are dropped when their one-minute window ends.
// Behind a reverse proxy, set TRUST_PROXY=true so the client address is read from
// X-Forwarded-For — only do that when the proxy overwrites that header, otherwise
// callers can pick their own address.
// ---------------------------------------------------------------------------

import type http from "http";

const LIMIT = parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? "", 10) || 0;
const TRUST_PROXY = process.env.TRUST_PROXY?.trim().toLowerCase() === "true";
const WINDOW_MS = 60_000;
// Bounds memory when many distinct addresses show up; the oldest window is dropped first.
const MAX_TRACKED = 10_000;

export const rateLimitPerMinute = LIMIT > 0 ? LIMIT : undefined;

const windows = new Map<string, { start: number; count: number }>();

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, w] of windows) {
    if (w.start < cutoff) windows.delete(ip);
  }
}, WINDOW_MS).unref();

function clientIp(req: http.IncomingMessage): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Counts the request. Returns the seconds to wait when the caller is over the limit, otherwise undefined. */
export function retryAfterSeconds(req: http.IncomingMessage): number | undefined {
  if (!rateLimitPerMinute) return undefined;
  const now = Date.now();
  const ip = clientIp(req);

  let w = windows.get(ip);
  if (!w || now - w.start >= WINDOW_MS) {
    w = { start: now, count: 0 };
    windows.delete(ip);
    windows.set(ip, w);
    if (windows.size > MAX_TRACKED) windows.delete(windows.keys().next().value!);
  }
  w.count++;
  return w.count > rateLimitPerMinute ? Math.ceil((w.start + WINDOW_MS - now) / 1000) : undefined;
}
