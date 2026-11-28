# TypeScript 执行逻辑

[bit-commands]: ../design/console-interaction.md#基本指令

## 无冲突的重复引用

通过 `import` 重复引用不会造成重复注册或 ID 冲突。
TypeScript 解析时会对引用情况去重。

因此，外部脚本可以像正常模块一样使用 `import`。
BitAgent 不会因为应用上下文中已经引用过而出现重复 ID 冲突，更不会因为重复引用而阻塞外部脚本执行。

在 BitAgent 中 `import` 的语义相当于「确保某个对象存在」。

当然，对于不同来源的对象，即便引用不重复，但 ID 冲突仍然存在。
请先[丢弃或重命名][bit-commands]旧引用，再引入新的来源的同名对象。
