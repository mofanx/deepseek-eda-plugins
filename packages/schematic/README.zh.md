---
description: "原理图接缝服务（ctx.schematic）：类型化原理图 IR、顺序无关的引擎注册中心，以及每个引擎共用的权威静态校验器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-eda-sch

[English](README.md) | 中文

## 概述

`dsh-plugin-eda-sch` 把原理图设计表示为类型化中间表示（IR），并在任何文档源产出前运行确定性的交付门禁。它按调用解析一个已注册的序列化引擎，并向调用方提供一致的校验发现词汇。当插件或工具需要产出/检查原理图内容时选择它；随附的 `dsh-plugin-eda-sch-gen` 工具会自动加载它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

需要原理图生成的组合加载 `dsh-plugin-eda-sch` 服务和至少一个引擎插件；调用方随后把类型化 IR 交给 `ctx.schematic.validate()`，并用 `ctx.schematic.engine()` 取得解析后的引擎。服务在调用时解析引擎，因此除非显式配置，调用方不会看到引擎 id。

### 最小配置

加载服务并让唯一可用的已挂载引擎自动选中，或用 `engine` 钉住引擎 id。`$DSH_SCHEMATIC_ENGINE` 喂给同一字段，不是独立的优先级链。

```yaml
- name: '@deepseek-ai/dsh-plugin-eda-sch'
- name: '@deepseek-ai/dsh-plugin-eda-easyeda'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `engine` | （未设置） | 钉住的引擎 id；未设置时在恰有一个可用引擎时自动选中 |
| `layout` | `auto` | `auto` 运行确定性布局阶段；`off` 使 `layout()` 成为直通 |
| `requireLibrary` | `false` | 没有已注册库应答时把 `BINDING_UNRESOLVED` 升级为 error；`false` 保持"库不可达即 warning"的降级 |

### 确定性布局

`layout(ir, options)` 补齐逻辑文档缺失的几何。当图纸页声明了功能模块（页级 `blocks` 加器件级 `block`），器件按模块聚集，模块单元格按确定顺序逐行打包进网格——已声明模块按声明顺序、未声明名称按字母序、未分组成员最后，每行 `moduleColumns` 个单元格。每个模块内部沿用与平铺图纸相同的信号流列（驱动在左、负载在右；`netflag`/`netport`/`nonelec` 符号堆叠在注释边距区），按引脚电气侧生成引脚端点，并在正交主干导线与网络旗标之间选择布线策略——电源网向上挂旗标、地网向下挂、高扇出/跨页/跨模块网络用旗标或网络端口而非长导线。无模块归属的图纸退化为单个分组，即模块化之前的平铺布局。显式几何（位置、引脚端点、导线折线）原样通过，因此该阶段幂等，且在几何存在之前 `pin.net` 一直是连通性声明。`layoutSchematic` 是同一阶段的纯函数形式；`SchematicLayoutOptions` 调节栅格、边距、列距、引脚距/桩长、旗标扇出阈值与模块网格列数。器件轮廓按声明引脚数定尺寸——EasyEDA 库 API 不暴露符号几何，已解析器件沿用同一定尺寸规则。

### 校验与产出

`validate(ir, options)` 对类型化 IR 文档运行静态门禁，返回 `{ ok, findings }`；存在任何 `error` 级发现时 `ok` 为 false。每条发现带稳定的 `code`、`severity`、`locator` 与可操作的 `suggestion`。`options.libraryResolver` 为绑定族规则提供工作区库查询；`options.requireLibrary` 按调用覆盖已配置的门禁；`options.disabledRules` 按 code 抑制规则。`engine()` 解析出所选引擎，其 `serialize(ir)` 把 IR 投影为文档源。

`await resolveBindings(ir)` 是校验前的异步步骤：经已注册库把可解析的 `lcsc` 声明填成真实 UUID 绑定（已声明 UUID 永远优先），并把每个已声明 UUID 预取为校验器消费的同步 `libraryResolver` 快照。返回 `{ ir, libraryResolver }`；没有任何库应答时解析器为 `undefined`——那是"库不可达"降级而非确定未命中。序列化应使用返回的 IR——它携带了解析出的绑定。

### 引擎与库注册

引擎插件调用 `ctx.schematic.registerEngine(engine)`。重复 id 会以 `SCHEMATIC_DUPLICATE_ENGINE` 拒绝；返回的 disposer 随贡献 fiber 卸载。引擎解析从不依赖注册顺序：配置的 id 必须已注册且 `available()` 为真，否则恰有一个可用引擎时才自动选中。失败抛出 `SchematicError`，code 为 `SCHEMATIC_ENGINE_CONFIGURED_MISSING`、`SCHEMATIC_ENGINE_CONFIGURED_UNAVAILABLE`、`SCHEMATIC_ENGINE_AMBIGUOUS` 或 `SCHEMATIC_ENGINE_UNAVAILABLE`。

工作区库提供方调用 `ctx.schematic.registerLibrary(library)`——重复 id 抛 `SCHEMATIC_DUPLICATE_LIBRARY`，同样的 effect/disposer 契约。`resolveBindings` 按注册顺序查询库并取首个应答（未抛错）结果；抛错的库对该次查询视为不可达而非确定未命中，运行中的查询失败经 `SCHEMATIC_LOOKUP_FAILED` 哨兵体现为"无法核实"的 warning。

<a id="understand-the-implementation"></a>
## 理解实现

### IR

`SchematicIr` 持有按序的图纸页，每页含器件、引脚、导线、总线接入点、连接点与通用属性。坐标为 `0.01 inch` 图纸单位——绝不接受 mil 或毫米值。图纸页可携带 `name`（序列化器写入页面标题记录，缺省回退 `P<n>`）与 `blocks` 列表——按显示顺序声明功能模块 `{ name, title? }`；器件的可选 `block` 把它绑定到一个模块名供布局聚集。`kind: 'block'` 器件是层级元素：`sheetIndex` 指明它展开到的子图纸索引，缺省时校验器用其 `designator`、`netName` 或 `id` 唯一匹配其他图纸的 `name`；块引脚的 `net` 名即接口，子页须以同名 `netport` 回应，跨页网络经 `netport` 布线。器件以 `kind` 判别（`part`、`block`、`netflag`、`netport`、`sheet`、`nonelec`、`short`），可携带 `deviceUuid`/`symbolUuid`/`footprintUuid` 绑定、可由库解析为这些绑定的 `lcsc` 料号、以及 `designator`，引脚端点使用图纸坐标，因此校验器无需反推布局。几何字段（`position`、引脚 `endpoint`、导线 `dots`、连接点 `point`）在输入上可选——逻辑文档经 `pin.net` 声明连通性，由布局阶段推导几何；完成布局的 IR 无需 `net` 即可保持连通。

### 门禁

`validateSchematic` 用并查集在引脚端点、导线折线、T 型搭接、具名 netflag/netport 与短接符号上计算连通性，然后应用四族规则：引脚连通（悬空引脚、交叉歧义、同网异名）、电气健全性（多驱动、纯输入网、电源短路）、器件/符号/封装绑定（位号、库解析、引脚焊盘匹配、多部件一致性、BOM/PCB 意向），以及网络命名与格式不变量（网名语法、总线展开、id、groupId、孤儿属性）。层次规则族守卫 block 与子页绑定：`HIERARCHY_BAD_SHEET_INDEX`、`HIERARCHY_UNRESOLVED_BLOCK`、`HIERARCHY_AMBIGUOUS_BLOCK`、`HIERARCHY_CYCLE` 为 error；`HIERARCHY_INTERFACE_MISMATCH`（块引脚网在子页无同名 `netport`，或子页端口无块引脚响应）与 `HIERARCHY_INDEX_ON_NON_BLOCK` 为 warning。四族之外还有一条建议级规则：`SCHEMATIC_LAYOUT_MONOLITHIC` 在图纸页放置超过 `monolithicThreshold`（默认 20）个 `part` 且零模块归属时给出 warning，引导产出方声明 `blocks` 或拆分页面。`parseSchematicIr` 是模型/JSON 边界，把原始 `document` 参数转为类型化 IR，失败抛 `SCHEMATIC_IR_INVALID`。门禁与布局都接受 `pageSize` 页框（默认 `SCHEMATIC_PAGE_A4`，0.01 inch 单位 1170×825）：A4 是唯一经实机验证的规格——EasyEDA API 不提供切换图纸页图幅的入口（只能编辑器界面手改），因此自定义 `pageSize` 只在虚拟边界内规划几何，交付到客户端的图纸页仍是其默认图幅。

<a id="model-experience"></a>
## 模型体验

间接地，经 `dsh-plugin-eda-sch-gen` 触达模型：它把门禁发现与产出源渲染给模型，本服务不贡献任何提示词或 schema。

#### KV Cache 影响

无直接失效；请求前缀的变化由工具包承担。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了本服务自身不完整之处，均为当前包约束。

- **无层次展开** —— `block` 器件为校验、布局与命名绑定子图纸，但没有任何环节把块展开为其子页的图元；需要平铺视图的消费方自行组合各页。
- **模块分区框不绘制** —— `blocks` 只影响放置、旗标布线与页面标题记录；可见的分区框与标题标签推迟到拥有绘图图元的序列化器。
- **无在线 EDA 回读** —— 门禁刻意保持进程内、无密钥；引擎专属的回读校验（例如 EasyEDA 客户端自身的导入检查）属于引擎包。
- **焊盘清单取决于库** —— `PIN_PAD_MISMATCH` 仅在解析出的封装携带 `pads` 清单时运行；EasyEDA BETA 封装 API 不暴露焊盘，因此 EasyEDA 解析的封装只验证存在性。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与未定方向，不具权威性——已交付行为、限制与理由以上文各节为准。

#### 开放：由引擎供给校验选项

`resolveBindings` 提供绑定族所需的预取快照，`dsh-plugin-eda-sch-gen` 已在门禁前运行它。不经异步步骤直接校验的消费方看到的是"库不可达"降级（或 `requireLibrary` 门禁）而非已核实的绑定。

</details>
