// ---------------------------------------------------------------------------
// Import resolver for the Remix compiler.
//
// solc asks for every import it cannot find among the supplied sources. We map
// the import path to a URL and fetch it:
//   @scope/pkg[@version]/path.sol   → https://unpkg.com/@scope/pkg[@version]/path.sol
//   pkg[@version]/path.sol          → https://unpkg.com/pkg[@version]/path.sol
//   github.com/owner/repo/blob/ref/path.sol → raw.githubusercontent.com/owner/repo/ref/path.sol
//   http(s)://…                     → fetched as-is
// ---------------------------------------------------------------------------

const NPM_CDN = (process.env.NPM_CDN_URL ?? "https://unpkg.com").replace(/\/$/, "");
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

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

  const url = importUrl(path);
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
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
