import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Model mapping — three quality tiers, resolved per provider.
//
// AUDIT_PROVIDER selects the backend: "openai" (default), "anthropic" or
// "openrouter". Every concrete model id can be overridden with an env var so
// the plugin keeps working as model names change.
// ---------------------------------------------------------------------------

export const MODEL_TIERS = ["Fast", "Balanced", "Deep"] as const;
export type ModelName = (typeof MODEL_TIERS)[number];

/** Model names used by the original Claude plugin, kept so existing callers still work. */
const LEGACY_MODEL_ALIASES: Record<string, ModelName> = {
  DeepSeek: "Fast",
  Sonnet:   "Balanced",
  Fable:    "Deep",
};

const DEFAULT_MODEL: ModelName = "Balanced";

export type Provider = "openai" | "anthropic" | "openrouter";

export function provider(): Provider {
  const p = process.env.AUDIT_PROVIDER;
  return p === "anthropic" || p === "openrouter" ? p : "openai";
}

const OPENAI_MODELS: Record<ModelName, string> = {
  Fast:     process.env.OPENAI_MODEL_FAST     ?? "gpt-5-mini",
  Balanced: process.env.OPENAI_MODEL_BALANCED ?? "gpt-5",
  Deep:     process.env.OPENAI_MODEL_DEEP     ?? "gpt-5-pro",
};

const ANTHROPIC_MODELS: Record<ModelName, string> = {
  Fast:     process.env.ANTHROPIC_MODEL_FAST     ?? "claude-haiku-5-5",
  Balanced: process.env.ANTHROPIC_MODEL_BALANCED ?? "claude-sonnet-5-5",
  Deep:     process.env.ANTHROPIC_MODEL_DEEP     ?? "claude-opus-5-5",
};

const OPENROUTER_MODELS: Record<ModelName, string> = {
  Fast:     process.env.OPENROUTER_MODEL_FAST     ?? "openai/gpt-5-mini",
  Balanced: process.env.OPENROUTER_MODEL_BALANCED ?? "openai/gpt-5",
  Deep:     process.env.OPENROUTER_MODEL_DEEP     ?? "anthropic/claude-sonnet-4-6",
};

/** Ordered fallbacks tried when the primary model errors out. */
const MODEL_FALLBACKS: Record<string, string[]> = {
  "gpt-5-pro":  ["gpt-5", "gpt-4.1"],
  "gpt-5":      ["gpt-5-mini", "gpt-4.1"],
  "gpt-5-mini": ["gpt-4.1-mini", "gpt-4o-mini"],
  "claude-opus-5-5":   ["claude-sonnet-5-5"],
  "claude-sonnet-5-5": ["claude-haiku-5-5"],
  "openai/gpt-5":      ["openai/gpt-5-mini", "openai/gpt-4.1"],
  "openai/gpt-5-mini": ["openai/gpt-4.1-mini", "openai/gpt-4o-mini"],
  "anthropic/claude-sonnet-4-6": ["openai/gpt-5", "openai/gpt-4.1"],
};

export function mapModelName(name: string): string {
  const tier = (LEGACY_MODEL_ALIASES[name] ?? name) as ModelName;
  if (!MODEL_TIERS.includes(tier)) {
    throw new Error(`Invalid model: ${name}. Must be one of: ${MODEL_TIERS.join(", ")}`);
  }
  switch (provider()) {
    case "anthropic":  return ANTHROPIC_MODELS[tier];
    case "openrouter": return OPENROUTER_MODELS[tier];
    default:           return OPENAI_MODELS[tier];
  }
}

// ---------------------------------------------------------------------------
// LLM call with model fallback + retry (OpenAI / Anthropic / OpenRouter)
// ---------------------------------------------------------------------------

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LlmResult {
  content: string;
  model: string;
  tokensUsed: number;
}

