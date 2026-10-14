# Agent Note: 让生成的原理图在客户端真正可用（绑定作用域、分片交付、客户端预言机）

Status: proposed — **待第三方复核**Scope: `packages/schematic/{schematic, schematic-easyeda, tool-schematic}`基准用例: 555 无稳态多谐振荡器 IR（8 器件 / 16 网标 / 19 段导线），本目录 `555-astable/`

## 阅读指引（给复核者）

- 每条问题都标了 **【实测】** 或 **【推断】**：实测表示本会话在真实 EasyEDA Pro 4.1.x 客户端上观察到，并给出原始观测；推断表示来自代码阅读，未经客户端验证——复核时请优先质疑【推断】条目。
- 第 2 节是证据台账，第 10 节列出**仍未验证**的假设（尤其是 `DeviceName.source` 语义）。
- 第 4 节是决策建议（含备选与回滚成本），第 6 节给出排序建议（M1 可拆成 M1a/M1b）。

## 1. 背景与复现

`packages/schematic` 的原理图链路是：模型给 IR → `resolveBindings` 解析 LCSC 绑定 → `layout` 补几何 →`validate` 静态门控 → `schematic-easyeda` 序列化为 V3 文档源；交付有两条实机路径：`build`（`sch_Primitive*` 逐个放置）与 `importProject`（打包 `.epro2` 交给 `importProjectByProjectFile`）。工具层 `schematic_generate` 在静态门控通过后序列化，`verify: true` 时再走 `build`。

一次 555 电路的完整失败链（全部实测）：

1. `schematic_generate(verify: true)` → `SCHEMATIC_VERIFY_UNAVAILABLE: live verification failed:easyeda bridge execute returned HTTP 500`，但工具仍返回 `ok: true`（基础设施失败被降级为 warning）。
2. 改走 `importProject` → 导入成功，画布 22 个元件全是空框，客户端日志面板刷：「发现异常数据，以下元件的 **器件** 属性有误…」「**符号** 属性有误」「**封装** 属性有误」。
3. 改用客户端自己的放置接口（`sch_PrimitiveComponent.create` / `createNetFlag` /`sch_PrimitiveWire.create`）→ 24 元件 / 19 导线 / 网表正好 7 个网络 / `sch_Drc.check` 返回 `[]`。

复现命令见附录 A。

## 2. 证据台账

### E1 工程是自带库的，放置会把器件复制进工程库 【实测】

```
放置 10 kΩ 0603（系统库 0819f05c…）后，sch_PrimitiveComponent.create 的返回：
  device     b948db94476e4027ac8953235755ec96  →  b9e00b22d20e5c23
  symbol     e23085a8f904493eb2ce369cbc1b267c  →  d0642609cce97818
  footprint  50b4943912284dab97752312e589e9e2  →  ce961dbe25a34a08
```

推论：手写 `.epro2`（只有 `CONFIG/SCH/SCH_PAGE`，无工程库文档）导入后，三类引用必然悬空。

### E2 桥接单次执行 30 s 上限 【实测】

```
{"success":false,"error":"Request 18012ce5-d294-4cab-9508-9dcdbd72b013 timed out after 30000ms"}
```

触发场景：一次 `execute` 里放 8 个器件；改成「一次一个器件」即可通过。

### E3 客户端 DRC 是可用且有效的预言机 【实测】

坏文档（导入版）：

```
[{"type":"warn","rule":"SHOWFLOATING","primitives":[{…,"name":"$3N1"}]},
 {"type":"warn","rule":"CHECKFLOATPIN","primitives":[{…,"designator":"R4","name":"2"}, …]},
 {"type":"fatalError","rule":"","primitives":[{…,"name":"$1I9"}, …]}]
```

好文档（客户端接口重建）：`sch_Drc.check(true,false,true)` → `[]`。

### E4 客户端网表只给命名网络 【实测】

`sch_ManufactureData.getNetlistFile()` 返回 `File`（需 `await f.text()`），`JSON.parse(text).designRule.netRule` 的键是**命名网络**集合，`components` 段为空；`sch_Net.getAllNets()` / `getCurrentProjectAllNets()` 在本客户端返回 `[]`。

推论：引脚级完整性只能靠 DRC（E3），网络名完整性靠 netRule。

