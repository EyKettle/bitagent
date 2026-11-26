# 持续类型程序实现验证

C1/C2 修正后的实施验证通过：完整检查 109/109、冻结目标声明 2/2。
首轮完整 Tier 3 与[R1 独立复审][r1-review]的原 FAIL 保留；[本次复审][corrections-review]确认 C1/C2 原反例已解决，但导入别名作用域仍有 C3 阻塞（新反例 0/1、退出 1）。
阶段仍待 C3 独立返工、无阻塞复审、匹配安装包/性能及本地记录。

[corrections-review]: ../../.pi/verification/2026-11-21-persistent-typed-program/ptp-r1-corrections-review.md

[r1-review]: ../../.pi/verification/2026-11-21-persistent-typed-program/ptp-r1-review.md

[原计划][plan] · [修复验证][validation] · [首轮审查][first-review] · [修复设计][repair] · [历史性能][performance]

[plan]: ../../.pi/plans/2026-11-20_213927-persistent-typed-program.md
[validation]: ../../.pi/verification/2026-11-21-persistent-typed-program/ptp-r1-corrections-source-build.json
[first-review]: ../../.pi/verification/2026-11-21-persistent-typed-program/review-before-repair.md
[repair]: ../../.pi/verification/2026-11-21-persistent-typed-program/ptp-r1-repair-design.md
[performance]: ../../.pi/verification/2026-11-21-persistent-typed-program/performance-results.md
[source-build]: ../../.pi/verification/2026-11-21-persistent-typed-program/ptp-r1-corrections-source-build.json
[check]: ../../.pi/verification/2026-11-21-persistent-typed-program/ptp-r1-corrections-check.log
[target]: ../../.pi/verification/2026-11-21-persistent-typed-program/ptp-r1-corrections-target.log
[counterexamples]: ../../.pi/verification/2026-11-21-persistent-typed-program/ptp-r1-retained-counterexamples-after.log

## 范围与实际入口

基线 `c84532b81d94a7066dbc6e2bff51ef56894c627a`，exploration。
保留 Jobs/Host；新增 State、TypeContracts、ValueContracts、Functions、Source、Session。
公开入口为 `@bitagent/core`、`/host`、`/state`、`/compiler`、`/node`。
必要生产依赖是 Effection 4.2.0 与 TypeScript 5.9.3，不恢复 MVP 或实施后续模型/界面阶段。

State 保存实际绑定及原完整类型；Source 采用实际源码/声明与模块版本，Worker 执行真实 TypeScript 检查及发射。
Session 准备归属当前 Job 范围，execute 从根外调用并同步发布真实定义。
Contracts/Functions/工具元数据从同一采用程序生成。

## 当前实施验证

原始记录均在 `.pi/verification/2026-11-21-persistent-typed-program/`，原始失败、旧版本与冻结来源保留。

| 检查 | 实际结果 | 记录 |
| --- | --- | --- |
| C1/C2 修正后完整检查 | strict/portable、构建、109/109 测试通过；其他测试状态均 0 | [完整输出][check]及同名 `.exit` |
| 冻结目标声明消费者 | 2/2 通过，Job 声明确认来自冻结目标文件 | [目标输出][target]及同名 `.exit` |
| 新复审反例 | C3 导入别名被误认为同名全局依赖，0/1、退出 1 | [本次复审][corrections-review] |
| 当前源码/构建 | 36 源码单元、144 输出文件及 72 个 source-map 对应；失败来源另已冻结 | [逐文件对应][source-build] |

原数组脚本保留其 `ts:2339` 冻结断言，不宣称该历史断言通过。
当前明确的 Source 准入结果及支持依据见[修复验证][validation]与[修复设计][repair]；当前公开回归检查真实诊断范围、无发布、旧值身份及后续正常访问。

## 保留的历史版本观测

| 版本 | 原观测 | 保留记录 |
| --- | --- | --- |
| 先前 R1 实施版 | 完整检查 106/106、冻结目标声明 2/2；四个未改原反例 4/4 | `ptp-r1-complete-check.log/.exit`、`ptp-r1-validation.json`、[原反例输出][counterexamples] |
| 首次实际生产安装包 | 11 公开通路断言、严格声明检查通过；33 源码/132 产物/135 包文件对应 | `package-consumer-corrected.log/.exit`、`package-types.log/.exit`、`implementation-source-build.json` |
| 发布扫描优化版 | 完整检查 86/86、目标声明 2/2；固定参考预算通过，30/30 控制样本覆盖实际检查区间 | `publication-all-units-check.log/.exit`、`publication-target-types.log/.exit`、`publication-engine-benchmark.json/.log/.exit` |

这些观测对应其原源码版本，不作为当前 R1 版本的安装包或性能结论。
新的包、测量与版本对应使用新增记录，不改写此前结果。

## 复现

```sh
pnpm run check
BITAGENT_JOB_TYPES_TARGET="$PWD/.pi/learns/contracts.d.ts" node --test test/types/completion.test.mjs test/types/program.test.mjs
node dev/benchmark/program.mjs /tmp/bitagent-benchmark-new.json
```

测量遵循固定协议，输出地址必须未存在，避免覆盖样本。
环境为 Node 24.18.0、pnpm 12.18.0、TypeScript 5.9.3、Linux x86_64、i7-8700。
完整硬件与历史样本见[性能记录][performance]。

## 边界

Node 适配器使用原生同步 ESM 及采用后的本地模块。
动态 import、顶层 await、外部运行时包和指回命令入口的持久模块返回明确诊断，不假装异步表达已执行。
Node 原生模块实例/失败缓存及来源元信息随平台进程保留；不宣称沙箱、回滚、同步业务抢占或无限规模延迟保证。

Native require(ESM) 的 throw undefined 用例打印 Node 内部 evaluateSync 源码位置，但实际原异常和部分发布断言通过、退出 0。
该观察保留，不推测原因。
所有原规范契约仍与路线快照相等。
