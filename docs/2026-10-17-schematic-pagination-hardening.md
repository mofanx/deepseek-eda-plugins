# 原理图自动分页与布局可读性加固

Status: j3 cross-review complete; offline gates green and live-client pagination/import/build sign-off obtained (2026-10-17).
j2 二次加固（同日）：电源/地列聚合、布线避障、分页手写导线清理；离线门禁全绿（504 用例、per-file 100%），见 §8。
二次交叉复核（同日，§9）：1 blocker + 2 major 全部修复并复测，实测幅度不变。

Scope: `packages/schematic/src/layout.ts`（分页规划、旗标落位、布线避障）及其测试。
本文件记录 2026-10-17 这一轮针对「AI 画原理图不按模块/超出画布/分页不生效」实测问题的复现、根因、改动与验收证据，供交叉复核与闭环验证。

## 1. 实测复现（离线 IR → layout → validate）

| 场景 | 改动前 | 改动后 |
|---|---|---|
| 30 器件扁平页（无 block） | 1 页，几何宽 5060，`OBJECT_OUT_OF_SHEET ×143`，交付被阻断 | 4 页（9/9/9/3），出框 0，无 `OBJECT_OUT_OF_SHEET` |
| 24 器件单模块（一个 block） | 1 页，几何宽 4100，`OBJECT_OUT_OF_SHEET ×71` | 3 页（9/9/6），出框 0，模块框标题 `(1/3)…(3/3)` |
| 12 器件 × 8 pin 的单列（旧「最紧间距单页」用例） | 1 页（间距压缩到 0.3） | 1 页，坐标不变（回归保护） |
| 29 器件 / 5 模块真实结构 | 5 页，旗标压器件体 6 处 | 5 页，旗标压器件体 0 处 |
| 同一结构 + 异网导线 T 接 | `NET_NAME_CONFLICT ×1`（VCC 与 SENSOR_INT 并网），交付被阻断 | 0 并网 |
| 单个 240 pin 器件（高于任何页面） | 1 页、超框 | 1 页、超框（不可再分的原子情形，交给校验器） |

> j3 复核把模块间距固定为 200（见 §3），因此竖排模块样本的「改动后」页数可能比 j2
> 阶段多 1 页；这是避免模块虚线框重叠的有意取舍，器件/网络数量与出框为 0 的结论不变。

复现入口：`packages/schematic/tests/layout.spec.ts` 的
`pagination of content that cannot fit one page` 与 `segment collision predicate` 两组用例，
其中前三个场景已固化为回归测试。

## 2. 根因

1. **分页只发生在模块之间，单个 group 永远不拆。** 扁平页（无 `block`）或一个过大的模块走到
   「最紧间距保留一页」分支，列继续向右延伸，几何直接出框；`OBJECT_OUT_OF_SHEET` 是 error，
   工具因此拒绝交付——这就是实测「分页没生效」的主因。
2. **测量与落位用了不同的可用高度。** 行高按 `usableHeight` 测量，落位时却按
   `bottomEdge - rowY` 重新换列；靠下的行可能换出更多列，导致规划宽度小于实际宽度。
3. **旗标回退方向会穿过器件体。** 同一侧相邻引脚的直线 stub 被异网引脚端点挡住后，
   旧逻辑按「垂直/镜像/对侧」回退，最终可能把旗标放进符号轮廓内（实测 6 处）。
4. **布线避障是点级的。** 干线端点落在异网导线的内部（T 接）不会被点集合发现，
   EasyEDA 会在该点并网；实测 VCC 与 SENSOR_INT 被并成一网，`NET_NAME_CONFLICT`（error）阻断交付。
5. **分页后的模块框没有续页编号。** 同一模块被切到多页时，每页都画同名框，读者无法区分。

## 3. 改动

`packages/schematic/src/layout.ts`：

- **页计划携带最终坐标。** `SheetPlan` 由 `rows` 改为 `cells`；`planCells` 用与落位完全相同的
  例程计算坐标，`layoutSheet` 不再二次摆放，规划/交付不可能漂移。
- **按信号流列切片分页。** 新增 `shardGroup`：先把 group 的列在页面宽度内折行，
  再按页面高度切片；单列过高时先按成员切段。任意扁平页/单模块都能拆页，不再向右出框。
  页内摆放在 `planPaginated` 中按 shelf packing 完成，尊重 `moduleColumns`。
- **续页编号。** `splitSheet` 接收每页的 `blocks` 标题，模块跨页时输出 `标题 (n/m)`；
  页面命名保持 `NAME`、`NAME 2`…。
- **分页间距。** 分页路径的列距取默认值的 0.75（300，仍留 180 的器件间隙），
  引脚间距不动（符号不缩小），页内折行间距用 `rowGap × 2`，避免过度稀疏。
- **旗标落位避让器件体。** 新增近似器件矩形；直线方向被挡时优先「先向外、再上下」的肘形 stub，
  并拒绝落在任何器件体内部的旗标候选。
- **线段级避障。** 新增 `segmentsTouch`：新线段与异网已有导线相交、T 接、共线重叠都视为冲突，
  冲突时回退到旗标方案，避免并网。

### j3 交叉复核补强（同轮）

复核用独立探针复现了四个 j2 阶段未覆盖的缺陷，并在同一份 `layout.ts` 上修复：

| 缺陷 | 复现 | 修复 |
|---|---|---|
| **分页后 `block.sheetIndex` 指向错页** | 第 1 张表切成 4 页后，原本 `sheetIndex: 2` 的子表实际到了第 5 页；块仍指向第 2 页，层级绑定错位 | `layoutSchematic` 按「源 sheet → 首页序号」重映射所有 `kind: 'block'` 的显式 `sheetIndex`；非法索引原样留给校验器 |
| **模块框重叠** | 4 个单器件模块单列排布时，间距压缩到 60，`computeBlockFrames` 画出的虚线框互相重叠 80，后一模块标题落进前一模块框内 | 模块间距不再参与压缩（固定 200）；只压缩列距、行距、引脚间距，压不下就分页。按默认 80 引脚 stub 轮廓，模块框水平/垂直均不再重叠 |
| **ATTR 分页后成孤儿** | 分页后第 1 页保留全部 `attrs`，而被引用的器件已到第 4 页，校验报 `ORPHAN_ATTR`（error）并阻断交付 | `splitSheet` 按 owner 分发 ATTR：器件、pin 复合 id、导线、bus entry 跟随所在页；真正孤儿的 ATTR 留在第 1 页继续报错 |
| **续页页名与既有页名冲突** | 源表 `MAIN` 切成 `MAIN 2/3/4` 时，另一张本来就叫 `MAIN 2` 的表会被重名，隐式 block 绑定变歧义 | 先保留所有源表首页名，再给续页挑最小可用后缀；实测 `MAIN` 续页跳成 `MAIN 3/4/5`，`MAIN 2` 原表不被占用 |

对应回归用例：`rewrites explicit block sheetIndex targets…`、`keeps module frames disjoint…`
（`packages/eda-core/tests/blocks.spec.ts`）、`keeps ATTR rows with their owning primitives…`、
`keeps continuation page names unique…`，以及 `serialize.spec.ts` 的
`paginated layout projection` 端到端投影用例。

### j3 live 复核补强（build 路径，同轮）

用真实 EasyEDA 客户端跑 `buildIntoEasyEda` 时又暴露了两个只在增量建图路径出现、离线投影
覆盖不到的缺陷，已一并修复：

| 缺陷 | live 复现 | 修复 |
|---|---|---|
| **多段导线的后续段被丢弃** | 分页后同网导线常由多条不相连的折线组成；旧 payload 把 `dots` 嵌套数组整体传给 `sch_PrimitiveWire.create`，客户端只落第一段，N4–N23 等网从读回源码/网表消失，计数 8 对 4 | `toBuildPayload` 把每条折线拆成独立 wire entry（`id:0`、`id:1`…），`renderWireChunkScript` 再逐条创建、逐条计数；读回期望也按折线数计算。live 建图从 84 个 primitive 提升到 118 个，N10–N13 等多段网全部出现 |
| **跨页网表把兄弟页的 pad 当成本页多余引脚** | 客户端网表是工程级的；旧过滤用「全工程 designator 集合」，第 2 页的 `U2-x` 被当成第 1 页 `U2` 的 pad，报 `SCHEMATIC_EDA_NET_PAD_MISMATCH` | pad 归属过滤改为**当前页**的 designator 集合；兄弟页的 pad 直接忽略。live 重跑后 17 条跨页 pad 误报归零 |

两条修复的回归用例：`creates every chain of a multi-chain wire as its own primitive`、
`splits a multi-chain wire into one payload entry per polyline`、
`keeps an empty wire as one payload entry and preserves its net`、
`scopes pad ownership to the page when sibling pages use other designators`。


## 4. 验收证据

- `tsc -b`：通过。
- `oxlint packages`：0 warning / 0 error。
- Vitest：17 个测试文件、491 个用例全部通过。
- 覆盖率：全仓语句/分支/函数/行 100%（`packages/schematic/src/layout.ts`、
  `packages/schematic-easyeda/src/build.ts` 均在内）。
- 新增回归用例：扁平页分页、单模块切片与续页编号、同层长列切段、跨网导线绕行、
  分页确定性与幂等、原子超高器件、线段相交判定表、层级索引重映射、模块框不重叠、
  ATTR 跟随 owner、续页页名唯一、分页布局到工程序列化的投影、多段导线逐段创建、
  跨页 pad 归属。
- 离线端到端（layout → validate → `serializeEasyEdaProject`）：30 器件 / 5 模块样本
  切成 5 页，页名 `MAIN`、`MAIN 2`…`MAIN 5` 唯一；30 个 part 全部保留，无 error；
  序列化输出每页一个 `META`、页 uuid 数与页数一致。

### 4.1 live 客户端连接（landing 页，无需安装插件）

本机验证通过的连接方式：

```bash
# 1) 启动 bridge；默认监听 49620–49629，内置网关固定 49630
node packages/eda-core/bin/dsh-eda-bridge.mjs

# 2) 用已登录 EasyEDA Pro 的浏览器打开 landing 页
msedge --new-window --profile-directory=Default \
  "https://pro.lceda.cn/api/landing?port=49620"

# 3) 确认注册
curl http://127.0.0.1:49620/health
# -> {"service":"easyeda-bridge","edaConnected":true,"edaWindowCount":1,...}
```

也可以直接打开 bridge 自带的 `http://127.0.0.1:49620/landing`：它会尝试用弹窗打开
landing 页，注册成功后自动关闭弹窗。若浏览器拦截弹窗，直接用上面的 `pro.lceda.cn`
URL 新开窗口即可。landing 页通过 `BroadcastChannel` 让编辑器内置的 run-api-gateway
连接 `ws://127.0.0.1:49630`，因此**不需要安装任何插件/扩展**。

### 4.2 live E2E 证据

| 场景 | 结果 |
|---|---|
| 6 模块（6 个 block，每页 2 个 part） | 6 页：`LIVE`、`LIVE 2`…`LIVE 6`；每页 1 个模块框、`MODULE n` 标题、2 个 part；全部页 `sch_Drc.check` 返回 `[]`；project `e1de05b880484867bd62ade3e41597b9` |
| 24 × 8-pin 单模块（一个 block 切成 4 页） | 4 页：`MCU`、`MCU 2`…`MCU 4`；模块框标题 `MCU CORE (1/4)…(4/4)`；每页 6 个 part；全部页 DRC `[]`；project `8e90904af6ea4ff1807ebe543e1861db` |
| `buildIntoEasyEda` 24 × 8-pin / 4 页（干净新工程） | 4 页、118 个 primitive；多段网 N4–N23 全部落图；0 个 wire/flag/net/count error；仅 5 条 `SCHEMATIC_EDA_FLOATING_PIN` DRC error，原因是探针 IR 只给每颗 8-pin 器件连了 2 个脚，属**测试样本预期**，不是布局缺陷 |
| 分页页名/模块框 | `importIntoEasyEda` 保留 `LIVE`/`MCU` 源页名与 `(n/m)` 框标题；`buildIntoEasyEda` 的页名是客户端默认 `P1..Pn`（既有行为，非分页回归） |

live 复核还确认了本轮 build 修复：多段导线由 84 个 primitive 提升到 118 个，N10–N13
等多段网从「客户端网表缺失」变为完整出现；跨页 pad 误报由 17 条降为 0。

