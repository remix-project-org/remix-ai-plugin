// ---------------------------------------------------------------------------
// OpenAPI 3.1 description of the /actions/* endpoints.
// Paste `${BASE_URL}/openapi.json` into a custom GPT's "Create new action"
// → "Import from URL" to get the same five capabilities as the MCP connector.
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

const modelSchema = {
  type: "string",
  enum: ["Fast", "Balanced", "Deep"],
  default: "Balanced",
  description: "Quality tier of the model used for the analysis.",
};

export function openApiSpec(baseUrl: string, requiresAuth: boolean) {
  const security = requiresAuth ? { security: [{ bearerAuth: [] }] } : {};

  return {
    openapi: "3.1.0",
    info: {
      title: "Remix Solidity",
      description:
        "Compile, audit and deploy Solidity smart contracts. Deployments and contract calls are signed by the user in a browser wallet — this API never holds private keys.",
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
            "Stores a transaction and returns a signUrl. Show the signUrl to the user as a clickable link — they open it and sign with MetaMask or WalletConnect. Omit 'to' and pass bytecode as 'data' to deploy a contract.",
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
                  properties: { transactionId: { type: "string", description: "Id returned by prepareTransaction." } },
                  required: ["transactionId"],
                },
              },
            },
          },
          responses: { "200": { description: "Transaction state", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } },
        },
      },

      "/actions/audit-checklist": {
        post: {
          operationId: "getAuditChecklist",
          summary: "Build a security audit checklist for the contracts",
          description:
            "Matches the contracts against a taxonomy of 70+ security categories and returns the most relevant ones as markdown. Run this before runAudit.",
          ...security,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sources: sourcesSchema,
                    maxCategories: { type: "integer", minimum: 1, maximum: 20, default: 12 },
                    model: modelSchema,
                  },
                  required: ["sources"],
                },
              },
            },
          },
          responses: { "200": { description: "Checklist", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } },
        },
      },

      "/actions/audit": {
        post: {
          operationId: "runAudit",
          summary: "Run a full security audit",
          description:
            "Audits the contracts against the checklist and returns a markdown report with findings classified CRITICAL / HIGH / MEDIUM / LOW / INFORMATIONAL.",
          ...security,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sources: sourcesSchema,
                    checklist: { type: "string", description: "Checklist markdown from getAuditChecklist, or a custom one." },
                    model: modelSchema,
                  },
                  required: ["sources", "checklist"],
                },
              },
            },
          },
          responses: { "200": { description: "Audit report", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } },
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
      "Compile, audit and deploy Solidity smart contracts. You sign every transaction in your own browser wallet.",
    description_for_model: [
      "Tools for working with Solidity smart contracts.",
      "Use compileSolidity to compile sources and obtain ABI and bytecode.",
      "Use getAuditChecklist then runAudit to produce a security audit report; always run the checklist first.",
      "Use prepareTransaction to deploy a contract (omit 'to', pass bytecode as 'data') or to call a function (pass 'to' and ABI-encoded calldata), then show the returned signUrl to the user as a clickable link and poll checkTransaction every few seconds until status is 'sent' or 'failed'.",
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
