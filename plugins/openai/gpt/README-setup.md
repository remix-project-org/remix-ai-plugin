<!-- Operator setup notes, not end-user documentation. -->

Two ways to use this server from ChatGPT. Both expose the same five capabilities.

## A. MCP connector (ChatGPT developer mode / Apps SDK)

Settings → Connectors → Create. Point it at:

    <BASE_URL>/mcp

Transport: Streamable HTTP. Auth: none, or Bearer if `PLUGIN_AUTH_TOKEN` is set.
Tools exposed: compile_solidity, transact, check_transaction, get_audit_checklist, do_audit.
Prompts exposed: deploy-contract, call-contract, audit-contract.

## B. Custom GPT Action

In the GPT editor → Actions → Create new action → Import from URL:

    <BASE_URL>/openapi.json

Then paste `instructions.md` into the GPT's Instructions box and
`conversation-starters.txt` into the starters. Authentication: None, or
API Key → Bearer when `PLUGIN_AUTH_TOKEN` is set.

The plugin manifest is served at `<BASE_URL>/.well-known/ai-plugin.json`.

`BASE_URL` must be publicly reachable — ChatGPT calls it directly, and it is
also the origin of the sign URLs the user opens in their wallet.
