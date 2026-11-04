import { Compiler } from "@remix-project/remix-solidity";
import { remixImportCallback } from "./imports.js";

const DEFAULT_VERSION = "v0.8.28+commit.7893614a";

const DEFAULT_SETTINGS = {
  optimizer: { enabled: false, runs: 200 },
  outputSelection: {
    "*": {
      "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"],
    },
  },
};

export interface CompileInput {
  sources: Record<string, { content: string }>;
  version?: string;
  settings?: Record<string, unknown>;
}

export interface CompileResult {
  success: boolean;
  contracts?: Record<string, unknown>;
  sources?: Record<string, unknown>;
  errors?: unknown[];
  version?: string;
  settings?: Record<string, unknown>;
}

export async function compileSolidity(input: CompileInput): Promise<CompileResult> {
  const { sources, version = DEFAULT_VERSION, settings = DEFAULT_SETTINGS } = input;

  // Imports not present in `sources` (e.g. @openzeppelin/contracts/...) are fetched on demand.
  const compiler = new Compiler(remixImportCallback);

  return new Promise<CompileResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Compilation timed out after 60 seconds"));
    }, 60_000);

    compiler.event.register("compilationFinished", (success: boolean, data: any) => {
      clearTimeout(timeout);

      if (success) {
        resolve({
          success: true,
          contracts: data.contracts,
          sources: data.sources,
          errors: data.errors?.filter((e: any) => e.severity === "warning") ?? [],
          version,
          settings: settings as Record<string, unknown>,
        });
      } else {
        resolve({
          success: false,
          // Import-resolution failures arrive as a single `error` rather than `errors`.
          errors: data.errors ?? (data.error ? [data.error] : []),
          version,
        });
      }
    });

    compiler.event.register("compilerLoaded", () => {
      compiler.compile(sources, "");
    });

    compiler.loadRemoteVersion(version);
  });
}
