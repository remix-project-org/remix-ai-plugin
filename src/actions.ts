// ---------------------------------------------------------------------------
// Action layer — the five capabilities of the plugin, as plain async functions.
//
// Both front doors use this module unchanged:
//   • mcp.ts  — MCP connector for ChatGPT developer mode / Apps SDK
//   • rest.ts — REST endpoints behind the OpenAPI spec used by custom GPT Actions
// ---------------------------------------------------------------------------

import { JsonRpcProvider } from "ethers";
import { compileSolidity } from "./tools/compile.js";
import { getAuditChecklist, doAudit } from "./tools/audit.js";
import { createTransaction, getTransaction, setReceipt } from "./store.js";
import { PUBLIC_RPCS } from "./rpcs.js";

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

// --- transact --------------------------------------------------------------

export interface TransactArgs {
  data: string;
  to?: string;
  value?: string;
  chainId?: number;
  gasLimit?: string;
  description?: string;
}

export function transact(args: TransactArgs) {
  const pending = createTransaction(args);
  return {
    transactionId: pending.id,
    signUrl: `${BASE_URL()}/sign/${pending.id}`,
    status: pending.status,
    instructions: [
      "Show the signUrl to the user as a clickable link.",
      "After sharing it, call check_transaction with the transactionId to monitor progress.",
      "Poll every few seconds until status is 'sent' or 'failed'.",
    ].join(" "),
  };
}

// --- check_transaction -----------------------------------------------------

export async function checkTransaction(transactionId: string) {
  const tx = getTransaction(transactionId);
  if (!tx) {
    return {
      status: "not_found" as const,
      error: "Transaction not found or expired (TTL: 1 hour).",
    };
  }

  // Fetch the receipt once, the first time we see a broadcast transaction.
  if (tx.status === "sent" && tx.txHash && !tx.receipt && tx.chainId) {
    const rpcUrl = PUBLIC_RPCS[tx.chainId];
    if (rpcUrl) {
      try {
        const provider = new JsonRpcProvider(rpcUrl);
        const receipt = await provider.getTransactionReceipt(tx.txHash);
        if (receipt) setReceipt(transactionId, receipt.toJSON());
      } catch { /* receipt not available yet — ignore */ }
    }
  }

  const { wallets, ...rest } = getTransaction(transactionId)!;
  const payload: Record<string, unknown> = {
    ...rest,
    signingPageOpened: Boolean(wallets),
    walletsDetected: wallets ? wallets.detected.map((w) => w.name) : null,
  };

  if (tx.status === "sent") {
    payload.message = "Transaction was broadcast successfully.";
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
