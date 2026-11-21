# BitAgent

English | [中文](README.zh-Hans.md)

BitAgent is a program-controlled LLM harness.
This exploration baseline provides structured coroutine Jobs and Host execution boundaries.

[Jobs API (中文)][jobs] · [Host API (中文)][host] · [Architecture (中文)][architecture]

[jobs]: docs/zh-Hans/api/jobs.md
[host]: docs/zh-Hans/api/host.md
[architecture]: docs/zh-Hans/architecture.md
[organization]: docs/zh-Hans/source-organization.md
[mock-config]: dev/llmock/config.json
[mock-payloads]: dev/llmock/payloads

## Build and verify

Use Node.js 24 or newer and pnpm 12.18.0 from the package root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
```

The check builds fresh JavaScript and declarations, checks strict and portable types, and runs all runtime, public-type and local HTTP fixtures.
Tests manage their own loopback processes and need no API credentials.
`pnpm run build` replaces only `dist/`; the test command replaces only `.build/test/` and preserves verification archives.
The [source organization][organization] identifies each implementation and test owner.

## Run a Job

After building, run this as an ES module in the package:

```js
import { Job } from "@bitagent/core";
import { createExecutionRoot, fromAsync, waitForJob } from "@bitagent/core/host";

const root = createExecutionRoot();
try {
  const job = root.run(() => Job.spawn(function* () {
    return yield* fromAsync(async () => 42);
  }));
  console.log(await waitForJob(job)); // { state: "finished", value: 42 }
} finally {
  await root.close();
}
```

Jobs use synchronous generators and `yield*`; their handles expose state and outcomes without being Promises.
Creation fixes ownership.
Cancellation is cooperative and terminal publication waits for owned work and actual Host operation completion.
Host adapters include resource release in their completion; synchronous work must yield to keep control responsive.
The [Jobs][jobs] and [Host][host] references define cancellation, cleanup, failure identity and type constraints.

## Run synthetic HTTP fixtures

```sh
pnpm run mock:start
pnpm run mock:submit
```

Run these in separate terminals: the text preset uses port 4317 and the Messages/tool-payload preset uses 4318.
Both bind to loopback, disable database persistence and request-body file logging, and stop with Ctrl+C.
Their [configuration][mock-config] and [payloads][mock-payloads] are independent development assets for provider protocol tests.
For an ephemeral port use `node --import tsx dev/llmock/server.mjs --port 0`.
