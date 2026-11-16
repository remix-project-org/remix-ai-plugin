// ---------------------------------------------------------------------------
// Matomo usage analytics (server-side, via the HTTP Tracking API).
//
// Disabled unless MATOMO_URL and MATOMO_SITE_ID are set. Only coarse usage
// events are sent — tool, prompt, resource and MCP method names, client names,
// outcomes and chain IDs. Never addresses, transaction hashes, calldata, ABIs
// or source code. Visitors are
// identified by a hash of the MCP session / transaction id, never by user data.
// ---------------------------------------------------------------------------

import crypto from "crypto";

const MATOMO_URL = process.env.MATOMO_URL;
const MATOMO_SITE_ID = process.env.MATOMO_SITE_ID;
const BASE_URL = () => process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

export const analyticsEnabled = Boolean(MATOMO_URL && MATOMO_SITE_ID);

export interface TrackEvent {
  category: string;
  action: string;
  name?: string;
  value?: number;
  /** Groups events into one Matomo visit, e.g. an MCP session or transaction id. */
  visitorKey?: string;
}

function visitorId(key: string | undefined): string {
  return crypto.createHash("sha256").update(key ?? crypto.randomUUID()).digest("hex").slice(0, 16);
}

/** Fire-and-forget: never throws and never delays the caller. */
export function trackEvent({ category, action, name, value, visitorKey }: TrackEvent): void {
  if (!analyticsEnabled) return;

  const params = new URLSearchParams({
    idsite: MATOMO_SITE_ID!,
    rec: "1",
    apiv: "1",
    send_image: "0",
    rand: crypto.randomBytes(4).toString("hex"),
    _id: visitorId(visitorKey),
    url: `${BASE_URL()}/${category}/${action}`,
    e_c: category,
    e_a: action,
    ...(name ? { e_n: name } : {}),
    ...(value !== undefined ? { e_v: String(value) } : {}),
  });

  fetch(MATOMO_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "remix-ai-plugin" },
    body: params,
    signal: AbortSignal.timeout(3000),
  }).catch(() => { /* analytics must never affect the plugin */ });
}
