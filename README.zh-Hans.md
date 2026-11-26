# BitAgent Core

结构化作业与持续类型 TypeScript 应用：真实定义、固定编译版本、同源数据契约及业务 Job。

[English](README.md)

## 构建与验证

参考环境为 Node.js 24+、pnpm 12.18.0、TypeScript 5.9.3。

```sh
pnpm install --frozen-lockfile
pnpm run check
```

构建使用普通项目编译器，不包含 MVP transformer、REPL、控制台或模型适配通路。

## 应用入口

宿主用显式目录文件 URL 创建 `createTypeScriptCompiler({ baseURL })`，并通过 `createCompilerSession({ state, root, compiler })` 借用指定 State、执行根和 Compiler。

```js
import { createState } from "@bitagent/core/state";
import { createTypeScriptCompiler } from "@bitagent/core/node";
import { createExecutionRoot, createCompilerSession, waitForJob } from "@bitagent/core/host";

const baseURL = new URL("file:///your/workspace/");
const root = createExecutionRoot();
const state = createState();
const compiler = createTypeScriptCompiler({ baseURL });
const session = createCompilerSession({ state, root, compiler });
const outcome = await waitForJob(root.run(() => session.prepare({
  kind: "text", url: new URL("input.ts", baseURL), text: "const value = 42; value",
})));
if (outcome.state === "finished" && outcome.value.kind === "ready") {
  console.log(session.execute(outcome.value.input));
}
// 宿主等待全部自有服务结束；一个关闭拒绝不会跳过其他服务。
const closed = await Promise.allSettled([session.close(), compiler.close(), root.close()]);
for (const result of closed) if (result.status === "rejected") console.error(result.reason);
```

准备 Job 属于调用者的当前执行范围；执行入口同步进入应用根，不把顶层代码套成输入 Job。
业务 Job 可以跨输入继续运行。State 保持原始绑定及固定类型，移除名字不清理任意对象资源。
准备入口只能消费一次，执行前核验来源、会话与结构版本，抛错仍记录真实变化。

公共入口为 Core（Jobs、数据契约、业务函数、工具元数据）、Host（根、发布、Session）、State、Compiler 中立契约及 Node 实现。
本地模块与其声明在准备中捕获，执行不重读更新文件；同应用的相同版本复用原生 ESM 实例，旧引用及初始化失败保留原身份。
当前适配器对顶层 await、动态导入及不能保持类型/运行身份对应的外部运行包明确诊断。
工具调用派发、模型与后续工程阶段不在本次实现中。

## 本地夹具与测量

```sh
pnpm run mock:start
node dev/benchmark/program.mjs /tmp/new-command-engine-samples.json
```

LLMock 只保留独立进程、配置、原始协议载荷及启动素材；测试自建场景并管理资源，不借用旧模型包装。
Benchmark 要求新的输出路径，保留 prepare/execute/State/控制响应的原始样本、冷热/变化/规模病例，不将业务或网络等待计作引擎开销。

- [Jobs](docs/zh-Hans/api/jobs.md)
- [State](docs/zh-Hans/api/state.md)
- [Source 与 Session](docs/zh-Hans/api/compiler.md)
- [源码职责](docs/zh-Hans/source-organization.md)
