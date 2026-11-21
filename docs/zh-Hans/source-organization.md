# 源码组织

源码按职责组织，目录与文件映射这些边界。

[架构总纲][architecture] · [术语][glossary]

[architecture]: architecture.md
[glossary]: glossary.md

- 模块入口汇聚公开能力，组件实现保留在所属模块边界内。
- 跨模块消费者依赖公开契约，不依赖对方的私有文件布局。
- 类型、常量与辅助实现随其服务的职责归属，不因复用进入无责任边界的公共目录。

> [!NOTE]
> 工程阶段按能力划分，执行计划按依赖安排；二者不与模块分解一一对应。
> 库入口可以汇聚多个功能模块，单元模块不等于独立发布包，职责拆分不自动改名公开符号。

## 当前实现与验证归属

| 路径 | 责任 |
| --- | --- |
| `src/index.ts`、`src/host.ts` | Core 与 Host 公开入口 |
| `src/runtime/` | 作业、归属范围、挂起协议、失败来源、宿主适配与私有内核 |
| `test/runtime/` | 通过公开入口验证状态、取消、清理和真实 socket；`fixtures/` 持有控制门闩与外部资源 |
| `test/types/` | 公开声明消费者、完成值约束和编译配置 |
| `dev/llmock/` | 独立的合成 HTTP 进程、配置和载荷 |
| `test/llmock/` | 直接 HTTP 验证与专属子进程生命周期 |
| `dev/build.mjs`、`dev/test.mjs` | 构建产物与按责任目录发现测试 |
| `dev/verification/` | 已发生的验证记录；其中旧文件地址按各记录的基线解释 |
