---
name: call-contract
description: Send a transaction to call a function on an already-deployed smart contract. Use when the user wants to interact with, invoke, or execute a function on an existing contract address.
---

## Call a Contract Function

1. Gather what's needed if not already provided:
   - Contract address (`to`)
   - ABI (or just the function signature)
   - Function name and arguments
   - Chain ID (default to Sepolia, chain ID 11155111, if unspecified)
   - ETH value to send, if payable (default 0)

2. Encode the calldata using the ABI and the function arguments. Show the user the encoded calldata before proceeding.

3. Call `transact` with:
   - `to`: the contract address
   - `data`: the ABI-encoded calldata
   - `value`: ETH in hex wei if the function is payable, otherwise omit
   - `chainId`: the target chain ID
   - `description`: e.g. "Call transfer() on 0x1234…"

4. Show the returned `signUrl` to the user as a clickable link and tell them to open it to sign with their wallet.

5. Immediately start polling with `check_transaction` every 3–5 seconds until status is `sent` or `failed`.

6. When done:
   - **sent**: Report the transaction hash and link to the block explorer.
   - **failed**: Report the error message.
