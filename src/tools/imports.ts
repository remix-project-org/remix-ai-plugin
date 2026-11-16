// ---------------------------------------------------------------------------
// Import resolver for the Remix compiler.
//
// solc asks for every import it cannot find among the supplied sources. We map
// the import path to a URL and fetch it:
//   @scope/pkg[@version]/path.sol   → https://unpkg.com/@scope/pkg[@version]/path.sol
//   pkg[@version]/path.sol          → https://unpkg.com/pkg[@version]/path.sol
//   github.com/owner/repo/blob/ref/path.sol → raw.githubusercontent.com/owner/repo/ref/path.sol
//   http(s)://…                     → fetched as-is, only from ALLOWED_HOSTS
// ---------------------------------------------------------------------------

const NPM_CDN = (process.env.NPM_CDN_URL ?? "https://unpkg.com").replace(/\/$/, "");
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// Only public source hosts may be fetched — never the server's own network (localhost, cloud metadata, …).
const ALLOWED_HOSTS = new Set([
  new URL(NPM_CDN).host,
  "unpkg.com",
  "cdn.jsdelivr.net",
  "raw.githubusercontent.com",
]);

function checkAllowed(url: URL, path: string): void {
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.host)) {
    throw new Error(`Import "${path}" is not allowed: only ${[...ALLOWED_HOSTS].join(", ")} and github.com files can be imported over https.`);
  }
}

const cache = new Map<string, string>();

export function importUrl(path: string): string {
  if (/^https?:\/\//.test(path)) {
    const gh = path.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    return gh ? `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}` : path;
  }
  const gh = path.match(/^github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`;

  // npm package path; reject anything that could escape the CDN path
  if (path.includes("..") || path.startsWith("/")) throw new Error(`Unsupported import path: ${path}`);
  return `${NPM_CDN}/${path}`;
}

export async function resolveImport(path: string): Promise<string> {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;

  // Follow redirects by hand so every hop is checked (unpkg redirects unversioned paths).
  let url = importUrl(path);
  let res: Response;
  for (let hops = 0; ; hops++) {
    checkAllowed(new URL(url), path);
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) break;
    if (hops >= MAX_REDIRECTS) throw new Error(`Could not resolve import "${path}": too many redirects`);
    url = new URL(location, url).toString();
  }
  if (!res.ok) throw new Error(`Could not resolve import "${path}" (${url} → HTTP ${res.status})`);
  const content = await res.text();
  if (content.length > MAX_FILE_BYTES) throw new Error(`Import "${path}" is too large`);

  cache.set(path, content);
  return content;
}

/** Callback in the shape the Remix Compiler constructor expects. */
export function remixImportCallback(path: string, cb: (err: string | null, content?: string) => void): void {
  resolveImport(path).then(
    (content) => cb(null, content),
    (err: Error) => cb(err.message),
  );
}
