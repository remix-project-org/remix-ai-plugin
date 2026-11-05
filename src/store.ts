import crypto from "crypto";
import type { DecodedCall } from "./tools/abi.js";
import type { TxReview } from "./tools/clearsign.js";

export interface DetectedWallet {
  name: string;
  rdns?: string;
}

/**
 * pending → signing → sent → confirmed | reverted
 *              ↓  ↑
 *           rejected   (the user can retry from the signing page)
 *
 * confirmed / reverted come only from the on-chain receipt.
 */
export type TxStatus = "pending" | "signing" | "sent" | "confirmed" | "reverted" | "rejected";

const TRANSITIONS: Record<TxStatus, readonly TxStatus[]> = {
  pending: ["signing", "sent", "rejected"],
  signing: ["signing", "sent", "rejected"],
  rejected: ["signing", "sent", "rejected"],
  sent: ["confirmed", "reverted"],
  confirmed: [],
  reverted: [],
};

export const TERMINAL_STATUSES: readonly TxStatus[] = ["confirmed", "reverted", "rejected"];

/** One signing attempt from the signing page. Kept for history only — never drives the top-level status. */
export interface SigningAttempt {
  startedAt: number;
  endedAt?: number;
  wallet?: string;
  outcome?: "sent" | "rejected";
  txHash?: string;
  error?: string;
}

export interface PendingTransaction {
  id: string;
  to?: string;
  data: string;
  value?: string;
  chainId?: number;
  gasLimit?: string;
  description?: string;
  createdAt: number;
  status: TxStatus;
  txHash?: string;
  /** Error of the latest attempt; only set while status is "rejected". */
  errorMessage?: string;
  receipt?: object;
  attempts: SigningAttempt[];
  /** Human-readable form of `data`, when an ABI was available. */
  decoded?: DecodedCall;
  /** Browser wallets found by the signing page; unset until the page is opened. */
  wallets?: { detected: DetectedWallet[]; reportedAt: number };
  /** Clear-signing review (intent, formatted fields, warnings); set once it has been built. */
  review?: TxReview;
}

/** Result of a status update: false when the transaction is unknown or the transition is not allowed. */
export type UpdateResult = { ok: true } | { ok: false; reason: "not_found" | "invalid_transition"; status?: TxStatus };

const store = new Map<string, PendingTransaction>();

const TTL_MS = 60 * 60 * 1000; // 1 hour

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, tx] of store) {
    if (tx.createdAt < cutoff) store.delete(id);
  }
}, 60_000).unref();

export function createTransaction(
  tx: Omit<PendingTransaction, "id" | "createdAt" | "status" | "attempts">
): PendingTransaction {
  const id = crypto.randomUUID();
  const pending: PendingTransaction = {
    ...tx,
    id,
    createdAt: Date.now(),
    status: "pending",
    attempts: [],
  };
  store.set(id, pending);
  return pending;
}

export function getTransaction(id: string): PendingTransaction | undefined {
  return store.get(id);
}

function transition(id: string, next: TxStatus, apply: (tx: PendingTransaction) => void): UpdateResult {
  const tx = store.get(id);
  if (!tx) return { ok: false, reason: "not_found" };
  if (!TRANSITIONS[tx.status].includes(next)) return { ok: false, reason: "invalid_transition", status: tx.status };
  apply(tx);
  tx.status = next;
  // Any status other than rejected supersedes an earlier failed attempt.
  if (next !== "rejected") delete tx.errorMessage;
  return { ok: true };
}

/** The open attempt, or a new one when the page reported an outcome without announcing the attempt first. */
function currentAttempt(tx: PendingTransaction, wallet?: string): SigningAttempt {
  const last = tx.attempts.at(-1);
  if (last && !last.outcome) return last;
  const attempt: SigningAttempt = { startedAt: Date.now(), ...(wallet ? { wallet } : {}) };
  tx.attempts.push(attempt);
  return attempt;
}

export function markSigning(id: string, wallet?: string): UpdateResult {
  return transition(id, "signing", (tx) => {
    tx.attempts.push({ startedAt: Date.now(), ...(wallet ? { wallet } : {}) });
  });
}

export function markSent(id: string, txHash: string, wallet?: string): UpdateResult {
  return transition(id, "sent", (tx) => {
    Object.assign(currentAttempt(tx, wallet), { outcome: "sent", txHash, endedAt: Date.now() });
    tx.txHash = txHash;
  });
}

export function markRejected(id: string, errorMessage: string, wallet?: string): UpdateResult {
  return transition(id, "rejected", (tx) => {
    Object.assign(currentAttempt(tx, wallet), { outcome: "rejected", error: errorMessage, endedAt: Date.now() });
    tx.errorMessage = errorMessage;
  });
}

/** Stores the mined receipt and settles the status from it: status 1 → confirmed, 0 → reverted. */
export function setReceipt(id: string, receipt: { status?: number | null }): UpdateResult {
  return transition(id, receipt.status === 0 ? "reverted" : "confirmed", (tx) => {
    tx.receipt = receipt;
  });
}

export function setReview(id: string, review: TxReview): boolean {
  const tx = store.get(id);
  if (!tx) return false;
  tx.review = review;
  return true;
}

export function setWallets(id: string, detected: DetectedWallet[]): boolean {
  const tx = store.get(id);
  if (!tx) return false;
  tx.wallets = { detected, reportedAt: Date.now() };
  return true;
}
