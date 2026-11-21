# BitAgent

[English](README.md) | 中文

BitAgent 是由程序控制的 LLM 基设。
当前探索基线提供结构化协程作业与宿主执行边界。

[Jobs API][jobs] · [Host API][host] · [架构总纲][architecture]

[jobs]: docs/zh-Hans/api/jobs.md
[host]: docs/zh-Hans/api/host.md
[architecture]: docs/zh-Hans/architecture.md
[organization]: docs/zh-Hans/source-organization.md
[mock-config]: dev/llmock/config.json
[mock-payloads]: dev/llmock/payloads

## 构建与验证

需要 Node.js 24 或更新版本，以及 pnpm 12.18.0，在包根目录运行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
```

检查会重新构建 JavaScript 和声明、检查严格及可移植类型，并运行全部运行时、公开类型和本地 HTTP 夹具。
测试管理自己的回环进程，不需要 API 凭据。
`pnpm run build` 只替换 `dist/`；测试命令只替换 `.build/test/`，保留验证归档。
[源码组织][organization]标明各实现与测试的责任归属。

## 运行作业

构建后，在包内以 ES 模块运行：

```js
import { Job } from "@bitagent/core";
import { createExecutionRoot, fromAsync, waitForJob } from "@bitagent/core/host";

const root = createExecutionRoot();
try {
  const job = root.run(() => Job.spawn(function* () {
    return yield* fromAsync(async () => 42);
  }));
  console.log(await waitForJob(job)); // { state: "finished", value: 42 }
} finally {
  await root.close();
}
```

作业使用同步 Generator 和 `yield*`；句柄公开状态与结果，不是 Promise。
创建决定归属，取消是协作式的；终态公布前须完成自有工作和实际宿主操作。
宿主适配器将资源释放计入完成边界；同步代码须主动让出以保持控制机会。
[Jobs][jobs] 与 [Host][host] 参考定义取消、清理、失败身份和类型约束。

## 运行合成 HTTP 夹具

```sh
pnpm run mock:start
pnpm run mock:submit
```

在不同终端运行，文本预设使用 4317 端口，Messages/工具载荷预设使用 4318。
两者均绑定回环地址，关闭数据库持久化和请求正文的文件日志，按 Ctrl+C 停止。
[配置][mock-config]和[载荷][mock-payloads]是独立的开发素材，供提供方协议测试使用。
需要临时端口时，运行 `node --import tsx dev/llmock/server.mjs --port 0`。
