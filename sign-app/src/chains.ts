import {
  mainnet, sepolia, polygon, base, baseSepolia, arbitrum, optimism,
} from '@reown/appkit/networks'
import type { AppKitNetwork } from '@reown/appkit/networks'

export const SUPPORTED_NETWORKS: [AppKitNetwork, ...AppKitNetwork[]] = [
  mainnet, sepolia, polygon, base, baseSepolia, arbitrum, optimism,
]

export const PUBLIC_RPCS: Record<number, string> = {
  1:        'https://shared.eu-central-1.getblock.io/3b015fe911af48aca45cf963c56bc033',
  11155111: 'https://shared.eu-central-1.getblock.io/7fbe62b139884d2c9c1616ca0de8b5b2',
  137:      'https://shared.us-east-1.getblock.io/b731158b1223495db0636acfb88118fe',
  8453:     'https://shared.us-east-1.getblock.io/068d7fb21aee4563b23464349e44d80e',
  84532:    'https://shared.eu-central-1.getblock.io/8cb02ef20a9641548d5d1f6d73832dd4',
  42161:    'https://shared.eu-central-1.getblock.io/d8fb0ccf25a646edaaf777d8abb10a62',
  10:       'https://shared.eu-central-1.getblock.io/7ab36af4c9c346bbabab70e9c54d9c6c',
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
