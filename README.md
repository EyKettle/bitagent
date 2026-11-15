# BitAgent

English | [中文](README.zh-Hans.md)

[![Conventional Commits][commit-badge]][conventional-commits]

BitAgent is a program-controlled LLM harness.
Write TypeScript files in your editor and execute them in one live instance; functions, variables and tasks remain available to later files until you explicitly clear them.
User workflows use `function*` and `yield*`, not Promise coordination.
The LLM is a stateless generator: code chooses its input, tools and stopping policy.

[Design outline (中文)][design] · [Official function][translator] · [User function][custom]

## Start the local playground

Use Node.js 24 or newer and pnpm 12.18.0.
From the repository root, start the tool-response fixture:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run mock:submit
```

Leave this terminal open.
The server listens on `http://127.0.0.1:4318`; it returns fixtures, not real translations, and needs no API credential.
Stop it with Ctrl+C in that terminal.

In a second terminal, from the same directory:

```sh
pnpm run console
```

Open `examples/workspace/` in your TypeScript editor.
The console creates a `tsconfig.json` only if none exists, and publishes live types through `.bitagent/globals.d.ts`.
Use the project's TypeScript version for the checked editor behavior.
Files that refer to definitions not yet executed can show missing-name diagnostics until those definitions exist.

The supplied [start.ts][start] contains:

```ts
import { createTranslator } from "@bitagent/core/skills";

const translate = createTranslator(llm, { maxAttempts: 2 });
const job = app.start(function* () {
  const result = yield* translate("你好", "English");
  return result;
});
```

In the console, run the actual file:

```text
.run start.ts
job.state
.run inspect.ts
```

`app.start()` returns a task immediately.
The coroutine suspends at `yield*` until a validated result is available; the instance still accepts other files.
Inspecting `job.state` shows its current state, not an implicit wait.
The fixture first submits an invalid value, receives a tool error, then submits `{ text: "Hello" }`.
The successful task has `status: "succeeded"` and that object in `value`.

### Control work from another file

After `start.ts`, try:

```text
.run wait.ts
waitingJob.state
.run cancel.ts
waitingJob.state
```

The `[wait]` fixture leaves the HTTP response open.
The second file can cancel it without running the first coroutine's result-dependent continuation.
Cancellation is cooperative: `cancelling` means requested, not settled.

To use a task's completed value inside another workflow, join it with a coroutine:

```ts
const report = app.start(function* () {
  const result = yield* job.join();
  console.log(result.text);
});
```

A join returns the typed result on success and throws on failure or cancellation.
Cancelling a joiner does not cancel the task it is observing.

## Keep and clear state explicitly

The console supplies `app` (scheduler), `llm` (model entity) and `scope` (definitions).
Definitions retain their real bindings: updating a variable in a later file is visible to closures that captured it.
Editing a source file alone does not replace a running definition.
Reusing a defined name requires explicit cleanup first.

| Operation | Effect |
| --- | --- |
| `.run <path>` | Check and execute a file; the rest of the line is its path, including spaces. |
| `job.state`, `app.list()` | Inspect tasks without waiting. |
| `job.cancel()` | Request cooperative cancellation. |
| `scope.list()` | Inspect retained definition handles. |
| `scope.forget(handle)` | Remove that name, not references already captured by other code. |
| `.clear` or `scope.clear()` | Forget all live names; keep tasks and captured references. |
| `app.forget(job)` | Remove a settled task from the scheduler's registry. |
| `.help` | Show console commands. |
| `.exit` | Exit this example host: cancel managed tasks and wait for cleanup. |

For example, select a handle from `scope.list()` and pass it to `scope.forget()`.
Cleanup is not object destruction or a rollback of effects.
The example also shuts down on EOF or a signal; it never stops the separate mock server.

## Build a reusable typed function

An official function has no privileged registration path.
[The translator][translator] and a user suite both compose `defineFunction` with ordinary code.
For an LLM-backed function, one TypeScript signature supplies its input and return contracts:

```ts
import { defineFunction } from "@bitagent/core";
import { answer } from "@bitagent/core/skills";

type Classify = (text: string) => { label: string; items: number };
const classify = defineFunction<Classify>(function* (result, text) {
  return yield* answer(llm, result, {
    system: "Use submit to return the declared result.",
    prompt: "[user-function] " + text,
    maxAttempts: 2,
  });
});
```

[custom.ts][custom] includes this function and a calling coroutine.
Run `.run custom.ts`, then inspect `customJob.state`.
The local fixture produces `"example:2"`; the marker selects a fixture, not a model feature.

`defineFunction` checks and snapshots arguments before scheduling its body, then validates its returned value.
The file compiler derives runtime schemas from the signature; no handwritten duplicate schema is needed.
Contracts require a concrete function signature and JSON-compatible data types.
Unsupported types such as `Date`, functions, `Promise`, `any` and `unknown`, and generic or overloaded function signatures, fail compilation instead of silently weakening validation.
Ordinary functions without a model contract do not have these restrictions.
Type conformance does not prove that a model's answer is correct.

### Choose the submit policy

`createSubmitTool(result)` constructs a parser and a `submit` declaration whose `value` parameter follows the return schema.
Parsing and deciding what to do with the answer are separate operations.
The official `answer` policy returns a tool error for invalid submissions, stops the request on a valid submission, and makes no extra final-text request.
`maxAttempts` bounds model generations, including the first one; transport failures are not blindly retried.
A user suite can choose a different policy using the same primitives.

### Distribute a user suite

