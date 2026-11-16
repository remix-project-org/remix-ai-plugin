// Keyless public endpoints, used unless RPC_URL_<chainId> is set (e.g. RPC_URL_11155111
// for a keyed provider). Keep provider keys in the environment, never in source.
const DEFAULT_RPCS: Record<number, string> = {
  1:        'https://ethereum-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  137:      'https://polygon-bor-rpc.publicnode.com',
  8453:     'https://mainnet.base.org',
  84532:    'https://sepolia.base.org',
  42161:    'https://arb1.arbitrum.io/rpc',
  10:       'https://mainnet.optimism.io',
}

export const PUBLIC_RPCS: Record<number, string> = Object.fromEntries(
  Object.entries(DEFAULT_RPCS).map(([chainId, url]) => [chainId, process.env[`RPC_URL_${chainId}`]?.trim() || url])
)

const EXPLORERS: Record<number, string> = {
  1:        'https://etherscan.io',
  11155111: 'https://sepolia.etherscan.io',
  137:      'https://polygonscan.com',
  8453:     'https://basescan.org',
  84532:    'https://sepolia.basescan.org',
  42161:    'https://arbiscan.io',
  10:       'https://optimistic.etherscan.io',
}

export function explorerUrl(chainId: number | undefined, kind: 'tx' | 'address', value: string): string | undefined {
  const base = chainId ? EXPLORERS[chainId] : undefined
  return base ? `${base}/${kind}/${value}` : undefined
}
