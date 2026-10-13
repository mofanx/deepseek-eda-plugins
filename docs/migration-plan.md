# 迁移计划：dsh 内置 schematic 包 → 独立插件仓

Scope: `deepseek-harness/packages/schematic/*` → 本仓。依据：`deepseek-harness/packages/schematic/docs/2026-10-13-schematic-flow-and-externalization.md` 第 6 节方案。本文记录 prep 结论与首轮迁移执行结果。

**执行状态（首轮迁移已完成，commit `911c05b`）**：4 包代码+测试+fixture+bin/README 已迁入；`pnpm install` / `tsc -b` / `vitest`（352/352）/ coverage 100% / `oxlint` 全绿；dsh headless profile 经 `cordis.patch.yml` 加载本仓 src 完成 mock-LLM validate→generate 回路。dsh 仓内嵌包暂保留为过渡期权威源（见 5-R6）。

## 1. 包结构决策：保留分包，不合并

| 包 | npm 名 | 保留独立包的理由 |
|---|---|---|
| `packages/schematic` | `@deepseek-ai/dsh-schematic` | Service Definition。`declare module '@deepseek-ai/cordis'` 的 `ctx.schematic` 类型合并必须以包为单位存在；其他 EDA Provider 也要依赖它。 |
| `packages/schematic-easyeda` | `@deepseek-ai/dsh-schematic-easyeda` | Provider。EasyEDA 专用（bridge、序列化、库绑定）；未来加 KiCad/Altium provider 时并行存在。bridge bin（`bin/dsh-eda-bridge.mjs`）随包分发，d3 已转正。 |
| `packages/tool-schematic` | `@deepseek-ai/dsh-tool-schematic` | Consumer。模型工具面，独立于引擎演进（如加 MCP 分发形态时不需要动引擎包）。 |
| `packages/schematic-bundle` | `@deepseek-ai/dsh-schematic-bundle` | 安装层。`dsh.bundle.patch` 声明是 `dsh plugin add` 激活层的唯一依据；用户只装这一个包。 |

不合并的原因：接缝本身就是分包的语义（Service Definition / Provider / Consumer），合并会让非 EasyEDA 消费者和后续 Provider 被迫携带无关依赖。bridge 原定独立包，后因 d3 把正式实现直接落进 `schematic-easyeda`（bin + `ws` 依赖），取消第 5 包。

## 2. 依赖分析（按 src 实际 import 枚举）

### 2.1 运行时依赖处置

| 导入符号 | 来源包 | 用法 | npm 现状 | 处置 | 理由 |
|---|---|---|---|---|---|
| `Context`, `Service` | `@deepseek-ai/cordis` | 运行期类（service 包 extends Service、apply(ctx)） | **已发布 4.0.4**（仓内 4.0.5-alpha.1） | **peerDependencies** | 类身份必须与宿主共享（instanceof、Service 子类、Context 原型链） |
| `z` | `@deepseek-ai/schemastery` | `Config` schema 值 | **已发布 3.18.4**（仓内 3.18.5-alpha.1） | **dependencies** `^3.18.4` | cordis 经 `runtime.Config['~standard'].validate(config)` 走 Standard Schema 协议消费（`vendor/cordis/src/fiber.ts:53`），不做 instanceof 检查，实例无关，无需 peer |
| `HarnessError` | `@deepseek-ai/dsh-llm` | `SchematicError` 的基类 | **已发布 0.0.1-rc.1**（仓内 0.2.1-alpha.2） | **peerDependencies** | 错误类身份：宿主侧 instanceof/类型收窄依赖同一份 HarnessError |
| `deadline`, `timeoutOf`, `TimeoutReason` | `@deepseek-ai/dsh-timeout` | bridge.ts 超时/熔断（纯工具） | **已发布 0.0.1-rc.1** | **peerDependencies** | 无单例问题；dsh-* peer 受宿主运行时版本检查，必须声明宿主版本能满足的范围（`>=0.0.1-rc.1`） |
| `defineTool` | `@deepseek-ai/dsh-tools` | 工具注册工厂 + `ctx.tools` 注入 | **已发布 0.0.1-rc.1** | **peerDependencies** | 注入的是宿主的 tools 服务；defineTool 产物由宿主注册器消费 |
| `ctx.systemPrompt` | `@deepseek-ai/dsh-system-prompt` | `inject` 成员 + `ctx.systemPrompt.section()` 运行期调用 | **已发布 0.0.1-rc.1** | **peerDependencies** | 运行时注入依赖，非纯类型 |
| `ContentBlock`, `ToolCallId` | `@deepseek-ai/dsh-llm` | 类型 | — | 随 dsh-llm peer 覆盖 | 类型级 |
| `JsonValue` | `@deepseek-ai/dsh-util-values` | 仅类型（findings locator） | **未发布** | **最小提取** | 单类型别名，提取为本仓 `types.ts` 内的 `type JsonValue`，删除该依赖 |

### 2.2 修正项（首轮执行发现）

