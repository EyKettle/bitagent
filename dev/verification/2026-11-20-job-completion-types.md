# Job 完成值静态约束验证

`Job.create` 和 `Job.spawn` 在调用处拒绝已知 thenable 完成值，合法结果推断及原运行时守卫不变。
基线为 `9f381411ef803213e31ea4b35315f6740705998d`；验证环境为 Node.js 24.18.0、pnpm 12.18.0、TypeScript 5.9.3。

[API 签名][api] · [声明消费者][consumer] · [源码与构建][build] · [Tier 3 审查][review]

[api]: ../../docs/zh-Hans/api/jobs.md#创建作业
[consumer]: ../fixtures/job-completion-consumer.ts
[build]: ../../.pi/verification/2026-11-20-job-completion-types/source-build.json
[review]: ../../.pi/verification/2026-11-20-job-completion-types/review.md
[old-public]: ../../.pi/verification/2026-11-20-job-completion-types/consumer-before.log
[old-target]: ../../.pi/verification/2026-11-20-job-completion-types/target-before.log
[public]: ../../.pi/verification/2026-11-20-job-completion-types/signature-consumer.log
[target]: ../../.pi/verification/2026-11-20-job-completion-types/signature-target.log
[regression]: ../../.pi/verification/2026-11-20-job-completion-types/final-validation.log
[isolation]: ../../.pi/verification/2026-11-20-job-completion-types/staged-validation.log
[contract]: ../../.pi/verification/2026-11-20-job-completion-types/target-contract.patch

## 结果

| 检查 | 观测 |
| --- | --- |
| [旧公开声明][old-public]与[旧目标声明][old-target] | 初版消费者各有 20 个 TS2578，证明旧签名没有拒绝这些非法调用 |
| [公开声明][public]与[目标声明][target] | 最终消费者均通过，且 `Job` 分别解析到构建声明和目标声明 |
| [聚焦回归][regression] | 56 项通过，包括 Jobs、Host、原型、公开入口、B1 与本次新增回归 |
| [暂存树隔离验证][isolation] | 用现有锁定依赖从暂存源码编译及运行同一聚焦套件 |
| [构建对比][build] | 11 个运行时及公开入口 JavaScript 文件与改前构建逐字节相同 |

`JobBody<T>` 检查 `then` 的调用或构造签名，不把函数元数据对象误判为函数。
分配条件检查联合分支，`NoInfer` 隔离限制与结果推断。
类型信息被擦除时仍依赖原运行时守卫。
目标声明和行为说明在 `.pi/` 内同步补齐；[对应补丁][contract]仅记录本次声明规则和静态说明，不修改执行行为。

## 复现

在包根目录执行：

```sh
pnpm run build
pnpm run typecheck
pnpm exec tsc -p tsconfig.test.json
node --test --test-timeout=15000 .build/test/jobs.test.js .build/test/job-host.test.js .build/test/coroutine.test.js .build/test/runtime.test.js test/controlled-runtime.test.mjs test/job-failure-provenance.test.mjs test/job-completion-types.test.mjs
BITAGENT_JOB_TYPES_TARGET=.pi/learns/contracts.d.ts node --test test/job-completion-types.test.mjs
```

未重跑全项目慢速套件，未覆盖其他 TypeScript 版本或配置。
原始日志、目标声明快照及审查记录保存在工作树的 `.pi/verification/2026-11-20-job-completion-types/`，不纳入 Git。
