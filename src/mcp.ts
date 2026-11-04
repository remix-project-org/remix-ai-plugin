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
import { compile, transact, checkTransaction, encodeCall, readContract } from "./actions.js";
import { SIGN_WIDGET_URI, SIGN_WIDGET_MIME, SIGN_WIDGET_TOOL_META, signWidgetHtml } from "./widget.js";

const sourcesSchema = z
  .record(z.object({ content: z.string() }))
  .describe("Map of filename → { content } for each Solidity file");

const abiSchema = z
  .union([z.string(), z.array(z.unknown()), z.record(z.unknown())])
  .describe('Contract ABI: the JSON ABI (array or string), the compiled contract output from compile_solidity, or human-readable signatures like "function transfer(address to, uint256 amount)".');

const argsSchema = z
  .array(z.unknown())
  .optional()
  .describe('Arguments in ABI order. Pass uint/int values as decimal strings (e.g. "1000000000000000000"), addresses as 0x strings, arrays/tuples as JSON arrays.');

function text(payload: unknown, isError = false) {
  const structured = payload && typeof payload === "object" && !Array.isArray(payload);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(structured ? { structuredContent: payload as Record<string, unknown> } : {}),
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
        "Clients that support MCP Apps also render an inline card that tracks the transaction live.",
        "Build 'data' with encode_call — never hand-encode hex.",
        "For contract deployment omit 'to' and set 'data' to the deployment data from encode_call (bytecode + constructor args).",
        "For a regular call set 'to' to the contract address and 'data' to the calldata from encode_call.",
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
        abi: abiSchema
          .optional()
          .describe("Optional contract ABI so the signing page can show the decoded function and arguments. Not needed if `data` came from encode_call."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: {
        ...SIGN_WIDGET_TOOL_META,
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
        "Pass waitSeconds (up to 25) to long-poll: the call returns as soon as something changes, so you don't need to call it repeatedly.",
        "If status is 'pending' or 'signing', call again with waitSeconds.",
        "Once sent and mined, the result includes explorerUrl and, for deployments, contractAddress.",
        "signingPageOpened and walletsDetected tell you whether the user has opened the page and which browser wallets (e.g. MetaMask) it found;",
        "if walletsDetected is an empty list, help the user install a wallet or use WalletConnect.",
      ].join(" "),
      inputSchema: {
        transactionId: z.string().uuid().describe("The transactionId returned by the transact tool."),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(25)
          .optional()
          .describe("Long-poll up to this many seconds for a status change before returning (default 0 = return immediately). 20 is a good value."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Checking the transaction…",
        "openai/toolInvocation/invoked": "Checked the transaction.",
      },
    },
    async ({ transactionId, waitSeconds }) => guard(() => checkTransaction(transactionId, waitSeconds))
  );

  server.registerTool(
    "encode_call",
    {
      title: "Encode contract call or deployment",
      description: [
        "ABI-encode transaction data so you never have to build hex by hand.",
        "Function call: pass abi, functionName and args → returns calldata for transact (with 'to' = contract address).",
        "Deployment: pass abi, bytecode (evm.bytecode.object from compile_solidity) and the constructor args → returns deployment data for transact (no 'to').",
      ].join(" "),
      inputSchema: {
        abi: abiSchema,
        functionName: z
          .string()
          .optional()
          .describe('Function name or full signature (e.g. "transfer" or "transfer(address,uint256)"). Omit when encoding a deployment.'),
        args: argsSchema,
        bytecode: z
          .string()
          .optional()
          .describe("Contract creation bytecode. When set, encodes a deployment with `args` as the constructor arguments."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "Encoding the call…",
        "openai/toolInvocation/invoked": "Encoded the call.",
      },
    },
    async (args) => guard(() => encodeCall(args))
  );

  server.registerTool(
    "read_contract",
    {
      title: "Read contract state",
      description: [
        "Call a view/pure function on a deployed contract (eth_call) and return the decoded result — no wallet or transaction needed.",
        "Use this for balances, owners, totals, configuration, etc. Calling a state-changing function only simulates it.",
      ].join(" "),
      inputSchema: {
        address: z.string().describe("Deployed contract address"),
        chainId: z.number().int().describe("EVM chain ID (e.g. 11155111 = Sepolia, 1 = Ethereum mainnet, 8453 = Base)."),
        abi: abiSchema,
        functionName: z.string().describe('Function name or full signature, e.g. "balanceOf"'),
        args: argsSchema,
        from: z.string().optional().describe("Optional caller address (msg.sender) for the call."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Reading the contract…",
        "openai/toolInvocation/invoked": "Read the contract.",
      },
    },
    async (args) => guard(() => readContract(args))
  );

  // -------------------------------------------------------------------------
  // MCP Apps view rendered inline for `transact` results
  // -------------------------------------------------------------------------

  server.registerResource(
    "sign-transaction-view",
    SIGN_WIDGET_URI,
    {
      title: "Transaction signing card",
      description: "Shows a pending transaction, opens the signing page and tracks its status.",
      mimeType: SIGN_WIDGET_MIME,
    },
    async () => ({
      contents: [{ uri: SIGN_WIDGET_URI, mimeType: SIGN_WIDGET_MIME, text: signWidgetHtml() }],
    })
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
              `2. If compilation succeeds, call encode_call with the contract's abi, its bytecode and any constructor args (ask me for values if needed).`,
              `3. Call transact with the returned data (no 'to' field — it's a deployment).`,
              `4. Show the sign URL and call check_transaction with waitSeconds: 20 until status is 'sent' or 'failed'.`,
              `5. On success, report the tx hash and the deployed address (contractAddress).`,
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
              `1. If the function is view/pure, call read_contract and report the result — no transaction needed.`,
              `2. Otherwise call encode_call with the ABI, function name and arguments.`,
              `3. Call transact with to=${address}, the returned data, the chainId, the value and the ABI.`,
              `4. Show the sign URL and call check_transaction with waitSeconds: 20 until status is 'sent' or 'failed'.`,
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

  return server;
}
