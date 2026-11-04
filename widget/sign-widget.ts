// ---------------------------------------------------------------------------
// In-chat transaction card (MCP Apps). Rendered by Claude / ChatGPT next to a
// `transact` result. Shows what is about to be signed, opens the signing page
// and tracks the transaction live by calling check_transaction itself.
//
// Signing still happens on the hosted signing page: wallet extensions are not
// injected into the sandboxed iframe hosts render this view in.
// ---------------------------------------------------------------------------

import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

interface Decoded {
  kind: "call" | "deploy";
  signature: string;
  args?: Array<{ name: string; type: string; value: unknown }>;
}

interface TransactResult {
  transactionId: string;
  signUrl: string;
  chainId?: number;
  to?: string;
  value?: string;
  description?: string;
  decoded?: Decoded;
}

interface CheckResult {
  status: "pending" | "signing" | "sent" | "failed" | "not_found";
  signingPageOpened?: boolean;
  walletsDetected?: string[] | null;
  txHash?: string;
  explorerUrl?: string;
  contractAddress?: string;
  contractExplorerUrl?: string;
  error?: string;
  errorMessage?: string;
  receipt?: { status?: number };
}

const CHAINS: Record<number, string> = {
  1: "Ethereum", 11155111: "Sepolia", 137: "Polygon", 8453: "Base",
  84532: "Base Sepolia", 42161: "Arbitrum One", 10: "Optimism",
};

const app = new App({ name: "remix-sign-transaction", version: "1.0.0" });
const root = document.getElementById("root")!;

let tx: TransactResult | undefined;
let check: CheckResult | undefined;
let polling = false;

// --- helpers -----------------------------------------------------------------

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function short(hex: string): string {
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}

function formatEth(value?: string): string {
  if (!value || /^0x0*$/.test(value) || value === "0") return "0 ETH";
  try {
    const wei = BigInt(value);
    const whole = wei / 10n ** 18n;
    const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "").slice(0, 8);
    return `${whole}${frac ? "." + frac : ""} ETH`;
  } catch {
    return `${value} wei`;
  }
}

function formatArg(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseResult(result: { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }): any {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((c) => c.type === "text")?.text;
  try { return text ? JSON.parse(text) : undefined; } catch { return undefined; }
}

async function open(url: string) {
  try { await app.openLink({ url }); }
  catch { window.open(url, "_blank", "noopener"); }
}

// --- rendering ---------------------------------------------------------------

function statusView(): { tone: string; label: string; detail: string } {
  if (!check) return { tone: "idle", label: "Waiting for signature", detail: "Open the signing page to review and sign with your wallet." };
  switch (check.status) {
    case "not_found":
      return { tone: "error", label: "Expired", detail: "This transaction expired (1 hour). Ask for a new one." };
    case "failed":
      return { tone: "error", label: "Failed", detail: esc(check.errorMessage ?? check.error ?? "The transaction was rejected or failed.") };
    case "signing":
      return { tone: "busy", label: "Confirm in your wallet", detail: "Waiting for you to approve in the wallet dialog." };
    case "sent":
      if (check.receipt?.status === 0) return { tone: "error", label: "Reverted", detail: "The transaction was mined but reverted." };
      return check.receipt
        ? { tone: "ok", label: tx?.to ? "Confirmed" : "Contract deployed", detail: "Mined successfully." }
        : { tone: "busy", label: "Broadcast", detail: "Waiting for the transaction to be mined…" };
    default:
      if (!check.signingPageOpened) return { tone: "idle", label: "Waiting for signature", detail: "Open the signing page to review and sign with your wallet." };
      if (check.walletsDetected && check.walletsDetected.length === 0) {
        return { tone: "warn", label: "No browser wallet found", detail: "Install MetaMask, or use WalletConnect on the signing page." };
      }
      return { tone: "idle", label: "Signing page open", detail: check.walletsDetected?.length ? `Detected: ${esc(check.walletsDetected.join(", "))}` : "" };
  }
}

function render() {
  if (!tx) {
    root.innerHTML = `<div class="card"><p class="muted">Preparing transaction…</p></div>`;
    return;
  }
  const s = statusView();
  const chain = tx.chainId ? (CHAINS[tx.chainId] ?? `Chain ${tx.chainId}`) : "Wallet default";
  const done = check?.status === "sent" || check?.status === "failed" || check?.status === "not_found";
  const decoded = tx.decoded;

  root.innerHTML = `
    <div class="card">
      <div class="head">
        <div>
          <div class="title">${esc(tx.description ?? (tx.to ? "Contract call" : "Contract deployment"))}</div>
          <div class="muted">${esc(chain)}${tx.chainId === 1 ? ' <span class="badge warn">mainnet — real funds</span>' : ""}</div>
        </div>
        <span class="pill ${s.tone}">${esc(s.label)}</span>
      </div>

      <dl>
        <dt>${tx.to ? "To" : "Type"}</dt><dd class="mono">${tx.to ? esc(short(tx.to)) : "Deploy new contract"}</dd>
        <dt>Value</dt><dd>${esc(formatEth(tx.value))}</dd>
        ${decoded ? `<dt>${decoded.kind === "deploy" ? "Constructor" : "Function"}</dt><dd class="mono">${esc(decoded.signature)}</dd>` : ""}
        ${(decoded?.args ?? []).map((a) => `<dt class="arg">${esc(a.name || a.type)}</dt><dd class="mono">${esc(formatArg(a.value))}</dd>`).join("")}
      </dl>

      ${s.detail ? `<p class="detail ${s.tone}">${s.detail}</p>` : ""}

      <div class="actions">
        ${!done ? `<button class="primary" data-open="${esc(tx.signUrl)}">Open signing page</button>` : ""}
        ${check?.explorerUrl ? `<button data-open="${esc(check.explorerUrl)}">View transaction</button>` : ""}
        ${check?.contractExplorerUrl ? `<button data-open="${esc(check.contractExplorerUrl)}">View contract ${esc(short(check.contractAddress ?? ""))}</button>` : ""}
      </div>
    </div>`;

  root.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((b) =>
    b.addEventListener("click", () => open(b.dataset.open!)),
  );
}

// --- live tracking ----------------------------------------------------------

function isFinal(c: CheckResult): boolean {
  return c.status === "failed" || c.status === "not_found" || (c.status === "sent" && Boolean(c.receipt));
}

async function track() {
  if (polling || !tx) return;
  polling = true;
  let errors = 0;
  while (tx && errors < 5) {
    try {
      const result = await app.callServerTool({
        name: "check_transaction",
        arguments: { transactionId: tx.transactionId, waitSeconds: 20 },
      });
      check = parseResult(result) as CheckResult;
      errors = 0;
      render();
      if (check && isFinal(check)) {
        await app.updateModelContext({
          content: [{
            type: "text",
            text: `Transaction ${tx.transactionId} is ${check.status}` +
              (check.txHash ? ` (hash ${check.txHash})` : "") +
              (check.contractAddress ? `, deployed at ${check.contractAddress}` : "") + ".",
          }],
        }).catch(() => { /* optional host capability */ });
        break;
      }
    } catch {
      errors++;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  polling = false;
}

// --- host wiring -------------------------------------------------------------

app.ontoolresult = (result) => {
  const data = parseResult(result as any);
  if (data?.transactionId && data?.signUrl) {
    tx = data as TransactResult;
    render();
    void track();
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

render();
await app.connect();
const ctx = app.getHostContext();
if (ctx?.theme) applyDocumentTheme(ctx.theme);
if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
