# Agent Note: 原理图生成的质量门控与校验-修复闭环

Status: proposed

[English](2026-10-10-schematic-generation-quality-assurance.md) | 中文

## 问题

模型生成的嘉立创EDA（EasyEDA）原理图会以调用方在导入前完全不可见的方式失败：文档可能结构合法但电气错误——悬空的 INPUT 引脚、因网络名差一个字符而被拆开的网络、引脚号在封装中无对应焊盘的符号。V3 源码格式还带来自身的静默失败模式：缺少 `NET` 属性的 `WIRE`、缺少 `NAME` 或 `NUMBER` 的 `PIN`、`parentId` 无法解析的 `ATTR`，以及由端点精确重合决定的连接关系——文本生成经常在这里出错。如果生成与交付之间没有校验层，这些缺陷全都会以"导入损坏"或"电路错误"的形式到达用户，而模型拿不到任何可操作的信息。为原理图生成设计的能力 seam（Service Definition 注册中心、引擎 provider、模型工具）需要同时给出质量方案，而不是事后补挂。

## 提案

校验面向一个类型化中间表示（IR）——元件、引脚、网络、导线、布局——绝不面向已发出的文本。生成器构建 IR；序列化器把 IR 投影为 SCH_PAGE 文档源码；校验器在序列化之前消费 IR。这使检查落在模型思考的层级（网络与引脚）上，并让序列化器保持为纯投影。

三个层次，各自有不同权威：

1. **静态校验器（权威门控）。** 对 IR 运行的确定性规则，进程内、无需 API key。error 级发现阻止交付；warning 级上报。归属 Service Definition 包，使每个 provider 引擎继承同一份契约。
2. **校验-修复闭环（模型可见）。** 发现以结构化工具结果返回——code、severity、message、locator（位号、引脚、网络）、修复建议——模型据此修补 IR 并重新校验。guard 限制修复轮次；每次校验往返都是一个 session event，符合 [testing policy](../../../../docs/testing.zh.md) 的 model-visible ⟺ logged 规则。
3. **客户端预言机（仅参考）。** 在有 EasyEDA bridge 可用时，把生成的源码导入一个临时文档，运行 `eda.sch_Drc.check(strict, false, true)` 获取客户端自己的 ERC 详情，并将 `eda.sch_ManufactureData.getNetlistFile()` 的输出与 IR 网表做 diff。`SCH_Drc` 文档标注为 BETA 且明确禁止生产使用，因此它只用于补充发现和 e2e 证据，绝不作为交付门控。

## 生成物校验规则

IR 上的四个规则族；每个发现携带稳定的 code 和一个模型可路由回去的 locator。

### 引脚连通性

- 用并查集构建网络图：引脚端点、共享端点的导线段、显式 junction、NetFlag 符号（按名字全局合并）、NetPort 符号（按名字跨页合并）、Short 符号（将其两个引脚所在网络做电气合并）。引脚端点位置由符号模板引脚位置经元件变换得出：绕原点旋转、置位时绕 Y 轴镜像、平移到布局位置。
- `FLOATING_INPUT_PIN`（error）：`electric = INPUT` 的引脚不在任何网络上。
- `FLOATING_PIN`（warning）：未连接的 OUTPUT、BI 或 UNKNOWN 引脚；模型把该引脚标记为 no-connect 时抑制。
- `SINGLE_PIN_NET`（warning）：命名网络只驱动一个引脚。
- `AMBIGUOUS_CROSSING`（warning）：导线相交但没有 junction、而 T 型连接本会连通——EasyEDA 在 T 端点处连通、在四路交叉处不连通，生成的几何不得依赖含糊的视觉接触。

### 电气规则

- `NET_MULTI_DRIVER`（error）：同一网络上存在两个及以上 `OUTPUT` 引脚；成员全属电源/地类别的网络除外。
- `POWER_SHORT`（error）：不同已声明电源名（如 `VCC`、`GND`）的引脚被 Short 符号或同名 NetFlag 合并到同一网络。
- `INPUT_NO_DRIVER`（warning）：网络上仅有的成员全是 INPUT 引脚。
- `ELECTRIC_TYPE_UNKNOWN`（warning）：引脚带着 `electric = UNKNOWN` 进入被检查的规则——生成器应解析出符号的电气类型，而不是直接透传默认值。

### 器件、符号与封装匹配

