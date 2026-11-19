---
name: simulate-call
description: Read from, or dry-run a function call on, an already-deployed smart contract. Use when the user wants to query, interact with, invoke, or execute a function on an existing contract address, or asks what a call would do. This connector cannot sign or send transactions — nothing is ever sent to the chain.
---

## Simulate a Contract Function Call

1. Gather what's needed if not already provided:
   - Contract address (`to`)
   - ABI (or just the function signature)
   - Function name and arguments
   - Chain ID (default to Sepolia, chain ID 11155111, if unspecified)
   - The caller's address (`from`), if the result depends on who calls
   - ETH value to send, if payable (default 0)

2. If the function is `view` or `pure`, call `read_contract` and report the result. Stop here.

3. Otherwise call `simulate` with:
   - `to`: the contract address
   - `abi`: the ABI
   - `functionName` and `args`
   - `chainId`: the target chain ID
   - `from`: the caller's address, if known — without it the zero address is used, so balance and permission checks may fail for the wrong reason
   - `value`: ETH in hex or decimal wei if the function is payable, otherwise omit

   The server encodes everything. Never hand-encode hex.

4. Report the result:
   - **success**: say the call would succeed, with the decoded return value (`returns`), the `gasEstimate`, the review `intent` and any warning (for example an unlimited token approval).
   - **failure**: show the `revert` reason (or decoded custom error) and suggest what to check, such as arguments, `value`, allowances, or the `from` address.

5. Be explicit that this was a simulation: nothing was signed or sent, and the real outcome can differ if chain state changes. This connector cannot send transactions — if the user wants to execute the call, they must use their own wallet. Never ask for a private key or seed phrase.
