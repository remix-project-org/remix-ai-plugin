import { ADDRESS_EXPLORERS } from '../chains'
import type { TxReview } from '../types'

// Clear-signing view: what the transaction does, where that description comes
// from, and anything risky — shown before the raw technical details.

const SOURCE_BADGE: Record<TxReview['source'], { label: string; tone: string }> = {
  erc7730: { label: 'Clear-signing descriptor', tone: 'trust-high' },
  verified: { label: 'Verified contract', tone: 'trust-high' },
  assistant: { label: 'Unverified', tone: 'trust-low' },
  none: { label: 'Not decoded', tone: 'trust-none' },
}

interface Props {
  review: TxReview | null
  loading: boolean
  chainId?: number
  /** Connected wallet, so fields that point at it can say so. */
  from?: string | null
  /** The assistant's own description, shown as a note rather than as the source of truth. */
  note?: string
}

export function ClearSign({ review, loading, chainId, from, note }: Props) {
  if (loading) return <div className="clear-sign muted-box">Looking up what this transaction does…</div>
  if (!review) return null

  const badge = SOURCE_BADGE[review.source]
  const explorer = chainId ? ADDRESS_EXPLORERS[chainId] : undefined
  const isMine = (address?: string) => Boolean(address && from && address.toLowerCase() === from.toLowerCase())

  return (
    <div className="clear-sign">
      <div className="clear-sign-head">
        <span className="clear-sign-action">{review.action}</span>
        <span className={`trust-badge ${badge.tone}`}>{badge.label}</span>
      </div>
      <div className="clear-sign-intent">{review.intent}</div>
      {review.contractName && <div className="clear-sign-contract">{review.contractName}{review.owner ? ` · ${review.owner}` : ''}</div>}

      {review.warnings.map((w, i) => (
        <div key={i} className={`risk ${w.level === 'danger' ? 'risk-danger' : 'risk-caution'}`}>
          {w.level === 'danger' ? '⛔' : '⚠️'} {w.text}
        </div>
      ))}

      {review.fields.length > 0 && (
        <dl className="clear-sign-fields">
          {review.fields.map((f, i) => (
            <div key={i} className="clear-sign-field">
              <dt>{f.label}</dt>
              <dd>
                {f.address && explorer
                  ? <a href={explorer + f.address} target="_blank" rel="noreferrer" className="mono">{f.value}</a>
                  : <span className={f.address ? 'mono' : undefined}>{f.value}</span>}
                {isMine(f.address) && <span className="chip-badge mine">your wallet</span>}
                {f.warning && <div className="field-warning">⚠️ {f.warning}</div>}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <p className="clear-sign-source">{review.sourceDetail}</p>
      {note && <p className="clear-sign-note">Assistant's note: “{note}”</p>}
    </div>
  )
}