## 5. 残留风险 / 复核清单

1. **手写几何仍然原样保留。** 只要任意器件带 `position`（或 `block`/`sheet` 层级图元），该 sheet
   不做自动分页；若手写坐标本身出框，仍由 `OBJECT_OUT_OF_SHEET` 报错（这是既有契约，未改变）。
2. **分页第 1 页的手写导线只保留声明，几何被清空后由路由器回填（2026-10-17 二次加固，见 §8.1-1）。**
   分页页没有手写器件坐标可锚定，旧几何必然悬空，因此 `splitSheet` 清空 `dots`、保留
   导线行与 ATTR，路由器按同一 net 重新布线并写回该行；标注符号（netflag/netport 等）仍原样保留。
   若作者就是要手写导线原样落图，应让该页不参与分页（给任一器件 `position`）。
   **总线入口（bus entry）是例外：** 它引用坐标 + 总线名、没有自己的 net，其 ATTR 按
   「跟随 primitive」分发；删掉它会静默丢失作者数据，因此仍原样留在第 1 页。它的点位已登记为
   布线占用点（`bus:<id>`，恒为异网），生成的导线不会从它上面穿过，因此不会再并网；
   它可能悬空（没有导线接到它），属可见但不并网的残留（§9.3-2）。使用总线记法的作者同样
   应让该页不参与分页。
3. **旗标密度已部分收敛（见 §8.2）。** 电源/地同列已聚合成一条母线 + 一个旗标（去耦电容列
   −75%）；信号网仍逐脚一个旗标——两个信号旗标之间的短母线只会增加线段而不减少旗标；
   VCC/GND 共用一列时按 §8.1-3 主动不聚合，避免切断对方的唯一出线方向。
4. **单个器件高于页面**（如 240 pin）无法拆分，只能超框；属于不可再分情形。
5. **模块间距固定为 200。** 这是为了让 serializer 的模块框（80 pad + 60 title headroom）
   不重叠；代价是以前靠压缩间距勉强塞进一页的竖排模块现在会分页。属于有意的可读性取舍。
6. **跨页 pad 对账只按 designator 归属。** 客户端 Protel 网表只给 `DESIGNATOR-PIN`，
   不给页 uuid；分页生成的 designator 全局唯一，因此本轮可用「当前页 designator 集合」过滤。
   若真实层级图在不同页复用了同一 designator，仍可能把兄弟页的同名 pad 当成本页多余项。
   这类工程需要客户端提供按页网表或页内 DRC 才能精确对账，已保留为已知限制。
7. **`buildIntoEasyEda` 的页名是 `P1..Pn`。** 这是 build 路径复用客户端默认页名的既有行为；
   分页/模块框/续页编号不受影响。需要保留 IR 页名时走 `importIntoEasyEda`。

## 6. 复核命令

```bash
pnpm typecheck
pnpm test            # 504 passed
pnpm test:coverage   # 100% per-file
pnpm lint            # 0 warning / 0 error
```

live 复核另需启动 bridge 并按 §4.1 打开 landing 页；可用 `curl http://127.0.0.1:49620/health`
确认 `edaConnected:true`。

## 7. 闭环验证状态（j3）

**离线闭环：通过。** 独立跑了 typecheck、oxlint、491 个用例、per-file 100% 覆盖率，
并用 30 器件 / 5 模块样本打通 `layoutSchematic → validateSchematic → serializeEasyEdaProject`：
5 页、页名唯一、30 个 part 无丢失、0 error、每页一个 `META`。

**live 闭环：通过。** 通过 landing 页完成客户端注册（未安装插件），并取得以下证据：

1. 6 模块 / 6 页：`LIVE`、`LIVE 2`…`LIVE 6`，每页 1 个模块框、2 个 part、`MODULE n`
   标题，全部页 DRC `[]`。
2. 24 × 8-pin 单模块 / 4 页：`MCU`、`MCU 2`…`MCU 4`，框标题 `MCU CORE (1/4)…(4/4)`，
   每页 6 个 part，全部页 DRC `[]`。
3. `buildIntoEasyEda` 4 页干净工程：118 个 primitive，多段网全部出现，0 个
   wire/flag/net/count error；5 条 floating-pin DRC 来自探针 IR 故意只连 2/8 脚，属预期。
4. 修复后跨页 pad 误报为 0；`importIntoEasyEda` 页名/`(n/m)` 框标题/每页 `META` 均正确。

**结论：本轮「按模块布局 + 自动分页 + 续页可读性 + 跨页连通」目标已闭环，可生产签收。**
剩余项只有 §5 的既有契约/已知限制（手写几何不自动分页、单器件超高、旗标密度、
跨页同名 designator 对账），不影响本轮分页功能的交付。

## 8. 可读性 / 连通性二次加固（j2，2026-10-17）

针对 §5 残留项 2、3 与「旗标/导线压器件体」的观感问题，这一轮做了三处改动，并修掉了一处
由优化本身引入的并网缺陷——**紧凑度让位于连通正确性**。

### 8.1 改动

1. **分页时清理手写导线几何（收口 §5.2）。** `splitSheet` 对第 1 页手写导线只清空 `dots`，
   保留导线行（id/net/kind）及其 ATTR：分页页没有手写器件坐标可锚定，旧几何必然悬空。
   路由器随后**回填这一行**（trunk 路径写主干，flag 路径写 stub 集合），因此它不会以空原语
   的形式到达构造器；只有「本页没有任何该网成员」的声明行保持空，构造器与 epru 投影都会
   跳过它（见 §9.1 A1）。
   回归用例 `drops stale wire geometry but keeps the wire row and its ATTR`：断言 9000 坐标
   不再出现在任何页面、ATTR 不成孤儿、无 `OBJECT_OUT_OF_SHEET`、续页不复活手写导线，
   且 flag 路径复用原导线 id、不再新增 `layout:wire:<net>:flags` 行。
2. **电源/地列聚合成一条母线 + 一个旗标（§5.3 的主要来源）。** `routeWithFlags` 把同网、
   同一 x 的未布线成员按 y 排序，向外最多试 3 条车道，选第一条干净的母线；成员用短 stub
   接入并在每个接点补 junction。地网母线在引脚上方、电源母线在下方。
   回归用例 `shares one flag and one tapped bus across a stacked power column`、
   `steps the bus outward past a blocked lane and falls back when all lanes are blocked`。
3. **两个电源网共用一列时主动不聚合。** 同列若还有另一个电源/地网，母线会切断对方唯一的
   出线方向（引脚同侧，另一侧是器件体）。`contendedX` 让两网都退回逐脚旗标。
   回归用例 `keeps per-pin flags when two power nets share a pin column`（同时断言无 error）。
4. **旗标/导线不压器件体，且绝不为省空间并网。** `segmentCrossesRect` 把「线段穿过近似器件
   矩形」计入冲突（端点落在体内属引脚 stub，不算穿越）；旗标候选全被挡时，宁可直接落在
   引脚上（无 stub、零长度连接），也不发射一条会 T 接到异网的 stub。兜底**不再** clamp 到
   未经检查的框边坐标——那可能正好落在异网旗标上（§9.1 A2）。
   回归用例 `segment body-crossing predicate`、`falls back to flags when a trunk would cross a symbol`、
   `sits the flag on the pin when every direction is blocked`、
   `sits the flag on an out-of-frame pin instead of clamping onto a foreign flag`。
5. **总线入口也是电气点位。** 校验器会把 `busEntry.point` 与其上的导线并网，因此布线占用表
   把每个入口登记为 `bus:<id>`（恒为异网），生成的 trunk 不会从总线入口上穿过。
   回归用例 `keeps a generated trunk off a bus-entry point`。

### 8.2 实测效果（同一 IR，三变体对照）

计数口径：flag = `netflag` + `netport`；线段 = 每条导线折线数之和；三个变体只差
「是否聚合 / 是否有同列守卫」，其余代码完全相同。

| 样本 | 变体 | 旗标 | 其中电源/地 | 线段 | junction | error |
|---|---|---|---|---|---|---|
| 8 去耦电容（2 列 × 4，VCC 左 / GND 右） | 逐脚基线 | 32 | 16 | 32 | 0 | 无 |
| | **本轮** | **20** | **4** | 36 | 16 | 无 |
| | 朴素聚合 | 20 | 4 | 36 | 16 | 无 |
| 12 器件（VCC/GND 同在左列） | 逐脚基线 | 24 | 24 | 36 | 0 | 无 |
| | **本轮** | **24** | **24** | 36 | 0 | 无 |
| | 朴素聚合 | 14 | 14 | 38 | 12 | 无 |
| 30 器件 / 5 页投影样本 | 逐脚基线 | 118 | 60 | 120 | 0 | 无 |
| | **本轮** | **118** | **60** | 120 | 0 | 无 |
| | 朴素聚合 | 99 | 40 | 130 | 30 | **NET_NAME_CONFLICT + POWER_SHORT** |

读法：

- 去耦电容列是聚合的真实受益场景：电源/地旗标 **16 → 4（−75%）**，总旗标 32 → 20（−37.5%）；
  线段 32 → 36（母线比逐脚 stub 多几段），多出的 16 个 junction 都是真实 T 接。
- VCC/GND 同列时守卫让本轮与逐脚基线**逐项相同**，没有回归。
- 朴素聚合在 30 器件投影样本上把 VCC 与 GND 并成一网（`POWER_SHORT` + `NET_NAME_CONFLICT`，
  均为 error），这是必须拒绝的「优化」；它正是 `packages/eda-core/tests/serialize.spec.ts`
  的 `paginated layout projection` 用例在本轮开发中抓到的真实回归，现已固化为门禁。

### 8.3 离线闭环

- `tsc -b` 通过；`oxlint packages` 0 warning / 0 error。
- Vitest：17 个测试文件、**504 个用例**全部通过；golden（`layout-golden.json`、
  `module-golden.json`）字节不变，证明默认输出未被本轮改动扰动。
- 覆盖率：全仓语句/分支/函数/行 **100%**（含 `layout.ts` 新增的聚合、守卫、避障、回退分支）。
- 端到端：`layoutSchematic → validateSchematic → serializeEasyEdaProject` 在 30 器件 / 5 页
  样本上 0 error、页名唯一、每页一个 `META`（用例即上述 `paginated layout projection`）。
- live：端口 49620 当前无客户端（`edaConnected` 不可用），本轮未新增 live 证据；本轮改动集中在
  校验器之前的几何规划，已由离线投影/序列化用例覆盖，§4.2 的 live 结论继续适用于分页与 build 路径。

## 9. 交叉复核与复验（2026-10-17）

复核对象：`layout.ts` SHA256 `A7D9B8F5…497CB75`（与冻结值一致）、`layout.spec.ts` 当前版本；
结论 **FIX-FIRST**：1 blocker、2 major、5 minor/nit。复核者所在环境无法启动 vitest
（esbuild `spawn EPERM`），全部结论为静态推导并给出具体坐标；随后由独立验证器在同一冻结
哈希上重跑 §8.2 的全部数字，**逐项 PASS**（见 9.2）。

修复后同一复核者只审增量，结论 **PASS**：A1/A2/A3/C2 确认修好，D1/D2 用例改为断言安全状态，
并额外指出 `carrier` 选中总线行时「离线校验器认为连通、客户端画的却是总线」的静默失败。
该条已按建议一行收紧（`layout.ts:1477`，见 9.2），本轮以 PASS 收口。

### 9.1 发现与处理

