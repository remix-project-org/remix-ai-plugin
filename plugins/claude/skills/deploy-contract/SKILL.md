---
name: deploy-contract
description: Deploy a Solidity smart contract to an EVM chain. Use when the user wants to deploy, publish, or launch a contract, or when they share Solidity source code and ask to put it on-chain.
---

## Deploy a Solidity Contract

1. If the user hasn't provided source code, ask for it. If they haven't specified a chain, default to Sepolia (chain ID 11155111).

2. Call `compile_solidity` with the source code. Use the filename the user provided, or `Contract.sol` if none. If compilation returns errors, show them and stop.

3. From the compilation result, extract the bytecode (`evm.bytecode.object`) for the target contract. If there are multiple contracts, ask the user which one to deploy.

4. If the constructor takes arguments, ask the user for any values they haven't given. Then call `encode_call` with the contract's `abi`, its `bytecode` and the constructor `args`. Never hand-encode hex.

5. Call `transact` with:
   - `data`: the `data` returned by `encode_call`
   - `chainId`: the target chain ID
   - `description`: a short label like "Deploy MyToken.sol"
   - No `to` field (deployment)

6. Show the returned `signUrl` to the user as a clickable link and tell them to open it to sign with their wallet. (If the client renders the inline transaction card, it tracks progress live too.)

7. Call `check_transaction` with `waitSeconds: 20`, repeating until status is `sent` with a receipt, or `failed`. If `walletsDetected` is an empty list, tell the user no browser wallet was found and suggest MetaMask or WalletConnect.

8. When done:
   - **sent**: Report the transaction hash (`explorerUrl`) and the deployed contract address (`contractAddress`).
   - **failed**: Report the error message.
