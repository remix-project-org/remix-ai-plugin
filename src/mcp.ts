// ---------------------------------------------------------------------------
// MCP server factory — one instance per connector session.
//
// Claude (connectors / Claude Code plugin) and ChatGPT (developer mode / Apps
// SDK) both speak Streamable HTTP MCP, so a single tool surface serves both.
// `annotations` are read by both clients; the `_meta["openai/*"]` hints are
// ChatGPT-only progress copy and are ignored by Claude.
// ---------------------------------------------------------------------------

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compile, transact, checkTransaction, auditChecklist, audit } from "./actions.js";

const sourcesSchema = z
  .record(z.object({ content: z.string() }))
  .describe("Map of filename → { content } for each Solidity file");

const modelSchema = z
  .enum(["Fast", "Balanced", "Deep"])
  .optional()
  .describe('Quality tier. "Fast" = small model, "Balanced" = default, "Deep" = highest quality (slower, pricier).');

function text(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function guard(fn: () => Promise<unknown> | unknown) {
  try {
    return text(await fn());
  } catch (err: any) {
    return text({ success: false, error: err?.message ?? String(err) }, true);
  }
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "remix-solidity", version: "1.0.0" });

  server.registerTool(
    "compile_solidity",
    {
      title: "Compile Solidity",
      description:
        "Compile one or more Solidity source files using the Remix compiler. Returns ABI, bytecode, and any errors or warnings.",
      inputSchema: {
        sources: sourcesSchema,
        version: z
          .string()
          .optional()
          .describe('Solidity compiler version, e.g. "v0.8.28+commit.7893614a". Defaults to 0.8.28.'),
        settings: z
          .record(z.unknown())
          .optional()
          .describe("solc compiler settings (optimizer, outputSelection, …)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Compiling the contract…",
        "openai/toolInvocation/invoked": "Compiled the contract.",
      },
    },
    async ({ sources, version, settings }) =>
      guard(() => compile({ sources, version, settings: settings as Record<string, unknown> | undefined }))
  );

  server.registerTool(
    "transact",
    {
      title: "Prepare transaction for signing",
      description: [
        "Save a transaction for the user to review, sign and broadcast via their browser wallet.",
        "Returns a signUrl — show it to the user as a clickable link; they open it to sign with MetaMask or WalletConnect.",
        "For contract deployment omit 'to' and set 'data' to the compiled bytecode.",
        "For a regular call set 'to' to the contract address and 'data' to the encoded calldata.",
      ].join(" "),
      inputSchema: {
        data: z
          .string()
          .describe("Hex-encoded transaction data. For deployment: the contract bytecode. For calls: the ABI-encoded calldata."),
        to: z.string().optional().describe("Recipient address. Omit for contract deployment."),
        value: z
          .string()
          .optional()
          .describe('ETH to send, as a hex string (e.g. "0x0") or decimal string in wei.'),
        chainId: z
          .number()
          .int()
          .optional()
          .describe("EVM chain ID (e.g. 1 = Ethereum mainnet, 11155111 = Sepolia, 8453 = Base)."),
        gasLimit: z
          .string()
          .optional()
          .describe('Gas limit as a hex string (e.g. "0x186A0"). Omit to let the wallet estimate.'),
        description: z
          .string()
          .optional()
          .describe('Human-readable description shown on the signing page, e.g. "Deploy MyToken.sol".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Preparing the transaction…",
        "openai/toolInvocation/invoked": "Transaction ready to sign.",
      },
    },
    async (args) => guard(() => transact(args))
  );

  server.registerTool(
    "check_transaction",
    {
      title: "Check transaction status",
      description: [
        "Poll the status of a transaction that was sent to the user for signing.",
        "Call this after sharing a signUrl with the user.",
        "Returns the transaction data (to, data, value, gasLimit) along with status.",
        "Status values: 'pending' (not opened yet), 'signing' (user is in the wallet confirmation dialog),",
        "'sent' (broadcast — txHash is available), 'failed' (user rejected or error occurred).",
        "If status is 'pending' or 'signing', wait a few seconds and call again.",
        "signingPageOpened and walletsDetected tell you whether the user has opened the page and which browser wallets (e.g. MetaMask) it found;",
        "if walletsDetected is an empty list, help the user install a wallet or use WalletConnect.",
      ].join(" "),
      inputSchema: {
        transactionId: z.string().uuid().describe("The transactionId returned by the transact tool."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Checking the transaction…",
        "openai/toolInvocation/invoked": "Checked the transaction.",
      },
    },
    async ({ transactionId }) => guard(() => checkTransaction(transactionId))
  );

  server.registerTool(
    "get_audit_checklist",
    {
      title: "Build security audit checklist",
      description: [
        "Analyze one or more Solidity contracts and return a security audit checklist — a ranked list of audit categories most relevant to these contracts.",
        "Strips each contract to a declaration skeleton, then matches it against a taxonomy of 70+ security categories (access control, reentrancy, oracle manipulation, flash loans, ERC token issues, etc.).",
        "Use this as the first step before running do_audit: the returned checklist focuses the full audit on what actually matters for these contracts.",
      ].join(" "),
      inputSchema: {
        sources: sourcesSchema,
        maxCategories: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum number of audit categories to return (default: 12, max: 20)"),
        model: modelSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Matching audit categories…",
        "openai/toolInvocation/invoked": "Built the audit checklist.",
      },
    },
    async (args) => guard(() => auditChecklist(args))
  );

  server.registerTool(
    "do_audit",
    {
      title: "Run security audit",
      description: [
        "Perform a complete AI-powered security audit of one or more Solidity contracts.",
        "Takes the contract sources and an audit checklist (typically from get_audit_checklist) and returns a detailed markdown audit report with findings classified by severity: CRITICAL, HIGH, MEDIUM, LOW, INFORMATIONAL.",
        "Each finding includes description, location, impact, and remediation guidance.",
        "Recommended flow: 1) compile_solidity to check for errors, 2) get_audit_checklist to identify relevant categories, 3) do_audit with the returned checklist for the full report.",
      ].join(" "),
      inputSchema: {
        sources: sourcesSchema,
        checklist: z
          .string()
          .describe("Audit checklist in markdown format — use the markdown field from get_audit_checklist, or provide a custom checklist"),
        model: modelSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Auditing the contracts…",
        "openai/toolInvocation/invoked": "Audit complete.",
      },
    },
    async (args) => guard(() => audit(args))
  );

  // -------------------------------------------------------------------------
  // Prompts — mirror the skills in plugins/claude/skills. Claude exposes them
  // as slash commands, ChatGPT in the connector's prompt picker.
  // -------------------------------------------------------------------------

  server.registerPrompt(
    "deploy-contract",
    {
      title: "Deploy Contract",
      description: "Compile a Solidity contract and deploy it — guides you through the full compile → sign flow.",
      argsSchema: {
        source: z.string().describe("Solidity source code of the contract to deploy"),
        filename: z.string().optional().describe('Filename, e.g. "MyToken.sol". Defaults to "Contract.sol".'),
        chain_id: z.string().optional().describe('EVM chain ID as a string (e.g. "11155111" for Sepolia). Defaults to Sepolia.'),
      },
    },
    ({ source, filename, chain_id }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Please deploy the following Solidity contract.`,
              `Filename: ${filename ?? "Contract.sol"}`,
              `Chain ID: ${chain_id ?? "11155111"} (Sepolia if not specified)`,
              ``,
              `Steps:`,
              `1. Call compile_solidity with the source below.`,
              `2. If compilation succeeds, call transact with the bytecode (no 'to' field — it's a deployment).`,
              `3. Show the sign URL to the user and poll check_transaction until status is 'sent' or 'failed'.`,
              `4. On success, report the tx hash and the deployed address from receipt.contractAddress.`,
              ``,
              `Source:`,
              "```solidity",
              source,
              "```",
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "call-contract",
    {
      title: "Call Contract Function",
      description: "Encode and send a function call to an already-deployed contract via the browser wallet.",
      argsSchema: {
        address: z.string().describe("Address of the deployed contract"),
        abi: z.string().describe("Contract ABI (JSON) or the single function signature to call"),
        function_call: z.string().describe('Function and arguments, e.g. "transfer(0xabc…, 1000)"'),
        chain_id: z.string().optional().describe('EVM chain ID as a string. Defaults to Sepolia ("11155111").'),
        value: z.string().optional().describe("ETH to send in wei, if the function is payable. Defaults to 0."),
      },
    },
    ({ address, abi, function_call, chain_id, value }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Please call a function on a deployed contract.`,
              `Contract: ${address}`,
              `Chain ID: ${chain_id ?? "11155111"} (Sepolia if not specified)`,
              `Call: ${function_call}`,
              `Value: ${value ?? "0"} wei`,
              ``,
              `Steps:`,
              `1. ABI-encode the calldata from the ABI and arguments, and show me the encoded calldata.`,
              `2. Call transact with to=${address}, that calldata, the chainId and the value.`,
              `3. Show the sign URL and poll check_transaction until status is 'sent' or 'failed'.`,
              ``,
              `ABI:`,
              "```json",
              abi,
              "```",
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "audit-contract",
    {
      title: "Audit Contract",
      description: "Run the full compile → checklist → audit flow and return a severity-ranked security report.",
      argsSchema: {
        source: z.string().describe("Solidity source code of the contract to audit"),
        filename: z.string().optional().describe('Filename, e.g. "Vault.sol". Defaults to "Contract.sol".'),
        model: z.string().optional().describe('Quality tier: "Fast", "Balanced" (default) or "Deep".'),
      },
    },
    ({ source, filename, model }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Please run a security audit of the following Solidity contract.`,
              `Filename: ${filename ?? "Contract.sol"}`,
              `Model tier: ${model ?? "Balanced"}`,
              ``,
              `Steps:`,
              `1. Call compile_solidity and report any errors before continuing.`,
              `2. Call get_audit_checklist on the source.`,
              `3. Call do_audit with the source and the checklist markdown.`,
              `4. Present the report, leading with CRITICAL and HIGH findings.`,
              ``,
              `Source:`,
              "```solidity",
              source,
              "```",
            ].join("\n"),
          },
        },
      ],
    })
  );

  return server;
}