1. **`dsh-schematic` 不可声明为 peer**。`plugin-compatibility.ts` 把**所有** `dsh`/`dsh-*` peer 按「dsh 运行时版本满足 semver 范围」检查——`peer: dsh-schematic@0.1.0` 会被判定与运行时 `0.2.1-alpha.2` 不兼容而禁用整行插件。seam 包是我们自己的分发物，改为 `dependencies`（`workspace:*`，发布时定版本）；profile 安装内单副本满足模块身份。
2. **npm `0.0.1-rc.1` 开发路径不可行**：`dsh-tools@0.0.1-rc.1` 传递依赖未发布的 `dsh-type-meta`，直接 404。devDeps 全部改 `link:` 指向 sibling deepseek-harness 检出（依赖经其 node_modules 祖先解析）。
3. **`JsonValue` 已提取**：`tool-schematic/src/index.ts` 改为本地 `type JsonValue` 别名，`dsh-util-values` 依赖消除。
4. **覆盖缺口补测**：`build.ts` association 嵌套对象形态（`association.symbol.uuid`）分支在 dsh 侧未提交改动里也无覆盖，本仓已补测试（352/352、100%）。
5. **pnpm 11 `allowBuilds`**：`pnpm-workspace.yaml` 需 `allowBuilds: { esbuild: true }` 放行 esbuild postinstall。
6. **oxlint**：dsh 的 curated type-aware 规则集依赖 oxlint-tsgolint，本仓先用等价核心子集（关全部 categories + 显式规则表）；迁移完成后可回填 typeAware。

### 2.3 测试依赖处置（全部 devDependencies）

