# 原理图生成：流程说明与外部插件化方案

Scope: `packages/schematic/{schematic, schematic-easyeda, tool-schematic, schematic-bundle}`面向读者：想了解原理图生成能力如何工作的用户，以及评估将其移出 deepseek-harness 主仓、作为外部插件分发的维护者。

## 1. 它在做什么

`schematic_generate` 工具把模型产出的结构化电路描述变成一张可在 EasyEDA 客户端里打开、可过 DRC 的原理图工程；`schematic_validate` 对同一份中间表示做静态检查并返回可修复的 findings。链路刻意分成「纯逻辑层」与「交付层」：前者离线可跑、可单测到 100% 覆盖；后者依赖 EasyEDA 客户端与库服务，失败时以结构化 finding 显式报告，绝不静默降级为"成功"。

## 2. 包结构

| 包 | 角色 | 依赖 dsh 服务的面 |
|---|---|---|
| `dsh-schematic` | Service Definition：`ctx.schematic` 注册中心、IR 类型、绑定解析、布局、静态校验器 | `cordis`、`schemastery`、`dsh-llm`（LLM 调用接缝） |
| `dsh-schematic-easyeda` | Service Provider：EasyEDA 序列化 + live 客户端构建/导入/校验引擎 | `cordis`、`dsh-schematic`、`dsh-timeout` |
| `dsh-tool-schematic` | Consumer：`schematic_generate` / `schematic_validate` 两个模型工具 | `cordis`、`dsh-tools`、`dsh-schematic`、`dsh-system-prompt` |
| `dsh-schematic-bundle` | 安装层：一个 `cordis.patch.yml` 插入上面三行插件 | 仅声明 `dsh.bundle.patch`，无代码 |

三层是标准能力接缝：Service Definition 定义契约，Provider 可以换成别的 EDA（当前只有 EasyEDA），Consumer 通过 `ctx.schematic` 拿到引擎而不关心实现。

## 3. 端到端流程

```
模型 ──schematic_generate──▶ IR ──▶ resolveBindings ──▶ layout ──▶ validate ──▶ 交付 ──▶ verify
                              ▲                                                       │
                              └──────── findings 回灌给模型修复（error 阻断） ◀────────┘
```

1. **IR 组装**：模型按 schemastery 描述的 schema 产出 `SchematicIr`——sheets、components（含 designator/kind/`deviceUuid`/`symbolUuid`/`footprintUuid` 及三个 `*LibraryUuid` 库作用域）、pins（net/endpoint/noConnect）、wires/buses/junctions、attrs。
2. **`resolveBindings`（`schematic/src/library.ts`）**：把器件名/LCSC 号解析为库 uuid；有作用域声明的在作用域内查，scoped miss 报 error，scope-less 不可验证降级为 `unverifiable` warning；同时经可选接缝 `resolveSymbolPins` 预取符号真实引脚几何。
3. **`layout`（`schematic/src/layout.ts`）**：用符号引脚几何确定导线端点（容差吸附），rotation/mirror 经 `transformSymbolPoint` 变换；引脚几何缺失时退回声明端点。
4. **`validate`（`schematic/src/validate.ts`）**：四族规则——器件/符号/封装绑定与 PCB/BOM 意图、引脚连通与电气合理性（含 `WIRE_NOT_ON_PIN`）、网络命名与 bus 格式、IR 不变量——产出带 `code`/`severity`/`locator`/`suggestion` 的 findings。error 级 findings 阻断交付并把清单回给模型。
5. **交付（`schematic-easyeda`）**，两条路径：
   - **`build`**（交付路径）：经 bridge 调客户端 `sch_PrimitiveComponent`/`sch_PrimitiveWire`/`sch_Drc` 等接口，分片放置、幂等去重、页身份校验；库引用在放置时由客户端复制进工程库。
   - **`importProject`**（归档/回退路径）：序列化为 `.epro2` 文档源，先经 bridge 批量抓取库文档并本地化为工程内嵌文档、重写 ATTR 引用，再交 `importProjectByProjectFile`。
