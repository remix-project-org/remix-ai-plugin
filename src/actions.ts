// ---------------------------------------------------------------------------
// Action layer — the plugin's capabilities, as plain async functions.
//
// Both front doors use this module unchanged:
//   • mcp.ts  — MCP connector for Claude and ChatGPT
//   • rest.ts — REST endpoints behind the OpenAPI spec used by custom GPT Actions
// ---------------------------------------------------------------------------

import { JsonRpcProvider, getAddress, type TransactionRequest } from "ethers";
import { TRANSACT_ENABLED } from "./features.js";
import { compileSolidity } from "./tools/compile.js";
import { encode, decodeTransaction, parseAbi, toJsonSafe, readContract as readContractCall, type DecodedCall, type EncodeArgs, type ReadArgs } from "./tools/abi.js";
import { createTransaction, getTransaction, setReceipt, setReview, TERMINAL_STATUSES, type PendingTransaction } from "./store.js";
import { buildReview, type TxReview } from "./tools/clearsign.js";
import { PUBLIC_RPCS, explorerUrl } from "./rpcs.js";

export type Sources = Record<string, { content: string }>;

const BASE_URL = () => process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

// --- compile ---------------------------------------------------------------

export interface CompileArgs {
  sources: Sources;
  version?: string;
  settings?: Record<string, unknown>;
}

export async function compile(args: CompileArgs) {
  return compileSolidity({
    sources: args.sources,
    version: args.version,
    settings: args.settings,
  });
}

// --- encode_call -----------------------------------------------------------

// Remembers what recent encode_call results mean, so transact can show the
// decoded call on the signing page even when no ABI is passed to it.
const recentEncodings = new Map<string, DecodedCall>();
const MAX_RECENT_ENCODINGS = 500;

export function encodeCall(args: EncodeArgs) {
  const result = encode(args);
  const decoded = decodeTransaction(args.abi, result.data, result.kind === "deploy");
  if (decoded) {
    if (result.kind === "deploy" && !decoded.args) {
      // Dynamic constructor args can't be recovered from the bytecode tail, but we know them here.
      const inputs = parseAbi(args.abi).deploy.inputs;
      decoded.args = inputs.map((p, i) => ({ name: p.name, type: p.type, value: toJsonSafe(args.args?.[i]) }));
    }
    recentEncodings.set(result.data.toLowerCase(), decoded);
    if (recentEncodings.size > MAX_RECENT_ENCODINGS) {
      recentEncodings.delete(recentEncodings.keys().next().value!);
    }
  }
  return {
    ...result,
    ...(TRANSACT_ENABLED
      ? {
          next: result.kind === "deploy"
            ? "Pass `data` to transact with no `to` field to deploy."
            : "Pass `data` to transact with `to` set to the contract address" + (result.payable ? " (and `value` if sending ETH)." : "."),
        }
      : {}),
  };
}

// --- read_contract ---------------------------------------------------------

export async function readContract(args: ReadArgs) {
  return readContractCall(args);
}

// --- transact --------------------------------------------------------------

export interface TransactArgs {
  /** Pre-encoded data. Optional when abi + functionName/bytecode are given. */
  data?: string;
  to?: string;
  value?: string;
  chainId?: number;
  gasLimit?: string;
  description?: string;
  /** ABI used to encode the call (with functionName/bytecode) or to decode `data` for display. */
  abi?: unknown;
  functionName?: string;
  args?: unknown[];
  bytecode?: string;
}

