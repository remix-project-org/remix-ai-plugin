import { useEffect, useState } from 'react'
import { useAppKitAccount, useAppKitProvider } from '@reown/appkit/react'
import { BrowserProvider, JsonRpcProvider, HDNodeWallet, type Eip1193Provider } from 'ethers'
import { TxFields } from './components/TxFields'
import { WalletOptions } from './components/WalletOptions'
import { GeneratedAccount } from './components/GeneratedAccount'
import { Status } from './components/Status'
import { fetchTx, reportStatus, reportWallets } from './api'
import { explorerTxUrl, PUBLIC_RPCS } from './chains'
import { modal } from './walletConfig'
import { useBrowserWallets, type Eip1193Provider as InjectedProvider } from './wallets'
import type { PendingTransaction, StatusMessage } from './types'
import './App.css'

// Extract tx ID from URL: /sign/<uuid>
const TX_ID = window.location.pathname.split('/sign/')[1]?.replace(/\/$/, '') ?? ''

type WalletMode = 'walletconnect' | 'injected' | 'generated' | null

export default function App() {
  const [tx, setTx] = useState<PendingTransaction | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [walletMode, setWalletMode] = useState<WalletMode>(null)
  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [generatedWallet, setGeneratedWallet] = useState<HDNodeWallet | null>(null)
  const [injectedProvider, setInjectedProvider] = useState<InjectedProvider | null>(null)

  const { wallets: browserWallets, settled: walletsSettled } = useBrowserWallets()

  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(false)
  const [status, setStatus] = useState<StatusMessage | null>(null)

  // AppKit account state (used for WalletConnect mode)
  const { address: wcAddress, isConnected: wcConnected } = useAppKitAccount()
  const { walletProvider } = useAppKitProvider<{ request: (...args: unknown[]) => Promise<unknown> }>('eip155')

  // Sync WalletConnect connection into local state (including pre-existing sessions and account switches)
  useEffect(() => {
    if (wcConnected && wcAddress && (walletMode === null || walletMode === 'walletconnect')) {
      setWalletMode('walletconnect')
      setWalletAddress(wcAddress)
    }
  }, [walletMode, wcConnected, wcAddress])

  // Tell the server which browser wallets are installed so the assistant can guide the user
  useEffect(() => {
    if (!TX_ID || !walletsSettled) return
    reportWallets(TX_ID, browserWallets.map(({ name, rdns }) => ({ name, rdns })))
  }, [walletsSettled, browserWallets])

  // Track injected wallet account switches
  useEffect(() => {
    if (walletMode !== 'injected' || !injectedProvider?.on) return
    const eth = injectedProvider
    function onAccountsChanged(accounts: string[]) {
      if (accounts.length > 0) setWalletAddress(accounts[0]!)
      else { setWalletMode(null); setWalletAddress(null); setInjectedProvider(null) }
    }
    eth.on!('accountsChanged', onAccountsChanged)
    return () => eth.removeListener?.('accountsChanged', onAccountsChanged)
  }, [walletMode, injectedProvider])

  // Load the pending transaction
  useEffect(() => {
    if (!TX_ID) { setLoadError('No transaction ID in URL'); return }
    fetchTx(TX_ID)
      .then(data => {
        setTx(data)
        if (data.status === 'sent') {
          setDone(true)
          setStatus({
            type: 'success',
            text: 'Already sent.',
            txHash: data.txHash,
            explorerUrl: explorerTxUrl(data.chainId, data.txHash ?? ''),
          })
        }
      })
      .catch(err => setLoadError((err as Error).message))
  }, [])

  function handleConnected(address: string, type: 'injected' | 'walletconnect', provider?: InjectedProvider) {
    setWalletMode(type)
    setInjectedProvider(provider ?? null)
    setWalletAddress(address)
    setStatus(null)
  }

  function handleGenerate(wallet: HDNodeWallet) {
    setWalletMode('generated')
    setGeneratedWallet(wallet)
    setWalletAddress(wallet.address)
    setStatus(null)
  }

  async function handleSend() {
    if (!tx || !walletAddress) return
    setSending(true)
    setStatus({ type: 'info', text: 'Waiting for wallet confirmation…' })
    await reportStatus(TX_ID, 'signing')

    try {
      const txHash = await sendTx()
      await reportStatus(TX_ID, 'sent', txHash)
      setDone(true)
      setStatus({
        type: 'success',
        text: 'Transaction sent!',
        txHash,
        explorerUrl: explorerTxUrl(tx.chainId, txHash),
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      await reportStatus(TX_ID, 'failed', undefined, msg)
      setStatus({ type: 'error', text: msg })
      setSending(false)
    }
  }

  async function sendTx(): Promise<string> {
    if (!tx) throw new Error('No transaction loaded')

    const params = {
      data: tx.data,
      value: tx.value ?? '0x0',
      ...(tx.to ? { to: tx.to } : {}),
      ...(tx.gasLimit ? { gasLimit: tx.gasLimit } : {}),
    }

    // --- Generated wallet ---
    if (walletMode === 'generated' && generatedWallet) {
      const rpcUrl = PUBLIC_RPCS[tx.chainId ?? 0]
      if (!rpcUrl) throw new Error(`No public RPC for chain #${tx.chainId}. Use a different wallet.`)
      const provider = new JsonRpcProvider(rpcUrl)
      const connected = generatedWallet.connect(provider)
      const response = await connected.sendTransaction({
        ...params,
        value: BigInt(tx.value ?? '0'),
      })
      return response.hash
    }

    // --- WalletConnect (AppKit) ---
    if (walletMode === 'walletconnect' && walletProvider && modal) {
      if (tx.chainId) {
        try { await modal.switchNetwork({ id: tx.chainId } as Parameters<typeof modal.switchNetwork>[0]) }
        catch { /* wallet may handle chain switch itself */ }
      }
      const provider = new BrowserProvider(walletProvider as Eip1193Provider)
      const signer = await provider.getSigner()
      const response = await signer.sendTransaction(params)
      return response.hash
    }

    // --- Injected browser wallet (the one the user picked) ---
    if (!injectedProvider) throw new Error('No wallet available')
    const eth = injectedProvider
    if (tx.chainId) {
      try {
        await eth.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x' + tx.chainId.toString(16) }],
        })
      } catch { /* ignore */ }
    }
    const hash = await eth.request({
      method: 'eth_sendTransaction',
      params: [{ from: walletAddress, ...params }],
    })
    return hash as string
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loadError) {
    return (
      <div className="card">
        <div className="logo">⚠️</div>
        <p className="error-text">{loadError}</p>
      </div>
    )
  }

  if (!tx) {
    return (
      <div className="card">
        <div className="logo">🔏</div>
        <p className="loading-text">Loading transaction…</p>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="logo">🔏</div>
      <h1>Sign &amp; Send Transaction</h1>
      <p className="subtitle">{tx.description ?? 'Review and sign the transaction below'}</p>

      <TxFields tx={tx} />

      {walletAddress && (
        <div className="wallet-chip">
          <span className={`dot ${walletMode === 'generated' ? 'dot-amber' : 'dot-green'}`} />
          {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}
          {walletMode === 'generated' && <span className="chip-badge">generated</span>}
        </div>
      )}

      {walletMode === 'walletconnect' && modal && !done && (
        <button className="wallet-btn" onClick={() => modal?.open()}>
          <span className="wallet-icon">🔗</span>
          <div>
            <div className="wallet-btn-title">WalletConnect</div>
            <div className="wallet-btn-sub">Switch account or disconnect</div>
          </div>
        </button>
      )}

      {!walletAddress && !done && (
        <WalletOptions
          wallets={browserWallets}
          walletsSettled={walletsSettled}
          onConnected={handleConnected}
          onGenerate={handleGenerate}
          onError={msg => setStatus({ type: 'error', text: msg })}
        />
      )}

      {walletMode === 'generated' && generatedWallet && (
        <GeneratedAccount wallet={generatedWallet} chainId={tx.chainId} onReplace={handleGenerate} />
      )}

      {walletAddress && !done && (
        <button
          className="btn-primary"
          onClick={handleSend}
          disabled={sending}
        >
          {sending ? <><span className="spinner" /> Waiting for wallet…</> : 'Sign & Send'}
        </button>
      )}

      <Status status={status} />
    </div>
  )
}
