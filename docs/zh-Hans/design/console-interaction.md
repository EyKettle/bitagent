# 控制台的交互契约

## 统一状态

BitAgent 没有会话的概念，每次回来都在同一个上下文中无缝衔接。

一个 BitAgent 实例与一位用户，心智模型一对一。
多任务管理属于 BitAgent 本身职责，不必劳烦用户。

没有会话不等同于放弃隔离性，通过 BitAgent 提供的接口，工作之初就把数据放在准确的位置。
用户可以清楚地认知到任务的分界，而不必承担多任务管理工作，更不必寻求在新会话继承旧会话信息的方案。

## 基本指令

在控制台中输入一行 TS 代码，BitAgent 会在应用上下文中执行。

以下函数均直接注册在全局空间中，随时可用。
允许用户通过 `bit.drop()` 丢弃，将命名留给自己。

- `const view = bit.view` (`function view(...target: unknown[]): ViewResult[]`)

读取已定义对象的结构与值，在控制台中会显示为格式化的代码。

- `const drop = bit.drop` (`function drop(...target: unknown[]): void`)

`drop()` 丢弃用户空间的已定义对象。

- `const llm = bit.llm` (`function llm(id?: string, options?: llm.ModelOptions): LLMEnitty`)

执行 `llm()` 获取或生成一个 LLM 实体。
被丢弃时生命周期停止。
