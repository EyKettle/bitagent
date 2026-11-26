import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// Preserve .build/verification and all other historical/unknown workspaces.
rmSync(new URL("../.build/test/", import.meta.url), { recursive: true, force: true });
const require = createRequire(import.meta.url);
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.test.json"], { stdio: "inherit" });
function tests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? tests(path) : /\.test\.(m?js)$/.test(entry.name) ? [path] : [];
  });
}
const files = [".build/test/runtime", "test/types", "test/llmock", "test/program"].flatMap(tests).sort();
const result = spawnSync(process.execPath, ["--test", "--test-timeout=15000", "--test-concurrency=1", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) throw new Error("Test runner terminated by " + result.signal);
process.exitCode = result.status ?? 1;
