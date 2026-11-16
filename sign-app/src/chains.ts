import {
  mainnet, sepolia, polygon, base, baseSepolia, arbitrum, optimism,
} from '@reown/appkit/networks'
import type { AppKitNetwork } from '@reown/appkit/networks'

export const SUPPORTED_NETWORKS: [AppKitNetwork, ...AppKitNetwork[]] = [
  mainnet, sepolia, polygon, base, baseSepolia, arbitrum, optimism,
]

// Keyless public endpoints only: anything shipped to the browser is public.
export const PUBLIC_RPCS: Record<number, string> = {
  1:        'https://ethereum-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  137:      'https://polygon-bor-rpc.publicnode.com',
  8453:     'https://mainnet.base.org',
  84532:    'https://sepolia.base.org',
  42161:    'https://arb1.arbitrum.io/rpc',
  10:       'https://mainnet.optimism.io',
}

export const EXPLORERS: Record<number, string> = {
  1:        'https://etherscan.io/tx/',
  11155111: 'https://sepolia.etherscan.io/tx/',
  137:      'https://polygonscan.com/tx/',
  8453:     'https://basescan.org/tx/',
  84532:    'https://sepolia.basescan.org/tx/',
  42161:    'https://arbiscan.io/tx/',
  10:       'https://optimistic.etherscan.io/tx/',
}

export const ADDRESS_EXPLORERS: Record<number, string> = {
  1:        'https://etherscan.io/address/',
  11155111: 'https://sepolia.etherscan.io/address/',
  137:      'https://polygonscan.com/address/',
  8453:     'https://basescan.org/address/',
  84532:    'https://sepolia.basescan.org/address/',
  42161:    'https://arbiscan.io/address/',
  10:       'https://optimistic.etherscan.io/address/',
}

export function explorerTxUrl(chainId: number | undefined, hash: string): string | undefined {
  if (!chainId) return undefined
  const base = EXPLORERS[chainId]
  return base ? base + hash : undefined
}

/** Networks where transactions spend test ETH only. */
const TESTNETS = new Set([11155111, 84532])

export const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum mainnet', 11155111: 'Sepolia', 137: 'Polygon', 8453: 'Base',
  84532: 'Base Sepolia', 42161: 'Arbitrum One', 10: 'Optimism',
}

export function isTestnet(chainId: number | undefined): boolean {
  return chainId !== undefined && TESTNETS.has(chainId)
}