| 编号 | 级别 | 发现 | 处理 |
|---|---|---|---|
| A1 | blocker | `splitSheet` 清空第 1 页手写导线的 `dots`，但只有 trunk 路径回填；flag 路径与「本页无该网成员」的行留空，`build.ts` 把空导线记为 `CREATE_FAILED`（error） | flag 路径优先回填本页已声明的空行（保 id/net/ATTR，不再新增 `layout:wire:*:flags`）；回填只接受 `kind:'wire'` 的声明行（`isDeclarableWire`，trunk 路径同样改用该判定），总线行不会被改写成导线；`build.ts` 对无几何行 `continue`（不建原语、不计入 expected count）；`serialize.ts` 不投影该行及其 ATTR |
| A2 | major | 最后兜底 `clampFrame(direct)` 未做冲突检查，会正好落在异网旗标上（用例把这个并网断言成了正确） | 兜底一律回到引脚本身 `clear ?? endpoint`；越界引脚诚实报 `OBJECT_OUT_OF_SHEET`，用例改为断言不出现 `NET_NAME_CONFLICT` |
| A3 | major | `occupy` 未登记 `busEntry.point`，生成的 trunk 可 T 接总线入口（校验器把该点并网） | 入口按 `bus:<id>` 占用，恒为异网；新增用例 `keeps a generated trunk off a bus-entry point` |
| A4 | minor | `contendedX` 只在同列出现第二个电源/地网时触发，偏保守（少聚合） | 保留：同列同侧两条母线在 y 范围重叠时必然交叉（内层母线抽头要穿过外层母线），此时聚合对两网都不可行；y 范围不重叠时理论上可共存，当前仍按保守策略逐脚展开——只多旗标，不产生 error |
| A5 | minor | `bodyRects` 只统计 `kind:'part'`，模块框/层次块不参与避障 | 保留：模块框是装饰性边框，导线穿越边框是正常画法 |
| B2 | minor | 续页丢 junction 却保留 bus entry，可能留下悬空入口 | 已知：bus entry 是作者原语且带 ATTR，删除会造成不可恢复的数据丢失；悬空入口可在客户端校验中检出，且其点位现已占用，不会被生成导线误接 |
| B3 | nit | 空 `blocks` 声明在分页页被过滤 | 既有契约：只保留有成员的模块，分页页无成员即无框可画 |
| C1 | nit | 分片比较用 `localeCompare` | 既有代码；改成码点比较会重排 golden 的分页边界，本轮不动 |
| C2 | nit | 聚合 run 的 key 按字符串排序（`'100' < '40'`） | 改为数值排序 `Number(a) - Number(b)`，只影响发射顺序 |
| D1/D2 | — | 用例把 A2/A1 的缺陷固化为「正确」 | 已随 A1/A2 改写（D1 改为断言落在引脚上且无 `NET_NAME_CONFLICT`；D2 改为断言原行被回填、无新增 flag 行） |

### 9.2 复验

**独立验证器（不共享本会话上下文）**在冻结哈希 `A7D9B8F5…497CB75` 上以「列优先」编码重建
三个样本，全部数字与 §8.2 一致：A = 20/4/16/36/1 页、B = 24/24/0/36、C = 118/60/0/120/5 页；
朴素变体分别复现 32/16/0/32、14/14/12/38、99/40/30/130 且 C 出现
`NET_NAME_CONFLICT` + `POWER_SHORT`；并确认最终一次 `fits` 阶梯修改对测量中性。

**修复后复测**（`layout.ts` SHA256 `7CE30E4A…F749CE`，`build.ts` `D8FC59C1…3EB037`，
`serialize.ts` `B29D654B…3A4159`）：同一测量用例逐项重跑，三个样本的
旗标/电源地/线段/junction/页数/error **与 §8.2 完全相同**——A1/A2/A3 只影响
「有手写导线」「有总线入口」「旗标饱和」的输入，不改变已公布的优化幅度。
临时测量用例已删除，最终仓库不含 `zz-*` / `measure*` 文件。

**复核者追加的一条静默失败已修复。** `carrier`（把未布线成员接到已有载体上的分支）此前
只按「有几何 + 同 net」选载体，若作者那条载体是 `kind:'bus'`，stub 会被追加进总线折线：
离线校验器按导线看到连通，客户端画出的却是总线（引脚不并入总线），且 oracle 把
`sch_PrimitiveBus.getAll()` 计入 `wires`，计数不变——**静默丢网**。现在 `carrier` 要求
`wire.kind === 'wire'`，该 net 走独立 trunk 并新建 `layout:wire:<net>` 行。
新增用例 `does not stack a trunk onto a declared bus row`（断言总线行几何不变、新导线行存在）。

**最终门禁**：`tsc -b` 通过；`oxlint` 0 warning / 0 error；17 个文件 **504 个用例**全绿；
全仓语句/分支/函数/行 **100%**；golden 字节不变。

### 9.3 残余风险（明确、已知、不并网）

1. 手写几何（任何带 `position` 的器件、`block`、`sheet`）仍按 §5.1 契约整体退出自动分页。
2. 续页保留的 bus entry 使用作者原坐标，可能悬空（B2）；它不会被生成导线误接。
3. 旗标密度在同列电源/地（§8.2）与高扇出信号列（§10.2）下降；同列双电源网与旗标饱和场景仍逐脚展开（A4）。
4. 跨页同名 designator 对账沿用 j3 的结论（§4.2）。
5. live 已在登录态完成（§10.3）：landing 接入、旗标 A/B、6 页模块分页与 DRC 0；
   build/serialize 改动同时有离线用例覆盖。
6. 分页第 1 页上作者手写的 `kind:'bus'` 行同样只保留声明、不重生成（`splitSheet` 清空所有
   导线几何，`isDeclarableWire` 又不接受总线行），因此该页的总线图形会被丢弃；不参与分页的
   页面不受影响。与「悬空几何不落图」的取舍一致，且总线本身在本轮之前就只有半交付
   （`UNSUPPORTED_BUSENTRY` warning）。
7. 旗标饱和时兜底落在引脚端点上，离线校验器仍报 `FLOATING_PIN`（**warning**）：它按导线判定
   连通，不把「与引脚端点重合的旗标」算作连接。客户端里 netflag 落在引脚端点上通常即连通，
   但本轮无 live 客户端可验证。这是有意的取舍——warning 不阻断交付，而此前的 unchecked
   clamp 会产生 `NET_NAME_CONFLICT`（error，阻断）。

交叉复核闭环完成：blocker 与 major 全部修复，复核者复审 PASS，实测幅度经独立验证与修复后复测双重确认。

## 10. 高扇出信号列聚合与 live 失败面加固（2026-10-17，j3）

§9.3 残留 3 只覆盖电源/地列。本节把同一套「抽头母线 + 单旗标」用于**高扇出信号列**
（时钟/复位扇出到同一侧多个接收器），并修掉 live 探测暴露的未登录失败面。

### 10.1 改动

1. **高扇出信号列也聚合（`layout.ts` `routeWithFlags`）。**
   `aggregateSignals = !vertical && unrouted.length >= o.flagFanout`：非电源/地网只要未布线成员数
   达到 `flagFanout`（默认 6），就复用既有的列聚合路径——按 x 分组、按 y 排序、向外试 1–3 条车道、
   每个成员一条短 stub、每个 T 接补 junction、整列只发一个旗标。粗网格下 `snap` 可能把旗标端
   舍入回列内，母线现在把旗标端夹到真实抽头极值（`Math.max(snapped,maxY)` /
   `Math.min(snapped,minY)`），并对 snap 后的三条车道去重（`Set`），保证每个抽头都落在母线上；
   回归用例 `extends a tapped bus past an off-grid outermost tap`（grid=100、抽头 y=105..605）。
   低扇出信号仍逐脚旗标（
   两脚点对点网络用母线只会多线不多省旗标）。安全边界不变：母线/抽头仍走 `collides`
   （异网引脚、旗标、junction、总线入口、异网导线），任一冲突即回退逐脚；`contendedX` 仍让
   同列双电源网逐脚展开。
   回归用例：`uses flags for high-fanout nets`（6 接收器一列 → 1 个 `:bus:` 旗标）、
   `shares one flag across a high-fanout signal column and keeps the driver separate`
   （7 接收器 + 1 驱动器 → 2 个旗标、0 error）、`honors the flag fanout threshold`
   （阈值下走 trunk，阈值上聚合成 1 个 `:bus:` 旗标）。
2. **未登录/无团队时给出可行动错误（`build.ts`）。** live 探测发现客户端未登录时
   `dmt_Team.getAllTeamsInfo()` 可能返回含 null 的数组，或 team 代理的 `uuid` getter 自身解引用 null；
   旧脚本直接 `teams[0].uuid`，表现为网关 HTTP 500 + `TypeError: Cannot read properties of null
   (reading 'uuid')`。现在：
   - 团队解析包在 try/catch 内，逐项安全取 `uuid`，并在 3s 上限内探测 `getCurrentTeamInfo()`
     （null/畸形也判否）；无有效团队返回 `NO_TEAM`（宿主映射为 `SCHEMATIC_IMPORT_NO_TEAM`，
     消息提示登录并选择团队）。
   - `importProjectByProjectFile` 自身抛错时返回 `{ status: 'IMPORT_THROWN', detail }`，
     宿主映射为 `SCHEMATIC_IMPORT_FAILED`，消息明确提示「sign in, select a team, and retry」，
     不再把客户端异常变成不可读的 500。
   回归用例：`guards a null team entry before reading its uuid`（脚本含守卫、无 `teams[0].uuid`）、
   `turns a client-side import throw into an actionable login/team error`（含 detail 与缺省 detail 两分支）。

### 10.2 实测效果（同一 IR，真实构建产物，A/B）

样本：7 个接收器 + 1 个驱动器，全部 `CLK`，接收器引脚同列 x=300（y=200..680，步长 80），
驱动器 x=700；同一真实器件 C25804 的 pin 2；其余引脚不参与布线。测量链：
`layoutSchematic → validateSchematic → serializeEasyEdaDocument → diffNetlists`；
计数来自 laid IR 与序列化记录，A/B 只差 `aggregateSignals` 一行（基线用 `false` 临时编译）。

| 变体 | 旗标 | COMPONENT 记录 | LINE | junction | validate error | diffNetlists |
|---|---|---|---|---|---|---|
| 逐脚基线 | 8 | 16 | 8 | 0 | 0 | `[]` |
| **本节优化** | **2** | **10** | 9 | 7 | 0 | `[]` |

- 旗标 **8 → 2（−75%）**，COMPONENT 记录 **16 → 10（−37.5%）**；多出的 1 条 LINE 是母线，
  7 个 junction 全是真实抽头 T 接；`diffNetlists` 两边都为空，证明离线回读看到的连通性与 IR 一致。
- 旗标 id：优化后为 `layout:flag:CLK:bus:300` + `layout:flag:CLK:0`；基线是 8 个逐脚
  `layout:flag:CLK:0..7`。
- §8.2 的电源/地去耦样本数字未受影响；golden 字节不变。

#### live A/B（真实客户端，同一 IR）

登录后的 EasyEDA Pro（V4.1.78）各导入一次；客户端计数来自
`sch_PrimitiveComponent.getAll`、Protel2 netlist 与 `sch_Drc.check(true,false,true)`，
netflag 用 primitive id（`layout:flag:*`）识别。

| 变体 | 项目 uuid | COMPONENT | netflag（primitive id） | CLK pad | 客户端 DRC |
|---|---|---|---|---|---|
| 逐脚基线 | `e7ff69c921e34f8e8ffd19b3790225b3` | 16 | 8（`layout:flag:CLK:0..7`） | 8 | 5 warning / 0 error |
| **本节优化** | `6475165a659e44dcb2b233ec6e06620d` | **10** | **2**（`layout:flag:CLK:bus:320`、`layout:flag:CLK:0`） | 8 | **3 warning / 0 error** |

- 真实客户端上旗标 **8 → 2**、COMPONENT **16 → 10**，与离线完全一致；两个变体的 `CLK` 都是
  8 个 pad，证明聚合没有改变连通性。
- 剩余 warning 全部来自该样本**故意悬空的第二脚**（`CHECKFLOATPIN`）与客户端对 netflag 符号
  自身的属性提示（`ATTRMATCHCODE`）；不是并网或错连。全引脚连通的模块样本 DRC 为 0（§10.3）。

### 10.3 live 复核（本轮为 full-live）

登录后的客户端（窗口 `67eef08074f91918`）经 landing 页接入，无需安装插件：

- `https://pro.lceda.cn/api/landing?port=49620` 触发后 `/health` 返回
  `edaConnected:true`、`edaWindowCount:1`；§4.1 的结论在登录态继续成立。
- **高扇出信号列 live A/B**：见 §10.2 表；真实客户端确认 8→2 旗标、16→10 组件、CLK 8 pad、0 error。
- **模块清晰度 live**：3 个带标题的模块块（MCU CORE / POWER SUPPLY / IO INTERFACE）× 14 器件，
  每器件 2 脚、每模块 2 条 14 脚网络，自动分页为 6 页
  （项目 `3c2152fdf5ae4308802543ec1150911f`）：

