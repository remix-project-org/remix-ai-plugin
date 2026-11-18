// ---------------------------------------------------------------------------
// MCP server factory — one instance per connector session.
//
// Claude (connectors / Claude Code plugin) and ChatGPT (developer mode / Apps
// SDK) both speak Streamable HTTP MCP, so a single tool surface serves both.
// `annotations` are read by both clients; the `_meta["openai/*"]` hints are
// ChatGPT-only progress copy and are ignored by Claude.
// ---------------------------------------------------------------------------

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { compile, transact, checkTransaction, encodeCall, readContract, simulate, type CompileArgs, type TransactArgs, type SimulateArgs } from "./actions.js";
import type { EncodeArgs, ReadArgs } from "./tools/abi.js";
import { trackEvent, type TrackEvent } from "./analytics.js";
import { TRANSACT_ENABLED } from "./features.js";
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

// Tool and prompt schemas go through shape() on purpose: letting TypeScript infer
// them through registerTool/registerPrompt — or check zod v3 schemas against the
// SDK's zod v3/v4 union — exhausts tsc's memory.
const shape = (s: ZodRawShape) => s as unknown as ZodRawShapeCompat;

const transactFields: ZodRawShape = {
    to: z.string().optional().describe("Contract address for a function call. Omit for a deployment."),
    abi: abiSchema
      .optional()
      .describe("Contract ABI. Required with functionName or bytecode; with pre-encoded data it is only used to show the decoded call."),
    functionName: z
      .string()
      .optional()
      .describe('Function to call, by name or full signature (e.g. "transfer"). Requires to and abi.'),
    args: argsSchema.describe(
      'Function or constructor arguments in ABI order. uint/int as decimal strings, addresses as 0x strings, arrays/tuples as JSON arrays.'
    ),
    bytecode: z
      .string()
      .optional()
      .describe("Creation bytecode for a deployment (evm.bytecode.object from compile_solidity). Requires abi; args are the constructor arguments."),
    data: z
      .string()
      .optional()
      .describe("Pre-encoded transaction data. Only needed when not passing abi + functionName/bytecode."),
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
  };

const transactInputSchema = shape(transactFields);

// simulate takes the same call as transact, minus the signing-page fields, with the chain required.
const { gasLimit: _gasLimit, description: _description, chainId: _chainId, ...callFields } = transactFields;
const simulateInputSchema = shape({
  ...callFields,
  chainId: z.number().int().describe("EVM chain ID (e.g. 1 = Ethereum mainnet, 11155111 = Sepolia, 8453 = Base)."),
  from: z
    .string()
    .optional()
    .describe("Caller address (msg.sender) to simulate as. Without it the zero address is used, so balance and permission checks may fail."),
});

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

// ---------------------------------------------------------------------------
// Usage analytics — one event per JSON-RPC exchange of a session.
// ---------------------------------------------------------------------------

/** The parts of a JSON-RPC message the tracker reads. */
type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: Record<string, any>;
  result?: { isError?: boolean };
  error?: unknown;
};

type RpcEvent = Pick<TrackEvent, "category" | "action" | "value">;

/** Client-supplied text (client, tool, prompt and method names) cut down to an analytics label. */
const label = (value: unknown) => String(value ?? "unknown").slice(0, 64);

/** The event for an incoming request or notification. Only names and the chain ID are read — never other arguments. */
function describe(method: string, params: Record<string, any> = {}): RpcEvent {
  switch (method) {
    case "tools/call": {
      const chainId = params.arguments?.chainId;
      return { category: "tool", action: label(params.name), value: Number.isInteger(chainId) ? chainId : undefined };
    }
    case "prompts/get":
      return { category: "prompt", action: label(params.name) };
    case "resources/read":
      return { category: "resource", action: label(params.uri) };
    default:
      return { category: "mcp", action: label(method) };
  }
}

/**
 * Reports every MCP interaction of a connected session to analytics, attributed to the
 * connecting client (e.g. Claude, ChatGPT). It watches the transport rather than the
 * handlers so that calls the SDK answers itself — unknown tools, invalid arguments,
 * list requests — are covered too. Failed requests get an "_error" category suffix.
 */
