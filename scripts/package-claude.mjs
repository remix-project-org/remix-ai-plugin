// Builds remix-solidity-plugin.zip from plugins/claude, with the MCP server URL
// in .mcp.json resolved to $BASE_URL/mcp (uploaded plugins don't expand env vars).
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
const out = path.join(root, "remix-solidity-plugin.zip");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remix-plugin-"));
try {
  for (const entry of [".claude-plugin", ".mcp.json", "skills"]) {
    fs.cpSync(path.join(root, "plugins/claude", entry), path.join(tmp, entry), { recursive: true });
  }
  const mcpPath = path.join(tmp, ".mcp.json");
  const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
  mcp.mcpServers["remix-solidity"].url = `${baseUrl}/mcp`;
  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");

  fs.rmSync(out, { force: true });
  execFileSync("zip", ["-qr", out, ".claude-plugin", ".mcp.json", "skills"], { cwd: tmp, stdio: "inherit" });
  console.log(`Wrote ${path.relative(process.cwd(), out)} → ${baseUrl}/mcp`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
