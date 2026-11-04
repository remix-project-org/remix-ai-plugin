import { useEffect, useState } from 'react'
import { JsonRpcProvider, formatEther } from 'ethers'
import { PUBLIC_RPCS } from '../chains'
import type { PendingTransaction } from '../types'

// Simulates the transaction against a public RPC before the user signs:
// estimates gas and fee, checks the sender's balance and surfaces likely reverts.

interface Props {
  tx: PendingTransaction
  from: string
}

type Result =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ok'; fee: bigint; balance: bigint; total: bigint }
  | { state: 'revert'; reason: string; balance?: bigint }

function revertReason(err: unknown): string {
  const e = err as { shortMessage?: string; reason?: string; message?: string }
  return e.reason ?? e.shortMessage ?? e.message ?? 'Unknown error'
}

function eth(wei: bigint): string {
  const n = Number(formatEther(wei))
  return `${n === 0 ? '0' : n < 0.000001 ? '<0.000001' : n.toFixed(6)} ETH`
}

export function Preflight({ tx, from }: Props) {
  const [result, setResult] = useState<Result>({ state: 'loading' })

  useEffect(() => {
    const rpc = tx.chainId ? PUBLIC_RPCS[tx.chainId] : undefined
    if (!rpc) { setResult({ state: 'unavailable' }); return }

    let cancelled = false
    const provider = new JsonRpcProvider(rpc, tx.chainId, { staticNetwork: true })
    const value = BigInt(tx.value ?? '0')
    const request = { from, data: tx.data, value, ...(tx.to ? { to: tx.to } : {}) }

    setResult({ state: 'loading' })
    ;(async () => {
      const balance = await provider.getBalance(from)
      try {
        const [gas, feeData] = await Promise.all([
          tx.gasLimit ? Promise.resolve(BigInt(tx.gasLimit)) : provider.estimateGas(request),
          provider.getFeeData(),
        ])
        const price = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n
        const fee = gas * price
        if (!cancelled) setResult({ state: 'ok', fee, balance, total: fee + value })
      } catch (err) {
        if (!cancelled) setResult({ state: 'revert', reason: revertReason(err), balance })
      }
    })().catch(() => { if (!cancelled) setResult({ state: 'unavailable' }) })

    return () => { cancelled = true }
  }, [tx, from])

  if (result.state === 'unavailable') return null
  if (result.state === 'loading') {
    return <div className="preflight muted-box">Simulating transaction…</div>
  }
  if (result.state === 'revert') {
    const noFunds = result.balance === 0n
    return (
      <div className="preflight warn-box">
        <strong>{noFunds ? 'This account has no ETH on this network.' : 'This transaction will likely fail.'}</strong>
        <div className="preflight-detail">{noFunds ? 'Fund the account to pay for gas, then try again.' : result.reason}</div>
      </div>
    )
  }

  const insufficient = result.balance < result.total
  return (
    <div className={`preflight ${insufficient ? 'warn-box' : 'muted-box'}`}>
      <div className="preflight-row"><span>Estimated max fee</span><span>{eth(result.fee)}</span></div>
      <div className="preflight-row"><span>Total (value + fee)</span><span>{eth(result.total)}</span></div>
      <div className="preflight-row"><span>Your balance</span><span>{eth(result.balance)}</span></div>
      {insufficient && <div className="preflight-detail"><strong>Insufficient funds</strong> — the wallet will likely reject this.</div>}
    </div>
  )
}