| 页 | 页名 | RECT | TEXT | 器件 | netflag | 模块 | DRC |
|---|---|---|---|---|---|---|---|
| 1 | MODULAR BOARD | 1 | 1 | 12 | 6 | MCU | 0 |
| 2 | MODULAR BOARD 2 | 1 | 1 | 2 | 4 | MCU | 0 |
| 3 | MODULAR BOARD 3 | 1 | 1 | 12 | 6 | PSU | 0 |
| 4 | MODULAR BOARD 4 | 1 | 1 | 2 | 4 | PSU | 0 |
| 5 | MODULAR BOARD 5 | 1 | 1 | 12 | 6 | IO | 0 |
| 6 | MODULAR BOARD 6 | 1 | 1 | 2 | 4 | IO | 0 |

  - 每页恰好一个模块框（RECT）+ 一个模块标题（TEXT）；分页保持模块成组，MCU→PSU→IO 顺序，
    没有跨模块混排。
  - Protel2 回读：`MCU_A/MCU_B/PSU_A/PSU_B/IO_A/IO_B` 各 **14 pad**，42 个器件、84 个引脚
    全部连通。
  - 6 页 DRC 全部 **0 finding**。
- **集成契约（live 发现）**：`layoutSchematic` 必须带 `symbolPins` 调用。生产路径
  `packages/tool-schematic` 已是 `resolveBindings → layout(bound, { symbolPins }) → validate`；
  若省略，布局按默认引脚偏移画线、而校验与客户端按真实符号引脚，会产生大量 `WIRE_NOT_ON_PIN`。
  这不是本轮改动引入的，但属于调用契约，已在本文档标注。
- 复跑方式：登录后触发 `http://127.0.0.1:49620/landing`，再运行
  `node packages/schematic-easyeda/scripts/live-verify.mjs`；高扇出 A/B 与模块分页按本节样本
  重建 IR，用 `importIntoEasyEda` 导入后用 `renderOracleScript`/Protel2 回读即可复现。

### 10.4 残余风险

1. 高扇出信号列的 live 导入/DRC 已完成（§10.3）。剩余的是**模块页名**：分页续页名仍是
   `MODULAR BOARD 2..n`，模块名在页内 RECT/TEXT 上而不在页签名上。若要求页签即模块名，
   需让 IR 按模块分 sheet，或在分页命名时带上主模块名。
2. §9.3 的 1、2、4、6、7 仍在：手写几何整体退出分页；续页 bus entry 悬空；跨页同名
   designator 对账；第 1 页作者总线行不重生成；旗标饱和兜底落引脚仍报 `FLOATING_PIN`（warning）。
3. 信号列聚合只在「未布线成员数 ≥ flagFanout」时启用；同列两条高扇出信号网会因母线互相
   穿越而回退逐脚（只多旗标，不并网）。
4. 真实客户端上 netflag 组件可能带客户端自身的 `ATTRMATCHCODE` 提示（同网多旗标、属性匹配码
   不同）；本样本 0 error，且全引脚连通的模块样本 DRC 0 finding。若后续要求 warning 也归零，
   需要研究客户端对 netflag 属性的期望。

### 10.5 门禁

- `tsc -b` 通过；`oxlint packages` 0 warning / 0 error。
- Vitest：17 个文件、**508 个用例**全绿；覆盖率语句/分支/函数/行 **100%**；golden 不变。
- 文件 SHA256 前缀：`layout.ts` `B188481D`、`build.ts` `56799337`、`serialize.ts` `B29D654B`
  （serialize 未在本轮改动）。
- live：登录态 EasyEDA Pro V4.1.78，landing 接入 + 高扇出 A/B + 6 页模块分页，见 §10.3。

### 10.6 交叉复核与增量复审

两轮独立复核（不共享本会话上下文）：第一轮结论 FIX-FIRST，修复后增量复审 **PASS**（无新增
BLOCKER/MAJOR）。发现与处理：

| 级别 | 发现 | 处理 |
|---|---|---|
| MAJOR | `grid ≥ ~90` 时 `snap(maxY+40,grid)` 可舍入到列内，母线停在最外抽头之前，却仍为该成员发 junction（悬空） | 旗标端夹到 `minY`/`maxY`；新增 `grid=100`、抽头 `y=105..605` 的回归用例（旧代码母线止于 600，断言失败） |
| MAJOR | 团队探测是无上限 `await`，且只接 throw，挂起客户端仍会拖死导入 | 改为 `raced(...,3000)`，并拒绝 null/畸形 `uuid`；`NO_TEAM` 消息补登录/选团队提示 |
| MINOR | snap 后车道可重合（grid=50 时 lane2/lane3 同为 200），第三条回退车道不存在 | `Set` 对 snap 后的车道去重，保持由内向外顺序 |
| MINOR | 母线只校验旗标点 `inFrame`，抽头越界时可能画出页外 | 随旗标端夹到抽头极值；抽头越界→旗标越界→整列回退逐脚 |
| MINOR | 同列两条高扇出信号网：第二条被第一条母线挡住，退回逐脚；y 不重叠时两条母线共线 | 已知、不并网；只多旗标/观感，记录为残余（§10.4-3） |
| NIT | 母线末端的 L 角也补了 junction（只有两段） | 纯观感，保留 |
| NIT | 守卫用例只做字符串断言，`NO_TEAM` 提示未被断言 | 增加 `raced`/`active.uuid`/提示断言；`NO_TEAM` 用例断言消息含 `sign in, select a team` |

复核明确未发现可构造的并网路径：母线/抽头全部进入 `collides`（异网点位、异网导线、器件体），
第二条同列母线在车道 1–3 均冲突后回退逐脚；`aggregateSignals ⇒ useFlags`，不会产生不可达分支。


## 11. A3 生产页预设与页框几何（j2，2026-10-17，进行中）

参考工程 CORE 页是 A3（1655×1170）+ 完整图框/标题栏；我们此前只有 A4，且 `pageSize` 在
**图元投影层被忽略**——这是一处真实缺陷，先修它，再谈版面。

### 11.1 改动

1. **`SCHEMATIC_PAGE_A3`（1655×1170）成为导出的生产预设**（`packages/schematic/src/types.ts`），
   与 `SCHEMATIC_PAGE_A4` 同级；`pageSize` 一直是 `layout`/`validate` 的入参。
2. **`pageSize` 贯通到装饰层**：`serializeEasyEdaDocument`/`serializeEasyEdaProject` 与
   `buildIntoEasyEda`/`EasyEdaBuildOptions` 新增 `pageSize`，并传给
   `computeBlockFrames(sheet, pageSize)`、`computeSheetSymbolBoxes(sheet, pageSize)`。
   此前这两处固定按 A4 夹取：A3 上落在 x>1170 / y>825 的模块框会被**截断**（x2=1420 宽度 0）。
3. 回归用例 `clamps frames to the page size the layout planned against`：同一个贴着 A4 边缘的
   模块，A4 投影 `dotX2=1170 / dotY2=0`，A3 投影 `1180 / -290`（旧代码是 `-825 / -880` 的
   镜像写法，§11.4 修正了 Y 轴映射）。

### 11.2 实测密度（30 器件 / 5 模块，同一 IR，只改页面与间距）

| 变体 | 页数 | 器件/页 | 内容包围盒填充率 | 页名 |
|---|---|---|---|---|
| A4 默认 | 5 | 6 | 22.4% | `MAIN`…`MAIN 5` |
| **A3 默认** | **3** | **12** | **35.4%** | `MAIN`…`MAIN 3` |
| A3 + 紧凑间距（列距 320 / 行距 40） | 2 | 24 | 29.0% | `MAIN`…`MAIN 2` |
| A4 + 紧凑间距 | 5 | 6 | 19.9% | `MAIN`…`MAIN 5` |

口径：填充率 = 每页内容包围盒面积 / 页面面积（多页取均值）。读法：

- **A3 单换页面就把填充率从 22.4% 提到 35.4%（达 j1 的 ≥35% 目标）、页数 5→3、每页 6→12 器件**；
- 继续压间距能把 3 页压到 2 页（24 器件/页），但填充率反而降到 29%——内容被挤到左上角，
  所以「密度」和「版面平衡」要分开优化：A3 负责前者，居中和模块框负责后者；
- 页名仍是 `MAIN`/`MAIN 2`，P1 的「页名=模块名」尚未落地（j3 正在做图框/标题栏，
  页名建议一并由模块主导名生成，见 §11.3）。

### 11.3 交接与状态

- 图框/标题栏由 j3 在 `packages/eda-core/src/sheet-chrome.ts`（`computeSheetChrome`）推进，
  已接 `pageSize` 与 `frame` 选项；本轮 A3 预设正是它需要的入参。
- 待办：页名=模块名（P1）、模块框/内容居中（P2）、参考工程图框几何与 `titleBlockData`
  实测抓取（j3 live）。
- 门禁：`tsc -b` 通过、`oxlint` 0/0、18 文件 **516 用例**全绿、覆盖率 **100%**
  （补了 `frame: {}` 的默认标题用例 `defaults the project title when the caller passes an empty frame`，
  覆盖 §11.1 图框代码的 `?? 'DSH Schematic'` 分支）。

### 11.4 live 复核：Y 轴镜像缺陷与图框落地（j3，2026-10-17）

在登录态客户端逐项对比参考 `工程 A`（CORE 页 A3 + 原生图框/标题栏）与生成页后，发现一处
**长期存在的坐标缺陷**：

- 参考工程与生成页的 `sys_FileManager` 源都写负 Y；但客户端 `getState_Y` 回读等于
  `-sourceY`，且屏幕 Y 向上（bottom-left 原点）。旧序列化器写 `sourceY = -IR_y`，于是
  持久化 Y = `IR_y`，整页相对 IR **上下镜像**：标题栏跑到页顶、模块标题落在模块框下方、
  多页从上往下顺序颠倒。此前多轮 live 复核只核对连通性/DRC，未发现这一观感缺陷。
- 修复：IR 顶左 Y 向下 → 持久化 `y - pageHeight`（A4=825，A3=1170），见
  `serialize.ts` 的 `Emitter.pageHeight`；`readback.ts` 的 `irNetRegions`/`diffNetlists`
  同步改用同一映射（新增 `pageSize` 入参，默认 A4），否则 read-back 会把正确的线判成
  `SCHEMATIC_NETLIST_DROPPED`。
- live 证据（项目 `aaf530fba049414581b533c0e98a3ca7`，页面 `63ddcf52…`）：
  - 回读文本坐标 `Project/项目名 y=116`、`Page/DUT/1-of-1 y=90`、`Size/A4 y=64`、
    `Rev/V0.1 y=38`，标题栏位于**页右下角**；模块标题 `DEVICE UNDER TEST y=555` 在
    器件 `y=425` **上方**——方向与参考一致。
  - 图元：双线页框 `1154×809 / 1138×793`、标题栏 `430×104` + 3 条分隔线 + 1 条竖线，
    模块虚线框 `200×220`；`frames` 回读 `rects:8, texts:10, components:1`；netlist/DRC
    0 error（`PASS`）。
- 图框实现：`computeSheetChrome` 生成双线边框 + 右下标题栏（Project/Page/Size/Rev 四行，
  含 `n/N`、页大小标签、日期、公司），由 `emitSheet` 在 CANVAS 之后、器件之前以实线
  RECT/TEXT 发出；`importIntoEasyEda` 默认带 `frame = { projectTitle }`，`pageSize` 可选。
  与参考的差别：参考用原生 `Sheet-Symbol_A3` 组件 + `titleBlockData`，客户端 API 创建该
  器件会挂起（20s 超时），故自绘等价图框，未写 `titleBlockData`。

### 11.5 残余与下一步

1. **页名=模块名（P1）✅ 本轮完成**：`planPaginated` 已按页内主导模块命名——一页只装一个
   模块时页名=模块标题（参考 `CORE`/`POWER`/`DEVICE`），一页混合多个模块或只有未分组器件时
   回退 sheet 名；续页用「模块标题 + 序号」去重，且仍先预留所有首屏名，避免续页抢占别的
   sheet 的既有名字（`MAIN 2` 用例保持通过）。live 见 §11.6。
2. **模块框/内容居中（P2）**：A3 填充率 35.4%（§11.2）已达目标，但内容偏左上；模块框可
   收紧到内容包围盒 + 小内边距，标题字号 40 → 24–30。
