---
description: "面向模型的原理图工具：schematic_generate 先经接缝门禁校验 IR 文档再输出文档源；schematic_validate 只跑门禁。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-eda-sch-gen

[English](README.md) | 中文

## 概述

`dsh-plugin-eda-sch-gen` 注册 `schematic_generate` 与 `schematic_validate` 两个工具，供模型产出原理图文档源或在定稿前检查原理图 IR 文档。与 `dsh-plugin-eda-sch` 和至少一个引擎插件（如 `dsh-plugin-eda-easyeda`）一同加载；生成需要可用引擎，校验只需接缝本身。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

```yaml
- name: '@deepseek-ai/dsh-plugin-eda-sch'
- name: '@deepseek-ai/dsh-plugin-eda-easyeda'
- name: '@deepseek-ai/dsh-plugin-eda-sch-gen'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxPrimitives` | `5000` | 整个 IR 文档内 id 图元的上限 |
| `maxSheets` | `32` | IR 文档内图纸页数的上限 |
| `maxSourceChars` | `1000000` | 单次结果返回的文档源字符数上限 |

### schematic_generate

接收 `document`（JSON 形式的原理图 IR），先解析、执行页数/图元数上限，再运行 `resolveBindings`——在工作区库可达时把 `lcsc` 声明解析为真实库绑定，然后运行确定性布局阶段为文档中未定位的几何完成放置与布线，再基于已布局 IR 与预取快照跑接缝的静态门禁；仅在无 error 级发现时经解析出的引擎序列化绑定后的 IR，返回 `{ ok, format, source, sourceBytes, findings }`。被门禁拦下的调用返回 `ok: false` 与全部发现，模型可据此修复重试。`document` 传成 JSON 编码字符串时仍会解析并标记 `SCHEMATIC_IR_STRING_ENCODED`；无法解析的文档返回 `ok: false` 及指明失败路径与实收值的 `SCHEMATIC_IR_INVALID` 发现。几何字段（`position`、引脚 `endpoint`、导线 `dots`）可省略：`pin.net` 是连通性声明，其余由布局阶段推导。传 `verify: true` 可再经引擎实机路径交付并 diff 客户端读回的网络表：实机发现并入 `findings`，error 级实机发现使 `ok` 变为 `false` 但 `source` 照常返回；客户端不可达或引擎无实机验证路径时降级为 `SCHEMATIC_VERIFY_UNAVAILABLE` 警告。超过 `maxSourceChars` 的产出的源文本将从结果中省略（`source: ''`，`sourceBytes` 报出完整长度）：`verify: true` 下实机交付已完成，通知降级为 `SCHEMATIC_SOURCE_TOO_LARGE` 警告；否则为 error 级并建议改用 `verify: true` 或缩小文档。

### schematic_validate

执行同样的解析、上限、绑定解析、布局与门禁但不产出任何内容，返回 `{ ok, findings }`。同样的字符串编码 `document` 容忍与解析失败发现规则适用。用于生成前检查或修复循环后的复检。传 `verify: true` 可在静态门禁通过后跑同样的实机读回 diff。

<a id="understand-the-implementation"></a>
## 理解实现

两个工具在门禁之前把参数形状错误报为 `ok: false` 的 `SCHEMATIC_IR_INVALID` 发现（经 `parseSchematicIr`），超限文档仍以 `SCHEMATIC_IR_BOUNDS` 抛出。引擎解析失败原样透出接缝的 `SCHEMATIC_ENGINE_*` 错误码，模型看到的词汇与服务一致。呈现为通用卡片；面向模型的正文是渲染后的发现列表。

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到的内容

任一原理图工具在 scope 中可见时，渲染 `tool:schematic` 区段（顺序 `TOOL_SCHEMATIC`，2500）：

##### 原理图工具指引

```markdown
When the user asks to produce, emit, or check schematic primitives from a schematic IR document, call `schematic_generate` (validate-then-emit) or `schematic_validate` (validate only). Declare connectivity through pin.net names — the layout stage places and routes deterministically in 0.01-inch coordinates, so geometry fields may be omitted; every wire must declare its net name and every pin must carry NAME/NUMBER attributes. Pass verify: true to run the live-client netlist read-back when one is reachable. If either tool reports findings, repair the document and retry.
```

#### Token 影响

任一工具注册期间为固定段落开销；隐藏两个工具的 scope 限制会移除该区段。

#### KV Cache 影响

工具可见性与指引文本不变时前缀保持稳定；会话中途挂载或移除本插件会从该区段起使复用失效。

### 工具 schema

#### 模型看到的内容

模型会看到生成的 [`schematic_generate` 与 `schematic_validate` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-plugin-eda-sch-gen)。图纸页数与图元数上限属于部署设置，不是模型参数。

#### Token 影响

两个工具注册期间每次请求为固定 schema token 开销；配置禁用或 scope 限制会移除 schema 及其指引。

#### KV Cache 影响

定义与可见性不变时前缀保持稳定；插件生命周期或 scope 限制变化可能使从第一个变化的 schema token 起的复用失效。

### 门禁发现

#### 模型看到的内容

被拦下的调用渲染 `Static validation failed; repair the document and retry:`，随后每条发现一行 `[<severity> <CODE>] at <locator> <message> (<suggestion>)`。通过的 `schematic_validate` 渲染 `Schematic IR is valid.`；通过的 `schematic_generate` 渲染 `Emitted <format> document source (<n> chars).` 实机验证发现并入同一列表；引擎不可达时以 `SCHEMATIC_VERIFY_UNAVAILABLE` 警告报告而非使调用失败。

#### Token 影响

发现数量取决于数据，压缩前会重复发送；`maxPrimitives` 约束文档大小，也就约束了发现列表长度。

#### KV Cache 影响

仅追加；每条新发现行位于可复用请求前缀之后，不使已有条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了工具自身不完整之处，均为当前包约束。

- **实机验证需要可达客户端** —— `verify: true` 只有在引擎暴露实机验证路径且客户端正在运行时才会经实机路径交付并 diff 读回网络表（当前为 `dsh-plugin-eda-easyeda` 加运行中的嘉立创EDA 客户端）；不满足时工具报告 `SCHEMATIC_VERIFY_UNAVAILABLE`，结果仅由静态门禁支撑。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与未定方向，不具权威性——已交付行为、限制与理由以上文各节为准。

#### 未来：就地修复闭环

把门禁发现在单次调用内回喂给模型的 verify-repair 闭环已推迟；当前由模型跨多次调用自行驱动修复。

</details>
