import type { AppConfig, PendingTransaction, TxReview } from './types'

export async function fetchTx(txId: string): Promise<PendingTransaction> {
  const res = await fetch(`/api/tx/${txId}`)
  if (!res.ok) throw new Error('Transaction not found or expired.')
  return res.json() as Promise<PendingTransaction>
}

/** Clear-signing review built by the server; null if it couldn't be built. */
export async function fetchReview(txId: string): Promise<TxReview | null> {
  try {
    const res = await fetch(`/api/tx/${txId}/review`)
    return res.ok ? (await res.json() as TxReview) : null
  } catch {
    return null
  }
}

export async function fetchConfig(): Promise<AppConfig> {
  const res = await fetch('/api/config')
  if (!res.ok) return {}
  return res.json() as Promise<AppConfig>
}

export async function reportStatus(
  txId: string,
  status: 'signing' | 'sent' | 'rejected',
  txHash?: string,
  error?: string,
  wallet?: string,
): Promise<void> {
  await fetch(`/api/tx/${txId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, txHash, error, wallet }),
  }).catch(() => { /* non-fatal */ })
}

export async function reportWallets(
  txId: string,
  wallets: { name: string; rdns?: string }[],
): Promise<void> {
  await fetch(`/api/tx/${txId}/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallets }),
  }).catch(() => { /* non-fatal */ })
}