/** Turns either pre-encoded `data` or abi + functionName/bytecode + args into transaction data. */
function resolveData({ data, to, abi, functionName, args, bytecode }: TransactArgs): string {
  if (bytecode !== undefined) {
    if (to) throw new Error("A deployment (bytecode) must not have a 'to' address.");
    if (abi === undefined) throw new Error("abi is required to encode constructor arguments.");
    return encodeCall({ abi, bytecode, args }).data;
  }
  if (functionName !== undefined) {
    if (!to) throw new Error("A function call needs 'to' — the deployed contract address.");
    if (abi === undefined) throw new Error("abi is required to encode the function call.");
    return encodeCall({ abi, functionName, args }).data;
  }
  if (data === undefined) {
    throw new Error("Pass abi + bytecode + args to deploy, abi + functionName + args + to to call a function, or pre-encoded data.");
  }
  return data.startsWith("0x") ? data : `0x${data}`;
}

// Clear-signing reviews being built, by transaction id. Building needs network
// lookups (registry, Sourcify, RPC), so transact waits only briefly for it.
const pendingReviews = new Map<string, Promise<TxReview | undefined>>();
const TRANSACT_REVIEW_WAIT_MS = 3000;

/** The transaction's review, waiting for it to finish building if needed. */
export async function getReview(transactionId: string): Promise<TxReview | undefined> {
  return getTransaction(transactionId)?.review ?? pendingReviews.get(transactionId);
}

/** What the model needs from a review: the headline, where it came from and any warnings. */
function reviewSummary(review: TxReview | undefined) {
  return review && { intent: review.intent, source: review.source, contractName: review.contractName, warnings: review.warnings };
}

export async function transact(input: TransactArgs) {
  const { abi, functionName: _f, args: _a, bytecode: _b, data: _d, ...args } = input;
  const data = resolveData(input);
  const decoded =
    recentEncodings.get(data.toLowerCase()) ??
    (abi !== undefined ? decodeTransaction(abi, data, !args.to) : undefined);

  const pending = createTransaction({ ...args, data, ...(decoded ? { decoded } : {}) });
  const building = buildReview({ chainId: args.chainId, to: args.to, data, value: args.value, abi, decodedArgs: decoded?.args })
    .then((review) => { setReview(pending.id, review); return review; })
    .catch(() => undefined)
    .finally(() => pendingReviews.delete(pending.id));
  pendingReviews.set(pending.id, building);
  const review = await Promise.race([building, new Promise<undefined>((r) => setTimeout(r, TRANSACT_REVIEW_WAIT_MS))]);

  return {
    transactionId: pending.id,
    signUrl: `${BASE_URL()}/sign/${pending.id}`,
    status: pending.status,
    chainId: pending.chainId,
    to: pending.to,
    value: pending.value,
    description: pending.description,
    ...(decoded ? { decoded } : {}),
    ...(review ? { review: reviewSummary(review) } : {}),
    instructions: [
      "If review.warnings contains a 'danger' item, tell the user about it plainly before they sign.",
      "Show the signUrl to the user as a clickable link and tell them to open it to sign (clients with the inline card also show an 'Open signing page' button).",
      "Then call check_transaction with the transactionId and waitSeconds: 20 to wait for progress;",
      "repeat until status is 'confirmed', 'reverted' or 'rejected'.",
    ].join(" "),
  };
}

// --- check_transaction -----------------------------------------------------

const MAX_WAIT_SECONDS = 25;

async function fetchReceipt(tx: PendingTransaction): Promise<void> {
  if (tx.status !== "sent" || !tx.txHash || tx.receipt || !tx.chainId) return;
  const rpcUrl = PUBLIC_RPCS[tx.chainId];
  if (!rpcUrl) return;
  try {
    const provider = new JsonRpcProvider(rpcUrl, tx.chainId, { staticNetwork: true });
    const receipt = await provider.getTransactionReceipt(tx.txHash);
    if (receipt) setReceipt(tx.id, receipt.toJSON() as { status?: number | null });
  } catch { /* receipt not available yet — ignore */ }
}

/**
 * Returns the transaction state. With waitSeconds > 0 it long-polls: it returns as
 * soon as something changes (status, wallet report, receipt) or the wait elapses.
 * Once a receipt exists it alone decides the outcome; earlier failed attempts are
 * only listed in `attempts`.
 */
