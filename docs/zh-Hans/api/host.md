# Host API

`@bitagent/core/host` 提供执行根、异步操作桥接和作业终态观察。
接口基线为 `@bitagent/core` 0.1.0 的第一阶段实现；Promise 位于宿主边界，作业体通过协程原语组织流程。

[Jobs API][jobs] · [运行时设计][runtime] · [公开入口][exports] · [类型声明][types]

[jobs]: jobs.md
[outcome]: jobs.md#状态与结果
[runtime]: ../runtime.md
[exports]: ../../../src/host.ts
[types]: ../../../src/runtime/types.ts
[bridge]: ../../../src/runtime/host.ts
[example]: jobs.md#宿主脚本中的手动启动

## 执行根

`createExecutionRoot(): ExecutionRoot` 创建隔离的执行范围，初始状态为 `open`。
`ExecutionRoot.state` 是只读的 `ExecutionRootState`：`"open" | "closing" | "closed"`。

### `run`

```ts
run<T>(entry: (() => T) & (
  [Extract<T, PromiseLike<unknown>>] extends [never] ? unknown : never
)): T;
```

在同步入口中提供顶层作业归属，返回入口原值或抛出原异常，退出时恢复先前上下文。
同一根可以同步重入；当前已有另一个根或作业上下文时，调用在执行入口前抛出 `TypeError`。
`closing` 和 `closed` 同样拒绝入口。

入口返回 thenable 时抛出 `TypeError`，已经发生的副作用不回滚。
异步回调不继承入口上下文；需要创建顶层作业时，重新通过仍开放的根调用 `run()`。

### `close`

`close(reason?: unknown): Promise<void>` 首次调用进入 `closing`，采用原因并取消未终结的根属作业，包括未启动作业。
关闭期拒绝新作业的创建和启动。
等待自有作业及资源收束后进入 `closed`；收束成功兑现 Promise，过程中存在未处理异常则拒绝它。
单个异常原样交付，多个独立异常用 `AggregateError` 交付；此前独立的业务失败不自动使关闭失败。

重复调用返回首次调用的同一个 Promise，不替换原因；失败后根仍为 `closed`。
当前作业在同步上下文中关闭所属根会抛出 `TypeError`。
宿主操作须在自身结束之外安排所属根关闭，避免根和操作互相等待；同步检查不推断异步自等待关系。

## `fromAsync`

[声明入口][bridge]：

```ts
fromAsync<T>(
  operation: (signal: AbortSignal) => T | PromiseLike<T>,
  options?: { readonly cleanup?: boolean },
): Coroutine<T>;
```

通过 `yield* fromAsync(operation)` 取得操作的完成值；操作在作业推进到该挂起点时才调用。
返回值恢复 Generator，拒绝或同步抛出的异常进入原生异常处理。
操作函数的同步部分使用所属作业上下文，异步回调不继承它。

| 选项 | 默认值 | 效果 |
| --- | --- | --- |
| `cleanup` | `false` | 为 `true` 时保护本次操作免受作业取消中断，值和异常仍正常交付 |

普通操作取得本次操作的 `AbortSignal`，受理取消时发出 abort。
适配器用 `signal.reason` 报告中断造成的拒绝；它是本次 `JobCancelledError`，其他拒绝保留为操作异常。
运行时等待操作实际结束后才恢复协程；适配器必须把资源释放纳入返回值或 Promise 的完成边界。

`cleanup: true` 也保护取消已受理但通知尚未注入的清理。
取消通知注入后的处理和清理操作自动受到同样保护。
停止等待或发出 abort 不代表资源已经释放。

操作在首次让出执行权前仍是同步调用；长计算或阻塞 I/O 须主动让出或置于控制路径之外。

## `waitForJob`

`waitForJob<T>(job: Job<T>): Promise<JobOutcome<T>>` 为宿主观察真实作业的[终态结果][outcome]。
失败和取消作为结果分支返回，不因作业失败或取消而拒绝该 Promise。
它不启动作业，也不接管归属；对 `created` 作业的等待，须由持有者另行启动或取消。
非本运行时创建的句柄，包括复制的普通对象，同步抛出 `TypeError`。

完整的执行根、手动启动和宿主观察用法见 [Jobs 示例][example]。
