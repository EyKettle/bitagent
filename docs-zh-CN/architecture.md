# BitAgent 架构设计

English (WIP) | 中文

> 理念与概念由 [concepts.md](concepts.md) 定义。本文不重述理念，只回答一个问题：
> **理念如何变成可编译、可校验、可测试的程序结构。**

## 本文的组织

全文按抽象层次自上而下排列。前三章给出完整的行为图景：总纲是全局约束，一次轮次是"一条消息进来到
一次回应出去"，一次工作是"选定流程到收尾结束"。后五章是它们依赖的定义：支撑设施、数据与持久化、
可见性、契约与验证，以及一份 MVP 实例数据。

| 章 | 回答什么 |
| --- | --- |
| 一 总纲 | 三条哲学落在哪、什么是数据什么是代码、层与层之间怎么依赖 |
| 二 一次轮次 | 一条用户消息如何变成意图数据，以及是否需要流程 |
| 三 一次工作 | 流程如何展开、如何审查、如何裁决、如何收尾 |
| 四 支撑设施 | 标签、上下文、记忆、实体、条件、行为记录各是什么 |
| 五 数据与持久化 | 三种文件的格式、工具链、版本与刷新 |
| 六 可见性 | 事件、问题卡片、状态接口、前端分流 |
| 七 契约与验证 | 不变量、限额、失败与终止、测试形状 |
| 八 MVP 登记 | 用前七章写出来的第一份实例数据 |

**每条规则、每个取值集、每个限额只在一个地方给出权威表述**，别处只引用不重述。找一条规则时，
顺着交叉引用走到定义处即可；同一件事若在两处都有说法，以带结构定义或带错误码的那一处为准。

核心哲学在本文以「行为哲学」「交互哲学」「权力哲学」指称，并附原话，不用序号。

凡写"必须"的地方都注明它在载入期、启动期还是执行路径上被拦住；**写作"建议"的没有强制点**。

术语用 concepts.md 的词。两个只在本文出现的词在此定义：**开发者**指开发东西的人（BitAgent 开发者，
以及开发扩展插件的用户）；**用户**指使用产品的人。

## 一、总纲

### 1.1 三条哲学的强制点

三条哲学各自落在若干条可校验的规则上，每条规则都注明它在哪一期被拦住。