### E5 无作用域的符号/封装查询永远 miss 【实测】

```
lib_Symbol.get(uuid, undefined)     → undefined   （系统库符号也 miss）
lib_Symbol.get(uuid, 系统库 uuid)    → {name: …}
lib_Footprint.get(uuid, undefined)  → 抛错
```

推论：`library.ts` 在未配置 `libraryUuid` 时用 `undefined` 作用域查询符号，会把合法符号判成`does not resolve`（error 级，见 `validate.ts:499-507`）。

### E6 LCSC 解析返回商城索引里的随机库副本且会漂移 【实测】

同一次会话内对 `C25804`：

```
第 1 次：device eca3f0ee51a649e898710ee6fe7bef48  (library 686654e4…)
第 2 次：device 2ba8369b8dbe439b97d11ad09f4e5740  (library 68b35344…)
第 3 次：device e6e91525ffe24849a0df5b82b2f4d56a  → 之后连 lib_Device.get 都查不到了
```

7 个器件一次解析分别落在 7 个不同库。系统库（`0819f05c4eef4c71ace90d822a990e87`）里同样有这 7 个型号，且 `lib_Device/lib_Symbol/lib_Footprint.get(uuid, 系统库)` 都能加载。个人库（`5b08508e…`）为空；`getAllLibrariesList()` 返回 `[]`。

### E7 重名工程导入被静默拒绝 【实测】

首次导入名 `555 Astable Multivibrator` 成功；同名再导 → `importProjectByProjectFile` 返回假值，`import-555.mjs` 只能报 `IMPORT_REJECTED`；改名为 `… v2` 后成功。

### E8 符号引脚几何可从 `lib_Symbol.getDocumentSource` 取得 【实测】

该源里 `PIN` 记录带 `x/y/length/rotation`，其 `ATTR` 子记录带 `Pin Name` / `Pin Number`。据此得到系统库符号的真实引脚（与本目录 IR 的端点一致）：

```
NE555(SOP-8)：1 GND(-60,-20) 2 TRIG(-60,-10) 3 OUT(-60,0) 4 RESET(-60,10)
              5 CONT(50,10)  6 THRES(50,0)   7 DISCH(50,-10) 8 VCC(50,-20)
R0603：1(-20,0) 2(20,0)      C0603：1(-20,0) 2(20,0)      C0805：1(0,20) 2(0,-20)
LED(KT-0603R 系统库)：1=A(20,0) 2=K(-20,0)   ← 与商城副本（1=K/2=A）相反
```

### E9 商城副本与系统库副本的符号几何可以不同 【实测】

同型号的 555 在商城副本里是「1/2/4/5/6 在左、3/7/8 在右」，在系统库里是「1–4 在左、5–8 在右」。LED 的 A/K 引脚号在两处相反。合成坐标（±80、间距 20）与两者都不符。

### E10 `getComponentDetail` 不能当作有效性预言机 【实测】

坏文档（导入版）与好文档（客户端重建）对它都抛「获取器件详情失败」。不要用它判有效性。

### E11 桥接在"无活动页 / 弹窗 / 多窗口"状态下大面积 500 【实测】

`edaWindowCount: 2` 时 `lib_*` 与 `dmt_Project.*` 全 500，`dmt_Schematic.getCurrentSchematicPageInfo`返回 `undefined`；关闭多余窗口、把页面激活后恢复正常。这解释了为何同一段脚本时好时坏。

## 3. 问题清单

| # | 问题 | 证据 | 根因（位置） |
| --- | --- | --- | --- |
| R1 | `verify` 实机路径必失败 | E2 E5 E11 | `schematic-easyeda/src/build.ts:167` `lib_Device.get(uuid)` 无作用域 |
| R2 | 导入后元件空框、三类属性报错 | E1 E9 | `serialize.ts:159` 工程包无工程库文档；`index.ts:181` `importProject` 被当作交付路径 |
| R3 | 一次 build 超时 | E2 | `build.ts:274-277` 全部图元一次 `execute` |
| R4 | 校验"通过"而客户端是坏的 | E3 E4 | `readback.ts:273-328` 只比对序列化源文本，不读客户端网表/DRC |
| R5 | 绑定不可复现 | E6 | `schematic/src/index.ts:290-299` 作用域只留在内存 map，IR 只有裸 uuid |
| R6 | 合法符号被判 error | E5 | `library.ts:98-100` 未配置时作用域为 `undefined`；`validate.ts:499-507` 把 miss 当不存在 |
| R7 | 绑定到随机库副本 | E6 | `library.ts:181-211` `resolveByLcsc` 无库偏好 |
| R8 | 自动布线落不到引脚 | E8 E9 | `schematic/src/layout.ts:34-40, 285-302` 合成引脚坐标 |
| R9 | 重名导入静默失败 | E7 | `build.ts:523-549` 只回 `SCHEMATIC_IMPORT_REJECTED` |
| R10 | 回退关掉用户全部标签页 | 代码阅读 | `build.ts:475-489` |
| R11 | 无活动页导致全接口失败 | E11 | build 路径未确保/创建并激活目标页 |