3. **A3 仍是调用方可选**：`importIntoEasyEda({ pageSize: SCHEMATIC_PAGE_A3 })` 与
   `layout(..., { pageSize })` 已通，但工具默认仍 A4；是否把 A3 设为生产默认需产品决策。
4. **原生图框**：自绘图框无 `titleBlockData`，导出/打印时标题栏字段不参与平台模板；如后续
   API 支持创建 `Sheet-Symbol`，可切换回原生。

### 11.6 live 多模块 A3 实测（j3，2026-10-17，本轮）

用 `SchematicRuntime.resolveBindings → layout({ pageSize: A3, moduleColumns: 1 }) → validate
→ importIntoEasyEda` 跑 3 模块 / 32 器件（C25804，全部走真实库绑定与自动布局）：

```
pages (3): ["MCU CORE","POWER SUPPLY","IO INTERFACE"]
frame titles: ["MCU CORE","POWER SUPPLY","IO INTERFACE"]
validate errors (0): []
import: project e7a1b1418f43490b901d3970e4786302 (3 page(s))
import errors (0): []
```

- 页名与页内模块框标题一致，与参考工程的 `CORE`/`POWER`/`DEVICE` 命名方式相同。
- 截图确认：左侧工程树 `1. MCU CORE / 2. POWER SUPPLY / 3. IO INTERFACE`；A3 页框 + 右下
  标题栏（Page Size 显示 `A3`）；模块标题在器件上方，方向与参考一致。
- 观察：本次 `moduleColumns: 1` 让每模块独占一列，模块内容只占 A3 左侧——这是 P2
  「模块框/内容居中」要解决的观感问题，不是命名问题。

**P2 居中（同一轮补）**：分页时每个页面的 cell 位置按内容包围盒在 usable rect 内居中（对齐
grid，只平移规划位置，布线/模块框/引脚端点随后派生，整页一起移动）。复测：

```
pages (3): ["MCU CORE","POWER SUPPLY","IO INTERFACE"]
validate errors (0): []   import: project 6af6c41fa4804d35a7295d98904256bc (3 page(s)), errors 0
```

截图对比：内容由「贴 A3 左上」变为**页面居中**，模块框/标题随内容一起移动，页框与右下标题栏
不变。仍待办：模块框 padding 80 → 40 量级、标题字号 40 → 24–30（会改变模块框几何与分页容量，
需单独一轮复测）。

### 11.7 下一轮（P2/P3 + 交叉复合闭环）

1. **P2 版面 ✅ 本轮完成居中**：分页页面内容已在 usable rect 内居中（§11.6）；模块框
   padding 80 → 40 量级、标题字号 40 → 24–30 仍待办（会改变模块框几何与分页容量）。
2. **P3 默认页**：决定工具是否默认 A3（`pageSize` 已贯通 layout/validate/import/engine）。
3. **交叉复合闭环 ✅ 本轮完成**：live 多模块 + 单器件 A/B 全绿，两轮独立复核已处置（§11.8），
   门禁 `tsc -b`/`oxlint` 0/0/Vitest 523 用例/覆盖率 100%，`.tmp-temp` 探针已删。

### 11.8 交叉复核与处置（j3，2026-10-17，本轮）

两轮独立复核（不共享本会话上下文）。复核方受沙箱 spawn/管道限制无法运行 vitest，门禁由本会话
执行；其结论基于代码阅读与编译产物探针。

**复核 A（Y 轴 / 图框 / 金样）— FIX-FIRST，处置：**

- 金样独立验证：31 个 Y 字段全部满足 `newY = -oldY - 825`，X/连线/ID/ticket 逐字节不变 →
  确认是映射变更的合法结果，非掩盖缺陷。
- **采纳**：`EasyEdaSchematicEngine.build/importProject` 之前丢弃 `pageSize`（`serialize` 还会
  丢 `frame`），A3 布局经 engine 交付会退回 A4 映射/夹取 → 已补 `pageSize`/`frame` 透传，
  `SchematicEngine.serialize` 增加可选 `SchematicEngineSerializeOptions`，并加 seam 用例。
- **部分驳回（有实测证据）**：复核认为 `diffNetlists(options.pageSize)` 会因「客户端页恒为 A4」
  产生假 `NETLIST_DROPPED`。实测 A3 导入（项目 `17e43190cfbb454ca25fe2980d1f404b`，3 页）
  0 error：diff 解析的是我们自己写入的 source，与序列化共用同一 `pageHeight`，自洽。但底层
  担忧成立——平台原生页大小/打印模板仍未写入（无 `titleBlockData`），A3 目前是画布/视觉交付，
  打印页大小需后续用原生 `Sheet-Symbol` 解决 → **残余**。
- **采纳**：Y 轴注释措辞自相矛盾 → 改为「API 空间 `pageHeight - y`；持久化 source 取其相反数
  `y - pageHeight`」（`serialize.ts`/`readback.ts`）。
- **采纳**：模块框 padding 可越过标题栏（A4 框底可达 755 > 标题栏顶 705）→ 新增
  `titleBlockTop()`，`computeBlockFrames` 在内容本身高于标题栏顶时把框底夹到 705（内容在标题栏
  下方时保留原框），新增回归用例。
- **NIT 计数口径**：live 探针 `rects:8` = 图框 7 + 模块框 1；`texts:10` = 图框 11 条中 company
  为空被省略，非文档错误。
- **残余（NIT）**：标题栏按字符数截断，超长项目名可能压到 `n/N` 列。

**复核 B（分页命名 / 居中）— FIX-FIRST，处置：**

- **MAJOR 采纳**：两个源 sheet 的单模块同名（都叫 `MCU CORE`）会产生重复页名并错位续页编号
  （实测 `["MCU CORE","MCU CORE 2","MCU CORE 3","MCU CORE",…]`）→ 命名改为统一 `assigned`
  分配：页 0 也参与去重，续页先查 `assigned`，回退命名再叠加 `reserved`（保护既有 sheet 名），
  新增「两 sheet 同名」回归用例。
- **MINOR 记录**：一页「单模块 + 未分组余量」按主导模块命名 → 视为有意（主导模块即该页主题）。
- **NIT 残余**：`block.title: ''` 会得到空页名（未修；声明非空标题即可）。
- **PASS 项**：居中不越界（复核以编译产物探针验证 planned 中心均在 usable rect 内，validate
  0 `OBJECT_OUT_OF_SHEET`）；确定性/幂等 `layout(layout(x))` 深等；层级绑定只用
  `sheetIndex`/`firstPageOfSheet`，与页名无关。

### 11.9 参考工程图框（原生 Sheet-Symbol）实现探查（j3，本轮 live 实测）

**结论：图框不是「页面设置」，而是每页一个放置的 `Sheet-Symbol` 元件；虽然有 `modifySchematicPageTitleBlock` 能改标题栏字段，但它无法把图框装进没有图框的页面——§11.10 记录了完整否证。**

探查方法：bridge `execute` + `eda.sys_FileManager.getDocumentSource()`，对象为参考工程
`eeba8a5545fd441a9d70c845b0df033e`（7 页，A3 3 页 + A4 4 页）。

- `eda.dmt_Schematic` / `dmt_Project` / `lib_Symbol` **没有**任何 title/frame/page 相关方法
  （按关键字过滤 `Object.keys` 为空），所以图框只能通过导入的文档源码声明。
- 每页 `getAllSchematicPagesInfo()` 都带 `showTitleBlock: true` 与 `titleBlockData`；
  `titleBlockData.Symbol.value` 为 `Sheet-Symbol_A3`（A3 页）或 `Drawing-Symbol_A4`（A4 绘图页），
  `titleBlockData['Page Size'].value` 为 `A3`/`A4`。`titleBlockData` 的字段
  （Page Size / @Page Name / @Page No / @Page Count / @Project Name / Version / Company /
  @Update Date / @Create Date …）来自该页图框元件的 `ATTR` 记录。
- CORE 页源码中的图框记录（持久化坐标，`y = IR_y - pageHeight`）：
  `{"partId":"pid8a0e77bacb214e","x":0,"y":0,"rotation":0,"isMirror":false,"attrs":{"Footprints":"[]","Devices":"[]","DeviceName":"{\"name\":\"Sheet-Symbol_A3_1\",\"source\":\"\",\"uuid\":\"bfbe682aba964f6a89723108613f166a\"}","FootprintName":null},"zIndex":910,"locked":false}`
  即图框元件位于页面**左下角** IR `(0, pageHeight)`，其后 6 条子 ATTR：
  `@Page Name (1213,-140,fs15,CENTER_MIDDLE)`、`@Project Name (1400,-100,fs20,CENTER_MIDDLE)`、
  `@Update Date (1470,-180,fs15,LEFT_MIDDLE)`、`@Create Date (1470,-160,fs15,LEFT_MIDDLE)`、
  `@Schematic Name (1190,-170,fs20,CENTER_MIDDLE)`、`@Page No (1430,-60,fs15,LEFT_MIDDLE)`、
  `Device (0,0,valueVisible:false)`；每条 `parentId` 指向图框元件 id，图框元件**没有**
  Designator/Name ATTR。
- 系统库 `0819f05c4eef4c71ace90d822a990e87` 提供整套图纸符号：
  `Sheet-Symbol_A4` device `4b872d674c0b4b0e8ede0a73cf1a0316` / symbol `f2baecf085944dad81faf9a0fd6bfcea`；
  `Sheet-Symbol_A3` device `25d1e29c59cf4041907f5908f56317a1` / symbol `6f8cc47a30c240bbb979c211cee8d9f2`
  （另有 A0/A1/A2/A5 与 A–E）。绘图页使用 `Drawing-Symbol_*`，其坐标空间与原理图页不同，
  **不**用于原理图页。
- 我们的导入路径 `serializeEasyEdaProject` 直接写 `SCH_PAGE` 文档源码，且
  `collectProjectLibrary` 按 IR 元件的 device/symbol uuid 抓取并本地化库文档，因此把图框作为
  一个元件写进页面源码即可，**不需要**走会挂起的 `sch_PrimitiveComponent.create`。

**实施决定（已按实测修正）**：原生图框元件虽然能写进页面源码并被客户端保留，但**不会渲染**，
因此本轮把该发射路径**移除**，导入/构建两条路径统一使用自绘 RECT/TEXT 图框（§11.10 记录了
否证过程与最终证据）。

### 11.10 原生图框的否证：客户端不认工程内自带的图纸符号（j3，本轮 live 实测）

§11.9 的推断是「把 `Sheet-Symbol` 元件写进页面源码即可」。本轮把它落地并用真实客户端
（V4.1.78）验证，结论是否定的。证据链：

1. **实现**：`collectProjectLibrary` 额外抓取图框 device/symbol 文档并本地化，序列化器每页
   发出 COMPONENT（`partId pid8a0e77bacb214e`、`zIndex 910`、`DeviceName` 指向本地 device）
   + 6 条动态 ATTR（`@Page Name/@Page No/@Project Name/@Schematic Name/@Update Date/@Create Date`）。
2. **源码层面成功**：导入后读回页面源码，图框记录逐字节保留（坐标与 §11.9 实测一致），
   `showTitleBlock` 也为 `true`。
3. **渲染层面失败**：页面属性面板「图纸」显示 **无**；`titleBlockData` 恒为 `{}`；
   `sch_PrimitiveComponent.getAll()` 里图框元件存在但 `componentType` 不是 sheet；
   截图无边框/标题栏。补发 `Symbol` 绑定 ATTR、或去掉合成 META（让符号文档与系统库原件
   一致）都不改变结果。
4. **替代路径「现造」不可用，但证据不闭环**：`eda.dmt_Schematic.modifySchematicPageTitleBlock(
   showTitleBlock, titleBlockData)` 确实存在（在 prototype 上，`Object.keys` 看不到，需
   `Object.getOwnPropertyNames(Object.getPrototypeOf(...))` 才能发现）。传入完整
   `{showTitle, showValue, value}` 结构（`@Page No`/`@Page Count` 为数字）后，在 `titleBlockData`
   为 `{}` 的页面上抛 `TypeError: Cannot convert undefined or null to object`，A3/A4 符号都一样；
   客户端自己（API）建的页面 `titleBlockData` 同样是 `{}`。
   **⚠️ t6 对抗性审查的修正**：`TypeError` 同样可以由「调用签名/参数结构不对」解释，因此它只
   证明「这个调用在空标题栏页上不工作」，**不证明**「该 API 只能改已有图框」。决定性对照是：
   在**参考工程已有原生图框的页面**上调用它并成功——该实验**尚未做**。
   **另有一条未稳定的事实**：`copySchematicPage`（页级复制）在同一个工程上两次调用
   **一次成功、一次返回 `undefined`**（j3 live 侧记录，本轮离线未复现）。所以「页级复制」这条路
   **存在但不可靠**，不能当交付路径依赖。
