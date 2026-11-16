# BitAgent

[English](README.md) | 中文

[![Conventional Commits][commit-badge]][conventional-commits]

> [!CAUTION]
> 该分支承担前期探索工作，是未经实测的实验版本。
>
> 核心功能不完整，工程质量没有保证。
> 由 AI 交付，可能包含低质量代码或有问题的文档。

BitAgent 是由程序控制的 LLM 基设。
在自己的编辑器中编写 TypeScript 文件，再交给同一个持续实例执行；函数、变量和任务保留到用户显式清理为止。
用户流程使用 `function*` 和 `yield*` 协程，不需要协调 Promise。
LLM 是无独立状态的生成器：输入、工具和停止策略都由代码决定。

[设计总纲][design] · [官方函数][translator] · [用户函数][custom]

## 启动本地试用环境

需要 Node.js 24 或更新版本，以及 pnpm 12.18.0。
在仓库根目录启动工具响应模拟服务：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run mock:submit
```

保持这个终端开启。
服务监听 `http://127.0.0.1:4318`，返回固定预设，不做真实翻译，也不需要 API 凭据。
在该终端按 Ctrl+C 停止服务。

另开一个终端，在相同目录运行：

```sh
pnpm run console
```

在 TypeScript 编辑器中打开 `examples/workspace/`。
控制台只在缺少 `tsconfig.json` 时创建它，并通过 `.bitagent/globals.d.ts` 提供当前实例的类型。
使用项目安装的 TypeScript 版本，以获得经过验证的编辑器行为。
依赖尚未执行的定义时，文件可以暂时显示名称不存在的诊断；执行后会出现对应类型。

提供的 [start.ts][start] 包含以下流程：

```ts
import { createTranslator } from "@bitagent/core/skills";

const translate = createTranslator(llm, { maxAttempts: 2 });
const job = app.start(function* () {
  const result = yield* translate("你好", "English");
  return result;
});
```

在控制台执行实际文件：

```text
.run start.ts
job.state
.run inspect.ts
```

`app.start()` 立即返回任务句柄。
协程在 `yield*` 处挂起，收到通过校验的结果后才继续；实例仍可接收其他文件。
读取 `job.state` 只查看当前状态，不会隐式等待。
模拟服务先提交错误类型，收到工具错误后，再提交 `{ text: "Hello" }`。
任务成功时，状态为 `succeeded`，`value` 为这个对象。

### 从另一个文件控制工作

执行 `start.ts` 后，可以尝试：

```text
.run wait.ts
waitingJob.state
.run cancel.ts
waitingJob.state
```

`[wait]` 预设会保持 HTTP 响应未完成。
第二个文件可以取消它，第一条协程中依赖结果的后续语句不会提前执行。
取消是协作式的：`cancelling` 只表示已请求，不代表已经结束。

在另一条流程中使用任务的完成值，通过协程等待：

```ts
const report = app.start(function* () {
  const result = yield* job.join();
  console.log(result.text);
});
```

`join()` 成功时返回带类型的结果，失败或取消时抛出对应错误或原因。
取消等待者不会取消它所等待的任务。

## 显式保留与清理状态

控制台提供 `app`（调度器）、`llm`（模型实体）和 `scope`（定义管理）。
定义保留真实绑定：后续文件修改变量时，捕获它的闭包也能看到变化。
只修改源文件不会替换正在运行的定义。
重复定义同名内容前，需要先显式清理。

| 操作 | 效果 |
| --- | --- |
| `.run <path>` | 检查并执行文件；该行剩余部分整体作为路径，可以包含空格。 |
| `job.state`、`app.list()` | 查看任务，不等待。 |
| `job.cancel()` | 请求协作式取消。 |
| `scope.list()` | 查看保留的定义句柄。 |
| `scope.forget(handle)` | 移除这个名称，不清除其他代码已经捕获的引用。 |
| `.clear` 或 `scope.clear()` | 清除所有可查找名称，保留任务和已捕获引用。 |
| `app.forget(job)` | 从调度器记录中移除一个已结束任务。 |
| `.help` | 查看控制台命令。 |
| `.exit` | 退出示例宿主：取消受管理任务并等待清理结束。 |

例如，从 `scope.list()` 选取一个句柄，再交给 `scope.forget()`。
清理名称不等于销毁对象，也不会回滚副作用。
示例宿主在 EOF 或收到信号时也会收尾，但不会停止独立的 mock 服务。

## 构建可复用的类型化函数

官方函数没有特权注册通道。
[翻译函数][translator]和用户套件都通过普通代码组合 `defineFunction`。
需要 LLM 返回结果的函数，由一份 TypeScript 签名提供输入与返回契约：

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

[custom.ts][custom] 包含该函数与调用协程。
执行 `.run custom.ts`，再查看 `customJob.state`。
本地预设返回 `"example:2"`；标记只是选择固定响应，不是模型能力。

`defineFunction` 在调度函数体前校验并快照参数，函数结束时再校验返回值。
文件编译器从签名生成运行时 schema，不需要手写第二份 schema。
契约要求具体的函数签名，以及兼容 JSON 的数据类型。
`Date`、函数、`Promise`、`any`、`unknown` 等不支持的类型，以及泛型或重载函数签名，会在编译时失败，而不是悄悄放宽校验。
没有模型契约的普通函数不受这些限制。
类型正确不代表模型答案在语义上正确。

### 选择 submit 策略

