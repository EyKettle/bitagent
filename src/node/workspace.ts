import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface FileWorkspace {
  readonly configPath: string;
  readonly created: boolean;
}

/** Creates an editor configuration only when the workspace has none. */
export function initializeFileWorkspace(directory: string): FileWorkspace {
  const cwd = resolve(directory);
  mkdirSync(cwd, { recursive: true });
  const configPath = join(cwd, "tsconfig.json");
  const config = {
    compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", moduleDetection: "force",
      lib: ["ES2022", "DOM"], types: [], strict: true, noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true, skipLibCheck: false, noEmit: true,
    },
    files: [".bitagent/globals.d.ts"],
    include: ["**/*.ts", "**/*.mts", "**/*.cts"],
    exclude: ["node_modules", ".bitagent", ".build", "dist"],
  };
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
    return Object.freeze({ configPath, created: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      return Object.freeze({ configPath, created: false });
    }
    throw error;
  }
}