function chatEndpoint(): { url: string; apiKey: string } {
  if (provider() === "openrouter") {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY environment variable is required when AUDIT_PROVIDER=openrouter");
    return { url: "https://openrouter.ai/api/v1/chat/completions", apiKey };
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable is required");
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  return { url: `${base}/chat/completions`, apiKey };
}

/** OpenAI-compatible chat completions (OpenAI, Azure, OpenRouter, proxies). */
async function callChatCompletions(
  messages: Message[],
  model: string,
  maxTokens: number,
  temperature: number
): Promise<LlmResult> {
  const { url, apiKey } = chatEndpoint();

  // Reasoning models reject `temperature` and rename the token budget field.
  const isReasoning = /^(o\d|gpt-5)/.test(model.replace(/^openai\//, ""));
  const body: Record<string, unknown> = {
    model,
    messages,
    response_format: { type: "json_object" },
    ...(isReasoning
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens, temperature }),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${provider()} ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };

  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("Empty response from model");

  const tokensUsed =
    data.usage?.total_tokens ??
    ((data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0));

  return { content, model: data.model ?? model, tokensUsed };
}

let anthropicClient: Anthropic | undefined;

/** Anthropic Messages API. Retries are handled by callLlm, so the SDK's own are disabled. */
async function callAnthropic(messages: Message[], model: string, maxTokens: number): Promise<LlmResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required when AUDIT_PROVIDER=anthropic");
  }
  anthropicClient ??= new Anthropic({ maxRetries: 0 });

  // Current Claude models reject sampling params, so `temperature` is not sent.
  const response = await anthropicClient.messages.create({
    model,
    max_tokens: maxTokens,
    system: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"),
    messages: messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  });

  if (response.stop_reason === "refusal") throw new Error(`${model} declined the request`);

  const content = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  if (!content) throw new Error("Empty response from model");

  return {
    content,
    model: response.model,
    tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
  };
}

async function callLlm(
  messages: Message[],
  primaryModel: string,
  maxTokens = 8192,
  temperature = 0.7
): Promise<LlmResult> {
  const modelsToTry = [primaryModel, ...(MODEL_FALLBACKS[primaryModel] ?? [])];

  for (let mi = 0; mi < modelsToTry.length; mi++) {
    const model = modelsToTry[mi]!;
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        return provider() === "anthropic"
          ? await callAnthropic(messages, model, maxTokens)
          : await callChatCompletions(messages, model, maxTokens, temperature);
      } catch (err: any) {
        const isLastAttempt = attempt === maxRetries;
        const isLastModel   = mi === modelsToTry.length - 1;
        if (isLastAttempt && isLastModel) {
          throw new Error(`All models failed. Last error: ${err.message}`);
        }
        if (isLastAttempt) break; // try next model
      }
    }
  }

  throw new Error("Exhausted all fallback models");
}

// ---------------------------------------------------------------------------
// Security audit category taxonomy for Solidity contracts
// ---------------------------------------------------------------------------

