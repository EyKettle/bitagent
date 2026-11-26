# BitAgent Core

A continuous typed TypeScript application with structured Jobs, real definitions, fixed compilation versions and runtime data contracts.

[中文](README.zh-Hans.md)

## Build and verify

The reference toolchain is Node.js 24+, pnpm 12.18.0 and TypeScript 5.9.3.

```sh
pnpm install --frozen-lockfile
pnpm run check
```

Checking and compilation use the ordinary project compiler.
There is no MVP transformer, REPL, console or model adapter.

## Embed a typed application

A Node embedding supplies an explicit workspace directory URL:

```js
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createState } from "@bitagent/core/state";
import { createTypeScriptCompiler } from "@bitagent/core/node";
import { createExecutionRoot, createCompilerSession, waitForJob } from "@bitagent/core/host";

const baseURL = pathToFileURL(resolve(".") + "/");
const root = createExecutionRoot();
const state = createState();
const compiler = createTypeScriptCompiler({ baseURL });
const session = createCompilerSession({ state, root, compiler });
try {
  const job = root.run(() => session.prepare({
    kind: "text", url: new URL("input.ts", baseURL), text: "let count = 1; count",
  }));
  const outcome = await waitForJob(job);
  if (outcome.state !== "finished" || outcome.value.kind !== "ready") {
    throw new Error("Preparation did not produce an executable input");
  }
  console.log(session.execute(outcome.value.input));
  console.log(state.value(state.find("count")));
} finally {
  const results = await Promise.allSettled([session.close(), compiler.close(), root.close()]);
  const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, "Application shutdown failed");
}
```

Successive inputs refer to adopted earlier definitions.
Removal uses authentic definition handles.
Prepared inputs are once-only and reject stale structure before effects.
State does not serialize or copy bindings.
Preparation belongs to its caller; synchronous execution enters the application's root so business Jobs can survive input return.

The public entries are `@bitagent/core` (Jobs, contracts, functions and tool metadata), `@bitagent/core/host` (roots, publication and Session), `@bitagent/core/state`, `@bitagent/core/compiler` (neutral contracts), and `@bitagent/core/node` (the TypeScript implementation).

## Adapter boundary

The Node adapter captures local TypeScript modules and their declarations before execution.
Core imports retain the actual package singleton.
Native synchronous ESM preserves live exports, cycles and cached initialization failure.
Top-level await, dynamic imports and unsupported external runtime packages receive diagnostics rather than mismatched types and execution.

Known concrete data shapes generate runtime adoption checks and an immutable JSON Schema projection.
Unrepresentable shapes fail compilation.
Tool construction in this stage supplies metadata and parameter parsing; dispatch and model integration belong to later stages.

## Local fixtures and measurements

```sh
pnpm run mock:start
node dev/benchmark/program.mjs /tmp/new-command-engine-samples.json
```

The independent LLMock process and raw HTTP payloads support future provider tests, not a hidden product adapter.
Tests own listeners, child processes and temporary workspaces.
The benchmark requires a new output path and reports public prepare/execute/State/control latency, cold/changed/scale cases and raw samples.
Business or network work is not engine overhead.

- [Jobs API](docs/zh-Hans/api/jobs.md)
- [Source and Session](docs/zh-Hans/api/compiler.md)
- [Source responsibilities](docs/zh-Hans/source-organization.md)
