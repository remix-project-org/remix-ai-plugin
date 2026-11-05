// ---------------------------------------------------------------------------
// Clear signing — turns a pending transaction into a human-readable review
// (intent + formatted fields + risk warnings) for the signing page and card.
//
// Sources, most trusted first:
//   1. ERC-7730 descriptor from the clear-signing registry for this contract
//      (or a generic ERC-20 / ERC-721 descriptor when the selector matches)
//   2. The contract's verified ABI on Sourcify (following proxies)
//   3. The ABI the assistant passed to transact — shown as unverified
//
// Implements the subset of ERC-7730 that calldata descriptors in the registry
// use: paths (#. $. @.), $ref definitions, field groups, visibility rules and
// the raw / amount / tokenAmount / addressName / date / duration / unit / enum
// / chainId / nftName / tokenTicker / calldata formats.
// https://eips.ethereum.org/EIPS/eip-7730
// ---------------------------------------------------------------------------

import { Contract, FunctionFragment, Interface, JsonRpcProvider, ParamType, formatUnits, getAddress, isAddress } from "ethers";
import { PUBLIC_RPCS } from "../rpcs.js";
import { parseAbi } from "./abi.js";

export type ReviewSource = "erc7730" | "verified" | "assistant" | "none";

export interface ReviewField {
  label: string;
  value: string;
  /** Checksummed address when the field is an address, so the page can link it and mark the user's own wallet. */
  address?: string;
  warning?: string;
}

export interface ReviewWarning {
  level: "danger" | "caution";
  text: string;
}

export interface TxReview {
  /** Short action, e.g. "Send", "Swap", "Deploy contract". */
  action: string;
  /** One-line summary, e.g. "Send 10 USDC to 0x2222…2222". */
  intent: string;
  source: ReviewSource;
  sourceDetail: string;
  contractName?: string;
  owner?: string;
  /** Function signature the description was matched on. */
  signature?: string;
  fields: ReviewField[];
  warnings: ReviewWarning[];
}

export interface ReviewInput {
  chainId?: number;
  to?: string;
  data: string;
  value?: string;
  /** ABI the assistant passed to transact, if any. */
  abi?: unknown;
  /** Constructor/function args the server encoded, used for deployments. */
  decodedArgs?: Array<{ name: string; type: string; value: unknown }>;
}

const REGISTRY_URL = (process.env.CLEAR_SIGNING_REGISTRY_URL ?? "https://raw.githubusercontent.com/ethereum/clear-signing-erc7730-registry/master").replace(/\/$/, "");
const SOURCIFY_URL = (process.env.SOURCIFY_URL ?? "https://sourcify.dev/server").replace(/\/$/, "");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 4000;
const UNLIMITED = 2n ** 255n;
const NATIVE_PLACEHOLDER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum", 11155111: "Sepolia", 137: "Polygon", 8453: "Base",
  84532: "Base Sepolia", 42161: "Arbitrum One", 10: "Optimism",
};
const NATIVE_SYMBOL: Record<number, string> = { 137: "POL" };

const chainName = (id?: number) => (id ? CHAIN_NAMES[id] ?? `chain #${id}` : "the selected network");
const nativeSymbol = (id?: number) => (id && NATIVE_SYMBOL[id]) || "ETH";
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// --- network helpers ---------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms = NETWORK_TIMEOUT_MS): Promise<T | undefined> {
  return Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(r, ms))]);
}

const jsonCache = new Map<string, { at: number; value: Promise<any> }>();

/** GET JSON with a shared in-memory cache; resolves undefined on any failure (404, timeout, bad JSON). */
function fetchJson(url: string): Promise<any> {
  const hit = jsonCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = withTimeout(
    fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) }).then((r) => (r.ok ? r.json() : undefined)),
  );
  jsonCache.set(url, { at: Date.now(), value });
  return value;
}

const providers = new Map<number, JsonRpcProvider>();
function provider(chainId?: number): JsonRpcProvider | undefined {
  if (!chainId || !PUBLIC_RPCS[chainId]) return undefined;
  if (!providers.has(chainId)) providers.set(chainId, new JsonRpcProvider(PUBLIC_RPCS[chainId], chainId, { staticNetwork: true }));
  return providers.get(chainId);
}

