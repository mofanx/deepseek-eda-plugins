---
description: "EasyEDA 文档源引擎插件：经 ctx.schematic 注册中心，把原理图 IR 投影为 EasyEDA V3 SCH_PAGE 文档源文本。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-eda-easyeda

[English](README.md) | 中文

## 概述

`dsh-plugin-eda-easyeda` 是把校验过的原理图 IR 序列化为 EasyEDA V3 文档源（`SCH_PAGE` 日志记录，客户端持久化 schema）的引擎插件。当组合需要产出可导入 EasyEDA 的源文本时，与 `dsh-plugin-eda-sch` 一起加载它；插件以引擎 id `easyeda` 注册自身。除序列化外，它还能经 run-api-gateway bridge 把 IR 交付进运行中的 EasyEDA 客户端：逐图元写入新建的图纸页（`engine.build`），或把生成的 `.epro2` 包作为新工程导入（`engine.importProject`）。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

与接缝服务一同加载本插件；挂载时注册 `easyeda` 引擎与 `easyeda` 工作区库，fiber 卸载时一并注销。

```yaml
- name: '@deepseek-ai/dsh-plugin-eda-sch'
- name: '@deepseek-ai/dsh-plugin-eda-easyeda'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `clientId` | `dsh` | 写入每行 `DOCHEAD` 的最终一致性客户端标签 |
| `bridgeHost` | `127.0.0.1` | run-api-gateway bridge 的探测主机 |
| `bridgeTimeoutMs` | `30000` | bridge 调用的单请求超时 |
| `bridgeQueryTimeoutMs` | `10000` | `lib_*` 读取调用的单请求超时；缺省取 `bridgeTimeoutMs` |
| `bridgeTimeoutStreakLimit` | `3` | 连续超时多少次后打开 fail-fast 熔断 |
| `bridgeCircuitCooldownMs` | `15000` | 半开探针重试客户端前的冷却时长 |
| `advisoryDrc` | `true` | 构建后把 BETA `sch_Drc` 明细收集为建议性 finding |
| `libraryUuid` | （未设置） | 限定每次库查询的工作区库 UUID；未设置时使用客户端默认范围 |

产出文本是 EasyEDA 文档源：每个 IR 图纸页对应一段以 `DOCHEAD` 开头的日志文档，随后是 `CANVAS`、`COMPONENT`/`ATTR`、`WIRE`/`BUS` 及其 `LINE` 线段与图纸 `ATTR` 记录，每行为 `||` 连接的一对 JSON 对象。`serializeEasyEdaProject` 还会在图纸外包裹 `CONFIG` 与 `SCH` 文档，凑齐 `importProjectByProjectFile` 所需的 `.epro2` 导入载荷。

实机构建/导入路径需要在本包与运行中的 EasyEDA 客户端之间跑 run-api-gateway bridge 服务。其依赖 `dsh-plugin-eda-core` 以 `dsh-eda-bridge` bin 形式分发——`npx dsh-eda-bridge`（或 `node node_modules/@deepseek-ai/dsh-plugin-eda-core/bin/dsh-eda-bridge.mjs`）启动一个 localhost 中继：绑定 49620–49629 中第一个空闲端口，提供 `GET /health`（`{service:"easyeda-bridge", bridge:"dsh-eda-bridge", edaConnected…}`）与 `POST /execute`，在 `/eda` 接受扩展的 WebSocket 注册、在 `/agent` 接受 agent 连接，首帧为 `{type:"handshake", service:"easyeda-bridge"}`。已有兼容 bridge 应答时二次启动直接退出；占用同服务名的异实现（`bridge` 健康字段不同的不兼容协议）会导致启动失败，除非传 `--force`。EasyEDA 客户端侧需安装并加载 `run-api-gateway` 扩展——它扫描同一端口段发现 bridge。

`scripts/live-verify.mjs` 不依赖测试框架验证整条实机链路：bridge 发现、真实 `lib_Device` LCSC 查询、`resolveSymbolPins`，以及一次单器件 `.epro2` 导入——读回源与 IR 对账（`--check-defect` 注入引脚偏移并要求检出 `WIRE_NOT_ON_PIN`）。

```sh
node node_modules/@deepseek-ai/dsh-plugin-eda-easyeda/scripts/live-verify.mjs [--lcsc C25804] [--name <project>] [--check-defect]
```

<a id="understand-the-implementation"></a>
## 理解实现

序列化器（共享于 `dsh-plugin-eda-core`）是按 4.1.x 持久化 schema 输出的纯投影：`x`/`y` 键且 Y 轴相对 `SCH_*` API 取反，`COMPONENT` 带 `attrs`，导线几何落在以 `lineGroup` 绑定的独立 `LINE` 记录中，页到原理图的绑定经页 `META` 记录。器件附带绑定 `ATTR` 行（`Device`、`Symbol`、`Footprint`、`Designator`），每条导线附带命名其图元的 `NET` `ATTR`；图纸引脚属符号数据，不产出。它不做校验——接缝门禁先行——也不编造库引用：IR 必须已携带可解析的 `deviceUuid`/`symbolUuid`/`footprintUuid`。

两条交付路径建立在投影之上。`buildIntoEasyEda`/`engine.build` 在打开的工程中逐 sheet 新建页面、激活并校验活动文档身份后才放置图元——器件每次桥接执行一个，旗标/导线按有界批量执行，重试以位置作幂等键，随后以读回与客户端预言机（计数、网络名、`sch_Drc`）校验——绝不写入恰好打开着的文档。`importIntoEasyEda`/`engine.importProject` 把 `serializeEasyEdaProject` 的产物打成 store 方式 zip（`project2.json` 加一个 `*.epru` 日志），交给 BETA `sys_FileManager.importProjectByProjectFile`，遇重名工程时自动加后缀改名。归档包会嵌入每个被引用 `DEVICE`/`SYMBOL`/`FOOTPRINT` 文档的工程本地副本——由 `collectProjectLibrary` 经桥接实时抓取——并把器件 `ATTR` 值重写为本地 uuid，这是客户端渲染器件图形的前提；抓取失败降级为未解析框并以 `SCHEMATIC_IMPORT_LIBDOC` 上报。`netflag`/`netport` 组件经按名搜索的旗标器件（`Ground-GND`、`Power-<net>`、`Netport`）走同一管线绑定；`short`/`nonelec` 类无符号绑定，保持未解析。打开导入工程可能需要先关闭当前工程的文档页签；该回退会改动用户的编辑器布局，只在显式 `allowTabClose` 选项下执行，否则以 `SCHEMATIC_IMPORT_OPEN_FAILED` 报告阻塞的页签数。导入成功后只重开归档实际发出的页面，并把读回源与 IR 的命名、网络对账。

本插件还注册 `EasyEdaLibrary`（共享于 `dsh-plugin-eda-core`），即 `ctx.schematic.registerLibrary` 背后的工作区库适配器。查询在运行中客户端的扩展运行时内经 run-api-gateway bridge 执行：`resolveByLcsc` 在系统库作用域（或已配置的 `libraryUuid`）下经 `lib_Device.getByLcscIds`、再回退 `lib_Device.search` 解析 LCSC 料号，并先验证器件的符号/封装关联能在各自所属作用域加载再发出；`resolveDevice`/`resolveSymbol`/`resolveFootprint` 则经 `lib_Device.get`/`lib_Symbol.get`/`lib_Footprint.get` 核实已声明 UUID——无作用域的符号/封装查询只解析客户端默认作用域，按"未验证"报告而非误判为 miss——`resolveSymbolPins` 从符号库文档源（`lib_Symbol.getDocumentSource`，未收录但已实机验证）读取绑定符号的真实引脚几何，供布局阶段落点。这些接口均为 BETA，适配器将其隔离：客户端缺失或载荷漂移表现为查询不可达或未命中，绝不在门禁内崩溃。

<a id="model-experience"></a>
## 模型体验

间接地，经 `dsh-plugin-eda-sch-gen`：本插件注册 `easyeda` 引擎，自身不产出模型可见文本；模型经工具输出看到文档源。

#### KV Cache 影响

无直接失效；请求前缀的变化由工具包承担。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了本提供方自身不完整之处，均为当前包约束。

- **库 API 不暴露焊盘清单** —— `lib_Footprint.get` 不返回焊盘枚举，EasyEDA 解析的封装只验证存在性，`PIN_PAD_MISMATCH` 对它们不运行。
- **beta API 面** —— 库适配器与在线构建/导入路径依赖 EasyEDA beta 接口，语义可能变化；接缝将其视作适配器内部细节，漂移降级为查询失败而非崩溃。
- **导入依赖实机库抓取** —— 器件图形可解析是因为 `collectProjectLibrary` 把每个被引用 `DEVICE`/`SYMBOL`/`FOOTPRINT` 文档的工程本地副本嵌入了 `.epro2`；客户端无法触达库时（离线工作区、作用域无权限、文档抓取失败）降级为未解析框并以 `SCHEMATIC_IMPORT_LIBDOC` 上报。`short`/`nonelec` 组件无符号绑定，保持未解析。
- **导入工程的文档模型不完整** —— 在导入工程的页面上，`createSchematicPage` 在页实际创建后才抛错（脚本以页列表差集兜底恢复 uuid），`sch_PrimitiveComponent.create` 可能挂起超过页内超时、表现为 bridge 执行错误。对导入工程做实机 `build` 因此不可靠；原生工程不受影响。
- **`setDocumentSource` 无法新增记录** —— 客户端 4.1.71 只接受对既有记录的值编辑，拒绝一切追加记录，因此它不是交付路径；打开文档用 `build`，新工程用 `importProject`。
- **LCSC 目录结果不确定** —— `lib_Device.getByLcscIds` 多次调用可能返回不同的列表条目，部分条目不带符号/封装关联；`resolveByLcsc` 先查系统库作用域，并验证每条关联能在其所属作用域加载，不成立的关联不发出，校验把其余 UUID 报告为未验证而非绑定漂移的商城副本。
- **扩展网关串行执行** —— 客户端侧 API 调用挂起（实测发生于 `lib_Device.getByLcscIds`）会阻塞之后所有 `execute`，直到编辑器页面刷新；bridge 超时不会释放页面侧队列。为避免一次挂起拖住所有调用方，`bridgeTimeoutStreakLimit` 次连续超时后打开 fail-fast 熔断：之后调用立即返回 `SCHEMATIC_BRIDGE_CIRCUIT_OPEN`，直到 `bridgeCircuitCooldownMs` 后半开探针确认客户端恢复响应。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与未定方向，不具权威性——已交付行为、限制与理由以上文各节为准。

#### 待定：冷工作区库文档

`.epro2` 导入已验证携带工作区可解析 UUID 的 `CONFIG`/`SCH`/`SCH_PAGE` 日志；在缺少所引条目的工作区上内嵌 `DEVICE`/`SYMBOL`/`FOOTPRINT` 文档以实现自足导入尚未验证，留待后续。

</details>