6. **`verify`（live oracle）**：放置完成后在客户端做三类对账——元件/导线计数（排除图框）、Protel 网表按 `DESIGNATOR-PIN` 逐 pad 对账（`SCHEMATIC_EDA_NET_PAD_MISMATCH`）、DRC 分类（`CHECKFLOATPIN` 对 IR 声明 `noConnect` 的引脚豁免）；可选地按 symbolPins 再做端点↔库引脚对账。verify 不可用或失败时工具返回 `ok: false`，不会把"没验证"报成"验证通过"。
7. **`schematic_validate`**：只跑第 4 步，供模型在生成前检查草稿或排查既有 IR。

## 4. 坐标与数据域约定（易踩坑）

- IR 与客户端放置 API 用同一坐标域：**sheet/API 空间，y 向下**。
- 持久化文档源（`.epro2`/库文档内的 PIN 坐标）**y 轴翻转**；`library.ts` 的 `parseSymbolPins` 在入库时完成翻转，`SchematicSymbolPin` 契约注释在 `types.ts`。
- 桥接单次 `execute` 有约 30 s 上限，故 build 按 chunk 分片并对 streak 失败熔断。
- `noConnect` 引脚是 IR 声明意图：静态校验与 DRC 豁免都认它，但客户端本身没有 no-connect 语义。

## 5. 前置条件

- **仅生成 + 静态校验**：离线可用，只依赖 dsh 正常启动。
- **live build / verify**：需要 EasyEDA 客户端运行 `run-api-gateway` 扩展（Web 版需登录并启用扩展）+ 本仓 `.tmp-temp/bridge-server.mjs` 桥接进程（默认 `http://127.0.0.1:49620`）+ LCSC 库访问权限。
- **importProject**：同样需要 bridge（抓取库文档）；bridge 不可用时降级为 `SCHEMATIC_IMPORT_LIBDOC` finding，不会产出空框工程。

已知限制见 `schematic-easyeda/README.md`：short/nonelec 器件未解析、`createSchematicPage` 在导入工程内行为受限、复杂多页设计实测覆盖有限。

## 6. 外部插件化方案

### 6.1 现状与已就绪条件

写作时四个包以 in-tree workspace 形式存在于 `packages/schematic/`（后经 `feat/schematic-generation` 过渡分支迁出至本仓，该分支已删除），经 `schematic-bundle` 的 `cordis.patch.yml` 以 `--patch` 或 profile bundle 方式挂载。发布形态其实已就绪：

- 包名均为 `@deepseek-ai/dsh-schematic-*`，`publishConfig.access: public`；
- 对 `cordis` 及宿主 dsh 服务已按外部插件规范声明为 `peerDependencies`（+ `devDependencies` 用于本地类型检查），共享实例规则天然满足；
- `dsh-schematic-bundle` 已声明 `dsh.bundle.patch`——这正是 `dsh plugin --profile <name> add <pkg>` 的激活依据（机制见 `docs/user/develop/basic/publish.md`）。

### 6.2 推荐路径：npm 发布 + `dsh plugin add`（保留 in-tree 开发）

第一阶段不需要搬仓库，只把产物发出去：

```sh
# 发布后用户侧
dsh plugin --profile demo add @deepseek-ai/dsh-schematic-bundle
dsh --profile demo
```

只装 bundle 一包即可：`dependencies` 会带下三个实现包，patch 插入三行插件。`pnpm publish` 会把 `workspace:*` 协议自动改写为实际版本号，不需要手工改 manifest。留在 monorepo 内继续开发，可保留现有 coverage/doc/翻译配对门禁与 live-e2e 脚手架，发布节奏可以独立于 dsh 主版本。

### 6.3 第二阶段：迁入独立仓库（真正"外部插件"）

若需要彻底独立迭代（独立 issue tracker、独立发版、非 dsh 维护者协作），再把 `packages/schematic` 迁到独立 repo，以 npm 版 `dsh-*` 为依赖消费。迁移代价要逐项评估：