interface TokenInfo { symbol: string; decimals: number }
const tokenCache = new Map<string, Promise<TokenInfo | undefined>>();

function tokenInfo(chainId: number | undefined, address: string): Promise<TokenInfo | undefined> {
  const rpc = provider(chainId);
  if (!rpc || !isAddress(address)) return Promise.resolve(undefined);
  const key = `${chainId}:${address.toLowerCase()}`;
  if (!tokenCache.has(key)) {
    const erc20 = new Contract(address, ["function decimals() view returns (uint8)", "function symbol() view returns (string)"], rpc);
    tokenCache.set(key, withTimeout(
      Promise.all([erc20.decimals!(), erc20.symbol!()]).then(([d, s]) => ({ decimals: Number(d), symbol: String(s) })),
    ));
  }
  return tokenCache.get(key)!;
}

const ensCache = new Map<string, Promise<string | undefined>>();
function ensName(chainId: number | undefined, address: string): Promise<string | undefined> {
  if (chainId !== 1) return Promise.resolve(undefined);
  const rpc = provider(1)!;
  const key = address.toLowerCase();
  if (!ensCache.has(key)) ensCache.set(key, withTimeout(rpc.lookupAddress(address).then((n) => n ?? undefined)));
  return ensCache.get(key)!;
}

// --- descriptor loading ------------------------------------------------------

type Descriptor = Record<string, any>;

function deepMerge(base: any, over: any): any {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== "object" || typeof over !== "object" || !base || !over) return over ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

/** Loads a descriptor and merges its `includes` chain (the including file wins). */
async function loadDescriptor(url: string, depth = 0): Promise<Descriptor | undefined> {
  const json = await fetchJson(url);
  if (!json || typeof json !== "object") return undefined;
  if (typeof json.includes !== "string" || depth > 3) return json;
  const base = await loadDescriptor(new URL(json.includes, url).href, depth + 1);
  const { includes: _, ...rest } = json;
  return base ? deepMerge(base, rest) : rest;
}

async function registryDescriptor(chainId: number, to: string): Promise<{ descriptor: Descriptor; file: string } | undefined> {
  const index = await fetchJson(`${REGISTRY_URL}/index.calldata.json`);
  const file = index?.[`eip155:${chainId}:${to.toLowerCase()}`];
  if (typeof file !== "string") return undefined;
  const descriptor = await loadDescriptor(`${REGISTRY_URL}/${file}`);
  return descriptor ? { descriptor, file } : undefined;
}

/** Finds the display format whose signature matches the calldata selector. */
function matchFormat(descriptor: Descriptor, data: string) {
  const selector = data.slice(0, 10).toLowerCase();
  for (const [key, format] of Object.entries<any>(descriptor.display?.formats ?? {})) {
    try {
      const fragment = FunctionFragment.from(`function ${key}`);
      if (fragment.selector === selector) return { fragment, format };
    } catch { /* not a calldata key (e.g. EIP-712) */ }
  }
  return undefined;
}

// --- decoding ----------------------------------------------------------------

/** Converts an ethers Result into plain objects/arrays keyed by parameter names. */
function plain(type: ParamType, value: any): unknown {
  if (type.isArray()) return Array.from(value as unknown[], (v) => plain(type.arrayChildren!, v));
  if (type.isTuple()) {
    const out: Record<string, unknown> = {};
    type.components!.forEach((c, i) => { out[c.name || String(i)] = plain(c, value[i]); });
    return out;
  }
  return value;
}

function decodeArgs(fragment: FunctionFragment, data: string): Record<string, unknown> {
  const values = new Interface([fragment]).decodeFunctionData(fragment, data);
  const args: Record<string, unknown> = {};
  fragment.inputs.forEach((p, i) => { args[p.name || String(i)] = plain(p, values[i]); });
  return args;
}

// --- ERC-7730 rendering ------------------------------------------------------

interface Ctx {
  chainId?: number;
  to?: string;
  value: bigint;
  args: Record<string, unknown>;
  descriptor: Descriptor;
}

