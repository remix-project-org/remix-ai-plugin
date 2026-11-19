# Remix Solidity

Remix Solidity gives Claude Solidity tooling inside the conversation. It compiles contracts with the Remix compiler, encodes contract calls, reads the state of deployed contracts, and simulates deployments and function calls on EVM chains. A simulation reports whether the transaction would succeed, the gas estimate, the decoded return value or revert reason, and a plain-language review of what the transaction does.

**Nothing is signed or sent.** The plugin connects to a simulate-only server. It has no tool that signs, sends or broadcasts a transaction, it never asks for or holds private keys, seed phrases or funds, and nothing is ever written on-chain. To deploy or call a contract for real, use your own wallet or deployment tooling.

## Tools

| Tool | What it does |
|---|---|
| `compile_solidity` | Compiles Solidity source files with the Remix compiler and returns the ABI, bytecode, errors and warnings. |
| `encode_call` | ABI-encodes a function call or a contract deployment so you can inspect the calldata. Runs on the server only; no chain access. |
| `read_contract` | Calls a `view` or `pure` function on a deployed contract (`eth_call`) and returns the decoded result. |
| `simulate` | Dry-runs a deployment or a function call against the chain's latest state and reports success or the revert reason, gas, decoded output and a clear-signing review. |

All four tools are read-only. The plugin also includes two skills, **simulate-deployment** and **simulate-call**, that guide Claude through compiling and simulating a deployment, or reading from and simulating a call on an existing contract.

Supported chains: Ethereum (1), Sepolia (11155111), Polygon (137), Base (8453), Base Sepolia (84532), Arbitrum One (42161) and Optimism (10). Sepolia is used when you don't name a chain.

## Example prompts

- "Compile this contract and simulate deploying it to Sepolia" (paste your Solidity source)
- "Read the current state of a deployed contract", for example: "What is the `totalSupply` of the USDC contract at 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 on Ethereum mainnet?"
- "Simulate a function call on a contract I already deployed"
- "What does this contract's ABI look like?"

## What is sent where

When Claude calls a tool, the plugin sends the tool's inputs to the Remix Solidity server at `https://ai-plugin.remixlabs.dev/mcp`. Depending on the tool, these inputs can include:

- Solidity source code and compiler settings
- contract ABIs, function names and arguments
- contract and caller addresses, call data, ETH amounts and chain IDs

To answer the request, the server passes some of this on to third parties:

| Service | What it receives |
|---|---|
| Public blockchain RPC nodes for the chosen chain | Contract and caller addresses, call data, values and the chain ID, for reads and simulations, plus ENS name lookups |
| Sourcify (sourcify.dev) | Contract address and chain ID, to fetch verified source code and ABIs for the review |
| ERC-7730 clear-signing registry (raw.githubusercontent.com) | Requests for the registry index and the descriptor files of the contracts involved |
| npm CDN (unpkg.com or jsDelivr) and GitHub | The path of an imported Solidity file (for example an OpenZeppelin contract) that is not included in your request |

The server does not store request data in a database or on disk. It keeps short-lived in-memory caches (fetched import files, recent encoded calls, and public contract metadata for up to 6 hours), which are cleared when it restarts. Server-side usage analytics record only the tool name, client name, outcome and chain ID, never source code, addresses, call data or amounts.

No account or sign-in is needed, and the server does not require authentication.

## Privacy policy

<https://ai-plugin.remixlabs.dev/privacy>

## Support

support@remixlabs.live · https://github.com/remix-project-org/remix-ai-plugin/issues

## License

MIT. See [LICENSE](LICENSE).
