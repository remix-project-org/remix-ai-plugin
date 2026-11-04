# remix-ai-plugin

Remix Solidity tooling for **Claude** and **ChatGPT** from a single server. Compile contracts, read on-chain state, and sign and broadcast transactions through a browser wallet — all from a conversation.

## Tools

| Tool | Description |
|---|---|
| `compile_solidity` | Compile Solidity files with the Remix compiler. Imports like `@openzeppelin/contracts/...` are fetched automatically. |
| `encode_call` | ABI-encode a function call, or a deployment with constructor arguments. |
| `read_contract` | Call a view/pure function on a deployed contract — no wallet needed. |
| `transact` | Save a transaction and return a `signUrl` the user opens to sign. Clients with MCP Apps support also show an inline card that tracks it live. |
| `check_transaction` | Transaction status (`pending` → `signing` → `sent` / `failed`), detected browser wallets, explorer links. Supports long-polling via `waitSeconds`. |

## Layout

```
src/              server: MCP (/mcp), REST actions (/actions/*), OpenAPI spec, signing page
sign-app/         React wallet-signing app (built into sign-dist/)
widget/           in-chat transaction card (MCP Apps), bundled into widget-dist/
plugins/claude/   Claude plugin: manifest, .mcp.json, skills
plugins/openai/   Custom GPT instructions and conversation starters
```

## Setup

Requires Node.js 20+.

```bash
npm install
cp .env.example .env   # fill in the values below
```

| Variable | Description |
|---|---|
| `WALLETCONNECT_PROJECT_ID` | Needed for the signing page |
| `BASE_URL` | Public URL of the server (used in sign links and the OpenAPI spec) |
| `PORT` | Default `3000` |
| `PLUGIN_AUTH_TOKEN` | Optional bearer token for `/mcp` and `/actions/*` |

## Run

```bash
# development (two terminals)
npm run dev:server
npm run dev:sign

# production
npm run build
npm start
```

To expose a local server: `ngrok http 3000`, then set `BASE_URL` to the ngrok URL.

## Connect

**Claude** — point `plugins/claude/.mcp.json` at `https://<your-host>/mcp`, then either install `plugins/claude` as a Claude Code plugin or run `npm run package:claude` to build `remix-solidity-plugin.zip` for upload. For a Claude connector, add `https://<your-host>/mcp` as a custom connector.

**ChatGPT connector** — in developer mode, add `https://<your-host>/mcp` as an MCP connector.

**Custom GPT** — import `https://<your-host>/openapi.json` as an Action and paste `plugins/openai/gpt/instructions.md` into the GPT's instructions. See `plugins/openai/gpt/README-setup.md`.
