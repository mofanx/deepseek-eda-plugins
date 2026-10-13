# 迁移计划：dsh 内置 schematic 包 → 独立插件仓

Scope: `deepseek-harness/packages/schematic/*` → 本仓。依据：`deepseek-harness/packages/schematic/docs/2026-10-13-schematic-flow-and-externalization.md` 第 6 节方案。本文是 prep 结论：包结构、依赖处置决策、被 dsh 消费的 API surface、迁移清单、风险评估。

## 1. 包结构决策：保留分包，不合并

| 包 | npm 名 | 保留独立包的理由 |
|---|---|---|
| `packages/schematic` | `@deepseek-ai/dsh-schematic` | Service Definition。`declare module '@deepseek-ai/cordis'` 的 `ctx.schematic` 类型合并必须以包为单位存在；其他 EDA Provider 也要依赖它。 |
| `packages/schematic-easyeda` | `@deepseek-ai/dsh-schematic-easyeda` | Provider。EasyEDA 专用（bridge、序列化、库绑定）；未来加 KiCad/Altium provider 时并行存在。 |
| `packages/tool-schematic` | `@deepseek-ai/dsh-tool-schematic` | Consumer。模型工具面，独立于引擎演进（如加 MCP 分发形态时不需要动引擎包）。 |
| `packages/schematic-bundle` | `@deepseek-ai/dsh-schematic-bundle` | 安装层。`dsh.bundle.patch` 声明是 `dsh plugin add` 激活层的唯一依据；用户只装这一个包。 |
| `packages/bridge` | `@deepseek-ai/dsh-schematic-easyeda-bridge` | 进程外组件：bin 分发，无 dsh 依赖，可独立发版。live build/import/verify 的前置。 |

不合并的原因：接缝本身就是分包的语义（Service Definition / Provider / Consumer），合并会让非 EasyEDA 消费者和后续 Provider 被迫携带无关依赖。

## 2. 依赖分析（按 src 实际 import 枚举）

### 2.1 运行时依赖处置

| 导入符号 | 来源包 | 用法 | npm 现状 | 处置 | 理由 |
|---|---|---|---|---|---|
| `Context`, `Service` | `@deepseek-ai/cordis` | 运行期类（service 包 extends Service、apply(ctx)） | **已发布 4.0.4**（仓内 4.0.5-alpha.1） | **peerDependencies** | 类身份必须与宿主共享（instanceof、Service 子类、Context 原型链） |
| `z` | `@deepseek-ai/schemastery` | `Config` schema 值 | **已发布 3.18.4**（仓内 3.18.5-alpha.1） | **dependencies** `^3.18.4` | cordis 经 `runtime.Config['~standard'].validate(config)` 走 Standard Schema 协议消费（`vendor/cordis/src/fiber.ts:53`），不做 instanceof 检查，实例无关，无需 peer |
| `HarnessError` | `@deepseek-ai/dsh-llm` | `SchematicError` 的基类 | **已发布 0.0.1-rc.1**（仓内 0.2.1-alpha.2） | **peerDependencies** | 错误类身份：宿主侧 instanceof/类型收窄依赖同一份 HarnessError |
| `deadline`, `timeoutOf`, `TimeoutReason` | `@deepseek-ai/dsh-timeout` | bridge.ts 超时/熔断（纯工具） | **已发布 0.0.1-rc.1** | **peerDependencies** | 无单例问题，本可 dependencies；保持与原 repo 一致的 peer 声明，由宿主安装提供 |
| `defineTool` | `@deepseek-ai/dsh-tools` | 工具注册工厂 + `ctx.tools` 注入 | **已发布 0.0.1-rc.1** | **peerDependencies** | 注入的是宿主的 tools 服务；defineTool 产物由宿主注册器消费 |
| `ctx.systemPrompt` | `@deepseek-ai/dsh-system-prompt` | `inject` 成员 + `ctx.systemPrompt.section()` 运行期调用 | **已发布 0.0.1-rc.1** | **peerDependencies** | 运行时注入依赖，非纯类型 |
| `ContentBlock`, `ToolCallId` | `@deepseek-ai/dsh-llm` | 类型 | — | 随 dsh-llm peer 覆盖 | 类型级 |
| `JsonValue` | `@deepseek-ai/dsh-util-values` | 仅类型（findings locator） | **未发布** | **最小提取** | 单类型别名，提取为本仓 `types.ts` 内的 `type JsonValue`，删除该依赖 |

### 2.2 测试依赖处置（全部 devDependencies）

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

