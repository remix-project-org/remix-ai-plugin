// ---------------------------------------------------------------------------
// OpenAPI 3.1 description of the /actions/* endpoints.
// Paste `${BASE_URL}/openapi.json` into a custom GPT's "Create new action"
// → "Import from URL" to get the same capabilities as the MCP connector.
// ---------------------------------------------------------------------------

const sourcesSchema = {
  description:
    "Solidity files to process. Either a list of { filename, content } objects or a map of filename → { content }.",
  oneOf: [
    {
      type: "array",
      items: {
        type: "object",
        properties: {
          filename: { type: "string", description: 'e.g. "MyToken.sol"' },
          content: { type: "string", description: "Full Solidity source text" },
        },
        required: ["content"],
      },
    },
    {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    },
  ],
};

const abiSchema = {
  description:
    'Contract ABI: a JSON ABI array, the compiled contract output from compileSolidity, or human-readable signatures like "function transfer(address to, uint256 amount)".',
  oneOf: [{ type: "array", items: {} }, { type: "string" }, { type: "object", additionalProperties: true }],
};

const argsSchema = {
  type: "array",
  items: {},
  description: 'Arguments in ABI order. uint/int as decimal strings (e.g. "1000000000000000000"), addresses as 0x strings, arrays/tuples as JSON arrays.',
};

