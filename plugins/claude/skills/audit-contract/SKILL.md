---
name: audit-contract
description: Run a security audit of a Solidity smart contract. Use when the user wants to audit, review for vulnerabilities, or check the security of a contract.
---

## Audit a Solidity Contract

1. If the user hasn't provided source code, ask for it. Use the filename they provided, or `Contract.sol` if none.

2. Call `compile_solidity` with the source. If compilation returns errors, show them and stop — do not audit code that doesn't compile.

3. Call `get_audit_checklist` with the sources. Pass `model` if the user asked for a specific quality tier (`Fast`, `Balanced` (default) or `Deep`).

4. Call `do_audit` with the same sources and the `markdown` field from the checklist as `checklist`, using the same `model`.

5. Present the report, leading with CRITICAL and HIGH findings. For each finding include location, impact and the recommended fix.