export function trackMcpSession(server: McpServer, transport: Transport): void {
  const report = (event: RpcEvent, suffix = "") =>
    trackEvent({
      ...event,
      category: event.category + suffix,
      name: label(server.server.getClientVersion()?.name),
      visitorKey: transport.sessionId,
    });

  // Requests still being handled: JSON-RPC id → the event to report once the outcome is known.
  const pending = new Map<string | number, RpcEvent>();
  const settle = (id: string | number | undefined, suffix: string) => {
    const event = id === undefined ? undefined : pending.get(id);
    if (!event) return;
    pending.delete(id!);
    report(event, suffix);
  };

  const receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    const { id, method, params } = message as RpcMessage;
    if (method && id !== undefined) {
      pending.set(id, describe(method, params));
    } else if (method) {
      report(describe(method, params));
      // A cancelled request never gets a response.
      if (method === "notifications/cancelled") settle(params?.requestId, "_cancelled");
    }
    receive?.(message, extra);
  };

  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const { id, method, result, error } = message as RpcMessage;
    if (!method) settle(id, error || result?.isError ? "_error" : "");
    return send(message, options);
  };

  server.server.onclose = () => report({ category: "session", action: "end" });
}

/** Tools and the inline card that exist only when transactions can be sent from the chat. */
function registerSigningTools(server: McpServer) {
  server.registerTool(
    "transact",
    {
      title: "Sign transaction (deploy or call)",
      description: [
        "Open the signing page so the user can review, sign and broadcast a transaction in their own browser wallet.",
        "Use this for EVERY contract deployment and EVERY state-changing function call — it is the only way to send a transaction.",
        "Deploy: pass abi, bytecode (evm.bytecode.object from compile_solidity) and constructor args; omit 'to'.",
        "Call: pass to (contract address), abi, functionName and args (plus value for payable functions).",
        "The server encodes everything — never hand-encode hex. Pre-encoded 'data' is also accepted.",
        "Returns a signUrl — show it to the user as a clickable link. Clients that support MCP Apps also render an inline card with an 'Open signing page' button that tracks the transaction live.",
        "The result includes a clear-signing review: a plain-language intent, where it was verified (ERC-7730 descriptor, verified source, or only your ABI) and risk warnings. Tell the user about any 'danger' warning before they sign.",
        "For view/pure functions use read_contract instead — no signature needed.",
      ].join(" "),
      inputSchema: transactInputSchema,
      // Broadcasting a transaction is irreversible once the user signs it.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: {
        ...SIGN_WIDGET_TOOL_META,
        "openai/toolInvocation/invoking": "Preparing the transaction…",
        "openai/toolInvocation/invoked": "Transaction ready to sign.",
      },
    },
    async (args) => guard(() => transact(args as TransactArgs))
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
        "'sent' (broadcast — txHash is available, waiting to be mined), 'confirmed' (mined successfully), 'reverted' (mined but reverted),",
        "'rejected' (the latest signing attempt was rejected or failed — see errorMessage; the user can retry on the same page).",
        "confirmed/reverted come from the on-chain receipt and are final; errors of earlier attempts are only listed in attempts.",
        "Pass waitSeconds (up to 25) to long-poll: the call returns as soon as something changes, so you don't need to call it repeatedly.",
        "If status is 'pending', 'signing' or 'sent', call again with waitSeconds.",
        "Once sent, the result includes explorerUrl and, for confirmed deployments, contractAddress.",
        "signingPageOpened and walletsDetected tell you whether the user has opened the page and which browser wallets (e.g. MetaMask) it found;",
        "if walletsDetected is an empty list, help the user install a wallet or use WalletConnect.",
      ].join(" "),
      inputSchema: shape({
        transactionId: z.string().uuid().describe("The transactionId returned by the transact tool."),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(25)
          .optional()
          .describe("Long-poll up to this many seconds for a status change before returning (default 0 = return immediately). 20 is a good value."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: {
        // The in-chat card calls this tool itself to track the transaction; ChatGPT requires the opt-in.
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Checking the transaction…",
        "openai/toolInvocation/invoked": "Checked the transaction.",
      },
    },
    async (args) => {
      const { transactionId, waitSeconds } = args as { transactionId: string; waitSeconds?: number };
      return guard(() => checkTransaction(transactionId, waitSeconds));
    }
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
}

/** Prompts that walk through compile → sign; mirror the skills in plugins/claude/skills. */
function registerSigningPrompts(server: McpServer) {
  server.registerPrompt(
    "deploy-contract",
    {
      title: "Deploy Contract",
      description: "Compile a Solidity contract and deploy it — guides you through the full compile → sign flow.",
      argsSchema: shape({
        source: z.string().describe("Solidity source code of the contract to deploy"),
        filename: z.string().optional().describe('Filename, e.g. "MyToken.sol". Defaults to "Contract.sol".'),
        chain_id: z.string().optional().describe('EVM chain ID as a string (e.g. "11155111" for Sepolia). Defaults to Sepolia.'),
      }),
    },
    (args) => {
      const { source, filename, chain_id } = args as { source: string; filename?: string; chain_id?: string };
      return {
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
              `2. If compilation succeeds, call transact with the contract's abi, its bytecode (evm.bytecode.object) and any constructor args (ask me for values if needed). Omit 'to' — it's a deployment.`,
              `3. Show the sign URL and call check_transaction with waitSeconds: 20 until status is 'confirmed', 'reverted' or 'rejected'.`,
              `4. On success, report the tx hash and the deployed address (contractAddress).`,
              ``,
              `Source:`,
              "```solidity",
              source,
              "```",
            ].join("\n"),
          },
        },
      ],
      };
    }
  );

  server.registerPrompt(
    "call-contract",
    {
      title: "Call Contract Function",
      description: "Encode and send a function call to an already-deployed contract via the browser wallet.",
      argsSchema: shape({
        address: z.string().describe("Address of the deployed contract"),
        abi: z.string().describe("Contract ABI (JSON) or the single function signature to call"),
        function_call: z.string().describe('Function and arguments, e.g. "transfer(0xabc…, 1000)"'),
        chain_id: z.string().optional().describe('EVM chain ID as a string. Defaults to Sepolia ("11155111").'),
        value: z.string().optional().describe("ETH to send in wei, if the function is payable. Defaults to 0."),
      }),
    },
    (args) => {
      const { address, abi, function_call, chain_id, value } = args as {
        address: string; abi: string; function_call: string; chain_id?: string; value?: string;
      };
      return {
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
              `2. Otherwise call transact with to=${address}, the ABI, the function name, the arguments, the chainId and the value.`,
              `3. Show the sign URL and call check_transaction with waitSeconds: 20 until status is 'confirmed', 'reverted' or 'rejected'.`,
              ``,
              `ABI:`,
              "```json",
              abi,
              "```",
            ].join("\n"),
          },
        },
      ],
      };
    }
  );
}