export async function checkTransaction(transactionId: string, waitSeconds = 0) {
  const tx = getTransaction(transactionId);
  if (!tx) {
    return {
      status: "not_found" as const,
      error: "Transaction not found or expired (TTL: 1 hour).",
    };
  }

  const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS) * 1000;
  const startStatus = tx.status;
  const startWalletReport = tx.wallets?.reportedAt;

  await fetchReceipt(tx);
  while (Date.now() < deadline) {
    if (TERMINAL_STATUSES.includes(tx.status)) break;
    if (tx.status !== startStatus && tx.status !== "sent") break;
    if (tx.wallets?.reportedAt !== startWalletReport) break;
    await new Promise((r) => setTimeout(r, tx.status === "sent" ? 2000 : 500));
    await fetchReceipt(tx);
  }

  const { wallets, errorMessage, review, ...rest } = getTransaction(transactionId)!;
  const payload: Record<string, unknown> = {
    ...rest,
    ...(review ? { review: reviewSummary(review) } : {}),
    ...(tx.status === "rejected" ? { errorMessage } : {}),
    signingPageOpened: Boolean(wallets),
    walletsDetected: wallets ? wallets.detected.map((w) => w.name) : null,
  };

  if (tx.txHash) payload.explorerUrl = explorerUrl(tx.chainId, "tx", tx.txHash);
  const contractAddress = (tx.receipt as { contractAddress?: string } | undefined)?.contractAddress;
  if (contractAddress) {
    payload.contractAddress = contractAddress;
    payload.contractExplorerUrl = explorerUrl(tx.chainId, "address", contractAddress);
  }

  if (tx.status === "confirmed") {
    payload.message = contractAddress ? "Transaction was mined successfully; the contract is deployed." : "Transaction was mined successfully.";
  } else if (tx.status === "reverted") {
    payload.message = "Transaction was mined but reverted — no state changed. Check the arguments, value and sender.";
  } else if (tx.status === "sent") {
    payload.message = "Transaction was broadcast; the receipt is not available yet — check again with waitSeconds to get it.";
  } else if (tx.status === "rejected") {
    payload.error = errorMessage;
    payload.message = "The signing attempt failed or was rejected — see error. The user can retry on the same signing page; check again to see a later attempt.";
  } else if (tx.status === "signing") {
    payload.message = "User is currently confirming in their wallet. Check again in a few seconds.";
  } else if (!wallets) {
    payload.message = "Transaction is pending — user has not opened the signing page yet.";
  } else if (wallets.detected.length === 0) {
    payload.message = [
      "The user opened the signing page but no browser wallet extension was detected.",
      "Suggest installing MetaMask (https://metamask.io) or another wallet, or using WalletConnect / the generated account option on the page.",
    ].join(" ");
  } else {
    payload.message = `User opened the signing page (detected: ${wallets.detected.map((w) => w.name).join(", ")}) but has not confirmed yet.`;
  }

  return payload;
}

// --- simulate --------------------------------------------------------------

export interface SimulateArgs extends Omit<TransactArgs, "gasLimit" | "description" | "chainId"> {
  chainId: number;
  /** Caller (msg.sender). Defaults to the zero address. */
  from?: string;
}

const SIMULATE_TIMEOUT_MS = 20_000;

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The RPC node did not answer in time.")), SIMULATE_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Why an eth_call reverted: the revert string, or a custom error decoded with the ABI when one was given. */
function revertDetails(err: any, abi: unknown) {
  const data: string | undefined = typeof err?.data === "string" && err.data !== "0x" ? err.data : undefined;
  let customError: { name: string; signature: string; args: unknown } | undefined;
  if (data && abi !== undefined) {
    try {
      const parsed = parseAbi(abi).parseError(data);
      if (parsed) customError = { name: parsed.name, signature: parsed.signature, args: toJsonSafe(Array.from(parsed.args)) };
    } catch { /* not an error of this ABI */ }
  }
  return {
    message: err?.shortMessage ?? err?.message ?? "execution reverted",
    ...(err?.reason ? { reason: err.reason } : {}),
    ...(customError ? { customError } : {}),
    ...(data ? { data } : {}),
  };
}

