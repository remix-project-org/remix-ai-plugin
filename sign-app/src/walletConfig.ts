import { createAppKit } from '@reown/appkit/react'
import { EthersAdapter } from '@reown/appkit-adapter-ethers'
import { SUPPORTED_NETWORKS } from './chains'

// In production the server injects window.__CONFIG__ into index.html.
// In dev (Vite), fall back to VITE_WC_PROJECT_ID from .env.local.
declare global {
  interface Window {
    __CONFIG__?: { wcProjectId?: string }
  }
}

export const wcProjectId =
  window.__CONFIG__?.wcProjectId ??
  (import.meta.env.VITE_WC_PROJECT_ID as string | undefined)

export const ethersAdapter = new EthersAdapter()

// Only initialise AppKit when a project ID is available
export const modal = wcProjectId
  ? createAppKit({
      adapters: [ethersAdapter],
      networks: SUPPORTED_NETWORKS,
      projectId: wcProjectId,
      metadata: {
        name: 'Remix Sign',
        description: 'Sign your Ethereum transaction',
        url: window.location.origin,
        icons: [],
      },
      features: { analytics: false },
    })
  : null