| 事项 | 处理方式 |
|---|---|
| monorepo 测试基建 | 需重建：vitest coverage 门禁、tsc project refs、oxlint、export-jsdoc、文档配对检查 |
| `dsh plugin add` 的 npm 路径 | 开箱可用；`github:` 安装需为每个包加 `prepare` 构建脚本（git 安装只拉源码、无 `lib/`），且用户要在 `pnpm-workspace.yaml` 的 `allowBuilds` 中显式放行——建议优先 npm/tarball 分发避免这一摩擦 |
| `bridge-server.mjs` | 目前在 `.tmp-temp/` 属 scratch 产物；外部化前必须转正为包内 bin（如 `dsh-schematic-easyeda/bin/bridge-server.mjs`）或独立 npm 包，否则 live 路径无法随插件交付 |
| live-e2e 实机测试 | 依赖真实 EasyEDA 客户端，无法进常规 CI；独立 repo 需约定人工验证流程 |
| in-box bundle 注册 | 从 `apps/cli`/app-boot 的可选 bundle 名册中摘除，避免"仓内没有、名册引用"的悬空 |

### 6.4 备选形态：MCP 包装

把两个工具包成 MCP server 可让非 dsh 宿主（Claude Code、其他 agent harness）复用同一引擎。代价：要重新实现 `schemastery` 工具 schema 映射、findings 回传格式，以及 dsh 的「model-visible ⟺ logged」会话记录契约；`ctx.tools`/`ctx.schematic` 接缝需替换为进程内直接调用。建议作为独立化之后的附加分发形态，而非替代 cordis 插件形态——后者在 dsh 内仍是一等集成。

### 6.5 结论建议

- **近期**：6.2 路径——包已在发布形态，补一个 npm 发布流程即可让外部用户 `dsh plugin add` 装用，主仓不动。
- **中期**：是否迁仓取决于协作诉求；该能力强依赖 EasyEDA 前置条件、目标用户面窄，独立仓库的隔离成本目前看收益有限。
- **先行债**：~~`bridge-server.mjs` 转正~~ 已完成——正式实现落为 `schematic-easyeda/bin/dsh-eda-bridge.mjs` 随包分发。

**执行状态（2026-10-13 更新）**：独立仓已落地 `../deepseek-eda-plugins`（见该仓 `docs/migration-plan.md`）：四包代码+测试已迁入并统一命名为 `@deepseek-ai/dsh-plugin-eda-{sch,easyeda,sch-gen,bundle}`，`pnpm install`/`tsc+tsdown`/`vitest 352`/`coverage 100%`/`oxlint` 全绿，且已通过 `cordis.patch.yml` 在 dsh headless profile 中实测外部加载（mock-LLM validate→generate 回路与 golden e2e 一致，跨包引用经外仓 lib 产物真实解析）。dsh 侧过渡分支 `feat/schematic-generation` 已删除（master 从未包含该插件），外部仓为唯一权威源，不存在双源同步问题。

## 7. 常见问题与设计取舍

### 7.1 为什么生成结果通常只有一页

单页输出是**模型的默认行为，不是能力限制**。IR 本身就支持 `sheets` 数组，且全链路都已就绪：`layoutSchematic` 做全局网络普查，出现在多页的同名网络自动改用 `netport` 互连（同页内才用 `netflag`）；`build` 按 sheet 建页、逐页校验页身份并分片放置；netlist oracle 按页回读。模型在 prompt 里显式输出多个 sheet、用同名网络（走 netport）跨页连接，今天就能工作。

缺的是**引导与自动拆分**：工具 schema 没有鼓励模型按功能块分解页面，`layoutSchematic` 也没有对单页规模做拆分启发式。已实测的 555 级电路单页是合理选择，这个问题只在几十/上百器件的设计上才会显现。

优化建议（按成本从低到高）：