## 4. 决策建议

### D-1 IR 作用域字段：推荐「三个 per-binding 字段 + 可选 `libraryUuid` 兜底」

- **理由**：内部模型已经是按 kind 分作用域的——`SchematicResolvedPart` 分别返回`deviceLibraryUuid/symbolLibraryUuid/footprintLibraryUuid`（`library.ts:200-210`），`resolveBindings` 已维护三张 scope 表（`schematic/src/index.ts:268-293`），resolver 签名本身就是`resolveSymbol(uuid, libraryUuid)`。三字段=照抄既有模型，**不需要推导**。客户端的 `association`结构上允许 symbol 与 footprint 落在不同库，用单字段就得写"从 device 关联推 symbol 作用域"的猜测。
- **实现约束**：三者相同时只写 `libraryUuid`，避免文档臃肿；旧 IR 无字段时按 D-3 降级。
- **备选**：单一 `libraryUuid`。省两个字段，但要么加推导逻辑，要么在跨库场景出错。
- **回滚成本**：低（可选字段，序列化可回退为不写）。

### D-2 `.epro2` 导入：推荐「M1 先降级为源文件归档，自包含放 M4」

- **理由**：自包含需要逆清 `.epru` 里 LIB 文档的形状与关联写法，目前无文档无样本，属开放式逆向，不该挡住 P0；而当前导入路径是**静默产出坏图**（E1/E9），比不提供更危险。降级只是语义+文档变更。
- **M4 的做法（先定死，避免"猜格式"）**：让客户端自己放置 1 个器件后`sys_FileManager.getDocumentSource()` + `getProjectFile()` 取**客户端产出的包**，与 DSH 的包逐记录对照，用真实样本锚定 LIB 文档格式，再决定是否内嵌。
- **备选**：M1 就做自包含。工作量与风险不可控，且不影响"下一张图能用"。
- **回滚成本**：低。

### D-3 无客户端时：推荐「默认要求客户端交付，拿不到即 `ok:false`；离线需显式 `deliver:'source-only'`」

- **理由**：目标是"生产可用"，而"可用"只能在客户端被证明（DRC 空 + 网表一致）。今天 `verify` 是opt-in，缺省路径产出文本且 `ok:true`，`liveVerify` 把基础设施失败降级为`SCHEMATIC_VERIFY_UNAVAILABLE`（warning），**这正是本次事故的形态**。Agent 会走最便宜的路，缺省必须是诚实的那条。
- **具体形态**：`deliver: 'client'（默认）| 'source-only'`；`source-only` 结果带`SCHEMATIC_SOURCE_UNVERIFIED`，渲染文案禁止出现"验证通过"；`verify: true` 等价于 `deliver:'client'`。
- **代价**：行为变更，需同步改工具描述、system prompt 指引与既有测试期望。
- **备选**：保持缺省 source-only，但在结果里显式标 `delivered:false`。改动小，但缺省仍然"看起来成功"。
- **回滚成本**：中（涉及工具契约与测试）。

### D-4 layout 吸附：推荐「容差内吸附 + 超差报 `WIRE_NOT_ON_PIN`」

