---
name: deploy-contract
description: Deploy a Solidity smart contract to an EVM chain. Use when the user wants to deploy, publish, or launch a contract, or when they share Solidity source code and ask to put it on-chain.
---

## Deploy a Solidity Contract

1. If the user hasn't provided source code, ask for it. If they haven't specified a chain, default to Sepolia (chain ID 11155111).

2. Call `compile_solidity` with the source code. Use the filename the user provided, or `Contract.sol` if none. If compilation returns errors, show them and stop.

3. From the compilation result, extract the bytecode (`evm.bytecode.object`) for the target contract. If there are multiple contracts, ask the user which one to deploy.

4. Call `transact` with:
   - `data`: the bytecode (prefix with `0x` if not already)
   - `chainId`: the target chain ID
   - `description`: a short label like "Deploy MyToken.sol"
   - No `to` field (deployment)

5. Show the returned `signUrl` to the user as a clickable link and tell them to open it to sign with their wallet.

6. Immediately start polling with `check_transaction` every 3–5 seconds. Keep polling until status is `sent` or `failed`.

7. When done:
   - **sent**: Report the transaction hash and, once the receipt is available, the deployed contract address (found in `receipt.contractAddress`).
   - **failed**: Report the error message.