function navigate(root: unknown, path: string): unknown {
  let cur: unknown = root;
  const parts = path.split(".").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (cur === undefined || cur === null) return undefined;
    if (part === "[]") {
      if (!Array.isArray(cur)) return undefined;
      const rest = parts.slice(i + 1).join(".");
      return cur.map((el) => (rest ? navigate(el, rest) : el));
    }
    const index = part.match(/^\[(-?\d+)\]$/);
    if (index) {
      const n = Number(index[1]);
      if (Array.isArray(cur)) cur = cur.at(n);
      else if (typeof cur === "string" && cur.startsWith("0x")) cur = "0x" + cur.slice(2).slice(n * 2, n * 2 + 2 || undefined);
      else return undefined;
      continue;
    }
    const slice = part.match(/^\[(-?\d*):(-?\d*)\]$/);
    if (slice) {
      const a = slice[1] ? Number(slice[1]) : undefined;
      const b = slice[2] ? Number(slice[2]) : undefined;
      if (Array.isArray(cur)) cur = cur.slice(a, b);
      else if (typeof cur === "string" && cur.startsWith("0x")) {
        const bytes = cur.slice(2);
        const byteLen = bytes.length / 2;
        const from = a === undefined ? 0 : a < 0 ? byteLen + a : a;
        const to = b === undefined ? byteLen : b < 0 ? byteLen + b : b;
        cur = "0x" + bytes.slice(from * 2, to * 2);
      } else return undefined;
      continue;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function resolvePath(path: string, ctx: Ctx): unknown {
  if (path.startsWith("@.")) {
    const key = path.slice(2);
    if (key === "to") return ctx.to;
    if (key === "value") return ctx.value;
    if (key === "chainId") return ctx.chainId === undefined ? undefined : BigInt(ctx.chainId);
    return undefined; // @.from is only known to the wallet
  }
  if (path.startsWith("$.")) return navigate(ctx.descriptor, path.slice(2));
  return navigate(ctx.args, path.startsWith("#.") ? path.slice(2) : path);
}

const param = (spec: any, name: string, ctx: Ctx) =>
  spec.params?.[`${name}Path`] !== undefined ? resolvePath(spec.params[`${name}Path`], ctx) : spec.params?.[name];

function trimUnits(v: bigint, decimals: number): string {
  const s = formatUnits(v, decimals);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function formatDuration(seconds: bigint): string {
  let s = Number(seconds);
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60]] as const) {
    if (s >= size) { parts.push(`${Math.floor(s / size)}${unit}`); s %= size; }
  }
  if (s || !parts.length) parts.push(`${s}s`);
  return parts.join(" ");
}

async function addressLabel(address: string, ctx: Ctx, contractName?: string): Promise<string> {
  const checksummed = getAddress(address);
  if (ctx.to && address.toLowerCase() === ctx.to.toLowerCase()) return `${contractName ?? "This contract"} (${short(checksummed)})`;
  const ens = await ensName(ctx.chainId, checksummed);
  return ens ? `${ens} (${short(checksummed)})` : checksummed;
}