- **理由**：完全重写显式端点会破坏 `layout.ts` 头部声明的"显式几何原样透传"契约——本次能把导线画在真实引脚上正是靠它；静默搬移还会让 idempotence 难以推理。另一端也不行：模型给坐标常有1–2 单位偏差，纯报错会把常见情况变啰嗦。
- **具体形态**：仅在「有绑定 + 拿到符号几何 + 偏差 ≤1 网格单位（远小于 20 单位引脚间距）」时吸附；超差保留原值并由 `WIRE_NOT_ON_PIN` 报 error。
- **备选**：只在端点缺失时生效（更保守，但解决不了模型给了近似坐标的情况）。
- **回滚成本**：低（吸附是 layout 内部策略）。

## 5. 改动设计

### D1 库作用域进入 IR（R1 R5 R6 R7）

```ts
interface SchematicIrComponent {
  deviceUuid?: string;  symbolUuid?: string;  footprintUuid?: string
  deviceLibraryUuid?: string;  symbolLibraryUuid?: string;  footprintLibraryUuid?: string  // 新增
}
```

- `resolveBindings` 把三个作用域写入 IR（现在只进内存 map）。
- 序列化：`serialize.ts` 的 `emitComponent` 除 `Device/Symbol/Footprint` 外补 `<Kind>Library` ATTR；**优先**直接写成客户端持久化形状的 `DeviceName/SymbolName/FootprintName`（`{"name","source","uuid"}`），但 `source` 语义必须先由第 10 节的 golden 锚定（见 Q1）。
- live build：`build.ts:167` → `eda.lib_Device.get(c.deviceUuid, c.deviceLibraryUuid)`。
- 校验：`queryUuid(kind, uuid, scope)` 的 scope 取自 IR 字段；无 scope 时**不发起查询**，直接降级为"未验证"（warning），不得报 `does not resolve`（error）。

### D2 解析策略：系统库优先 + 三元组验证（R6 R7）

`EasyEdaLibrary` 增加系统库探测并缓存 `lib_LibrariesList.getSystemLibraryUuid()`；`resolveByLcsc`：

1. 系统库作用域下 `lib_Device.getByLcscIds(code, systemUuid)`，miss 再 `search(mpn, systemUuid)`；
2. 对候选逐个验证 `lib_Device/lib_Symbol/lib_Footprint.get(uuid, 同一作用域)` **全部可加载**；
3. 全部不成立才回退到当前无作用域行为，并标 `unverified: true`；
4. 返回值携带三个作用域（字段已存在）。

引擎 `Config.libraryUuid` 从"无默认"改为"默认探测到的系统库"。

### D3 分片交付（R3 R11）

`buildIntoEasyEda` 把单次 `execute` 拆成多批，每批独立处理 HTTP 500 与`timed out after 30000ms`（按可重试处理）：

```
page   ：确保工程与页面存在（createSchematic/createSchematicPage），openDocument 并校验 active
parts  ：每器件一次 execute（复制进工程库较慢），失败重试 ≤2，退避 500ms
flags  ：每批 4 个
wires  ：每批 4 段
校验段 ：DRC + 网表（见 D5）
```

**幂等键必须是 `(x,y)` 位置，不能是位号**：`create` 与 `modify` 之间无事务，超时窗口会留下带自动位号（`R5`/`C4`/…）的元件；按位号判重会重复放置——本次已实测踩到。

### D4 交付路径收敛（R2）

- `schematic_generate` 的交付 = `build`；`deliver:'source-only'` 时明确标注未验证（见 D-3）。
- `importProject` 降级为导出/归档用途；工具描述与文档不得暗示它能得到可用原理图。
- M4（可选）：把工程库文档写进 `.epro2`，做法见 D-2。

### D5 客户端预言机（R4）

build 后按能力探测取真值，全部并入 findings：

| 来源 | 提取 | finding | 级别 |
| --- | --- | --- | --- |
| `sch_Drc.check(true,false,true)` | `{type:'fatalError'}`（实测即"器件属性有误"批次） | `SCHEMATIC_EDA_ABNORMAL_DATA` | error |
| 同上 | `rule:'CHECKFLOATPIN'` | `SCHEMATIC_EDA_FLOATING_PIN` | error |
| 同上 | `rule:'SHOWFLOATING'` | `SCHEMATIC_EDA_FLOATING_NET` | warning |
| `sch_Net.getAllNets` → `getCurrentProjectAllNets` → `getNetlistFile()`（首个有返回者） | 网络名集合 | 与 IR 网表对账 | error |
| `sch_PrimitiveComponent.getAll()` / `sch_PrimitiveWire.getAll()` | 位号、数量 | 与 IR 计数对账 | error |