| 哲学 | 原话 | 强制点 | 拦在哪 |
| --- | --- | --- | --- |
| 行为 | 能用程序化流程解决的事情，绝不交给概率 | 控制流由数据描述；步骤只按标签指名已登记的能力，不持过程指针 | 载入期 `Unknown_Iface` |
| 行为 | 同上 | 凡需要判断的位置都在数据里指名由谁判断，并校验它有那份职责 | 载入期 `Bad_Judge` |
| 行为 | 同上 | 谓词封闭、无循环无递归；条件是扁平 AND | 载入期 `Bad_Condition` |
| 行为 | 同上 | 复杂度只有两种来源，没有"由实体自由判断"这条路 | 载入期 `Bad_Complexity` |
| 交互 | 能用图形界面解决的事情，绝不用大量文字替代 | 封闭取值集一律给结构化选项，不写成一段话让用户猜 | 出题构造（程序判定形态，实体无权决定） |
| 交互 | 同上 | 工具按界面准则设计（按步开屏、有默认值、有回执、可就地改正） | 工具模式构造 + 实参校验 |
| 交互 | 同上 | 问题以卡片呈现，至少说清是谁、什么问题、什么原因 | `Problem` 三个必填字段 |
| 交互 | 出现问题优先报告给用户，无论是否阻塞 | 构造与上报是同一个入口，没有"先攒着"的写法 | `report` 是唯一入口 + 不变量 31 |
| 权力 | 尊重用户的知情权和选择权，任何信息都能看到 | 事件全部外送，后端不设显示开关 | `Event_Sink` 无过滤参数 |
| 权力 | 所有状态都要有地方展示，不能以"信息太多"忽略 | 上下文、行为记录、注册表、事实、统计、留守条目各有只读接口 | [6.3](#63-状态接口) 接口表 + 不变量 35 |
| 权力 | 同上 | 任何被简化、跳过、削减、多选未用的东西都有一条对应上报 | 执行路径 + 可测试性断言 |
| 权力 | 即便是垃圾也不会替用户丢掉 | 临时轨道过期也保留，日志里没有删除路径 | 生成上限满则拒绝，不淘汰 |
| 权力 | 用户可以选择让 LLM 处理，但不等同于交给程序自动让 LLM 处理 | 未被数据指名处执行器不得调用实体 | 不变量 12 + 调用栈深度断言 |

最后一条来自 concepts.md 的「决策权力」小节：*即便是垃圾也不会替用户丢掉。用户可以选择让 LLM 处理，
但并不等同于交给程序自动让 LLM 处理*。所以数据里的每一处 `by`（`Gate.by`、`Select_Mode.by`、
`Track.by_*`）不只是配置项，它是**用户授权的凭据**——数据由用户拟定，执行器只按指名调用，于是
"交给 LLM"始终是用户选的。

### 1.2 数据与代码的分界

这条分界是整个架构的地基：**变量是数据，能力是代码。**

| 归属 | 内容 | 可变性 |
| --- | --- | --- |
| 数据（蓝本） | 原子标签表、技能、流程、预测轨道、标准、实体声明 | 用户拟定或经用户批准吸收，热刷新 |
| 数据（运行期本体） | 事实、留守条目、标签请求 | 运行期追加，持久 |
| 数据（运行期副本） | 环境上下文里的一切、行为记录、统计 | 运行期读写，不持久（统计是派生量） |
| 代码 | 程序区编号、接口实现、模板实现、视图实现、谓词求值、各执行器、传输与供应商适配 | 随程序发布 |

流程是主要的变量：它决定行为框架，而它本身是数据。步骤不持有过程指针，只按原子标签指名一个
已登记的接口、模板、视图或实体；登记表在代码侧，指名在数据侧。于是新增一份**能力**要改代码，
而重组一段**工作**不用——后者才是天天在变的东西。

**蓝本与副本的分界同样是硬的。** concepts.md 说环境上下文里的标准、技能、文件快照都是副本，
本体在本地永久储存。所以本文凡出现"快照"二字，指的都是副本，它的生命周期跟着上下文的层走；
本体只有一份，在文件里。这条让"唯一事实来源"不必和"记忆要持久"打架——见 [4.2](#42-环境上下文)。

### 1.3 分层与依赖方向

依赖单向朝内。最内层既不知道 HTTP，也不知道 LLM 供应商。

| 层 | 位置 | 单一职责 |
| --- | --- | --- |
| 传输 | `server.odin` | 收发 HTTP 与 SSE 字节，不做任何决策 |
| 实例 | `agent.odin` | 一个活动代理：持有注册表版本、常驻层上下文、会话 |
| 控制 | `lib/control/` | 载入与校验、飞行检查、选轨、执行轨道、选流程、执行流程 |
| 能力 | `lib/llm_request/` | 与 LLM 供应商通信（流式 + 工具调用 + 可中止） |
| 工具 | `lib/flag/`、`bagtool` | 标签位图；数据文件的读写与校验 |

```text
main.odin ──装配──▶ server.odin ──▶ agent.odin ──▶ lib/control
                                        │              ▲
                                        │              │注入过程指针
                                        └──▶ entity_bridge.odin ──▶ lib/llm_request
                                             interfaces.odin
                                             templates.odin
```

`lib/control` 不 import `lib/llm_request`，不 import `network:odin-http`，**也不 import 根包**。
它只声明三张登记表的过程指针类型（调用实体、执行接口、渲染模板与视图），生产实现由根包在启动
时注入，测试实现由测试注入。

**控制层不接网络即可完整运行**——这是全部测试的前提，也是"程序控制流程"这句话的检验标准：
如果控制流必须有模型在线才能推进，控制权就还在模型手里。

依赖方向是可编译性约束，不是风格偏好。控制层的执行器要读写"当前这份状态"，如果它为此持有根包的
`Agent`，两个包就互相 import——**在 Odin 里直接编译不过**。所以控制层定义自己需要的那三样，
根包组合它：

```odin
// lib/control/host.odin —— 控制层执行一步所需的全部状态，由根包填好后传入
Host :: struct {
	registry: ^Registry, // 本次工作绑定的不可变版本（含标签表）
	ctx:      ^Context,   // 环境上下文：唯一事实来源，按层组装的视图
	acts:     ^Act_Log,   // 行为记录：与状态记录并列的另一半
}
```

`Host` 只有三样，不是四样。**记忆没有单独的槽位**：技能与标准的本体在 `control.ctrg` 文件里，注册表
持有的是它的只读映射（所以"本体在本地永久储存"与"从注册表取用"说的是同一件事）；事实的本体在运行期
日志里，进入上下文的都是副本。**行为记录有单独的槽位**：concepts.md 把会话定义为"行为记录 + 状态记录"，
两者并列，所以它不是上下文的一个条目类，而是 `Host` 的第三样。控制层九成的 `Act` 都产生在这里，
没有这个槽位就只能靠实例层回填，那是结构上不通。

**活动代理**在实例层这一侧。一个活动代理是一个 BitAgent 实例，含多个 LLM 实体，持有自己的
注册表版本、常驻层上下文与会话存储。所以这些东西挂在实例上，不做全局量——多活动代理的隔离边界
从一开始就在结构里，MVP 只实例化一个。

```odin
// agent.odin
Agent :: struct {
	id:       Flag,
	registry: ^control.Registry,  // 当前版本
	pending:  ^control.Registry,  // 待生效版本；nil 表示无
	standing: control.Layer,      // 常驻层上下文：身份、配置、计量、统计
	sessions: Session_Store,      // 会话存储是实例层的事，控制层不需要知道
	admin:    control.Event_Sink, // 管理端事件出口：reload 的卡片投这里
}

// session.odin
Session_Store :: struct {
	byid: map[string]^Session,
	lock: sync.Mutex,             // 保护表与各会话的 in_flight
}

Session :: struct {
	id:         string,           // 32 位十六进制，服务端用密码学随机生成
	created_at: time.Time,
	touched_at: time.Time,
	in_flight:  bool,             // 同一会话不允许并发轮次
	log:        control.Act_Log,  // 行为记录与问题卡片本体
	layer:      control.Layer,    // 会话层上下文
	work:       ^control.Work,    // 进行中的工作（就是工作层）；nil 表示没有
	arena:      virtual.Arena,
}
```

实体不在这里列举：它们是注册表里的数据（`Registry.entities`），随版本刷新。"一个活动代理含多个
LLM 实体"因此是数据事实，不是结构字段。

### 1.4 命名与错误处理约定

命名：类型 `Pascal_Snake_Case`，过程 `snake_case`，常量全大写，内部过程标 `@(private)`。
一个概念一个词——本文与代码里，"轨道"只叫 track、"环节"只叫 phase、"段"只叫 segment，不混用近义词。
布尔量用谓词形式（`awaits_user`、`enabled`），集合用复数（`steps`、`entries`）。

每个文件开头 3–6 行中文注释，说明该文件职责与非显然的取舍。注释只写**为什么**：做什么由代码本身
表达，怎么做由命名表达，注释只解释取舍的理由。

**错误处理是架构决策，不是各处自选。** 两条路，泾渭分明：

| 情形 | 表达 | 例子 |
| --- | --- | --- |
| **预期的失败** | 返回值的最后一位是错误枚举；`(value, Error)` | 载入被拒、实参不合法、追问用尽、审查未通过 |
| **异常** | 断言或就地终止本轮并上报，不进任何"终止种类"表 | 飞行检查的实体调用彻底失败、分配器耗尽、注册表指针为空 |

分界依据是《The Pragmatic Programmer》第 34 条：**异常只用于异常情况**，预期分支用条件表达。
所以飞行检查失败不是一种 `Terminal`——它是每轮必经的第一步，跑不起来意味着环境坏了，不是一种
可以设计应对的业务结果。它照旧出一张问题卡片（"出现问题优先报告给用户"不因它是异常而豁免），
但不进 [7.3](#73-失败与终止) 的终止分类表。

不用 nil 指针表示**失败**，不返回 null；可失败过程的错误枚举各自专用，不共享一个笼统的 `Error`
——分类的依据是"调用方要怎么处理"，不是"错误从哪来"。**"缺值"与"缺层"是两件事**：一个可能没有值的
字段用 `Maybe(T)`（`Mode.condition`、`Ask_Entity.emit`）；一个指向"目前不存在的那一层／那个阶段"的
指针可以是 nil（`Context.work` 无工作时、`Agent.pending` 无待生效版本时、`Work.pending` 无挂起时）。
后者不是缺值，是**这一层还没开始**，用 `Maybe(^T)` 只会多一层包装而不多一点信息。

## 二、一次轮次

一次轮次是"一条用户消息进来，一次回应出去"。

### 2.1 轮次的完整路径

```text
用户输入（一句话，或对上次出题的一次选择）
  │
  ▼
[传输] 校验请求 ──────── 越限 / 格式非法 ──▶ 400
  │
  ▼
[实例] 取或建会话
  │      ├─ 会话忙 / 会话数满 / 并发满 ──▶ 终止应答
  │      ├─ 无进行中的工作 ──▶ 先应用待生效的注册表版本，再开新工作
  │      └─ 有挂起点 ──▶ 沿用本次工作绑定的版本，按挂起类型直接续接
  │              ├─ 澄清挂起 ──▶ 回到轨道的中断步骤
  │              ├─ 报告挂起 ──▶ 按用户裁决：进收尾 / 回跳返工 / 丢弃收尾重新规划
  │              └─ 确认挂起 ──▶ 用户批准则由程序执行该接口，拒绝则终止应答
  ▼
[控制] 飞行检查：一次实体调用，提交 叙述清晰度 + 需求类型（两个封闭取值集）
  │
  ▼
[控制] 选轨：按 清晰度 + 需求类型 + 已知事实 求值各轨道的条件，层序内首个命中者胜
  │      └─ 全部未命中 ──▶ 现场生成临时轨道（reasoner，提示含轨道创建指南）
  │                          └─ 生成失败 ──▶ 如实告知不会处理
  ▼
[控制] 轨道执行：按 condition 决定深度，逐步解析用户消息、落定槽位
  │      ├─ 缺槽位且准许提问 ──▶ 出题（封闭槽位给控件，含自由文本才由 writer 写问句）
  │      │                       └─ 记录澄清挂起 → 本轮结束
  │      ├─ 第一层预加载：筛选出本次可能要用的技能与标准（只筛不载）
  │      └─ 追问用尽 / 回答无法满足 / 解析失败 ──▶ 终止应答
  ▼
[控制] 产出意图数据，并决定是否需要流程
  │      ├─ 不需要（闲聊）──▶ 一次实体回话 → 本轮结束，不开工作
  │      └─ 需要 ──▶ 意图种类查表得到流程（一对一）
  ▼
[控制] 一次工作开始（见第三章）
  ▼
[传输] SSE 事件流：Session / Step / Reasoning / Content / Question / Report / Problem / Done
```

六条非直线路径都是一等公民，不是异常兜底：**未命中 → 现场生成临时轨道**、
**缺槽位 → 出题并挂起**、**不需要流程 → 直接回话**、**审查不通过 → 回跳**、
**低于门槛 → 简化或省略**、**无法处理 → 如实告知**。另有一条贯穿全程：
**任何一处出问题，就地上报，不论是否阻塞。**

**轨道期只解析与筛选，不加载、不执行工作。** 这条取舍有两个理由：意图尚未落定时多筛的代价远小于
漏筛，而真正的加载要等到知道哪些是真需要的时候；同时它让轨道期的成本可预测——轨道再长也只是
若干次解析，不会因为一句话而把整个工程目录读进上下文。

### 2.2 飞行检查

在执行预测轨道前**总是**执行一次飞行检查。它判两件事，都是封闭取值集，都由程序定义等级：

```odin
// lib/control/triage.odin

// 叙述清晰度：决定用哪条轨道，类似流程的大分支。
// 成员顺序即序关系，**数值越大越清晰**——这样 At_Least 读作"不低于"才不反义。
Clarity :: enum {
	Vague,         // 在探索自己的需求：侧向表达多，词汇抽象
	Under_Severe,  // 知道为什么，不知道要什么：动机清楚，范围不清
	Under_Mild,    // 知道要什么，不知道怎么做：细节未定
	Explicit,      // 指令完整：任务、边界、约束都清楚
}

// 需求类型：决定轨道的形态与长度。
Demand :: enum {
	Chat,       // 闲聊：不必深入推理
	Discussion, // 讨论：需要深度思考与探索
	Task,       // 任务：需要提前分析行为边界
}

Triage :: struct {
	clarity: Clarity,
	demand:  Demand,
}
```

飞行检查是一次实体调用，实体用 `submit_triage` 提交两个 `Flag_Value` 参数，取值集就是上面两组
程序区标签。判断自然语言的清晰度与类型是概率工作，程序做不了；但**结果落成两个原子标签之后，
后续全部是逻辑确定的**——这正是"LLM 只负责翻译"的形状：它把自然语言译成机械可读的两个数，
接下来的分支由程序算。

由哪个实体来答，在数据里指名，不由执行器写死。轨道注册表有一条**默认指派**（`Registry.triage_by`），
单条轨道不覆盖它——飞行检查发生在选轨之前，此时还没有轨道可言。默认指派本身是数据，由用户拟定，
所以"交给 LLM 判"仍然是用户选的。

**飞行检查不设终止种类。** 它跑不起来（供应商不可用、鉴权失败、墙钟越限）是异常而非预期失败：
按 [1.4](#14-命名与错误处理约定) 的分界，异常照旧出一张 `Blocking` 问题卡片，但不进
[7.3](#73-失败与终止) 的终止分类表，也不为它设计"降级用哪条轨道"的兜底——那会让"没有清晰度判定"
悄悄变成一种正常状态。

清晰度**只做一件事：选轨道**。问什么、问几个由轨道的步骤与槽位决定。把出题密度直接挂到清晰度上
会让"越模糊问得越多"变成没有判据的手感；挂到轨道上，则每一级的行为差异是可枚举、可测试的：

| 清晰度 | 轨道形态 | 出题 |
| --- | --- | --- |
| `Explicit` | 直取：只落定必需槽位 | 不出题 |
| `Under_Mild` | 默认值：程序填 `Field_Spec.default` 并在事件里留痕 | **不出题**（此级的风险是问得太多，不是问得太少） |
| `Under_Severe` | 盘点：先落定"要做什么"这一层 | 必然出题，封闭选项枚举可能的干预方式 |
| `Vague` | 诊断：以出题为主体 | 只问，不落定执行层槽位，**且不选流程** |

`Under_Mild` 的"填默认必须留痕"与权力哲学配对：不打断用户，但不许悄悄决定。**默认值的来源是数据**
（`Field_Spec.default`），不是执行器现编的——没有声明默认值的必填槽位，即便在 `Under_Mild` 也照旧出题。
`Vague` 那一轮的产物就是把 `Vague` 变成 `Under_Mild` 或 `Under_Severe`——用户答完进下一轮，
重新飞行检查。

### 2.3 轨道的选取

轨道是**思维骨架**：它锁定一套用户消息的解析方式，产出逻辑确定的意图数据。工作量小，但决定后面
全部走向。

```odin
// lib/control/track.odin

Track :: struct {
	id:         Flag,
	tier:       Tier,         // 由文件里的 tier 字段给出，程序赋值，内容声明一律忽略
	priority:   u32,          // 程序赋值，取 len(conditions)
	yields:     []Flag,       // 本轨道能导向的意图种类集合；空集表示不导向流程
	conditions: []Condition,  // 全部成立才命中；空集在载入期即被拒
	tags:       Tag_Set,      // 本轨道声明它可能要用到的技能与标准，第一层预加载读它
	steps:      []Track_Step, // 可以为空：不导向流程的轨道无槽位可落定
	by_asker:   Flag,         // 出自由文本问句的实体
	by_judge:   Flag,         // 判定自由文本作答是否满足该步目标的实体
	reply_by:   Flag,         // 仅 yields 为空时：由哪个实体回话
	reply_tmpl: Flag,         // 仅 yields 为空时：回话用哪个提示模板
	enabled:    bool,
}

Tier :: enum {
	Authored,  // 用户拟定
	Absorbed,  // 用户在收尾环节批准吸收的
	Temporary, // 本次工作现场生成的，还没被处理
}
```

**`yields` 是集合，不是单值。** 轨道是按"怎么解析"分的，不是按"解析出什么"分的——清晰度四级乘需求
类型三值只有十二种组合，而意图种类是用户可以任意增加的。若一条轨道只能导向一个意图种类，两个同为
"任务 + 清晰"的不同请求就无从区分：它们会命中同一条轨道（条件完全相同），而先命中的那条会把另一条
永久遮住。

所以**意图种类本身是轨道解析出来的第一个槽位**：轨道的首步必须落定它，取值集是 `yields`
加上 `Closed.No_Match`。选中 `No_Match` 即"这条轨道认不出你要什么"，转去生成临时轨道。
载入期校验：`yields` 里每个种类都有已启用的流程（`No_Flow`），且每条流程的必填字段都被本轨道后续
步骤覆盖（`Slot_Uncovered`）。

`by_asker` 与 `by_judge` 在数据里指名，不由执行器写死——这是 [1.1](#11-三条哲学的强制点) 最后
一条的直接后果：轨道期同样有"把决定交给 LLM"的位置，同样必须由用户授权。载入期校验：**只要有任何一步
`ask.allowed` 为真**，`by_asker` 就必须非空且能力为 `Write_Text`、`by_judge` 必须非空且能力为
`Review`；全部步骤都不提问时二者可为 `FLAG_NONE`。否则 `Bad_Judge`。

`reply_by` 与 `reply_tmpl` 与 `yields` **互斥**：`yields` 为空时二者必须非空且 `reply_by` 的能力为
`Write_Text`；`yields` 非空时二者必须为空。否则 `Bad_Reply`。没有这两个字段，"闲聊直接回话"就得由
执行器写死一个实体名。

选轨是纯查表加求值，零实体调用：

```odin
select_track :: proc(h: ^Host, t: Triage) -> (track: ^Track, miss: Miss_Reason)

Miss_Reason :: enum {
	None,
	No_Track,         // 一条启用的轨道也没有
	Conditions_Unmet, // 有轨道但条件都不成立
}
```

顺序是全序、可复现：先 `Authored` 后 `Absorbed`，同层内 `priority` 降序，同优先级按 id 升序。
**层序保证吸收进来的轨道只能补空白，抢不到既有覆盖**——这是结构保证，不是策略保证。
`priority` 由程序赋值（取 `len(conditions)`，越具体越先试），文件里写什么都忽略。

轨道的条件能读什么，由 [4.5](#45-条件封闭谓词) 的主语表限定。选轨期只有三种主语可用——
清晰度、需求类型、事实——因为槽位尚未落定、复杂度尚未算出、模式尚不存在。载入期校验
`Track.conditions` 只用这三种，否则 `Bad_Condition`。**用户原话不是主语**：把控制流绑回词汇会让
英文输入不命中、"不要重构"反而命中，而且不命中是静默的。要按措辞分支，正确做法是让飞行检查或
解析步骤把它译成一个原子标签。

### 2.4 轨道的解析步骤与出题

```odin
Track_Step :: struct {
	goal:      string,      // 这一步要想清楚什么，写进提示（字符串以免失真）
	condition: []Condition, // 对已落定槽位求值；空集恒真
	resolves:  []Flag,      // 该步要落定的槽位键
	tags:      Tag_Set,     // 落定之后追加进第一层筛选的标签
	by:        Flag,        // 执行本步解析的实体；能力须为 Capture_Intent
	ask:       Ask_Policy,
}

Ask_Policy :: struct {
	allowed:   bool,
	direction: string, // 提问的方向与目标，字符串以免失真
	max_turns: u32,    // 不得超过 MAX_CLARIFY_TURNS
}

Track_Outcome :: union {
	Intent,          // 解析完成
	Prompt_To_User,  // 需要出题，本轮在此挂起
	Clarify_Failure,
}

Clarify_Failure :: enum {
	Asks_Exhausted,    // 追问次数用尽
	Unresolvable_Slot, // by_judge 判定用户的回答无法满足该步目标
	Translate_Failed,  // 槽位值解析不出原子标签
}
```

`Translate_Failed` 是"标签表表达不了这件事"的第一个信号，所以它的卡片额外附上**这一步想落定的槽位、
它的取值集、以及实体给的那个词**——用户看完可以直接去标签界面加一个标签，下一轮就命中了。
备用通道（`propose_label`）只在生成临时轨道时开放，而这条路径上还没走到那里；把线索放进卡片，
是让"多一个来回"这个代价至少是一次**有信息的**来回。

**轨道的执行深度由数据描述，不是代码分支**：每步的 `condition` 决定它是否执行，所以同一条轨道在
不同清晰度下走出不同长度。任务型轨道的步骤就是行为边界分析那一串——是 Demo 还是工程实践、
项目级别与工作量、生产环境安全要求、工作边界是什么——每步落定一个槽位。

槽位的取值集不写在轨道里，写在流程的字段声明里。载入期校验：每个 `resolves` 的键必须是 `yields` 里
**某一个**意图种类对应流程声明过的字段，且每条流程的必填字段都被某一步覆盖（`Slot_Uncovered` /
`Unknown_Slot`）。于是任何轨道都产不出流程消费不了的意图，吸收进来的轨道也发明不出新槽位。

一条轨道导向多个意图种类时，落定「意图种类」之后的步骤按 `condition` 分流：读
`Subject.Intent_Kind` 就能写出"只有撰写类才问工作量"。**这也是 `Intent_Kind` 这个主语在轨道期就要
可用的原因。**

出题形态由程序判定，不由实体决定：

- 所有缺失槽位都有封闭取值集 → 问句用模板生成，选项照搬字段声明的取值集，**不调实体**
- 存在自由文本槽位 → 由 `by_asker` 指名的实体写一句问句，`emit = .Question`；封闭槽位仍以选项
  并列给出
- `Under_Mild` 级别 → 不出题，缺失的非必填槽位取默认值，并发一条 `Notice` 说明填了什么

用户作答两种形态：选择（`User_Chose`）直接落定槽位，不经 LLM；自由文本（`User_Said`）才交给
`by_judge` 判定是否满足该步目标。

### 2.5 第一层预加载：筛选

轨道期筛出**本次可能要用到**的技能、标准与工作路径信息，只筛不载。筛选的载体是标签集合的位运算：

```odin
// 第一层：轨道声明的 tags ∪ 各解析步骤落定槽位后追加的 Track_Step.tags
prepared: Tag_Set
```

第二层在流程开始时算出 `needed` 并真正加载（见 [3.3](#33-第二层预加载加载)）。两层的关系是三个
集合运算，每一个都有用户可见的含义：

| 集合 | 含义 | 处置 |
| --- | --- | --- |
| `prepared & needed` | 筛对了 | 加载进环境上下文 |
| `needed &~ prepared` | 第一层漏筛 | 临时补取，并发一条 `Notice`——漏筛是轨道该改的信号 |
| `prepared &~ needed` | 第一层多筛 | 不加载，并发一条 `Notice` 记下多筛了什么 |

后两个差集必须外送。按权力哲学，"多筛了什么、漏筛了什么"是程序替用户做的判断，不许悄悄算完扔掉；
它们同时是唯一能告诉用户"轨道的筛选准不准"的信号，也就是调轨道的依据。

### 2.6 临时轨道

不存在合适的轨道时，调实体按**轨道创建指南**现场生成一条临时轨道，再遵循它解析用户意图。
指南是一份视图，含轨道结构的完整说明、谓词的合法组合与可用的原子标签。

```odin
// lib/control/leftover.odin

Temp_Track :: struct {
	seq:     u64,          // 运行期日志里的序号，去重与引用都用它
	track:   Track,        // 结构与正式轨道完全一致，住在工作层
	state:   Temp_State,
	made_at: time.Time,
	trigger: Triage,       // 当时的清晰度与需求类型，供用户判断值不值得吸收
}

Temp_State :: enum {
	In_Use,   // 本次工作正在用
	Stale,    // 未走到收尾就被放弃（用户重新规划、或工作重头再来）
	Absorbed, // 用户批准吸收
	Declined, // 用户拒绝
}
```

草案与正式结构的区别只有一处：**凡是 `Flag` 的位置在提交时都还是语义标签文本**，等着走一次
`resolve_label`。所以草案校验就是"解析 + 走一遍正式的载入校验"，不需要第二套校验逻辑。
两条豁免要写明，否则每条临时轨道都会被自己的校验拒掉：**`No_Conditions` 不适用**（临时轨道不参与
选轨，是现场指定的，没有条件可言），**`priority` 与 `tier` 由程序填**（`Tier.Temporary`）。
其余校验一条不减；不过即整条丢弃并上报——学习失败不能静默。

**临时轨道一旦生成就落进运行期日志，不等吸收。** 三条规则来自 concepts.md：

- **一直保留直到用户处理，程序不替用户选择丢弃。** 未走到收尾就被放弃的置 `Stale`，**不删除**。
  无论经历怎样的变动和重头再来，它都留着。
- **总是在收尾环节向用户申请处理，不会在其他环节打断工作。** 所以它不是一种挂起点，是收尾环节的
  一个必然步骤——见 [3.10](#310-留守条目与吸收固化)。
- **不存在后台的隐式吸收。** 没有自动准入，也没有自动退役：吸收与否是用户的决定，未经用户决策的
  吸收有豆腐渣风险。

这一条同时决定了架构里**没有**什么：没有准入结果枚举、没有命中率阈值、没有自动置 `enabled = false`
的退役判定。统计仍然记（状态展示要它），但它不驱动任何控制流——见 [4.2](#42-环境上下文) 里
"统计是派生量"。

### 2.7 是否选择流程

轨道是"决定**是否选择**以及选择什么流程之前的必要经历"。所以轨道有两种出口：

| 轨道的 `yields` | 出口 | 后续 |
| --- | --- | --- |
| 空集 | 不需要流程 | 由 `reply_by` 一次实体回话，本轮结束，**不开工作** |
| 非空 | 需要流程 | 首步落定的意图种类查表得到流程（一对一），进入第三章 |

闲聊走前者：它没有可交付的产物、没有可审查的结果、没有要处理的状态生命周期，硬给它套六环节只会
让审查、优化、收尾三个环节空转。`Vague` 级别也走前者——那一轮的任务就是把需求问清楚。

**无流程分支不是特例通道。** 它照旧产生行为记录、照旧经过环境上下文、照旧发事件，只是不开
`Work`、不占工作层、不刷新注册表版本（没有工作边界）。因此它也不处理留守条目：那要等下一次有收尾
的工作。

```odin
// lib/control/intent.odin

// 解析产物。键由工具模式固定，故未采信的只有值。
Intent_Draft :: struct {
	slots:     []Slot_Draft,
	utterance: string,      // 原话，出题与临时轨道要用；不参与任何条件求值
}

Slot_Draft :: struct {
	key:  Flag,   // 由工具模式给定，可信
	text: string, // 待解析，或待作为自由文本采纳
}

// 采信后的意图数据。
Intent :: struct {
	kind:   Flag,          // 意图种类；决定流程
	slots:  []Slot,
	origin: Intent_Origin,
}

Slot :: struct {
	key:   Flag,
	value: Value, // 封闭槽位落成 Flag，自由文本槽位落成 string
}

Intent_Origin :: struct {
	track: Flag, // 命中或生成的轨道 id
	tier:  Tier,
	temp:  u64,  // 非 0 表示由临时轨道产出，值是它的 seq
}
```

意图种类不是编译期枚举——它是原子标签，因为技能与流程是用户可拟定的数据。"默认拒绝"由两道校验
落实：标签必须在标签表内，且必须有已启用的流程声明处理它。两者缺一即当作未命中。

## 三、一次工作

一次工作从选定流程开始，可能跨多轮，到收尾结束。

流程决定行为框架：**复杂度决定步骤，步骤决定行动路径，每步的限定条件与模式决定行动细节。**
它从属于某个技能，是数据，可由用户拟定或经用户批准吸收。

### 3.1 工作的完整路径

```text
选定流程
  ▼
预测检查（必然的第一个环节）
  ├─ 按流程声明的 cplx 取复杂度（固定值，或指名槽位的值）
  ├─ 算出 needed，第二层预加载：真正加载进环境上下文
  └─ 三个差集各发一条事件
  ▼
从顶层段起走 —— 顶层段首步必然是模式选择
  │
  ├─ 模式选择步骤 ─▶ 按候选顺序取首个条件成立者
  │                   全不成立 ─▶ 兜底模式，或交 by 指名的实体在候选里挑
  │                   ─▶ 展开该模式的段（就地），执行完回父段继续
  │
  ├─ 每步先程序化检查（对已落定标签求值 require，再比门槛）
  │        必要时叠一次 LLM 保底检查 ─▶ Execute / Simplify / Skip
  │
  ├─ 审查步骤不通过 ─▶ 沿本段回跳边回到更早的步骤，受 max_loops 约束
  │
  ├─ 带 awaits_user 的步骤 ─▶ 记录挂起点（连段栈一起）→ 本轮结束
  │        用户裁决 ─┬─ 结束     ─▶ 允许进收尾
  │                  ├─ 返工     ─▶ 沿本步声明的回跳边回去
  │                  └─ 重新规划 ─▶ 丢弃本流程的收尾，回到预备与用户盘点需求
  │
  ├─ confirm 的接口 ─▶ 转成确认挂起，用户批准后由程序执行
  │
  └─ 收尾环节 ─▶ 仅在三项证据齐备时执行；同时盘点留守条目
  ▼
工作结束：整层清理工作层上下文，在工作边界应用待生效的注册表版本
```

**有界性在载入期就要证明**，不靠运行期计数兜底。段不成环、回跳只能向后且有轮数上限、模式嵌套有
深度上限、展开路径条数有限——这些都是载入期可判定的性质，于是"流程一定会停"不是希望，而是它的
反面会被拒绝载入。[7.2](#72-预算与限额) 的运行期限额是第二道闸，不是唯一的闸。

**步骤与环节是两码事**：步骤是执行序列，环节是贴在步骤上的语义标记。一个环节含多个步骤，一个
步骤可属于多个环节。所以环节不是容器，是集合成员关系。

流程由**步骤池**和**段**构成：池里是步骤本体，段给出顺序与回跳边。模式选中哪一段就展开哪一段
——结构在段里，不在步骤里。

三条结构规则在载入期强制，一处写清：**每个段的序列都是步骤池的子集，同一步骤不在一段内出现两次**
（`Bad_Segment`）；**步骤池里的每个步骤至少属于一个段**，否则是死代码（`Orphan_Step`）；
**回跳边只能指向本段序列里更早的步骤**（`Bad_Jump`）。

```odin
// lib/control/flow.odin

Flow :: struct {
	id:      Flag,
	handles: Flag,              // 处理的意图种类，一对一
	fields:  []Field_Spec,      // 轨道可落定的槽位声明，同时用于出题与解析
	steps:   []Flow_Step,       // 步骤池，按 id 索引，本身不定序
	modes:   []Mode,            // 模式池
	root:    Segment,           // 顶层段；首步必须是模式选择
	cplx:    Complexity_Source, // 复杂度从哪来
	needs:   Tag_Set,           // 本流程真正需要的技能与标准，第二层预加载读它
	tier:    Tier,
	enabled: bool,              // 显式声明，不靠零值
}

// 段是"顺序 + 回跳边"。结构在段里，所以模式改变结构就是换一段。
Segment :: struct {
	sequence: []Flag, // 步骤 id 的有序序列，须是步骤池的子集
	jumps:    []Jump, // 回跳边，只能指向本段内更早的步骤
}

Jump :: struct {
	from:      Flag,
	to:        Flag,
	max_loops: u32, // 不得超过 MAX_REFINE_ROUNDS
}

Field_Spec :: struct {
	key:      Flag,
	required: bool,
	label:    Flag,   // 出题时给用户看的名字；`Slot_Prompt.label` 就是 label_of(它)
	options:  []Flag, // 封闭取值集
	free:     bool,   // 真表示本槽位收自由文本，此时 options 必须为空
	default:  Value,  // 缺席即无默认值；Under_Mild 级别只对有默认值的槽位免出题
}

Flow_Step :: struct {
	id:          Flag,
	phases:      Phase_Set, // 该步属于哪些环节，可多个
	gate:        Gate,      // 前置条件、精简门槛、保底检查
	action:      Action,
	awaits_user: bool,      // 执行后本轮挂起，等用户裁决
	adjust_to:   Flag,      // awaits_user 时"返工"跳回哪一步；FLAG_NONE 表示不支持返工
}

Phase :: enum {
	Prepare,  // 预备：以官方和规范的资料锚定路径，预测结果与应对
	Work,     // 工作
	Review,   // 审查
	Refine,   // 优化
	Report,   // 报告：交付并（可选）等待用户裁决
	Teardown, // 收尾：证据齐备且用户批准后处理状态生命周期
}

Phase_Set :: bit_set[Phase]
```

`awaits_user` 不能由 `Report` 环节代替：两个步骤都可以属于报告环节，一个答完即止，一个必须等
用户批准才能进收尾。**环节是语义标记，挂不挂起是执行语义**，两者不是一回事。

`adjust_to` 是显式字段，不靠"以本步为 `from` 的那条回跳边"推断——那需要额外保证"每个 `from`
至多一条出边"，而那条约束本身也得校验。显式声明省掉一层推理，并让"这个报告点支不支持返工"在数据
里看得见。

### 3.2 预测检查两层

每个流程必然先过一次预测检查。它定三件事：**预加载什么、复杂度是多少、后续展开哪些步骤**。

**复杂度从哪来，必须由数据说清。** 流程并不知道哪个槽位是难度——有些流程根本没有难度槽位。
所以流程自己声明来源：

```odin
Complexity :: enum {Trivial, Simple, Normal, Complex, Heavy}

Complexity_Source :: union {
	Complexity, // 固定值：这条流程的工作量恒定
	Flag,       // 槽位键：取该槽位的值，须落在复杂度五级的保留标签内
}
```

载入期校验：取槽位时该键必须在本流程 `fields` 内，且它的 `options` 是复杂度五级的子集（于是轨道
出题时用户看到的就是这五项，实体能填的也只有这五项），否则 `Bad_Complexity`。
**没有第三种来源**——不存在"由实体自由判断复杂度"这条路，那会让工作量脱离数据控制。

每个步骤都带前置条件与精简门槛。检查分两层，程序先行，实体保底：

```odin
Gate :: struct {
	require:   []Condition, // 程序化检查：不满足即跳过该步；空集恒真
	threshold: Complexity,  // 精简门槛：复杂度低于此则该步可简化或省略
	backstop:  Backstop,    // LLM 保底检查
	by:        Flag,        // backstop 非 None 时由哪个实体来判
}

Backstop :: enum {
	None,     // 不需要保底，程序化检查即终局
	On_Below, // 仅当复杂度低于门槛时，交实体判断这步是否真的可省
	Always,   // 每次进入前都问一次
}

Gate_Outcome :: enum {Execute, Simplify, Skip}
```

1. **程序化检查**：对已落定的原子标签求值 `require`，再比对 `threshold`。够则 `Execute`，
   低于门槛则暂定 `Simplify`，前置条件不成立则 `Skip`。全自动，无 LLM。
2. **LLM 保底检查**：按 `backstop` 决定是否问实体一次，避免无意义的工作。实体只能在三个结果里选
   一个（工具的取值集就这三项），选完由程序执行——**决定权在程序读结果之后**。

`backstop = None` 时程序化检查即终局：低于门槛就按 `Simplify` 执行，不再问。所以**把门槛设成低于该步
所在路径的复杂度下界，等于声明"这一步永不简化"**——`draft_text` 里那些 `琐碎` 门槛就是这个意思，
不是随手填的。

`by` 的能力必须是 `Reason` 或 `Review`：判断"这一步是否真的可省"是判断而非撰写。载入期校验
`backstop != None` 时 `by` 非空且能力落在这两者内，否则 `Bad_Judge`。这与 `Select_Mode.by`、
`Track.by_judge` 同构——**凡要实体做判断的地方，都在数据里指名是谁、并由载入期校验它有那份职责**。
执行器不挑实体，它只按指名调用。

`Simplify` 的语义由动作自己解释：接口调用取简化实参，撰写取更短的篇幅要求，审查只查硬性项。
程序不会把 `Simplify` 悄悄当成 `Execute`；每一次 `Simplify` 与 `Skip` 都发一条 `Degraded` 上报。

**门槛必须可达。** 若一条 `On_Below` 步骤的门槛不高于"它所在的段能被走到时的复杂度下界"，保底检查就
恒不触发，两层预测检查退化成一层。这个下界是能算的：模式条件是对 `Complexity` 的封闭谓词，展开路径
条数有限，所以对每条展开路径都能求出它的复杂度可达区间。载入期校验：`On_Below` 步骤的 `threshold`
必须**严格高于**它所在展开路径的复杂度下界，否则 `Unreachable_Backstop`。

按整条流程的下界来判是不够的——一个只在"复杂度 ≥ 普通"的段里出现的步骤，门槛设成 `简单` 照样恒不
触发，而按流程下界（`琐碎`）算却会通过。**校验的粒度必须和可达性的粒度一致。**

### 3.3 第二层预加载：加载

预测检查环节把第一层筛出的候选落实成真正的加载。`needed` 由三部分并起来：

```odin
needed = flow.needs                          // 流程声明真正需要的标准与技能
       | tags_of_slots(work.intent.slots)    // 已落定槽位牵出的（如工作路径、工程文件）
       | tags_of_gates(expanded_steps)       // 展开路径上各步骤 require 读到的事实课题
```

加载的内容按 [4.2](#42-环境上下文) 的条目类落进**工作层**：额外标准的正文、工作路径的文档快照、
外部文档快照、已知需要的工程文件快照。它们都是副本，本体在文件里或工程目录里；工作结束整层清掉，
不必逐个回收。

三个差集的处置见 [2.5](#25-第一层预加载筛选)。**`needed &~ prepared` 允许临时补取，但补取有上限**
（`MAX_LATE_LOADS`），越限即 `Budget_Exceeded`。漏筛应该去改轨道，而不是靠运行期无限补救；有上限才会
让漏筛暴露成一个必须处理的信号。

### 3.4 流程模式与段

不同模式直接改变整个流程的**结构**。**模式选择本身是一个步骤**，而**这个步骤的位置是成文期定的，
不是运行期插的**：流程作者在拟定流程时决定"这里要分一次岔"，运行期只是走到那一步、按条件或让实体
在候选里挑一个。

顶层段的首步是模式选择，定下大分支；被选中模式的段里还可以再有模式选择，定下小分支。
**大模式套小模式**就是段的嵌套，深度受 `MAX_MODE_DEPTH` 约束。

展开规则：走到模式选择步骤时，选中模式的段就地展开并执行；该段执行完，回到父段继续往下走。所以
"模式控制后续步骤的整体结构"是**词法作用域**式的——一个模式的影响范围就是它自己那一段，边界在
成文期看得见，不需要运行期回滚任何东西。

```odin
Mode :: struct {
	id:        Flag,
	condition: Maybe([]Condition), // nil 只由实体挑；Some([]) 恒真即兜底；Some(…) 按条件自动选
	brief:     string,             // 交给实体选择时的说明
	segment:   Segment,            // 选中它就展开这一段
}
```

选择规则与预测检查同构，程序先行：按候选声明顺序取首个条件成立的模式（全序，可复现）；全都不成立
时，才让 `Select_Mode.by` 指名的实体在候选集里选一个。实体选的是**封闭集合里的一项**，不是"下一步
做什么"——候选集、每一项对应的段、段里的每一步，都是数据早就写死的。

两种成文期意图都得表达得出来：

| 作者想要的 | 怎么写 | 例子 |
| --- | --- | --- |
| 程序按条件定，另有兜底 | 前面的候选带条件，末尾一个 `Some([])` | 工作量低→速写，否则正式 |
| 交实体判断（程序没有判断依据） | 候选一律不声明条件（缺席），`by` 指名实体 | 该写成说明文还是叙述文 |

所以 `condition` 的类型是 `Maybe([]Condition)`，**"没声明"与"声明了空集"是两件事**：

```odin
condition: Maybe([]Condition)
// nil      —— 不参与自动选择，只能由实体挑（文件里该字段缺席）
// Some([]) —— 恒真，兜底模式
// Some(…)  —— 按条件自动选中
```

若让 nil 也当恒真，"全部候选交实体挑"就写不出来——第一个候选会永远命中，后面的全成
`Unreachable_Mode`。这是空集通则的唯一一处例外，而它恰恰不是例外：空**列表**照旧恒真，
nil 表示的是**缺席**。

**必须有出路**：条件全不成立且 `by` 为 `FLAG_NONE` 就是死局。载入期要求二者至少有一个——候选里有
一个 `Some([])` 的兜底模式，或者声明 `by`。缺一即 `No_Mode_Fallback`。

### 3.5 步骤能做什么：动作六支

步骤不持有过程指针，只按原子标签指名已登记的接口、模板、视图、实体。

```odin
Action :: union {
	Select_Mode,
	Read_View,
	Call_Interface,
	Ask_Entity,
	Render,
	Record_Fact,
}

Select_Mode :: struct {
	candidates: []Flag, // 候选模式，须是本流程 modes 的子集
	by:         Flag,   // 条件全不成立时由哪个实体来选；FLAG_NONE 表示只靠条件
}

Read_View :: struct {
	view: Flag,
	args: []Arg_Binding, // 视图的过滤参数，如按课题取事实
	into: Flag,          // 写入环境上下文的键
}

// 接口在数据里指名，实现在代码里；实参只取自已采信的意图与环境上下文。
Call_Interface :: struct {
	iface: Flag,
	args:  []Arg_Binding,
	into:  Flag, // 回执落进上下文的键；FLAG_NONE 表示不留存
}

Ask_Entity :: struct {
	entity: Flag,
	views:  []Flag,        // 本步额外准许可见的速查表
	tools:  []Flag,        // 本步额外授予的工具
	prompt: Flag,          // 已登记的提示模板
	args:   []Arg_Binding, // 填进提示模板的槽，成文期定死
	into:   Flag,          // 产物写进上下文的哪个键；FLAG_NONE 表示无产物
	emit:   Maybe(Event_Kind),
}

Render :: struct {
	template: Flag,
	args:     []Arg_Binding,
	emit:     Event_Kind, // 渲染的唯一目的就是给用户看，所以不是 Maybe
}

Record_Fact :: struct {
	topic:  Flag,
	from:   Arg_Source,  // 事实正文从哪来
	ref:    Flag,
	source: Fact_Source, // 可信度分级，见 4.3
}

Arg_Binding :: struct {
	key:  Flag,
	from: Arg_Source,
	ref:  Flag,
}

Arg_Source :: enum {Slot, Context, Literal, Step_Result, Utterance}
```

`Utterance` 这一支只把**用户原话**取出来当实参——出题模板与闲聊回话都要它，而它不是槽位、不在上下文
条目里（原话是会失真的内容，进行为记录而不进条目）。它**只能作实参，不能作条件主语**：进提示是翻译，
进条件是把控制流绑回词汇。

载入期校验每个绑定的来源可达，**按展开路径判定，不按段内序列判定**：`from = .Slot` 的键在 `fields`
内；`from = .Context` 的键在同一条展开路径上更早的某步写入过（`Read_View.into`、`Ask_Entity.into`、
`Call_Interface.into` 三者之一）；`from = .Step_Result` 的步骤在同一条展开路径上位于本步之前。
任一不成立即 `Bad_Binding`——**否则运行期才发现"要渲染的东西根本没人写过"**。

按展开路径判定是必须的：子段里的撰写步骤写进上下文的键，父段里更晚的步骤要读得到，而它并不在父段的
`sequence` 里。段不成环，所以展开路径条数有限，能穷举验证。

**实体从不指名要调哪个接口。** `Call_Interface` 的 `iface` 与实参来源都在成文期定死；实体能碰到的
只有本步授予的工具集，而那是程序给它的。提示注入最坏让本轮答错，碰不到未授予的接口。

**模板、视图与提示同样需要实参绑定。** 只给 `template: Flag` 是不够的：一条流程里多个撰写步骤各自
把产物落在不同键下，交付步骤若不声明"渲染哪一个"，就只能靠执行器猜——那正是"数据里只出现指名，
不出现过程指针"要避免的。`Read_View` 的 `args` 同理：没有它，"取本次工作相关的事实"表达不出来，
只能读全表。

`Ask_Entity.into` 与 `emit` 是两件独立的事，混为一谈会撞上唯一事实来源：

| | `into` | `emit` |
| --- | --- | --- |
| 管什么 | 产物**存哪**（后续步骤怎么读到它） | 产物**是否边生成边外送** |
| 落点 | 环境上下文（工作层） | SSE 事件流 |
| 不设的含义 | 该步无产物可留（如只提交工具调用） | 不外送（内部产物，如审查意见） |

**撰写类步骤必须声明 `into`。** 只 `emit` 不存，产物就只存在于外送过的字节里——审查读不到它，
优化也读不到，而环境上下文是唯一事实来源随即作废。所以撰写产物先入上下文，再由后续步骤按
`Arg_Binding{from = .Context}` 取用。载入期校验：能力为 `Write_Text` 的实体的 `Ask_Entity` 步骤
必须有 `into`，否则 `Missing_Sink`。

对撰写类步骤而言 `emit` 通常是 `.Content`，但这**不使它成为"面向用户的产出步骤"**：产出步骤要带
`Report` 标记，而撰写属于 `Work` 环节。**边写边给用户看初稿，与把定稿交付给用户，是两件事**——
前者是过程可见（状态展示：所有状态都要有地方展示），后者才是交付。

### 3.6 六环节的执行语义

环节是标记，但每个环节都有专属的执行语义或强制校验，不是六个空标签：

| 环节 | 执行语义 | 强制点 |
| --- | --- | --- |
| 预备 | 预测检查在此发生：定复杂度、第二层加载、`Read_View` 锚定官方与规范资料、`Record_Fact` 记下预测的结果与应对 | `Bad_First_Step`（顶层段首步必须是模式选择） |
| 工作 | 按既有要求与规划执行；撰写产物必须落 `into` | `Missing_Sink` |
| 审查 | 执行器把该步的 `Verdict` 落进 `Work.results`，键是步骤 id | `Bad_Review_Step`（该步必须是 `Ask_Entity` 且指名实体的能力为 `Review`） |
| 优化 | 调整结果，沿回跳边回到审查 | `Bad_Refine` |
| 报告 | 交付产物；可选地挂起等裁决 | `No_User_Output` |
| 收尾 | 三项证据齐备才执行；盘点留守条目 | `Bad_Teardown` + `No_Review` |

三处的界线容易混，逐条说明：

- **预测检查不是一个步骤**，它是流程开始时执行器的固定动作，所以它没有"至少有一步"这种校验可言。
  预备环节的可校验部分只有顶层段首步那一条。**"`Prepare` 环节至少有一步"说不出强制点，所以不写。**
- **`Verdict` 落进 `results` 是执行语义，不是数据声明**：审查步骤不需要（也不能）用 `into` 声明它，
  因为 `into` 写的是上下文，而步骤产出是另一个位置。载入期能校验的是"这一步真的是一次审查"——
  `Bad_Review_Step` 拦的就是"标了 `Review` 却在做别的事"。
- 预备环节的后半句——**预测之后的结果及应对措施**——落在 `Record_Fact`：预测出来的结果与应对不能只
  存在于某次实体调用的输出里，它要以事实的形态进上下文与运行期日志，后续步骤的 `require` 才读得到
  （`Subject.Fact`）。没有这条，预备环节就只剩一个 bit_set 标记。

`No_Review` 的必要性：`Completion_Evidence.review_passed` 在一条没有审查步骤的路径上恒为假，收尾
**永远执行不了**，而这种缺陷不在载入期拦下就只能到运行期显形——那正是静默降级。

### 3.7 审查回环

审查步骤的产物是有界判定；不通过就沿本段的回跳边回到指定步骤，次数受 `Jump.max_loops` 约束。

**回环的形状由此定死：审查在前，优化在后，优化沿回跳边回到审查。** 反过来（优化在前、由审查跳到它）
表达不出来，因为回跳边只能指向序列里**更早**的步骤。这不是限制，正是"优化环节通常会再接上审查环节"
的直译——而架构把
"通常"升级成了"必须"。

```odin
Verdict :: struct {
	passed:  bool,
	missing: []Flag,  // 未满足的要点，取自审查要点集合
	note:    string,  // 供优化步骤读取，字符串以免失真
}
```

**审查的产出是整个 `Verdict`，不是一个标签。** 只落一个"通过与否"，优化步骤就只知道"没通过"，
不知道差在哪——回环在数据上是断的。所以步骤产出的值类型是 `Value`，能装下结构：

```odin
// 步骤产出：键是步骤 id，值是该步的结论
results: map[Flag]Value  // 住在 Work 里，见 3.11
```

条件读它靠 `Subject.Step_Result`：`test = .Equals` 比 `Verdict.passed` 折算的程序区标签
（`Closed.Passed` / `Closed.Failed`），`test = .In_Set` 比 `missing` 是否含某个要点。
被读的步骤未执行时求值为不成立（与"该步没产出"一致）。

`Step_Result` 不是可选项：没有它，"仅当上一次审查未通过时才执行"这类条件就只能靠执行器写死——
那是把数据的职责挪回代码。

两条执行语义：

- **被跳过或被简化掉的步骤不触发它的回跳边。** 否则优化步骤因为门槛被跳过，却仍然把执行拉回审查，
  就成了空转。
- **回跳后目标步骤重过 `Gate`。** 这与 `Backstop.Always`（每次进入前都问一次）一致，也让"第二次
  审查可以因为门槛而简化"成为可能。但由此产生一个死角：若第二次审查被判 `Skip`，它就没有产出，
  优化步骤的 `Step_Result` 条件随之不成立，回环会静默断掉。所以载入期加一条：**回跳边的目标步骤，
  其 `Gate.require` 不得引用该回跳边起点的 `Step_Result`**（否则 `Bad_Jump`），并且执行期若回跳
  目标被 `Skip`，直接判定回环终止并发一条 `Degraded`——不静默。

### 3.8 用户裁决三支

报告环节把裁决交回用户。三支的语义各不相同，其中一支不在本流程内继续：

```odin
Report_Verdict :: enum {
	Finish, // 结束：允许进入收尾
	Rework, // 返工：沿本步 adjust_to 声明的回跳边回去
	Replan, // 重新规划：当前工作尚未做成，丢弃本流程的收尾，回到预备与用户盘点需求
}
```

`Replan` 不是流程内回跳。concepts.md 说报告环节"和用户会讨论产生下一步规划"——**需要下一步规划即
代表当前工作仍未进行**，要重新回到预备环节与用户盘点需求与规划，这几乎等同于丢弃当前流程的收尾
环节、开启新的流程。所以它的执行语义是：

1. 本次工作**不执行收尾**，工作层整层清理，`Work` 释放
2. 当前工作用过的临时轨道置 `Stale`——**保留，不删除**
3. 下一轮从飞行检查重新开始，用户的新要求走新一轮意图捕获

把 `Replan` 错当成流程内回跳会产生两个静默故障：优化步骤的 `require`（"仅当审查未通过"）在审查
已通过时不成立，于是回跳过去也什么都不做，白耗一轮；而末位报告点选它时，流程会推进到收尾步骤却
因为 `user_approved` 为假而不执行，**收尾静默没做**。两者都违反"没有静默降级"。

`Rework` 才是流程内回跳，而**它由 `adjust_to` 的有无决定，不需要另一个字段**：`adjust_to` 非空即表示
本报告点提供返工，出题时 `choices` 给三支；为空则只给结束与重新规划两支。载入期校验 `adjust_to` 非空
时它指向本段内更早的步骤，否则 `Bad_Adjust`。

这样安排是为了不让同一件事有两处声明——若既有 `choices` 又有 `adjust_to`，就会出现"给了返工按钮却没有
回跳目标"的组合，而那要靠第三条校验去拦。**能用字段的有无表达的，不再多设一个字段。**

三支都写进步骤产出（值是 `Closed.Finish` / `Closed.Rework` / `Closed.Replan`），所以"用户上次选了什么"是条件
读得到的数据。

### 3.9 收尾证据

收尾环节的步骤只在三项证据齐备时执行。三项都由程序检查，不问实体。

```odin
// 住在 Work 里，随工作层一起释放
Completion_Evidence :: struct {
	review_passed:   bool, // 最近一次审查通过
	steps_completed: bool, // 展开路径上所有未被跳过的步骤都已执行完
	user_approved:   bool, // 用户在报告环节明确选了 Finish
}
```

各自的置位时刻定死，不留解释空间：

| 证据 | 何时置真 | 何时置假 |
| --- | --- | --- |
| `review_passed` | 某个 `Review` 步骤产出 `Verdict.passed == true` | 又一次审查不通过；或沿回跳边回到审查之前 |
| `steps_completed` | 展开路径上所有**非收尾**且未被跳过的步骤都已执行完 | 发生回跳 |
| `user_approved` | 用户裁决为 `Finish` | 用户裁决为 `Rework` 或 `Replan` |

`steps_completed` 的判据是"**非收尾**步骤都完了"，不能是"段栈退到空"。收尾步骤本身位于某个段内，
求值时段栈必然非空；按段栈判，三项证据永不齐备，收尾步骤永远执行不了，而载入期查不出这种缺陷。

条件要引用它们时用 `Subject.Evidence`，`key` 取三者之一的程序区标签。否则收尾的判据就只能是执行器
写死的检查，而那与"条件必须能写成数据"相抵。

### 3.10 留守条目与吸收固化

收尾环节有一对必然步骤：**读出留守清单、再把它呈给用户**。它呈的是全部未处理的临时轨道，不只本次工作
产生的——concepts.md 的原话是"无论经历怎样的变动和重头再来"。分两步是因为清单住在运行期日志里，
实参绑定取不到它，得先由 `Read_View` 渲染进上下文（见 [8.4](#84-技能与流程)）。

```odin
Leftover_Review :: struct {
	groups: []Leftover_Group, // 按意图种类聚组
	shown:  u32,              // 本次呈现的条数，受 MAX_LEFTOVER_PER_TEARDOWN 约束
	held:   u32,              // 顺延到下次收尾的条数
}

Leftover_Group :: struct {
	kind:  Flag,     // 这一组共同指向的意图种类
	items: []u64,    // 临时轨道的 seq
	count: u32,      // 结构完全相同的条目已合并，这是合并后的计数
}

Absorb_Action :: enum {
	Establish, // 建立为独立轨道
	Merge,     // 合并到已有轨道
	Update,    // 更新已有轨道
	Decline,   // 拒绝
}
```

四条规则，都从"不替用户丢垃圾"推出来：

- **不设淘汰上限，只设盘点批量上限。** 一次收尾最多呈现 `MAX_LEFTOVER_PER_TEARDOWN` 条，其余顺延
  到下次收尾。条目本身永不被程序淘汰——`MAX_TEMP_TRACKS` 满时**拒绝新生成**而不是删旧的。
- **同一意图种类聚成一组呈现。** 用户可以一次决定整组，也可以展开逐条——这正是"能给控件就不给
  大段文字"。
- **结构完全相同的条目合并计数。** 步骤序列与条件集合一致的两条是同一样东西，合并后记次数；这是
  去重，不是丢弃。
- **拒绝也留记录。** `Declined` 的条目持久保留，否则重启后去重规则失效，同一条会反复呈上来。

吸收走的是普通载入与刷新路径：批准后写进注册表的 `Absorbed` 段，在**下一个工作边界**生效。
所以"吸收"与"生效"是两件事，中间隔着一次全量原子校验——校验不过就照旧上报，条目退回未处理状态。

### 3.11 执行状态

模式嵌套让执行位置不是一个下标，而是一条路径，所以执行状态用栈表示——挂起与续接靠的就是它。

**`Work` 就是环境上下文的工作层。** 它不是与上下文并列的第二份状态，而是那一层本身：既有通用条目，
也有执行位置这几个形状固定的字段。这样"唯一事实来源"不必要求所有状态挤成同一个数据形状，只要求
没有第二个副本、没有第二个所有者。

```odin
// lib/control/work.odin

Work :: struct {
	using layer: Layer,       // 工作层的通用条目与 arena，见 4.2

	registry: ^Registry,      // 本次工作绑定的版本，工作期间不换
	intent:   Intent,
	flow:     Flag,
	cplx:     Complexity,
	path:     [dynamic]Frame, // 段栈，挂起时原样保留
	results:  map[Flag]Value, // 步骤产出，键是步骤 id
	loops:    map[Jump_Id]u32,// 各回跳边已用轮数
	rounds:   map[Flag]u32,   // 各报告点已用往复次数，键是步骤 id
	evidence: Completion_Evidence,
	pending:  Pending,        // nil 表示没有挂起
	turns:    u32,            // 本次工作已跨的轮次，受 MAX_WORK_TURNS 约束
	prepared: Tag_Set,        // 第一层筛选的结果，供第二层算差集
}

Frame :: struct {
	mode:    Flag,     // 展开本段的模式；顶层段为 FLAG_NONE
	segment: ^Segment,
	index:   int,      // 本段内的当前下标
}

// 回跳边的身份是 (from, to) 而不是 from：同一个 from 可以有多条出边，
// 只用 from 作键会让两条边共用一个计数槽，轮数互相串扰。
Jump_Id :: struct { from, to: Flag }

Pending :: union {
	Clarify_Point, // 轨道执行中的出题
	Report_Point,  // 报告环节等待裁决
	Confirm_Point, // 不可逆接口等待用户批准
}

Clarify_Point :: struct {
	track:      Flag,          // 命中的正式轨道；临时轨道时为 FLAG_NONE
	temp:       u64,           // 临时轨道的 seq；正式轨道时为 0
	step_index: int,
	asked:      u32,
	prompt:     Prompt_To_User,
}

Report_Point :: struct {
	step:   Flag,          // 哪个报告步骤挂起的；往复次数在 Work.rounds 里，不存这里
	prompt: Prompt_To_User,
}

Confirm_Point :: struct {
	step:   Flag,
	iface:  Flag,          // 待批准的接口
	args:   []Arg,         // 已绑定好的实参，批准后由程序原样执行
	prompt: Prompt_To_User,
}
```

`rounds` 挂在 `Work` 而不是挂在 `Report_Point` 里：挂起点被消费后就重建，计数会归零，于是一条路径
上多个报告点的总往复次数无界。这也说明 `MAX_WORK_TURNS` 为什么不能省——单轮有界不等于一次工作有界。

段栈只有一份。`Flow_Context` 借用它而不复制——两处各存一份就要来回同步，挂起与续接正是最容易漏
同步的地方。`Work.path` 同时是给用户看的进度：每一层都是"哪个模式、走到第几步"，正好对应状态展示
要的分层。

```odin
Flow_Context :: struct {
	host:    ^Host,
	work:    ^Work,
	flow:    ^Flow,
	sink:    ^Event_Sink,
	scratch: mem.Allocator, // 每步结束即释放；跨步数据一律落 work.arena
	calls:   map[Flag]u32,  // 各实体本轮调用次数，轮次边界清零
}
```

## 四、支撑设施

前两章的每一步都要有东西可依。这一章逐个定义它们：前两章用到的规则，权威表述都在这里。

### 4.1 原子标签

一切概念的身份都是**原子标签**：一个 `u32`，不与词汇绑定，比较与查表都是整数操作。它是**用于
搜索、筛选、匹配的最佳基础**——身份唯一，语义确定。凡不会因此失真的地方一律用它，只有会失真的
内容才留字符串。

```odin
// lib/control/flag.odin

Flag :: distinct u32
FLAG_NONE :: Flag(0) // 零值即"无"，任何登记表都不会分配 0
```

**只有两层，不是三层。** 原子标签是身份，语义标签是展示名，没有第三样东西：

| 项 | 谁在用 | 可变性 |
| --- | --- | --- |
| 原子标签 | 程序内部的比较、查表、位运算；**数据文件里的每一处引用** | 运行期恒定，一个概念一个，编号永不复用 |
| 语义标签 | 展示给用户与 LLM 的名字 | 随时可改，改完到处生效 |

数据文件里写的就是 `u32`，不是名字。所以改语义标签不会打断任何引用——**"一次更新到处生效"是这个
结构的直接结果，不需要额外机制**。反过来，若数据文件引用名字，改名就会打断全部引用，那才需要再造
一个"稳定的名字"，而那个东西会变成第二身份，能与第一身份不一致，还给用户多一个不许撞的命名空间。
数据文件不是给人或 LLM 读的，可读性由工具链提供（见 [5.6](#56-工具链-bagtool)）。

解析只有一个方向：**语义标签 → 原子标签**，只在解析实体回答时用。

```odin
Label_Table :: struct {
	flags:    []Flag,           // 升序，指进映射，零拷贝
	lens:     []u8,             // 语义标签字节长度
	blob:     []u8,             // UTF-8 字节，按 flags 顺序紧密排列
	offsets:  []u32,            // 载入时一趟前缀和算出，不进文件
	by_label: map[string]Flag,  // 解析实体回答用；键是指进 blob 的切片，不复制
	present:  Tag_Set,          // 已登记编号的位图，合法性检查降到 O(1)
	next_id:  Flag,             // 下一个可分配编号，只增不减
}

resolve_label :: proc(t: ^Label_Table, label: string) -> (flag: Flag, ok: bool)
label_of      :: proc(t: ^Label_Table, flag: Flag) -> string // 二分，零分配
```

规则：

- **原子标签只能由用户拟定**（程序区除外，见下），通过交互界面增删标签、改语义标签。吸收进来的
  轨道不新造标签。
- 语义标签允许用词组消歧，但必须精简；**表内不允许重复的语义标签**，否则解析有歧义。这是程序侧的
  逻辑确定性要求，不与"语义标签不具身份唯一性"矛盾：后者说的是它不做身份，不是说它可以撞车。
- 解析失败即拒绝，**不做模糊匹配、不取最近似项**。
- 编号只增不复用：回收一个编号会让陈旧引用静默指向另一个语义。

**程序区：随代码发布的身份。** 程序定义的封闭集合与代码侧登记的能力都需要标签身份——它们是能力，
身份随代码发布。让用户先去界面上手造一遍才能用，是把开发流程摊给用户。

编号空间分两个**区**（不叫"段"——"段"是 `Segment` 的名字）：程序区与用户区。

```odin
// 编号由枚举顺序决定，只能追加不能插入——插入会改变后续成员的编号，
// 而运行期日志里已经存了这些编号。
Closed :: enum Flag {
	// 叙述清晰度四级：数值越大越清晰
	Vague = 1, Under_Severe, Under_Mild, Explicit,
	// 需求类型三值
	Chat, Discussion, Task,
	// 复杂度五级：数值越大越复杂
	Trivial, Simple, Normal, Complex, Heavy,
	// 门槛三结果
	Execute, Simplify, Skip,
	// 审查结论
	Passed, Failed,
	// 报告裁决三支
	Finish, Rework, Replan,
	// 吸收处置四支
	Establish, Merge, Update, Decline,
	// 收尾证据三项
	Ev_Review, Ev_Steps, Ev_Approved,
	// 封闭取值集的统一出口
	No_Match,
	// 严重级别三级
	Sv_Blocking, Sv_Degraded, Sv_Notice,
	// 问题主体八类
	Ac_Transport, Ac_Provider, Ac_Entity, Ac_Interface, Ac_Step, Ac_Track, Ac_Registry, Ac_Input,
	// 问题种类十类
	Pk_Unreachable, Pk_Rejected, Pk_Malformed, Pk_Out_Of_Budget, Pk_Not_Covered,
	Pk_Unresolvable, Pk_Overreach, Pk_Retries_Spent, Pk_Not_Registered, Pk_Capacity,
	// 问题原因十类
	Cs_Network, Cs_Auth, Cs_Timeout, Cs_Client_Gone, Cs_Bad_Argument, Cs_Missing_Label,
	Cs_Condition_Unmet, Cs_Limit_Reached, Cs_Data_Invalid, Cs_User_Declined,
	// 问题卡片的定位字段名
	Field_File, Field_Path, Field_Detail, Field_Skill, Field_Flow,
	Field_Mode, Field_Step, Field_Track, Field_Entity, Field_Interface, Field_Version,
}

// 登记物身份：视图、模板、接口（含全部工具）、实体、计量键。同样随代码发布。
Registered :: enum Flag {
	View_Runtime = 256, View_Intents, View_Track_Guide, View_Labels, View_Facts, View_Leftovers,
	Tmpl_Status_Reply, Tmpl_Capability_Reply, Tmpl_Chat_Reply,
	Tmpl_Slot_Question, Tmpl_Report_Question, Tmpl_Leftover_Question,
	Tmpl_Foresee, Tmpl_Generic_Draft, Tmpl_Expository, Tmpl_Narrative,
	Tmpl_Review, Tmpl_Rewrite, Tmpl_Delivery,
	// 工具就是接口，所以每个工具都有一个登记物身份
	Iface_Submit_Triage, Iface_Submit_Intent, Iface_Submit_Text, Iface_Submit_Verdict,
	Iface_Submit_Gate, Iface_Submit_Mode, Iface_Submit_Reasoning,
	Iface_Begin_Track, Iface_Add_Track_Step, Iface_Submit_Track, Iface_Propose_Label,
	Iface_Release,
	Ent_Catcher, Ent_Writer, Ent_Reviewer, Ent_Reasoner,
	Metric_Listen, Metric_Uptime, Metric_Requests, Metric_Model,
}

FLAG_RESERVED_MAX :: Flag(max(Registered)) // max() 返回 Registered，须转成 Flag
```

两个区都在**同一张表**里。分区是编号范围上的事，由程序判定
（`is_reserved(f) := f <= FLAG_RESERVED_MAX`），不由文件分开存放——复杂的分类逻辑应该由程序实现，
而不是文件代劳。这样"用户区占用了程序区编号"这个冲突根本构造不出来，一整类校验从"要检查"变成
"无法表达"。

**程序区里的封闭集合与 Odin 枚举是一份东西的两个形态。** `Complexity`、`Clarity`、`Severity`、
`Problem_Kind` 这些在代码里仍是普通枚举（穷举 switch 要它，序关系也只有代码知道），同时在标签表里
有一个对应的程序区标签，供谓词操作数、工具取值集与展示使用。两者靠命名一一对应，转换是查表。
**这条不能省**：`Problem.what` 若只是一个 Odin 枚举，问题卡片的类型名就没有语义标签，改不了名，
也进不了工具取值集——而 concepts.md 要求"所有数据类型都采用原子标签来表述结构、类型和内容"。

**有序枚举的序必须与谓词语义一致。** `At_Least` 读作"不低于"，所以数值大的那一端必须是"更多"的
那一端：复杂度越大越复杂，**清晰度越大越清晰**。所以 `Clarity` 的成员顺序是
`Vague → Under_Severe → Under_Mild → Explicit`。L0–L3 那套编号是展示层的叫法，序正好相反；
按它排枚举会让"清晰度不低于轻度欠定"算出 {轻度欠定, 重度欠定, 模糊}。

程序区的**语义标签允许用户改**：文件是标签的唯一事实来源，代码里的内建默认只用于补缺行。
载入时的对齐规则见 [5.3](#53-labelsfglb原子表)。

**匹配的原语是位图，不是字符串比较。** 每条可筛选的数据带一组标签，筛选就是集合运算：

```odin
// lib/flag/bitmap.odin —— 稀疏分块位图：高 16 位寻址块，低 16 位密位运算。
// 稀疏时用升序 u16 数组，超过 4096 条升级成 8 KB 稠密位集。
Tag_Set :: struct { chunks: map[u16]Chunk }

tag_insert    :: proc(s: ^Tag_Set, f: Flag)
tag_contains  :: proc(s: ^Tag_Set, f: Flag) -> bool // O(1)
tag_union     :: proc(dst: ^Tag_Set, src: ^Tag_Set)
tag_intersect :: proc(dst: ^Tag_Set, src: ^Tag_Set)
tag_subtract  :: proc(dst: ^Tag_Set, src: ^Tag_Set)
```

于是"要求的标签全满足"是 `require &~ have == ∅`，"命中任意一个"是 `have & any != ∅`，都是常数级，
有界性由集合大小直接给出。第一层与第二层预加载的三个差集就是这三个运算。

**备用通道：请求增改标签。** 标签表总有表达不了的东西。活动代理可以向用户**发起**增改标签的请求
——用户可以在请求基础上自行修改，也可以直接接受或拒绝。发起权在代理，拟定权仍然只在用户。

```odin
Label_Request :: struct {
	seq:       u64,              // 运行期日志里的序号，去重与回执都用它
	proposals: []Label_Proposal,
	reason:    string,           // 为什么现有标签表达不了，字符串以免失真
	origin:    Flag,             // 触发它的轨道或流程步骤
	state:     Request_State,
	at:        time.Time,
}

Label_Proposal :: struct {
	action:  Proposal_Action,
	target:  Flag,   // .Update 时的目标；.Add 时为 FLAG_NONE
	label:   string, // 建议的语义标签
	purpose: string, // 用途说明，供用户判断
}

Proposal_Action :: enum {Add, Update}
Request_State :: enum {Pending, Accepted, Edited, Declined}
```

请求的**发起手段**是 `reasoner` 的 `propose_label` 工具——没有发起手段的备用通道等于不存在。
五条限制是程序强制的，不是叮嘱：只有生成临时轨道时能发起（那时"确实表达不了"有客观证据）；
`.Update` 的 `target` 落在程序区即整条丢弃（改它要改代码）；与任何 `Pending` 或 `Declined` 请求
提案集合等价的新请求直接丢弃；越过 `MAX_LABEL_REQUESTS_PER_DAY` 即丢弃并上报；不阻塞本轮，
也不自动生效——用户在界面上接受或改写后，走的仍是普通的载入与刷新路径。

### 4.2 环境上下文

环境上下文是活动代理的唯一事实来源，也是储存状态与数据的唯一载体。它**相当于一个实例对它能接触到
的一切所产生的认知**：系统提示词、临时记忆、结构化消息、目录快照、文件快照、日期时间、已落定槽位、
运行期计量、统计，全部在这里，分层分类。**状态记录就是环境上下文**，不另设一份。

**里面的一切都是副本。** 标准、技能、文件快照的**本体**在本地永久储存里；上下文持有的是这一次
用得上的那一份拷贝。这条让"唯一事实来源"与"记忆要持久"不必打架：唯一事实来源管的是**认知**，
持久化管的是**本体**，两者归属不同、生命周期不同。

分层的依据是存活期，**每一层由生命周期与它相同的那个东西持有**，因此清理是按层整体进行的：

```odin
// lib/control/context.odin

Context_Layer :: enum {
	Standing, // 常驻：活动代理自身的身份、配置、计量、统计
	Session,  // 会话级：跨轮次存活
	Work,     // 工作级：一次工作（可能跨多轮）内存活
	Step,     // 步骤级：一步结束即清
}

Layer :: struct {
	entries: [dynamic]Entry,
	arena:   virtual.Arena,
}

// 上下文是按层组装的视图，不是一个大容器——否则多会话就会共用同一个会话层。
Context :: struct {
	standing: ^Layer, // 活动代理持有
	session:  ^Layer, // 当前会话持有
	work:     ^Layer, // 当前工作持有（就是 Work 的嵌入层）；无工作时 nil
	step:     ^Layer, // 当前步骤
}

Entry_Class :: enum {
	Standard_Text,  // 标准正文副本（组装系统提示词用）
	Skill_Guide,    // 技能指南副本
	View_Text,      // Read_View 渲染出来的视图正文，供后续步骤读
	Memo,           // 临时记忆：Ask_Entity 的 into 落在会话层时即此类
	Message,        // 结构化消息
	Dir_Snapshot,   // 目录结构快照
	File_Snapshot,  // 文件内容快照
	Fact_Snapshot,  // 事实副本
	Moment,         // 日期时间：执行器在每步开始时写进步骤层
	Slot,           // 已落定的槽位
	Draft,          // 撰写产物
	Receipt_Data,   // 接口回执
	Metric,         // 运行期计量
	Stat,           // 统计（派生量）
}

Entry :: struct {
	key:        Flag,
	class:      Entry_Class,
	value:      Value,
	importance: Importance, // 由 class 查表得到，不由判断得到
	at:         time.Time,
}

Importance :: enum {Critical, Normal, Detail}

// 唯一的读写接口。程序其他部分与实体都只能走这里。
// 读取按 Step → Work → Session → Standing 取首个命中——短命的层遮住长命的层，
// 于是"本步临时覆盖某个值"不需要写回去改，一步结束整层清掉即自动恢复。
ctx_get  :: proc(c: ^Context, key: Flag) -> (Value, bool)
ctx_put  :: proc(c: ^Context, layer: Context_Layer, e: Entry)
ctx_drop :: proc(c: ^Context, layer: Context_Layer) // 整层清理
```

`Entry_Class` 到 `Importance` 的映射是查表，不是判断——**表在这里，只有这一份**：

| 条目类 | 重要级别 | 条目类 | 重要级别 |
| --- | --- | --- | --- |
| `Slot` | `Critical` | `Fact_Snapshot` | `Normal` |
| `Draft` | `Critical` | `Receipt_Data` | `Normal` |
| `Standard_Text` | `Critical` | `Memo` | `Normal` |
| `Message` | `Critical` | `View_Text` | `Normal` |
| `Skill_Guide` | `Normal` | `Dir_Snapshot` | `Detail` |
| `Metric` | `Detail` | `File_Snapshot` | `Detail` |
| `Stat` | `Detail` | `Moment` | `Detail` |

**`importance` 的读者是 `compose_prompt`**：往提示里放上下文条目时，`CONTEXT_BUDGET_BYTES` 不够就按
这一列从 `Detail` 起停止放入，并留一条"省略了哪些类"的痕迹。它不是给"上下文裁剪"用的——上下文没有
裁剪，只有整层清理（见 [4.6](#46-行为记录) 的说明：被裁剪的是行为记录）。**没有读者的字段等于不存在，
所以这里必须点明读者。**

**`Value` 是跨模块的唯一数据载体。** 上下文条目、工具实参、步骤产出、谓词操作数、问题卡片字段都在
传同一种东西；各自定义一遍就会各自漂移。

```odin
// lib/control/value.odin

Value :: union {
	Flag,       // 原子标签：绝大多数情况
	string,     // 会失真的内容：原话、撰写产物、指南与标准正文、审查备注
	i64,
	bool,
	time.Time,
	Tag_Set,    // 标签集合：预加载的筛选结果、审查未满足要点
	Verdict,    // 审查结论：让优化步骤读得到"差在哪"，而不只是"没通过"
	Receipt,    // 接口回执
}

Arg :: struct {
	key:   Flag,
	value: Value,
}
```

谓词在每种成员上的语义一处定死，不支持的组合在载入期即 `Bad_Condition`：

| `Test` | `Flag` | `string` | `i64` | `bool` | `time.Time` | `Tag_Set` | `Verdict` | `Receipt` |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `Exists` | 非 `FLAG_NONE` | 非空 | 非 0 | 恒真 | 非零时刻 | 非空 | 恒真 | 恒真 |
| `Equals` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | 折算成 `Passed`/`Failed` 比 | ✗ |
| `In_Set` | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | 比 `missing` | ✗ |
| `At_Least` / `At_Most` | 仅复杂度与清晰度 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

`Equals` 只对 `Flag` 成立，因为 `Condition.operands` 只有 `[]Flag`——**谓词没有整数或布尔操作数**，
要比数值就先把它译成一个封闭取值集的标签。这条限制是有意的：一旦允许整数比较，条件就会开始表达算术，
而封闭谓词的可校验性正来自"操作数是有限集合里的成员"。

`bool` 上的 `Exists` 恒真也是这个道理：`bool` 的"无"无法与 `false` 区分，所以判缺席要用 `Maybe`
或另设一个标签。

**速查表是现取现渲染的视图，不是另一份事实。** 缓存副本会让"官方事实"与真实状态脱节。

```odin
// 视图拿到的是整个 Host——"意图清单"要读技能与流程注册表，只给 ^Context 渲染不出来。
View_Render :: proc(h: ^Host, args: []Arg, out: ^strings.Builder)
register_view :: proc(id: Flag, render: View_Render)
ctx_view      :: proc(h: ^Host, view: Flag, args: []Arg, out: ^strings.Builder)
```

视图直接读 `h.registry` 与运行期日志**不违反唯一事实来源**：注册表是蓝本，日志里是本体，视图做的是
"现在把本体渲染一遍给人看"，不是"另存一份状态"。不变量管的是**状态不许有第二个副本**，而现取现渲染
恰恰是不留副本的做法。

**运行期计量与统计也走上下文。** 监听地址、运行时长、已处理请求数不能是全局量，必须以 `Metric` 条目
写进常驻层，视图才读得到；否则"运行状态"这份视图就绕过了唯一事实来源。传输层负责写入，视图只负责读。

**统计是派生量，不落盘。** 命中数、完成数、失败数在启动时由运行期日志折叠得出，运行期在常驻层以
`Stat` 条目累加；日志压实时写一条基线记录保住历史。派生量不该有自己的持久副本——这也是不变量的一条
推论。统计只用于状态展示，**不驱动任何控制流**。

**视图怎么进提示，一处定死。** 本步可见的视图集合 = `Entity.views`（长期）∪ 本次技能的 `Skill.views`
（附赠的速查表）∪ `Ask_Entity.views`（本步额外准许），三者取并集后去重。`ctx_view` 的输出按这个顺序
拼接（长期 → 技能 → 本步），放在系统提示的**标准之后、本步指令之前**；总长受 `CONTEXT_BUDGET_BYTES`
约束，越限时按**逆序**裁剪（后加入的先裁），并留一条"省略了哪些视图"的痕迹。不写清注入点与并集来源，
`Entity.views` 与 `Skill.views` 就是两个没有读者的字段。

### 4.3 记忆

记忆分三层，各处理一类经验，全部是数据。**记忆的本体在本地永久储存，进入上下文的是副本。**

```odin
// lib/control/memory.odin

// 技能：做一件事的规范流程 + 指南 + 索引 + 速查表。
// id 既是技能身份，也是它指向的课题——"一个技能只指向一个课题"由此结构保证，
// 不需要额外校验"两个技能指向同一课题"。
Skill :: struct {
	id:        Flag,
	guide:     string,   // 指南正文，字符串以免失真
	standards: []Flag,   // 导向相关标准的索引
	views:     []Flag,   // 附赠的速查表
	flows:     []Flow,   // 该课题下的多种流程，按工作类别分
	tags:      Tag_Set,  // 供预加载筛选
}

// 事实：发现的客观事实，协助实体澄清事实。
Fact :: struct {
	seq:       u64,        // 运行期日志里的序号
	topic:     Flag,
	statement: string,     // 事实正文，字符串以免失真
	source:    Fact_Source,
	at:        time.Time,
}

Fact_Source :: enum {
	User_Stated,      // 用户说的               ← 用户作答
	View_Read,        // 从速查表读到的         ← Read_View
	Interface_Result, // 接口返回的             ← Call_Interface 回执
	Entity_Concluded, // 实体推断的，可信度最低 ← 预备环节的预测、临时轨道的结论
}

// 标准：约束实体行为的提示词。系统提示词由这些组合而成。
Standard :: struct {
	id:   Flag,
	kind: Standard_Kind,
	text: string,
	tags: Tag_Set,
}

Standard_Kind :: enum {System, Identity, Duty, Domain}
```

**事实有写入通道。** `Fact_Source` 的四个值各对应一个写入时机，四个时机都由 `Record_Fact` 动作在
数据里声明——没有写入者的事实表是一个只读的空转层，`Subject.Fact` 的条件会恒为假。写入同时落两处：
运行期日志（本体，持久）与上下文的 `Fact_Snapshot` 条目（副本，随层清）。容量受 `MAX_FACTS` 约束，
满则淘汰最旧的非 `User_Stated` 条目并留痕——用户说过的话不因容量而丢。

技能的三要件各有读点，不是摆设：`guide` 由 `compose_prompt` 作为技能级说明拼进提示；`standards` 参与
提示组合；`views` 决定本次工作里哪些速查表可授予。没有读点的字段等于不存在，所以这三条要写明。

**系统提示词不写死，靠组合。** 以最小文本量精准定位行为与权力边界，是靠组合实现的，不是靠写长。

```odin
compose_prompt :: proc(h: ^Host, e: ^Entity, skill: Flag, extra: []Flag, out: ^strings.Builder)
```

组合顺序固定，可复现：`System` → `Identity` → `Duty` → `Domain` → 技能 `guide` → 上下文指定的追加
标准（`extra`）。同类内按标准 id 升序。三份来源（`Entity.standards`、`Skill.standards`、`extra`）
去重后按此顺序排——**顺序不定死，同一组标准就会拼出不同提示，提示调优无从复现**。

### 4.4 LLM 实体与工具调用

每个实体是一个专门处理特定功能的函数：一份职责、一组上下文片段、一套工具集。跟用户对话的、做总结
的，同样是实体，没有例外。

**结构化产物走工具调用，不走格式化输出。** 参数名与取值集由程序在工具模式里定死，实体只能填值；
格式化输出连键都要靠解析。这条决定了未采信数据的范围：**只剩"值"，"键"这一层已经由程序掌握。**

**实体与工具的关系，就是用户与图形界面的关系。** 所以工具按界面来设计，不按 API 来设计：

| 界面准则 | 工具设计上的落点 |
| --- | --- |
| 当前屏只放当前要用的控件 | 工具集按步骤授予，不摊开全量工具表 |
| 下拉优于自由输入 | 参数优先 `Flag_Value` + 封闭取值集，`Text` 只用于会失真的内容 |
| 控件有合理默认值 | 非必填参数声明默认值，实体不必填满 |
| 条件不满足的控件不出现 | 前置条件不成立的工具不进本步工具模式——不是"调了再拒"，是压根看不见 |
| 操作要有即时反馈 | 每次工具调用都回一份回执 |
| 校验错误要能就地改正 | 实参不合法回一份校验回执（哪个参数、错在哪），在预算内允许改正重提 |
| 不可逆操作要二次确认 | 接口声明 `confirm`，转成用户裁决点，不给实体按 |
| 提交与查询是两类按钮 | 工具分终结型与查询型 |

```odin
// lib/control/entity.odin

Capability :: enum {
	Capture_Intent, // 意图捕获
	Translate,      // 转译处理
	Write_Text,     // 撰写文本
	Review,         // 视察审核
	Reason,         // 逻辑推理
}

Entity :: struct {
	id:         Flag,
	capability: Capability, // 五条职责之一，唯一授权
	standards:  []Flag,     // 组成它系统提示词的标准
	tools:      []Flag,     // 长期授予的工具集
	views:      []Flag,     // 长期可见的速查表
	writes:     bool,       // 是否准许产出自由文本
}
```

`Translate` 有能力位但 MVP 无实体持有它，这是**有意的取舍而非遗漏**：语义标签到原子标签是查表，
程序结果到文字多数情况是模板。行为哲学要落实到"能用程序解决的，绝不用 LLM"——下载进度条那种输出
本身已高度可读，硬走一次 LLM 只会破坏实时性。但这不否认 LLM 负责自然语言渲染：**需要组织成自然
语言的产出仍然交实体**（回话、报告、问句），那些走 `Write_Text`。判据是"这份数据是否已经具备可读性"，
不是"要不要好看"。

工具即接口：声明在数据里，实现在代码里。

```odin
// lib/control/interface.odin

Interface :: struct {
	id:      Flag,
	kind:    Tool_Kind,
	confirm: bool,         // 不可逆操作：执行前必须经过用户裁决点
	params:  []Param_Spec, // 既用于生成工具模式，也用于校验实参
	require: []Condition,  // 前置条件不成立时，本工具不进工具模式；空集恒真
	direct:  bool,         // 真表示允许程序直调（Call_Interface），假表示只作实体工具
}

Tool_Kind :: enum {
	Submit, // 终结型：调用后本次实体调用结束
	Query,  // 查询型：回执后实体继续
}

Param_Spec :: struct {
	key:      Flag,
	required: bool,
	kind:     Param_Kind,
	options:  []Flag,       // kind = .Flag_Value 时的封闭取值集
	dynamic:  Flag,         // 非 FLAG_NONE 表示取值集在运行期算出，值是算法的登记 id
	default:  Value,
}

Param_Kind :: enum {Flag_Value, Text, Int}

Options_Of :: proc(h: ^Host, w: ^Work) -> []Flag // 运行期取值集的钩子
register_options :: proc(id: Flag, f: Options_Of)
```

`options` 与 `dynamic` 二者必居其一且不可兼有：**取值集要么登记期就定死，要么由一个登记过的算法在
运行期算出**，不存在"空集表示任意"这种隐含语义。`submit_mode` 的候选与 `submit_verdict` 的要点集合
都走 `dynamic`——它们依赖当前这一步的数据，登记期算不出来。空 `options` 且无 `dynamic` 在载入期即
`Bad_Options`。

`Field_Spec` 那一侧用显式的 `free: bool` 表达自由文本，也不靠空集（见 [3.1](#31-工作的完整路径) 的
结构定义）。**同名字段的空集不许有两种含义**——`options` 在接口参数与槽位声明里都出现，读错一处就会
让自由文本槽位变成"任意标签"。

```odin
Invoke :: #type proc(h: ^Host, args: []Arg) -> (Receipt, Interface_Error)

// 回执就是界面上的反馈：实体看得见自己那一下按出了什么效果。
Receipt :: struct {
	ok:      bool,
	summary: Flag,     // 结果种类，已登记的标签
	fields:  []Arg,    // 结果要点
	problem: ^Problem, // 失败时非 nil，与上报给用户的是同一份
}

Interface_Error :: enum {
	None,
	Rejected,    // 实参不满足接口自身的前置条件
	Unavailable, // 依赖不可用
}

register_interface :: proc(spec: Interface, invoke: Invoke)
```

`direct` 区分接口的两种身份：作为实体工具时 `kind`/`confirm` 都有意义；被 `Call_Interface` 程序直调时
`kind` 无意义（没有"结束本次调用"可言），`confirm` **仍然生效**（转成确认挂起），`require` 仍然求值
（不成立即该步 `Skip`）。载入期校验 `Call_Interface` 指名的接口 `direct` 为真，否则 `Bad_Direct`。

一次实体调用是一段有界的交互，不是一次问答：程序开一屏工具，实体按、看回执、再按，直到按下终结型
工具或预算用尽。

```odin
Entity_Call :: struct {
	entity: Flag,
	prompt: string,            // 由程序按环境上下文组装
	tools:  []Flag,            // 本屏工具：长期工具 + 本步追加 − 前置条件不成立的 − confirm 的
	emit:   Maybe(Event_Kind),
}

Entity_Result :: struct {
	calls:  []Tool_Call, // 已校验并已执行的工具调用，按发起顺序
	closed: Flag,        // 结束本次调用的终结型工具；FLAG_NONE 表示预算用尽
	text:   string,      // 仅当实体 writes 为真时非空
}

Tool_Call :: struct {
	tool:    Flag,
	args:    []Arg,
	receipt: Receipt,
}

// 调用实体的唯一手段。生产实现在 entity_bridge.odin，测试实现返回固定产物。
Entity_Caller :: #type proc(call: Entity_Call, sink: ^Event_Sink) -> (Entity_Result, Entity_Error)

Entity_Error :: enum {
	None,
	Unavailable,   // 传输、鉴权、超时
	Unknown_Tool,  // 调了未在本屏工具集里的工具
	Retries_Spent, // 校验回执给了，改正次数仍然用尽
	No_Submit,     // 预算用尽仍未按下终结型工具
	Cancelled,     // 墙钟越限或客户端已断开
}
```

**每个实体都必须有至少一个终结型工具**，撰写类也不例外。一次调用要"按下终结型工具或预算用尽"才结束，
所以工具屏是空的实体永远走 `No_Submit`。撰写类实体登记 `submit_text`：它与 `emit = .Content` 的流式
外送并存——流式是给用户看的过程，`submit_text` 是给程序的"我写完了"信号，同时把定稿作为实参交上来，
好落进 `into`。载入期校验：每个实体的长期工具集里至少有一个 `kind = .Submit` 的工具，否则
`No_Submit_Tool`。

实参校验按"默认拒绝"执行，但**不合法不等于整次失败**——像界面上的表单校验一样，回一份回执让它就地
改正：

- 工具必须在本屏工具集内。集外工具压根不出现在工具模式里，出现即 `Unknown_Tool`，**整次失败**
  ——那不是填错，那是越权。
- 必填参数齐全，类型与 `Param_Spec` 一致；非必填缺失时取 `default`。
- `Flag_Value` 参数的语义标签必须解析成功，且落在 `options`（或 `dynamic` 算出的取值集）内。
- `Text` 参数受 `MAX_TEXT_ARG_BYTES` 限制。
- 以上任一不过，回一份校验回执（哪个参数、错在哪、允许的取值），计一次改正；改正次数超过
  `MAX_TOOL_RETRIES` 即 `Retries_Spent`。
- 每次校验失败同时上报一条 `Notice`——用户有权知道实体在这一步卡过。

**封闭取值集必须有出口。** 没有出口的封闭集合会逼实体说谎：面对一屏只有四项的下拉框，用户问的却是
第五件事，它只能挑一个最像的——于是"未命中"这条路永远走不到。所以凡是封闭取值集，都带一项
`Closed.No_Match`：

- 飞行检查的两个参数：清晰度与需求类型都是全覆盖的分级，**没有"第五种情况"**，不加出口
- `submit_mode` 的候选：由兜底模式或 `by` 承担出口角色，不需要额外一项
- 门槛保底、报告裁决、吸收处置：三到四项本身就是全集，不加出口
- **意图种类**（若某个工具需要实体在意图清单里选）：必须带 `No_Match`，选中即进临时轨道生成

**给出口不等于放宽采信。** `No_Match` 是封闭集合里的一项、语义由程序定义、后续路径由程序决定。
实体表达的是"我认不出"，不是"我要做点别的"。

实体之间的隔离是可执行的，不是口号：一个实体只看见自己的标准、自己被授予的工具与速查表、以及本步
写进提示的内容。**别的实体的内部产物不会自动进入它的上下文**——要传就得经由 `into` 落进上下文，
再由下游步骤用 `Arg_Binding` 显式取。

**实体不派发实体。** `Entity_Caller` 只能由控制层的轨道执行器与流程执行器调用；接口实现、模板、
视图一律不得调用它。否则一个注册进来的接口实现就能在内部派发另一个实体并同步等待，恰好造出
concepts.md 要避免的"主 Agent 反复等待子 Agent"。这条列在 [7.1](#71-不变量) 的不变量表里，
测试用注入的 `Entity_Caller` 记录调用栈深度，断言恒为 1。

### 4.5 条件：封闭谓词

条件必须能写成数据，所以不是过程指针，而是封闭谓词。谓词是**全的**：无循环、无递归、无回溯，一次
求值是有界的整数比较或有界集合运算。条件集合是扁平 AND；需要 OR 就多登记一条。

```odin
// lib/control/condition.odin

Condition :: struct {
	subject:  Subject,
	key:      Flag,   // subject 需要键时用，其余为 FLAG_NONE
	test:     Test,
	operands: []Flag, // 标签操作数，条数受 MAX_OPERANDS 约束
	negate:   bool,
}

Subject :: enum {
	Clarity,     // 飞行检查得出的叙述清晰度
	Demand,      // 飞行检查得出的需求类型
	Intent_Kind, // 已采信的意图种类
	Slot,        // 已落定的槽位值，key 是槽位键
	Complexity,  // 预测检查得出的复杂度
	Mode,        // 本段栈上任一层已选中的模式
	Fact,        // 事实表内是否有该课题的事实，key 是课题
	Step_Result, // 某个已执行步骤的产出，key 是步骤 id
	Evidence,    // 收尾证据三项之一，key 是三者的程序区标签
}

Test :: enum {
	Exists,   // 有值且非零，语义见 4.2 的对照表
	Equals,   // 等于 operands[0]
	In_Set,   // 属于 operands
	At_Least, // 仅 Complexity / Clarity：不低于 operands[0] 的等级
	At_Most,  // 仅 Complexity / Clarity
}
```

**没有 `Utterance`，也没有 `Contains_Any`。** 让控制流直接依赖词汇会带来三个后果：英文输入不命中、
"不要重构"因子串匹配而反向命中、不命中是静默的。而它同时与"不做模糊匹配、不取最近似项"自相矛盾。
要按措辞分支，正确做法是让飞行检查或解析步骤把措辞译成一个原子标签——这样未命中还能走 `No_Match`
进临时轨道，而子串不命中什么也不会发生。

载入期校验 `subject` / `test` / 操作数的组合合法，非法组合即拒绝整批（`Bad_Condition`）：

| 位置 | 允许的主语 | 理由 |
| --- | --- | --- |
| `Track.conditions` | `Clarity`、`Demand`、`Fact` | 选轨时槽位未落定、复杂度未算出、模式不存在 |
| `Track_Step.condition` | 上述 + `Slot` | 解析中槽位陆续落定 |
| `Gate.require` | 全部九种 | 流程执行期一切都在手 |
| `Mode.condition` | 全部九种 | 同上 |
| `Interface.require` | 全部九种 | 同上 |

**空集语义一处定死，不逐处再解释。** 同一个 `[]Condition` 形状在五个位置出现：

| 位置 | 空集含义 | 理由 |
| --- | --- | --- |
| `Gate.require` | 恒真 | 没有前置条件就是随时可执行 |
| `Track_Step.condition` | 恒真 | 同上 |
| `Interface.require` | 恒真 | 同上 |
| `Track.conditions` | **拒绝** | 无条件命中的轨道会吃掉一切输入，载入期即 `No_Conditions` |
| `Mode.condition` | 恒真（兜底）；**缺席另有含义** | 见 [3.4](#34-流程模式与段) |

复杂度与清晰度都是有序的，所以等级由程序定义，不开放给数据；它们同时以程序区标签的形式存在，供谓词
操作数与提示展示，**顺序关系只有程序知道**。

### 4.6 行为记录

不用"对话与事件"结构。会话由**行为记录**和**状态记录**构成；状态记录就是环境上下文，不另存一份。
行为记录只记三件事：用户问了什么、LLM 答了什么、Agent 做了什么。

```odin
// lib/control/act.odin

Act_Log :: struct {
	acts:     [dynamic]Act,
	problems: [dynamic]Problem, // 卡片本体存这里，Act 只存下标
	arena:    virtual.Arena,    // 会话级
}

Act :: struct {
	actor:      Actor,
	kind:       Act_Kind,
	importance: Importance, // 由 kind 查表得到，不由判断得到
	at:         time.Time,
	ref:        [2]Flag,    // 主体与副体，如"哪个流程的哪个模式"
	payload:    Value,      // 装不进两个 Flag 的东西：回执、问题下标、判定
	text:       string,     // 只在会失真时非空
}

Actor :: enum {User, Llm, Agent} // Importance 定义在 4.2，它先被上下文条目用到
```

`ref` 是两个标签而不是一个：`Agent_Selected` 要记"哪个流程的哪个模式"，一个装不下。装不进标签的
（接口回执、问题卡片、审查判定）走 `payload`。这样"同一份内容三处落地"才做得到——卡片本体在
`Act_Log.problems` 里，`Act.payload` 存它的下标，外送与日志共用同一份，不会出现"界面上说没事、
日志里全是错"。

`Actor` 三值对应 concepts.md 的三个主语，与问题卡片的 `Actor_Kind` 是两个不同粒度的东西，映射如下
（一处定死，避免两个枚举各自漂移）：

| `Actor_Kind` | 归入 `Actor` |
| --- | --- |
| `User_Input` | `User` |
| `Entity`、`Provider` | `Llm` |
| `Transport`、`Interface`、`Flow_Step`、`Track`、`Registry` | `Agent` |

```odin
Act_Kind :: enum {
	User_Said,         // 用户原话
	User_Chose,        // 用户在结构化选项里的选择
	Llm_Answered,      // 外送给用户的产出
	Llm_Triaged,       // 飞行检查的清晰度与需求类型结论
	Llm_Judged,        // 审查判定（内部）
	Llm_Drafted_Track, // 生成了一条临时轨道
	Agent_Selected,    // 选中轨道 / 流程 / 模式
	Agent_Predicted,   // 预测检查的复杂度结论
	Agent_Preloaded,   // 两层预加载的三个集合结果
	Agent_Gated,       // 某步被简化或跳过及其原因
	Agent_Resolved,    // 落定槽位
	Agent_Read_View,   // 读速查表
	Agent_Called,      // 调接口及其回执
	Agent_Recorded,    // 记下一条事实
	Agent_Looped,      // 沿回跳边回到更早的步骤
	Agent_Problem,     // 上报的问题卡片
	Agent_Asked_Label, // 发起了增改标签的请求
	Agent_Absorbed,    // 用户处置了留守条目
	Agent_Terminated,  // 终止应答及原因
}
```

`Act_Kind` 到 `Importance` 的映射表——**只有这一份**，裁剪算法完全依赖它：

| 重要级别 | 种类 |
| --- | --- |
| `Critical` | `User_Said`、`User_Chose`、`Llm_Answered`、`Agent_Problem`、`Agent_Asked_Label`、`Agent_Absorbed`、`Agent_Terminated` |
| `Normal` | `Llm_Triaged`、`Llm_Judged`、`Llm_Drafted_Track`、`Agent_Selected`、`Agent_Predicted`、`Agent_Gated`、`Agent_Resolved`、`Agent_Called`、`Agent_Recorded`、`Agent_Looped` |
| `Detail` | `Agent_Read_View`、`Agent_Preloaded` |

**上下文不足时由程序裁剪，不交给 LLM 压缩**——LLM 压缩会丢信息也会失真，而丢什么、怎么并，程序说得
清、测得出。

```odin
build_prompt_history :: proc(log: ^Act_Log, budget: int, out: ^strings.Builder)
```

裁剪顺序固定，输出逐字确定：

1. `Critical` 全量保留，任何情况下不动
2. 预算不足：`Detail` 按 `kind` 归并成计数式一行（原子标签让归并是整数分组，不需要文本比较）
3. 仍不足：`Normal` 同样按 `kind` 归并
4. 仍不足：从最旧的 `Normal` 归并条目开始丢弃
5. **任何裁剪都留下痕迹**（"省略 N 条"），不做无声删减

行为记录本身有上限 `MAX_ACTS_KEPT`，超出时按同一顺序归并，会话内存因此有界。

被裁剪的是**行为记录**，不是环境上下文——上下文只有整层清理，没有"裁剪"这回事。两者混称会让人以为
上下文条目会被悄悄丢掉。

跨会话的记忆网络不在 MVP 内。它的原料是这里的行为记录，索引键是原子标签。

## 五、数据与持久化

### 5.1 为什么不用 JSON

不是偏好问题。**JSON 与"引用即 u32"根本不相容**：数据文件里每处引用都是原子标签，用 JSON 表达它只有
两条路——写成人读不懂的数字字面量（比二进制多占数倍字节，一个优点都没剩），或者为了能读而写成名字，
而那就会造出第二身份。既然数据文件是机械产物、不是给人读的，JSON 唯一的优点（人可读）就消失了，
剩下的全是缺点。

换成对齐的二进制之后有三个连带收益：

- **零拷贝**：载入是 `mmap` 加校验偏移，不是解析。记录数组直接从映射里切出来
- **语法层错误整类消失**：不会有"缺逗号""键不是数字""union 的 tag 名没定义"这类错误，载入器只剩
  结构校验
- **与不可变版本天然合流**：一个版本就是一组只读映射，刷新是整份原子替换，引用归零就 `munmap`

可读性由工具链提供，不由文件格式提供——`bagtool dump` 把二进制渲染成人可读文本，并作为 git 的
textconv，于是 `git diff` 照旧能看。

### 5.2 文件信封

三种文件共用一个信封，所以工具链只有一个读头。固定小端，不放字节序标记（跨机器搬运不是需求）。

本章把文件内的划分叫**区**（section），不叫"段"——"段"在第三章已经是 `Segment` 的名字，一个词两个
意思会让 `Duplicate_Id` 与 `Bad_Segment` 看起来覆盖同一件事。

```odin
// lib/bagfile/envelope.odin

Header :: struct {              // 32 字节
	magic:    [4]u8,            // "FGLB" / "CTRG" / "JRNL"
	format:   u16,              // 格式版本，破坏性改动才 +1
	sections: u16,              // 区数
	payload:  u32,              // 区表末尾到文件末尾的字节数
	hash:     u32,              // 载荷 crc32c，查截断与损坏
	content:  u32,              // 内容版本号，每次写入 +1
	_pad:     [12]u8,           // 必须为 0；将来加字段不必动 format
}

Section :: struct {             // 16 字节，区表紧随信封
	kind:   u32,
	count:  u32,
	offset: u32,                // 相对文件首，保证 8 字节对齐
	bytes:  u32,
}
```

**载荷从区表末尾起算**，所以文件大小必须恰好等于 `32 + 16 × sections + payload`。不相等即 `Unreadable`
——那是截断或拼接，连载荷校验都不必做。

**区与字段只能追加不能插入**，与程序区编号同理：文件里已经存了按位置解释的数据，插入会让旧文件被
错读。`_pad` 留着给将来的字段，用完再升 `format`。

**整份重写的两种文件**（`.fglb` 与 `.ctrg`）写入一律"临时文件 → fsync → rename"，所以任何时刻磁盘上
的文件都是完整的某一版，不存在半写状态。

**追加型文件（`.jrnl`）是信封的一个特例**：`payload` 与 `hash` 只在创建时写一次、此后**不再维护**，
一律置 0：每追加一条就重算整份载荷的 crc 与长度，追加会退化成整份重写。它的完整性由
每条记录自带的 crc 承担，长度由记录头的 `bytes` 逐条推进（见 [5.5](#55-runtimejrnl运行期日志)）。
载入器按 `magic` 分派：`JRNL` 跳过 `payload`/`hash` 的两条校验。**不写清这条特例，"信封统一"就会与
"追加写"直接打架。**

### 5.3 `labels.fglb`：原子表

**一个文件，原子标签的唯一事实来源。** 工程实践上至多两张表（静态与动态），但**只用一张**：

```
0    Header      32 字节  magic "FGLB" / sections = 1
32   Section     16 字节  kind = .Labels / count = n / offset = 48
48   Labels 区
     +0          next_id:  u32          下一个可分配编号，只增不减
     +4          blob_len: u32
     +8          flags:    [n]u32       严格升序（起始偏移 56，天然 8 字节对齐）
     +8+4n       lens:     [n]u8        语义标签 UTF-8 字节长度
                 （填充至 8 字节对齐）
                 blob:     [blob_len]u8 按 flags 顺序紧密排列
```

1024 条标签的定长部分占 48 + 8 + 4096 + 1024 = 5176 字节；按语义标签平均 8 字节（约 2.7 个汉字，
"必须保持精简"这条约束下的合理均值）算，blob 约 8 KB，合计约 13 KB。整份重写的代价可以忽略，
这也是"只用一张"在工程上成立的真正原因——真要分静态与动态两张，只有标签数进到十万量级、整份重写
成为热点时才有意义，而标签是语义原语不是数据行，不会到那个量级。**因此不预留分表结构。**

`flags` 升序不只是为了二分：它本身就是位图的稀疏形态，载入时不做转换就能建出"已登记编号"的位图，
把 `Unknown_Flag` 校验降到 O(1)。`offsets` 由一趟前缀和算出，不进文件。

载入期校验（顺序即依赖顺序，前一条不过就不必查后一条；括号里是对应的错误码）：

1. 文件大小 == `32 + 16 × sections + payload`；`magic` 与 `format` 已知（`Unreadable`）
2. 载荷 crc32c 相符（`Bad_Hash`）
3. 区表恰好一个 `.Labels` 区，`offset` 8 字节对齐，`bytes` == `8 + 4n + n + 填充 + blob_len`
   （`Bad_Section`）
4. `flags` **严格**升序，由此保证编号无重复（`Unsorted_Flags`）
5. 末元素 < `next_id`，且 `next_id` ≤ `MAX_FLAGS`（`Id_Overflow`）
6. `lens` 前缀和 == `blob_len`，每条 > 0（`Bad_Blob`）
7. blob 每条是合法 UTF-8（`Bad_Utf8`）
8. **语义标签两两不重复**（`Duplicate_Label`）
9. 程序区对齐：见下（缺行补齐不报错；多行报 `Stale_Reserved`）

程序区的对齐规则——**编译期枚举定编号与存在性，文件提供语义标签**：

| 情形 | 处置 |
| --- | --- |
| 编译进来的程序区成员缺行 | 用内建默认语义标签补齐，把文件标记为待更新，**不拒绝** |
| 出现编号 ≤ 程序区上界、但代码里已无对应成员的行 | **拒绝整个版本**并出卡片：文件比代码新，除标签外很可能还有别的不兼容 |
| 程序区的语义标签与内建默认不同 | 以**文件**为准。用户改得了程序区的展示名，改名安全，因为引用全是数字 |

写入三种操作：

- **新建**：`id = next_id`，`next_id += 1`，行追加在末尾（天然保持升序）
- **改语义标签**：只改该行的 `lens` 与 blob，引用不受影响——这就是"一次更新到处生效"
- **删除**：先扫结构注册表与运行期日志查引用，有引用则拒绝并列出引用点；无引用才删行，
  **编号不回收**。所以不需要墓碑行：被删编号从此不出现在 `flags` 里，任何悬空引用在下次载入被
  `Unknown_Flag` 抓住

### 5.4 `control.ctrg`：结构注册表

单文件，装标准、技能、流程、轨道、模式、步骤、条件、实体声明、接口登记、模板登记。单文件的理由：
全量原子、不可变版本、mmap 零拷贝三条已定设计都指向它；分层用记录里的 `tier` 字段而不是目录。

布局是**定长记录数组 + 三个共享池**。记录里所有引用都是 `u32`，且两种引用用不同类型区分——
`Flag` 是标签身份，`Idx` 是区内下标，混用它们正是"键"那一类错误的近亲：

```odin
Idx  :: distinct u32          // 区内下标
Span :: struct { off, len: u32 } // 指进共享池

Flow_Record :: struct {       // 定长 48 字节
	id:      Flag,            // +0
	handles: Flag,            // +4
	root:    Idx,             // +8   段区里的下标
	_gap:    u32,             // +12  对齐到 8，供将来的字段
	modes:   Span,            // +16  指进 idx 池，元素是模式下标
	fields:  Span,            // +24
	needs:   Span,            // +32  指进 tagset 池
	cplx:    Cplx_Record,     // +40
	tier:    u8,              // +44
	enabled: u8,              // +45  显式 1/0，不靠零值
	_pad:    [2]u8,           // +46
}                             // = 48

// union 在文件里的通用形状：显式 tag + 定长载荷。
Cplx_Record :: struct { tag: u32, value: u32 } // tag = 0 固定值，1 槽位键
```

**记录长度是数组步长，写错一个字节整个区就错位**，所以每个字段都标了偏移。定长记录一律补齐到 8 的
倍数，于是 `mmap` 之后 `slice_data_cast` 对任何一条记录都成立。

三个池：`idx_pool`（下标与 `Flag` 数组）、`blob`（UTF-8 正文）、`tagset_pool`（位图稀疏形态）。
union 的表示是**显式 tag + 载荷**（`Cplx_Record`、`Action_Record` 都是这个形状），不靠字段有无来推断
——推断规则一旦没写清，两个实现就会各自猜。

载入 = `mmap` + 校验偏移 + `slice_data_cast`（要求 4 字节对齐，区起始 8 字节对齐已满足）。
所有跨记录引用都要查界：`Span` 不越池尾、`Idx` 小于对应区的 `count`，否则 `Bad_Section`。

### 5.5 `runtime.jrnl`：运行期日志

追加型，装运行期产出的**本体**：事实、临时轨道与留守条目、标签请求。

```odin
Journal_Record :: struct {  // 定长 24 字节头 + 载荷
	kind:  u32,             // +0
	bytes: u32,             // +4   载荷字节数，不含头与填充
	seq:   u64,             // +8   递增序号，去重与引用都用它
	crc:   u32,             // +16  载荷 crc32c
	_pad:  u32,             // +20
}                           // = 24
```

`seq` 是 `u64`：它是留守条目、事实与标签请求的**持久身份**，全文引用它的地方都按 `u64` 算。
用 `u32` 会在计数溢出后让旧引用指向新条目——与编号复用同一类错误。

每条记录的载荷末尾填充到 8 的倍数，所以下一条记录头也落在 8 字节对齐处，读取时可以直接把头 cast 出来。
追加写后 fsync；读到 crc 不符、`bytes` 越过文件末尾、或头不完整，即**就地截断**——崩溃时最后一条可能
只写了一半，截断比拒绝整个文件好，因为前面那些是完好的。

信封的 `payload` 与 `hash` 对本文件不适用，理由见 [5.2](#52-文件信封)。

统计不在这里，它是派生量（见 [4.2](#42-环境上下文)）：启动时折叠日志得出，运行期在常驻层累加。
`bagtool compact` 压实时写一条基线记录，把已折叠的历史收成一条，于是压实不丢统计。

### 5.6 工具链 `bagtool`

一个独立可执行文件，四个子命令进 MVP：

| 命令 | 作用 |
| --- | --- |
| `seed` | 从 Odin 结构体字面量生成 `labels.fglb` 的程序区与 `control.ctrg`。附带好处：**一批载入期错误降级成编译错误**——字段拼错、类型不对、引用不存在的常量，编译器先拦一道 |
| `dump` | 渲染成人可读文本，语义标签已解析。调试、code review、git textconv 都靠它 |
| `check` | 独立跑全套载入期校验，输出 `Load_Report`。同时是"每个载入期错误一份坏数据文件"那批负面测试的运行器 |
| `relabel` | 改语义标签，整份原子替换 |

推后：`diff`（语义级差异）、`compact`（日志压实 + 基线记录）。

git 侧：`.gitattributes` 配 `*.fglb *.ctrg diff=bag`，`diff.bag.textconv = bagtool dump`。二进制进仓库
但 `git diff` 直接可读。

**git 里谁是源，按文件分而不是按时间分**：

- `labels.fglb`：**从第一天起二进制就是源**。标签只能由用户拟定，交互界面与 `relabel` 是唯一入口
- `control.ctrg`：MVP 期间以**播种代码为源**、产物进 git 便于审查；编辑界面上线后切换成二进制为源，
  播种代码退役为测试固件

两者是两个文件，所以永远不会出现两个源打架——这是分成两种文件类型的额外好处。

### 5.7 注册表版本与刷新

成文期＝载入与校验，产出一个**不可变**版本；运行期＝工作执行，绑定一个版本直到工作结束。隔离由程序
保证，不靠"要求用户改代码重建"。

```odin
// lib/control/registry.odin

Registry :: struct {
	version:    u64,
	labels:     Label_Table,
	skills:     []Skill,           // 含各自的流程
	tracks:     []Track,
	standards:  []Standard,
	entities:   []Entity,
	flow_of:    map[Flag]^Flow,    // 意图种类 → 流程，一对一
	tracks_of:  []^Track,          // 已按层序与优先级排好，选轨直接顺序扫
	triage_by:  Flag,              // 飞行检查的默认指派实体，能力须为 Capture_Intent
	refs:       int,               // 原子引用计数
	maps:       [2]Mapping,        // labels.fglb 与 control.ctrg 的只读映射
	arena:      virtual.Arena,     // 只装索引：offsets、by_label、位图、map
}

// 一份只读映射：文件描述符与映射到的字节。释放时 munmap 并关闭。
Mapping :: struct {
	fd:    os.Handle,
	bytes: []u8,
}

registry_load    :: proc(root: string) -> (^Registry, Load_Report)
registry_stage    :: proc(a: ^Agent, reg: ^Registry)  // 置为"待生效"
registry_adopt   :: proc(a: ^Agent)                  // 在工作边界切到待生效版本
registry_release :: proc(reg: ^Registry)
```

**一个版本 = 两份映射 + 一组索引**，同生同死。主体零拷贝住在映射里，`arena` 只装载入时算出来的索引
（`offsets`、`by_label`、位图、两张 map）。引用归零后 `munmap` 两份映射并释放 arena。

`registry_adopt` 的签名拿的是 `^Agent` 而不是两个指针：切版本时**同时**要把常驻层里指向旧标签表的
引用重挂。**标签表只经 `Host.registry.labels` 取用，没有第二个持有者**——上下文的存活期是活动代理级、
跨版本存活，而旧版本的 arena 在引用归零时整体释放，所以任何存在上下文里的标签表指针都会悬垂。

刷新语义（对应 concepts.md 的重载特性）：

- **活动中不生效。** 一次工作从开始到结束（含跨轮的挂起）始终走它绑定的那个版本
- **工作完成才刷新。** 会话在工作边界调 `registry_adopt`
- **作用于所有活跃会话，不只新会话。** 待生效版本是活动代理级的，任何会话到达自己的工作边界都会
  切过去；空闲会话在下一次开工时立即用上新版本
- **全量原子**：任一文件不合法就整批拒绝，当前版本继续服务，错误带文件与位置。半套注册表不存在
- **层序**：`tracks_of` 内先 `Authored` 后 `Absorbed`；同层内 `priority` 降序，同优先级按 id 升序。
  全序、可复现，于是吸收进来的轨道**只能补空白，抢不到既有覆盖**
- **优先级与层级由程序赋值**：层级由所在段决定，吸收进来的轨道取 `priority = len(conditions)`
  （越具体越先试）。文件里声明的层级与优先级一律忽略
- **运行期不改写蓝本文件。** 运行期产出全部进 `runtime.jrnl`

载入期错误码。**每一种触发情形都对应一份坏数据文件**——不是每个码一份：几个码覆盖多种情形
（逐个注明在枚举里），那就每种情形一份。断言 `Load_Report` 的 `file` 与 `path` 指对了位置，
`detail` 说清是哪一种情形；拒绝理由说不清哪一处，等于没说。

**打不开文件不在这张表里**：那是异常（磁盘、权限、路径），按 [1.4](#14-命名与错误处理约定) 的分界处理。
这张表只收"文件读到了，但内容不合法"。

```odin
// 拒绝必须说清"哪个文件的哪一处"，否则用户只知道"载入失败了"——
// 那正是错误处理那条不允许的。报告直接映射成一张问题卡片。
Load_Report :: struct {
	err:    Load_Error,
	file:   string, // 相对 root 的路径
	path:   string, // 文件内位置，如 "flows[2].steps[5].gate.threshold"
	detail: string, // 违规的原值与情形，字符串以免失真
}

Load_Error :: enum {
	None,
	// —— 文件层
	Unreadable,        // magic 不符、format 未知，或大小 ≠ 32 + 16×sections + payload
	Bad_Hash,          // 载荷 crc32c 不符：截断或损坏
	Bad_Section,       // 【2 情形】区表不自洽；Span / Idx 越界
	// —— 标签表
	Unsorted_Flags,    // flags 非严格升序
	Bad_Blob,          // 【2 情形】lens 前缀和与 blob_len 不符；有零长条目
	Bad_Utf8,
	Duplicate_Label,   // 语义标签重复，解析会有歧义
	Stale_Reserved,    // 有程序区行，代码里已无对应成员：文件比代码新
	Id_Overflow,       // 【2 情形】末元素 ≥ next_id；next_id 越过 MAX_FLAGS
	// —— 指名
	Unknown_Flag,      // 指名了未登记的标签
	Unknown_Iface,     // 指名了未登记的登记物（接口 / 模板 / 视图 / 实体，四类共用一码）
	Bad_Direct,        // Call_Interface 指名的接口未声明 direct
	No_Submit_Tool,    // 某个实体的长期工具集里没有终结型工具
	Bad_Judge,         // 【2 情形】by（含 Registry.triage_by）缺失；它的能力不在允许集合内
	Bad_Reply,         // 轨道的 yields 与 reply_by / reply_tmpl 不互斥
	Bad_Options,       // 【3 情形】接口参数的 options 与 dynamic 都空；二者兼有；
	                   // Field_Spec 的 free 为真却声明了 options
	// —— 轨道
	No_Conditions,     // 轨道的条件集合为空
	Unknown_Slot,      // resolves 不在流程的 fields 内
	Slot_Uncovered,    // 流程的必填字段没有任何轨道步骤落定
	// —— 流程结构
	No_Flow,           // 轨道的 yields 没有对应流程
	Duplicate_Flow,    // 两条流程声明处理同一意图种类（flow_of 是一对一）
	Bad_First_Step,    // 顶层段首步不是模式选择
	Bad_Segment,       // 【3 情形】序列里有步骤不在步骤池内；同一步骤在一段内出现两次；
	                   // 模式候选不在本流程的模式池内
	Orphan_Step,       // 步骤池里有步骤不属于任何段，等于死代码
	Bad_Jump,          // 【4 情形】回跳边越出本段；指向更晚的步骤；轮数越限；
	                   // 目标的 require 引用了起点的产出
	Bad_Mode_Nesting,  // 【2 情形】模式嵌套成环；深度越过 MAX_MODE_DEPTH
	Unreachable_Mode,  // 候选列表里排在恒真模式之后，永远选不上
	No_Mode_Fallback,  // 候选条件可能全不成立，却既无兜底模式也无 by
	// —— 环节与语义
	Bad_Refine,        // 带 Refine 标记的步骤没有回跳边指向本段内的 Review 步骤
	Bad_Review_Step,   // 带 Review 标记的步骤不是 Ask_Entity，或指名实体的能力不是 Review
	No_Review,         // 有 Teardown 的路径上没有 Review 步骤，收尾证据恒不齐备
	No_User_Output,    // 某条展开路径上没有带 Report 标记的 Render 步骤
	Bad_Teardown,      // 有收尾但该路径上没有等待裁决的报告步骤
	Bad_Adjust,        // adjust_to 非空却指向段外或指向更晚的步骤
	Missing_Sink,      // 撰写类步骤没声明 into，产物无处存放
	// —— 取值与规模
	Bad_Condition,     // subject / test / 操作数组合非法，或用在不允许该主语的位置
	Bad_Complexity,    // cplx 指名的槽位不在 fields 内，或其取值集越出复杂度五级
	Unreachable_Backstop, // On_Below 的门槛不高于**所在展开路径**的复杂度下界，保底恒不触发
	Bad_Binding,       // Arg_Binding 的来源不可达
	Bad_Bounds,        // 规模上限越限，**且没有专用码**：MAX_TRACK_STEPS、MAX_FLOW_STEPS、
	                   // MAX_SEGMENT_STEPS、MAX_CONDITIONS、MAX_OPERANDS、MAX_CLARIFY_TURNS、
	                   // MAX_MODE_CANDIDATES、MAX_EXPANSIONS、MAX_LABEL_PROPOSALS。
	                   // 有专用码的不归它：深度→Bad_Mode_Nesting，回跳轮数→Bad_Jump，
	                   // 标签容量→Id_Overflow
	Duplicate_Id,      // 同一命名域内 id 重复。域是按登记物种类划分的：标签、技能、流程、轨道、
	                   // 模式、步骤各自成域，不是按文件区划分
}
```

## 六、可见性

知情权在这一章变成接口。程序发生的每一件事都有出口：过程以**事件**外送，问题以**卡片**呈现，状态以
**只读接口**开放。

### 6.1 事件

```odin
// lib/control/event.odin

Event :: struct {
	kind:    Event_Kind,
	session: string,
	step:    Flag,           // Step：步骤 id
	delta:   string,         // Content / Question / Reasoning 的文本增量
	prompt:  Prompt_To_User, // Question / Report：结构化出题
	problem: Problem,        // Problem：问题卡片
	path:    []Frame_View,   // Step / Question / Report：当前段栈
}

// 段栈的外送形态：每层是"哪个模式、走到哪一步"，正好对应状态展示要的分层
Frame_View :: struct {
	mode: Flag,
	step: Flag,
	at:   int,
	of:   int,
}

Event_Kind :: enum {
	Session,   // 首轮回送会话 id
	Step,      // 步骤进入 / 离开 / 被简化 / 被跳过
	Reasoning, // 思考增量：不进气泡，进思考面板
	Content,   // 面向用户的正文增量
	Question,  // 澄清出题，本轮挂起
	Report,    // 报告裁决点或确认裁决点，本轮挂起
	Problem,   // 问题卡片，任何严重级别都发
	Done,      // 终止事件，永远最后一个
}

// 出口只知道"投一个事件出去，成没成"。SSE 帧格式与 socket 都在传输层，控制层碰不到——
// 否则 lib/control 就得 import core:net，"不接网络即可完整运行"随之作废。
Emit :: #type proc(user: rawptr, ev: Event) -> bool

Event_Sink :: struct {
	emit:     Emit,
	user:     rawptr,    // 生产实现是 server.odin 里的 ^Sse_Sink，测试实现是一个事件数组
	session:  string,    // 由实例层填，控制层只是转抄进 Event
	healthy:  bool,      // emit 返回假即置否，执行随即中止
	deadline: time.Time, // 越过即中止，实体调用一并取消
}
```

`Session` 与 `Done` 的产生者由实例层承担，不由控制层：**`Session` 在建会话后立即发一次**
（控制层不知道会话是什么，所以它发不出来）；**`Done` 由实例层在轮次结束时发，成功与失败都发，
永远最后一个**。终止时的顺序是先 `Problem` 后 `Done`——卡片说明发生了什么，`Done` 只表示"到此为止"。

`Question` 与 `Report` 也带 `path`：挂起恰恰是用户停留最久的时刻，此时看不到自己在流程的哪个位置是
说不通的。

事件全部外送，**不设服务端的显示开关**：分流是前端按 `kind` 做的。"默认不展示思考"是布局决策，
不是不发送——发不发送不该由后端替用户决定看不看。

`Ask_Entity.emit` 是一处例外，但不构成显示开关：它写在流程数据里、由用户拟定，而不 `emit` 的产物照旧
以 `Act` 进入行为记录、经 `/api/acts` 读得到。**没有任何东西只存在于内存里而不可读**——这才是那条禁令
要守的东西。

`healthy` 与 `deadline` 要真正生效，`lib/llm_request` 必须能中止流并支持工具调用：

```odin
// lib/llm_request 的必要改动
Stream_Control  :: enum {Continue, Stop}
Stream_Callback :: #type proc(user: rawptr, kind: Delta_Kind, delta: string) -> Stream_Control
Delta_Kind      :: enum {Reasoning, Content, Tool_Call}
// 请求体加 tools 与 tool_choice；Error 增加 Cancelled
```

没有中止返回值，墙钟上限与"客户端已断开"都只是纸面约束；没有工具调用，结构化产物就得回退到解析格式化
输出。两项都是必要改动，不是可选项。

### 6.2 问题上报

问题不压成一句话。每条问题至少说清三件事——**是谁有问题、有什么问题、什么原因导致的**——其余信息放进
卡片的其他部分，由前端用图标与布局呈现。

```odin
// lib/control/problem.odin

Problem :: struct {
	severity: Severity,
	who:      Actor_Ref,      // 是谁：主体类别 + 具体标签
	what:     Problem_Kind,   // 有什么问题；前端据此选图标，封闭集所以映射是全的
	cause:    Cause_Kind,     // 什么原因导致
	fields:   []Problem_Field,// 卡片其余部分：定位信息、原始消息、可做的处置
	at:       time.Time,
}

Severity :: enum {
	Blocking, // 本轮到此为止
	Degraded, // 工作继续，但结果已被削减
	Notice,   // 不影响结果，但用户有权知道
}

Actor_Ref :: struct {
	kind: Actor_Kind,
	id:   Flag,       // 具体是哪一个；无对应标签时为 FLAG_NONE
}

Actor_Kind :: enum {
	Transport, Provider, Entity, Interface, Flow_Step, Track, Registry, User_Input,
}

Problem_Kind :: enum {
	Unreachable, Rejected, Malformed, Out_Of_Budget, Not_Covered,
	Unresolvable, Overreach, Retries_Spent, Not_Registered, Capacity,
}

Cause_Kind :: enum {
	Network, Auth, Timeout, Client_Gone, Bad_Argument, Missing_Label,
	Condition_Unmet, Limit_Reached, Data_Invalid, User_Declined,
}

Problem_Field :: struct {
	key:   Flag,  // 字段名；定位类字段用程序区的 Field_* 标签
	value: Value,
}

// 构造与上报是一件事，所以只有一个入口——"先构造好、也许待会儿再报"就是静默降级的开口。
report :: proc(h: ^Host, sink: ^Event_Sink, p: Problem)
```

规则：

- **产出即上报。** 任何一处判定出问题，就地构造并投出去，不等到轮次结束、不因为"不阻塞"而省略
- **卡片由程序产出，不经 LLM。** LLM 可能正是出问题的那一环；卡片是结构化数据，本来也不需要它组织文字
- **同一份内容三处落地**：外送给用户、写进行为记录、追加一条 `kind = Problem` 的运行期日志记录。
  三处同源——卡片本体在 `Act_Log.problems`，`Act.payload` 存下标，外送与日志引用同一份。
  （本文里"**日志**"只指 `runtime.jrnl`；会话里那一份一律叫**行为记录**，两个词不混用）
- **不做静默降级。** 任何 `Degraded` 都必须有对应的一条上报，说明被削减了什么
- **载入期的问题没有 sink 可投。** 载入发生在任何轮次之外（启动或 `reload`），所以 `registry_load`
  返回 `Load_Report`，由调用方转成卡片：启动时写进标准错误并拒绝启动，`reload` 时投给发起刷新的那一侧
- **stdin 侧的 `reload` 卡片投到管理端事件流。** MVP 的 `reload` 从 stdin 发起，那一侧没有 SSE 连接，
  所以实例层维护一个管理端 `Event_Sink`（前端的状态页订阅它），卡片投在那里；stdin 只回一行"已受理
  / 已拒绝，详见状态页"。**不把结构化卡片压成文本打在终端上**——那与"绝不用文本一刀切"相抵

### 6.3 状态接口

**程序持有的每一样信息都有读取路径，不以"信息太多"为由隐藏**——那是对用户知情权的侵犯。判据是穷举的：
上下文四层、行为记录、注册表里的蓝本、运行期日志里的三类本体（事实、留守条目、标签请求）、
以及由日志折叠出来的统计，逐一对应下表的一行。前端用分组、分层、分页
安排布局，但服务端不做取舍。

| 接口 | 内容 |
| --- | --- |
| `POST /api/chat` | **唯一的对话入口**。请求体只有三个可选字段：`session`（会话 id，首轮可省）、`utterance`（一句话）、`choice`（对上次出题的一次选择）。不接受客户端携带历史——历史在服务端 |
| `GET /api/state` | 环境上下文四层的全部条目（按层与条目类分组） |
| `GET /api/acts` | 行为记录（含问题卡片本体） |
| `GET /api/registry` | 标签表、技能、流程、轨道、标准、实体声明、接口与模板登记 |
| `GET /api/facts` | 事实表的全部条目，含来源分级与写入时刻 |
| `GET /api/stats` | 统计（派生量，含各条轨道与流程的命中与完成） |
| `GET /api/leftovers` | 留守条目：临时轨道与标签请求，含状态 |

`utterance` 受 `MAX_UTTERANCE_BYTES` 限制，越限与格式非法都由传输层直接拒（400），不进控制层——
默认拒绝在最外层就生效。

写入端同样要有——否则"增删标签、改语义标签、接受或改写标签请求"这些反复承诺过的用户操作在架构里不
存在：

| 接口 | 作用 |
| --- | --- |
| `POST /api/labels` | 新建标签、改语义标签、删除标签（删除前查引用） |
| `POST /api/leftovers/<seq>` | 处置一条留守条目：建立 / 合并 / 更新 / 拒绝 |
| `POST /api/reload` | 触发一次载入与 `registry_stage` |

写入的共同路径：**先写临时文件 → 用与载入器同一套校验查临时文件 → 通过才 rename**。校验不过就删掉
临时文件，磁盘上原有的那份从未被动过。反过来（先替换再校验）会让磁盘上的唯一事实来源在校验失败时已经
是非法内容，下次启动直接起不来。通过之后再 `registry_load` + `registry_stage`，在各会话的工作边界生效
——**写入不即时生效**，这是重载特性要求的。

**流程与轨道在 MVP 没有 HTTP 写接口**，但这不是"用户不能拟定流程"——concepts.md 明写流程与轨道可以由
用户拟定。这只是 MVP 的范围取舍：编辑流程结构需要一个结构编辑器，MVP 期间那个位置由
`bagtool` 与播种代码占着（见 [5.6](#56-工具链-bagtool)），编辑界面在 MVP 之后。标签与留守条目走 HTTP，
因为它们是日常使用中会碰到的东西。

### 6.4 前端分流规则

| 事件 | 落点 |
| --- | --- |
| `Content` | 气泡（**纯文本**，不渲染 Markdown） |
| `Question` / `Report` | 气泡 + 结构化控件（封闭槽位给按钮或下拉，裁决给按钮组） |
| `Reasoning` | 思考面板，默认收起 |
| `Step` | 进度面板，按 `path` 分层显示"哪个模式、走到第几步" |
| `Problem` | 问题卡片，按 `what` 选图标，按 `severity` 定强度 |
| `Session` | 存下会话 id，不显示 |
| `Done` | 收尾：解除输入锁 |

三条界面约束：颜色只取 `:root` 变量（橙 + 灰阶）；气泡只渲染纯文本——**Markdown 会让人下意识细读，
反复出现的加粗与列表制造认知疲劳**；默认 `user-select: none`，只在需要复制的区域打开。

### 6.5 与用户的交互：能给控件就不给大段文字

交互哲学落在这里：**要用户在封闭取值集里选一项时，给结构化选项，不写成一段话让他猜。**

```odin
// lib/control/prompt.odin

Prompt_To_User :: struct {
	text:      string,        // 一句话，纯文本
	slots:     []Slot_Prompt, // 需要用户选的槽位
	choices:   []Flag,        // 裁决选项：报告三支、确认两支、吸收四支
	free_text: bool,          // 是否同时接受自由文本
}

Slot_Prompt :: struct {
	key:     Flag,
	label:   string,  // label_of(Field_Spec.label) 现取
	options: []Flag,  // 封闭取值集
	free:    bool,    // 与 Field_Spec.free 同源；真表示本槽位收自由文本
}
```

`Slot_Prompt` 的 `free` 与 `Field_Spec.free` 同源，**不用"options 空集"表达自由文本**——同一个字段名
在两个结构里带两种空集含义，读错一处就会让自由文本槽位变成"任意标签"。

`free_text` 与选项可以并存，规则定死：**用户既选了选项又填了文本时，选项优先落定槽位，文本作为一条
`User_Said` 记入行为记录并进上下文**（后续步骤可以读，但不参与本次落定）。不定这条，两个实现会各自
猜，而用户会以为自己填的话被吃了。

出题形态由程序判定，不由实体决定——三种形态见 [2.4](#24-轨道的解析步骤与出题) 与
[3.10](#310-留守条目与吸收固化)。

## 七、契约与验证

### 7.1 不变量

每一条都给出强制点：它在载入期、启动期还是执行路径上被拦住，以及拦住它的是哪个错误码或哪段判定。

| # | 不变量 | 强制点 |
| --: | --- | --- |
| 1 | 语义标签到原子标签的解析是唯一的采信点，解析不成即拒绝，不做模糊匹配 | 实参校验路径 |
| 2 | 标签身份是编号，展示是语义标签；数据文件引用编号，改名不打断引用 | 文件格式（`.fglb` 无名字引用） |
| 3 | 编号只增不复用 | `next_id` 持久化 + 删除路径不回收 |
| 4 | 用户区只能由用户拟定，程序区随代码发布；代理只能**请求**增改 | 写入接口 + `Stale_Reserved` |
| 5 | 变量是数据，能力是代码；数据里只出现指名，不出现过程指针 | `Unknown_Iface` |
| 6 | 控制层不依赖传输层与实例层——不接网络即可完整运行 | 编译（无 import） |
| 7 | 结构化产物走工具调用，参数名与取值集由程序定死 | 工具模式构造 |
| 8 | 工具按界面八条准则设计 | 工具模式构造 + 实参校验 + `Confirm_Point` |
| 9 | 每个实体至少有一个终结型工具 | `No_Submit_Tool` |
| 10 | 封闭取值集必须有出口 | `No_Match` + `No_Mode_Fallback` |
| 11 | 实体从不指名要调哪个接口；`confirm` 的接口不进实体的屏 | `Entity_Call.tools` 构造 |
| 12 | **实体不派发实体** | 调用栈深度断言恒为 1 |
| 13 | 实体之间不互看内部产物 | 提示组装只读本步授予的东西 |
| 14 | 凡要实体做判断处都在数据里指名并校验职责；执行器不挑实体 | `Bad_Judge` |
| 15 | 步骤与环节是多对多；挂不挂起由 `awaits_user` 表达 | 结构（`Phase_Set` 是集合） |
| 16 | 模式选择的位置在成文期定死；影响范围就是它自己那一段 | 结构 + `Bad_Mode_Nesting` |
| 17 | 复杂度只有两种来源 | `Bad_Complexity` |
| 18 | 预测检查程序先行，实体保底只在封闭三选一里作答 | 执行路径（读结果后才决定） |
| 19 | 保底检查必须可达 | `Unreachable_Backstop` |
| 20 | 被跳过或被简化的步骤不触发它的回跳边 | 执行路径 |
| 21 | 回跳只指向更早的步骤、有轮数上限、模式嵌套不成环——有界性载入期证明 | `Bad_Jump` + `Bad_Mode_Nesting` |
| 22 | 收尾需三项证据齐备；有收尾的路径必须有审查步骤 | 执行路径 + `No_Review` |
| 23 | 报告三支语义定死，重新规划不进本流程 | 执行路径 + `Bad_Adjust` |
| 24 | 流程只在轨道命中后执行；未命中则现场生成，生成不出来就如实告知 | 执行路径 |
| 25 | 一次工作绑定一个不可变版本；工作完成才刷新，作用于所有活跃会话 | `Work.registry` + `registry_adopt` |
| 26 | 载入全量原子，拒绝理由带文件与位置 | `registry_load` 返回 `Load_Report` |
| 27 | 层级由段决定、优先级由程序赋值；吸收的只能补空白 | `registry_load` 忽略文件声明 |
| 28 | 运行期不改写蓝本文件 | 运行期产出只写 `runtime.jrnl` |
| 29 | **环境上下文是唯一事实来源**：跨步骤产物只经它传递；里面的一切是副本，本体在永久储存 | `Missing_Sink` + 层的所有权结构 |
| 30 | 上下文裁剪由程序完成（裁剪的是行为记录），按重要级别归并并留痕 | `build_prompt_history` |
| 31 | 出现问题就上报，不论是否阻塞；卡片由程序产出，三处同源 | `report` 是唯一入口 |
| 32 | 没有静默降级：简化、跳过、削减、多筛、漏筛都有对应上报 | 执行路径 + 测试断言 |
| 33 | 不替用户丢弃：留守条目保留至用户处理，拒绝也留记录 | 条目持久在 `runtime.jrnl`（无删除路径）+ `MAX_TEMP_TRACKS` 满时拒绝新生成 |
| 34 | 不存在隐式吸收：没有自动准入，没有自动退役 | 结构上没有这两个过程 |
| 35 | 程序持有的每一样信息都有读取路径 | [6.3](#63-状态接口) 的接口表逐项对应各个持有者 |
| 36 | 会话是程序状态的唯一来源，客户端不携带历史 | `POST /api/chat` 的请求体只有三个可选字段，见 [6.3](#63-状态接口) |

第 33 条的强制点特意不写"收尾盘点步骤"：盘点是**主要**的处置场所，但不是唯一——速写这类无收尾的流程
压根不盘点（见 [8.4](#84-技能与流程)）。真正保证"不丢"的是日志里没有删除路径，以及条目堆满时**拒绝
新生成**而不是淘汰旧的。把强制点写成盘点步骤，就会有一条不成立的断言留在表里。

### 7.2 预算与限额

每一项都是硬上限，越限即拒绝，不做降级尝试。**越限本身也是一条问题上报。** 一处定义在
`lib/control/limits.odin`。

第三列是它**在哪被拦**——没有这一列，"硬上限"就是一句没有落点的话。载入期拦的写错误码，
运行期拦的写终止种类或处置。

| 常量 | 值 | 拦在哪 |
| --- | --- | --- |
| `MAX_UTTERANCE_BYTES` | 4096 | 传输层校验请求体，越限直接 400 |
| `MAX_TEXT_ARG_BYTES` | 8192 | 实参校验，回校验回执 |
| `MAX_LABEL_BYTES` | 255 | `lens: u8` 的天然上限；写入路径拒绝 |
| `MAX_CLARIFY_TURNS` | 3 | 载入期 `Bad_Bounds`（`Ask_Policy.max_turns`）+ 运行期 `Clarify_Failed` |
| `MAX_TRACK_STEPS` | 8 | 载入期 `Bad_Bounds` |
| `MAX_FLOW_STEPS` | 32 | 载入期 `Bad_Bounds` |
| `MAX_SEGMENT_STEPS` | 16 | 载入期 `Bad_Bounds` |
| `MAX_MODE_CANDIDATES` | 4 | 载入期 `Bad_Bounds`（单个模式选择的候选数） |
| `MAX_EXPANSIONS` | 64 | 载入期 `Bad_Bounds`（展开路径条数，穷举校验的规模上限） |
| `MAX_MODE_DEPTH` | 3 | 载入期 `Bad_Mode_Nesting` |
| `MAX_CONDITIONS` | 8 | 载入期 `Bad_Bounds` |
| `MAX_OPERANDS` | 16 | 载入期 `Bad_Bounds` |
| `MAX_REFINE_ROUNDS` | 3 | 载入期 `Bad_Jump` + 运行期 `Review_Failed` |
| `MAX_REPORT_ROUNDS` | 3 | 运行期按 `Work.rounds` 计数，越限 `Budget_Exceeded` |
| `MAX_LATE_LOADS` | 4 | 运行期第二层补取计数，越限 `Budget_Exceeded` |
| `MAX_CALLS_PER_ENTITY` | 8 | 运行期 `Flow_Context.calls`，越限 `Budget_Exceeded` |
| `MAX_LLM_CALLS_PER_TURN` | 24 | 运行期轮次级计数，越限 `Budget_Exceeded` |
| `MAX_TOOL_CALLS_PER_CALL` | 8 | 一次实体调用内计数，用尽即 `No_Submit` |
| `MAX_TOOL_RETRIES` | 2 | 实参校验计数，用尽即 `Retries_Spent` |
| `TURN_DEADLINE` | 180 s | `Event_Sink.deadline`，越过即 `Cancelled` |
| `MAX_FLAGS` | 65536 | 载入期 `Id_Overflow` |
| `MAX_FACTS` | 1024 | 写入事实时淘汰最旧的非 `User_Stated` 条目并留痕 |
| `MAX_LABEL_REQUESTS_PER_DAY` | 8 | 备用通道发起时丢弃并上报 |
| `MAX_LABEL_PROPOSALS` | 8 | `propose_label` 的实参校验，越限回校验回执 |
| `MAX_TEMP_TRACKS` | 128 | 生成临时轨道前检查，满则拒绝并上报 `Blocking` |
| `MAX_LEFTOVER_PER_TEARDOWN` | 5 | 收尾盘点构造出题时截断，其余顺延 |
| `CONTEXT_BUDGET_BYTES` | 8192 | 提示组装时按视图声明逆序裁剪并留痕 |
| `MAX_ACTS_KEPT` | 256 | 追加行为记录时按重要级别归并 |
| `MAX_WORK_TURNS` | 16 | 工作续接时计数，越限 `Budget_Exceeded` |
| `SESSION_TTL` | 30 min | 会话回收扫描，同时释放它持有的版本引用 |
| `MAX_SESSIONS` | 256 | 建会话时拒绝，`Overloaded` |
| `MAX_CONCURRENT_TURNS` | 4 | 原子计数守卫，超出立即 `Overloaded`，不排队 |

`MAX_EXPANSIONS` 不是装饰：载入期有三处校验要穷举展开路径（门槛可达性、`Arg_Binding` 可达性、
每条路径的交付步骤）。`MAX_MODE_DEPTH` 单独不构成规模上限——深度 3 配上不封顶的候选数，路径条数照旧
可以爆。**要穷举就得先给穷举定界**，否则"载入期证明有界"这句话本身没有界。

`MAX_WORK_TURNS` 不能省：**单轮有界不等于一次工作有界。** `MAX_REPORT_ROUNDS` 管的是单个报告点的
往复次数，而 `Work.rounds` 按步骤 id 分别计数——一条路径上有多个报告点时，总轮次仍然无界。
越限映射 `Budget_Exceeded`。

`MAX_TEMP_TRACKS` 满时**拒绝新生成**而不是淘汰旧的：淘汰就是替用户丢垃圾。拒绝时上报一条
`Blocking` 卡片，告诉用户"要先处理留守条目才能继续学新东西"。

### 7.3 失败与终止

终止种类决定**程序做什么**；用户看到的是一张问题卡片，不是一句被压扁的话。

```odin
Terminal :: enum {
	Unhandled,        // 临时轨道也生成不出来：如实告知，附意图清单
	Clarify_Failed,   // 追问用尽、回答无法满足、解析失败
	Review_Failed,    // 回跳轮数用尽仍未通过审查
	Interface_Failed, // 接口拒绝或依赖不可用
	Entity_Failed,    // 实体越权调工具、改正次数用尽、无终结型工具可按
	Budget_Exceeded,  // 步数、调用数、补取次数、工作轮次或墙钟越限
	User_Declined,    // 确认裁决点上用户拒绝了不可逆操作
	Session_Busy,     // 同一会话已有轮次在跑
	Overloaded,       // 并发轮次或会话数达上限
	Load_Rejected,    // reload 被拒：当前版本继续服务，但用户必须知道新数据没生效
}
```

**这张表只收预期终止。** 按 [1.4](#14-命名与错误处理约定) 的分界，异常不进这里：飞行检查跑不起来、
分配器耗尽、注册表指针为空都是异常，它们照旧出 `Blocking` 卡片，但不伪装成一种业务结果。反过来，
这张表里的每一项都是**设计出来的路径**，都有对应的执行分支与测试。

每个终止种类映射一张 `Blocking` 卡片：`who` 指到具体的实体、接口或步骤，`what` 与 `cause` 取自判定
现场，`fields` 带定位信息（技能、流程、模式、步骤、注册表版本）和可做的处置。
**不再有"内部细节只进日志"这回事**——日志与卡片是同一份内容的两个落点。

`Load_Rejected` 是唯一不终止某一轮的终止种类：它终止的是一次刷新。`Load_Report` 的
`file`/`path`/`detail` 直接填进卡片的 `fields`——"载入失败了"不算说清楚，"哪个文件的哪一处、原值是
什么"才算。

`Unhandled` 的卡片额外附上意图清单视图，以及（若发起过）待用户处理的标签请求，让"我现在不会做这件
事"变成"这是我会做的，以及你可以补什么"。

### 7.4 并发与内存

一次轮次占用一个事件循环线程（共 CPU 核数个），因为 SSE 字节由该连接所属的线程直接写出，而轮次内含
多次实体调用，占用时长以秒计。原子计数守卫 `MAX_CONCURRENT_TURNS`，超出立即返回 `Overloaded`，不排队。

代价是：与被占满的线程共用同一 loop 的其他连接，会排在该轮次之后。这是传输层的天花板，突破它
要把连接生命周期从框架手里接管（读完请求后把 socket 交给工作线程并自行收尾）；在那之前，上限与墙钟是
定死的，不靠祈祷。

会话存储由一把 `sync.Mutex` 保护，`in_flight` 在锁内置位，第二个同会话请求得到 `Session_Busy`。
注册表版本用原子引用计数：`registry_stage` 只置待生效指针，切换发生在各会话的工作边界。

**引用计数的增减方定死**：`Work` 创建时对绑定的版本 `+1`，`Work` 释放时 `-1`；`Agent.registry` 与
`Agent.pending` 各持一份，`registry_adopt` 时旧的 `-1`、新的 `+1`。空闲会话回收时若还有进行中的
`Work`（挂起状态），随 `Work` 一起释放那份引用。不写清增减方，"引用归零才释放"就是一句空话。

分配器按存活期划分，与环境上下文的分层一一对应，所以清理是整层进行的：

| 分配器 | 存活期 | 内容 | 落点 |
| --- | --- | --- | --- |
| 映射 | 一个版本 | 标签表、技能、流程、轨道、标准、实体声明的主体 | `mmap`，只读 |
| 注册表索引 | 一个版本 | `offsets`、`by_label`、位图、两张 map | `Registry.arena` |
| 常驻 | 活动代理 | 常驻层条目：身份、配置、计量、统计 | `Agent.standing.arena` |
| 会话 | 一次会话 | 行为记录、问题卡片、会话层条目 | `Session.arena` |
| 工作 | 一次工作 | 意图、已落定槽位、步骤产出、工作层条目 | `Work.arena` |
| 步骤暂存 | 一个步骤 | 提示串、原始响应、工具实参 | `Flow_Context.scratch` |

**跨步的东西必须显式落在 `Work.arena` 上。** 步骤暂存每步结束即整体释放，落错分配器的字符串会在下一步
变成悬垂指针——这是这套分层唯一的锋刃。所以控制层的过程不用 `context.allocator` 存跨步数据，一律显式
取 `Flow_Context` 上的那两个。

### 7.5 可测试性

控制层不接网络即可整体运行，这决定了测试的形状：**表驱动的纯函数测试，不起服务、不连模型、不依赖时序。**

- **纯函数表驱动单测**：语义标签解析、条件求值（每个 `subject × test` 合法组合一组用例，非法组合断言
  被拒）、`select_track`、槽位解析、预测检查三结果、模式选择、行为记录裁剪（给定记录与预算，输出必须
  逐字确定）、模板渲染、位图三种集合运算
- **载入器负面测试**：**每一种触发情形都要有一份触发它的坏数据文件**（不是每个码一份——`Bad_Jump`
  有四种情形、`Bad_Segment` 与 `Bad_Options` 各三种，见 [5.7](#57-注册表版本与刷新) 的注明），断言
  当前版本仍在服务，且 `Load_Report` 的 `file`/`path` 指到了正确位置、`detail` 说清是哪一种情形
  ——报错不说清哪一处，等于没报
- **文件格式测试**：截断、crc 破坏、段表越界、`flags` 乱序、`lens` 与 blob 不匹配、非法 UTF-8、
  程序区缺行（断言补齐而非拒绝）、程序区多行（断言拒绝）
- **工具调用校验负面测试**：越权工具、缺必填参、类型不符、标签解析不出、取值集外，各一例；断言前四种
  回校验回执并允许改正，越权那一种整次失败；断言每种都产出一条问题上报
- **工具即界面的性质要断言**：前置条件不成立的工具不出现在工具模式里（不是"调了再拒"）；非必填参数
  缺失时取到默认值；`confirm` 的接口不出现在实体的屏上，而是变成确认挂起
- **实体不派发实体**：注入的 `Entity_Caller` 记录调用栈深度，断言恒为 1
- **段与模式测试**：同一步骤池在两个模式下走出两条不同序列；小模式在大模式段内展开后回到父段；嵌套
  深度越限、成环、恒真模式后还有候选、无兜底也无 `by`，全部在载入期被拒
- **两层预加载测试**：断言三个差集各发一条事件；断言漏筛补取越限即终止
- **回环语义测试**：优化步骤因 `Step_Result` 条件不成立被 `Skip` 时其回跳边不触发；审查不通过时回跳被
  触发且轮数按 `(from, to)` 计数；回跳目标被 `Skip` 时断言回环终止且有 `Degraded` 上报
- **裁决三支测试**：`Finish` 进收尾；`Rework` 回到 `adjust_to`；`Replan` 不执行收尾、临时轨道置 `Stale`、
  工作层被清、下一轮从飞行检查重新开始
- **收尾证据测试**：三项各缺一项时收尾都不执行；`No_Review` 的流程在载入期被拒
- **留守条目测试**：跳过收尾的临时轨道置 `Stale` 而非删除；下一次收尾仍然呈上；批量上限生效且顺延；
  结构相同的两条合并计数；拒绝后不再重复呈上
- **流程与轨道执行**用返回固定产物的 `Entity_Caller` 跑，断言事件序列、步骤序列、门槛导致的简化与跳过、
  回跳轮数、裁决分支、证据不齐时不执行收尾、各项预算触发后的终止分支
- **问题上报的完整性**：每个 `Terminal` 都对应一张 `Blocking` 卡片；每次简化、跳过、改正、越限、多筛、
  漏筛都对应一条 `Degraded` 或 `Notice`；断言卡片、行为记录、日志三处同源（比对同一个下标）
- **刷新语义测试**：工作进行中 `registry_stage` 新版本，断言本次工作仍走旧版本；工作完成后断言切换；
  断言另一个空闲会话开工时也用上新版本；断言旧版本引用归零后映射被 `munmap`
- **改名不破坏引用**：改掉某个标签的语义标签，断言全部数据文件照旧载入通过，且提示与出题里显示新名字
- **备用通道测试**：非临时轨道场景发起被拒；重复提案被去重；越过日限被丢弃并上报；接受与改写后走普通
  载入路径生效
- **不确定的那一步单独度量**：golden set 由（原话 → 期望的清晰度、需求类型、意图种类与槽位）组成，
  跑真实模型统计命中率。纯代码测试用录制下来的工具调用作固件，不联网。两者分开跑：前者是模型选型与
  提示调优的指标，后者是回归门

### 7.6 文件布局

```text
bitagent/
├── main.odin                 # 入口、生命周期、装配与注入
├── server.odin               # HTTP 路由、SSE 传输
├── commands.odin             # stdin 管理指令（含 reload）
├── agent.odin                # 活动代理：版本、常驻层、会话存储、管理端事件出口
├── session.odin              # 会话：行为记录、工作、挂起点、TTL、互斥
├── entity_bridge.odin        # llm_request 的流与工具调用适配成 Entity_Caller
├── interfaces.odin           # 接口实现与登记
├── templates.odin            # 模板、视图与运行期取值集算法的实现与登记
├── lib/control/              # 决策核心，不依赖 HTTP、供应商与根包
│   ├── flag.odin             # 原子标签、两个编号区、标签表
│   ├── value.odin            # Value 联合与 Arg：跨模块的数据载体
│   ├── limits.odin           # 预算与限额常量，一处定义
│   ├── host.odin             # Host：执行一步所需的三样，由外层填充
│   ├── context.odin          # 环境上下文：层、条目、读写、视图
│   ├── act.odin              # 行为记录、问题卡片存储、提示历史裁剪
│   ├── memory.odin           # 技能、事实、标准、提示组合
│   ├── entity.odin           # 实体声明、能力白名单、调用契约
│   ├── interface.odin        # 接口声明、实参校验、运行期取值集
│   ├── condition.odin        # 封闭谓词与求值
│   ├── triage.odin           # 飞行检查：清晰度与需求类型
│   ├── intent.odin           # 意图数据、草案、解析
│   ├── track.odin            # 轨道结构
│   ├── track_runner.odin     # 轨道执行：深度、出题、挂起与续接、第一层筛选
│   ├── leftover.odin         # 临时轨道、留守条目、吸收处置
│   ├── flow.odin             # 流程、步骤、环节、模式、门槛
│   ├── work.odin             # 工作层：段栈、步骤产出、回跳轮数、证据、挂起点
│   ├── flow_runner.odin      # 流程执行：预测检查、第二层加载、模式、回跳、裁决、收尾
│   ├── registry.odin         # 载入、校验、版本、引用计数、刷新
│   ├── prompt.odin           # 提示组装与出题构造
│   ├── event.odin            # 事件与出口（Emit 过程指针，不碰 socket）
│   ├── problem.odin          # 问题卡片的结构与上报
│   └── terminal.odin         # 终止种类到问题卡片的映射
├── lib/flag/bitmap.odin      # 稀疏分块位图：标签集合的交并差
├── lib/bagfile/              # 文件信封、三种载荷的读写
├── lib/llm_request/          # LLM 客户端：流式 + 工具调用 + 可中止
├── bagtool/                  # seed / dump / check / relabel
├── data/labels.fglb          # 原子标签表：唯一事实来源
├── data/control.ctrg         # 结构注册表：标准、技能、流程、轨道、实体声明
├── data/runtime.jrnl         # 运行期日志：事实、临时轨道、标签请求
└── web/                      # 前端
```

蓝本只有两个文件，没有目录树。层级不靠目录名承载：`tier` 是记录里的一个字段，由 `bagtool` 在写入时
赋值。**用目录表达层级要靠目录纪律维持，用字段表达则是结构保证**——"层级不由文件内容声明"因此不需要
额外约定。

### 7.7 实现状态

本表记录架构各部件的落地状态。"待移植"指该部件在另一个仓库里已有可用实现，其中传输层的 SSE 直写
（`Response_Writer` 只缓冲，须直写 `res._conn.socket`）与模型侧的工具调用支持都已实测确认。

| 部件 | 状态 |
| --- | --- |
| 传输：HTTP 路由、SSE 直写 socket | 待移植 |
| `lib/llm_request`：流式客户端 | 待移植 + 扩展工具调用与回调中止 |
| 生命周期、管理指令 | 待移植 + 加 `reload` |
| 前端：流式渲染、纯文本气泡、状态灯 | 待移植（配色、`user-select`、气泡纯文本三条约束随之生效） |
| 前端：结构化选项控件 | 待建（与"气泡只渲染纯文本"不冲突：选项是控件，不是文字） |
| 前端：问题卡片（图标 + 布局） | 待建 |
| 前端：思考面板、进度面板 | 待建，接 `Reasoning` 与 `Step` |
| 前端：状态展示页 | 待建：上下文、行为记录、注册表、统计、留守条目 |
| 前端：标签表管理界面 | 待建，含改语义标签与处置标签请求 |
| `lib/flag/bitmap.odin` | 待建 |
| `lib/bagfile/` 与 `bagtool` | 待建：信封、三种载荷、四个子命令 |
| `lib/control` 全部 | 待建 |
| 活动代理、会话、行为记录 | 待建 |
| 数据文件（标签表、3 技能 4 流程、轨道） | 待建，由 `bagtool seed` 播种，本身即载入器的正面用例 |

[api.md](api.md) 随请求体、事件集合与状态接口一并撰写（尚未撰写）。

### 7.8 已知取舍

- **一次轮次占一个事件循环线程**，饱和会拖慢同 loop 的其他连接。上限与墙钟定死，根治要接管连接生命周期
- **条件是扁平 AND 的封闭谓词**，表达力有意受限：没有条件之间的 OR、没有嵌套、没有算术。需要分支就多
  登记一条流程或轨道。换来的是可校验、可枚举、无法逾越。（析取只允许出现在单个谓词**内部**且操作数
  有界——`In_Set` 与 `Subject.Mode` 的"本段栈上任一层"都是这类）
- **回跳只允许向后指**，所以流程是有界的有向图而不是任意状态机。表达不出"任意跳转"，这是有意的：
  任意跳转就不可能在载入时证明有界
- **吸收进来的东西只能补空白**，因此 BitAgent 学不会"把用户已经安排好的工作改一种做法"。改既有行为是
  用户的事
- **没有自动准入也没有自动退役**，所以每一条学到的东西都要用户点一次头。代价是用户要处理留守条目；
  收益是不会积累未经审查的豆腐渣
- **原子标签的用户区只有用户能拟定**，所以自学习无法引入新概念，只能重组已有概念。备用通道能让代理
  **请求**增改，但生效与否始终在用户手里。语义空间因此恒定可控，代价是遇到全新概念时至少多一个来回
- **程序区随代码发布**，所以新增一种复杂度等级、一个门槛结果、一类卡片字段都要改代码。这是"能力是代码"
  的必然结果，不是遗漏
- **模式选择的位置由成文期定死**，所以流程的分岔点是设计出来的，不是运行期临时冒出来的。表达不出"根据
  结果动态生成新分支"——那正是要避免的东西
- **数据文件是二进制，不能手工编辑**。可读性与可 diff 性由 `bagtool dump` 与 git textconv 提供；
  代价是没有工具链就改不了数据。这与"数据文件是机械产物"是同一个取舍的两面
- **`confirm` 在 MVP 无实例**：MVP 没有不可逆操作（`释放` 发生在用户已选"结束"之后，再问一遍是多余的
  界面噪音）。`Confirm_Point` 与确认挂起的结构在那里，由测试专用接口覆盖，等第一个真正不可逆的能力
  （写文件、发请求）进来时启用
- **BitAgent 不自己发明流程**：慢路径只生成临时轨道，不生成流程。轨道能提议"这件事按什么顺序想清楚"，
  流程要规定"这件事做到什么程度算合格"，后者是用户的判断。所以某个意图种类若压根没有流程，临时轨道
  也救不了它，只能如实告知
- **`Translate` 能力在 MVP 无实体持有**：转译两个方向都落在程序侧（查表与模板）。能力位保留，因为
  "需要组织成自然语言的产出"仍然可能需要它
- **上游取消依赖轮询式中止**：中止在下一个增量到达时生效，不是即刻切断连接。对本项目的延迟量级足够，
  但不是硬实时
- **只有一个模型可用**，四个实体共用它。身份、职责、工具集的隔离已经在结构里，按能力分派不同模型只是
  换一份声明的事，尚无从验证
- **跨会话的记忆网络不在 MVP 内**，行为记录与原子标签是它的原料
- **睡眠期／清醒期／活动期不在 MVP 内**：MVP 走"提需求 → 做工作 → 总结吸收"的线性自学习流程，
  BitAgent 人格那一层的概念一概不实现，也不为它预留结构

## 八、MVP 的具体登记

这一章是实例数据，不是架构。它的作用是**证明前七章的规则能同时被满足**：一份过不了自己校验的实例
数据，说明规则之间有隐藏冲突。所以它逐项过一遍校验，而不是"举个例子说明一下"。

两个技能、三条流程、四条轨道，其中一条轨道不导向流程。

### 8.1 登记的实体

| 实体 | 能力 | 长期工具 | 按步追加 | 产出文本 |
| --- | --- | --- | --- | --- |
| `catcher` | `Capture_Intent` | `submit_triage`、`submit_intent` | — | 否 |
| `writer` | `Write_Text` | `submit_text` | — | 是 |
| `reviewer` | `Review` | `submit_verdict` | `submit_gate` | 否 |
| `reasoner` | `Reason` | `submit_reasoning`、`begin_track`、`add_track_step`、`submit_track`、`propose_label` | `submit_gate`、`submit_mode` | 否 |

每个实体都有终结型工具，`No_Submit_Tool` 通过。`submit_gate` 与 `submit_mode` 不进长期工具集：
**按步授予**才符合"当前屏只放当前要用的控件"。

`Registry.triage_by = catcher`：判定叙述清晰度与需求类型是意图捕获的第一步。载入期校验它的能力是
`Capture_Intent`。

### 8.2 登记的工具

| 工具 | 类型 | 参数 | 取值集 | 谁能用 |
| --- | --- | --- | --- | --- |
| `submit_triage` | 终结 | `清晰度`、`需求类型`（都必填 `Flag_Value`） | 静态：四级 / 三值 | `Capture_Intent` |
| `submit_intent` | 终结 | `意图种类`（必填）、各槽位（按流程 `fields` 生成） | 动态：意图清单 + `No_Match` | `Capture_Intent` |
| `submit_text` | 终结 | `正文`（必填 `Text`） | — | `Write_Text` |
| `submit_verdict` | 终结 | `结论`（必填）、`未满足要点`（选填多值）、`备注`（选填 `Text`） | 静态 `Passed`/`Failed`；要点集动态 | `Review` |
| `submit_gate` | 终结 | `结果`（必填） | 静态：`Execute`/`Simplify`/`Skip` | `Reason` / `Review` |
| `submit_mode` | 终结 | `模式`（必填） | 动态：本步 `candidates` | `by` 指名者 |
| `submit_reasoning` | 终结 | `结论`（必填 `Text`）、`证据`（选填 `Text`） | — | `Reason` |
| `begin_track` | 查询 | `产出意图种类`（必填） | 动态：意图清单 | `Reason` |
| `add_track_step` | 查询 | `目标`（`Text`）、`落定槽位`（多值）、`准许提问`、`提问方向`、`追问上限` | 动态：该意图对应流程的 `fields` | `Reason` |
| `submit_track` | 终结 | 无 | — | `Reason` |
| `propose_label` | 查询 | `处置`、`目标`、`语义标签`、`用途` | 静态：`Add`/`Update` | `Reason` |

`释放` 不在这张表里：它不是实体工具，是程序直调的接口，见 [8.3](#83-登记的视图模板与接口)。

**临时轨道用三个工具分屏提交，不用一个塞满结构的文本参数。** 一次调用里：`begin_track` 一次、
`add_track_step` 若干次（每次一步，参数逐个校验）、`submit_track` 收尾。这既是"工具即界面"的直接
应用（多屏表单，每屏都有回执可看），也让全部校验落在**扁平参数**上——不需要解析任何格式，
`Bad_Options` 之类的错误压根不会出现在这条路上。`MAX_TOOL_CALLS_PER_CALL = 8` 因此有了真实约束：
一条临时轨道最多六步。

`propose_label` 是查询型，可以在生成临时轨道的同一次调用里穿插——"标签表达不了"正是在拟定步骤时
才发现的。请求入队，调用结束时一并写进运行期日志。

### 8.3 登记的视图、模板与接口

| 视图 | 内容 | 参数 |
| --- | --- | --- |
| `运行状态` | 常驻层的 `Metric` 条目 | 按 `查看项` 过滤 |
| `意图清单` | 已启用的流程能处理的意图种类 | 无 |
| `轨道创建指南` | 轨道结构说明、谓词合法组合、可用标签 | 无 |
| `标签表` | 全部标签与语义标签 | 无 |
| `事实快照` | 事实表 | 按 `课题` 过滤 |
| `留守清单` | 未处理的临时轨道，按意图种类聚组、结构相同的已合并 | 无 |

| 模板 | 用途 | 期望的 `args` |
| --- | --- | --- |
| `运行状态回复` | `query_status` 的交付 | `快照`、`查看项` |
| `能力回复` | `query_capability` 的交付 | `意图清单` |
| `闲聊回话` | 不导向流程时的回话提示 | `原话` |
| `槽位问句` | 全封闭槽位的出题 | 缺失槽位清单 |
| `裁决问句` | 报告环节的出题 | `稿件` 摘要 |
| `留守问句` | 收尾环节的留守条目盘点 | `留守清单`（由 `读留守` 步骤先写进上下文） |
| `预判` | 预备环节让实体预测结果与应对 | `题目`、`事实快照` |
| `通用初稿` | `速写` 的撰写提示 | `题目` |
| `说明文` | `说明` 段的撰写提示 | `题目`、`事实快照` |
| `叙述文` | `叙述` 段的撰写提示 | `题目`、`事实快照` |
| `审查` | `自查` 的提示 | `稿件`、`题目` |
| `改写` | `改写` 的提示 | `稿件`、`自查` |
| `交付` | `draft_text` 的交付渲染 | `稿件` |

| 接口 | `direct` | `kind` | `confirm` | 参数 | `require` |
| --- | --- | --- | --- | --- | --- |
| `释放` | 真 | —（程序直调时无意义） | 假 | `工作` | 空集（恒真） |

`释放` 是 MVP 唯一的接口，也是唯一的 `Call_Interface` 步骤：它处理工作层状态的生命周期（清理已交付的
稿件、把统计计入常驻层）。`confirm` 为假，因为它发生在用户已选"结束"之后——再问一遍是多余的界面噪音。

### 8.4 技能与流程

| 技能 | 流程 | 槽位 | 复杂度来源 | 流程内部实体调用 |
| --- | --- | --- | --- | --- |
| `self_report` | `query_status` | `查看项`（封闭五项） | 固定 `琐碎` | 0 |
| `self_report` | `query_capability` | 无 | 固定 `琐碎` | 0 |
| `compose` | `draft_text` | `题目`（自由）、`工作量`（封闭五级） | 槽位 `工作量` | 速写 1；正式 4+n |

一个技能含多条流程，正是"技能只指向一个课题、按工作类别分流程"的落点：`self_report` 这个课题下，
查状态与查能力是两类工作。

正式路径的四次固定调用是 `预判`、`选体裁`、撰写、`自查`；`n` 是审查回环里 `改写` + 再次 `自查` 的轮数
（≤ `MAX_REFINE_ROUNDS`）。`锚定事实` 与 `自查` 的 `On_Below` 保底各可能再加一次，那是条件性的，
不算进固定数。

**"零实体调用的流程"这个说法只对流程内部成立。** 每一轮都有一次飞行检查，加上轨道里落定意图种类与
槽位的解析步骤，所以上表那一列只算**流程内部**。`query_status` 一轮的实际总数是飞行检查 1 次 +
轨道解析 1 次 = 2 次，流程内部 0 次。行为哲学的证据因此要写成一句更准确的话：
**判断与选择全在程序侧，实体只出现在自然语言的两个端点上**——把话译成数据，把数据译成话。

`draft_text` 的步骤池（环节是标记，一步可带多个）：

| 步骤 | 环节 | `require` | 门槛 | 保底 | 动作 | 产物落点 |
| --- | --- | --- | --- | --- | --- | --- |
| `选深浅` | 预备 | — | 琐碎 | 无 | `Select_Mode`（速写 / 正式） | — |
| `锚定事实` | 预备 | — | 复杂 | `On_Below`，`by = reviewer` | `Read_View` 事实快照，按 `题目` 过滤 | `事实快照` |
| `预判` | 预备 | — | 琐碎 | 无 | `Ask_Entity` reasoner，`预判` 模板，不外送 | `预判` |
| `记预判` | 预备 | — | 琐碎 | 无 | `Record_Fact` 从 `预判`，`Entity_Concluded` | 运行期日志 + 上下文 |
| `选体裁` | 预备 | — | 琐碎 | 无 | `Select_Mode`（说明 / 叙述），`by = reasoner` | — |
| `写初稿` | 工作 | — | 琐碎 | 无 | `Ask_Entity` writer，`通用初稿`，`emit = Content` | `稿件` |
| `写说明文` | 工作 | — | 琐碎 | 无 | `Ask_Entity` writer，`说明文`，`emit = Content` | `稿件` |
| `写叙述文` | 工作 | — | 琐碎 | 无 | `Ask_Entity` writer，`叙述文`，`emit = Content` | `稿件` |
| `自查` | 工作·审查 | — | 复杂 | `On_Below`，`by = reviewer` | `Ask_Entity` reviewer，读 `稿件` 与 `返工请求`，不外送 | 步骤产出（`Verdict`） |
| `改写` | 优化 | `Step_Result(自查) == Failed` | 普通 | 无 | `Ask_Entity` writer，读 `稿件` 与 `自查` | `稿件`（覆盖） |
| `交付初稿` | 报告 | — | 琐碎 | 无 | `Render` 读 `稿件`，`emit = Report`，`awaits_user`，`adjust_to = 写初稿` | — |
| `交付定稿` | 报告 | — | 琐碎 | 无 | `Render` 读 `稿件`，`emit = Report`，`awaits_user`，`adjust_to = 自查` | — |
| `读留守` | 收尾 | `Evidence` 三项 | 琐碎 | 无 | `Read_View` `留守清单` | `留守清单` |
| `问留守` | 收尾 | — | 琐碎 | 无 | `Render` `留守问句` 读 `留守清单`，`emit = Report`，`awaits_user` | — |
| `释放` | 收尾 | `Evidence` 三项 | 琐碎 | 无 | `Call_Interface` `释放` | — |

段的结构（模式改的是这个，不是步骤本身）：

| 段 | 序列 | 回跳边 |
| --- | --- | --- |
| 顶层 | `选深浅` | 无 |
| 模式 `速写` | `写初稿` → `交付初稿` | `交付初稿` → `写初稿`（≤3） |
| 模式 `正式` | `锚定事实` → `预判` → `记预判` → `选体裁` → `自查` → `改写` → `交付定稿` → `读留守` → `问留守` → `释放` | `改写` → `自查`、`交付定稿` → `自查`（各 ≤3） |
| 模式 `说明` | `写说明文` | 无 |
| 模式 `叙述` | `写叙述文` | 无 |

**交付步骤分成两个，不是一个复用两次。** `adjust_to` 是步骤级字段，只能指一个目标；而"返工"在速写段
要回到 `写初稿`、在正式段要回到 `自查`。同一个步骤在两段里需要不同的回跳目标，那它本来就是两个步骤
——硬要复用就得让 `adjust_to` 变成"按段查表"，那是把段的结构挪进步骤里。

**正式段的返工回到 `自查` 而不是 `改写`。** 回到 `改写` 是一个死循环般的空转：能走到交付的前提就是
末次 `自查` 通过，而 `改写.require` 要求 `自查` 判 `Failed`，所以返工过去必被 `Skip`，紧接着又是交付，
稿件一字未改却耗掉一轮。回到 `自查` 才有意义——重新审一遍，判 `Failed` 就顺势执行 `改写`。
为了让第二次审查不是原地重复，执行器在 `Rework` 时把用户的返工请求（可选附一句文本）作为
`返工请求` 条目写进工作层，`自查` 的提示模板绑定它。

三个撰写步骤都写同一个上下文键 `稿件`，`自查`／`改写`／两个交付步骤都按
`Arg_Binding{from = .Context, ref = 稿件}` 读它。**这样下游步骤不必知道上游是哪一个模式选出来的**
——否则交付得写成"如果走的是说明段就读 `写说明文` 的产出，否则读 `写叙述文` 的"，那正是模式该消除的
分支。`改写` 覆盖同一个键，于是"最新稿件"只有一个位置，不存在版本歧义。

**留守条目盘点是两步，不是一步。** `Render` 的实参只能取自槽位、上下文、字面量与步骤产出，而留守清单
住在运行期日志里——所以先由 `读留守` 用 `Read_View` 把它渲染进上下文，`问留守` 再绑定那个键。
一步做完会撞上 `Bad_Binding`：那个实参没有合法来源。

两个模式选择的位置都是成文期写死的，写法正好是模式选择的两种形态：

- `选深浅`：候选 `速写` 带条件（**复杂度** `At_Most 简单`），候选 `正式` 是 `Some([])` 兜底。
  程序按条件定，**一个实体也不问**。这里的主语是 `Complexity` 而不是 `Slot`——`At_Most` 只允许配
  复杂度与清晰度，而 `cplx` 已经指名 `工作量` 槽位，复杂度就是该槽位的值，语义等价且合法
- `选体裁`：`说明` 与 `叙述` 都**不声明**条件（字段缺席），`by = reasoner`。程序没有判断依据
  ——用户没说要说明文还是叙述文，槽位里也没有这一项——所以交实体挑。这里若写成空集，`说明` 就恒真
  且 `叙述` 永远选不上，载入期报 `Unreachable_Mode`

`选体裁` 的 `by` 用 `reasoner` 而非 `writer`：判断"这个题目该写成说明文还是叙述文"是逻辑推理，不是
撰写。**能力白名单不允许 `writer` 做推理**——一个实体只干它那一条职责。

逐项过校验：

| 校验 | 结果 |
| --- | --- |
| 顶层段首步是 `Select_Mode` | ✓ `选深浅` |
| 每段序列是步骤池子集、无重复；每步至少属于一个段 | ✓ 十五步全部落在五个段里 |
| 回跳只指向更早的步骤、`max_loops ≤ 3` | ✓ `改写` 与 `交付定稿` 都在 `自查` 之后 |
| 回跳目标的 `require` 不引用起点的产出 | ✓ `自查` 与 `写初稿` 的 `require` 都是空集 |
| 每个 `Refine` 步骤有回跳边指向本段 `Review` 步骤 | ✓ `改写` → `自查` |
| 带 `Review` 标记的步骤是 `Ask_Entity` 且实体能力为 `Review` | ✓ `自查` 用 `reviewer` |
| 有 `Teardown` 的路径必须有 `Review` 步骤 | ✓ 正式段有 `自查`；速写段无 `Teardown`，本条不适用 |
| 有 `Teardown` 的路径必须有 `awaits_user` 报告步骤 | ✓ `交付定稿` |
| 每条展开路径至少一个带 `Report` 的 `Render` | ✓ 两个交付步骤各覆盖一条路径 |
| `adjust_to` 非空则指向本段内更早的步骤 | ✓ 速写 → `写初稿`；正式 → `自查` |
| 撰写类步骤声明 `into` | ✓ 三个撰写步骤与 `改写` 都落 `稿件` |
| `On_Below` 的门槛严格高于所在路径的复杂度下界 | ✓ 正式段可达区间是 `普通..繁重`，两处门槛都是 `复杂` |
| `cplx` 指名的槽位在 `fields` 内且取值集是五级子集 | ✓ `工作量` |
| 候选模式在模式池内；恒真模式之后无候选；有兜底或 `by` | ✓ 两处模式选择各占一种形态 |
| 模式嵌套不成环、深度 ≤ 3 | ✓ 顶层 → 正式 → 说明，深度 3 |
| `Arg_Binding` 按展开路径可达 | ✓ `自查` 读的 `稿件` 由子段的撰写步骤写入；`问留守` 读的清单由 `读留守` 写入 |
| 小模式的两段真的不同 | ✓ `说明` 与 `叙述` 各指名一个用不同模板的步骤 |

**`速写` 是"无收尾流程"的合法形态**：它交付即止，工作层的状态生命周期由工作结束时的整层清理承担，
不需要专门的收尾步骤。代价是这条路径不盘点留守条目——那些条目留着，等下一次走正式路径的工作，
或者用户直接在留守条目页处理。`MAX_TEMP_TRACKS` 满时拒绝新生成的那条 `Blocking` 卡片，就是提醒。

### 8.5 登记的轨道

三条，按选轨顺序（`priority` 由程序取 `len(conditions)`，越具体越先试）：

| 轨道 | 条件 | `yields` | 步骤 | 回话 |
| --- | --- | --- | --- | --- |
| `任务轨道` | `需求类型 == 任务` 且 `清晰度 At_Least 轻度欠定` | `撰写文本`、`查询运行状态` | 3 步：落定 `意图种类`；`意图种类 == 撰写文本` 时落定 `题目` 与 `工作量`；`== 查询运行状态` 时落定 `查看项` | — |
| `讨论轨道` | `需求类型 == 讨论` | `查询能力` | 1 步：落定 `意图种类` | — |
| `闲聊轨道` | `需求类型 == 闲聊` | 空集 | 0 步 | `writer` + `闲聊回话` |

**一条任务轨道导向两个意图种类**，而不是两条条件相同的轨道各导向一个。后一种写法有静默故障：
两条轨道的条件完全一样（都是"任务 + 某个清晰度"），`priority` 也一样，于是同优先级按 id 升序，
**排在前面的那条会把后面那条永久遮住**——"帮我看看运行状态"会被送进撰写流程。轨道是按"怎么解析"
分的，不是按"解析出什么"分的；解析出什么是它的产物，所以意图种类是它落定的第一个槽位。

`清晰度 At_Least 轻度欠定` 取的集合是 {轻度欠定, 清晰}——因为 `Clarity` 的序是**越大越清晰**
（见 [4.1](#41-原子标签)）。**模糊与重度欠定不进任务轨道**，它们落到"没有轨道命中"→ 生成临时轨道，
而临时轨道的第一步通常就是反问。这是清晰度四级行为差异在数据里的落点——不是在执行器里写
`if clarity == Vague`。

三条都有非空条件，`No_Conditions` 通过。前两条 `yields` 里的每个种类都有对应流程，`No_Flow` 通过；
每条流程的必填字段都被某一步覆盖（`query_capability` 无字段，故落定意图种类那一步就够），
`Slot_Uncovered` 通过。`闲聊轨道` 的 `yields` 为空且声明了 `reply_by`/`reply_tmpl`，`Bad_Reply` 通过；
它全部步骤都不提问，所以 `by_asker`/`by_judge` 为空也合法。

条件只用 `Clarity`、`Demand` 两种主语（`Fact` 在 MVP 无实例），符合 [4.5](#45-条件封闭谓词) 的位置
限制。**没有一条轨道去看用户原话**——这是 `Contains_Any` 被删掉之后的样子：分支依据是飞行检查译出来的
两个标签，而不是词。

### 8.6 一次真实轮次的走查

用户说"帮我写一段关于原子标签的介绍，不用太正式"。

| # | 发生了什么 | 事件 | 行为记录 |
| --: | --- | --- | --- |
| 1 | 传输层校验长度与格式，取会话 | `Session` | — |
| 2 | 飞行检查：`catcher` 调 `submit_triage`，提交 `清晰度 = 轻度欠定`、`需求类型 = 任务` | — | `Llm_Triaged` |
| 3 | 选轨：`任务轨道` 条件成立（任务；轻度欠定 ≥ 轻度欠定），命中 | `Step` | `Agent_Selected` |
| 4 | 第一层筛选：轨道的 `tags` 给出 `compose` 与 `self_report` 两个技能的候选标签 | — | `Agent_Preloaded` |
| 5 | 轨道第 1 步：`catcher` 调 `submit_intent`，在 `yields` 两项 + `No_Match` 里选中 `撰写文本`。该步的 `tags` 追加撰写类标准，`self_report` 的候选随后落进"多筛"差集 | `Step` | `Agent_Resolved` |
| 6 | 轨道第 2 步（`condition` 为 `意图种类 == 撰写文本`）：解析出 `题目 = "原子标签的介绍"` | `Step` | `Agent_Resolved` |
| 7 | 同一步的 `工作量` 未在原话中明说。清晰度是 `轻度欠定` → **不出题**，取 `Field_Spec.default = 简单`，发 `Notice` | `Problem`(Notice) | `Agent_Resolved` |
| 8 | 意图种类 `撰写文本` 查表得到 `draft_text`，开工作 | — | — |
| 9 | 预测检查：`cplx` 指名 `工作量` → 复杂度 `简单`。第二层加载：`prepared &~ needed` 非空（`self_report` 那一份没用上），发一条事件说明多筛了什么 | `Step` | `Agent_Predicted`、`Agent_Preloaded` |
| 10 | `选深浅`：候选 `速写` 的条件 `复杂度 At_Most 简单` 成立 → 展开 `速写` 段。**零实体调用** | `Step` | `Agent_Selected` |
| 11 | `写初稿`：`writer` 流式写出，`emit = Content`；按 `submit_text` 收尾，定稿落进 `稿件` | `Content`×N | `Llm_Answered` |
| 12 | `交付初稿`：渲染 `稿件`，`emit = Report`，`awaits_user` → 记录报告挂起，本轮结束 | `Report`、`Done` | — |

一轮共**三次**实体调用：飞行检查、落定意图种类、撰写。零次判断类调用（选轨、选模式、门槛都是程序算的）。
用户此时看到的是：正文气泡、一条"我按'简单'处理了工作量"的通知、一条"多筛了 `self_report` 相关标准"的
通知、一组三个裁决按钮、进度面板上"速写 / 写初稿 → 交付初稿"两层。

若用户点**返工**：沿 `adjust_to` 回到 `写初稿`，`Work.rounds[交付初稿] += 1`，重过 `Gate`
（门槛 `琐碎`，判 `Execute`），带上 `返工请求` 条目再写一遍。若点**重新规划**：不执行收尾
（速写段本来也没有），临时轨道若有则置 `Stale`，工作层整层清理，下一轮从飞行检查重新开始。
若点**结束**：`user_approved = true`，但速写段没有 `Teardown` 步骤，工作直接结束。

最后这一支的判定容易误读：此时 `steps_completed` 与 `user_approved` 都真而 `review_passed` 为假，
**而收尾不受影响，因为这条路径上压根没有收尾步骤**。三项证据只在收尾步骤的 `require` 里被读；
没有收尾步骤，就没有读者。反过来，如果作者给速写段加了收尾步骤而不加审查步骤，收尾就会永远执行不了
——`No_Review` 那条校验就是为此存在的，载入期直接拒绝这种流程。



