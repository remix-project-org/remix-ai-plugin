export interface PendingTransaction {
  id: string
  to?: string
  data: string
  value?: string
  chainId?: number
  gasLimit?: string
  description?: string
  status: 'pending' | 'signing' | 'sent' | 'failed'
  txHash?: string
  errorMessage?: string
}

export interface AppConfig {
  wcProjectId?: string
}

export type StatusMessage =
  | { type: 'info'; text: string }
  | { type: 'success'; text: string; txHash?: string; explorerUrl?: string }
  | { type: 'error'; text: string }
