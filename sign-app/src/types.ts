export interface PendingTransaction {
  id: string
  to?: string
  data: string
  value?: string
  chainId?: number
  gasLimit?: string
  description?: string
  status: 'pending' | 'signing' | 'sent' | 'confirmed' | 'reverted' | 'rejected'
  txHash?: string
  errorMessage?: string
  decoded?: DecodedCall
}

export interface DecodedCall {
  kind: 'call' | 'deploy'
  signature: string
  args?: Array<{ name: string; type: string; value: unknown }>
}

export interface TxReview {
  action: string
  intent: string
  source: 'erc7730' | 'verified' | 'assistant' | 'none'
  sourceDetail: string
  contractName?: string
  owner?: string
  signature?: string
  fields: Array<{ label: string; value: string; address?: string; warning?: string }>
  warnings: Array<{ level: 'danger' | 'caution'; text: string }>
}

export interface AppConfig {
  wcProjectId?: string
}

export type StatusMessage =
  | { type: 'info'; text: string }
  | { type: 'success'; text: string; txHash?: string; explorerUrl?: string }
  | { type: 'error'; text: string }
