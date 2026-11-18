# Privacy Policy — Remix Solidity connector

DRAFT for legal review. Every [bracketed] item must be filled in or confirmed by the operator before publishing. This text describes the server's behaviour as implemented; if the code or hosting changes, update it.

Last updated: [date]

## Who we are

[Legal entity name] ("we") operates the Remix Solidity connector, an MCP server that lets AI assistants such as Claude and ChatGPT compile Solidity, read smart contracts and simulate transactions. Contact: [support@remixlabs.live — confirm], [postal address if required].

## What the service does and does not do

- It compiles Solidity code, reads public blockchain data, and simulates contract deployments and calls. A simulation is a read-only request to a blockchain node; nothing is signed, sent or written on-chain.
- It has no user accounts and does not ask for, receive or store private keys, seed phrases or passwords.
- It does not hold or move funds.

## Information we process to answer your requests

When your AI assistant calls a tool, the connector receives what the assistant sends it: Solidity source code, contract ABIs, contract and caller addresses, call data, ETH amounts and chain IDs. We use it only to produce the response.

We do not write this information to disk or to a database, and we do not use it to build profiles or to train models. It is held in the server's memory only while the request runs, with these exceptions, all of which are discarded when the server restarts:

- fetched source files for imports such as OpenZeppelin (cached by import path);
- the last few hundred encoded calls, so a later request can show what they mean;
- public contract metadata looked up for clear-signing reviews (cached for up to 6 hours).

[Full build only — delete this paragraph for the simulate-only service] When a transaction is prepared for signing, its destination, call data, value, chain ID, status and transaction hash are kept in memory for one hour so you can sign it and track it, then deleted.

## Third parties that receive request data

To answer a request the server contacts the services below, so they receive the data shown. Their own privacy policies apply to what they do with it.

| Service | What it receives |
|---|---|
| Blockchain RPC nodes — PublicNode, Base, Arbitrum, Optimism public endpoints, or the operator's own provider [confirm] | Contract and caller addresses, call data, values and chain ID for simulations and reads, plus address lookups for ENS names |
| Sourcify (sourcify.dev) | Contract address and chain ID, to fetch verified source and ABI |
| ERC-7730 clear-signing registry (served from raw.githubusercontent.com) | A request for the registry index and for descriptor files of the contracts involved |
| npm CDN (unpkg.com or jsDelivr) and GitHub (raw.githubusercontent.com) | The package or file path of an import in your Solidity code, when it is not included in the request |
| [Hosting provider — name] | Network traffic to the server, see "Logs" below |

## Usage analytics

[If analytics is disabled in the published service, replace this section with "We do not collect usage analytics."]

We use [Matomo, hosted by us at matomo.remix.live — confirm] to count how the service is used. The server sends one event for each request in a connection, containing only:

- the type of request (a tool name such as "simulate", a prompt or resource name, or a protocol method such as "tools/list");
- the name of the client application as it identifies itself, for example "Claude" or "ChatGPT", or for REST callers the product name in their User-Agent;
- whether the request succeeded, failed or was cancelled;
- the chain ID, for tool calls that include one;
- a pseudonymous connection identifier: a truncated one-way hash of the session ID, which cannot be traced to a person;
- the time of the event.

The events are sent by our server, not by your browser, so your IP address is not forwarded; the analytics instance sees our server's address. We do not send source code, ABIs, addresses, call data, amounts, error messages or any conversation content. Names a client sends that we do not recognise, such as a mistyped tool name, are recorded as received, shortened to 64 characters.

Legal basis (EU/UK users): [legitimate interest in understanding and improving the service — confirm with counsel].

## Logs

The server itself writes only start-up and fatal error messages and does not log requests. [Hosting provider] may keep access logs containing IP addresses and request metadata for [period — confirm]. [If rate limiting is enabled:] To limit abuse, the server keeps a request counter per IP address in memory for one minute at a time.

## Retention

Request data is not stored beyond the in-memory caches above. Analytics events are kept for [period — confirm] and then deleted or aggregated.

## Your rights

Depending on where you live, you may have the right to access, correct, delete or restrict the use of personal data about you, to object to processing, and to complain to a data protection authority. Because the analytics identifier is a one-way hash and we hold no account data, we usually cannot link stored data to you; contact us at [email] and we will tell you what we can do. [Add jurisdiction-specific wording, such as GDPR representative details and CCPA disclosures, if applicable.]

## Children

The service is not directed at children under [13/16] and we do not knowingly process their data.

## Changes

We will post changes here and update the date above. For material changes to data practices we will also notify the directories where the connector is listed, as they require.

## Contact

[Entity name], [email], [address].
