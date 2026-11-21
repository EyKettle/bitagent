# Clean Jobs/Host baseline verification

The clean baseline retains Jobs/Host and removes the MVP execution, compiler, model, skill and Node console pipelines.
The source baseline is `ca8da18f94fa89fdaefe00f781d7b531d2f8af64` on `exploration`.
The cleanup does not implement later engineering stages or change Jobs/Host behavior contracts.

[Ownership and decisions][design] · [Review][review] · [Raw evidence][evidence] · [Current source organization][organization]

[design]: ../../.pi/verification/2026-11-21-clean-baseline/design.md
[review]: ../../.pi/verification/2026-11-21-clean-baseline/review.md
[evidence]: ../../.pi/verification/2026-11-21-clean-baseline/
[organization]: ../../docs/zh-Hans/source-organization.md

## Ownership and disposal

| Unit | Current owner |
| --- | --- |
| Core and Host entry points | `src/index.ts`, `src/host.ts` |
| Jobs, ownership, suspension, cancellation, failure provenance and private kernel | `src/runtime/` |
| Runtime contracts and real socket lifetime | `test/runtime/`, including owned control/socket fixtures |
| Declaration consumers and compiler configuration | `test/types/` |
| Synthetic provider process, configuration and payloads | `dev/llmock/` |
| Raw HTTP and owned child lifecycle | `test/llmock/` |
| Product and test compilation/discovery | `dev/build.mjs`, `dev/test.mjs` |

The exact 83-file original classification is in `disposition.json` in the evidence directory.
It removes 40 tracked MVP files and reorganizes 14 retained assets; new shared fixtures have specific lifecycle or compilation responsibilities.
Scheduler/Task, Application/Run, the old contract transform/business wrappers, Pi model adapters, skills, Node file/console/workspace hosts, examples and their dedicated tests are removed.
Their old exports, compiler build step and unused dependencies are removed with them.

The untracked default `examples/workspace/tsconfig.json` was removed under the owner's explicit ruling after matching its preserved original and SHA256 `0743c81e3a88920703b8522172f1fab1ad094d35975c1d9dd7b0409bcb0ac0a1`.
Ordinary `dist`, `.build/src` and `.build/test` compiler outputs were cleared or replaced.
Historical `.pi` and `.build/verification` records remain; other ignored/unknown workspaces are preserved and listed in `source-build.json`.
Earlier verification reports retain paths as historical addresses relative to their recorded commits.

## Observed checks

Environment: Node.js 24.18.0, pnpm 12.18.0, TypeScript 5.9.3, Linux x86_64.
Raw records are local, ignored Git evidence under `.pi/verification/2026-11-21-clean-baseline/`.

| Check | Result | Record |
| --- | --- | --- |
| Fixed baseline in an isolated exported tree | Build and 42 retained target checks passed | `baseline.log`, `baseline.exit`, `baseline.path` |
| Fresh `pnpm run check`, after removing product/test outputs | Strict and portable types, product declarations, test compilation and 45 tests passed; zero failures/cancellations/skips/todos | `fresh-check.log`, `fresh-check.exit` |
| Target contract declaration consumer | One consumer test passed against the unchanged `.pi/learns/contracts.d.ts`, also from the isolated staged tree | `target-types.log`, `target-types.exit`, `staged-target-types.log`, `staged-target-types.exit` |
| Isolated staged tree without old build output | Strict and portable checks, fresh product/test compilation and all 45 tests passed using the frozen clean dependency tree | `staged-check.log`, `staged-check.exit`, `staged-tree.path`, `staged-tree.hash` |
| Runtime/Host and public declaration closure | 10 source files, exactly 40 corresponding artifacts; no public Effection or Node type dependency; direct example finished with 42 | `closure.mjs`, `closure.json`, `closure.log` |
| Frozen offline clean dependency tree | Existing versions only, no downloads; production dependency is Effection 4.2.0 | `clean-install.log`, `clean-install.exit`, `installed-tree.json` |
| Actual package and independent consumer | Exactly 43 archive entries: 40 artifacts, two READMEs and manifest; all 40 artifacts and both READMEs match the isolated staged tree byte for byte; pnpm removes only the manifest’s packageManager metadata and preserves every other parsed field; its unpacked Jobs/Host example passed | `final-package.json`, `final-package.tgz`, `final-pack.log`, `final-package-consumer.log` |
| Behavior and archive correspondence | All eight runtime units retain behavior; both type-consumer bodies match the baseline; protected archives unchanged | `correspondence.py`, `source-build.json` |

The retained 42 checks cover Jobs, cancellation, Host settlement, failure provenance, public declarations and static completion typing.
The three added checks verify listener disposal when root cleanup rejects, and the text/Messages HTTP fixture assets without product adapters.
The real socket case retains the order: connection and input, abort, resource closure, operation cleanup, native catch/handler cleanup, native finally/cleanup, terminal observation, root closure.
LLMock teardown records both owned child processes exiting normally.

The first run of the new raw Messages fixture used exact payload comparison before accounting for LLMock's generated tool IDs; its failure is retained in `check-first.log` and `check-first.exit`.
The corrected assertion checks generated ID types and compares template payload fields.
A fresh checkout checks source types before building; test types and package consumers are checked after the product build so they cannot rely on an old `dist`.

## Reproduction

Run from the package root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
BITAGENT_JOB_TYPES_TARGET="$PWD/.pi/learns/contracts.d.ts" node --test test/types/completion.test.mjs
node .pi/verification/2026-11-21-clean-baseline/closure.mjs
```

The last two commands require the local contract/evidence directory.
The public regression suite and built declarations are in the tracked tree and do not require those local records.

## Verification boundary

The review covers removal, retained runtime relationships, shared-fixture ownership, source/declaration/artifact closure, build and dependency changes, and current running instructions.
It does not certify future Provider/Generator/Compiler stages, a repository-wide vulnerability audit or platforms other than the observed Node/Linux environment.
Historical test counts remain historical; the clean baseline's complete current test command reports 45.
