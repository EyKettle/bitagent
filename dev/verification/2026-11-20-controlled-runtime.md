# Controlled runtime implementation verification

Stage 1 implements `Runtime/Jobs` and `Runtime/Host` in the `exploration` worktree.
This record reports author verification; the independently assigned acceptance and Tier 3 review remain pending.
The approved route is [the controlled runtime plan][plan].

[plan]: ../../.pi/plans/2026-11-20_123933-controlled-runtime.md

## Environment and boundary

- Baseline: `2224a6b3eeb11061ec6320aff51c8a299d19e1c5`.
- Node.js 24.18.0, pnpm 12.18.0, TypeScript 5.9.3; Linux x86_64.
- Effection 4.2.0 is pinned as a private scheduling dependency.
- Source: `src/runtime/`; public surfaces: `src/index.ts` and `src/host.ts`.
- Prototype Scheduler, Application, and existing `fromAsync` consumers retain their entry points.
- Tests use controlled local operations and loopback I/O.

## Observed checks

Raw records reside in `.pi/verification/2026-11-20-controlled-runtime/` in this worktree.
That directory is ignored by Git and must remain available to the accepting reviewer.

| Check | Observation | Record |
| --- | --- | --- |
| Pre-change `pnpm run check` | Build and both type checks passed; 62 tests passed, zero failures | `baseline-full.log`, `baseline-full.exit` |
| Final `pnpm run check` | Build and both type checks passed; 93 tests passed, zero failures, cancellations, skips or todos | `final-check.log`, `final-check.exit` |
| Focused public/runtime suite | 45 tests passed, including 31 added cases and 14 retained prototype cases | `public-tests.log` |
| Isolated frozen offline install | 258 packages installed using the existing store and copy mode | `clean-install-copy.log` |
| Installed dependency identity and scope/action smoke | Version, tarball integrity, result, resource release and scope close passed | `dependency-smoke.mjs`, `dependency-smoke.log` |
| Index-exported isolated source tree | Both type checks, build and 45 focused tests passed using the clean installed dependency tree | `staged-tree.log`, `staged-tree.exit`, `staged-tree.path`, `staged-tree.hash` |
| Added-line static scan and staged whitespace check | No matching secret, injection, dynamic execution, unsafe deserialization or formatted SQL additions; `git diff --cached --check` passed | `scan-added.py`, `security-scan.json` |

The first baseline command exceeded a 60-second tool limit; the complete baseline above subsequently finished.
The first isolated offline install selected an empty store on the `/tmp` filesystem.
The successful retry explicitly selected the existing store and `--package-import-method=copy`; its initial failure is retained in `clean-install.log`.

## Contract and risk coverage

| Requirement or risk | Runnable evidence |
| --- | --- |
| Synchronous isolated roots, entry restoration, delayed/single start, result/state boundaries and closing admission | `test/jobs.test.ts` |
| Creation ownership, borrowed waits, unread business failure versus shutdown failure and child settlement before parent publication | `test/jobs.test.ts` |
| Illegal suspensions, async generators and thenable completions are rejected at their declared boundaries | `test/jobs.test.ts` |
| Cancellation reaches native catch once, preserves the first reason and cannot publish finished after acceptance | `test/job-host.test.ts` |
| Actual operation completion precedes catch; protected handlers and asynchronous finally remain part of the Job lifetime | `test/job-host.test.ts` |
| Cleanup already active before cancellation, pending notification, independent error precedence and terminal races | `test/job-host.test.ts` |
| Independent failures with equal thrown values retain distinct sources; wait plus shutdown does not double count; propagated aggregates retain identity | `test/jobs.test.ts` |
| Built package entry points join real socket closure, operation cleanup, native catch and finally before Job and root terminal observation | `test/controlled-runtime.test.mjs` |
| Public declarations type-check with `types: []` and no reachable Effection declarations | `test/controlled-runtime.test.mjs`, `dev/fixtures/runtime-consumer.ts` |

The socket fixture records this order:

```text
socket-connected -> peer-received -> abort -> resources-closed
-> operation-cleaned -> native-catch -> handler-cleaned
-> native-finally -> finally-cleaned -> terminal-observed -> root-closed
```

## Contract clarification C1

The existing execution-root contract fixes ownership to synchronous entry, but did not define the execution context of a Host operation's callback.
The implementation extends the same synchronous-context rule to Host invocation.
The synchronous operation function executes within its Job; asynchronous callbacks do not inherit that context and use an explicit open-root entry when creating top-level Jobs.
The root self-close guard covers the currently executing synchronous Job context.
A Host operation must arrange root closing outside its own unfinished operation, because its asynchronous self-wait cannot be inferred by that guard.

This resolves the missing Host context boundary consistently with synchronous root entry and the portable Core boundary.
Observable effects are checked by the Host callback ownership case and root reentry/self-close cases.
The adopted behavior is in `.pi/learns/contracts.md` under execution roots and Host bridging, and in [the runtime design][runtime].
The exact before/after source and patch are preserved as `contracts-before.md`, `contracts-after.md` and `contracts.patch` in the evidence directory.
The target `.pi/learns/contracts.d.ts` signatures remain unchanged.

[runtime]: ../../docs/zh-Hans/runtime.md

## Reproduction

Run from the package root:

```sh
pnpm run check
```

For the focused runtime and built-package fixtures:

```sh
pnpm run build
pnpm exec tsc -p tsconfig.test.json
node --test --test-timeout=15000 .build/test/jobs.test.js .build/test/job-host.test.js .build/test/coroutine.test.js .build/test/runtime.test.js test/controlled-runtime.test.mjs
```

`dev/fixtures/runtime-consumer.ts` is a compile-only consumer loaded by the public-declaration test.
The dependency smoke accepts an isolated installation directory as its first argument; the retained tarball is checked against that directory's lockfile.

```sh
node .pi/verification/2026-11-20-controlled-runtime/dependency-smoke.mjs /tmp/bitagent-controlled-runtime-glassrobin/clean-install
```

For the same added-line scan after the commit, consume the retained patch:

```sh
python3 .pi/verification/2026-11-20-controlled-runtime/scan-added.py .pi/verification/2026-11-20-controlled-runtime/change.patch
```

## Verification boundary

The author checked the changed admission, suspension, cancellation, failure propagation and terminal publication paths against the contract cases above.
Registered suspension identity, synchronous iterator validation and thenable rejection enforce the runtime input boundary.
Host callback errors return through the coroutine failure path.
The runtime adds no filesystem-path, SQL, credential or dynamic-code execution surface.
The existing repository provides TypeScript checks; no separate linter is configured.

## Limits and handoff

- Cancellation is cooperative; synchronous work retains control until it yields or is placed outside the control path.
- A Host adapter must include actual resource release in its returned completion.
- The synchronous self-close guard cannot detect an asynchronous callback waiting for its own root.
- Independent acceptance and implementation review have not been performed by this author.
- No remote publication or later engineering stage is part of this delivery.
