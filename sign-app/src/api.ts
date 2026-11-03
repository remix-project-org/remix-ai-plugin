import type { AppConfig, PendingTransaction } from './types'

export async function fetchTx(txId: string): Promise<PendingTransaction> {
  const res = await fetch(`/api/tx/${txId}`)
  if (!res.ok) throw new Error('Transaction not found or expired.')
  return res.json() as Promise<PendingTransaction>
}

export async function fetchConfig(): Promise<AppConfig> {
  const res = await fetch('/api/config')
  if (!res.ok) return {}
  return res.json() as Promise<AppConfig>
}

export async function reportStatus(
  txId: string,
  status: 'signing' | 'sent' | 'failed',
  txHash?: string,
  error?: string,
): Promise<void> {
  await fetch(`/api/tx/${txId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, txHash, error }),
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
