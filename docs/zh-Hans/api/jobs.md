# Jobs API

`Job<T>` 是可观察、启动、等待和取消的协程执行句柄，从 `@bitagent/core` 导入。
接口基线为 `@bitagent/core` 0.1.0 的第一阶段实现。
顶层创建作业需要先进入 [Host 执行根][root]。

[Host API][host] · [运行时设计][runtime] · [类型声明][types] · [构造入口][factory]

[host]: host.md
[root]: host.md#执行根
[runtime]: ../runtime.md
[types]: ../../../src/runtime/types.ts
[factory]: ../../../src/runtime/jobs.ts

## 创建作业

| 接口 | 签名 | 行为 |
| --- | --- | --- |
| `Job.create` | `create<T>(body: JobBody<T>): Job<T>` | 创建 `created` 作业，等待显式启动 |
| `Job.spawn` | `spawn<T>(body: JobBody<T>): Job<T>` | 创建并启动作业；业务体在当前入口返回后执行 |

`Coroutine<T>` 的类型为 `Generator<Suspension, T, unknown>`。
`JobBody<T>` 从 Core 类型入口导入，是 `() => Coroutine<T>` 与完成值调用约束的交集，不宽化结果 `T`。
工厂在调用处拒绝 `then` 具有调用或构造签名的完成类型，包括 Promise、结构 thenable，以及可选或联合类型中的相应分支；显式泛型同样受限。
普通值、`void`、合法联合及 `yield*` 返回推断保留。
结果类型或 `then` 属性的签名信息被擦除时（如 `unknown`、`any`、宽泛 `object` 或 `Function`），仍由运行时守卫兜底；这不使 thenable 成为合法结果。
业务体使用同步 `function*`，通过 `yield*` 调用 Core 原语；普通作业返回的值不被复制，也不被解释为业务成功。
异步操作通过 Host 的 `fromAsync` 取得完成值；作为流程结果返回的 Promise 或其他 thenable 会使作业以 `TypeError` 失败。
非法挂起值以异常恢复 Generator，使其可以执行清理；异步迭代器同样被拒绝。

创建时归属于当前作业，或顶层入口的执行根。
没有当前执行范围时抛出 `TypeError`；当前作业已停止接收新工作时抛出 `JobStateError`。
业务体离开后，仍未结束的自有子作业被取消并收束，随后才公布父作业终态。

## `Job<T>` 句柄

| 只读属性 | 类型 | 含义 |
| --- | --- | --- |
| `id` | `string` | 作业标识 |
| `state` | `JobState` | 当前执行状态 |
| `outcome` | `JobOutcome<T> \| undefined` | 终态前为 `undefined`，终态后给出完成值、异常或取消原因 |
| `result` | `T` | 仅在 `finished` 时返回原完成值；其他状态抛出 `JobStateError` |

### 状态与结果

| `JobState` | 含义 | `outcome` |
| --- | --- | --- |
| `created` | 尚未启动 | `undefined` |
| `generating` | 已启动，包含执行和挂起等待 | `undefined` |
| `cancelling` | 已受理取消，等待执行与清理收束 | `undefined` |
| `finished` | 正常返回 | `{ state: "finished", value: T }` |
| `failed` | 流程或清理失败 | `{ state: "failed", error: unknown }` |
| `cancelled` | 取消已收束 | `{ state: "cancelled", reason: unknown }` |

后三种状态是终态。
`generating` 不表示作业一定正在调用模型；正常返回业务失败报告仍为 `finished`。
单个失败保留原异常，多个独立失败通过 `AggregateError` 交付。

### 启动、等待与取消

| 方法 | 签名 | 返回与效果 |
| --- | --- | --- |
| `start` | `start(): boolean` | 归属范围仍接收启动、且首次从 `created` 启动时返回 `true`；其余情况为 `false` |
| `wait` | `wait(): Coroutine<T>` | 通过 `yield* job.wait()` 等待终态；成功返回值，失败抛原异常，取消抛出携带目标原因的 `JobCancelledError` |
| `cancel` | `cancel(reason?: unknown): boolean` | 首次受理取消返回 `true`；再次取消或终态为 `false`，保留首次原因；省略原因采用 `undefined` |

`wait()` 不启动目标，也不改变目标归属；取消借用的等待者不取消目标。
对未进入业务体的作业，取消跳过业务体。
对已进入的作业，取消通知在协作边界至多注入一次，可进入原生 `catch` 和 `finally`；处理和清理仍须完成。
已受理取消的作业最终只能为 `cancelled` 或 `failed`，即使业务体后来正常返回。
取消不回滚副作用，也不抢占同步计算。

## 错误

| 导出类型 | 构造签名 | 信息与用途 |
| --- | --- | --- |
| `JobStateError` | `new JobStateError(state: JobState, message: string)` | `state` 为拒绝操作时的状态；用于过早读取结果或在已关闭作业范围创建工作 |
| `JobCancelledError` | `new JobCancelledError(reason?: unknown)` | `reason` 保留原取消原因；用于运行时取消通知和等待已取消目标 |

收到目标作业的取消异常或自行抛出同类异常，不会自动将当前作业标记为取消。

## 宿主脚本中的手动启动

宿主用 `await` 观察结果和关闭执行根；作业体使用同步 Generator。

```ts
import { Job } from "@bitagent/core";
import { createExecutionRoot, waitForJob } from "@bitagent/core/host";

const root = createExecutionRoot();
try {
  const job = root.run(() => Job.create(function* () {
    return 42;
  }));

  console.log(job.state); // created
  job.start();
  const outcome = await waitForJob(job);
  if (outcome.state === "finished") {
    console.log(job.result); // 42
  }
} finally {
  await root.close();
}
```
