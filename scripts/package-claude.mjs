// Builds the Claude plugin zip for one build flavour, with the MCP server URL in
// .mcp.json resolved to $BASE_URL/mcp (uploaded plugins don't expand env vars):
//   full      plugins/claude           → remix-solidity-plugin.zip
//   simulate  plugins/claude-simulate  → remix-solidity-simulate-plugin.zip
// The README names the same host in its data-flow and privacy sections, so it is rewritten too.
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const flavours = {
  full: { dir: "plugins/claude", zip: "remix-solidity-plugin.zip" },
  simulate: { dir: "plugins/claude-simulate", zip: "remix-solidity-simulate-plugin.zip" },
};
const flavour = flavours[process.argv[2]];
if (!flavour) {
  console.error(`Usage: package-claude.mjs <${Object.keys(flavours).join("|")}>`);
  process.exit(1);
}

const baseUrl = process.env.BASE_URL?.replace(/\/$/, "");
if (!baseUrl || !baseUrl.startsWith("https://")) {
  console.error("Set BASE_URL to the server's public https URL (in the build's env file or the environment) before packaging.");
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
const pluginDir = path.join(root, flavour.dir);
if (fs.readFileSync(path.join(pluginDir, "README.md"), "utf-8").includes("<PRIVACY_POLICY_URL>")) {
  console.error(`Replace <PRIVACY_POLICY_URL> in ${flavour.dir}/README.md with the published privacy policy URL before packaging.`);
  process.exit(1);
}
const out = path.join(root, flavour.zip);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remix-plugin-"));
// README.md and LICENSE are part of the submission: the review checks the
// plugin folder for both.
const entries = [".claude-plugin", ".mcp.json", "skills", "README.md", "LICENSE"];
try {
  for (const entry of entries) {
    fs.cpSync(path.join(pluginDir, entry), path.join(tmp, entry), { recursive: true });
  }
  const mcpPath = path.join(tmp, ".mcp.json");
  const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
  const [serverName] = Object.keys(mcp.mcpServers);
  const sourceOrigin = new URL(mcp.mcpServers[serverName].url).origin;
  const url = `${baseUrl}/mcp`;
  mcp.mcpServers[serverName].url = url;
  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");

  const readmePath = path.join(tmp, "README.md");
  const readme = fs.readFileSync(readmePath, "utf-8");
  fs.writeFileSync(readmePath, readme.split(sourceOrigin).join(baseUrl));

  fs.rmSync(out, { force: true });
  execFileSync("zip", ["-qr", out, ...entries], { cwd: tmp, stdio: "inherit" });
  console.log(`Wrote ${path.relative(process.cwd(), out)} (${process.argv[2]}) → ${url}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
