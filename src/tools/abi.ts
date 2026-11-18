// ---------------------------------------------------------------------------
// ABI helpers — encoding calldata / constructor args, decoding transactions
// and read-only contract calls. Done server-side with ethers so the model never
// has to hand-encode hex.
// ---------------------------------------------------------------------------

import { Contract, Interface, JsonRpcProvider, getAddress, type InterfaceAbi } from "ethers";
import { PUBLIC_RPCS } from "../rpcs.js";
import { TRANSACT_ENABLED } from "../features.js";

/**
 * Accepts a JSON ABI (array or string), a compile_solidity contract output
 * ({ abi: [...] }), a single human-readable signature
 * ("function transfer(address to, uint256 amount)") or a list of them.
 */
export function parseAbi(raw: unknown): Interface {
  let abi: unknown = raw;
  if (typeof abi === "string") {
    const trimmed = abi.trim();
    abi = trimmed.startsWith("[") || trimmed.startsWith("{") ? JSON.parse(trimmed) : [trimmed];
  }
  if (abi && !Array.isArray(abi) && typeof abi === "object" && Array.isArray((abi as any).abi)) {
    abi = (abi as any).abi;
  }
  if (!Array.isArray(abi)) throw new Error("abi must be a JSON ABI array, a contract output with an abi field, or human-readable signatures");
  return new Interface(abi as InterfaceAbi);
}

/** Recursively converts ethers values (bigint, Result) into JSON-safe values. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return Array.from(value, toJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}

function withHexPrefix(hex: string): string {
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

// --- encode ----------------------------------------------------------------

export interface EncodeArgs {
  abi: unknown;
  functionName?: string;
  args?: unknown[];
  bytecode?: string;
}

export function encode({ abi, functionName, args = [], bytecode }: EncodeArgs) {
  const iface = parseAbi(abi);

  if (bytecode !== undefined) {
    const encodedArgs = iface.encodeDeploy(args);
    const code = withHexPrefix(bytecode.trim());
    if (code.length <= 2) throw new Error("bytecode is empty — is the contract abstract or an interface?");
    return {
      kind: "deploy" as const,
      data: code + encodedArgs.slice(2),
      signature: iface.deploy.format("full"),
      encodedArgs,
    };
  }

  if (!functionName) throw new Error("functionName is required (or pass bytecode to encode a deployment)");
  const fragment = iface.getFunction(functionName);
  if (!fragment) throw new Error(`Function "${functionName}" not found in ABI`);
  return {
    kind: "call" as const,
    data: iface.encodeFunctionData(fragment, args),
    signature: fragment.format("full"),
    selector: fragment.selector,
    stateMutability: fragment.stateMutability,
    payable: fragment.payable,
  };
}

// --- decode ----------------------------------------------------------------

export interface DecodedCall {
  kind: "call" | "deploy";
  signature: string;
  /** Undefined when the constructor args can't be located (dynamic types). */
  args?: Array<{ name: string; type: string; value: unknown }>;
}

/** Best-effort decode of a pending transaction for display. Returns undefined if it doesn't match the ABI. */
export function decodeTransaction(abi: unknown, data: string, isDeploy: boolean): DecodedCall | undefined {
  try {
    const iface = parseAbi(abi);
    if (isDeploy) {
      const inputs = iface.deploy.inputs;
      if (inputs.length === 0) return { kind: "deploy", signature: iface.deploy.format("full"), args: [] };
      const signature = iface.deploy.format("full");
      try {
        // Constructor args are ABI-encoded at the tail of the creation code.
        const tailLength = iface.getAbiCoder().encode(inputs, inputs.map((i) => defaultValue(i.baseType))).length - 2;
        const values = iface.getAbiCoder().decode(inputs, "0x" + data.slice(data.length - tailLength));
        return {
          kind: "deploy",
          signature,
          args: inputs.map((p, i) => ({ name: p.name, type: p.type, value: toJsonSafe(values[i]) })),
        };
      } catch {
        return { kind: "deploy", signature };
      }
    }
    const parsed = iface.parseTransaction({ data });
    if (!parsed) return undefined;
    return {
      kind: "call",
      signature: parsed.fragment.format("full"),
      args: parsed.fragment.inputs.map((p, i) => ({ name: p.name, type: p.type, value: toJsonSafe(parsed.args[i]) })),
    };
  } catch {
    return undefined;
  }
}

/** Placeholder values used only to measure the size of static constructor args. */
function defaultValue(baseType: string): unknown {
  if (baseType === "address") return "0x0000000000000000000000000000000000000000";
  if (baseType === "bool") return false;
  if (baseType.startsWith("uint") || baseType.startsWith("int")) return 0;
  if (baseType.startsWith("bytes") && baseType !== "bytes") return "0x" + "00".repeat(Number(baseType.slice(5)));
  // Dynamic types (string, bytes, arrays, tuples) have no fixed size — bail out.
  throw new Error("dynamic constructor args");
}

// --- read ------------------------------------------------------------------

export interface ReadArgs {
  address: string;
  chainId: number;
  abi: unknown;
  functionName: string;
  args?: unknown[];
  from?: string;
}

export async function readContract({ address, chainId, abi, functionName, args = [], from }: ReadArgs) {
  const rpcUrl = PUBLIC_RPCS[chainId];
  if (!rpcUrl) throw new Error(`No RPC configured for chain ${chainId}. Supported: ${Object.keys(PUBLIC_RPCS).join(", ")}`);

  const iface = parseAbi(abi);
  const fragment = iface.getFunction(functionName);
  if (!fragment) throw new Error(`Function "${functionName}" not found in ABI`);

  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const contract = new Contract(getAddress(address), iface, provider);
  const result = await contract.getFunction(fragment).staticCall(...args, from ? { from } : {});

  // Single return values come back unwrapped; multiple as a Result.
  const outputs = fragment.outputs;
  const values = outputs.length === 1 ? [result] : Array.from(result as ArrayLike<unknown>);
  return {
    signature: fragment.format("full"),
    stateMutability: fragment.stateMutability,
    result: outputs.length === 1 ? toJsonSafe(result) : toJsonSafe(values),
    outputs: outputs.map((o, i) => ({ name: o.name, type: o.type, value: toJsonSafe(values[i]) })),
    ...(fragment.stateMutability === "view" || fragment.stateMutability === "pure"
      ? {}
      : { note: `This function is not view/pure — the result is a simulation and nothing was written on-chain.${TRANSACT_ENABLED ? " Use transact to execute it." : ""}` }),
  };
}