export const AUDIT_CATEGORIES = [
  // Access Control
  "Access Control::Missing Access Modifiers",
  "Access Control::Incorrect Role Assignment",
  "Access Control::Centralization Risk (Single Owner)",
  "Access Control::Missing Two-Step Ownership Transfer",
  "Access Control::Privilege Escalation",

  // Reentrancy
  "Reentrancy::Cross-Function Reentrancy",
  "Reentrancy::Cross-Contract Reentrancy",
  "Reentrancy::Read-Only Reentrancy",
  "Reentrancy::ERC777 / Callback-Based Reentrancy",

  // Arithmetic
  "Arithmetic::Integer Overflow / Underflow (pre-0.8)",
  "Arithmetic::Precision Loss / Rounding Errors",
  "Arithmetic::Division Before Multiplication",
  "Arithmetic::Incorrect Decimal Handling",

  // ERC Token Standards
  "ERC Token Standards::ERC20 Missing Return Value",
  "ERC Token Standards::ERC20 Approval Race Condition",
  "ERC Token Standards::ERC20 Deflationary / Fee-on-Transfer Tokens",
  "ERC Token Standards::ERC721 Missing SafeTransferFrom Checks",
  "ERC Token Standards::ERC4626 Inflation Attack",
  "ERC Token Standards::Non-Standard Token Compatibility",

  // Oracle & Price Feed
  "Oracle & Price Feed::Spot Price Manipulation",
  "Oracle & Price Feed::Stale Price Data (Missing Freshness Check)",
  "Oracle & Price Feed::Single-Oracle Dependency",
  "Oracle & Price Feed::TWAP Manipulation",

  // Flash Loans
  "Flash Loans::Flash Loan Price Oracle Manipulation",
  "Flash Loans::Flash Loan Reentrancy",
  "Flash Loans::Single-Block Liquidity Attacks",

  // External Calls
  "External Calls::Unchecked Return Values",
  "External Calls::Call to Untrusted Contracts",
  "External Calls::Delegatecall to Untrusted Contracts",
  "External Calls::Low-Level Call Forwarding Gas Issues",

  // Signature & Cryptography
  "Signature & Cryptography::Missing Signature Replay Protection",
  "Signature & Cryptography::Incorrect ecrecover Usage",
  "Signature & Cryptography::Signature Malleability",
  "Signature & Cryptography::Weak Randomness (block variables)",

  // Upgradability
  "Upgradability::Uninitialized Proxy Implementation",
  "Upgradability::Storage Collision in Proxy Pattern",
  "Upgradability::Missing Initializer Modifier",
  "Upgradability::Function Clashing",
  "Upgradability::Selfdestruct in Implementation",

  // Front-Running / MEV
  "Front-Running & MEV::Sandwich Attack Vulnerability",
  "Front-Running & MEV::Transaction Ordering Dependence",
  "Front-Running & MEV::Commit-Reveal Scheme Missing",

  // Denial of Service
  "Denial of Service::Unbounded Loop Gas Exhaustion",
  "Denial of Service::Block Gas Limit Dependency",
  "Denial of Service::Push vs Pull Payment Pattern",
  "Denial of Service::Selfdestruct ETH Forcing",

  // Logic & Business
  "Logic & Business::Incorrect Invariant / State Assumption",
  "Logic & Business::Missing Event Emission",
  "Logic & Business::Incorrect Calculation / Formula",
  "Logic & Business::Off-By-One Error",
  "Logic & Business::Missing Input Validation",
  "Logic & Business::Incorrect Deadline / Expiry Handling",

  // DeFi Protocol Specific
  "DeFi Protocol::AMM Slippage Not Enforced",
  "DeFi Protocol::Liquidity Pool K-Value Manipulation",
  "DeFi Protocol::Lending Protocol Undercollateralization",
  "DeFi Protocol::Liquidation Logic Error",
  "DeFi Protocol::Fee Accounting Error",

  // Governance
  "Governance::Flash Loan Governance Attack",
  "Governance::Timelock Missing or Too Short",
  "Governance::Quorum Manipulation",

  // Compiler & Low-Level
  "Compiler & Low-Level::Floating Pragma Version",
  "Compiler & Low-Level::Use of tx.origin for Auth",
  "Compiler & Low-Level::Timestamp Dependence",
  "Compiler & Low-Level::Assembly / Low-Level Operations",
  "Compiler & Low-Level::Incorrect ABI Encoding",
  "Compiler & Low-Level::Uninitialized Storage Pointer",
];

// ---------------------------------------------------------------------------
// Strip Solidity source to a skeleton (declarations only, no function bodies)
// ---------------------------------------------------------------------------

