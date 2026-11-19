---
name: simulate-deployment
description: Compile a Solidity smart contract and dry-run its deployment on an EVM chain to see whether it would succeed and how much gas it needs. Use when the user wants to deploy, publish, or launch a contract, or when they share Solidity source code and ask to put it on-chain. This connector cannot sign or send transactions — nothing is ever deployed.
---

## Simulate a Solidity Contract Deployment

1. If the user hasn't provided source code, ask for it. If they haven't specified a chain, default to Sepolia (chain ID 11155111) and say so.

2. Call `compile_solidity` with the source code. Use the filename the user provided, or `Contract.sol` if none. If compilation returns errors, show them and stop.

3. From the compilation result, extract the bytecode (`evm.bytecode.object`) for the target contract. If there are multiple contracts, ask the user which one to simulate.

4. If the constructor takes arguments, ask the user for any values they haven't given.

5. Call `simulate` with:
   - `abi`: the contract's ABI
   - `bytecode`: the creation bytecode
   - `args`: the constructor arguments, if any
   - `chainId`: the target chain ID
   - `from`: the user's address, if they gave one (otherwise the zero address is used)
   - No `to` field (deployment)

   The server encodes everything. Never hand-encode hex.

6. Report the result:
   - **success**: say the deployment would succeed, with the `gasEstimate` and the `deployedCodeBytes`. Mention the review `intent` and tell the user about any warning.
   - **failure**: show the `revert` reason (or decoded custom error) and suggest what to check, such as constructor arguments, `value` for a payable constructor, or the `from` address.

7. Be explicit that this was a simulation: nothing was signed, sent or deployed, and the real outcome can differ if chain state changes. This connector cannot deploy — if the user wants to deploy for real, they must use their own wallet or deployment tooling. Never ask for a private key or seed phrase.