5. **库层不可读**：`lib_Device` **没有** `getDocumentSource`（只有 `get`），DEVICE 文档由
   `info.association`/`info.property` 合成；`sys_FileManager.getProjectFile/getSchematicFile`
   是「按文件名读盘」的导入接口，不能读当前工程的页元数据。

因此，按**证据强度分三层**表述（t6 对抗性审查后修正）：

- **程序化「现造」不可行（已证，范围限 V4.1.78）**：把 `Sheet-Symbol` 作为 COMPONENT 写进页面
  源码、或用 `modifySchematicPageTitleBlock` 在 `titleBlockData={}` 的页面上现造标题栏，在
  EasyEDA Pro V4.1.78 上都不成立（§11.10.1–11.10.4）。
- **页级「复制」有条件可用（未证稳）**：`copySchematicPage` 一次成功、一次 `undefined`（§11.10.4）。
- **不再声称「平台不可能」**：上述否证只覆盖单一客户端版本与单一发射方式，且缺两个对照实验
  （把**参考工程自己的页面源码**原样回灌看是否渲染；在**已有图框**的页面上调用
  `modifySchematicPageTitleBlock`），也从未走完 `sch_PrimitiveComponent.create`（「挂起 20s」
  ≠ 失败）。正确读法是：**当前版本、当前发射方式下不可行**。

`sheet-chrome.ts` 里保留参考图框的 uuid/字段表（含 `frameSymbolFor`）作为实测数据，供客户端
后续版本支持时重新接线；生产路径只发自绘图框，且不再向页面写入无效元件。


### 11.11 自绘图框对齐参考观感：双边框 + 分区刻度 + 标题栏（j3，本轮 live 实测）

原生元件不可用（§11.10），于是把「看起来像参考工程」这件事做实到自绘层：

- **双边框**：外框 inset 8、内框 inset 16，与参考帧的边框带一致。
- **分区刻度**：按参考帧把图幅分成 6 列 × 4 行，在边框带内画短刻度线（上下 5 条、左右 3 条）
  并标注 `1–6` / `A–D`（字号 12，落在带内居中）。
- **标题栏**：右下角 4 行（Project / Page / Size / Rev），右侧带 `n/m` 页码、日期与公司名。
  ⚠️ **此行已被 §13.1 / §13.3 取代**：现为 5 行 × 两组 = 11 格、宽 560、`titleBlockTop =
  height-16-130`（A3 1024 / A4 679），framed 内容下界 `height-170`（clearance 24），
  不再是「4 行」与 `height-150`。
- **实测**（本轮 live 导入，A3 单页 4 器件）：页面矩形 24（8 标题栏 + 1 模块框 + 16 刻度），
  文本 31，读回值依次为 `Project, DSH BOARD, Page, MAIN, 1/1, Size, A3, Rev, V1.0, DSH,
  1,1,…,6,6, A,A,…,D,D, MCU CORE`；截图中边框、刻度、标题栏均可见，值正确。
- **与参考工程仍有的差异**（都属于标题栏内容而非图框机制）：参考标题栏还有
  Schematic/Drawed/Reviewed/Part Number 等单元格与公司 Logo；我们只印四行。要补只需在
  `computeSheetChrome` 里加行/单元格，不影响导入与校验。
- **门禁**：535 tests、100% 覆盖率（含刻度几何与裁剪断言）、oxlint 0/0、`tsc -b` 干净。

**结论**：在 EasyEDA Pro V4.1.78 上，「平台原生图框」只能由客户端 UI 创建；我们能交付的是
**与参考工程同构的自绘图框**（双边框 + 分区刻度 + 标题栏），它随页导入、可打印、可读回，
且不会在页面里留下无效元件。


### 11.12 交叉复核结论（独立子代理对抗审查）

审查覆盖 sheet-chrome/serialize/build/tool-schematic/types，8 条发现，处置如下：

- 已修：**标题栏值溢出页外**（`VALUE_MAX` 42→28，42 个 20 号字在 354 单位单元格内必越界）；
  **分区列号未在边框带内垂直居中**（改为 `(8+16)/2-MARK_FONT/2`、`(y1+height-8)/2-MARK_FONT/2`）。
- **已修（原记为「留待下一轮」的那条）**：按是否画框收紧可用区。`layout.ts` 现在两处都用
  `edgePad = framed ? PAGE_EDGE_FRAMED(170) : PAGE_EDGE_FLAT(80)`（单页规划与分页规划各一处），
  framed 页的内容下界因此自动跟着 `titleBlockTop` 收；原句「正确修法…留待下一轮」**已过期，
  删除**。
- **仍开（与原残余不是同一件事，范围已缩小）**：扁平页（`framed=false`，无模块分组）在配置了
  `frame` 时**也会画 chrome**（`serialize.ts` 只判 `frame !== undefined`），而它的 `edgePad`
  仍是 80，故内容理论上仍可进入标题栏右下角；把 `PAGE_EDGE_FLAT` 提到 150 会让「超大单组保持
  单页」用例 1 页变 3 页。当前交付的板都是模块分组（`framed=true`），扁平页压字**没有实测
  样例**，列为残余跟踪（收紧项见 §14.5）。
- 其他残余：极小自定义页 `blockY<0`；`frameSymbolFor` 等参考常量仍在包入口公开导出（应标
  `@internal`）；`tool-schematic` validate 分支重复调用 `pageSizeFor` 且未透传 `titleBlock`。
- Y 轴与透传链路：复核未发现缺陷。


## 12. 生产交付路径接通 A3 与图纸边框/标题栏（j2，2026-10-17）

§11 只做到了「库层能用」：`SCHEMATIC_PAGE_A3` 与 `frame` 选项存在，但**面向模型的生产入口
（`tool-schematic`）一个都没用上**。本轮把这条链路接通，并对齐参考工程「每页默认有图纸框图」。

### 12.1 查出的三处断点

| 断点 | 位置 | 后果 |
|---|---|---|
| 工具硬编码 A4 | `tool-schematic` 的 `layout(bound, { symbolPins })` | 模型无法选 A3，密集板只能分页；提示词还写着「几何必须在 A4 内」 |
| `engine.serialize` 从不下发 frame | `schematic-easyeda` 的 `serialize()` 只传 `clientId`/`pageSize` | 工具返回的文档源码**没有任何边框/标题栏** |
| 图元（live）路径不画边框 | `buildIntoEasyEda` 只画模块框/层次块 | `verify: true` 的真实交付页没有图纸框 |

### 12.2 改动

1. **seam 新增引擎无关的标题栏类型**：`SchematicTitleBlockOptions { projectTitle?, version?,
   company?, date? }`，挂到 `SchematicEngineSerializeOptions` 与 `SchematicEngineVerifyOptions`
   （`titleBlock`）——引擎名/字段不泄漏 EasyEDA 的 schema。
2. **引擎映射**：`EasyEdaSchematicEngine.serialize` 把 `titleBlock` 映射为文档源码的 `frame`；
   `build`/`verify` 接受 `frame ?? titleBlock`，图元路径同样能画。
3. **图元路径新增 chrome chunk**：`toBuildPayload` 按页计算 `computeSheetChrome`，新增
   `renderChromeChunkScript`（先画边框线、再画标题栏文字，按几何/内容去重），失败降级为
   `SCHEMATIC_BUILD_FRAME_FAILED` 警告——与模块框同级的装饰语义。
4. **工具接线**：`schematic_generate`/`schematic_validate` 新增 `pageSize`（`A3`/`A4`）与
   `titleBlock` 参数；`Config.pageSize` 默认 **`A3`**、`Config.projectTitle`/`company` 作为
   默认标题栏字段；布局、校验、序列化、live 校验四处使用同一个 `pageSize`。

### 12.3 与原生图框的关系（重要）

j3 曾在 `serialize.ts` 尝试**原生图框**（`Sheet-Symbol_A3/A4` COMPONENT + 标题栏 ATTR），
live 复核（§11.10）证否后**已整体回退**：两条交付路径统一使用自绘 chrome。

- **项目导入路径**（`importIntoEasyEda`）与**图元 live 路径**（`buildIntoEasyEda`）→ 自绘
  双边框 + 分区刻度 + 标题栏，逐页写进页面源码；
- 原生 `Sheet-Symbol` 的 source 发射与库文档嵌入已删除（`collectProjectLibrary` 不再抓图框
  文档），页面里不会留下客户端不渲染的无效元件；
- `sheet-chrome.ts` 保留参考图框的 uuid/字段表与 `frameSymbolFor` 作为实测数据，供客户端
  后续版本支持时重新接线（有单测覆盖，文档 §11.9）。

### 12.4 验收

- `tsc -b` 通过；`oxlint` 0/0；**18 文件 / 535 用例全绿；覆盖率 100%**。
- 新增断言：A3 默认下发给布局与序列化、显式 A4 生效、`titleBlock` 四字段透传、配置兜底、
  非法 `pageSize`/非字符串字段被忽略、live 校验同样拿到 `pageSize`+`titleBlock`、
  chrome chunk 先于模块框且不进计数不变量、无 frame 时不发 chrome、chrome 失败降级为警告、
  分区刻度几何（5 条上/下刻度、3 条左/右刻度、`1–6`/`A–D` 标签）。
- j3 live 复核已完成（§11.11）：导入后每页矩形 24、文本 31，`Page Size`/`@Page Name` 等
  标题栏值由自绘文本正确打印；原生 `titleBlockData` 仍为空（客户端限制，§11.10）。


## 13. 11 格标题栏 + 边距同步调整（j2，子任务 t2，2026-10-18）

> 本节取代 §12 里关于标题栏的描述；§12 提到的「4 行 / 宽 430 / 内容下边界 `height-150`」
> 均已过期（见 13.1、13.3）。

### 13.1 标题栏：5 行 × 两组「标签+值」= 11 格

`computeSheetChrome` 的右下标题栏由 4 行英文格改为 5 行中文格，宽度 430 → **560**
（`LABEL_COLUMN 64 + VALUE_COLUMN 186` 两组 + `PAGE_COLUMN 60` 页码角格，常量求和得出
`TITLE_BLOCK_WIDTH`，避免列宽与总宽漂移）：

| 行 | 左组 | 右组 |
|---|---|---|
| 1 | 图样名称 = `schematicName`（缺省取页名） | 图号 = `drawingNumber` |
| 2 | 项目 = `projectTitle` | 图幅 = 页幅标签（A3/A4/`w×h`） |
| 3 | 版本 = `version` | 日期 = `date` |
| 4 | 设计 = `drawnBy` | 审核 = `checkedBy` |
| 5 | 批准 = `approvedBy` | 单位 = `company` |

外加**页次 `n/N` 右对齐挂在第 1 行右端**（`x = x1-6`，`RIGHT_TOP`），共 11 格。
**明确不设比例格**：电气图样不注比例，参考工程的图框里也没有该格。
缺值行为：标签行始终画出（格子有线有标签），**值为空则该格不产生文字图元**，留白。
A4 实测渲染（`rects=27 texts=41`）：

```
y=683: 图样名称@600 | MCU CORE@664 | 图号@850 | DSH-SCH-001@914 | >2/3@1148
y=709: 项目@600 | DSH Control Board@664 | 图幅@850 | A4@914
y=735: 版本@600 | V1.0@664 | 日期@850 | 2026-10-18@914
y=761: 设计@600 | j2@664 | 审核@850 | j3@914
y=787: 批准@600 | j1@664 | 单位@850 | DeepSeek@914
```

### 13.2 字段透传链路

- seam：`SchematicTitleBlockOptions` 新增 `drawingNumber / schematicName / drawnBy / checkedBy / approvedBy`；
- 引擎：`serialize` 与图元 `build` 路径都把 9 个字段透传进 `computeSheetChrome`；
- 工具：`schematic_generate` / `schematic_validate` 的 `titleBlock` 参数接受全部 9 个字段
  （参数本身是自由 JSON，无需改 schema），`Config` 新增同名字段做兜底，**单次调用优先于配置**。

### 13.3 边距 150 → 170（必须同步，否则压字）