| 来源包 | 用法 | npm 现状 |
|---|---|---|
| `@deepseek-ai/dsh-scope` | `createScope` 工具执行上下文 | 已发布 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tools`（ToolRuntime 默认导出） | REAL 组合测试挂工具服务 | 已发布 0.0.1-rc.1 |
| `@deepseek-ai/dsh-system-prompt`（含 `renderPrompt`） | REAL 组合测试 | 已发布 0.0.1-rc.1 |
| `@deepseek-ai/cordis-plugin-loader` | 经 Loader 实机装载验证 | 已发布 1.0.5 |
| `@deepseek-ai/cordis-plugin-include` | 组合测试 | 已发布 1.0.9 |
| `vitest` / `@vitest/coverage-v8` / `vite-tsconfig-paths` / `tsx` / `typescript` / `oxlint` | 基建 | 上游公开 |

### 2.3 结论

- **唯一必须提取的依赖**：`dsh-util-values` 的 `JsonValue`（未发布、纯类型、单别名）。
- **唯一进程外依赖**：bridge server（无包依赖，纯 Node；源码待恢复，见风险 R1）。
- 其他全部依赖 npm 可解析，但存在**版本漂移**（见 4.2）。

## 3. 被 dsh 消费的 API surface

外部插件被 dsh 装载时，宿主只依赖以下契约（cordis 插件协议）：

| 面 | 形态 | 约束 |
|---|---|---|
| `dsh-schematic` | **默认导出** `SchematicRuntime extends Service`（service 包允许 default）；`declare module '@deepseek-ai/cordis'` 合并 `Context.schematic`；静态 `inject`/`Config`（schemastery） | Loader 对 service 包按类装载；Config 经 `~standard` 校验 |
| `dsh-schematic-easyeda` | 函数插件：具名导出 `name` / `inject` / `Config` / `apply`，**无 default** | `inject` 声明注入服务；apply 内 `ctx.schematic.registerEngine(...)`/`registerLibrary(...)`，返回值经 `ctx.effect` 管 disposal |
| `dsh-tool-schematic` | 函数插件：`inject = ['tools', 'schematic', 'systemPrompt']`，具名导出同上 | `ctx.tools.register(defineTool(...))`、`ctx.systemPrompt.section(...)` |
| `dsh-schematic-bundle` | `package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` 三行 insert | patch 行以**包名**引用插件（Node 解析），非相对路径 |
| bridge | 非 cordis：HTTP 契约——端口扫描 49620–49629、`GET /health` `{service:'easyeda-bridge',edaConnected}`、`POST /execute {code}` → `{result}`/`{error}` | 引擎经 `HttpEasyEdaBridge.discover` 探测；契约常量在 `bridge.ts` |

反向看，dsh 侧需要存在的服务：`tools`、`schematic`（本仓自带）、`systemPrompt`（tool-schematic inject），以及 `dsh-llm`/`dsh-timeout` 的可解析 peer。`dsh plugin add` 安装时 peers 由 dsh 安装的运行时解析提供（publish.md 的祖先解析规则）。

## 4. 迁移清单（有序）

### 4.1 代码迁移

- [x] ~~恢复 bridge-server.mjs~~ d3 已把正式实现落为 `schematic-easyeda/bin/dsh-eda-bridge.mjs`，随包迁入。
- [x] **复制 src+tests**：四包 `{src,tests,fixtures,bin,scripts}` 已迁入（单 commit `911c05b`，来源 dsh `feat/schematic-generation` HEAD 含未提交编辑）。
- [x] **删除 `dsh-util-values` 依赖**：`JsonValue` 已改本地类型别名。
- [x] **fixtures**：全部迁入；`live-e2e.spec.ts` 保留并在 `vitest.config.ts` 默认 exclude。
- [x] **README 双语**：`README.md`/`README.zh.md`/`README.i18n.yaml`/`locale/`/`icon.svg` 已迁。

### 4.2 基建与验证

- [x] `pnpm install`：npm rc.1 路径实测失败（`dsh-type-meta` 404）→ devDeps 全改 `link:` sibling 检出，安装通过。
- [x] `pnpm run build`（tsc -b exit 0）、`pnpm run test`（352/352）、`pnpm run test:coverage`（per-file 100 通过，补 association 对象形态用例）、`pnpm run lint`（oxlint exit 0）。
- [x] **真实组合测试保留**：`loader-composition.spec.ts` 经 linked cordis Loader 通过；另增根级 `cordis.patch.yml` 供 `--patch` 直载 src。
- [ ] `pnpm publish` 顺序：`dsh-schematic` → `dsh-schematic-easyeda` → `dsh-tool-schematic` → `dsh-schematic-bundle`（内部 `workspace:*` 发布时改写版本号）。
- [ ] **dsh 仓清理**：从 `packages/schematic/` 摘除、OPTIONAL_BUNDLES/可选 bundle 名册、tool-catalog、profile patch 引用、文档链接改指外部仓。**本轮决定：暂不摘除**——npm 未发版前 in-tree 保留为权威源，本仓为镜像（单向 dsh→外部同步）；发布后同批摘除。

### 4.3 分发验证

- [x] **加载路径实测**：`pnpm dsh --profile headless --patch <本仓 cordis.patch.yml> --patch <mock-llm patch> --json <task>` 通过——三插件从本仓 src 装载，`schematic_validate`/`schematic_generate` 走通 mock-LLM 修复回路，输出与 golden e2e 一致（含 `plugin-compatibility` 校验发现并修复 `dsh-*` peer 声明）。
- [ ] `dsh plugin --profile demo add @deepseek-ai/dsh-schematic-bundle` 实装（待 npm 发版）。
- [x] bridge bin 已随 `dsh-schematic-easyeda` 分发（`dsh-eda-bridge`，`files`+`bin` 已声明）。

## 5. 风险评估

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | ~~bridge-server.mjs 源码已失~~ **已解除**：d3 把正式实现落为 `schematic-easyeda/bin/dsh-eda-bridge.mjs`（+`ws` dep、`scripts/live-verify.mjs` 实机验证 PASS） | — | 随包分发，无独立包 |
| R2 | **npm dsh-* 版本漂移**：已发布 0.0.1-rc.1 vs 仓内 0.2.1-alpha.2，且 rc.1 依赖未发布的 `dsh-type-meta` 导致 npm dev 路径直接 404 | **高（已证实）** | devDeps 已落 `link:` 指向 sibling deepseek-harness 检出；正式发布前必须等 dsh 0.2.x 上 registry 或钉定兼容版 |
| R3 | schemastery 双实例：plugin 的 Config 与 cordis 内部 schemastery 版本不同 | 低 | 已核实 cordis 走 `~standard` 协议无 instanceof（`fiber.ts:53`）；dep `^3.18.4` 即可 |
| R4 | peer 解析语义：`dsh plugin add` 的祖先解析规则要求 peer 在宿主运行时可见——profile 独立 node_modules 下 `dsh-llm` 等需经 dsh 安装侧解析而非 profile 本地装 | 中 | publish.md 规则已确认该机制；实装验证（4.3）覆盖；不要在 profile 里手动 `add` peer 包以免遮蔽宿主实例 |
| R5 | live-e2e 依赖实机 EasyEDA 无法进 CI | 中 | 保留 spec 默认 exclude + 人工验证流程；README 标注 |
| R6 | 双仓过渡期 API 漂移：IR/engine 类型在 dsh 侧仍被 app-boot/system-prompt/tool-catalog 引用 | 中 | 迁出后 dsh 侧引用全部删除（4.2 末项）；过渡期以 dsh 仓为权威源，本仓为镜像，单向同步 |
| R7 | `schematic-easyeda` peer `dsh-schematic@0.1.0` 锁死版本：seam 演进要同步发版 | 低 | 同仓发版序列固定；semver 宽松化留待 API 稳定后 |
| R8 | in-box bundle 名册残留：dsh 的 OPTIONAL_BUNDLES/profile 模板若仍引用已迁出的包名会悬空 | 低 | 4.2 末项与名册摘除同 PR；`verify-optional-bundles` 类门禁会捕捉 |

## 6. 与 2026-10-13 文档的对应

- 该文档 6.2（npm 发布 + `dsh plugin add`）= 本计划 4.3；6.3（迁仓基建重建）= 本仓骨架已完成的 vitest/tsconfig/oxlint 部分，尚差 CI 流水线与文档门禁；6.5「先行债」= R1。
