// ---------------------------------------------------------------------------
// Action layer — the plugin's capabilities, as plain async functions.
//
// Both front doors use this module unchanged:
//   • mcp.ts  — MCP connector for Claude and ChatGPT
//   • rest.ts — REST endpoints behind the OpenAPI spec used by custom GPT Actions
// ---------------------------------------------------------------------------

import { JsonRpcProvider } from "ethers";
import { compileSolidity } from "./tools/compile.js";
import { getAuditChecklist, doAudit } from "./tools/audit.js";
import { encode, decodeTransaction, parseAbi, toJsonSafe, readContract as readContractCall, type DecodedCall, type EncodeArgs, type ReadArgs } from "./tools/abi.js";
import { createTransaction, getTransaction, setReceipt, type PendingTransaction } from "./store.js";
import { PUBLIC_RPCS, explorerUrl } from "./rpcs.js";

export type Sources = Record<string, { content: string }>;

const BASE_URL = () => process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

// --- compile ---------------------------------------------------------------

export interface CompileArgs {
  sources: Sources;
  version?: string;
  settings?: Record<string, unknown>;
}

export async function compile(args: CompileArgs) {
  return compileSolidity({
    sources: args.sources,
    version: args.version,
    settings: args.settings,
  });
}

// --- encode_call -----------------------------------------------------------

// Remembers what recent encode_call results mean, so transact can show the
// decoded call on the signing page even when no ABI is passed to it.
const recentEncodings = new Map<string, DecodedCall>();
const MAX_RECENT_ENCODINGS = 500;

export function encodeCall(args: EncodeArgs) {
  const result = encode(args);
  const decoded = decodeTransaction(args.abi, result.data, result.kind === "deploy");
  if (decoded) {
    if (result.kind === "deploy" && !decoded.args) {
      // Dynamic constructor args can't be recovered from the bytecode tail, but we know them here.
      const inputs = parseAbi(args.abi).deploy.inputs;
      decoded.args = inputs.map((p, i) => ({ name: p.name, type: p.type, value: toJsonSafe(args.args?.[i]) }));
    }
    recentEncodings.set(result.data.toLowerCase(), decoded);
    if (recentEncodings.size > MAX_RECENT_ENCODINGS) {
      recentEncodings.delete(recentEncodings.keys().next().value!);
    }
  }
  return {
    ...result,
    next: result.kind === "deploy"
      ? "Pass `data` to transact with no `to` field to deploy."
      : "Pass `data` to transact with `to` set to the contract address" + (result.payable ? " (and `value` if sending ETH)." : "."),
  };
}

// --- read_contract ---------------------------------------------------------

export async function readContract(args: ReadArgs) {
  return readContractCall(args);
}

// --- transact --------------------------------------------------------------

export interface TransactArgs {
  data: string;
  to?: string;
  value?: string;
  chainId?: number;
  gasLimit?: string;
  description?: string;
  /** Optional ABI so the signing page can show the decoded call. */
  abi?: unknown;
}

export function transact({ abi, ...args }: TransactArgs) {
  const data = args.data.startsWith("0x") ? args.data : `0x${args.data}`;
  const decoded =
    (abi !== undefined ? decodeTransaction(abi, data, !args.to) : undefined) ??
    recentEncodings.get(data.toLowerCase());

  const pending = createTransaction({ ...args, data, ...(decoded ? { decoded } : {}) });
  return {
    transactionId: pending.id,
    signUrl: `${BASE_URL()}/sign/${pending.id}`,
    status: pending.status,
    chainId: pending.chainId,
    to: pending.to,
    value: pending.value,
    description: pending.description,
    ...(decoded ? { decoded } : {}),
    instructions: [
      "Show the signUrl to the user as a clickable link.",
      "Then call check_transaction with the transactionId and waitSeconds: 20 to wait for progress;",
      "repeat until status is 'sent' (and the receipt is present) or 'failed'.",
    ].join(" "),
  };
}

// --- check_transaction -----------------------------------------------------

const MAX_WAIT_SECONDS = 25;

