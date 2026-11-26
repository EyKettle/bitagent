# Source 与持续输入

Node 宿主通过 `createTypeScriptCompiler({ baseURL })` 创建中立的 Compiler，通过 `createCompilerSession({ state, root, compiler })` 关联应用 State、执行根与编译服务。
同一 State 固定同一组服务；会话关闭不关闭借用的根或 Compiler。

[State][state] · [Host][host] · [Jobs][jobs]

[state]: state.md
[host]: host.md
[jobs]: jobs.md

## 准备与执行

`prepare({ kind: "text", url, text })` 与 `prepare({ kind: "file", url })` 在调用者的当前执行范围创建已启动 Job。
输入记录、URL 和 State 快照在调用时采用；文件内容在编译工作中读取。
Node 入口采用干净的绝对文件 URL，目录入口、凭据、查询和片段在创建 Job 前拒绝。

准备结果为 `ready` 或 `diagnostics`；基础设施/I/O 异常和取消沿 Job 交付。
成功产物固定源码、声明及模块依赖，执行不重读磁盘。
`execute(prepared)` 从 Job 上下文之外同步进入关联根，先核验真实身份、所属会话、一次消费与 State 结构版本。
通过准入立即标记 used，运行异常也不能再次使用。
returned/threw 都携带实际定义变化；抛出 undefined 不等于正常返回。

## 版本与范围

局部模块身份包含规范来源、采用文本、依赖及用到的外部定义身份；同一应用中同版本复用原生实例。
循环按完整相关图确定版本，摘要碰撞还比较内容；旧引用保留原实现和固定声明。
主输入每次执行。
初始化失败保留原异常，不自动重跑该版本副作用。

当前适配器支持本地 TS/ES 模块与实际 Core 包入口；未知或不能保证对应关系的外部运行包明确诊断。
与实际采用的只读标准库/Core 声明符号合并的用户声明在准备中返回 `core:shared-library-augmentation`；内建成员查找共享标准库，Core 则保持实际单实例，不能用新增强声明重标记原运行值的完整类型。
其他用户全局声明及模块内同名类型按实际采用程序检查。
顶层 await、动态 import 与无法精确投影的数据形状在准备中诊断，不发射宽松或异步替代路径。
模块代码通过 Node 同步模块钩子执行，不复制 Core，不提供沙箱或业务 I/O 权限。

## 关闭

Session/Compiler 的 close 使用首次原因，共享完成 Promise，停止准入、请求取消并等待实际工作结束；失败后仍 closed。
Session 丢弃未用准备入口，但不清空 State、不清理任意业务对象、不关闭借用服务。
关闭 Compiler 后，仍有效的固定 PreparedInput 可以执行。
关闭操作从自身准备工作之外发起；执行期间不能关闭同一会话破坏发布。
