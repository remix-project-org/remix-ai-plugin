// ---------------------------------------------------------------------------
// MCP Apps view for `transact`: a self-contained HTML document (CSS + bundled
// JS inlined, no network access needed) served as a ui:// resource.
// Build the script with `npm run build:widget`.
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export const SIGN_WIDGET_URI = "ui://remix/sign-transaction.html";
export const SIGN_WIDGET_MIME = RESOURCE_MIME_TYPE;

/** Tool `_meta` that attaches the widget — MCP Apps key plus the ChatGPT Apps SDK aliases. */
export const SIGN_WIDGET_TOOL_META = {
  ui: { resourceUri: SIGN_WIDGET_URI },
  "ui/resourceUri": SIGN_WIDGET_URI,
  "openai/outputTemplate": SIGN_WIDGET_URI,
  "openai/widgetAccessible": true,
} as const;

let cached: string | undefined;

export function signWidgetHtml(): string {
  if (cached) return cached;
  const js = fs.readFileSync(path.join(ROOT, "widget-dist", "sign-widget.js"), "utf-8");
  const css = fs.readFileSync(path.join(ROOT, "widget", "sign-widget.css"), "utf-8");
  // Guard against a literal </script> inside the bundle closing the tag early.
  const safeJs = js.replace(/<\/script/gi, "<\\/script");
  cached = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transaction</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script type="module">${safeJs}</script>
</body>
</html>`;
  return cached;
}
