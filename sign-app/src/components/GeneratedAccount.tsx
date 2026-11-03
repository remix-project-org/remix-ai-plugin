import { useEffect, useState } from 'react'
import { JsonRpcProvider, HDNodeWallet } from 'ethers'
import { PUBLIC_RPCS, ADDRESS_EXPLORERS } from '../chains'
import { GENERATED_WALLET_KEY } from './WalletOptions'

interface Props {
  wallet: HDNodeWallet
  chainId: number | undefined
  onReplace: (wallet: HDNodeWallet) => void
}

export function GeneratedAccount({ wallet, chainId, onReplace }: Props) {
  const [keyVisible, setKeyVisible] = useState(false)
  const [copied, setCopied] = useState<'address' | 'key' | null>(null)
  const [balance, setBalance] = useState<string | null>(null)

  useEffect(() => {
    if (!chainId) return
    const rpc = PUBLIC_RPCS[chainId]
    if (!rpc) return

    const provider = new JsonRpcProvider(rpc)
    provider.getBalance(wallet.address).then(bal => {
      const eth = Number(bal) / 1e18
      setBalance(bal === 0n ? 'No ETH — fund this address before sending' : `${eth.toFixed(6)} ETH`)
    }).catch(() => setBalance('Could not fetch balance'))
  }, [wallet.address, chainId])

  function replaceAccount() {
    if (!confirm('Generate a new account? The current one will be replaced in storage.')) return
    const newWallet = HDNodeWallet.createRandom()
    localStorage.setItem(GENERATED_WALLET_KEY, newWallet.mnemonic!.phrase)
    onReplace(newWallet)
  }

  function copy(text: string, which: 'address' | 'key') {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(which)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  const explorerUrl = chainId ? ADDRESS_EXPLORERS[chainId] : undefined

  return (
    <div className="gen-panel">
      <div className="gen-header">
        <span>✨ Generated account</span>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span className="warn-badge">needs ETH for gas</span>
          <button className="copy-btn" onClick={replaceAccount} title="Generate a new account">new</button>
        </div>
      </div>

      <div className="key-row">
        <span className="key-label">Address</span>
        <span className="key-val mono">{wallet.address}</span>
        <button className="copy-btn" onClick={() => copy(wallet.address, 'address')}>
          {copied === 'address' ? '✓' : 'copy'}
        </button>
      </div>

      <div className="key-row">
        <span className="key-label">Private key</span>
        <span
          className={`key-val mono${keyVisible ? '' : ' blurred'}`}
          onClick={() => setKeyVisible(true)}
          title={keyVisible ? undefined : 'Click to reveal'}
        >
          {wallet.privateKey}
        </span>
        <button className="copy-btn" onClick={() => copy(wallet.privateKey, 'key')}>
          {copied === 'key' ? '✓' : 'copy'}
        </button>
      </div>

      <div className="balance-row">
        {balance ?? 'Checking balance…'}
        {explorerUrl && (
          <>
            {' · '}
            <a href={explorerUrl + wallet.address} target="_blank" rel="noreferrer">
              View on explorer ↗
            </a>
          </>
        )}
      </div>
    </div>
  )
}