export function openApiSpec(baseUrl: string, requiresAuth: boolean) {
  const security = requiresAuth ? { security: [{ bearerAuth: [] }] } : {};

  return {
    openapi: "3.1.0",
    info: {
      title: "Remix Solidity",
      description:
        "Compile, deploy and interact with Solidity smart contracts. Deployments and contract calls are signed by the user in a browser wallet — this API never holds private keys.",
      version: "1.0.0",
    },
    servers: [{ url: baseUrl }],
    ...(requiresAuth
      ? {
          components: {
            securitySchemes: {
              bearerAuth: { type: "http", scheme: "bearer" },
            },
          },
          security: [{ bearerAuth: [] }],
        }
      : {}),
    paths: {
      "/actions/compile": {
        post: {
          operationId: "compileSolidity",
          summary: "Compile Solidity sources",
          description:
            "Compile one or more Solidity files with the Remix compiler. Returns ABI, bytecode and any errors or warnings.",
          ...security,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sources: sourcesSchema,
                    version: {
                      type: "string",
                      description: 'Compiler version, e.g. "v0.8.28+commit.7893614a". Defaults to 0.8.28.',
                    },
                    settings: {
                      type: "object",
                      additionalProperties: true,
                      description: "solc settings (optimizer, outputSelection, …).",
                    },
                  },
                  required: ["sources"],
                },
              },
            },
          },
          responses: { "200": { description: "Compilation result", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } },
        },
      },

      "/actions/transact": {
        post: {
          operationId: "prepareTransaction",
          summary: "Prepare a transaction for the user to sign",
          description:
            "Stores a transaction and returns a signUrl. Show the signUrl to the user as a clickable link — they open it and sign with MetaMask or WalletConnect. Build 'data' with encodeCall (never hand-encode hex). Omit 'to' to deploy a contract.",
          ...security,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "string", description: "Hex calldata, or contract bytecode for a deployment." },
                    to: { type: "string", description: "Recipient address. Omit for contract deployment." },
                    value: { type: "string", description: 'ETH to send, hex (e.g. "0x0") or decimal wei.' },
                    chainId: { type: "integer", description: "EVM chain ID. 11155111 = Sepolia, 1 = mainnet, 8453 = Base." },
                    gasLimit: { type: "string", description: 'Hex gas limit (e.g. "0x186A0"). Omit to let the wallet estimate.' },
                    description: { type: "string", description: "Label shown on the signing page." },
                    abi: { ...abiSchema, description: "Optional ABI so the signing page can show the decoded call. Not needed if data came from encodeCall." },
                  },
                  required: ["data"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Pending transaction with a sign URL",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      transactionId: { type: "string" },
                      signUrl: { type: "string" },
                      status: { type: "string" },
                      instructions: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },

      "/actions/check-transaction": {
        post: {
          operationId: "checkTransaction",
          summary: "Poll the status of a pending transaction",
          description:
            "Status is 'pending' (sign page not opened), 'signing' (wallet dialog open), 'sent' (broadcast — txHash available) or 'failed'. Poll every few seconds until 'sent' or 'failed'. signingPageOpened / walletsDetected report whether the user opened the page and which browser wallets it found; an empty walletsDetected list means no wallet extension is installed.",
          ...security,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    transactionId: { type: "string", description: "Id returned by prepareTransaction." },
                    waitSeconds: { type: "integer", minimum: 0, maximum: 25, description: "Long-poll up to this many seconds for a status change before returning. 20 is a good value." },
                  },
                  required: ["transactionId"],
                },
              },
            },
          },
          responses: { "200": { description: "Transaction state", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } },
        },
      },

      "/actions/encode-call": {
        post: {
          operationId: "encodeCall",
          summary: "ABI-encode a function call or a deployment with constructor args",
          description:
            "Function call: pass abi, functionName and args → calldata for prepareTransaction (with 'to'). Deployment: pass abi, bytecode (evm.bytecode.object from compileSolidity) and constructor args → deployment data for prepareTransaction (no 'to').",
          ...security,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    abi: abiSchema,
                    functionName: { type: "string", description: 'Function name or signature, e.g. "transfer". Omit for a deployment.' },
                    args: argsSchema,
                    bytecode: { type: "string", description: "Creation bytecode. When set, args are the constructor arguments." },
                  },
                  required: ["abi"],
                },
              },
            },
          },
          responses: { "200": { description: "Encoded data", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } },
        },
      },

      "/actions/read-contract": {
        post: {
          operationId: "readContract",
          summary: "Call a view/pure function on a deployed contract",
          description: "Runs an eth_call and returns the decoded result. No wallet or transaction needed.",
          ...security,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    address: { type: "string", description: "Deployed contract address" },
                    chainId: { type: "integer", description: "EVM chain ID, e.g. 11155111 = Sepolia" },
                    abi: abiSchema,
                    functionName: { type: "string", description: 'Function name or signature, e.g. "balanceOf"' },
                    args: argsSchema,
                    from: { type: "string", description: "Optional caller address" },
                  },
                  required: ["address", "chainId", "abi", "functionName"],
                },
              },
            },
          },
          responses: { "200": { description: "Decoded result", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// ai-plugin.json — served at /.well-known/ai-plugin.json
// ---------------------------------------------------------------------------

export function pluginManifest(baseUrl: string, requiresAuth: boolean) {
  return {
    schema_version: "v1",
    name_for_human: "Remix Solidity",
    name_for_model: "remix_solidity",
    description_for_human:
      "Compile, deploy and interact with Solidity smart contracts. You sign every transaction in your own browser wallet.",
    description_for_model: [
      "Tools for working with Solidity smart contracts.",
      "Use compileSolidity to compile sources and obtain ABI and bytecode.",
      "Use readContract to read state from a deployed contract (no transaction needed).",
      "Use encodeCall to build transaction data — a deployment (bytecode + constructor args) or a function call — never hand-encode hex.",
      "Then use prepareTransaction to deploy (omit 'to') or call a function (pass 'to'), show the returned signUrl to the user as a clickable link, and call checkTransaction with waitSeconds: 20 until status is 'sent' or 'failed'.",
      "Never ask the user for a private key or seed phrase — signing always happens in the user's own browser wallet.",
      "Default to Sepolia (chainId 11155111) when the user does not name a chain.",
    ].join(" "),
    auth: requiresAuth
      ? { type: "user_http", authorization_type: "bearer" }
      : { type: "none" },
    api: { type: "openapi", url: `${baseUrl}/openapi.json` },
    logo_url: `${baseUrl}/logo.png`,
    contact_email: process.env.CONTACT_EMAIL ?? "support@remixlabs.live",
    legal_info_url: process.env.LEGAL_URL ?? "https://remix-project.org/terms",
  };
}
