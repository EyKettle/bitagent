# BitAgent

English | [中文](README.zh-Hans.md)

[![Conventional Commits][commit-badge]][conventional-commits]

BitAgent lets ordinary TypeScript programs control LLM work.
A persistent console retains your functions and variables; the application manages work that outlives an individual snippet.
The LLM generates text from explicit input, without an agent loop or independent memory.

[Design outline (中文)][design] · [Ordinary skill example][skill-source]

[commit-badge]: https://img.shields.io/badge/Conventional%20Commits-1.0.0-%23FE5196?logo=conventionalcommits&logoColor=white
[conventional-commits]: https://conventionalcommits.org
[design]: docs_zh-Hans/design.md
[skill-source]: src/skills/index.ts
[mock-config]: dev/llmock.json
[mock-fixtures]: dev/fixtures
[mock-wiring]: examples/mock-llm.mjs
[core-source]: src/index.ts
[pi-source]: src/pi.ts
[console-source]: src/node/index.ts
[tests]: test

## Try the local playground

Use Node.js 24 or newer and pnpm 12.18.0.
Run these commands from this repository's root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run mock:start
```

Leave that terminal open.
LLMock listens on `http://127.0.0.1:4317` and returns local fixtures; it uses no real model or API credential.
Stop it with Ctrl+C in that terminal.

In another terminal, from the same directory:

```sh
pnpm run console
```

The console provides typed `app` and `llm` values.
Enter these snippets:

```ts
import { summarize } from "@bitagent/core/skills";
const input = { text: "[summary]", instruction: "Summarize briefly." };
const job = app.start(({ signal }) => summarize(llm, input, signal));
```

The starting snippet ends without waiting for the job.
Later snippets still see the same variables and application:

```ts
job.state
await job.done
app.list()
```

`job.done` resolves to a tagged outcome: `succeeded`, `failed`, or `cancelled`.
Successful generation returns text and a `stop` or `length` finish reason.
A token limit is not an instruction to continue automatically.

To request cancellation while work is active:

```ts
job.cancel()
await job.done
```

Cancellation is cooperative: the function must use its signal.
`cancelling` is not a completed state, and code that ignores cancellation may still succeed.

Once a job has settled, remove it from the application's registry explicitly:

```ts
app.forget(job)
```

Existing references to that handle remain usable.

## Work in the console

Incomplete TypeScript is buffered for additional lines.
Complete snippets run in order; a top-level `await` blocks subsequent snippets until it settles.
Use `app.start()` for long work you want to control from later snippets.

| Command | Effect |
| --- | --- |
| `.help` | List terminal commands. |
| `.break` | Discard unfinished input. |
| `.clear` | Reset console definitions and types; keep application runs. |
| `.exit` | Request cancellation of managed work and wait for it to settle. |

Use `.clear` between snippets; `.break` first if input is unfinished.
EOF also closes the console.
Closing the console does not stop the separate mock server.
A reset does not destroy resources held by your code or references captured by running functions.

The console executes **trusted user code with the host process's permissions**.
It is not a sandbox, and TypeScript checks are not a security boundary.
Compile errors reject a snippet before execution; runtime errors do not roll back earlier side effects.
Scripts can block the process or ignore cancellation.

Definitions and runs live in memory, not across process restarts.
The Node console uses CommonJS loading: imports must be resolvable through `require`, and native ESM dependencies must support synchronous loading.
Import-only exports and dependencies with top-level `await` are not supported by this console.
This restriction concerns imported modules, not the console's own top-level `await`.

## Reuse the same public building blocks

| Import | Purpose |
| --- | --- |
| `@bitagent/core` | [Application run supervision and the text-generation interface][core-source]. |
| `@bitagent/core/pi` | [Explicit Pi model adapter][pi-source]. |
| `@bitagent/core/node` | [Persistent typed console for Node hosts][console-source]. |
| `@bitagent/core/skills` | [Ordinary functions using the same public interfaces][skill-source]. |

An official skill is an exported function, not a privileged plugin.
Write your own function, compose it with other functions, and pass it to `app.start()` when it needs a managed lifetime.
No registration or central skill-name list is required.

A host can embed `createScriptConsole({ app, llm, cwd })` and submit complete snippets through `evaluate(source)`.
Its result is `{ value: unknown }`; returned promises remain values unless the script explicitly awaits them.
`reset()` explicitly replaces the console's definitions.
`cwd` selects the import base, not an access restriction.

The Pi adapter accepts a caller-configured model service and model.
It sends only the explicit prompt and optional system instruction, streams text, and exposes errors without executing tools, retrying, or accumulating history.
[The mock wiring][mock-wiring] shows the adapter boundary without discovering credentials.

The portable entry does not import Node or Pi.
The console is Node-specific; Android embedding is not implemented or verified here.

## Change mock responses and verify changes

The [mock configuration][mock-config] selects [local fixtures][mock-fixtures].
Restart the mock process after changing its configuration.

| Prompt marker | Response |
| --- | --- |
| `[summary]` | The summary text fixture. |
| `[length]` | A truncated response with finish reason `length`. |
| `[error]` | HTTP 500. |
| No matching marker | The default fixed response. |

Markers are case-sensitive and the first matching rule wins.
Request logging, the admin interface, and database persistence are disabled in the development runner.
For another port, start `node --import tsx dev/mock.mjs --port 4318`, then use `pnpm run console --base-url http://127.0.0.1:4318/v1`.
The example client accepts only loopback HTTP endpoints.

```sh
pnpm run check
```

This builds the public entries, checks strict types and the portable boundary, and runs the [tests][tests].
HTTP tests start and close their own mock process on an available loopback port; they do not need your playground server or a real model.