5 行 × `ROW_HEIGHT 26` = 130，`titleBlockTop = height-16-130`：

| 页面 | 标题栏顶边 | framed 内容下界（`height-170`） | clearance |
|---|---|---|---|
| A4 825 | **679**（原 705） | **655**（原 675） | 24（原 4） |
| A3 1170 | **1024** | **1000** | 24 |

若不改边距，内容下界 675 与标题栏顶边 679 只差 4，模块框/文字会压到标题栏上。
`PAGE_EDGE_FRAMED` 因此 150 → 170；`computeBlockFrames` 的夹取上限自动跟着 `titleBlockTop` 走。

### 13.4 分页容量与填充率复测（30 器件 / 5 模块，A3 与 A4）

同一 IR、同一布局，只改 `PAGE_EDGE_FRAMED` 做 A/B：

> ⚠️ **口径提示**：下表填充率是 t2 期的**锚点口径**（符号 ±60/±40），已在 §14.2 被**交付口径**取代，
> 两者不可比。本文件当前的填充率数字**只在 §14.5**，且全部是交付口径。

| | 页数 | 器件/页 | 内容包围盒填充率（锚点口径，**已作废**） | 与标题栏重叠 | 越界 |
|---|---|---|---|---|---|
| A3 @170 | 2 | 24 + 6 | 46.4% / 12.6% | 0 | 0 |
| A3 @150 | 2 | 24 + 6 | 46.4% / 12.6% | 0 | 0 |
| A4 @170 | 5 | 6 × 5 | 30.1% | 0 | 0 |
| A4 @150 | 5 | 6 × 5 | 30.1% | 0 | 0 |

结论：

1. **边距改动零容量代价**：页数、每页器件数、填充率完全一致，只有居中内容整体平移 10 单位
   （可用区右下各收 20，居中后内容向左上偏 10），且包围盒下沿始终在标题栏顶边之上。
2. **无越界、无压标题栏**：7 页全部 0 overlap / 0 out-of-bounds（回归用例
   `packages/eda-core/tests/page-budget.spec.ts` 固化该不变量 + A3 满页 ≥35%）。
3. **≥35% 当时未全页达标**（锚点口径下的历史状态）：A3 满页 46.4% 达标；A3 尾页 12.6%、
   A4 单模块页 30.1% 不达标。根因是**按模块贪心分页、不做尾页再平衡**，与边距无关
   （150/170 两版数字相同）。该问题已由 §14 的再平衡 + 幅面收敛解决：交付口径下当前为
   A3 两页 **47.9% / 39.4%**、A4 五页 **47.2% ×5**（§14.5）。

### 13.5 验收

`tsc -b` 通过；`oxlint` 0/0；**19 文件 / 541 用例全绿；覆盖率 100%**。
新增回归：11 格几何与分隔线、缺值留白、无比例格、页名回退、9 字段透传（serialize + 工具）、
`Config` 兜底与单次覆盖、`titleBlockTop` 679/1024、A3/A4 分页容量与「不压标题栏」不变量。


## 14. 填充率收口：唯一口径 + 可自足的验收规则（j2，子任务 t4/t7/t10/t12，2026-10-18）

### 14.1 策略（三条，均已落地）

1. **band 容量均分再平衡**：先算一条 band 能横排几个 shard（`bandCapacity`，与放置循环同一判定），
   再 `bandCount = ceil(N/capacity)`、`bandLimit = ceil(N/bandCount)`。宽度贪心的 **4+1** 因此变成 **3+2**。
2. **欠满页幅面收敛**：每页两个盒——**紧盒**（符号 ±60/±40，只用于判定是否收敛）与**外扩盒**
   （左右 ±180、上 200、下 140，用于定尺寸，覆盖模块框与旗标/端口走线）。紧盒面积 < 35% 计划面积时，
   交付幅面收敛到 `外扩盒 + FITTED_MARGIN(60) + edgePad(170)`，下限 `592×300`、上限计划幅面；
   `sheet.pageSize` 随之落地，序列化器按**交付幅面**出图框（`serialize.ts` 的 `size = sheet.pageSize ?? pageSize`）。
3. **收敛页按交付宽度重新居中**（**t10 落地；t12 未改几何**）：原实现把外扩盒钉在固定 60 边距上；
   t9 在 **t8 时代 live 回读**上量到左 140 / 右 250（源 `docs/evidence/review/t9-cross-review.md:97`：
   框 x=140/460/780 与 140/460；该 t8 回读文件已随 t13 退休）。t10 改为
   `dx = snap((交付宽 − 外扩盒宽)/2 − 外扩盒.x1)`，t13 实测 live 边距 **192 / 182**（差 10 = 1 格）、
   IR 框并集边距 **200 / 190**，即已居中。
   ⚠️ **t14 订正**：t12 本身**没有**改动居中数学（只把常量搬进 `budget.ts` 并补回归断言），
   t13 独立复核确认「交付几何与 t10 之后一致（live 192/182、IR 200/190，两次相同）」；
   所以「左 140 / 右 250 是 t12 修好的」不成立——那是 **t8 时代**数据，修它的是 **t10**，
   且 t12 的居中重写在本板上**无可测变化**。回归断言用的是**模块件外扩盒**
   （离线 MAIN L=120 / R=110、MAIN 2 L=120 / R=90），与 live 的 192/182 是不同盒
   （外扩盒 vs 图元框），两者都 ≤ 1 格。

预算常量集中在 `packages/schematic/src/budget.ts` 的 `SCHEMATIC_PAGE_BUDGET`（`fillTarget 0.35`、
`fillFloor 0.25`、`moduleGap 200`、`fittedMargin 60`、`outwardX 180`…），布局与判定都读它，
测试不再重复声明常量（t8 指出的漂移风险）。

### 14.2 唯一口径：交付口径（`measurePageFill`）

**定义**（唯一实现：`packages/eda-core/src/measure.ts`）：

> 分子 = 该页**实际画出内容的包围盒**：模块框（`computeBlockFrames`：成员位置 ∪ 引脚端点，±80 外扩、
> 顶部再留 60 标题位）∪ 器件位置 ∪ 引脚端点；分母 = **交付幅面** `sheet.pageSize ?? planned`。

**为什么选它**：参考侧 `docs/evidence/current/t11-reference-metric.json` 用「内容几何（带位号元件 +
图元，排除原生图框）÷ A3 面积」量参考工程——与交付口径是**同一种量**（都是内容包围盒 ÷ 页面面积），
因此双方数字可比：我方 47.9% / 39.4% vs 参考 CORE 67.5%、DEVICE 57.3%、POWER 32.3%（§14.5）。
另外两种盒只作诊断，不作验收。
⚠️ **t14 订正**：本节旧版把 `docs/evidence/review/fill-measure.json` 的 **像素口径** 77.5 / 70.7 / 44.6
当成「同口径」，那其实是另一种量（像素墨迹），已不再作为同口径对照。

同一对页在三种盒下的数字（离线树内实测，`docs/evidence/review/t12-metrics.mjs`）：

| 口径 | 盒定义 | MAIN（3 模块 / 18 器件） | MAIN 2（2 模块 / 12 器件） |
|---|---|---|---|
| **交付口径（本文件唯一采用）** | 内容包围盒 ÷ 交付幅面 | **47.9%** | **39.4%** |
| 锚点盒（t2/t7 旧口径，**已作废**） | 锚点 ±60/±40 ÷ 交付幅面 | 37.9% | 30.2% |
| 框面积和（诊断） | Σ 模块框面积 ÷ 交付幅面 | 31.5% | 28.4% |

35% 线**正好横跨**这三种口径（尾页 28.4 / 30.2 / 39.4），所以「达标 / 不达标」若不标注口径就没有意义。
**本文件此后所有填充率均为交付口径**，逐页数字只在 §14.5；§13.4 的旧数字已就地标注作废。

live 回读（t8/t11）在交付口径下给同一尾页 40.0%，离线树内为 39.4%（差 0.6pt）：live 抓到的框高 820、
离线框高 840，差在离线框含顶部 60 标题位。两者同口径同结论，本文表格一律用**离线树内**数字。

### 14.3 验收规则：唯一实现 `checkPageBudget`（t12）

规则不再是测试里重写的一段代码，而是 `packages/eda-core/src/page-budget.ts` 的
`checkPageBudget(sheets, planned)`：测试只喂布局结果、断言判定，因此**不可能出现「测试比实现宽松」**。

> **单页**：`fill ≥ 35%` **或** 同时满足
> ① `atMinimum`：该页已交付在**它自己内容的**最小可行幅面上（`pageSize === fittedPageSize(外扩盒)`）；
> ② `ceiling < 35%`：该形状即便收到最小幅面也够不到目标；
> ③ `fill ≥ 25%`：绝对下限。
>
> **板块**：④ 每页器件数极差 ≤ 最大模块器件数（不许把某个模块孤立成一页）；
> ⑤ 相邻两页不得「合并后仍放得下一张计划幅面」（分页必须是最小的）。

`atMinimum` 必须由 `fittedPageSize(outwardContentBox(锚点))` 算出——**不能**用交付口径的墨迹盒去算：
墨迹盒比外扩盒小，用它算出的「最小幅面」会小于实现真正能交付的幅面（t11 实测：A4 页交付 890 宽，
用墨迹盒算出来只有 730 宽），于是收敛页会被误判成「没收敛」。这两个函数现在**可组合**，
A4 页实测 `minSize === pageSize === 890×825`（§14.5）。

**被删掉的旧条款**（t9 控制实验证明系统性恒真）：

| 旧条款 | 为什么恒真 |
|---|---|
| `fill ≥ 0.9 × 上限` | 测试用 `ceil` 算最小幅面、实现用 `snap`（四舍五入），于是 `最小幅面 ≥ 交付幅面` ⇒ `上限 ≤ fill` ⇒ 90% 恒成立 |
| 「交付幅面 ≤ 最小可行幅面 + 1 格」 | 同上，`ceil` 版最小幅面恒 ≥ 交付幅面 |

t9 的旁路证据：`moduleColumns: 1` 会产出 5 页、每页一个模块，旧规则**全部判 PASS**（实际靠
`parts == [18,12]` 这种硬断言兜底）；新规则判 **FAIL(minimum, floor)**，且没有任何器件数断言参与（§14.4 用例 3）。

### 14.4 控制实验（已固化为回归用例，`packages/eda-core/tests/page-budget.spec.ts`）

| # | 控制用例 | 实测输出（`describePageBudget` 原文） | 判定 |
|---|---|---|---|
| 1 | 交付（t5 收敛页，基准） | `OK MAIN:1230x1170* parts=18 fill=47.9% min=1250x1170 \| MAIN 2:910x1170* parts=12 fill=39.4% min=930x1170` | **PASS**（两页都 ≥35%，未用豁免） |
| 2 | 不收敛，直接交付整张 A3 | `FAIL(minimum,ceiling,floor) MAIN:1655x1170 parts=18 fill=35.6% min=1250x1170 \| MAIN 2:1655x1170 parts=12 fill=21.7% min=930x1170` | **FAIL** |
| 3 | `moduleColumns:1`（t9 旁路） | `FAIL(minimum,floor ×5) MCU:592x1170* parts=6 fill=21.8% min=610x1170 \| …` | **FAIL** |
| 4 | 宽度贪心 4+1（t7 修掉的） | `FAIL(distribution) ?:1655x1170 parts=24 fill=54.2% \| CLK:592x1170* parts=6 fill=37.9%` | **FAIL** |
| 5 | 可合并的分页（5×5，一页一模块） | `FAIL(pagination ×4) MCU:592x1050* parts=5 fill=36.0% min=592x1050=min \| …` | **FAIL** |
| 6 | 真被形状卡住的页（手搓） | `OK CAPPED:592x1170* parts=2 fill=34.0% min=592x1170=min` | **PASS**（走豁免，证明该分支可达、非死代码） |

用例 3 的断言代码（判定只看 `report.ok` 与触发的规则名，`page.parts` 那行只是**记录**布局产出）：

```ts
const report = judge(ir, SCHEMATIC_PAGE_A3, { symbolPins: new Map([['sym', pins]]), moduleColumns: 1 })
expect(report.pages.length).toBe(5)
expect(report.pages.map(page => page.parts)).toEqual([6, 6, 6, 6, 6])
for (const page of report.pages) {
  expect(page.fill).toBeLessThan(SCHEMATIC_PAGE_BUDGET.fillTarget)
  expect(page.fill).toBeLessThan(SCHEMATIC_PAGE_BUDGET.fillFloor)
}
expect(report.ok).toBe(false)
expect(rules(report)).toEqual(['floor', 'minimum'])
```

