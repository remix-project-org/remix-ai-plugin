import crypto from "crypto";

export interface DetectedWallet {
  name: string;
  rdns?: string;
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
  status: "pending" | "signing" | "sent" | "failed";
  txHash?: string;
  errorMessage?: string;
  receipt?: object;
  /** Browser wallets found by the signing page; unset until the page is opened. */
  wallets?: { detected: DetectedWallet[]; reportedAt: number };
}

const store = new Map<string, PendingTransaction>();

const TTL_MS = 60 * 60 * 1000; // 1 hour

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, tx] of store) {
    if (tx.createdAt < cutoff) store.delete(id);
  }
}, 60_000).unref();

export function createTransaction(
  tx: Omit<PendingTransaction, "id" | "createdAt" | "status">
): PendingTransaction {
  const id = crypto.randomUUID();
  const pending: PendingTransaction = {
    ...tx,
    id,
    createdAt: Date.now(),
    status: "pending",
  };
  store.set(id, pending);
  return pending;
}

export function getTransaction(id: string): PendingTransaction | undefined {
  return store.get(id);
}

export function markSigning(id: string): boolean {
  const tx = store.get(id);
  if (!tx) return false;
  tx.status = "signing";
  return true;
}

export function markSent(id: string, txHash: string): boolean {
  const tx = store.get(id);
  if (!tx) return false;
  tx.status = "sent";
  tx.txHash = txHash;
  return true;
}

export function markFailed(id: string, errorMessage: string): boolean {
  const tx = store.get(id);
  if (!tx) return false;
  tx.status = "failed";
  tx.errorMessage = errorMessage;
  return true;
}

export function setWallets(id: string, detected: DetectedWallet[]): boolean {
  const tx = store.get(id);
  if (!tx) return false;
  tx.wallets = { detected, reportedAt: Date.now() };
  return true;
}

export function setReceipt(id: string, receipt: object): boolean {
  const tx = store.get(id);
  if (!tx) return false;
  tx.receipt = receipt;
  return true;
}