export function stripToSkeleton(source: string): string {
  // Remove single-line comments
  let code = source.replace(/\/\/[^\n]*/g, "");
  // Remove multi-line comments
  code = code.replace(/\/\*[\s\S]*?\*\//g, "");

  const lines = code.split("\n");
  const out: string[] = [];
  let depth = 0;
  let inFunctionBody = false;
  let functionDepthStart = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inFunctionBody) {
      const opens  = (line.match(/{/g) ?? []).length;
      const closes = (line.match(/}/g) ?? []).length;

      const isFunctionLike =
        /\b(function|modifier|constructor|receive|fallback)\b/.test(trimmed);

      out.push(line);

      if (opens > closes) {
        depth += opens - closes;
        if (isFunctionLike && depth > 1 && trimmed.includes("{")) {
          inFunctionBody = true;
          functionDepthStart = depth;
          out[out.length - 1] = line.replace(/{[\s\S]*$/, "{ /* ... */ }");
        }
      } else {
        depth = Math.max(0, depth + opens - closes);
      }
    } else {
      const opens  = (line.match(/{/g) ?? []).length;
      const closes = (line.match(/}/g) ?? []).length;
      depth += opens - closes;
      if (depth < functionDepthStart) {
        inFunctionBody = false;
        functionDepthStart = 0;
      }
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// get_audit_checklist
// ---------------------------------------------------------------------------

export interface AuditMatch {
  path: string;
  reason: string;
  confidence: "high" | "medium" | "low";
}

export interface AuditChecklistResult {
  success: boolean;
  markdown: string;
  matchedCategories: number;
  matches: AuditMatch[];
  skippedReason?: string;
  model: string;
  tokensUsed: number;
}

export async function getAuditChecklist(
  sources: Record<string, { content: string }>,
  maxCategories = 12,
  modelName: string = DEFAULT_MODEL
): Promise<AuditChecklistResult> {
  const resolvedModel = mapModelName(modelName);

  const skeletons = Object.entries(sources)
    .filter(([, f]) => f?.content)
    .map(([filename, f]) => ({ filename, skeleton: stripToSkeleton(f.content) }));

  const contractsSection = skeletons
    .map(({ filename, skeleton }) => `# Contract: ${filename}\n\`\`\`solidity\n${skeleton}\n\`\`\``)
    .join("\n\n");

  const categoryList = AUDIT_CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const systemMessage = `You map a Solidity contract onto a security-audit checklist taxonomy.

You are given a contract SKELETON (declarations only — function bodies stripped) and a fixed list of audit categories. Select every category whose checklist items would plausibly produce findings for this contract.

Rules:
1. Each "path" MUST be copied character-for-character from the supplied list. Never invent, rename, or abbreviate.
2. Base every match on evidence visible in the skeleton: imports, inherited bases, state variables, events, modifiers, or function signatures.
3. Prefer specific over generic. Also include cross-cutting categories (access control, external calls, centralization) when the skeleton shows the surface area.
4. Return at most the requested number of categories, ordered most to least confident, no duplicates.
5. "reason" is ONE short sentence naming the specific evidence.
6. "confidence": high = unmistakable, medium = likely, low = plausible but weakly evidenced.
7. If nothing applies, return an empty matches array and set skipped_reason.

Return ONLY valid JSON:
{"matches":[{"path":"exact category path","reason":"brief evidence","confidence":"high|medium|low"}],"skipped_reason":"optional"}`;

  const userMessage = `# Audit categories — choose ONLY from these ${AUDIT_CATEGORIES.length} paths\n\n${categoryList}\n\n---\n\n${contractsSection}\n\nReturn at most ${maxCategories} matches.`;

  const { content, model, tokensUsed } = await callLlm(
    [{ role: "system", content: systemMessage }, { role: "user", content: userMessage }],
    resolvedModel,
    4096
  );

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Model response did not contain valid JSON");

  const parsed = JSON.parse(jsonMatch[0]) as { matches?: AuditMatch[]; skipped_reason?: string };
  const matches = (parsed.matches ?? []).slice(0, maxCategories);

  const contractNames = skeletons.map((s) => s.filename).join(", ");
  const markdown = buildChecklistMarkdown(matches, contractNames);

  return { success: true, markdown, matchedCategories: matches.length, matches, skippedReason: parsed.skipped_reason, model, tokensUsed };
}

function buildChecklistMarkdown(matches: AuditMatch[], contractNames: string): string {
  const confidenceEmoji: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };
  const lines: string[] = [
    "# Security Audit Checklist",
    "",
    `**Contracts**: ${contractNames}`,
    `**Matched Categories**: ${matches.length}`,
    "",
    "---",
    "",
  ];

  const byGroup: Record<string, AuditMatch[]> = {};
  for (const m of matches) {
    const group = m.path.split("::")[0] ?? "Other";
    (byGroup[group] ??= []).push(m);
  }

  for (const [group, items] of Object.entries(byGroup)) {
    lines.push(`## ${group}`);
    lines.push("");
    for (const item of items) {
      const sub = item.path.split("::").slice(1).join(" > ");
      lines.push(`- **${sub}** ${confidenceEmoji[item.confidence] ?? ""} \`${item.confidence}\``);
      lines.push(`  - ${item.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// do_audit
// ---------------------------------------------------------------------------

export interface AuditFinding {
  title: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFORMATIONAL";
  description: string;
  location?: string;
  code?: string;
  impact?: string;
  remediation: string;
}

export interface DoAuditResult {
  success: boolean;
  markdown: string;
  findingsCount: number;
  severity: { critical: number; high: number; medium: number; low: number; informational: number };
  model: string;
  tokensUsed: number;
}

export async function doAudit(
  sources: Record<string, { content: string }>,
  checklist: string,
  modelName: string = DEFAULT_MODEL
): Promise<DoAuditResult> {
  const resolvedModel = mapModelName(modelName);

  const contractsSection = Object.entries(sources)
    .filter(([, f]) => f?.content)
    .map(([name, f]) => `## Contract: ${name}\n\`\`\`solidity\n${f.content}\n\`\`\``)
    .join("\n\n");

  const systemMessage = `You are an expert smart contract security auditor. Analyze the provided Solidity contracts against the given audit checklist and produce a comprehensive security audit report.

For each finding:
- Reference exact function names, state variables, or code patterns
- Severity: CRITICAL (funds always at risk), HIGH (likely funds at risk), MEDIUM (potential issue), LOW (best practice), INFORMATIONAL
- Provide clear, actionable remediation

Return ONLY valid JSON:
{"findings":[{"title":"Brief title","severity":"CRITICAL|HIGH|MEDIUM|LOW|INFORMATIONAL","description":"Detailed explanation","location":"ContractName::functionName","code":"optional snippet","impact":"What could happen","remediation":"How to fix"}],"summary":"Executive summary","recommendations":["General recommendation"]}`;

  const userMessage = `# Audit Checklist\n\n${checklist}\n\n---\n\n# Contracts\n\n${contractsSection}\n\nPerform a thorough security audit against every checklist item. Report all findings.`;

  const { content, model, tokensUsed } = await callLlm(
    [{ role: "system", content: systemMessage }, { role: "user", content: userMessage }],
    resolvedModel,
    8192
  );

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Model response did not contain valid JSON");

  const parsed = JSON.parse(jsonMatch[0]) as { findings?: AuditFinding[]; summary?: string; recommendations?: string[] };
  const findings      = parsed.findings ?? [];
  const summary       = parsed.summary ?? "No summary provided.";
  const recommendations = parsed.recommendations ?? [];

  const severity = {
    critical:      findings.filter((f) => f.severity === "CRITICAL").length,
    high:          findings.filter((f) => f.severity === "HIGH").length,
    medium:        findings.filter((f) => f.severity === "MEDIUM").length,
    low:           findings.filter((f) => f.severity === "LOW").length,
    informational: findings.filter((f) => f.severity === "INFORMATIONAL").length,
  };

  const markdown = buildAuditMarkdown(findings, summary, recommendations, severity, Object.keys(sources).join(", "));

  return { success: true, markdown, findingsCount: findings.length, severity, model, tokensUsed };
}

function buildAuditMarkdown(
  findings: AuditFinding[],
  summary: string,
  recommendations: string[],
  severity: DoAuditResult["severity"],
  contractNames: string
): string {
  const severityEmoji: Record<string, string> = {
    CRITICAL: "🔴", HIGH: "🟠", MEDIUM: "🟡", LOW: "🟢", INFORMATIONAL: "ℹ️",
  };

  const lines: string[] = [
    "# Security Audit Report",
    "",
    `**Contracts**: ${contractNames}`,
    `**Total Findings**: ${findings.length}`,
    "",
    "## Severity Breakdown",
    "",
    `- 🔴 **Critical**: ${severity.critical}`,
    `- 🟠 **High**: ${severity.high}`,
    `- 🟡 **Medium**: ${severity.medium}`,
    `- 🟢 **Low**: ${severity.low}`,
    `- ℹ️ **Informational**: ${severity.informational}`,
    "",
    "---",
    "",
    "## Executive Summary",
    "",
    summary,
    "",
    "---",
    "",
  ];

  const order: AuditFinding["severity"][] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL"];
  for (const sev of order) {
    const group = findings.filter((f) => f.severity === sev);
    if (!group.length) continue;
    lines.push(`## ${severityEmoji[sev]} ${sev} Severity Findings`);
    lines.push("");
    group.forEach((f, i) => {
      lines.push(`### ${i + 1}. ${f.title}`);
      lines.push("");
      lines.push(`**Severity**: ${sev}`);
      if (f.location) lines.push(`**Location**: \`${f.location}\``);
      lines.push("");
      lines.push("**Description**:");
      lines.push(f.description);
      lines.push("");
      if (f.code) {
        lines.push("**Code**:");
        lines.push("```solidity");
        lines.push(f.code);
        lines.push("```");
        lines.push("");
      }
      if (f.impact) {
        lines.push("**Impact**:");
        lines.push(f.impact);
        lines.push("");
      }
      lines.push("**Remediation**:");
      lines.push(f.remediation);
      lines.push("");
      lines.push("---");
      lines.push("");
    });
  }

  if (recommendations.length) {
    lines.push("## General Recommendations");
    lines.push("");
    recommendations.forEach((r) => lines.push(`- ${r}`));
    lines.push("");
  }

  return lines.join("\n");
}