- `DESIGNATOR_*`：每个实体元件携带 `Designator` ATTR；位号在工程内唯一并遵循按类别的前缀约定。
- `BINDING_UNRESOLVED`（元件库可达时为 error，否则为 warning）：每个 `COMPONENT` 上的 `Device`、`Symbol`、`Footprint` ATTR 绑定能解析到目标工作区中的真实库 UUID。
- `PIN_PAD_MISMATCH`（error）：符号引脚 `NUMBER` 在所绑定封装中经器件的引脚-焊盘映射后无对应焊盘——这种错配会在转入 PCB 时静默丢失连接。
- `MULTI_PART_INCONSISTENT`（error）：同一多 PART `COMPONENT` 的各分体在器件绑定或位号上不一致。
- 标志一致性：`addIntoBom`/`addIntoPcb` 与已绑定封装保持一致；NoneElec 符号不得携带 PCB 意图。

### 网络命名与格式不变式

- `NET_NAME_*`：网络名符合声明的语法——非空、无首尾空白、受限字符集、统一应用文档化的大小写折叠策略。`A[1:5]` 这类总线名必须格式良好，且每个 `BUSENTRY` 的 order 索引必须映射到总线展开中真实存在的分支。
- `WIRE_MISSING_NET`（error）：`WIRE` 或 `BUS` 缺少 `NET` ATTR，或其 `NET` 值与同一图连通分量上的 NetFlag 命名不一致。
- `PIN_ATTR_MISSING`（error）：`PIN` 缺少 `NAME` 或 `NUMBER`。
- `ORPHAN_ATTR`（error）：`ATTR` 的 `parentId` 解析不到任何存活的图元，包括复合 parent（`component-id` + `pin-id`）必须可解析的引脚覆盖 ATTR。
- `FORMAT_*`：`id` 在文档内按 `type` 唯一、`ticket` 单调、存在时 `groupId` 不得为 `0`、新产出中不得出现删除记录（内层为 `""` 或 `DELETE_DOC`）、坐标以 `0.01 inch` 为单位。

## 测试策略

- **单元测试**（`pnpm run test`）：每条规则配一个最小 IR fixture，正反两例；并查集解析器覆盖总线、Short 符号、NetFlag 合并和跨页 NetPort 合并；序列化 golden 固定每种图元发出的确切行；解析-序列化 round-trip 证明导入器能从自身产出恢复 IR。
- **覆盖率**：新增 `src` 树在 `test:coverage` 下逐文件 100%。
- **Loader 与 HMR 安全**：每个函数插件都要有 [postmortem 0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md) 的"无 default 导出 + `unwrapExports` round-trip"守卫；每个注册表贡献都要有"dispose 后观察移除"的测试。
- **真实组合**：test-only `cordis.yml` 经 Loader 启动 seam、provider、consumer 与 guard，经 `ctx.tools.execute()` 驱动；只有 bridge 边界打桩。
- **owner-local expected output**：golden 文档源码文件与期望发现表放在所属包的 `tests/expected/` 下，不进 `snapshots/`——按 [snapshot ownership](../../../../snapshots/AGENTS.md)，它们不由 session 驱动。
- **快照**：`snapshots/session/` 下录制一条"生成 → 校验 → 修复 → 通过"的无 key 回放 session；发现以工具结果形式到达模型，因此 session fixture 会逐字固定它们，再配一条触发失败规则的 fixture 固定修复路径。
- **真实 API e2e**：`DEEPSEEK_API_KEY` 门控的套件让模型生成一个小型真实电路，断言闭环参与且交付物通过静态校验。另有一个独立 env 门控的套件对运行中的 EasyEDA 客户端跑 live bridge 预言机——导入、`SCH_Drc`、网表 diff；无 bridge 时自动跳过。

## 交付里程碑

- **M1 — IR、序列化器、校验器核心。** 类型化 IR、IR→SCH_PAGE 投影、格式不变式与连通性规则、单元测试。尚无工具层。
- **M2 — 工具 seam 与校验-修复闭环。** 模型工具返回结构化发现；guard 限定修复轮数；真实组合测试与录制快照在同一变更中落地。
- **M3 — 库解析。** 面向真实工作区库的器件/符号/封装绑定检查、引脚-焊盘映射校验、库不可达时降级为 warning 的行为、真实 API e2e。
- **M4 — 客户端预言机。** 经 bridge 导入、`SCH_Drc` 收集与网表 diff，产出参考级发现；env 门控的 live 测试。

## 进展证据

