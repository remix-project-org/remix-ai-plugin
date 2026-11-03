import type { StatusMessage } from '../types'

interface Props {
  status: StatusMessage | null
}

export function Status({ status }: Props) {
  if (!status) return null

  return (
    <div className={`status status-${status.type}`}>
      {status.type === 'success' && status.explorerUrl ? (
        <>
          Transaction sent!{' '}
          <a href={status.explorerUrl} target="_blank" rel="noreferrer">
            View on explorer ↗
          </a>
          <div className="tx-hash">{status.txHash}</div>
        </>
      ) : (
        status.text
      )}
    </div>
  )
}
