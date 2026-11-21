import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";

// This directory is exclusively the output of tsconfig.build.json.
rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
const require = createRequire(import.meta.url);
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json"], { stdio: "inherit" });
