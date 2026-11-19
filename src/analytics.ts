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

/** The tracking endpoint. Accepts the Matomo install URL or the matomo.php URL, with stray whitespace. */
function trackerUrl(raw: string | undefined): string | undefined {
  const url = raw?.trim().replace(/\/+$/, "");
  if (!url) return undefined;
  return url.endsWith(".php") ? url : `${url}/matomo.php`;
}

const MATOMO_URL = trackerUrl(process.env.MATOMO_URL);
const MATOMO_SITE_ID = process.env.MATOMO_SITE_ID?.trim();
const BASE_URL = () => process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

export const analyticsEnabled = Boolean(MATOMO_URL && MATOMO_SITE_ID);

/**
 * Matomo page-view snippet for the server's public web pages, plus the origin their
 * Content-Security-Policy must allow. Undefined when analytics is off.
 */
export function pageTracking(): { snippet: string; origin: string } | undefined {
  if (!MATOMO_URL || !MATOMO_SITE_ID) return undefined;
  // Embedded in an inline <script>, so keep "<" out of the JSON strings.
  const js = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c");
  const snippet = `<!-- Matomo -->
<script>
  var _paq = window._paq = window._paq || [];
  /* tracker methods like "setCustomDimension" should be called before "trackPageView" */
  _paq.push(['trackPageView']);
  _paq.push(['enableLinkTracking']);
  (function() {
    _paq.push(['setTrackerUrl', ${js(MATOMO_URL)}]);
    _paq.push(['setSiteId', ${js(MATOMO_SITE_ID)}]);
    var d=document, g=d.createElement('script'), s=d.getElementsByTagName('script')[0];
    g.async=true; g.src=${js(MATOMO_URL.replace(/\.php$/, ".js"))}; s.parentNode.insertBefore(g,s);
  })();
</script>
<!-- End Matomo Code -->`;
  return { snippet, origin: new URL(MATOMO_URL).origin };
}

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