async function fetchReceipt(tx: PendingTransaction): Promise<void> {
  if (tx.status !== "sent" || !tx.txHash || tx.receipt || !tx.chainId) return;
  const rpcUrl = PUBLIC_RPCS[tx.chainId];
  if (!rpcUrl) return;
  try {
    const provider = new JsonRpcProvider(rpcUrl, tx.chainId, { staticNetwork: true });
    const receipt = await provider.getTransactionReceipt(tx.txHash);
    if (receipt) setReceipt(tx.id, receipt.toJSON());
  } catch { /* receipt not available yet — ignore */ }
}

/**
 * Returns the transaction state. With waitSeconds > 0 it long-polls: it returns as
 * soon as something changes (status, wallet report, receipt) or the wait elapses.
 */
export async function checkTransaction(transactionId: string, waitSeconds = 0) {
  const tx = getTransaction(transactionId);
  if (!tx) {
    return {
      status: "not_found" as const,
      error: "Transaction not found or expired (TTL: 1 hour).",
    };
  }

  const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS) * 1000;
  const startStatus = tx.status;
  const startWalletReport = tx.wallets?.reportedAt;

  await fetchReceipt(tx);
  while (Date.now() < deadline) {
    if (tx.status === "failed" || tx.receipt) break;
    if (tx.status !== startStatus && tx.status !== "sent") break;
    if (tx.wallets?.reportedAt !== startWalletReport) break;
    await new Promise((r) => setTimeout(r, tx.status === "sent" ? 2000 : 500));
    await fetchReceipt(tx);
  }

  const { wallets, ...rest } = getTransaction(transactionId)!;
  const payload: Record<string, unknown> = {
    ...rest,
    signingPageOpened: Boolean(wallets),
    walletsDetected: wallets ? wallets.detected.map((w) => w.name) : null,
  };

  if (tx.txHash) payload.explorerUrl = explorerUrl(tx.chainId, "tx", tx.txHash);
  const contractAddress = (tx.receipt as { contractAddress?: string } | undefined)?.contractAddress;
  if (contractAddress) {
    payload.contractAddress = contractAddress;
    payload.contractExplorerUrl = explorerUrl(tx.chainId, "address", contractAddress);
  }

  if (tx.status === "sent") {
    payload.message = tx.receipt
      ? "Transaction was broadcast and mined."
      : "Transaction was broadcast; the receipt is not available yet — check again with waitSeconds to get it.";
  } else if (tx.status === "failed") {
    payload.error = tx.errorMessage;
    payload.message = "Transaction failed — see error for details.";
  } else if (tx.status === "signing") {
    payload.message = "User is currently confirming in their wallet. Check again in a few seconds.";
  } else if (!wallets) {
    payload.message = "Transaction is pending — user has not opened the signing page yet.";
  } else if (wallets.detected.length === 0) {
    payload.message = [
      "The user opened the signing page but no browser wallet extension was detected.",
      "Suggest installing MetaMask (https://metamask.io) or another wallet, or using WalletConnect / the generated account option on the page.",
    ].join(" ");
  } else {
    payload.message = `User opened the signing page (detected: ${wallets.detected.map((w) => w.name).join(", ")}) but has not confirmed yet.`;
  }

  return payload;
}

// --- get_audit_checklist ---------------------------------------------------

export interface ChecklistArgs {
  sources: Sources;
  maxCategories?: number;
  model?: string;
}

export async function auditChecklist(args: ChecklistArgs) {
  const result = await getAuditChecklist(
    args.sources,
    args.maxCategories ?? 12,
    args.model ?? "Balanced"
  );
  return {
    success: result.success,
    matchedCategories: result.matchedCategories,
    model: result.model,
    ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}),
    markdown: result.markdown,
    matches: result.matches,
  };
}

// --- do_audit --------------------------------------------------------------

export interface AuditArgs {
  sources: Sources;
  checklist: string;
  model?: string;
}

export async function audit(args: AuditArgs) {
  const result = await doAudit(args.sources, args.checklist, args.model ?? "Balanced");
  return {
    success: result.success,
    findingsCount: result.findingsCount,
    severity: result.severity,
    model: result.model,
    markdown: result.markdown,
  };
}