`createSubmitTool(result)` 构造解析器和 `submit` 声明，参数 `value` 的结构由返回类型决定。
解析答案与决定如何使用答案是两层操作。
官方 `answer` 策略遇到错误提交时返回工具错误，遇到合法提交时停止请求，不再请求额外的最终文本。
`maxAttempts` 限制模型生成次数，包含第一次生成；传输错误不会被盲目重试。
用户套件可以使用相同基础单元选择不同策略。

### 分发用户套件

在 TypeScript 包中导出普通函数。
包含 `defineFunction` 的函数，需要在加载 JavaScript 前执行契约转换：

```js
// build.mjs — 包构建步骤，不是用户流程中的异步协调
import { compileContractProject } from "@bitagent/core/node";
compileContractProject("./tsconfig.json");
```

将这个包的 TypeScript 项目配置为输出 JavaScript 和声明文件，运行 `node build.mjs`，再导出构建产物。
单独使用 `tsc` 不会提供运行时契约。
BitAgent 也使用这个公开编译器构建官方函数；使用已编译套件的用户不需要再次编译它。
可复用套件将 `@bitagent/core` 声明为 peer dependency，使宿主和套件共用同一个协程运行时。
不需要中央技能名称表。

## 嵌入公开库

| 导入入口 | 用途 |
| --- | --- |
| `@bitagent/core` | 协程调度、类型化函数、submit 解析与模型契约。 |
| `@bitagent/core/skills` | 官方函数与有界的 `answer` 策略。 |
| `@bitagent/core/pi` | 将调用方配置的 Pi 模型服务和模型包装为 `createPiEntity`。 |
| `@bitagent/core/node` | 文件会话、控制台、编辑器配置与契约编译器。 |
| `@bitagent/core/host` | 宿主实现使用的异步 I/O 适配与任务结束等待。 |

宿主创建调度器和实体后，调用 `createFileSession({ app, llm, cwd })`。
`runFile(path)` 和 `evaluate(source)` 返回 `{ value, definitions }`，不等待文件启动的任务。
`initializeFileWorkspace(cwd)` 在缺少编辑器配置时创建它；已有配置需要自行纳入 `.bitagent/globals.d.ts`。
`runFileConsole({ session })` 提供终端命令，但不管理应用关闭。
[示例宿主][console-host]负责退出时的取消和等待。
关闭文件会话只断开编辑器声明，不取消应用任务。

实体只接收显式提供的消息和工具声明，没有独立历史，也不会自动执行工具调用。
应用代码可通过 `onMessage` 保留消息记录。
[mock 实体配置][mock-wiring]展示了不发现凭据的显式提供方配置。
底层的 `createApplication`、`createScriptConsole` 和文本生成 API 仍可供宿主集成使用；它们不是协程文件工作流的主接口。

## 执行边界

- 文件是**具有宿主进程权限的受信任代码**，不是沙箱。
  `cwd` 只决定导入基准，不限制文件访问。
- 用户代码执行前会检查源码和待发布的类型声明。
  与编辑器环境声明冲突的名称会被拒绝。
  运行时异常不会回滚已有副作用或已初始化的定义。
- 状态跨文件保留，不跨进程重启恢复。
  `.bitagent/` 保存编辑器声明与不可变类型快照，不保存可恢复的任务。
  一个工作区由一个活动编辑器连接占用；确认没有会话使用后，失效的 `session.lock` 才能由用户清理。
- 模型 I/O 只挂起调用它的协程。
  编译和同步代码仍占用宿主事件循环，不会抢占 CPU 密集代码。
- 文件宿主加载 CommonJS 和可同步加载的 ESM 依赖。
  仅提供 `import` 导出条件或要求顶层 `await` 的依赖暂不支持。
  文件入口也不能使用顶层 `await`，应启动协程。
- 当前 MVP 提供 Node 宿主。
  尚未实现或验证 Android 嵌入。

## 调整预设与验证

`pnpm run mock:submit` 在 `4318` 端口运行 Messages API 预设。
原有 `pnpm run mock:start` 文本预设保留在 `4317`。
两者都关闭请求内容的文件日志、管理 API 和数据库持久化。
LLMock 仍会向控制台打印请求到达和模板路径等诊断提示；这些提示不代表请求内容已保存。
示例客户端只接受本机回环 HTTP 地址。

| submit 预设输入 | 行为 |
| --- | --- |
| 翻译调用（`targetLanguage`） | 先错误提交，收到纠正反馈后合法提交 `{ text: "Hello" }`。 |
| `[user-function]` | 提交 `{ label: "example", items: 2 }`。 |
| `[wait]` | 挂起响应，供测试取消。 |
| `[invalid]` | 持续提交错误类型，直到次数上限。 |
| `[error]` | HTTP 500。 |

[配置][mock-config]决定规则顺序，[预设文件][mock-fixtures]决定响应内容。
修改配置后重启相应的 mock。
需要其他工具模拟端口时，运行 `node --import tsx dev/mock.mjs --model submit --port 4320` 和 `pnpm run console --base-url http://127.0.0.1:4320`。
通过 `--cwd <directory>` 选择其他编辑器工作区。

```sh
pnpm run check
pnpm audit
```

检查会构建契约、执行严格类型和可移植边界检查，并运行[测试][tests]，包含编辑器诊断与 HTTP 工作流。
测试管理自己的临时 mock 进程，不需要真实模型或手动启动的服务。

当前依赖树仍报告两项中危告警：经由 `ts-json-schema-generator` 引入的 [glob 取消问题][glob-advisory]和 [minimatch 放大问题][minimatch-advisory]。
BitAgent 提供现成的 TypeScript Program，不使用该依赖基于 glob 的项目发现路径；告警仍存在于安装树中，并未宣称已修复。

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
