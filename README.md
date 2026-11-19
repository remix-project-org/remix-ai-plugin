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

Both builds serve `/privacy` (the privacy policy) and `/docs` (the documentation). Each page is one template in `assets/` (`privacy.html`, `docs.html`) with `<!--simulate-only-->`, `<!--full-only-->` and `<!--analytics-only-->` blocks; the server keeps only the blocks that apply, so the text always matches the build that serves it. Blocks must not be nested.

Deploy the simulate-only build on its own URL, without `PLUGIN_AUTH_TOKEN`, if you want to submit it to a connector directory (see below). The full build runs separately, for example on a dev URL.

## Layout

```
src/              server: MCP (/mcp), REST actions (/actions/*), OpenAPI spec, signing page
sign-app/         React wallet-signing app (built into sign-dist/)
widget/           in-chat transaction card (MCP Apps), bundled into widget-dist/
assets/           logo and the /privacy and /docs page templates
plugins/claude/            Claude plugin, full build (plugin remix-solidity-full)
plugins/claude-simulate/   Claude plugin, simulate-only build (plugin remix-solidity)
plugins/openai/gpt/            Custom GPT files, full build
plugins/openai/gpt-simulate/   Custom GPT files, simulate-only build
```

## Setup

Requires Node.js 22+.

```bash
npm install
cp .env.example .env   # fill in the values below
```

Each build can have its own env file, read by the `:full` and `:simulate` scripts below: `.env_main` for the full build (for example `PORT=4000` and `BASE_URL=https://ai-plugin-dev.remixlabs.dev`) and `.env_simulate` for the simulate-only build. Both are git-ignored. The scripts set `ENABLE_TRANSACT` themselves, so it does not need to be in the file.

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

Per build, using that build's env file:

```bash
npm run dev:full          # tsx, .env_main, transactions enabled
npm run dev:simulate      # tsx, .env_simulate, simulate-only
npm run build             # full build: signing app, widget and server
npm run build:simulate    # simulate-only build: server only (needs far less memory)
npm run start:full        # dist/, .env_main
npm run start:simulate    # dist/, .env_simulate
```

To expose a local server: `ngrok http 3000`, then set `BASE_URL` to the ngrok URL.

## Connect

**Claude** — each build has its own plugin. `plugins/claude/.mcp.json` points at the full build (`https://ai-plugin-dev.remixlabs.dev/mcp`) and `plugins/claude-simulate/.mcp.json` at the simulate-only build (`https://ai-plugin.remixlabs.dev/mcp`). Install either folder as a Claude Code plugin, or build an upload zip with the host taken from that build's env file:

```bash
npm run package:claude:full       # plugins/claude          → remix-solidity-plugin.zip
npm run package:claude:simulate   # plugins/claude-simulate → remix-solidity-simulate-plugin.zip
```

The two plugins have different names, so both can be installed together. For a Claude connector, add `https://<your-host>/mcp` as a custom connector.

**ChatGPT connector** — in developer mode, add `https://<your-host>/mcp` as an MCP connector.

**Custom GPT** — import `https://<your-host>/openapi.json` as an Action and paste `instructions.md` from `plugins/openai/gpt/` (full build) or `plugins/openai/gpt-simulate/` (simulate-only build) into the GPT's instructions. See `README-setup.md` in the same folder.

## Data handling and analytics

- Request data (source code, ABIs, addresses, call data, amounts) is processed in memory to answer the request and is not written to disk or a database. A few in-memory caches (import files, recent encodings, clear-signing lookups) are dropped on restart. Pending transactions in the full build are kept for one hour.
- To answer requests the server contacts the configured RPC nodes, Sourcify, the ERC-7730 clear-signing registry on GitHub, and an npm CDN or GitHub for imports.
- When Matomo is configured, the server sends one server-side event per MCP request: the request type (tool, prompt, resource or protocol method name), the client name as it identifies itself (`rest:<product>` for REST callers), success, error or cancelled, the chain ID, and a hashed session identifier. It never sends source code, ABIs, addresses, call data, amounts, error messages or conversation content.
- Requests rejected by the rate limiter are counted as `rate_limit` events. The server writes no request logs of its own.
- The web pages themselves (`/privacy` and `/docs`) carry a Matomo page-view snippet when `MATOMO_URL` and `MATOMO_SITE_ID` are set, built from the same settings. It sets Matomo cookies and sends the visitor's IP address and browser details to Matomo, which the privacy page discloses when analytics is on.
- The privacy policy is served at `/privacy` (source: `assets/privacy.html`) and the documentation at `/docs`. Both directories require a published privacy policy; review the text, including the effective date, before submitting.

## Directory listings

Connector directories review submissions against their own policies, and those restrict crypto software:

- **Anthropic** does not generally allow cryptocurrency software in its directory unless it is permitted in writing, and bans software that moves money without human-in-the-loop safeguards. It also requires OAuth 2.0 for authenticated servers, tool annotations, a privacy policy and example prompts.
- **OpenAI** prohibits executing money transfers, crypto transfers or investment trades, and requires explicit annotations and a privacy policy.

The simulate-only build exists so a listing can avoid the transaction-executing tools. It does not by itself settle Anthropic's cryptocurrency-software rule, so ask Anthropic for written confirmation before submitting. Self-distribution (custom connectors, the Claude Code plugin, the MCP Registry) does not go through directory review.