1. **提示层**：在 `schematic_generate` 的工具描述/系统提示中约定功能块拆页规范（如「电源、MCU 最小系统、接口各一页，跨页网络一律 netport」），零代码改动；
2. **建议层**：`layout` 或 `validate` 增加规模阈值 finding——单页元件数超阈值时给 warning 建议拆页，让模型在修复循环中自行重排；
3. **自动层**：连通度驱动的自动分区（按功能子图切分、边界网络自动生成 netport）——收益最大但最容易切错语义边界，建议等真实大电路样本积累后再做。

### 7.2 布局布线如何实现，效果如何

`layoutSchematic`（`schematic/src/layout.ts`）是确定性纯函数：同样输入必得同样输出，且对已带几何的 IR 幂等（显式 position/endpoint/dots 原样通过）。三个阶段：

- **分区摆放**：器件按"信号流列"从左向右排——以同一网络上 OUTPUT→INPUT 的引脚关系建边，做最长路分层，驱动源在左、负载在右；环用确定性回退（最低 designator 先行）。注释类符号（netflag/netport/nonelec）统一收进右侧标注区。
- **引脚端点**：有 `symbolPins` 库几何时引脚落在符号真实引脚坐标上（经 rotation/mirror 变换，1 格内自动吸附）；否则按电气方向合成（INPUT 居左、OUTPUT 居右、BI/UNKNOWN 两侧均衡），引脚间距 `pinPitch=20`、引脚 stub `pinStub=20`。
- **网络布线**：模型声明的导线原样保留；未接通的网络成员按策略接通——电源网向上挂旗、地网向下挂旗、普通网按引脚侧向伸出 `netflag`（同名旗标逻辑合并，无需干线）；跨页网用 `netport`；不走旗标的网络生成"中位 y 水平干线 + 每端点竖直 stub + junction"。生成的干线/挂载会检查是否穿过异网已占点（引脚端点/旗标/junction），冲突则整体回退旗标方案，防止并网。

**自评**：对 555 级小电路（≤~20 器件）实机验证可用，DRC 干净、可读性可接受。明确局限：

1. 库 API 不提供器件外形，占位轮廓只按声明 pin 数估高（半宽固定 60）——列内纵向堆叠在引脚数差异大时会显得松散，极端情形可能视觉重叠；
2. 布线避障是**点级**的（只避异网的引脚/旗标/junction 点），不绕器件体，干线可能穿过器件轮廓；
3. 无美学启发式：列内按 designator 字母序而非连接关系排序，交叉数没有优化目标；
4. 旗标策略在成员多时会散布较多旗标，视觉上不如集中干线整洁。

**优化空间**（按收益排序）：

1. 用库文档中的符号外形做真实 occupancy，既消除重叠也让干线可绕开器件体；
2. 干线避让升级为绕障 Manhattan（A* 或线段推挤），把器件外框纳入障碍集；
3. 列内排序引入 barycenter 等连接感知排序，减少网间交叉；
4. 旗标聚合：邻近同网旗标合并为短干线，控制旗标密度；
5. 页面尺寸自适应与图框/标题栏生成，配合 7.1 的多页拆分。

### 7.3 生成的工程能否直接导入 EDA 并正常显示

**能，已实机验证**。`importProject` 路径在序列化前经 bridge 批量抓取器件/符号/封装库文档，本地化为工程内嵌文档并重写组件 ATTR/`partId` 引用——导入后器件不再是空框，电阻、旗标、端口、导线均正常渲染（555 样例 0 findings）。没有这一步时（早期版本）导入工程会显示带 X 的空框，这正是"工程自带库"问题的修复点。

前提与边界：

- **bridge 必须在线**且能访问 LCSC/系统库；抓不到时报 `SCHEMATIC_IMPORT_LIBDOC` finding——明确报错而非静默产出空框。纯离线环境只能产出未嵌入库文档的 `.epro2`，不适合直接导入。
- **导入工程内建页受限**（EasyEDA 客户端行为）：`createSchematicPage` 对已导入工程可能抛错，因此 import 定位为**归档/回退路径**，交互式交付走 live `build`。
- `.epro2` 文档源 schema 对客户端版本敏感，当前在 EasyEDA Pro 4.1.x 上实测；跨版本未验证。