Export ordinary functions from a TypeScript package.
Functions containing `defineFunction` need the contract transform before their JavaScript is loaded:

```js
// build.mjs — a package build step, not user workflow coordination
import { compileContractProject } from "@bitagent/core/node";
compileContractProject("./tsconfig.json");
```

Configure that package's TypeScript project to emit JavaScript and declarations, run `node build.mjs`, and export its built files.
A plain `tsc` build does not supply the runtime contract.
The BitAgent build uses this same public compiler for official functions; consumers of an already compiled package do not recompile it.
Declare `@bitagent/core` as a peer dependency in reusable suites so the host and suite use one runtime for coroutine primitives.
No central skill-name registry is required.

## Embed the public library

| Import | Purpose |
| --- | --- |
| `@bitagent/core` | Coroutine scheduler, typed functions, submit parsing and model contracts. |
| `@bitagent/core/skills` | Official functions and the bounded `answer` policy. |
| `@bitagent/core/pi` | `createPiEntity` for a caller-configured Pi model service and model. |
| `@bitagent/core/node` | File session, console, editor setup and contract compiler. |
| `@bitagent/core/host` | Async I/O adaptation and task settlement for host implementations. |

A host creates a scheduler and an entity, then calls `createFileSession({ app, llm, cwd })`.
`runFile(path)` and `evaluate(source)` return `{ value, definitions }` without joining tasks.
`initializeFileWorkspace(cwd)` supplies the editor configuration when absent; existing configurations must include `.bitagent/globals.d.ts` themselves.
`runFileConsole({ session })` provides terminal commands without owning application shutdown.
The [example host][console-host] owns cancellation and waiting when it exits.
Closing a file session disconnects its editor declarations but does not cancel application tasks.

The entity receives explicitly supplied messages and tool declarations, has no independent history, and does not execute tool calls automatically.
Application code can retain transcript messages through `onMessage`.
[The mock entity wiring][mock-wiring] shows explicit provider setup without credential discovery.
Lower-level `createApplication`, `createScriptConsole` and text-generation APIs remain for host integrations; they are not the coroutine file workflow's main interface.

## Execution boundaries

- Files are **trusted code with host-process privileges**, not a sandbox.
  `cwd` is an import base, not a filesystem restriction.
- Source and proposed live declarations are checked before user code executes.
  Names conflicting with ambient editor declarations are rejected.
  A runtime exception does not roll back earlier effects or initialized definitions.
- State survives individual files, not process restarts.
  `.bitagent/` holds editor declarations and immutable type snapshots, not durable task recovery.
  One live editor connection owns a workspace; a stale `session.lock` needs owner cleanup after confirming no session is using it.
- Model I/O suspends only the calling coroutine.
  Compilation and synchronous code still occupy the host event loop; CPU-bound work is not preempted.
- The file host loads CommonJS and synchronously loadable ESM dependencies.
  Import-only exports and dependencies requiring top-level `await` are not supported here.
  File entries cannot use top-level `await`; start a coroutine instead.
- This MVP has a Node host.
  Android embedding is not implemented or verified.

## Change fixtures and verify

`pnpm run mock:submit` runs the Messages-API preset on port `4318`.
The original `pnpm run mock:start` text preset remains on port `4317`.
Both disable request-body file logging, the admin API and database persistence.
LLMock still prints request-arrival and template-path diagnostics to the console; those notices do not mean request bodies were saved.
The example clients accept only loopback HTTP endpoints.

| Submit fixture input | Behavior |
| --- | --- |
| Translator call (`targetLanguage`) | Invalid submit, then valid `{ text: "Hello" }` after correction feedback. |
| `[user-function]` | Submit `{ label: "example", items: 2 }`. |
| `[wait]` | Stall the response for cancellation testing. |
| `[invalid]` | Keep submitting the wrong type until the attempt limit. |
| `[error]` | HTTP 500. |

The [configuration][mock-config] owns rule order and [fixtures][mock-fixtures] own response values.
Restart the appropriate mock after changing its configuration.
For a different submit port, use `node --import tsx dev/mock.mjs --model submit --port 4320` and `pnpm run console --base-url http://127.0.0.1:4320`.
Use `--cwd <directory>` to select another editor workspace.

```sh
pnpm run check
pnpm audit
```

The check builds contracts, checks strict types and the portable boundary, and runs [tests][tests], including editor diagnostics and HTTP workflows.
Tests own their temporary mock processes and need no real model or manually running server.

The dependency tree currently reports two moderate advisories: [glob cancellation][glob-advisory] and [minimatch amplification][minimatch-advisory], through `ts-json-schema-generator`.
BitAgent supplies an existing TypeScript Program and does not use that dependency's glob-based project discovery; the advisories remain in the installed tree and are not claimed fixed.

[commit-badge]: https://img.shields.io/badge/Conventional%20Commits-1.0.0-%23FE5196?logo=conventionalcommits&logoColor=white
[conventional-commits]: https://conventionalcommits.org
[design]: docs_zh-Hans/design.md
[translator]: src/skills/translate.ts
[custom]: examples/workspace/custom.ts
[start]: examples/workspace/start.ts
[console-host]: examples/console.mjs
[mock-wiring]: examples/mock-entity.mjs
[mock-config]: dev/llmock.json
[mock-fixtures]: dev/fixtures
[tests]: test
[glob-advisory]: https://github.com/advisories/GHSA-3g3m-2fjr-6pw4
[minimatch-advisory]: https://github.com/advisories/GHSA-g3hv-75wg-m249
