---
name: call-contract
description: Read from or send a transaction to an already-deployed smart contract. Use when the user wants to query, interact with, invoke, or execute a function on an existing contract address.
---

## Call a Contract Function

1. Gather what's needed if not already provided:
   - Contract address (`to`)
   - ABI (or just the function signature)
   - Function name and arguments
   - Chain ID (default to Sepolia, chain ID 11155111, if unspecified)
   - ETH value to send, if payable (default 0)

2. If the function is `view` or `pure`, call `read_contract` and report the result — no transaction or wallet needed. Stop here.

3. Otherwise call `encode_call` with the ABI, function name and arguments. Never hand-encode hex.

4. Call `transact` with:
   - `to`: the contract address
   - `data`: the `data` returned by `encode_call`
   - `value`: ETH in hex wei if the function is payable, otherwise omit
   - `chainId`: the target chain ID
   - `abi`: the ABI, so the signing page shows the decoded call
   - `description`: e.g. "Call transfer() on 0x1234…"

5. Show the returned `signUrl` to the user as a clickable link and tell them to open it to sign with their wallet.

6. Call `check_transaction` with `waitSeconds: 20`, repeating until status is `confirmed`, `reverted` or `rejected`. If `walletsDetected` is an empty list, suggest installing MetaMask or using WalletConnect.

7. When done:
   - **confirmed**: Report the transaction hash and its `explorerUrl`.
   - **reverted**: Report that the call was mined but reverted, with the `explorerUrl`.
   - **rejected**: Report `errorMessage` and tell the user they can retry on the same signing page.
