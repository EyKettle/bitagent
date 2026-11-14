# BitAgent

[English](README.md) | 中文

[![Conventional Commits][commit-badge]][conventional-commits]

BitAgent 让普通 TypeScript 程序掌握 LLM 工作的控制流。
持续运行的控制台保留用户定义的函数和变量，应用实例管理跨越单次脚本的工作。
LLM 只根据显式输入生成文本，没有 Agent 循环或独立记忆。

[设计总纲][design] · [普通函数技能示例][skill-source]

[commit-badge]: https://img.shields.io/badge/Conventional%20Commits-1.0.0-%23FE5196?logo=conventionalcommits&logoColor=white
[conventional-commits]: https://conventionalcommits.org
[design]: docs_zh-Hans/design.md
[skill-source]: src/skills/index.ts
[mock-config]: dev/llmock.json
[mock-fixtures]: dev/fixtures
[mock-wiring]: examples/mock-llm.mjs
[core-source]: src/index.ts
[pi-source]: src/pi.ts
[console-source]: src/node/index.ts
[tests]: test

## 启动本地试用环境

需要 Node.js 24 或更新版本，以及 pnpm 12.18.0。
在本仓库根目录运行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run mock:start
```

保持这个终端开启。
LLMock 监听 `http://127.0.0.1:4317`，返回本地预设内容，不使用真实模型或 API 凭据。
在该终端按 Ctrl+C 停止服务。

另开一个终端，在相同目录运行：

```sh
pnpm run console
```

控制台已提供带类型的 `app` 和 `llm`。
依次输入：

```ts
import { summarize } from "@bitagent/core/skills";
const input = { text: "[summary]", instruction: "Summarize briefly." };
const job = app.start(({ signal }) => summarize(llm, input, signal));
```

启动脚本结束时不必等待工作完成。
后续脚本仍能访问相同变量和应用实例：

```ts
job.state
await job.done
app.list()
```

`job.done` 返回带状态标签的结果：`succeeded`、`failed` 或 `cancelled`。
生成成功时包含文本和 `stop` 或 `length` 结束原因。
达到 token 上限不会触发自动续写。

工作尚未结束时，可以请求取消：

```ts
job.cancel()
await job.done
```

取消是协作式的，函数必须使用传入的 signal。
`cancelling` 不代表已经结束；忽略取消的代码仍可能成功返回。

工作结束后，显式将它从应用的运行记录中移除：

```ts
app.forget(job)
```

已有的句柄引用仍然可用。

## 在控制台中工作

未完成的 TypeScript 输入会等待续行。
完整片段按顺序执行，顶层 `await` 会阻塞后续输入，直到等待结束。
需要从后续脚本控制的长工作放进 `app.start()`。

| 命令 | 效果 |
| --- | --- |
| `.help` | 列出终端命令。 |
| `.break` | 丢弃尚未完成的输入。 |
| `.clear` | 重置控制台定义和类型，保留应用中的运行。 |
| `.exit` | 请求取消受管理的工作，并等待它们结束。 |

在片段之间使用 `.clear`；输入尚未完成时先用 `.break`。
EOF 也会关闭控制台。
关闭控制台不会停止独立的 mock 服务。
重置不会销毁用户代码持有的资源，也不会清除运行函数已捕获的引用。

控制台以**宿主进程的权限执行受信任的用户代码**。
它不是沙箱，TypeScript 检查也不是安全边界。
编译错误会在执行前拒绝整个片段；运行时错误不会回滚此前的副作用。
脚本可以阻塞进程，也可以忽略取消。

定义和运行只保存在内存中，不跨进程重启恢复。
Node 控制台采用 CommonJS 加载：导入必须能够通过 `require` 解析，原生 ESM 依赖必须支持同步加载。
仅提供 `import` 导出条件或包含顶层 `await` 的依赖不适用于这个控制台。
该限制针对被导入模块，不影响控制台自身的顶层 `await`。

## 复用相同的公开基础单元

| 导入入口 | 用途 |
| --- | --- |
| `@bitagent/core` | [应用运行管理与文本生成接口][core-source]。 |
| `@bitagent/core/pi` | [显式配置的 Pi 模型适配器][pi-source]。 |
| `@bitagent/core/node` | [Node 宿主使用的持久类型化控制台][console-source]。 |
| `@bitagent/core/skills` | [使用相同公开接口的普通函数][skill-source]。 |

官方技能只是导出的函数，没有插件特权。
用户可以编写自己的函数，与其他函数组合；需要受管理的运行寿命时，再交给 `app.start()`。
不需要注册或维护中央技能名称表。

宿主可以通过 `createScriptConsole({ app, llm, cwd })` 嵌入控制台，再调用 `evaluate(source)` 提交完整片段。
返回值为 `{ value: unknown }`；除非脚本显式等待，Promise 本身也只是返回值。
`reset()` 显式替换控制台定义。
`cwd` 决定导入基准目录，不限制访问权限。

Pi 适配器接收由调用方配置的模型服务和模型。
它只发送显式 prompt 和可选 system 指令，提供流式文本和错误结果，不执行工具、不重试、不积累历史。
[本地 mock 配置示例][mock-wiring] 展示了无需发现凭据的适配边界。

可移植入口不导入 Node 或 Pi。
控制台是 Node 专用实现；这里尚未实现或验证 Android 嵌入。

## 调整 mock 与验证改动

[mock 配置][mock-config] 选择[本地预设内容][mock-fixtures]。
修改配置后重启 mock 进程。

| prompt 标记 | 响应 |
| --- | --- |
| `[summary]` | 摘要文本预设。 |
| `[length]` | 结束原因为 `length` 的截断响应。 |
| `[error]` | HTTP 500。 |
| 未匹配标记 | 默认固定响应。 |

标记区分大小写，按配置中的顺序采用第一个匹配规则。
开发服务关闭请求日志、管理接口和数据库持久化。
需要其他端口时，先运行 `node --import tsx dev/mock.mjs --port 4318`，再运行 `pnpm run console --base-url http://127.0.0.1:4318/v1`。
示例客户端只接受本机回环 HTTP 地址。

```sh
pnpm run check
```

该命令构建公开入口，检查严格类型与可移植边界，并运行[测试][tests]。
HTTP 测试在空闲回环端口启动并关闭自己的 mock 进程，不依赖手动启动的服务或真实模型。