必须区分「预言机不可用」（warning）与「预言机说 OK」（才可声称已验证）。现 `build.ts:378-403` 的`advisoryDrc` 只做 JSON 文本拼接、且恒为 warning，需替换为结构化解析。

### D6 layout 使用真实符号引脚几何（R8）

`SchematicLibrary` 新增可选方法（缺失时保持现状）：

```ts
resolveSymbolPins?(uuid: string, libraryUuid?: string): Promise<{
  pins: readonly { number: string; name?: string; x: number; y: number; length?: number; rotation?: number }[]
} | undefined>
```

EasyEDA 实现：`lib_Symbol.getDocumentSource(uuid, lib)` 解析 `PIN` + `Pin Number`/`Pin Name`（E8 已验证可行）。`layout.ts` 在有绑定且几何可得时改用真实偏移（尊重 rotation/mirror），否则退回合成坐标；`validate.ts` 新增 `WIRE_NOT_ON_PIN`（显式端点不在绑定符号引脚上 → error），并按 D-4 的容差规则与吸附配合。顺带可用 `Pin Type` 缓解 `ELECTRIC_TYPE_UNKNOWN`。

### D7 稳健性与破坏性操作（R9 R10 R11）

- 导入 `IMPORT_REJECTED` 时先探测同名工程，自动加 ` v2` 重试一次；仍失败则把"疑似同名"写进 finding。
- `renderImportScript` 的关标签页回退改为默认关闭，需显式 `allowTabClose: true`。
- 各阶段失败补可诊断原因（HTTP 状态 + 客户端错误体），不要把 `undefined` 折叠成通用错误码。
- build 前校验活动页；无活动页时报 `SCHEMATIC_BUILD_NO_ACTIVE_PAGE`（error）而不是让后续全 500。

## 6. 里程碑与排序建议

推荐把 M1 拆成两半，让"下一张图就能用"提前落地：

- **M1a（不碰 IR 契约）**：D2 + D3 + D5。三者做完，生成链路即可产出可用原理图——本次实测证明「系统库绑定 + 分片放置 + DRC 验真」得到 24 元件 / 19 导线 / 7 网络 / DRC 空。
- **M1b（碰 IR 契约）**：D1 + 校验降级语义。解决**可复现性**（不再随商城索引漂移，E6）与 build查询的确定性（`build.ts:167` 需要知道作用域）。属"防复发"，不是"能用"的前置。
- **M2（P1）**：D6 符号几何 + `WIRE_NOT_ON_PIN`。
- **M3（P2）**：D7 可诊断错误、导入改名、破坏性回退收敛、活动页前置检查。
- **M4（可选）**：D4 的工程库文档内嵌，使 `.epro2` 自包含。

## 7. 测试策略

**单元（无客户端）**

1. `resolveBindings` 把三个作用域写进 IR；旧 IR 无作用域 → warning 而非 error。
2. `resolveByLcsc` 优先系统库；系统库候选符号缺失时不采用；回退路径标 `unverified`。
3. `layout` 提供符号几何时端点等于符号偏移（含 rotation 90/180 与 mirror）；容差内吸附、超差保留。
4. `validate` 对"端点不在绑定引脚上"报 `WIRE_NOT_ON_PIN`。

**fake bridge 回归（复刻本客户端真实行为，每条对应一个 E）**

5. 放置时把 device/symbol/footprint 换成工程库新 uuid（E1）→ 断言引用的是副本。
6. `lib_Symbol.get(uuid, undefined)` 返回空、带作用域返回对象（E5）→ 断言不发无作用域符号查询。
7. 单次 execute 返回 `timed out after 30000ms`（E2）→ 断言分片、可续跑、**不重复放件**；假响应里带自动位号 `R5`，用来钉死"按位号判重会重复"这个回归。
8. 重名导入返回假值（E7）→ 断言自动改名重试并给出可诊断 finding。
9. DRC 返回 `[{type:'fatalError'},{rule:'CHECKFLOATPIN'}]`（E3）→ 断言升为 error 且 `ok === false`。
10. 无活动页（E11）→ 断言报 `SCHEMATIC_BUILD_NO_ACTIVE_PAGE` 且不发出无作用域查询。