- [ ] **恢复 bridge-server.mjs**：唯一无源码副本的资产；scratch 文件已删，须从运行中进程/会话记录恢复，或按 `bridge.ts` 契约重写（~200 行 Node HTTP+WS relay）。放入 `packages/bridge/bin/`。
- [ ] **复制 src+tests**：`packages/schematic/{schematic,schematic-easyeda,tool-schematic,schematic-bundle}/{src,tests}` → 本仓对应包。建议 `git filter-repo`/`git mv` 保历史，或直接复制后单 commit 标注来源 hash（`dsh@38db9a72` 起）。
- [ ] **删除 `dsh-util-values` 依赖**：tool-schematic `index.ts` 的 `JsonValue` import 改本地类型别名。
- [ ] **fixtures**：`schematic-easyeda/tests/fixtures/`（layout-golden.eeda、imported .epro2 等）一并迁移；live-e2e.spec.ts 保留但默认 exclude（需实机）。
- [ ] **README 双语**：随包迁移 `README.md`/`README.zh.md` 与 `locale/`、`icon.svg`。

### 4.2 基建与验证

- [ ] `pnpm install`：peers 经 devDependencies 镜像装 npm 版；**核对 0.0.1-rc.1 的 API 面**——`defineTool`、`ctx.systemPrompt.section`、`HarnessError`、`deadline/timeoutOf/TimeoutReason` 是否在 rc.1 已存在；不在则 devDeps 改 `link:../deepseek-harness/packages/...`（见 5-R2）。
- [ ] `pnpm run build`（tsc -b）、`pnpm run test`（vitest 源平面）、`pnpm run test:coverage`（per-file 100 门禁沿用）、`pnpm run lint`。
- [ ] **真实组合测试保留**：cordis Loader + 三包 patch 的非单测组合验证（测试基建已含 cordis-plugin-loader/-include devDeps）。
- [ ] `pnpm publish` 顺序：`dsh-schematic` → `dsh-schematic-easyeda` → `dsh-tool-schematic` → `dsh-schematic-bundle` → `dsh-schematic-easyeda-bridge`（内部依赖按已发布版本号）。
- [ ] **dsh 仓清理**：从 `packages/schematic/` 摘除、OPTIONAL_BUNDLES/可选 bundle 名册、tool-catalog、profile patch 引用、文档链接改指外部仓；in-tree 副本删除或保留为开发镜像（建议删除，避免双源漂移）。

### 4.3 分发验证

- [ ] `dsh plugin --profile demo add @deepseek-ai/dsh-schematic-bundle` 实装 → `dsh --profile demo --dump-config` 确认层生效 → 会话内 `schematic_generate` 可用。
- [ ] bridge bin 分发路径：`npx @deepseek-ai/dsh-schematic-easyeda-bridge` 或随 bundle 文档指引。

## 5. 风险评估

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | **bridge-server.mjs 源码已失** | **高** | 运行中进程仍在 49620——优先从 d3 会话/进程内存恢复；否则按 `bridge.ts` 契约重写并回归 live-e2e。**这是唯一硬阻塞**。 |
| R2 | **npm dsh-* 版本漂移**：已发布 0.0.1-rc.1 vs 仓内 0.2.1-alpha.2，`defineTool`/`systemPrompt.section`/`timeoutOf` 等 API 可能在 rc.1 缺位或语义不同 | **高** | 开发期 devDeps 用 `link:` 指向 sibling deepseek-harness 检出（pnpm-workspace.yaml overrides）；正式发布等 dsh 0.2.x 上 registry，或钉 rc.1 API 后实测 |
| R3 | schemastery 双实例：plugin 的 Config 与 cordis 内部 schemastery 版本不同 | 低 | 已核实 cordis 走 `~standard` 协议无 instanceof（`fiber.ts:53`）；dep `^3.18.4` 即可 |
| R4 | peer 解析语义：`dsh plugin add` 的祖先解析规则要求 peer 在宿主运行时可见——profile 独立 node_modules 下 `dsh-llm` 等需经 dsh 安装侧解析而非 profile 本地装 | 中 | publish.md 规则已确认该机制；实装验证（4.3）覆盖；不要在 profile 里手动 `add` peer 包以免遮蔽宿主实例 |
| R5 | live-e2e 依赖实机 EasyEDA 无法进 CI | 中 | 保留 spec 默认 exclude + 人工验证流程；README 标注 |
| R6 | 双仓过渡期 API 漂移：IR/engine 类型在 dsh 侧仍被 app-boot/system-prompt/tool-catalog 引用 | 中 | 迁出后 dsh 侧引用全部删除（4.2 末项）；过渡期以 dsh 仓为权威源，本仓为镜像，单向同步 |
| R7 | `schematic-easyeda` peer `dsh-schematic@0.1.0` 锁死版本：seam 演进要同步发版 | 低 | 同仓发版序列固定；semver 宽松化留待 API 稳定后 |
| R8 | in-box bundle 名册残留：dsh 的 OPTIONAL_BUNDLES/profile 模板若仍引用已迁出的包名会悬空 | 低 | 4.2 末项与名册摘除同 PR；`verify-optional-bundles` 类门禁会捕捉 |

## 6. 与 2026-10-13 文档的对应

- 该文档 6.2（npm 发布 + `dsh plugin add`）= 本计划 4.3；6.3（迁仓基建重建）= 本仓骨架已完成的 vitest/tsconfig/oxlint 部分，尚差 CI 流水线与文档门禁；6.5「先行债」= R1。