/** Decodes what a successful call returned, when the ABI knows the function. */
function decodeReturn(abi: unknown, functionName: string | undefined, data: string, returnData: string) {
  try {
    const iface = parseAbi(abi);
    const fragment = iface.getFunction(functionName ?? data.slice(0, 10));
    if (!fragment || fragment.outputs.length === 0) return undefined;
    const values = Array.from(iface.decodeFunctionResult(fragment, returnData) as ArrayLike<unknown>);
    return {
      signature: fragment.format("full"),
      outputs: fragment.outputs.map((o, i) => ({ name: o.name, type: o.type, value: toJsonSafe(values[i]) })),
    };
  } catch {
    return undefined;
  }
}

/** Dry-runs a deployment or call with eth_call + eth_estimateGas. Nothing is signed, sent or stored. */
export async function simulate(input: SimulateArgs) {
  const { chainId, to, from, abi, functionName } = input;
  const rpcUrl = PUBLIC_RPCS[chainId];
  if (!rpcUrl) throw new Error(`No RPC configured for chain ${chainId}. Supported: ${Object.keys(PUBLIC_RPCS).join(", ")}`);

  const data = resolveData(input);
  let value: bigint | undefined;
  try { value = input.value !== undefined ? BigInt(input.value) : undefined; }
  catch { throw new Error('value must be a hex string (e.g. "0x0") or a decimal string in wei.'); }

  const decoded =
    recentEncodings.get(data.toLowerCase()) ??
    (abi !== undefined ? decodeTransaction(abi, data, !to) : undefined);

  const request: TransactionRequest = {
    ...(to ? { to: getAddress(to) } : {}),
    ...(from ? { from: getAddress(from) } : {}),
    data,
    ...(value !== undefined ? { value } : {}),
  };
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });

  const run = async () => {
    try {
      const returnData = await withTimeout(provider.call(request));
      const gas = await withTimeout(provider.estimateGas(request)).catch(() => undefined);
      return { ok: true as const, returnData, gasEstimate: gas?.toString() };
    } catch (err: any) {
      if (err?.code !== "CALL_EXCEPTION") throw err;
      return { ok: false as const, revert: revertDetails(err, abi) };
    }
  };
  const [outcome, review] = await Promise.all([
    run(),
    buildReview({ chainId, to, data, value: input.value, abi, decodedArgs: decoded?.args }).catch(() => undefined),
  ]);

  const returns = outcome.ok && to && abi !== undefined ? decodeReturn(abi, functionName, data, outcome.returnData) : undefined;
  return {
    simulated: true,
    success: outcome.ok,
    chainId,
    ...(to ? { to } : {}),
    ...(from ? { from } : {}),
    ...(value !== undefined ? { value: value.toString() } : {}),
    ...(decoded ? { decoded } : {}),
    ...(outcome.ok
      ? {
          ...(outcome.gasEstimate ? { gasEstimate: outcome.gasEstimate } : {}),
          ...(returns ? { returns } : {}),
          ...(!to ? { deployedCodeBytes: Math.max(0, (outcome.returnData.length - 2) / 2) } : {}),
        }
      : { revert: outcome.revert }),
    ...(review ? { review: reviewSummary(review) } : {}),
    note: [
      "Simulation only: nothing was signed or sent, and no state changed on-chain.",
      "It ran against the latest block, so a real transaction can still behave differently.",
      ...(from ? [] : ["No 'from' was given, so msg.sender was the zero address — pass 'from' to simulate a specific caller."]),
    ].join(" "),
  };
}
