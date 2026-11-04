import { CHAIN_NAMES } from '../chains'
import type { PendingTransaction } from '../types'

function formatArg(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function hexToEth(hex: string | undefined): string {
  if (!hex || hex === '0x0' || hex === '0x') return '0 ETH'
  const val = Number(BigInt(hex)) / 1e18
  return val.toFixed(val < 0.001 ? 8 : 4) + ' ETH'
}

interface Props {
  tx: PendingTransaction
}

export function TxFields({ tx }: Props) {
  const decoded = tx.decoded
  return (
    <div className="tx-fields">
      {decoded && (
        <Field label={decoded.kind === 'deploy' ? 'Constructor' : 'Function'}>
          <span className="mono">{decoded.signature}</span>
          {decoded.args && decoded.args.length > 0 && (
            <div className="decoded-args">
              {decoded.args.map((a, i) => (
                <div key={i} className="decoded-arg">
                  <span className="decoded-name">{a.name || `arg${i}`} <em className="muted">{a.type}</em></span>
                  <span className="mono">{formatArg(a.value)}</span>
                </div>
              ))}
            </div>
          )}
        </Field>
      )}
      <Field label="To">
        {tx.to ?? <em className="muted">(contract creation — no recipient)</em>}
      </Field>
      <Field label="Value">{hexToEth(tx.value)}</Field>
      <Field label="Network">
        {tx.chainId ? `${CHAIN_NAMES[tx.chainId] ?? 'Chain'} (#${tx.chainId})` : 'wallet default'}
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