/** Formats one value according to an ERC-7730 field spec. */
async function formatValue(value: unknown, spec: any, ctx: Ctx): Promise<Omit<ReviewField, "label">> {
  if (Array.isArray(value)) {
    const parts = await Promise.all(value.map((v) => formatValue(v, spec, ctx)));
    return { value: parts.map((p) => p.value).join(", ") || "(none)", ...(parts.find((p) => p.warning) ? { warning: parts.find((p) => p.warning)!.warning } : {}) };
  }
  const big = typeof value === "bigint" ? value : undefined;
  const threshold = spec.params?.threshold !== undefined ? BigInt(spec.params.threshold) : undefined;
  const overThreshold = big !== undefined && threshold !== undefined && big >= threshold;

  switch (spec.format) {
    case "amount":
      if (big === undefined) break;
      if (overThreshold) return { value: spec.params?.message ?? "Unlimited" };
      return { value: `${trimUnits(big, 18)} ${nativeSymbol(ctx.chainId)}` };

    case "tokenAmount": {
      if (big === undefined) break;
      const tokenAddr = String(param(spec, "token", ctx) ?? "");
      const nativeAddrs = [spec.params?.nativeCurrencyAddress].flat().filter(Boolean).map((a: string) => String(resolvePath(a, ctx) ?? a).toLowerCase());
      const isNative = !tokenAddr || tokenAddr.toLowerCase() === NATIVE_PLACEHOLDER || nativeAddrs.includes(tokenAddr.toLowerCase());
      const isSelf = ctx.to && tokenAddr.toLowerCase() === ctx.to.toLowerCase();
      const token: TokenInfo | undefined = isNative
        ? { symbol: nativeSymbol(ctx.chainId), decimals: 18 }
        : (isSelf && ctx.descriptor.metadata?.token?.decimals !== undefined
          ? { symbol: ctx.descriptor.metadata.token.ticker, decimals: ctx.descriptor.metadata.token.decimals }
          : await tokenInfo(ctx.chainId, tokenAddr));
      if (overThreshold) return { value: `${spec.params?.message ?? "Unlimited"}${token ? ` ${token.symbol}` : ""}` };
      if (!token) return { value: `${big} (raw units of ${isAddress(tokenAddr) ? short(tokenAddr) : "unknown token"})`, warning: "Token decimals unknown — this is the raw integer amount." };
      return { value: `${trimUnits(big, token.decimals)} ${token.symbol}` };
    }

    case "addressName":
      if (typeof value !== "string" || !isAddress(value)) break;
      return { value: await addressLabel(value, ctx, ctx.descriptor.metadata?.contractName), address: getAddress(value) };

    case "tokenTicker": {
      if (typeof value !== "string" || !isAddress(value)) break;
      const token = await tokenInfo(ctx.chainId, value);
      return { value: token?.symbol ?? value, address: getAddress(value) };
    }

    case "nftName": {
      if (big === undefined) break;
      const collection = String(param(spec, "collection", ctx) ?? "");
      return { value: `#${big}${isAddress(collection) ? ` of ${short(getAddress(collection))}` : ""}` };
    }

    case "date":
      if (big === undefined) break;
      if (spec.params?.encoding === "blockheight") return { value: `Block #${big}` };
      if (big > 10n ** 12n) return { value: "Never" };
      return { value: new Date(Number(big) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") };

    case "duration":
      if (big === undefined) break;
      return { value: formatDuration(big) };

    case "unit":
      if (big === undefined) break;
      return { value: `${trimUnits(big, Number(spec.params?.decimals ?? 0))}${spec.params?.base ?? ""}` };

    case "enum": {
      const ref = spec.params?.$ref;
      const map = ref ? resolvePath(ref, ctx) as Record<string, string> | undefined : undefined;
      const label = map?.[String(value)];
      if (label) return { value: label };
      break;
    }

    case "chainId":
      if (big === undefined) break;
      return { value: `${CHAIN_NAMES[Number(big)] ?? "Chain"} (#${big})` };

    case "calldata": {
      const callee = param(spec, "callee", ctx);
      const size = typeof value === "string" ? Math.max(0, (value.length - 2) / 2) : 0;
      return {
        value: `Embedded call${typeof callee === "string" && isAddress(callee) ? ` to ${short(getAddress(callee))}` : ""} (${size} bytes)`,
        warning: "Contains a nested call that is not decoded here — review it in your wallet.",
      };
    }
  }
  return { value: rawString(value), ...(typeof value === "string" && isAddress(value) ? { address: getAddress(value) } : {}) };
}

function rawString(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === undefined || value === null) return "—";
  if (typeof value === "object") return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  return String(value);
}

function isHidden(spec: any, value: unknown): { hidden: boolean; warning?: string } {
  const v = spec.visible;
  if (v === "never") return { hidden: true };
  if (!v || typeof v !== "object") return { hidden: false };
  const eq = (list: unknown[]) => list.some((x) => String(x).toLowerCase() === rawString(value).toLowerCase());
  if (Array.isArray(v.ifNotIn)) return { hidden: eq(v.ifNotIn) };
  if (Array.isArray(v.mustMatch)) {
    return eq(v.mustMatch) ? { hidden: true } : { hidden: false, warning: `Unexpected value — expected ${v.mustMatch.join(" or ")}.` };
  }
  return { hidden: false };
}

/** Flattens $ref definitions and nested groups into concrete field specs with absolute paths. */
function expandFields(fields: any[], ctx: Ctx, prefix = ""): any[] {
  const out: any[] = [];
  for (const raw of fields ?? []) {
    let spec = raw;
    if (typeof spec?.$ref === "string") {
      const def = resolvePath(spec.$ref, ctx) as any;
      spec = { ...def, ...spec, params: { ...def?.params, ...spec.params } };
    }
    const path = spec.path && prefix && !/^[#$@]\./.test(spec.path) ? `${prefix}.${spec.path}` : spec.path;
    if (Array.isArray(spec.fields)) {
      const target = path ? resolvePath(path, ctx) : undefined;
      if (Array.isArray(target)) target.forEach((_, i) => out.push(...expandFields(spec.fields, ctx, `${path}.[${i}]`)));
      else out.push(...expandFields(spec.fields, ctx, path ?? prefix));
      continue;
    }
    out.push({ ...spec, path });
  }
  return out;
}

async function renderDescriptor(descriptor: Descriptor, data: string, base: { chainId?: number; to?: string; value: bigint }) {
  const match = matchFormat(descriptor, data);
  if (!match) return undefined;
  const ctx: Ctx = { ...base, args: decodeArgs(match.fragment, data), descriptor };
  const specs = expandFields(match.format.fields ?? [], ctx);
  const fields: ReviewField[] = [];
  const byPath = new Map<string, string>();
  for (const spec of specs) {
    const value = spec.path !== undefined ? resolvePath(spec.path, ctx) : spec.value;
    const visibility = isHidden(spec, value);
    const formatted = await formatValue(value, spec, ctx);
    if (spec.path) byPath.set(spec.path.replace(/^#\./, ""), formatted.value);
    if (visibility.hidden) continue;
    fields.push({ label: spec.label ?? spec.path ?? "Value", ...formatted, ...(visibility.warning ? { warning: visibility.warning } : {}) });
  }
  const action = typeof match.format.intent === "string"
    ? capitalize(match.format.intent)
    : Object.keys(match.format.intent ?? {}).join(", ") || capitalize(match.fragment.name);
  let intent = action;
  if (typeof match.format.interpolatedIntent === "string") {
    const interpolated = match.format.interpolatedIntent.replace(/\{([^}]+)\}/g, (_: string, p: string) => byPath.get(p.replace(/^#\./, "")) ?? `{${p}}`);
    if (!/\{[^}]+\}/.test(interpolated)) intent = interpolated;
  } else {
    intent = summarize(action, fields);
  }
  return { fragment: match.fragment, args: ctx.args, action, intent, fields };
}

/** Headline for formats without an interpolatedIntent, e.g. "Send 2.5 USDC to 0x2222…2222". */
function summarize(action: string, fields: ReviewField[]): string {
  const val = (label: string) => {
    const f = fields.find((x) => x.label.toLowerCase() === label);
    return f && (f.address && f.value === f.address ? short(f.address) : f.value);
  };
  if (action === "Send" && val("amount") && val("to")) return `Send ${val("amount")} to ${val("to")}`;
  if (action === "Approve" && val("amount") && val("spender")) return `Allow ${val("spender")} to spend ${val("amount")}`;
  const shown = fields.slice(0, 2).map((f) => (f.address && f.value === f.address ? short(f.address) : f.value));
  return shown.length ? `${action} · ${shown.join(" · ")}` : action;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

// --- ABI-only rendering (verified or assistant ABI) ---------------------------

function inferredSpec(type: ParamType): any {
  if (type.baseType === "address") return { format: "addressName" };
  return { format: "raw" };
}

async function renderAbi(fragment: FunctionFragment, data: string, base: { chainId?: number; to?: string; value: bigint }, contractName?: string) {
  const ctx: Ctx = { ...base, args: decodeArgs(fragment, data), descriptor: { metadata: { contractName } } };
  const fields: ReviewField[] = [];
  const walk = async (type: ParamType, value: unknown, label: string) => {
    if (type.isTuple() && value && typeof value === "object" && !Array.isArray(value)) {
      for (const c of type.components!) await walk(c, (value as Record<string, unknown>)[c.name], `${label}.${c.name}`);
      return;
    }
    fields.push({ label, ...(await formatValue(value, inferredSpec(type.isArray() ? type.arrayChildren! : type), ctx)) });
  };
  for (const [i, p] of fragment.inputs.entries()) await walk(p, ctx.args[p.name || String(i)], p.name || `arg${i}`);
  return { args: ctx.args, action: `Call ${fragment.name}`, intent: `Call ${fragment.name}${contractName ? ` on ${contractName}` : ""}`, fields };
}

async function sourcifyAbi(chainId: number, to: string): Promise<{ abi: unknown[]; name?: string } | undefined> {
  const info = await fetchJson(`${SOURCIFY_URL}/v2/contract/${chainId}/${getAddress(to)}?fields=abi,compilation,proxyResolution`);
  if (!Array.isArray(info?.abi)) return undefined;
  const impl = info.proxyResolution?.isProxy ? info.proxyResolution.implementations?.[0] : undefined;
  if (impl?.address) {
    const implInfo = await fetchJson(`${SOURCIFY_URL}/v2/contract/${chainId}/${getAddress(impl.address)}?fields=abi,compilation`);
    if (Array.isArray(implInfo?.abi)) {
      return { abi: [...implInfo.abi, ...info.abi], name: implInfo.compilation?.name ?? impl.name ?? info.compilation?.name };
    }
  }
  return { abi: info.abi, name: info.compilation?.name };
}

function fragmentFor(abi: unknown, data: string): FunctionFragment | undefined {
  try {
    return parseAbi(abi).getFunction(data.slice(0, 10)) ?? undefined;
  } catch {
    return undefined;
  }
}

// --- risk heuristics -----------------------------------------------------------

function riskWarnings(fragment: FunctionFragment | undefined, args: Record<string, unknown>, fields: ReviewField[]): ReviewWarning[] {
  if (!fragment) return [];
  const warnings: ReviewWarning[] = [];
  const name = fragment.name;
  const values = fragment.inputs.map((p, i) => args[p.name || String(i)]);
  const amount = values.find((v) => typeof v === "bigint") as bigint | undefined;
  const spender = values.find((v) => typeof v === "string" && isAddress(v)) as string | undefined;
  const label = spender ? fields.find((f) => f.address === getAddress(spender))?.value : undefined;
  const who = spender ? (label && label !== getAddress(spender) ? label : short(getAddress(spender))) : "the spender";

  if (["approve", "increaseAllowance", "permit"].includes(name) && amount !== undefined && amount >= UNLIMITED) {
    warnings.push({ level: "danger", text: `Unlimited approval: ${who} will be able to move all of this token from your wallet, now and later.` });
  }
  if (name === "setApprovalForAll" && values.includes(true)) {
    warnings.push({ level: "danger", text: `${who} will be able to transfer every NFT you own in this collection.` });
  }
  if (["transferOwnership", "renounceOwnership", "upgradeTo", "upgradeToAndCall", "changeAdmin"].includes(name)) {
    warnings.push({ level: "caution", text: "This changes who controls the contract or the code it runs." });
  }
  return warnings;
}

// --- entry point ------------------------------------------------------------------

/** Builds the clear-signing review for a transaction. Never throws; falls back to less-trusted sources. */
export async function buildReview(input: ReviewInput): Promise<TxReview> {
  const value = BigInt(input.value ?? 0);
  const base = { chainId: input.chainId, to: input.to, value };
  const warnings: ReviewWarning[] = [];
  const valueField: ReviewField[] = value > 0n ? [{ label: "Sends", value: `${trimUnits(value, 18)} ${nativeSymbol(input.chainId)}` }] : [];

  if (!PUBLIC_RPCS[input.chainId ?? 0]) {
    warnings.push({ level: "caution", text: `Token amounts and contract checks aren't available on ${chainName(input.chainId)} — review the technical details carefully.` });
  }

  // Deployment: nothing on-chain to verify against yet.
  if (!input.to) {
    const fields: ReviewField[] = [
      ...(input.decodedArgs ?? []).map((a) => ({ label: a.name || a.type, value: rawString(a.value), ...(typeof a.value === "string" && isAddress(a.value) ? { address: getAddress(a.value) } : {}) })),
      { label: "Creation code", value: `${Math.max(0, (input.data.length - 2) / 2).toLocaleString("en-US")} bytes` },
      ...valueField,
    ];
    return {
      action: "Deploy contract",
      intent: `Deploy a new contract on ${chainName(input.chainId)}`,
      source: input.decodedArgs ? "assistant" : "none",
      sourceDetail: "A new contract has no verified code yet. The bytecode and constructor arguments come from this chat.",
      fields,
      warnings,
    };
  }

  const to = getAddress(input.to);
  const rpc = provider(input.chainId);
  const code = rpc ? await withTimeout(rpc.getCode(to)) : undefined;
  if (code === "0x" && input.data !== "0x") {
    warnings.push({ level: "danger", text: `There is no contract at ${short(to)} on ${chainName(input.chainId)}. Check the address and network — the call data would be ignored.` });
  }
  if (input.data === "0x" || input.data.length < 10) {
    return {
      action: "Send",
      intent: `Send ${trimUnits(value, 18)} ${nativeSymbol(input.chainId)} to ${short(to)}`,
      source: "none",
      sourceDetail: "Plain transfer — there is no contract call to describe.",
      fields: [{ label: "To", value: (await ensName(input.chainId, to)) ?? to, address: to }, ...valueField],
      warnings,
    };
  }

  const assistantFragment = input.abi !== undefined ? fragmentFor(input.abi, input.data) : undefined;
  if (input.abi !== undefined && !assistantFragment) {
    warnings.push({ level: "danger", text: `The ABI the assistant provided has no function matching this call (${input.data.slice(0, 10)}), so its description of the call can't be trusted.` });
  }
  const mismatch = (signature: string, label: string): ReviewWarning[] =>
    assistantFragment && assistantFragment.format("sighash") !== signature
      ? [{ level: "danger", text: `The assistant described this as ${assistantFragment.format("sighash")}, but the ${label} says it is ${signature}.` }]
      : [];

  // 1. ERC-7730 registry descriptor for this exact deployment
  if (input.chainId) {
    const entry = await registryDescriptor(input.chainId, to);
    const rendered = entry ? await renderDescriptor(entry.descriptor, input.data, base).catch(() => undefined) : undefined;
    if (entry && rendered) {
      const meta = entry.descriptor.metadata ?? {};
      return {
        action: rendered.action,
        intent: rendered.intent,
        source: "erc7730",
        sourceDetail: `Clear-signing descriptor from the ERC-7730 registry${meta.owner ? `, published for ${meta.owner}` : ""}.`,
        contractName: meta.contractName ?? entry.descriptor.context?.$id,
        owner: meta.owner,
        signature: rendered.fragment.format("sighash"),
        fields: [...rendered.fields, ...valueField],
        warnings: [...warnings, ...mismatch(rendered.fragment.format("sighash"), "clear-signing descriptor"), ...riskWarnings(rendered.fragment, rendered.args, rendered.fields)],
      };
    }
  }

  // 2. Verified source on Sourcify, then generic ERC-20 / ERC-721 descriptors on top of it
  const verified = input.chainId ? await sourcifyAbi(input.chainId, to) : undefined;
  const verifiedFragment = verified ? fragmentFor(verified.abi, input.data) : undefined;
  const generic = await genericDescriptor(input, base, to);
  if (generic && (!verified || verifiedFragment?.selector === generic.fragment.selector)) {
    const token = await tokenInfo(input.chainId, to);
    return {
      action: generic.action,
      intent: generic.intent,
      source: verifiedFragment ? "verified" : "erc7730",
      sourceDetail: verifiedFragment
        ? `Verified contract${verified?.name ? ` ${verified.name}` : ""} on Sourcify, shown with the standard ${generic.standard} clear-signing format.`
        : `Standard ${generic.standard} clear-signing format. The contract source is not verified, so the token itself is unconfirmed.`,
      contractName: token ? `${token.symbol} token` : verified?.name,
      signature: generic.fragment.format("sighash"),
      fields: [...generic.fields, ...valueField],
      warnings: [...warnings, ...mismatch(generic.fragment.format("sighash"), "token standard"), ...riskWarnings(generic.fragment, generic.args, generic.fields)],
    };
  }
  if (verifiedFragment) {
    const rendered = await renderAbi(verifiedFragment, input.data, base, verified!.name);
    if (value > 0n && !verifiedFragment.payable) {
      warnings.push({ level: "danger", text: `${verifiedFragment.name} does not accept ${nativeSymbol(input.chainId)} — this transaction will revert.` });
    }
    return {
      ...rendered,
      source: "verified",
      sourceDetail: `Decoded with the verified source of ${verified!.name ?? "this contract"} on Sourcify.`,
      contractName: verified!.name,
      signature: verifiedFragment.format("sighash"),
      fields: [...rendered.fields, ...valueField],
      warnings: [...warnings, ...mismatch(verifiedFragment.format("sighash"), "verified contract"), ...riskWarnings(verifiedFragment, rendered.args, rendered.fields)],
    };
  }
  if (verified && !verifiedFragment) {
    warnings.push({ level: "danger", text: `The verified contract${verified.name ? ` ${verified.name}` : ""} has no function with selector ${input.data.slice(0, 10)}.` });
  }

  // 3. The assistant's ABI — readable, but not independently confirmed
  if (assistantFragment) {
    const rendered = await renderAbi(assistantFragment, input.data, base);
    if (value > 0n && !assistantFragment.payable) {
      warnings.push({ level: "caution", text: `According to the assistant's ABI, ${assistantFragment.name} does not accept ${nativeSymbol(input.chainId)}, so this would revert.` });
    }
    return {
      ...rendered,
      source: "assistant",
      sourceDetail: "This contract is not verified and has no clear-signing descriptor. The names below come from the ABI the assistant provided and could not be checked against the contract.",
      signature: assistantFragment.format("sighash"),
      fields: [...rendered.fields, ...valueField],
      warnings: [...warnings, ...riskWarnings(assistantFragment, rendered.args, rendered.fields)],
    };
  }

  return {
    action: "Contract call",
    intent: `Call an unknown function (${input.data.slice(0, 10)}) on ${short(to)}`,
    source: "none",
    sourceDetail: "No descriptor, verified source or ABI is available — only the raw data can be shown.",
    fields: [{ label: "Contract", value: to, address: to }, ...valueField],
    warnings: [...warnings, { level: "caution", text: "This is blind signing: the transaction can't be decoded. Only continue if you trust where it came from." }],
  };
}

async function isErc721(chainId: number | undefined, address: string): Promise<boolean> {
  const rpc = provider(chainId);
  if (!rpc) return false;
  const c = new Contract(address, ["function supportsInterface(bytes4) view returns (bool)"], rpc);
  return Boolean(await withTimeout(c.supportsInterface!("0x80ac58cd")));
}

const GENERIC_DESCRIPTORS = [
  { standard: "ERC-20", file: "ercs/calldata-erc20-tokens.json", detect: async (chainId: number | undefined, to: string) => Boolean(await tokenInfo(chainId, to)) },
  { standard: "ERC-721", file: "ercs/calldata-erc721-nfts.json", detect: isErc721 },
];

/** Applies a generic ERC descriptor when the selector matches and the target really implements that standard. */
async function genericDescriptor(input: ReviewInput, base: { chainId?: number; to?: string; value: bigint }, to: string) {
  for (const g of GENERIC_DESCRIPTORS) {
    if (!(await g.detect(input.chainId, to))) continue;
    const descriptor = await loadDescriptor(`${REGISTRY_URL}/${g.file}`);
    const rendered = descriptor ? await renderDescriptor(descriptor, input.data, base).catch(() => undefined) : undefined;
    if (rendered) return { ...rendered, standard: g.standard };
  }
  return undefined;
}