/** Prompts for the simulate-only build: the same flows as above, ending in a dry run instead of a signature. */
function registerSimulationPrompts(server: McpServer) {
  server.registerPrompt(
    "simulate-deployment",
    {
      title: "Simulate Deployment",
      description: "Compile a Solidity contract and dry-run its deployment — nothing is signed or sent.",
      argsSchema: shape({
        source: z.string().describe("Solidity source code of the contract to simulate deploying"),
        filename: z.string().optional().describe('Filename, e.g. "MyToken.sol". Defaults to "Contract.sol".'),
        chain_id: z.string().optional().describe('EVM chain ID as a string (e.g. "11155111" for Sepolia). Defaults to Sepolia.'),
      }),
    },
    (args) => {
      const { source, filename, chain_id } = args as { source: string; filename?: string; chain_id?: string };
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Please simulate deploying the following Solidity contract. Nothing will be sent to the chain.`,
                `Filename: ${filename ?? "Contract.sol"}`,
                `Chain ID: ${chain_id ?? "11155111"} (Sepolia if not specified)`,
                ``,
                `Steps:`,
                `1. Call compile_solidity with the source below.`,
                `2. If compilation succeeds, call simulate with the contract's abi, its bytecode (evm.bytecode.object) and any constructor args (ask me for values if needed). Omit 'to' — it's a deployment.`,
                `3. Report whether the deployment would succeed, the gas estimate and any revert reason or review warning.`,
                ``,
                `Source:`,
                "```solidity",
                source,
                "```",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "simulate-call",
    {
      title: "Simulate Contract Call",
      description: "Dry-run a function call on a deployed contract and show what it would do — nothing is signed or sent.",
      argsSchema: shape({
        address: z.string().describe("Address of the deployed contract"),
        abi: z.string().describe("Contract ABI (JSON) or the single function signature to call"),
        function_call: z.string().describe('Function and arguments, e.g. "transfer(0xabc…, 1000)"'),
        chain_id: z.string().optional().describe('EVM chain ID as a string. Defaults to Sepolia ("11155111").'),
        from: z.string().optional().describe("Address to simulate the call from (msg.sender)."),
        value: z.string().optional().describe("ETH to send in wei, if the function is payable. Defaults to 0."),
      }),
    },
    (args) => {
      const { address, abi, function_call, chain_id, from, value } = args as {
        address: string; abi: string; function_call: string; chain_id?: string; from?: string; value?: string;
      };
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Simulate a function call on a deployed contract. Nothing will be sent to the chain.`,
                `Contract: ${address}`,
                `Chain ID: ${chain_id ?? "11155111"} (Sepolia if not specified)`,
                `Call: ${function_call}`,
                `From: ${from ?? "not specified (zero address)"}`,
                `Value: ${value ?? "0"} wei`,
                ``,
                `Steps:`,
                `1. If the function is view/pure, call read_contract and report the result.`,
                `2. Otherwise call simulate with to=${address}, the ABI, the function name, the arguments, the chainId${from ? `, from=${from}` : ""} and the value.`,
                `3. Report whether the call would succeed, the decoded return value, the gas estimate and any revert reason or review warning.`,
                ``,
                `ABI:`,
                "```json",
                abi,
                "```",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "remix-solidity", version: "1.0.0" });

  server.registerTool(
    "compile_solidity",
    {
      title: "Compile Solidity",
      description:
        "Compile one or more Solidity source files using the Remix compiler. Returns ABI, bytecode, and any errors or warnings.",
      inputSchema: shape({
        sources: sourcesSchema,
        version: z
          .string()
          .optional()
          .describe('Solidity compiler version, e.g. "v0.8.28+commit.7893614a". Defaults to 0.8.28.'),
        settings: z
          .record(z.unknown())
          .optional()
          .describe("solc compiler settings (optimizer, outputSelection, …)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Compiling the contract…",
        "openai/toolInvocation/invoked": "Compiled the contract.",
      },
    },
    async (args) => guard(() => compile(args as CompileArgs))
  );

  server.registerTool(
    "encode_call",
    {
      title: "Encode contract call or deployment",
      description: [
        "ABI-encode transaction data without sending anything (e.g. to show or inspect calldata).",
        ...(TRANSACT_ENABLED
          ? [
              "To actually deploy or call a contract, use transact directly with abi + functionName/bytecode + args — it encodes for you.",
              "Function call: pass abi, functionName and args → returns calldata for transact (with 'to' = contract address).",
              "Deployment: pass abi, bytecode (evm.bytecode.object from compile_solidity) and the constructor args → returns deployment data for transact (no 'to').",
            ]
          : [
              "To see what a call or deployment would do on-chain, pass the same inputs to simulate — it encodes for you.",
              "Function call: pass abi, functionName and args → returns calldata.",
              "Deployment: pass abi, bytecode (evm.bytecode.object from compile_solidity) and the constructor args → returns deployment data.",
            ]),
      ].join(" "),
      inputSchema: shape({
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
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "Encoding the call…",
        "openai/toolInvocation/invoked": "Encoded the call.",
      },
    },
    async (args) => guard(() => encodeCall(args as EncodeArgs))
  );

  server.registerTool(
    "read_contract",
    {
      title: "Read contract state",
      description: [
        "Call a view/pure function on a deployed contract (eth_call) and return the decoded result — no wallet or transaction needed.",
        "Use this for balances, owners, totals, configuration, etc. Calling a state-changing function only simulates it.",
      ].join(" "),
      inputSchema: shape({
        address: z.string().describe("Deployed contract address"),
        chainId: z.number().int().describe("EVM chain ID (e.g. 11155111 = Sepolia, 1 = Ethereum mainnet, 8453 = Base)."),
        abi: abiSchema,
        functionName: z.string().describe('Function name or full signature, e.g. "balanceOf"'),
        args: argsSchema,
        from: z.string().optional().describe("Optional caller address (msg.sender) for the call."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Reading the contract…",
        "openai/toolInvocation/invoked": "Read the contract.",
      },
    },
    async (args) => guard(() => readContract(args as ReadArgs))
  );

  server.registerTool(
    "simulate",
    {
      title: "Simulate transaction",
      description: [
        "Dry-run a contract deployment or function call on the chain's current state and report what would happen — nothing is signed, sent or stored.",
        "Returns whether it would succeed, the gas estimate, the decoded return value (for calls) or the revert reason, and a clear-signing review: a plain-language intent, where it was verified and risk warnings.",
        "Deploy: pass abi, bytecode (evm.bytecode.object from compile_solidity) and constructor args; omit 'to'.",
        "Call: pass to (contract address), abi, functionName and args (plus value for payable functions).",
        "Pass 'from' to simulate a specific caller; otherwise the zero address is used.",
        "The server encodes everything — never hand-encode hex. Pre-encoded 'data' is also accepted.",
        "The result is a prediction against the latest block, not a guarantee of what a real transaction would do.",
      ].join(" "),
      inputSchema: simulateInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Simulating the transaction…",
        "openai/toolInvocation/invoked": "Simulated the transaction.",
      },
    },
    async (args) => guard(() => simulate(args as SimulateArgs))
  );

  if (TRANSACT_ENABLED) {
    registerSigningTools(server);
    registerSigningPrompts(server);
  } else {
    registerSimulationPrompts(server);
  }

  return server;
}
