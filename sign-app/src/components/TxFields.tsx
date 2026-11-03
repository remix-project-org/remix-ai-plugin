import type { PendingTransaction } from '../types'

function hexToEth(hex: string | undefined): string {
  if (!hex || hex === '0x0' || hex === '0x') return '0 ETH'
  const val = Number(BigInt(hex)) / 1e18
  return val.toFixed(val < 0.001 ? 8 : 4) + ' ETH'
}

interface Props {
  tx: PendingTransaction
}

export function TxFields({ tx }: Props) {
  return (
    <div className="tx-fields">
      <Field label="To">
        {tx.to ?? <em className="muted">(contract creation — no recipient)</em>}
      </Field>
      <Field label="Value">{hexToEth(tx.value)}</Field>
      <Field label="Chain ID">
        {tx.chainId ? `#${tx.chainId}` : 'wallet default'}
      </Field>
      <Field label="Gas limit">{tx.gasLimit ?? 'auto'}</Field>
      <Field label="Data" truncate>
        {tx.data || '0x'}
      </Field>
    </div>
  )
}

function Field({
  label,
  children,
  truncate,
}: {
  label: string
  children: React.ReactNode
  truncate?: boolean
}) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className={`field-value${truncate ? ' truncate' : ''}`}>{children}</div>
    </div>
  )
}