**env 门控 live e2e（有客户端时）**

11. 生成 555 电路 → build → 断言 DRC 空、netRule 集合等于 IR 网络集合、元件/导线计数一致；并把"导入路径"的坏结果（E1+E3 的 fatalError）固化为反例。

## 8. 验收标准

- "已交付"必须来自客户端真值：`sch_Drc.check` 为空 **且** 网表集合与 IR 一致；源文本 round-trip 仅作辅助。
- 8~20 器件不再因 30 s 上限失败；中途失败可续跑且不产生重复元件。
- 绑定带作用域，同一 IR 重复运行得到同一组 uuid（E6 不再发生）。
- 无客户端时不得给出"验证通过"。
- 基准：本目录 555 电路 DRC 空、7 个网络、24 元件 / 19 导线。

## 9. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| LIB 文档格式未知（E1 的下游） | M4 可能长期做不成 | M1 只降级不做；M4 先用客户端自产包做样本 |
| 客户端版本差异（DRC 结构、`sch_Net` 可用性） | 预言机误判 | 能力探测 + 降级；"不可用"≠"通过" |
| `DeviceName.source` 语义未证实（Q1） | 序列化可能写错 | 先固化 golden 再写协议；写错也不影响 build 路径 |
| create/modify 非事务 | 续跑重复放件 | 幂等键用位置（D3） |
| D1/D5/D6 触及契约 | 回归面大 | M1a/M1b 拆分，逐步可回滚 |

## 10. 开放问题（复核请重点看这里）

- **Q1**：`DeviceName/SymbolName/FootprintName` 里的 `source` 是否就是库 uuid？目前只有"客户端放置后读源"能回答。计划：写一条录制测试，放置 1 个系统库器件后 `getDocumentSource()`，把该形状固化为golden，再决定 D1 的序列化写法。**在此之前不要按猜测写协议。**
- **Q2**：`lib_Footprint.get(uuid, undefined)` 是无作用域必然抛错，还是仅某些 uuid 如此？需要多样本。
- **Q3**：`sch_Net.getAllNets()` 在何种条件下有返回（本项目返回 `[]`）？若有条件，能否作为引脚级预言机替代/补充 DRC。
- **Q4**：同一型号在商城副本与系统库副本的符号几何不同（E9），解析策略是否应把"系统库优先"写成硬规则，还是允许用户/工程配置库偏好？
- **Q5**：`fatalError`（空 rule）的具体判据是什么？本次它精确命中了"器件/符号/封装属性有误"的元件，若能确认判据，可直接作为 D5 的主判据。

## 附录 A 复现命令

工作区：`C:\Users\yanwuning\Documents\deepseek-harness\default-workspace\555-astable\`

```powershell
# 1) 桥接与客户端状态（E11）
Invoke-RestMethod -Uri "http://127.0.0.1:49620/health"      # 关注 edaWindowCount / edaConnected

# 2) 离线复现绑定漂移与系统库对照（E6）—— 见 build-555.mjs 的 --refresh 与 PINNED 常量
node .\build-555.mjs            # 固定系统库绑定出包
node .\build-555.mjs --refresh  # 经客户端重解析（观察 uuid 漂移）

# 3) 复现"导入产出坏图"（E1/E9）再导入 v2 工程
node .\import-555.mjs --name="555 Astable Multivibrator v3"

# 4) 复现"正确方式"（E3/E4）：分片 build + 客户端 DRC/网表验真
node .\build-in-client.mjs build --page=<页 uuid>

# 5) 复核者可直接查询客户端真值
#    sch_Drc.check(true,false,true) / sch_ManufactureData.getNetlistFile() / sch_PrimitiveComponent.getAll()
```

## 附录 B 本次基准记录（重建后的 555）

```
工程 555 Astable Multivibrator v2   uuid 97bf601b057748778d17130905adcd5c
页面 P9                              uuid 1b72fbda93e8b682
components 24  = 8 器件（U1 R1 R2 R3 C1 C2 C3 D1）+ 16 网标
wires 19
nets  OUT / LED_A / GND / VCC / T / CTRL / DISCH
drc   []
```

变更历史：本文档首版列出问题清单与改动设计；第二版补入 E1–E11 证据台账、决策建议（D-1…D-4）与 M1a/M1b 排序建议，供第三方复核。