用例 5 特别值得记：**每页 36.0% 都过了 35%**，板块仍因 `pagination` 判 FAIL——规则不是只看填充率。

#### 跨复核数值对照（t14 订正①：不得只留单一未复现数值）

同一形态（`moduleColumns:1`，5 页）在不同几何来源下有三个数，**判定全部是 ok=false**：

| 来源 | 口径 / 几何来源 | 数值 | 判定 | 复现 |
|---|---|---|---|---|
| 本表用例 3（t12，离线） | 交付口径 ÷ `computeBlockFrames`（IR） | **21.8%** ×5 | FAIL(minimum,floor) | `node node_modules/vitest/vitest.mjs run packages/eda-core/tests/page-budget.spec.ts --reporter=basic` |
| t13 独立复核（j3，live） | 交付口径 ÷ live `rectBox` 框 | **23.7%** ×5 | FAIL(pagination×4, floor×5) | `docs/evidence/current/index.json` → `adversarial.cases["moduleColumns:1 on A3"]` |
| t9 控制实验（旧规则，旁路） | t9 当时的盒（**非**交付口径） | **14.1%** ×5 | 旧规则 **PASS**（旁路） | `docs/evidence/review/t9-cross-review.md:132` + `t9-rule-audit.mjs` |

同一形态的不收敛尾页：离线 **21.7%**（本表用例 2）vs t13 live **22.0%**。A4 收敛页：本文件离线夹具
**47.2% ×5**（§14.5）vs t13 夹具 **38.1% ×5**——两者都 ≥35%、都 PASS，差在夹具器件数与符号几何。

**差异来源**：① **几何来源**——IR 的 `computeBlockFrames` 框（离线 180×840）vs live `rectBox` 框
（t13 实测 200×820），同页同器件、框尺寸不同；② **夹具**——模块器件数/符号几何不同。
**不是规则差异**：三种来源对同一形态都判 ok=false。

⚠️ 交付文档里曾出现的 **14.4%** 与复核方复现的 **15.0%**，在本树任何文件中都检索不到
（全树检索只命中 t9 的 **14.1%** 与章节号「§14.4」），故**不保留任何单一数值**：上表三个可复现数值并列，
其中**同口径**的两个是 **21.8%（离线）/ 23.7%（live）**，14.1% 是旧规则口径下的历史旁路记录。

### 14.5 实测表（交付口径，离线树内；`*` = 幅面已收敛）

| 板 | 页 | 交付幅面 | 器件 | 交付口径填充 | 最小可行幅面 | `atMinimum` | 判定 |
|---|---|---|---|---|---|---|---|
| t5 形状（5×6 窄高模块） | MAIN | 1230×1170* | 18 | **47.9%** | 1250×1170 | 否 | ✅ ≥35% |
| t5 形状 | MAIN 2 | 910×1170* | 12 | **39.4%** | 930×1170 | 否 | ✅ ≥35% |
| 宽模块夹具（5×6） | 0 / 1 | 1230×1170* / 910×1170* | 18 / 12 | **54.7% / 49.3%** | 同交付 | 是 | ✅ ≥35% |
| A4 夹具（5×6） | 0–4 | 890×825* ×5 | 6 | **47.2% ×5** | 890×825 | 是 | ✅ ≥35% |
| 单模块 1×12（A3） | MAIN | 1655×1170（未收敛） | 12 | **34.7%** | 1110×1170 | 否 | ❌ `minimum,ceiling` |

越界 0、压标题栏 0（逐页断言）。最后一行是 t12 的**真实发现**：收敛触发用**紧盒**、验收用**交付口径**，
两把尺子在边界上会打架——该页紧盒 ≥35% 故不收敛，交付口径只有 34.7%，而它本可以收到 1110 宽（→51.8%）。
规则判 FAIL 是**对的**（这是漏收敛，不是「形状不可达」）；要修需把收敛触发改成同一把尺子，
属布局行为改动 + 黄金样例重生成，本轮不做，登记为遗留项。

**参考侧（同口径，可比；t14 订正来源）**：`docs/evidence/current/t11-reference-metric.json` 用
「内容几何（带位号元件 + 图元，排除原生图框）÷ A3 面积」测得 **CORE 67.5%（含图元 71.1%）、
DEVICE 57.3%（73.7%）、POWER 32.3%（32.4%）**。我方 47.9% / 39.4% 落在 POWER 与 DEVICE/CORE 之间：
**参考 POWER 页比我们更空**，CORE/DEVICE 更密。参考侧**带位号器件**是我方的 1.9–3.2 倍
（43/34/58 vs 18/12），不是旧文写的 4–10 倍（那个倍数把原生图框自带的 140/75/44 个子元件也算进去了）。
⚠️ 旧版引用的 77.5% / 70.7% / 44.6%（`docs/evidence/review/fill-measure.json`，**像素口径**）
是另一种量，不再作为同口径对照（j1 亦指出过像素口径不可比）。

**未收口项（如实记录）**：页名仍是 `MAIN` / `MAIN 2` 而非模块名（多模块页无法等于三个模块名），
「页名 = 模块名」这条验收仍未满足，建议改为 `MCU+POWER+IO` 形式，需改 `pageModuleTitle` 并重生成黄金样例。

### 14.6 密度差距：刻意取舍 vs 还可收紧（结论保留，数字口径已作废）

**刻意保留（不收紧，有理由）**

1. 模块框留白（`FRAME_PAD 80` + 顶部标题位 60）：给模块名/引脚名留位，收紧会压标签。
2. 标题栏 11 格 560×130（占 A3 4.1%）与 24 单位 clearance：有规格含义，不动。
3. `edgePad 170` / `FITTED_MARGIN 60`：安全区，避免与边框、刻度、标题栏打架。

**曾评估的收紧**：t7 做过一次灵敏度实验（`FITTED_MARGIN 60→40`、`OUTWARD_X 180→140`、
`OUTWARD_TOP 200→160`），当时结论是尾页可由 30.2% 提到 35.8%（**锚点口径，已作废**），
数字不再在本文件重复（原始记录见 git 历史与 `docs/evidence/review/t9-*.json`）。在**交付口径**下
尾页已是 39.4%，**不再需要**这组收紧；且 `OUT_X 140` 只比模块框半宽 + 旗标略宽，有旗标/端口越界风险，
故不采用。

### 14.7 复现

```bash
node node_modules/typescript/bin/tsc -b
node node_modules/oxlint/bin/oxlint packages
node node_modules/vitest/vitest.mjs run --coverage --reporter=dot
# 规则判定 + 控制实验的原始输出（每条用例都会打印 describePageBudget）：
node node_modules/vitest/vitest.mjs run packages/eda-core/tests/page-budget.spec.ts --reporter=basic
# 三种盒口径对照表（需先 pnpm build）：
node docs/evidence/review/t12-metrics.mjs
```

⚠️ **不要**用 `node docs/evidence/tools/t5-board.mjs` 复核：它 import `packages/*/lib/`，而该目录由
`tsdown` 产出、`tsc -b` 只写 `lib/types`；未跑 `pnpm build` 时读到旧 bundle（t7 踩过：旧 bundle 给出
4+1 页 / 37.9% / 4.2%）。从 `src` 直跑（vitest）才反映当前实现。


### 14.8 门禁（t12 收口）

```bash
node node_modules/typescript/bin/tsc -b          # exit 0
node node_modules/oxlint/bin/oxlint packages     # Found 0 warnings and 0 errors. (42 files, 16 rules)
node node_modules/vitest/vitest.mjs run --coverage --reporter=dot
#   Test Files  19 passed (19)
#        Tests  553 passed (553)
#   All files  | 100 | 100 | 100 | 100
#   measure.ts | 100 | 100 | 100 | 100     page-budget.ts | 100 | 100 | 100 | 100
#   budget.ts  | 100 | 100 | 100 | 100     layout.ts      | 100 | 100 | 100 | 100
```

黄金样例 `layout-golden.json`（`packages/schematic/tests/fixtures` 与 `packages/eda-core/tests/fixtures`）
**不含任何收敛页**——两个 fixture 里 `pageSize` 出现 **0** 次——所以 t10 的居中改动它们发现不了。
这正是「左 140 / 右 250」能活到 t9 的原因：收敛页几何当时**没有任何黄金样例或断言覆盖**。
现在由 `page-budget.spec.ts` 的 `centres a converged page on the sheet it converges to` 锁定。

**t14 复核运行**（本轮只改文档与证据文字，未动布局算法与规则实现）：`tsc -b` exit 0、
`oxlint` 0 warnings / 0 errors（42 文件）、**19 文件 / 553 用例通过**、覆盖率 **100%**（原始输出见 t14 报告）。

### 14.9 已知差异 / 后续课题（t11/t13 已量化，t14 补记）

**差异 1：模块框窄高、框内大片空白，根因是单列打包策略——不能归因于「测试板器件少」**

t13 live 回读（`docs/evidence/current/t13-readback.json`）里每页的模块框是 **200×820**（MAIN 三个、
MAIN 2 两个），长宽比 **1:4.1**；离线 IR 框为 180×840（1:4.7）。框内实测（`docs/evidence/review/t14-visual-gap.mjs`）：
6 个器件排成**一列**，紧盒只有 120×680，**占框面积 54%，即 46% 是框内空白**，且五个模块数值完全相同
——这是**固定单列打包**的签名。同样 6 器件的模块，参考侧排成多列，块是**宽而矮**的：
t11 实测 CORE 1050×760（1.4:1）、DEVICE 1414×918（1.5:1）、POWER 540×310（1.7:1）。
所以「框内空」是**策略**造成的，不是器件数量造成的。

**本轮不强制改的理由**：把单列打包改成多列会同时改变 band 容量、每页模块数、收敛幅面与尾页平衡，
即**动分页稳定性**，属独立课题（需要自己的黄金样例与 live 对照）；本轮验收规则在现有策略下已全部通过
（§14.5），故只登记差异、不改实现。

**差异 2：页名仍是 `MAIN` / `MAIN 2`**（多模块页无法等于三个模块名）——见 §14.5 未收口项。

**差异 3：参考侧无法用同一函数量测**（t13 保留意见之一）——参考工程没有 IR，客户端 API 无法把原生
图框与网络旗标/标签干净分离，故参考侧只能按 t11 的方法在 live 几何上近似同口径。

### 14.10 独立复核与保留意见（t13，j3）

**复核结论：t12 判 pass。** 来源 `docs/evidence/current/index.json`
（`generatedAt 2026-10-18T06:25:11Z`，`purpose: "t13 independent review of t12: rule enforcement,
adversarial attempts, live re-verification"`）：

- 门禁复核：tsc clean / oxlint 0-0（42 文件）/ vitest **19 文件 553 用例通过**（该轮未跑 `--coverage`，
  覆盖率数字由 t12 自报 100%）。
- 现场导入：项目 `dsh-t13-…`，`validateErrors: 0`、`budgetOk: true`、2 页；两页 rects/texts 与期望一致
  （30/44、29/43）。
- 对抗实验 7 例，`bypassConclusion: "no bypass found: every below-target page is caught either by
  minimum (not delivered on its smallest sheet), ceiling (the shape could reach the target) or
  floor (below 25%)"`。
- 规则确实在门禁里执行：`specEnforcement` 指出 spec 断言的是规则**判定与规则名**，
  `parts==[18,12]` 只是并列的形状守卫，不是执行点。

**t13 两条保留意见（原文引用）**：

1. **参考侧同口径不可得**：`referenceComparison.limitation` = "the same metric cannot be computed on
   the reference: it has no IR, and the client API cannot cleanly separate the native frame from net
   flags/labels"（对应 §14.9 差异 3）。
2. **居中 baseline 不可复现**：`centering.note` = "…t12 centering baseline (left 140 / right 250) does
   not reproduce against the t10 tree; it may describe the pre-t10 state."（**t14 已据此订正 §14.1 第 3 条**）。

另记：t13 的 `coverage` 字段注明该轮只跑套件、未跑覆盖率，因此覆盖率证据来源仍是 `--coverage` 运行；
t14 已重跑一次（§14.8）。
