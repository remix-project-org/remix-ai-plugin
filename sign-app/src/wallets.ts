import { useEffect, useMemo, useState } from 'react'

// Browser wallet discovery via EIP-6963 (multi-wallet standard), with a
// window.ethereum fallback for wallets that don't announce themselves.

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on?: (event: string, cb: (...args: any[]) => void) => void
  removeListener?: (event: string, cb: (...args: any[]) => void) => void
}

export interface BrowserWallet {
  uuid: string
  name: string
  icon?: string
  rdns?: string
  provider: Eip1193Provider
}

interface Eip6963AnnounceEvent extends Event {
  detail: {
    info: { uuid: string; name: string; icon: string; rdns: string }
    provider: Eip1193Provider
  }
}

/** How long to wait for wallets to announce before treating the list as settled. */
const DISCOVERY_MS = 600

function legacyWallet(): BrowserWallet | null {
  const eth = (window as { ethereum?: Eip1193Provider & Record<string, unknown> }).ethereum
  if (!eth) return null
  const name =
    eth.isRabby ? 'Rabby' :
    eth.isCoinbaseWallet ? 'Coinbase Wallet' :
    eth.isBraveWallet ? 'Brave Wallet' :
    eth.isMetaMask ? 'MetaMask' :
    'Browser wallet'
  return { uuid: 'legacy-window-ethereum', name, provider: eth }
}

/**
 * Returns the browser wallets installed in this browser. `settled` turns true once
 * the discovery window has elapsed, so an empty list then means "no wallet installed".
 */
export function useBrowserWallets(): { wallets: BrowserWallet[]; settled: boolean } {
  const [announced, setAnnounced] = useState<BrowserWallet[]>([])
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    function onAnnounce(event: Event) {
      const { info, provider } = (event as Eip6963AnnounceEvent).detail
      setAnnounced(prev =>
        prev.some(w => w.uuid === info.uuid)
          ? prev
          : [...prev, { uuid: info.uuid, name: info.name, icon: info.icon, rdns: info.rdns, provider }],
      )
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    const timer = setTimeout(() => setSettled(true), DISCOVERY_MS)
    return () => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce)
      clearTimeout(timer)
    }
  }, [])

  const wallets = useMemo(() => {
    if (announced.length > 0 || !settled) return announced
    const legacy = legacyWallet()
    return legacy ? [legacy] : []
  }, [announced, settled])

  return { wallets, settled }
}
