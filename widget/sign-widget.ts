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

interface ReviewSummary {
  intent: string;
  source: "erc7730" | "verified" | "assistant" | "none";
  contractName?: string;
  warnings: Array<{ level: "danger" | "caution"; text: string }>;
}

interface TransactResult {
  transactionId: string;
  signUrl: string;
  chainId?: number;
  to?: string;
  value?: string;
  description?: string;
  decoded?: Decoded;
  review?: ReviewSummary;
}

interface CheckResult {
  status: "pending" | "signing" | "sent" | "confirmed" | "reverted" | "rejected" | "not_found";
  signingPageOpened?: boolean;
  walletsDetected?: string[] | null;
  txHash?: string;
  explorerUrl?: string;
  contractAddress?: string;
  contractExplorerUrl?: string;
  error?: string;
  errorMessage?: string;
  receipt?: { status?: number | null };
  review?: ReviewSummary;
}

const TRUST: Record<ReviewSummary["source"], { label: string; tone: string }> = {
  erc7730: { label: "Clear-signing descriptor", tone: "ok" },
  verified: { label: "Verified contract", tone: "ok" },
  assistant: { label: "Unverified — decoded from the assistant's ABI", tone: "warn" },
  none: { label: "Not decoded", tone: "muted" },
};

const CHAINS: Record<number, string> = {
  1: "Ethereum", 11155111: "Sepolia", 137: "Polygon", 8453: "Base",
  84532: "Base Sepolia", 42161: "Arbitrum One", 10: "Optimism",
};

const app = new App({ name: "remix-sign-transaction", version: "1.0.0" });
const root = document.getElementById("root")!;

let tx: TransactResult | undefined;
let check: CheckResult | undefined;
let polling = false;

// Poll cadence: fast while something can happen soon, slower after a rejected
// attempt (the user may retry on the signing page), backing off on errors.
const POLL_MS = 4000;
const POLL_AFTER_REJECT_MS = 10000;
const POLL_MAX_BACKOFF_MS = 30000;

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

/** Receipt first, then status; errorMessage only for a rejected attempt with no receipt. */
function statusView(): { tone: string; label: string; detail: string } {
  if (!check) return { tone: "idle", label: "Waiting for signature", detail: "Open the signing page to review and sign with your wallet." };
  if (check.status === "not_found") {
    return { tone: "error", label: "Expired", detail: "This transaction expired (1 hour). Ask for a new one." };
  }
  if (check.receipt) {
    if (check.receipt.status === 0) return { tone: "error", label: "Reverted", detail: "The transaction was mined but reverted." };
    return { tone: "ok", label: tx?.to ? "Confirmed" : "Contract deployed", detail: "Mined successfully." };
  }
  switch (check.status) {
    case "rejected":
      return {
        tone: "error",
        label: "Failed",
        detail: `${esc(check.errorMessage ?? check.error ?? "The signing attempt was rejected or failed.")} You can retry on the signing page.`,
      };
    case "signing":
      return { tone: "busy", label: "Confirm in your wallet", detail: "Waiting for you to approve in the wallet dialog." };
    case "sent":
    case "confirmed":
    case "reverted":
      return { tone: "busy", label: "Broadcast", detail: "Waiting for the transaction to be mined…" };
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
  const canSign = !check || ["pending", "signing", "rejected"].includes(check.status);
  const decoded = tx.decoded;
  // The review can finish building after transact returned; check_transaction then carries it.
  const review = check?.review ?? tx.review;
  const trust = review ? TRUST[review.source] : undefined;

  root.innerHTML = `
    <div class="card">
      <div class="head">
        <div>
          <div class="title">${esc(review?.intent ?? tx.description ?? (tx.to ? "Contract call" : "Contract deployment"))}</div>
          <div class="muted">${esc(chain)}${review?.contractName ? ` · ${esc(review.contractName)}` : ""}${tx.chainId === 1 ? ' <span class="badge warn">mainnet — real funds</span>' : ""}</div>
          ${trust ? `<span class="trust ${trust.tone}">${esc(trust.label)}</span>` : ""}
        </div>
        <span class="pill ${s.tone}">${esc(s.label)}</span>
      </div>

      ${(review?.warnings ?? []).map((w) => `<p class="risk ${w.level}">${esc(w.text)}</p>`).join("")}

      <dl>
        <dt>${tx.to ? "To" : "Type"}</dt><dd class="mono">${tx.to ? esc(short(tx.to)) : "Deploy new contract"}</dd>
        <dt>Value</dt><dd>${esc(formatEth(tx.value))}</dd>
        ${decoded ? `<dt>${decoded.kind === "deploy" ? "Constructor" : "Function"}</dt><dd class="mono">${esc(decoded.signature)}</dd>` : ""}
        ${(decoded?.args ?? []).map((a) => `<dt class="arg">${esc(a.name || a.type)}</dt><dd class="mono">${esc(formatArg(a.value))}</dd>`).join("")}
      </dl>

      ${s.detail ? `<p class="detail ${s.tone}">${s.detail}</p>` : ""}

      <div class="actions">
        ${canSign ? `<button class="primary" data-open="${esc(tx.signUrl)}">${check?.status === "rejected" ? "Retry on signing page" : "Open signing page"}</button>` : ""}
        ${check?.explorerUrl ? `<button data-open="${esc(check.explorerUrl)}">View transaction</button>` : ""}
        ${check?.contractExplorerUrl ? `<button data-open="${esc(check.contractExplorerUrl)}">View contract ${esc(short(check.contractAddress ?? ""))}</button>` : ""}
      </div>
    </div>`;

  root.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((b) =>
    b.addEventListener("click", () => open(b.dataset.open!)),
  );
}

// --- live tracking ----------------------------------------------------------

/** Stop polling once the outcome can no longer change: mined (receipt) or expired. */
function isFinal(c: CheckResult): boolean {
  return c.status === "not_found" || Boolean(c.receipt);
}

/** Tells the model about a settled outcome, once per status. */
let reportedStatus: string | undefined;
async function reportToModel(c: CheckResult) {
  const settled = c.receipt || c.status === "rejected" || c.status === "not_found";
  if (!tx || !settled || reportedStatus === c.status) return;
  reportedStatus = c.status;
  const outcome = c.receipt ? (c.receipt.status === 0 ? "reverted" : "confirmed") : c.status;
  await app.updateModelContext({
    content: [{
      type: "text",
      text: `Transaction ${tx.transactionId} is ${outcome}` +
        (c.txHash ? ` (hash ${c.txHash})` : "") +
        (c.contractAddress ? `, deployed at ${c.contractAddress}` : "") +
        (c.status === "rejected" && c.errorMessage ? `: ${c.errorMessage}` : "") + ".",
    }],
  }).catch(() => { /* optional host capability */ });
}

async function track() {
  if (polling || !tx) return;
  polling = true;
  let errors = 0;
  while (tx) {
    let delay = POLL_MS;
    try {
      const result = await app.callServerTool({
        name: "check_transaction",
        arguments: { transactionId: tx.transactionId },
      });
      const next = parseResult(result) as CheckResult | undefined;
      if (!next?.status) throw new Error("Unexpected check_transaction result");
      check = next;
      errors = 0;
      render();
      void reportToModel(check);
      if (isFinal(check)) break;
      if (check.status === "rejected") delay = POLL_AFTER_REJECT_MS;
    } catch {
      // Keep going: a failed poll says nothing about the transaction itself.
      errors++;
      delay = Math.min(POLL_MS * 2 ** errors, POLL_MAX_BACKOFF_MS);
    }
    await new Promise((r) => setTimeout(r, delay));
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
