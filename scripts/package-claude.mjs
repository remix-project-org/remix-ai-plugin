// Builds remix-solidity-plugin.zip from plugins/claude, with the MCP server URL
// in .mcp.json resolved to $BASE_URL/mcp (uploaded plugins don't expand env vars).
// The README names the same URL in its data-flow section, so it is rewritten too.
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const baseUrl = process.env.BASE_URL?.replace(/\/$/, "");
if (!baseUrl || !baseUrl.startsWith("https://")) {
  console.error("Set BASE_URL to the server's public https URL (in .env or the environment) before packaging.");
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
if (fs.readFileSync(path.join(root, "plugins/claude/README.md"), "utf-8").includes("<PRIVACY_POLICY_URL>")) {
  console.error("Replace <PRIVACY_POLICY_URL> in plugins/claude/README.md with the published privacy policy URL before packaging.");
  process.exit(1);
}
const out = path.join(root, "remix-solidity-plugin.zip");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remix-plugin-"));
// README.md and LICENSE are part of the submission: the review checks the
// plugin folder for both.
const entries = [".claude-plugin", ".mcp.json", "skills", "README.md", "LICENSE"];
try {
  for (const entry of entries) {
    fs.cpSync(path.join(root, "plugins/claude", entry), path.join(tmp, entry), { recursive: true });
  }
  const mcpPath = path.join(tmp, ".mcp.json");
  const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
  const sourceUrl = mcp.mcpServers["remix-solidity"].url;
  const url = `${baseUrl}/mcp`;
  mcp.mcpServers["remix-solidity"].url = url;
  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");

  const readmePath = path.join(tmp, "README.md");
  const readme = fs.readFileSync(readmePath, "utf-8");
  fs.writeFileSync(readmePath, readme.split(sourceUrl).join(url));

  fs.rmSync(out, { force: true });
  execFileSync("zip", ["-qr", out, ...entries], { cwd: tmp, stdio: "inherit" });
  console.log(`Wrote ${path.relative(process.cwd(), out)} → ${url}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