- **M1–M4 已交付。** 16 个测试文件 / 289 个用例；`test:coverage` 在 `packages/schematic/*/src` 限定范围内语句/分支/函数/行四项 100%；`tsc -b`、`oxlint`、`verify-export-jsdoc` 全部通过；`pnpm run test:docs` doc-quick 21/21；headless `schematic-tools` expected e2e 回放完整的生成 → findings → 修复 → 输出记录。
- **M4 网表 diff 已接线。** `engine.verify(ir)` 把客户端文档源读回为几何网络区域并与 IR 网图做 diff——`SCHEMATIC_NETLIST_DROPPED`、`SCHEMATIC_NETLIST_WRONG_NET`、`SCHEMATIC_NETLIST_MERGED` 发现经两个工具的 `verify: true` 返回供模型修复；引擎不可达降级为 `SCHEMATIC_VERIFY_UNAVAILABLE` 警告，error 级 diff 使 `ok` 变 false 但已产出的源照常返回。
- **实机闭环（EasyEDA 4.1.71 Web 客户端）。** 一张两页、经实时 `C25804` LCSC 绑定的 IR 跑通 parse → resolve → layout → validate → `importProject` → 读回。缺陷文档返回 `FLOATING_PIN` 警告加 `BINDING_UNRESOLVED` 错误；修复后文档仅余警告通过门禁；导入产出工程 `96e67c786e294795942e9a795636895f`，页面 `f7f2add3db984015b3610b57b19f4803`/`99e4a220f36a472eb61285e39f58ba18`，`findings: []`，读回 `P1 {COMPONENT:6, ATTR:17, WIRE:3, LINE:4}` / `P2 {COMPONENT:2, ATTR:3}`。
- **env 门控 live 套件。** `dsh-schematic-easyeda` 的 `tests/live-e2e.spec.ts` 在模块加载时探测 bridge、无客户端时自跳过；可达时驱动实时 `resolveByLcsc` 绑定，并经真实 `Context` 组合跑通 `resolveBindings → layout → validate → importIntoEasyEda` 全链。
- **实机校验抓出的缺陷。** 门禁曾拦下一条把 `GND` 与 `SIG` 在外部引脚端点处合并的生成干线导线，以及一条缺 `NET` 属性的旗标支线；此后布线检查外部占点并回退旗标布线、生成支线携带 `net`、孤立地网走旗标、LCSC 关联字段把空串归一为缺失、导入读回等待文档树挂载完成。

## 考虑过的替代方案

**不做预校验——交给 EasyEDA 导入器拒绝坏输出。** 导入失败只会表现为不透明错误或静默误读（一个不被识别的 ATTR、一条什么都没连上的导线），模型拿不到可操作信息。校验存在的意义就是在交付前把这些转成有定位、有名字的缺陷。

**用 prompt 级自审替代确定性检查。** 让模型检查自己的输出正是测试策略所否定的 self-report 模式——产生缺陷的那个概率过程再去评审它自己。确定性 IR 规则才是预言机；模型消费它们的发现。

**校验已发出的文档源码文本而不是 IR。** 行级校验会重复序列化器的投影逻辑，并迫使每条规则从原始坐标和 ATTR 接线中重新推导语义。校验 IR 检查的是意图；序列化 round-trip 另行证明投影保真。

**把 `eda.sch_Drc.check` 作为权威检查来门控。** 客户端 DRC 标注为 BETA，并明确警告不可用于生产；而且它要求一个运行中的 EasyEDA 客户端，CI 与 headless 会话都没有。它只作为参考证据；确定性校验器持有门控权。

**第一天就上完整 PCB 级 ERC。** 初始规则集瞄准生成实际会产生的失败——连通性、命名、绑定、格式。注册表结构让新规则可以按观察到的模型失败独立落地，而不是预先堆一套未经验证的规则矩阵。

## 验收标准

- 任何生成物到达用户之前必须通过静态校验器；每个发现携带稳定的 code、severity、locator 和可操作的 message。
- 每条规则有正反例单元覆盖；`test:coverage` 在新包上通过；每个注册表贡献都证明了可 dispose。
- 校验-修复闭环出现在已提交的录制 session 快照中，至少包含一轮修复。
- env 门控的 bridge 套件证明 IR 网络图与客户端自身网表提取结果一致，或将分歧作为参考级发现上报。

## 风险

- **端点重合语义只被部分文档化。** junction 与交叉、导线端点规则必须对照 live 客户端行为验证；静态模型与 EasyEDA 不一致时以 bridge 网表 diff 为仲裁，分歧记为校验器 bug 而非用户可见错误。
- **`SCH_Drc` 是 BETA。** 其结果结构可能变化且明确不受生产支持；所有预言机消费都包在一个 adapter 后面，detail 结果格式变化时降级为"预言机不可用"，绝不崩溃。
- **格式文档不完整。** V3 参考是部分快照，V2.2 归档已过时；序列化器做版本门控，golden fixture 保持足够小，以便格式参考更新时重新推导。
- **工作区库内容因用户而异。** 器件 UUID 离线不可解析时绑定检查必须降级为 warning，否则校验器会在用户缺少个人库时对每次生成都硬失败。
- **修复闭环可能空转。** 轮次上限和"N 轮后仍失败"的结构化报告是契约的一部分，不是事后补丁。
