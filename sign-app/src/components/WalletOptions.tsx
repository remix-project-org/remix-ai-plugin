import { useEffect, useState } from 'react'
import { HDNodeWallet } from 'ethers'
import { modal, wcProjectId } from '../walletConfig'
import type { BrowserWallet, Eip1193Provider } from '../wallets'

export const GENERATED_WALLET_KEY = 'sign-app:generated-wallet'

interface Props {
  wallets: BrowserWallet[]
  walletsSettled: boolean
  onConnected: (address: string, type: 'injected' | 'walletconnect', provider?: Eip1193Provider) => void
  onGenerate: (wallet: HDNodeWallet) => void
  onError: (msg: string) => void
}

export function WalletOptions({ wallets, walletsSettled, onConnected, onGenerate, onError }: Props) {
  const [savedAddress, setSavedAddress] = useState<string | null>(null)

  useEffect(() => {
    const phrase = localStorage.getItem(GENERATED_WALLET_KEY)
    if (phrase) {
      try {
        setSavedAddress(HDNodeWallet.fromPhrase(phrase).address)
      } catch {
        localStorage.removeItem(GENERATED_WALLET_KEY)
      }
    }
  }, [])

  async function connectInjected(wallet: BrowserWallet) {
    try {
      const accounts = (await wallet.provider.request({ method: 'eth_requestAccounts' })) as string[]
      if (!accounts[0]) throw new Error(`${wallet.name} returned no accounts`)
      onConnected(accounts[0], 'injected', wallet.provider)
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'Wallet connection failed')
    }
  }

  async function connectWalletConnect() {
    if (!modal) return
    try {
      await modal.open()
      // Connection result arrives via useAppKitAccount in App.tsx
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'WalletConnect failed')
    }
  }

  function generateAccount() {
    try {
      const phrase = localStorage.getItem(GENERATED_WALLET_KEY)
      let wallet: HDNodeWallet
      if (phrase) {
        wallet = HDNodeWallet.fromPhrase(phrase)
      } else {
        wallet = HDNodeWallet.createRandom()
        localStorage.setItem(GENERATED_WALLET_KEY, wallet.mnemonic!.phrase)
        setSavedAddress(wallet.address)
      }
      onGenerate(wallet)
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'Failed to load account')
    }
  }

  return (
    <div className="wallet-options">
      {wcProjectId && (
        <button className="wallet-btn" onClick={connectWalletConnect}>
          <span className="wallet-icon">🔗</span>
          <div>
            <div className="wallet-btn-title">WalletConnect</div>
            <div className="wallet-btn-sub">Scan QR with any mobile wallet</div>
          </div>
        </button>
      )}

      {wallets.map(wallet => (
        <button key={wallet.uuid} className="wallet-btn" onClick={() => connectInjected(wallet)}>
          {wallet.icon
            ? <img className="wallet-icon wallet-icon-img" src={wallet.icon} alt="" />
            : <span className="wallet-icon">🦊</span>}
          <div>
            <div className="wallet-btn-title">{wallet.name}</div>
            <div className="wallet-btn-sub">Browser wallet detected</div>
          </div>
        </button>
      ))}

      {walletsSettled && wallets.length === 0 && (
        <a className="wallet-btn" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
          <span className="wallet-icon">🦊</span>
          <div>
            <div className="wallet-btn-title">No browser wallet detected</div>
            <div className="wallet-btn-sub">Install MetaMask, then reload this page</div>
          </div>
        </a>
      )}

      <button className="wallet-btn" onClick={generateAccount}>
        <span className="wallet-icon">✨</span>
        <div>
          <div className="wallet-btn-title">Generated account</div>
          <div className="wallet-btn-sub">
            {savedAddress
              ? `${savedAddress.slice(0, 6)}…${savedAddress.slice(-4)} — saved in browser`
              : 'Creates and saves a keypair in your browser'}
          </div>
        </div>
      </button>
    </div>
  )
}
