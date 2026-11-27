# 控制台的交互契约

## 统一状态

BitAgent 没有会话的概念，每次回来都在同一个上下文中无缝衔接。

一个 BitAgent 实例与一位用户，心智模型一对一。
多任务管理属于 BitAgent 本身职责，不必劳烦用户。

没有会话不等同于放弃隔离性，通过 BitAgent 提供的接口，工作之初就把数据放在准确的位置。
用户可以清楚地认知到任务的分界，而不必承担多任务管理工作，更不必寻求在新会话继承旧会话信息的方案。

## 基本指令

> [!CAUTION]
> 这部分内容的签名仅作语义说明，非契约要求。
> 实际的类型命名与引用位置据相关规范决定。

在控制台中输入一行 TS 代码，BitAgent 会在应用上下文中执行。

以下函数均直接注册在全局空间中，随时可用。
允许用户通过 `bit.drop()` 丢弃，将命名留给自己。

- `const view = bit.view` (`function view(...target: unknown[]): ViewResult[]`)

读取已定义对象的结构与值，在控制台中会显示为格式化的代码。

- `const drop = bit.drop` (`function drop(...target: unknown[]): void`)

`drop()` 丢弃用户空间的已定义对象。

- `const file = bit.file` (`function file(path: string): File`)

引入外部文件（通常是 TS 脚本），便于之后调用或进行文件数据处理。

- `const llm = bit.llm` (`function llm(id?: string, options?: llm.ModelOptions): LLMEnitty`)

执行 `llm()` 获取或生成一个 LLM 实体。
被丢弃时生命周期停止。

## 执行外部脚本

用户可以在自己的编辑器中编写脚本，交由 BitAgent 执行。

对于工作区内的脚本，可以直接通过原生 `import` 引入其中的内容（同原生逻辑，文件中的顶级代码会作为副作用执行）。
无论如何，都可以通过 `bit.file()` 引入任意位置的代码文件，然后通过 BitAgent 为 `File` 提供的接口完整运行。
