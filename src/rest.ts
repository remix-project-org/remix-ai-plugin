// ---------------------------------------------------------------------------
// REST front door — the same five capabilities as plain JSON POST endpoints,
// described by openapi.ts so they can be imported as a custom GPT Action.
// ---------------------------------------------------------------------------

import { compile, transact, checkTransaction, auditChecklist, audit, type Sources } from "./actions.js";

export interface RestResult {
  status: number;
  body: unknown;
}

type Handler = (body: any) => Promise<unknown> | unknown;

/**
 * GPT Actions cannot send a free-form map as reliably as a list, so every
 * endpoint accepts either shape:
 *   sources: { "A.sol": { content: "…" } }
 *   sources: [ { filename: "A.sol", content: "…" } ]
 */
function normalizeSources(raw: unknown): Sources {
  if (Array.isArray(raw)) {
    const out: Sources = {};
    raw.forEach((item: any, i) => {
      const name = item?.filename ?? item?.name ?? `Contract${i === 0 ? "" : i}.sol`;
      if (typeof item?.content !== "string") throw new Error(`sources[${i}].content must be a string`);
      out[name] = { content: item.content };
    });
    if (!Object.keys(out).length) throw new Error("sources must contain at least one file");
    return out;
  }
  if (raw && typeof raw === "object") {
    const out: Sources = {};
    for (const [name, v] of Object.entries(raw as Record<string, any>)) {
      const content = typeof v === "string" ? v : v?.content;
      if (typeof content !== "string") throw new Error(`sources["${name}"] must be a string or { content }`);
      out[name] = { content };
    }
    if (!Object.keys(out).length) throw new Error("sources must contain at least one file");
    return out;
  }
  throw new Error("sources is required");
}

const handlers: Record<string, Handler> = {
  "/actions/compile": (body) =>
    compile({
      sources: normalizeSources(body?.sources),
      version: body?.version,
      settings: body?.settings,
    }),

  "/actions/transact": (body) => {
    if (typeof body?.data !== "string") throw new Error("data is required and must be a hex string");
    return transact({
      data: body.data,
      to: body.to,
      value: body.value,
      chainId: body.chainId,
      gasLimit: body.gasLimit,
      description: body.description,
    });
  },

  "/actions/check-transaction": (body) => {
    if (typeof body?.transactionId !== "string") throw new Error("transactionId is required");
    return checkTransaction(body.transactionId);
  },

  "/actions/audit-checklist": (body) =>
    auditChecklist({
      sources: normalizeSources(body?.sources),
      maxCategories: body?.maxCategories,
      model: body?.model,
    }),

  "/actions/audit": (body) => {
    if (typeof body?.checklist !== "string") throw new Error("checklist is required");
    return audit({
      sources: normalizeSources(body?.sources),
      checklist: body.checklist,
      model: body?.model,
    });
  },
};

export function isActionPath(pathname: string): boolean {
  return pathname in handlers;
}

export async function handleAction(pathname: string, body: unknown): Promise<RestResult> {
  const handler = handlers[pathname];
  if (!handler) return { status: 404, body: { error: "Unknown action" } };
  try {
    return { status: 200, body: await handler(body) };
  } catch (err: any) {
    return { status: 400, body: { success: false, error: err?.message ?? String(err) } };
  }
}
