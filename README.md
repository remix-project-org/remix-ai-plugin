# remix-ai-plugin

Remix Solidity tooling for **Claude** and **ChatGPT** from a single server. Compile contracts, read on-chain state, simulate transactions, and — in the full build — sign and broadcast them through a browser wallet, all from a conversation. The server never holds private keys or funds.

## Tools

| Tool | Build | Description |
|---|---|---|
| `compile_solidity` | both | Compile Solidity files with the Remix compiler. Imports like `@openzeppelin/contracts/...` are fetched automatically. |
| `encode_call` | both | ABI-encode a function call, or a deployment with constructor arguments. |
| `read_contract` | both | Call a view/pure function on a deployed contract — no wallet needed. |
| `simulate` | both | Dry-run a deployment or call (`eth_call` + gas estimate) and return the decoded result or revert reason plus a clear-signing review. Nothing is signed or sent. |
| `transact` | full | Save a transaction and return a `signUrl` the user opens to sign. Clients with MCP Apps support also show an inline card that tracks it live. |
| `check_transaction` | full | Transaction status (`pending` → `signing` → `sent` → `confirmed` / `reverted`, or `rejected`), detected browser wallets, explorer links. Supports long-polling via `waitSeconds`. |

Every tool sets a title and explicit `readOnlyHint`, `destructiveHint` and `openWorldHint` annotations. `transact` is marked destructive because a signed transaction cannot be undone.

## Builds

One codebase, two builds, chosen by `ENABLE_TRANSACT`:

- **Full** (default): all tools above, the signing page (`/sign/:id`), its API (`/api/*`) and the inline card.
- **Simulate-only** (`ENABLE_TRANSACT=false`): only `compile_solidity`, `encode_call`, `read_contract` and `simulate`. `transact`, `check_transaction`, `/actions/transact`, `/actions/check-transaction`, the signing page and its API are not exposed, and the prompts, OpenAPI spec and plugin manifest no longer mention signing. `/health` reports `"mode": "simulate-only"`.

Deploy the simulate-only build on its own URL, without `PLUGIN_AUTH_TOKEN`, if you want to submit it to a connector directory (see below).

## Layout

```
src/              server: MCP (/mcp), REST actions (/actions/*), OpenAPI spec, signing page
sign-app/         React wallet-signing app (built into sign-dist/)
widget/           in-chat transaction card (MCP Apps), bundled into widget-dist/
plugins/claude/   Claude plugin: manifest, .mcp.json, skills
plugins/openai/   Custom GPT instructions and conversation starters
```

## Setup

Requires Node.js 22+.

```bash
npm install
cp .env.example .env   # fill in the values below
```

| Variable | Description |
|---|---|
| `WALLETCONNECT_PROJECT_ID` | Needed for the signing page (full build) |
| `BASE_URL` | Public URL of the server (used in sign links and the OpenAPI spec) |
| `PORT` | Default `3000` |
| `ENABLE_TRANSACT` | Set to `false` for the simulate-only build. Default `true`. |
| `PLUGIN_AUTH_TOKEN` | Optional static bearer token for `/mcp` and `/actions/*`. Leave unset for a public listing; directories expect OAuth 2.0 if a server needs authentication, which this token is not. |
| `RATE_LIMIT_PER_MINUTE` | Optional per-IP request limit for `/mcp` and `/actions/*`. Off when unset. |
| `TRUST_PROXY` | `true` to read the client IP from `X-Forwarded-For`. Only behind a proxy that overwrites that header. |
| `RPC_URL_<chainId>` | Optional server-side RPC endpoint per chain (1, 11155111, 137, 8453, 84532, 42161, 10). Keyless public endpoints are used otherwise. Keep provider keys here, never in source. |
| `CONTACT_EMAIL` / `LEGAL_URL` | Contact and legal links shown in the plugin manifest |
| `MATOMO_URL` / `MATOMO_SITE_ID` | Optional usage analytics, e.g. `https://matomo.remix.live/matomo/matomo.php`. Off when unset. |

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

## Data handling and analytics

- Request data (source code, ABIs, addresses, call data, amounts) is processed in memory to answer the request and is not written to disk or a database. A few in-memory caches (import files, recent encodings, clear-signing lookups) are dropped on restart. Pending transactions in the full build are kept for one hour.
- To answer requests the server contacts the configured RPC nodes, Sourcify, the ERC-7730 clear-signing registry on GitHub, and an npm CDN or GitHub for imports.
- When Matomo is configured, the server sends one server-side event per MCP request: the request type (tool, prompt, resource or protocol method name), the client name as it identifies itself (`rest:<product>` for REST callers), success, error or cancelled, the chain ID, and a hashed session identifier. It never sends source code, ABIs, addresses, call data, amounts, error messages or conversation content.
- Requests rejected by the rate limiter are counted as `rate_limit` events. The server writes no request logs of its own.
- The privacy policy is served at `/privacy` (source: `assets/privacy.html`). Both directories require a published privacy policy; review the text before submitting.

## Directory listings

Connector directories review submissions against their own policies, and those restrict crypto software:

- **Anthropic** does not generally allow cryptocurrency software in its directory unless it is permitted in writing, and bans software that moves money without human-in-the-loop safeguards. It also requires OAuth 2.0 for authenticated servers, tool annotations, a privacy policy and example prompts.
- **OpenAI** prohibits executing money transfers, crypto transfers or investment trades, and requires explicit annotations and a privacy policy.

The simulate-only build exists so a listing can avoid the transaction-executing tools. It does not by itself settle Anthropic's cryptocurrency-software rule, so ask Anthropic for written confirmation before submitting. Self-distribution (custom connectors, the Claude Code plugin, the MCP Registry) does not go through directory review.
