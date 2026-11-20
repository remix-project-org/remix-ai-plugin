// ---------------------------------------------------------------------------
// Static HTML pages in assets/ are templates. renderPage fills in {{BASE_URL}},
// {{BASE_HOST}} and {{MATOMO_SNIPPET}}, and keeps only the <!--simulate-only-->,
// <!--full-only--> and <!--analytics-only--> blocks that apply (blocks must not
// be nested). The server uses it per request; scripts/build-install-page.mjs
// uses it to write a static copy.
// ---------------------------------------------------------------------------

export interface PageContext {
  /** Public base URL of the server the page describes. */
  baseUrl: string;
  /** True for the full build (transactions enabled), false for simulate-only. */
  full: boolean;
  /** Matomo page-view snippet; omit when analytics is off. */
  tracking?: { snippet: string };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderPage(html: string, { baseUrl, full, tracking }: PageContext): string {
  const applies = { simulate: !full, full, analytics: Boolean(tracking) };
  return html
    .replace(/<!--(simulate|full|analytics)-only-->([\s\S]*?)<!--\/\1-only-->/g, (_block, key: keyof typeof applies, body: string) => (applies[key] ? body : ""))
    .replaceAll("{{BASE_URL}}", escapeHtml(baseUrl))
    .replaceAll("{{BASE_HOST}}", escapeHtml(new URL(baseUrl).host))
    .replaceAll("{{MATOMO_SNIPPET}}", tracking?.snippet ?? "");
}
