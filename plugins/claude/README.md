# Remix Solidity (full)

Remix Solidity gives Claude Solidity tooling inside the conversation. It compiles contracts with the Remix compiler, encodes contract calls, reads the state of deployed contracts, simulates deployments and function calls, and prepares transactions for you to sign. A simulation reports whether the transaction would succeed, the gas estimate, the decoded return value or revert reason, and a plain-language review of what the transaction does.

**You sign every transaction yourself.** The `transact` tool returns a link to a signing page where you review the transaction and sign it with your own browser wallet. The server never asks for or holds private keys, seed phrases or funds, and it does not broadcast anything on your behalf. A signed transaction is public on the blockchain and cannot be undone.

## Tools

| Tool | What it does |
|---|---|
| `compile_solidity` | Compiles Solidity source files with the Remix compiler and returns the ABI, bytecode, errors and warnings. |
| `encode_call` | ABI-encodes a function call or a contract deployment so you can inspect the calldata. Runs on the server only; no chain access. |
| `read_contract` | Calls a `view` or `pure` function on a deployed contract (`eth_call`) and returns the decoded result. |
| `simulate` | Dry-runs a deployment or a function call against the chain's latest state and reports success or the revert reason, gas, decoded output and a clear-signing review. Nothing is signed or sent. |
| `transact` | Prepares a deployment or a state-changing call and returns a signing link. Marked as destructive, because a signed transaction cannot be undone. |
| `check_transaction` | Reports the status of a prepared transaction: pending, signing, sent, confirmed, reverted or rejected, with block-explorer links. |

`compile_solidity`, `encode_call`, `read_contract`, `simulate` and `check_transaction` are read-only. The plugin also includes two skills, **deploy-contract** and **call-contract**, that guide Claude through compiling and deploying a contract, or reading from and sending a call to an existing one.

Supported chains: Ethereum (1), Sepolia (11155111), Polygon (137), Base (8453), Base Sepolia (84532), Arbitrum One (42161) and Optimism (10). Sepolia is used when you don't name a chain.

## Example prompts

- "Compile this contract and deploy it to Sepolia" (paste your Solidity source)
- "Simulate `transfer(0x…, 1000)` on this contract on Base from this address and tell me if it would revert"
- "What is the `totalSupply` of the USDC contract at 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 on Ethereum mainnet?"
- "What would approving unlimited USDC to this spender do? Simulate it and show the warnings"

## What is sent where

When Claude calls a tool, the plugin sends the tool's inputs to the Remix Solidity server at `https://ai-plugin-dev.remixlabs.dev/mcp`. Depending on the tool, these inputs can include:

- Solidity source code and compiler settings
- contract ABIs, function names and arguments
- contract and caller addresses, call data, ETH amounts and chain IDs
- for `transact`: the destination, call data, amount, chain and an optional description of the transaction to sign

When you open the signing page, the server also receives the names of the browser wallets it detects, the status of each signing attempt and, if you send the transaction, its transaction hash.

To answer the request, the server passes some of this on to third parties:

| Service | What it receives |
|---|---|
| Public blockchain RPC nodes for the chosen chain | Contract and caller addresses, call data, values and the chain ID, for reads and simulations, plus ENS name lookups |
| Sourcify (sourcify.dev) | Contract address and chain ID, to fetch verified source code and ABIs for the review |
| ERC-7730 clear-signing registry (raw.githubusercontent.com) | Requests for the registry index and the descriptor files of the contracts involved |
| npm CDN (unpkg.com or jsDelivr) and GitHub | The path of an imported Solidity file (for example an OpenZeppelin contract) that is not included in your request |

If you connect a wallet with WalletConnect on the signing page, your browser communicates with WalletConnect (Reown) services under their own privacy policy.

The server does not store request data in a database or on disk. Prepared transactions are kept in memory for one hour. Other short-lived in-memory caches (fetched import files, recent encoded calls, and public contract metadata for up to 6 hours) are cleared when it restarts. Server-side usage analytics record only the tool name, client name, outcome and chain ID, never source code, addresses, call data or amounts.

No account or sign-in is needed, and the server does not require authentication.

## Privacy policy

<https://ai-plugin-dev.remixlabs.dev/privacy>

## Support

support@remixlabs.live · https://github.com/remix-project-org/remix-ai-plugin/issues

## License

MIT. See [LICENSE](LICENSE).
