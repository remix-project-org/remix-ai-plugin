// ---------------------------------------------------------------------------
// Build flavours. ENABLE_TRANSACT=false turns this into a simulate-only server:
// transactions can be dry-run but never signed or sent from the chat, and the
// signing tools, signing page and its API are not exposed.
// ---------------------------------------------------------------------------

export const TRANSACT_ENABLED = !["false", "0", "no", "off"].includes((process.env.ENABLE_TRANSACT ?? "").trim().toLowerCase());
