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

计数判据：flag = `netflag` + `netport`；线段 = 每条导线折线数之和；三个变体只差
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
- **NIT 计数判据**：live 探针 `rects:8` = 图框 7 + 模块框 1；`texts:10` = 图框 11 条中 company
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
（全树检索只命中 t9 的 **14.1%** 与章节号「§14.4」）。这两个数属**外部记账残留**：既无可复现命令，
也不对应本树的任何一种几何口径，**不再作为遗留项跟踪**。

**结论写法**：同一形态**跨口径的数值不可直接互比**（21.8 / 23.7 / 14.1），只能并列记录；
可比的是**判定**——三种来源对同一形态都给 ok=false。不要把「数值随口径变」误读成「结论随口径变」。

### 14.5 实测表（交付口径，离线树内；`*` = 幅面已收敛）

> 下表是 t12/t14 基线。t15 模块内多列打包后的实测另见 §14.11；两套数字不要混引。

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

**参考侧（近似同口径，见 §14.9 差异 3；t14 订正来源）**：`docs/evidence/current/t11-reference-metric.json` 用
「内容几何（带位号元件 + 图元，排除原生图框）÷ A3 面积」测得 **CORE 67.5%（含图元 71.1%）、
DEVICE 57.3%（73.7%）、POWER 32.3%（32.4%）**。
⚠️ 口径并非同一个函数：`measurePageFill` 的框**包含我们画出来的模块框**（框是绘制内容），
而参考侧那一列**排除**原生图框、只算带位号元件的外包盒。两者只能算「同类盒子」，
不能当「同一口径」互算差额（t17 订正）。我方 47.9% / 39.4% 落在 POWER 与 DEVICE/CORE 之间：
**参考 POWER 页比我们更空**，CORE/DEVICE 更密。参考侧**带位号器件**是我方的 1.9–3.2 倍
（43/34/58 vs 18/12），不是旧文写的 4–10 倍（那个倍数把原生图框自带的 140/75/44 个子元件也算进去了）。
⚠️ 旧版引用的 77.5% / 70.7% / 44.6%（`docs/evidence/review/fill-measure.json`，**像素口径**）
是另一种量，不再作为同口径对照（j1 亦指出过像素口径不可比）。

**未收口项（t16 已处理）**：页名曾是 `MAIN` / `MAIN 2` 而非模块名。t16 改为模块列表
（`MCU+POWER+IO` / `MEM+CLK`），并把隐式层级绑定钉到改名后的第一页，见 §14.12。

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
到 t16 为止**不含任何收敛页**——两个 fixture 里 `pageSize` 出现 **0** 次——所以 t10 的居中改动它们发现不了。
这正是「左 140 / 右 250」能活到 t9 的原因：收敛页几何当时**没有任何黄金样例或断言覆盖**。
t17 之前由 `page-budget.spec.ts` 的 `centres a converged page on the sheet it converges to` 锁定；
**t17 起** `module-golden.json` 自身带上一页收敛（910×700，见 §14.13），收敛坐标也进黄金样例了。

**t14 复核运行**（本轮只改文档与证据文字，未动布局算法与规则实现）：`tsc -b` exit 0、
`oxlint` 0 warnings / 0 errors（42 文件）、**19 文件 / 553 用例通过**、覆盖率 **100%**（原始输出见 t14 报告）。

### 14.9 已知差异 / 后续课题（t11/t13 已量化，t14 补记）

**差异 1：模块框窄高、框内大片空白，根因是单列打包策略——不能归因于「测试板器件少」**

> **t15 后续**：本条已在多列打包中处理，见 §14.11；下面保留当时的取舍记录。

t13 live 回读（`docs/evidence/current/t13-readback.json`）里每页的模块框是 **200×820**（MAIN 三个、
MAIN 2 两个），长宽比 **1:4.1**；离线 IR 框为 180×840（1:4.7）。框内实测（`docs/evidence/review/t14-visual-gap.mjs`）：
6 个器件排成**一列**，紧盒只有 120×680，对**离线 IR 框 180×840** 占 54%，即 **46% 是框内空白**
（该百分比只在离线 IR 框口径下成立；live 框 200×820 用同一紧盒折算约 **50%**，两种口径不可混引），
且五个模块数值完全相同
——这是**固定单列打包**的签名。同样 6 器件的模块，参考侧排成多列，块是**宽而矮**的：
t11 实测 CORE 1050×760（1.4:1）、DEVICE 1414×918（1.5:1）、POWER 540×310（1.7:1）。
所以「框内空」是**策略**造成的，不是器件数量造成的。

**本轮不强制改的理由**：把单列打包改成多列会同时改变 band 容量、每页模块数、收敛幅面与尾页平衡，
即**动分页稳定性**，属独立课题（需要自己的黄金样例与 live 对照）；本轮验收规则在现有策略下已全部通过
（§14.5），故只登记差异、不改实现。

**差异 2：页名曾是 `MAIN` / `MAIN 2`**（t15 时；多模块页无法等于三个模块名）——t16 已改为
模块列表，见 §14.12。

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

### 14.11 后续优化（t15）：模块内多列打包

§14.9 差异 1 的根因不是器件少，而是**同一信号流层内的器件只排一列**。t15 把这样的层拆成
左右平衡的子列，目标块宽高比 **1.4:1**（参考 CORE/DEVICE/POWER 实测 1.4–1.7:1）；同时把
分页从「4+1」改成「3+2」，不足一行的带水平居中。

**改动点**（`packages/schematic/src/layout.ts`）：

1. `targetColumnsOf` / `splitLayerColumns`：同层器件 >2 时，按平均器件高与列距求目标列数，
   连续且按计数平衡地切成子列；平板（未分组）仍用 1 列，保持原行为。
2. `placeGroup` 与 `shardGroup` 共用这套切分，单页规划与分页交付不会给出两种块形。
3. `planPaginated` 增加每页模块上限（`ceil(N / ceil(N / 每页容量))`）与 `centreBands`：
   5 个模块落到 3+2，而不是把第 5 个孤立到第二页（4+1）。

**同一 t14 夹具的实测**（`node docs/evidence/review/t15-compact.mjs`，离线树内）：

| 量 | t14（单列） | t15（多列） |
|---|---|---|
| 模块框 | 180×840（1:4.7） | **480×480（1:1.0）**（IO 下沿让标题栏，480×444） |
| 紧盒 | 120×680 | **420×320** |
| 框内空白（对 180×840 框） | 46.0% | **41.7%** |
| t5 A3 MAIN / MAIN 2 填充 | 47.9% / 39.4% | **53.6% / 43.2%** |
| t5 A3 器件数 | 18 / 12 | 18 / 12 |
| A4 五模块板填充 | 47.2% ×5 | 39.6% ×5 |

A4 的填充率下降是**取舍**：竖版页面上的方形块更接近参考形态，但墨迹包围盒变窄；两版都
≥35%，验收均 OK。t5 A3 的 MAIN 页现在紧盒已越过 35% 门槛，规则判「够密」，保留整张 A3
（不再收敛到 1530×1170）；MAIN 2 收敛到 1510×810。分页仍是最小的：3+2 两页，没有触发
`distribution` 或 `pagination`。

**门禁（t15 运行）**：`tsc -b` exit 0；`oxlint packages` 0 warnings / 0 errors（42 文件）；
`vitest --coverage` **19 文件 / 554 用例**通过，覆盖率 **100%**。控制用例改为手搓页面，
不再依赖旧的单列打包形状：一个模块一页、24+6 分布不均、两页可合并三种形态仍分别命中
`floor/minimum`、`distribution`、`pagination`。

**未收口**：页名已在 t16 改为模块列表（§14.12）；参考侧同口径量测限制仍在（§14.10）；
块宽高比 1:1 仍低于参考的 1.4:1，差额来自图框 80 内边距与 60 标题位，若要更宽需改图框规格。

### 14.12 后续优化（t16）：页名改为模块列表 + 层级绑定加固

t15 的未收口项是页名。t16 把 `pageModuleTitle` 从「只有单模块页才用模块名」改成「一页最多列
三个模块标题，用 `+` 连接」：

- t5 A3 两页：`MCU+POWER+IO` / `MEM+CLK`（`node docs/evidence/review/t16-page-names.mjs`）。
- A4 一模块一页时仍是 `MCU` / `POWER` / `IO` / `MEM` / `CLK`。
- 超过 3 个模块，或合成名超过 40 字符，回退到作者页名（+序号）：标签页不会被一行清单撑爆。
- 既有唯一性规则不变：同名续页加序号，且续页不得占用其他源表的作者名（`MAIN 2` 用例仍通过）。

**同一轮加固层级绑定**：页 0 被改名后，原先靠作者页名隐式绑定的 `block`（`designator` /
`netName` / `id` 匹配）会在布局阶段钉到该源表第一页的 `sheetIndex`；若多个名字命中不同页，
保持原样让校验器继续报 `HIERARCHY_AMBIGUOUS_BLOCK`。没有这一步，`MCU+POWER+IO` 这样的
新页名会让旧绑定无声失效。

**试过但不采用**：把 `MODULE_BLOCK_ASPECT` 从 1.4 提到 1.7 会逼出 3 列 × 2 行，块变成
780×360（1:0.5），框内空白反而从 41.7% 升到 **48.7%**；A3 从 3+2 变成 2+2+1 三页，尾页
只剩 34.2%，低于 35% 目标。故保留 1.4 / 2 列。

**验证**：t16 证据脚本输出
`0: name="MCU+POWER+IO" ... parts=18 page=1655x1170` /
`1: name="MEM+CLK" ... parts=12 page=1510x810`；t15 的几何数字不变（53.6% / 43.2%，仍 3+2 两页）。
门禁：`tsc -b` exit 0；`oxlint packages` 0 warnings / 0 errors（42 文件）；
`vitest --coverage` **19 文件 / 560 用例**通过，覆盖率 **100%**。

**未收口**：live 回读/截图仍未重跑——本轮环境没有运行中的 EasyEDA 桌面端，49620–49630
无监听，`live-verify.mjs` 无法发现 bridge；需在打开客户端后补一次 t13 回读。块宽高比 1:1
仍低于参考 1.4:1（差额来自图框 80 内边距 + 60 标题位），参考侧同口径量测限制仍在（§14.10）。

### 14.13 后续优化（t17）：单页路径也收敛 + 口径文字订正

**先订正上一轮遗留的三处文字**（只动文档，不动代码）：

1. §14.9 的 **46%** 明确标注为**离线 IR 框 180×840** 口径；live 框 200×820 用同一紧盒折算约 **50%**，
   两种口径不可混引。
2. §14.5 参考侧标题由「同口径，可比」改为「**近似同口径**」：`measurePageFill` 的框**包含我们画出来的
   模块框**，而参考侧那一列**排除**原生图框，只能算「同类盒子」，不能当同一函数互算差额。
3. §14.4 的 **14.4% / 15.0%** 结案：全树检索只命中这两个字面量所在的说明句本身，既无可复现命令、
   也不对应任何几何口径，**不再作为遗留项**；可复现的是 21.8%（离线）/ 23.7%（live）/ 14.1%（旧规则）。

**本轮的实现优化：单页路径从来没收敛过。**

`fitPageSize` 只在 `planPaginated` 里被调用；`planSheet` 的单页快路径直接返回计划的 `options`。
后果是一块只会占紧盒 **20.9%** 的单模块 A3 板按整张 **1655×1170** 交付（交付口径 30.4%），
既难看，也**违反本仓自己的 `minimum` 规则**（低于 35% 却没交付在最小幅面上）——而同一块内容一旦
走到分页路径就会收敛。这就是 §14.5 末行「34.7% 漏收敛」的真实根因，不是「两把尺子」，是**只有一把
尺子在工作、另一条路径根本没量**。

**改动**（`packages/schematic/src/layout.ts`）：把「收敛 + 居中」抽成 `fitAndCentre()`，分页与单页
两条路径共用；单页路径传 `recentrePlanned = false`——未收敛的页不移动坐标，否则所有单页板都会被整体
平移一遍（t17 第一次尝试就是这样把 7 个用例和两份黄金样例打翻的）。

**实测**（同构夹具：1 模块 12 器件、A3、`node docs/evidence/review/t17-single-page.mjs`）：

| 量 | t16 | t17 |
|---|---|---|
| 交付幅面 | 1655×1170（未收敛） | **1390×930**（收敛） |
| 交付口径填充 | 30.4% | **45.5%**（+15.1pt） |
| 框内器件落点 | 贴左上 | 居中（框 980×600 @ 220,110） |

**黄金样例**：`module-golden.json`（NE555 BLINKER，2 模块 3 器件）由「A4 不收敛」变为 **910×700 收敛**，
填充 32.9% → **36.2%**；这是本仓第一次有收敛页进黄金样例，收敛坐标从此被 fixture 锁定（§14.8）。
同时修正 `gen-golden.mts` 的 pin id 字面量——它写的是 `p1`，而提交的 fixture 是 `u1-p1`，照原样重跑
会把两份 input 改脏（本轮已对齐，重跑后 input 零差异）。

**未变**：t5 五模块 A3 仍 **53.6% / 43.2%**（3+2 两页），A4 五模块板仍 **39.6% ×5**——两者都走分页路径，
本来就会收敛。`page-budget` 六条控制实验输出与 §14.4 表一致。

**门禁（独立复跑，非自报）**：`tsc -b` exit 0；`oxlint packages` 0 warnings / 0 errors（42 文件）；
`vitest --coverage` **19 文件 / 560 用例通过，覆盖率 100%**。

**仍未收口**：live 回读/截图（无客户端 bridge，同上）；块形 1:1 vs 参考 1.4–1.7，差额仍在图框规格
（80 内边距 + 60 标题位），改它属观感改动、需 live 对照后才动。

> **2026-10-18 补记**：live 回读/截图已由 §14.14 完成（按 landing 流程重注册 bridge 后）。

### 14.14 live 闭环（t18）：拟合页回读高度 + 声明线过滤

**为什么现在才跑 live**：此前 EasyEDA 客户端一直没连上；本轮按仓内 landing 流程重注册（脚本弹窗被拦截时点
“open the landing page”，BroadcastChannel 把编辑器标签页注册到 49620），bridge `--check` 退出 0 后才开始。

**live 首跑抓到的真 bug（拟合页丢网）**：t5 五模块板两页 [18,12]；第 2 页（MEM+CLK）按内容收敛到
**1510×810**（请求幅面 A3 1655×1170）。`diffNetlists` 仍用 `options.pageSize.height=1170` 反算持久化 Y，
而 EasyEDA 的持久化 Y 是 `layoutY - 交付页高`；810 的页按 1170 反算后，第 2 页 12 个器件的 24 个引脚
全被读成 `SCHEMATIC_NETLIST_DROPPED`。回读源本身正确（12 器件、24 条 NET），不是导入丢数据。

**修复 1**：`build.ts` 增加
`deliveredPageSize(sheet, requested) => sheet.pageSize ?? requested`，
**import 调用点**改传它（交付路径就是 `.epru` 导入，页幅面随 `sheet.pageSize` 落盘）。回归用例
`diffs each imported page against its own delivered height`：两页 IR（尾页 `pageSize 1510×810`）
逐页序列化回读，旧代码报 dropped、新代码零 error。**verify/primitive 路径不用 `deliveredPageSize`**：
它走 `SCH_*` API，持久化是 `-layoutY`（与页高无关），由 `ySign=-1` 投影（§14.17）。

**修复 2（同一轮 live 暴露的第二个误报）**：修复 1 后 error 归零，但剩 10 条 `SCHEMATIC_IMPORT_NET`
（MEM/CLK 的 A1–A5；消息里的 “page 1” 指第 1 页，也就是含这些声明行的 MCU+POWER+IO 页）。根因：
分页把源页所有 authored wire 行留在第 1 页并剥掉 `dots`（只为保住 ATTR；路由再给每页画新线），
NET 检查却把这些**声明行**当成要落盘的已画线；序列化本就不画它们。离线 mock 重放 live 回读源确认：
第 1 页 `sheet.wires=46`、落盘 NET 36，差额正是 10 条 MEM/CLK 声明；第 2 页 24 条已画线全部命中。
修复：verify/import 两处 NET 检查与 oracle 的客户端网表对账都跳过
`(wire.dots ?? []).length === 0` 的行（与 `serialize.ts` 的声明判定同口径），并各加回归断言。

**t18 live 证据**：`node docs/evidence/review/t18-live-loop.mjs`（bridge 49620，真实窗口）：

| 页 | 名称 | 交付幅面 | 矩形 | 器件 | 模块框 | 填充 |
|---|---|---|---|---|---|---|
| 0 | MCU+POWER+IO | 1655×1170 | 30 | 18 | 3/3 | 54.0% |
| 1 | MEM+CLK | **1510×810** | 29 | 12 | 2/2 | 42.1% |

`findings` 为空，脚本 PASS；截图 `docs/evidence/current/t18-page1-mcu-power-io.png`、
`t18-page2-mem-clk.png`。页名、幅面、矩形/器件数、模块框位置与标题全部由 live 回读断言，
不是只看导入返回值。

**文字数 38/37 vs t13 44/43 不是回归**：逐值 diff 显示差异只是标题栏字段（t13 传了公司/图号/日期/版本/作者，
t18 走默认标题栏），MCU/POWER/IO/MEM/CLK 模块标题两版都在；矩形、线、器件数与 t13 完全一致。

**脚本自身修的两处**：`t5-board.measure()` 的 `pageSize` 先写对象又被字符串覆盖，改为对象 +
`pageSizeLabel`；t18 的页高改 `max(rect.y)+8`（该 API 的 `y` 是下边），模块框匹配用
`pageHeight - frame.y`。

**门禁（独立复跑）**：`pnpm build`（`tsc -b` + tsdown）exit 0；`oxlint packages` 0 warnings / 0 errors
（42 文件）；`vitest run --coverage` **19 文件 / 563 用例通过，覆盖率 100%**。

**primitive/verify 坐标系已收口（unit-closed + live projection-verified；建件仍被客户端阻塞）**：
`diffNetlists` 新增 `ySign` 参数（`1` = 序列化/导入页的 `y - deliveredPageHeight`，`-1` = `SCH_*`
primitive 页的 `-y`）；`build.ts` 的 primitive 调用点改传 `-1`。回归
`projects primitive-path sources through -y instead of the page height` 用 592×570 拟合页
（layoutY=260 → 源 -260）证明旧投影报 2 条 `SCHEMATIC_NETLIST_DROPPED`、新投影零 error。
**live 投影证据见 §14.17**：真客户端 API 在 (100,200) 建 netflag + wire，回读 COMPONENT/LINE 均为
`y=-200`，同一份源 `ySign=-1` 零 finding、默认 A4 报 1 条 dropped。仍未 live 收口的是**建件**：
`buildIntoEasyEda` 的 `sch_PrimitiveComponent.create` 在该导入工程上 6/6、1/1 均
`SCHEMATIC_BUILD_CREATE_TIMEOUT`（netflag/wire 可落），所以完整 primitive 交付不冒充 live；
生产交付走 import，不受影响。

**t19 真板 live 闭环**：见 §14.15。t18 依赖本地 bridge/landing，CI 不跑；标题栏文字数随 `frame` 配置
变化，t18 只断言模块标题存在、不断言总数。

### 14.15 t19：真实 48-pin IC 的 live 交付与引脚密度限制

> **本节的「渲染器忽略 overlay ATTR 的 `fontSize`」结论已在 §14.21 撤回**：那是画布懒重绘造成的陈旧帧；
> 稳定帧 A/B 证明渲染器按 `fontSize` 渲染，且堆叠的真正原因是 ATTR 可见性（`keyVisible` 与重复的 `Name`）。

**脚本**：`node docs/evidence/review/t19-real-ic.mjs`（bridge 49620，真实窗口；需要联网解析 LCSC 库）。
它用真实 `C23922 STM32F030C8T6`（48 脚）加 6 颗 `C25804` 0603 电阻，铺成 `MCU/POWER/IO/CLK` 四模块，
`layoutSchematic` A3 后走生产 import 路径，最后在客户端逐页回读。

**交付结果（PASS）**：

| 项 | 值 |
|---|---|
| 预算 | `MAIN:910x1170* parts=7 fill=46.5% min=1010x1170` OK |
| import findings | 0 error，0 `SCHEMATIC_NETLIST_*` |
| live 页 | `MAIN 910x1170`，21 components（7 器件 + 14 网络旗标），39 texts |
| 截图 | `docs/evidence/current/t19-real-ic-page1.png` |

脚本断言页名、交付幅面、21 components 与零 error；它证明真实 IC 的**布局→序列化→导入→回读**链路
（含 `-layoutY` 之外的 `layoutY - deliveredPageHeight` 导入坐标系）在 48 脚符号上闭环。

**同轮抓到的视觉限制（未修，已定性）**：截图里 MCU 每个引脚的网标 `MCU-nn` 在 10 单位引脚间距下
垂直重叠，网络旗标文本约 40 单位高。两条候选修复都在 live 上被否掉：

1. **按真实符号外框缩放高度**（`symbolHalfHeight` 实验）：只把器件框收紧，标签仍按引脚间距排，
   重叠未解，且 8 脚 LM393 板反而更挤；已完整 revert。
2. **压 ATTR `fontSize`**：先对 netflag 的 `Global Net Name` 试 12/6，再对 wire `NET` 试 8；
   源码确认 `fontSize` 已落盘，但客户端截图里的标签高度不变——**渲染器忽略 overlay ATTR 的
   `fontSize`**。该实验已 revert。

交叉复核（独立 subagent）先判断重叠来自 wire `NET` ATTR，据此建议把 `NET` 的 `fontSize` 压到 8；
live A/B 直接把这一假设否掉（48 脚的 `MCU-nn` 实为 `layout:flag:MCU_nn` 旗标，且 `fontSize` 不生效），
复核结论随后修正为：**不要上 fanout/stagger 大改**；要么换引脚间距更大的符号，要么接受限制并归档。
本轮采纳归档，不把无效的字号改动混进交付。

### 14.16 后续优化（t20）：live 连接复核 + 图框内边距 A/B（负结果）

**连接**：`docs §4.1` 已写明 landing 页可连 bridge（`pro.lceda.cn/api/landing?port=49620` 或
`http://127.0.0.1:49620/landing`）。本轮开始时 `/health` 已经是
`edaConnected: true / edaWindowCount: 1 / activeWindowId a94fad14a94ecf03`，**当前连接下无需重开 landing**；
但这不是常驻保证——bridge 或客户端重启后仍需按 §4.1 重新注册（§14.14 就踩过），所以「随时可复跑」
不成立，可核验的只有「此刻已连」。t20 复跑 t18：`PASS`，两页 `1655x1170 / 1510x810`，
`rects 30 / 29`、`frames 3/3 与 2/2`、零 error。

**A/B：图框内边距 `FRAME_PAD` 80 → 60**（`packages/eda-core/src/blocks.ts`，`TITLE_HEADROOM` 仍 60）：

| 量 | 80（保留） | 60（否） |
|---|---|---|
| 框内空白（4 个 1:1 框，`t15-compact.mjs`） | 41.7% | **30.6%** |
| 模块框 | 480×480 | 440×440 |
| t18 计划页填充（页 0 / 页 1，offline `measurePageFill`） | **54.0% / 42.1%** | 51.0% / 37.1% |
| live 回读（页幅面 / 矩形 / 框数） | PASS（1655×1170 / 1510×810，30/29，3/3、2/2） | PASS（同左） |

IO 框受下沿让位影响，不在上表那 4 个 1:1 框里：80 时 480×444（空白 36.9%），60 时 440×424（28.0%）。
表里 60 侧的数字由独立复核者在内存中替换 `lib` 常量后复算（不写文件），与实测吻合；仓内没有 t20 的
运行日志，可追溯性靠 §14.16 本条 + 复核记录，不算强证据。

**结论（负结果，已完整回退）**：收紧到 60 确实让框内空白少了 11pt，但**交付口径的页面填充反而降 3–5pt**——
框变小，`measurePageFill` 量的墨迹包围盒也跟着变小，而页面本身已经收敛到最小幅面、不会再缩。
也就是说「收紧图框」不是提密手段，反而把本来 54% 的页面推向 35% 边缘。改动已回退，只在常量注释里
留下这条结论，避免下一轮有人再试一遍。

**仍未收口**（沿用 §14.15）：48-pin IC 逐脚网标在 10 单位引脚间距下垂直重叠（渲染器忽略 overlay ATTR
的 `fontSize`，网标文本尺寸由符号决定）；`primitive/verify` 的建件仍被 `SCHEMATIC_BUILD_CREATE_TIMEOUT`
阻塞（投影已由 §14.17 live 闭合，生产 import 路径不受影响）。

### 14.17 t21：primitive 持久化 Y 的 live 证据（`-y`，不是 `y - pageHeight`）

**背景**：§14.14 把 `ySign=-1` 记为 unit-closed / live-blocked。独立复核提出 blocker：如果客户端新建页
默认 A4（825），持久化应是 `y - 825`（(100,200) → -625），`-1` 会让所有 built sheet 误报；要求先抓
live `getDocumentSource()` 再发。本轮按这个要求做了实验。

**实验**：`node docs/evidence/review/t21-primitive-y.mjs`（bridge 49620，当前页；不依赖器件库）。
脚本先清掉旧 `T21PROBE*` 探针，再用 `SCH_*` API 在 IR `(100,200)` 建 netflag，并建
`[0,200] → [100,200]` 的 wire；读 `getDocumentSource()` 后删除探针，再回读一次断言源码里没有
`T21PROBE` 残留。

**结果（PASS）**：

| 量 | live 值 | 若按 `y - pageHeight`（A4 825） |
|---|---|---|
| COMPONENT y（API 入参 200） | **-200** | -625 |
| LINE startY（API 入参 200） | **-200** | -625 |
| `diffNetlists(..., -1)` | **0 netlist finding** | — |
| `diffNetlists(...)` 默认 A4 | ≥1 条 `SCHEMATIC_NETLIST_DROPPED`（本次 1 条） | — |
| 探针清理 / 残留 | netflag=true、wire=true；脚本内 `residue=0` | — |

结论：`SCH_*` primitive API 接受 IR 的 top-left / Y-down 坐标，客户端持久化时直接取反（`-y`），
**不参与页高**；`ySign=-1` 正确，复核的 blocker 被 live 数据否掉。`y - pageHeight` 只适用于
serialize/导入的 `.epru` 页（§14.14 修复 1）。`readback.ts`、`serialize.ts`、`build.ts` 的四处注释
已按这两套约定改写，避免下一轮再把 primitive 页按页高反算。

**仍未收口**：`buildIntoEasyEda` 的器件 `create` 在该导入工程上仍 `CREATE_TIMEOUT`（netflag/wire 正常），
完整 primitive 交付没有 live 闭环；本条只闭合“回读投影”，不冒充整条链路。§14.18 把「能否换原生工程」
查到了 API 层，并把 6×15s 的盲等改成 2×15s 的快速失败。

### 14.18 t22：primitive 建件为何无法 live 收口 + CREATE_TIMEOUT 快速失败

**问题**：§14.17 只闭合了回读投影；器件 `create` 仍挂起。假设是「导入工程不支持 `sch_PrimitiveComponent.create`，
换成原生工程就能落件」。本轮用 live API 逐项验证这个假设。

**live 事实（当前 web 客户端）**：

| 探测 | 结果 |
|---|---|
| `dmt_Project.createProject(name, name, team, null, '', 1, 'eprj3')` | 返回 `undefined`，之后 203 个工程里没有任何 `dsh-native-probe` —— **静默 no-op，建不出原生工程** |
| `dmt_Project.copyProject` / `modifyProjectFriendlyName` / `deleteProject` / `waitForReady` | 空实现或返回 `false`（`waitForReady(){return!1}`），**不能复制/改名/删除/等待** |
| `getReadyState()` | 导入工程 t18 与原生用户工程 `电阻分压电路_5V转2.5V` **都返回 `notLoaded`** —— 不是可用的判别位 |
| `dmt_Schematic.createSchematic('DSH_T22_PROBE')`（原生工程内） | 未创建（`NO_SCHEMATIC`），**建不出探针原理图** |
| `lib_Device.get(deviceUuid, libraryUuid)` | 返回 device 对象（解析正常） |
| `sch_PrimitiveComponent.create(device, 100, 200, ...)`（导入工程） | **15s 超时**，器件未落 |

**结论**：当前 web 客户端既不能程序化建原生工程，也不能在原生工程里建探针页，所以「原生工程能落件」
这个假设**无法在 live 上证实**；完整 primitive 交付本轮仍不冒充闭环。生产交付走 import，不受影响。

**同轮优化（可 live 闭环的部分）**：`buildIntoEasyEda` 原先只在**传输层**连续 3 次失败时中止；而
`CREATE_TIMEOUT` 是 chunk 正常返回里的 failure payload，不会触发中止，6 个器件就要盲等 6×15s。
本轮在 `runChunks` 里加 `createTimeoutStreak`：连续 2 个 chunk 返回 `CREATE_TIMEOUT` 就置
`abortedByCreateTimeout`，跳过剩余 placement，并追加一条 `SCHEMATIC_BUILD_CREATE_ABORTED` error（消息直接指向 import 路径）。A/B（同一导入工程、6 颗
`C25804`，改前/改后同一探针；永久脚本 `docs/evidence/review/t22-create-abort.mjs`）：

| 量 | 改前 | 改后 |
|---|---|---|
| 墙钟 | **98.4s** | **34.7s**（-64.7%） |
| `SCHEMATIC_BUILD_CREATE_TIMEOUT` | 6 条 | 2 条 |
| `SCHEMATIC_BUILD_CREATE_ABORTED` | 0 | 1 条（error） |
| 已落器件 | 11（部分 marker/wire） | 0（剩余 placement 全跳过） |

跳过 marker/wire 会让空页多出 12 条 `SCHEMATIC_NETLIST_DROPPED`；但改前同样是失败构建（count/net
mismatch 已在），改后用一条明确的 abort 换掉 4 次 15s 盲等，并避免继续把挂起的 create 堆进客户端队列。
回归用例 `aborts remaining part chunks after two consecutive CREATE_TIMEOUTs`（3 个 part、前两个
`CREATE_TIMEOUT`）断言只执行 2 个 part chunk、报出 abort。永久证据脚本
`node docs/evidence/review/t22-create-abort.mjs` 复跑 **PASS**：
`elapsed 34.7s componentChunks=2 timeouts=2 aborted=1`，并清理自己创建的页；若目标工程上器件创建真的成功，
脚本打印 `SKIP` 而不是误报失败。

**交叉复核**：独立 subagent 对 `runChunks` 的 streak 语义、与既有 `chunkStreak` 的交互、跳过 marker/wire
的取舍、finding code/severity 与覆盖率逐项审阅。**结论：ship（无需回退）**，并指出五处非阻塞改进；
本轮采纳了其中四项：

1. **transport throw 重置 streak**：catch 分支原来只加 `chunkStreak`、不重置 `createTimeoutStreak`，
   会出现 `timeout → throw → timeout` 也触发 abort，与“连续”语义不符；已在 catch 里 `createTimeoutStreak = 0`。
2. **2 vs 3 注释纠偏**：原注释称“与 transport streak 同一信号”，但 transport 阈值是 3；已改为说明
   “故意比 transport 少一次，因为每次都要付 15s”，并记录 abort 是跨 sheet 全局的。
3. **诊断措辞软化**：消息不再断言“该工程不支持 primitive 建件”，改为条件式（“如果是导入工程……”），
   并注明后面的 dropped/mismatch 是跳过 placement 的后果。
4. **补多 sheet 回归**：新增 `carries the CREATE_TIMEOUT abort across sheets`（3 个 sheet 各 1 个 part，
   前两个 timeout，第三个 chunk 被跳过）和 `resets the CREATE_TIMEOUT streak when the next part chunk succeeds`。
5. 未采纳：抑制 abort 后的 downstream finding（复核自己也标为非阻塞；保留原始证据更有用）。

复核同时确认：`CREATE_TIMEOUT` 是返回的 failure payload、不是 throw，所以 `executeChunk` 不会重试它；
新代码走的是 `SchematicFinding.code` 自由字符串，没有注册表要同步；覆盖率门禁不因新分支破 100%。
另记一条边界：脚本里的 15s race 低于 bridge 默认 30s execute budget；若调用方把 `options.timeoutMs`
压到 ~15s 以下，bridge 会先超时、`CREATE_TIMEOUT` 不再浮出，此时只有 transport streak 生效（已在代码注释）。

### 14.19 t23：合成 48-pin 的 on-pin 兜底——根因是引脚压在 body 估算边界上

> **本节按「字号不可控」推断的「标签仍会重叠」已在 §14.21 撤回**：网标字号可控（默认 6），且交付源改为
> 与客户端一致的可见性后，每个网名只画一次、不再带 `Key : Value` 前缀，真实 48 脚页已无堆叠。

§14.15 把「48-pin IC 逐脚标签垂直重叠」归档为限制。t23 修掉的是**「所有候选被拒 → on-pin 兜底」的根因，
标签重叠的观感没有解决**（见本节末）。

**复现**（合成 48 脚、脚距 10 单位＝100 mil，每脚一个唯一 net；`t23-pin-edge.mjs` 是修后回归，
修前的 `48 flags` 需要回退修复才能复现）：

- 修复前：`flags=48 columns=1 wires=0`——48 个旗标全部落在同一条 x 列（x=340），纵向 span 470，
  **同列最小间距 10 单位**。x=340 就是**引脚端点列**（part x=300 + probe 使用的 pin 偏移 40，与 t19 的
  `C23922` 形状一致），而 `wires=0` 说明这些旗标是**直接落在引脚上、没有 stub**：不是「选了一条太挤的
  lane」，是所有候选都被拒后的兜底。
- 根因：`BODY_HALF_WIDTH 60` → 估算 body 右边 360，`pinStub 20` → padded 右边界 **340**，恰好等于引脚端点。
  `segmentCrossesRect` 里 `inside()` 用严格 `<`（340 不算「在体内」），而边测试用 `segmentsTouch`
  把「stub 起点正好落在 padded 边界上」判成穿越 → `fits()` 对**所有**候选（含 lane）返回 false →
  `flagPosition = endpoint`。反证：`pinStub` 改成 19 或 21，同一张表立刻输出 48 wires / 0 flags；
  只有 20 这个「body 右边界 − pin 偏移 = pinStub」的刀锋值会触发兜底。

**一个被污染的负结果，记下来避免误导**：中途试过「给旗标候选加 lane 2/3 + 同列 30×18 去重」，
复量仍是 48 flags / 1 列 / minGap 10。当时写成了「还有更强的未知约束」，复核指出 lane 候选**从未被执行**
（第一个候选就失败），所以这次实验**不能用来否定 lane**；改动已回退，结论作废。

**修复**：`segmentCrossesRect` 改成用 Liang–Barsky 求线段落在 padded 矩形内的参数区间——只**贴住**边界
（stub 从引脚向外离开）区间长度为 0，判为合法；**沿边滑行或穿过**（中心弦、贴边弦、近边斜弦）区间长度为正，
仍算穿越。端点严格落在 padded 内部的仍然豁免（符号引脚几何可以落在估算轮廓内）。这版没有内缩盲带：
复核点名的 `(20,20)→(80,20)`、`(20,20)→(80,21)`、`(340,500)→(260,500)` 都判为 true，并已写进回归用例。

- 效果：合成的 48 脚最坏情况从 `48 flags / 0 wires` 变成 **`48 wires / 0 flags`**，stub 长 80 单位；
  即恢复了设计里的 wire 路径（`DEFAULT_FLAG_FANOUT 6` 下单脚网络本来就该走 wire）。
- **没有解决的**：wire 的 `NET` ATTR 文本仍在引脚端点 `(340,y)`、10 单位间距，**标签重叠的结构性原因
  （文本高度 > 脚距）没变**；live t19 截图（`docs/evidence/current/t19-real-ic-page1.png`）里 MCU
  右侧仍是密集文本。要真正可读，还得决定单脚网络用 wire+NET 还是 flag，再谈错列 fanout。

**live 复核**（复用已有 bridge/landing 会话，客户端未重启）：

- `node docs/evidence/review/t18-live-loop.mjs` → **PASS**：`54.0% / 42.1%`，`1655×1170 / 1510×810`，
  `rects 30/29`，`frames 3/3、2/2`——与修复前同数，说明 t18 的引脚不在这个边界上，它只作回归；
- `node docs/evidence/review/t19-real-ic.mjs` → **PASS**：`MAIN 910×1170`，`21 components / 39 texts`，
  填充 `46.5%`，零 error——同样与修复前同数，**只作回归，不构成「观感改善」的证据**；
- `node docs/evidence/review/t23-pin-edge.mjs` → **PASS**：`pins=48 wires=48 flags=0`，`stub length 80`。

**证据存放范围**：`t23-pin-edge.mjs` 已随本轮进入版本库；旧探针仍留在 gitignore 的 `.tmp-temp/`，不再作为证据。
它复现的是「全唯一 net 的合成最坏情况」，live t19 是 14 个 flag、不是 48，两者不要混用。

### 14.20 t5 收尾：`/eda-windows/select` 曾能**一次请求打死 bridge**（已修 + 回归）

**现象**：本轮一次 `POST /eda-windows/select` 之后，bridge 进程直接消失（`/health` 从 200 变 connection refused），
日志只有一行 `Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client`，
栈顶是 `dsh-eda-bridge.mjs` 的 HTTP handler。同一时刻浏览器里编辑器还在，但所有 agent 的 live 通道全部中断。

**两个独立根因，都修了**：

1. **成功分支引用了不存在的变量**。`select` 回包写的是 `{ success: true, activeWindowId }`，而模块里的变量名是
   `activeEdaWindowId` → `ReferenceError` 在 `writeHead(200)` **之后**抛出 → `catch` 里又无条件 `res.writeHead(400)`
   → `ERR_HTTP_HEADERS_SENT` 从 `catch` 里逃出去 → Node 把它当成未捕获异常 → 进程退出。
   **一行 `POST /eda-windows/select` 就能把整个 bridge 打死**，这是本轮最严重的稳定性缺陷。
   （注意：只有**成功分支**会走到这里；未知 id / 非 JSON body 在旧版走的是 `writeHead(404/400)`，本身不崩——
   最初我在文档里把三行都写成崩溃路径，是交叉复核纠正的。）
2. **handler 没有兜底层**。`handleHttpRequest` 是 `async`，HTTP server 不会 await 它；任何逃出来的异常都会变成
   unhandled rejection。客户端在请求体传到一半断开时，`for await (const chunk of req)` 会抛 `Error: aborted`
   （`code: ECONNRESET`），这条路径同样直接打死进程。

**修复**（`packages/eda-core/bin/`）：

- 新增 `http-guard.mjs`：`replyJson()` 在 `headersSent || writableEnded || destroyed` 时**只返回 false、不再写**；
  `guardHttpHandler()` 把整个 handler 包起来，异常时能写就补 500、写不了就 `res.destroy()`，并且只报告不抛出。
- 新增 `http-api.mjs`：`/health`、`/eda-windows`、`/eda-windows/select`、`/execute` 四个 JSON 端点抽成
  依赖注入的工厂（`getActiveWindowId`/`setActiveWindowId`/`execute` 全部注入），**不再直接摸模块级变量**——
  这正是根因 1 的土壤；`/landing` 与 CORS/OPTIONS 仍留在 bin 里。
- `select` 的解析与写回复彻底分开：解析阶段的失败（JSON 非法、或请求体中途断开）才是 400，写完之后的失败不再被
  误判成「body 不合法」。
- 顺手修掉一处语义不一致：`/execute` 在「没有可用窗口」时原先回 **500**，现在映射到 **503**。两条真实消息都要匹配：
  `No EDA window connected. …` 与 `EDA window "…" is no longer connected. …`；第一版只写了 `not connected`，
  **漏掉了后者**（交叉复核实测：stale-window 仍回 500），已补 `no longer connected`，测试也改成用这两条真实字符串。
- **一处有意的契约变化**：`/execute` 的 body 不是合法 JSON（含 `null`）时，旧版回 500 `{success:false,error:"Unexpected token…"}`，
  现在回 400 `{error:"Invalid request body"}`。仓内客户端 `src/bridge.ts:293` 对所有非 2xx 一律抛
  `SCHEMATIC_BRIDGE_EXECUTION`、不读 body，所以不影响调用方；但这是超出 500→503 之外的改变，明确记在这里。
- `package.json` 的 `files` 补上两个新 bin 文件，否则发布包里 bridge 会缺依赖模块（这个坑不补等于没修）。

**回归**（`packages/eda-core/tests/http-guard.spec.ts` 15 例 + `http-api.spec.ts` 13 例，共 28 例）：

- `replyJson` 覆盖：正常写、已写头/已结束/已销毁时不写、写时抛错返回 false **且打日志**、跳过时不打日志、`undefined` 载荷写空体。
- `guardHttpHandler` 覆盖：正常透传、抛错转 500、**已回包后再抛错只 destroy 不二次写头**、默认 `console.error`、
  **错误回调自己抛错也不得让 guard 的 promise reject**、非 `Error` 抛出用 `String()`。
- `http-api` 覆盖：health 计数与时间戳、窗口列表的 connected/active、select 的 200/400/404、**select 成功回包必须
  回显新 id**（就是根因 1 会挂的那条断言）、`/execute` 的 200/400/503/500、结果不可序列化时降级为 500、未知路由返回 false。
- **变异验证**：把 `activeWindowId` 拼写错误原样注回 `http-api.mjs:85`，该用例立刻失败并打印
  `ReferenceError: activeWindowId is not defined`；还原后文件 SHA256 与备份一致。即这条回归**确实**能抓住原 bug。
- **回归覆盖的边界（复核提出，如实记录）**：测试加载的是抽出来的 `http-api.mjs`，**bin 里的装配代码本身没有单测**
  （`vitest.config.ts` 的覆盖率门槛只覆盖 `packages/*/src/**/*.ts`，`bin/` 不在 100% 口径内），
  且 `tsc` 也不检查 `.mjs`。装配错误只能靠 live 冒烟兜住——所以下面每个端点都在真实进程上打了一遍。

**live A/B（同一台机器、同一个浏览器会话，两版都用真实注册的 EDA 窗口）**：

| 场景 | 旧版（`HEAD~1`） | 修复后 |
|---|---|---|
| `POST /eda-windows/select`（**合法** id，真实注册窗口） | 客户端收到 `An error occurred while sending the request`（200 头已发出、body 没等到，连接被重置）；进程 exit 1，栈 `ERR_HTTP_HEADERS_SENT at .head-bridge.tmp.mjs:282` | 200 `{"success":true,"activeWindowId":"51cfb4f02b56a54d"}`，进程存活 |
| 请求体中断（`Content-Length: 500` 只发 12 字节） | 进程 exit 1，栈 `Error: aborted`（`ECONNRESET`） | 存活，`/health` 仍 200 |
| 未知 id / 非 JSON body | 404 / 400，**不崩** | 404 / 400，存活 |
| 无 EDA 窗口时 `/execute` | 500 | 503 |
| `/execute` 指定一个已消失的 `windowId` | 500（判定串漏了 `no longer connected`） | 503 `EDA window "ghost-window" is no longer connected. …` |
| 客户端在 `execute` 执行到一半断开（3s 脚本，300ms 时断开） | 未单独复现 | 存活，`/health` 仍 200，`edaWindowCount` 不变 |
| 12 次连续 `/health` 探测 | — | 12/12 通过，同一进程 |

**门禁**：`tsc -b` exit 0；`oxlint packages` **0 warning / 0 error（44 文件）**；
`vitest run --coverage` **21 文件 / 596 用例通过**，`src` 覆盖率 100%（`perFile` 门槛未破；如上，`bin/` 不在该口径内）。

**live 回归（复用修复后的 bridge，走团队既有证据脚本）**：`t19-real-ic.mjs` PASS（`MAIN 910×1170`，
`21 components / 39 texts`）；`t18-live-loop.mjs` PASS（`54.0% / 42.1%`，`1655×1170 / 1510×810`，
`rects 30/29`，`frames 3/3、2/2`——与文档既有数字一致）；`t23-pin-edge.mjs` PASS（`pins=48 wires=48 flags=0`，
`stub 80`）。注意 `t19-real-ic.mjs` 会重刷 `docs/evidence/current/t19-real-ic-page1.png`：本次因为视口缩放不同
（176394 → 84995 字节）而**不是**渲染变化，已 `git checkout` 还原，不留噪声。

**现场**：t19 工程 MAIN 页复核 `21 components / 0 buses / 55 wires`，源 `94833` 字符，
无 `T5AB`/`T3*` 残留、`nonNullFontSize = 0`——本轮的 `fontSize` 四档 A/B 与临时旗标均已还原干净。
注意工程里出现了另一个**空页 `P1`（uuid `671078d5dd8ce96d`，0 器件）**，不是本轮创建（本轮删的是
`fde5a4e6b954df83`，已落 `DELETE_DOC` 墓碑），未做改动。

**推送**：修复提交已推送到 `origin/master`（`ebaae63..` 快进，push exit 0）；本段推送说明是随后追加的
文档提交。注意本机到 `github.com:443` 的连通性时好时坏，第一次尝试两次都 `Failed to connect to github.com port 443`，
第三次才成功；若后续推送失败先 `Test-NetConnection github.com -Port 443` 确认是网络而不是仓库问题。

## 14.21 网标交付：字号可控 + 可见性对齐客户端（撤回 §14.15/§14.19 的「渲染器忽略 fontSize」）

§14.15 与 §14.19 把 48 脚 IC 的网标堆叠归档为「渲染器忽略 overlay ATTR 的 `fontSize`」。本轮用**稳定帧**复核，
该结论不成立：渲染器确实按 ATTR 的 `fontSize` 渲染，之前看到的「无变化」是画布**懒重绘**造成的陈旧帧。
堆叠的**真正原因**是交付源的 ATTR 可见性：`keyVisible` 被写成 `true`，且网旗的 `Name` 与 `Global Net Name`
**同时可见**——每个网名被画两遍，还带 `Key : Value` 前缀（`Global Net Name : MCU-34`）。

**修正 1：渲染器尊重 `fontSize`（稳定帧 A/B，同一页面同一视口，14 个网标）**

方法：改字号后先 `zoomToAllPrimitives()` 强制重绘，再连拍两张并要求**逐字节一致**（否则算未稳定）。

| 存储值 | 客户端 bbox 高 | 渲染字节 | 稳定 | sha256 前 16 |
|---|---|---|---|---|
| `null`（客户端默认） | 8 | 134325 | 是 | `86af904501391acc` |
| 4 | 4 | 127077 | 是 | `efbf9ac18cabeccc` |
| 6 | 6 | 129771 | 是 | `191e96e6525f058b` |
| 12 | 12 | 141415 | 是 | `19a8f1935b90535e` |
| 16 | 16 | 149549 | 是 | `0c0965e73c524b93` |
| 20 | 20 | 155778 | 是 | `959b5df4899e9066` |

六档互不相同、随字号单调，每档两张连拍一致；`fontSize:null` 与显式 `8` 渲染**完全相同**。
此前的「同 hash」复现自证是陈旧帧（同一状态两次采样都会变），故 §14.15/§14.19 的「忽略」撤回。

**修正 2：可见性对齐客户端自己的导出（堆叠的真正原因）**

`packages/eda-core/tests/fixtures/live-build-readback.eeda` 是客户端**自己导出**的文档源（全文件 `"keyVisible":true` 出现 **0 次**：
66 次 `null`、1 次 `false`），其中：`Designator` 与**本发射器写出的**器件/网旗/网口 `Name` 为
`"keyVisible":null,"valueVisible":true`（L44/L62/L67）；导线的 `NET` 为
`"keyVisible":false,"valueVisible":true`（L75）；网旗的 `Global Net Name` 为 `"keyVisible":null,"valueVisible":null`（L63，隐藏）。
交付源此前对所有可见键一律写 `keyVisible:true`，并把网旗的 `Name` 与 `Global Net Name` 都设为可见。

> 交叉复核的限定：该 fixture 里 `Name` **并非一律** `valueVisible:true`——L34（图框、`value:""`）是 `null/null`，
> L72（未绑定符号、`value:""`）是 `null/false`。本发射器从不写这两种 `Name`，故映射只针对它自己写出的 `Name` 成立；
> 且 fixture 只有 1 条 `Global Net Name`，该条映射是单样本。

- `serialize.ts` 新增 `ATTR_VISIBILITY` 表，按客户端约定逐键给出可见性，取代「可见键一律 true」。
- 网旗/网口真正被器件绘制的是 `Name`，因此**网标字号挂在 `Name`**；`Global Net Name` 保持隐藏、不带字号。
- 导线的 `NET` 仍可见（`keyVisible:false`），字号同样生效。
- 回读链路不受影响：`readback.ts` 不读 `keyVisible`/`valueVisible`（已核对）。

**修正 3：新增网标字号旋钮（默认 6）**

`DEFAULT_NET_LABEL_FONT_SIZE = 6`（格式单位 = 0.01 英寸）。客户端默认 8；实测真实 48 脚 C23922 同侧最小脚距
**10 单位（100 mil）**，8 单位只剩 20% 净空；KiCad 官方 `DEFAULT_TEXT_SIZE` 为 50 mil（5 单位）对同样 100 mil 脚距，
取 6 单位留 40% 净空。`serializeEasyEdaDocument` / `serializeEasyEdaProject` / `importIntoEasyEda` /
`engine.importProject` / `engine.serialize` 均可用 `netLabelFontSize` 覆盖（`null` 回到客户端默认）。

**live 闭环（真实导入路径，`docs/evidence/review/t8-netlabel-font.mjs`，exit 0）**

- 用与 t19 相同的真实 C23922 48 脚 IR 经 `importIntoEasyEda` 交付：`errors=0`。
- 客户端读回：`flags=14`、`labels=14`；14/14 的 `Name` 字号 = **6**；14/14 `keyVisible` 为假（无键前缀）；
  14/14 的 `Global Net Name` `valueVisible` 为假（不再重复绘制）。
- `getPrimitivesBBox` 实测 `+3V3`：**12.407 × 6**；修正前用**同一 IR 的另一次导入**、可见属性是带键前缀的
  `Global Net Name`，同一测量为 **57.05 × 6**——宽度收窄 **78%**。
- 视觉：`docs/evidence/current/t8-netlabel-f6-page1.png` 全页与局部均为 `MCU-17`…`MCU-48`、`GND`、`+3V3`
  单次、无前缀、无堆叠（对照见 §14.15 的旧图）。
- 截图步骤已自足：`t8-netlabel-font.mjs` 在截图前 `openProject` → `waitForDocumentReady` → `zoomToAllPrimitives`，
  并要求两张连拍一致；**导入后立即截图会拿到 ~16 kB 的空白帧**（本次实测两次），故空白/未稳定时只 WARN 且
  **不覆盖**既有证据图，避免把空白图提交进仓库。修正前该脚本会把 16 kB 空白帧当成 PASS 写盘。

**门禁与回归**

- 新增用例：`serialize.spec.ts` 5 例（字号 + 可见性表，数值取自客户端 fixture）、`build.spec.ts` 引擎转发 1 例、
  导入透传 1 例。
- `tsc -b` exit 0；`oxlint packages` 0/0（44 文件）；`vitest run --coverage` **21 文件 / 603 用例**，`src` 100%。
- 黄金样例 `layout-golden.eeda` 重生成：`"fontSize":6` 5 处、`"fontSize":null` 7 处、`"keyVisible":true` **0 处**。
- 改动文件：`eda-core/src/serialize.ts`、`eda-core/src/index.ts`、`schematic-easyeda/src/build.ts`、
  `schematic-easyeda/src/index.ts`、`schematic/src/types.ts`、`eda-core/tests/serialize.spec.ts`、
  `schematic-easyeda/tests/build.spec.ts`、`eda-core/tests/fixtures/layout-golden.eeda`、本文件。

**交叉复核（独立 subagent，对抗式）**：结论 `sound-with-caveats`。它独立核对并**证实**：可见性映射与客户端 fixture
一致（该文件 `keyVisible:true` 出现 0 次）、黄金样例计数 5/7/0、`netLabelFontSize` 五处入口全部生效（默认 6 /
显式 5 / `null` / 工程 7 均落到正确 ATTR）、`readback.ts` 不读可见性、`tsc -b` 与 `oxlint` 通过。
它用**变异测试**证明数值被钉住：默认 6 改成 8 → 黄金样例字节比较与 `build.spec.ts:1347` 字面量断言双双失败；
`Name` 的 `keyVisible` 改回 `true` → 黄金样例与新可见性用例双双失败（两次都还原，sha256 回到 `3B95617E…FE29C`）。
其提出的问题已逐条处理：默认值断言改为字面量 `6`（原写法用同一常量自证，变异后仍通过）、`build.spec.ts` 的 `null`
断言改为只查网旗 `Name` 行（原断言在默认输出里恒真）、补回一处被误删的换行、限定 `Name` 的措辞、把本文件补进
改动清单、并把 primitive 路径的缺口记在下面。它在沙箱内跑不了 `vitest`（esbuild `spawn EPERM`），故
「603 用例 / 100%」由本机另行跑出（见上），评审侧如实标注为未能复现。

**已知未覆盖（交叉复核提出，如实记录）**

- **原始 build 路径没有这个旋钮**：`engine.build`/`buildIntoEasyEda` 走客户端的 `createNetFlag`/`createNetPort`
  （`build.ts:362-369`），该 API 无字号参数，故这条路径交付的网标仍是客户端默认 8。若 48 脚页走 primitive 路径，
  仍可能堆叠。serialize/import 路径（真实交付用的那条）已修；primitive 路径列为下一步（需在创建后定位并
  `modify` 该器件的 `Name` ATTR，并做同样的 live 闭环）。
- `tool-schematic/src/index.ts:333`、`scripts/live-verify.mjs:169` 未暴露该选项，取默认 6（无正确性问题）。


## 14.22 网标字号与文字堆叠：量到了什么，哪些结论要撤回

触发：交付页上模块符号旁的文字仍然"堆叠"，需要判断字号旋钮（§14.21 引入的 `netLabelFontSize`）能否解决。

### 14.22.1 与取图无关的几何事实（可信）

对已交付页 `dsh-t19-real-ic-1792382444751` 的 MAIN 页，直接读客户端的属性几何：

| 存储 fontSize（0.01 inch） | 该属性 bbox 高 | bbox 宽 | 所属 flag 组件 bbox |
| --- | --- | --- | --- |
| `null`（客户端自然值） | 8 | — | 6 × 11 |
| 3 | 3 | 9.75 | 6 × 11 |
| 5 | 5 | 16.27 | 6 × 11 |
| 6（当前交付值） | 6 | 19.54 | 6 × 11 |
| 12 | 12 | 39.09 | 6 × 11 |
| 20 | 20 | 65.18 | 6 × 11 |

结论：
- **网标文字高 = 存储字号**（单位 0.01 inch = 10 mil），宽 ≈ 3.26 × 字号；flag 符号本身不随字号缩放（恒 6 × 11）。
- 真实 48 脚符号脚距 10 单位，故垂直余隙：自然值 8 → 20%，6 → 40%，5 → 50%，3 → 70%。
- 因此字号**确实是**有效的渲染杠杆；`DEFAULT_NET_LABEL_FONT_SIZE = 6` 的注释（"8 单位只剩 20%"）与实测一致。

### 14.22.2 需要撤回的结论

1. **t5 与 t6 的像素结论都测错了对象。** 交付页每个网标有两个属性：`Name`（**画出来的**那个）与 `Global Net Name`（连接性，客户端给出的 bbox 是 **0 × 0**，即不绘制）。t5 与 t6 改的都是 `Global Net Name`，所以"字号无效果"（t5）与"哈希/PNG 字节单调变化"（t6）都不是渲染证据，二者矛盾源于测了非绘制属性。
2. **`getCurrentRenderedAreaImage()` 在本会话返回陈旧图。** 把 `Name` 的值从 `MCU-22` 改成 `WWWWWWWWWWWW`、以及调用 `zoomToAllPrimitives()` 之后，该 API 的整图校验和与图像尺寸（1419 × 508）**完全不变**，而同一时刻的真实浏览器截图明显变化（基线见 `docs/evidence/current/t24-netlabel-overlap-baseline.png`）。凡是仅凭该 API 得出的像素结论（含 t6 的字节增长、t8 头部"changing the stored size changed the rendered pixels"）都需要用真实截图通道复验后才能采信。
3. **`eda.sch_PrimitiveAttribute.modify(attr, { fontSize: X })` 的单位是 inch，不是 0.01 inch。** 传 6 写进源里是 600，传 0.06 写进源里是 6。要写 N 单位必须传 `N / 100`。直接用源单位去 modify 会得到 100 倍字号（实测把 14 个网标写成 2000 后，画面出现巨型图形，随后已精确还原为 6）。

### 14.22.3 真正的堆叠来源（关键）

- 该 MAIN 页共 **55 条导线**，其中 14 条 flag 的 `Name` 属性是 ATTR，其余是每条导线自带的 `Net`（`MCU-10`、`CLK-A0`…），**页面上的 `NET` ATTR 数为 0**。
- 也就是说，屏幕上那一大片 `MCU-nn` 文字是**客户端为导线绘制的网络名**，不是 §14.21 那套 `NET`/`Name` ATTR 标签。`netLabelFontSize` 只能影响 14 个 flag 标签（以及将来可能出现的 `NET` ATTR），**影响不到这片文字**。
- 没有找到控制导线网络名大小/可见性的接口：`sch_PrimitiveWire` 只暴露 `LineType` 与 `Net`；`dmt_Schematic` / `dmt_Project` / `dmt_EditorControl` 上不存在 net/label/font/size 类方法。
- 因此"调小字号即可解决堆叠"的假设不成立；可行的方向只有几何层面（把导线的有效标注间距撑开）或接受当前密度。

### 14.22.4 本轮未交付的改动（已回滚，不做无验证上线）

primitive 放置路径补字号旋钮（`netLabelFontSize` → 创建 flag/netport 后对 `Name` 属性 `modify(fontSize: N/100)`，失败记 `SCHEMATIC_BUILD_NET_LABEL_FONT` 警告而非中断放置）已实现，但：
- 它解决不了 14.22.3 的主要堆叠；
- 新增的 5 个用例是红的（测试执行壳里 `await` 落在非 async 作用域，另有 1 处字面量断言写错）。

按"不交付未验证改动"的纪律整棵工作树回滚，`tsc -b` 0、`oxlint packages` 0/0、`vitest run` 21 文件 **603/603** 全绿。

### 14.22.5 下一步（需要先补测量通道）

1. 用真实截图（dpx）建立可复现的像素通道；`zoomToRegion`/`zoomTo` 的参数语义在此版本上不可靠（传 bbox 得到 5% 缩放），需要先标定。
2. 标定后回答一个问题：客户端把导线的网络名画在导线的哪个位置（起点/中点/最长段）。若跟随导线 y，则可在 `layout.ts` 把这 55 段 stub 分成 ≥2 条泳道（间距 ≥20 单位）展开，连通性（每段导线的 `Net`）不变，再用 t19/t23 回归；若固定在图幅某处，则几何方案无效，只能接受密度。
3. flag 标签仍可用 5（50% 余隙，KiCad 参考值）替代 6；但这只改善 14 个标签的观感，不改主诉。

## 14.23 primitive 路径补齐网标字号：两条交付路径对齐

§14.21 只给 serialize/import 路径加了 `netLabelFontSize`；primitive 路径（`buildIntoEasyEda` →
`renderComponentChunkScript`）没有旋钮，同一份 IR 走两条路会交付 8 与 6 两种网标。本节把两条路对齐。

**实现**

- 创建 `netflag`/`netport` 后记录其 primitive id（`getState_PrimitiveId` → `primitiveId` → `id` 依次兜底），
  chunk 末尾做**一次** `eda.sch_PrimitiveAttribute.getAll()` 扫描（每个 flag 各扫一次是 O(n²)），
  对 `parentId` 匹配且 `key === 'Name'` 的属性调 `modify(attr, { fontSize: labelFontSize / 100 })`。
- **单位**：`modify` 收 inch，文档存 0.01 inch，故除 100（§14.22.2 第 3 条已实测）。这是本改动的关键一行。
- 定位不到或 modify 抛错只记 `NET_LABEL_FONT_MISSING` / `NET_LABEL_FONT_FAILED`
  （→ `SCHEMATIC_BUILD_NET_LABEL_FONT`），**不中断放置**。
- 入口：`EasyEdaBuildOptions`、`EasyEdaEngineBuildOptions`、seam 的 `SchematicEngineVerifyOptions` 均新增
  `netLabelFontSize`；默认与序列化器一致（`DEFAULT_NET_LABEL_FONT_SIZE = 6`），`null` 交给客户端默认。

**live 闭环**（真实客户端，`buildIntoEasyEda` 交付 3 个 netflag 后回读 `Name` 属性的**存储值**，再删除临时页）

| 调用 | 交付 `Name` 存储 fontSize | 期望 |
|---|---|---|
| 不给选项（默认） | 6 | 6 |
| `netLabelFontSize: 5` | 5 | 5 |
| `netLabelFontSize: null` | `null`（未触碰） | `null` |

三次 `errors=0`，3 个临时页全部删除。**5 能落成 5 就证明 `/100` 是对的**：若漏掉换算，存储值会是 500。

**门禁**：`tsc -b` 0；`oxlint packages` 0/0（44 文件）；`vitest run --coverage` **21 文件 / 612 用例**，`src` 100%。

**交叉复核**（独立子代理，结论 `sound-with-caveats`）查出两处真实缺陷，均已修：

1. **重试缺口**——位置已被占用而跳过的组件（`build.ts:365`）原本**不记录**标签，于是"放置成功但在扫描前超时"的一次重试会把该标签留在客户端默认 8 且**零告警**，与"无法定尺寸必须告警"直接矛盾。改为取出那个已存在 primitive 的 id 一并纳入扫描（`recordLabel(c, existing)`），重试路径也会补齐字号。
2. **`getAll()` 形状**——`(attrs || []).find` 在 try 之外，若返回非数组就抛 → `CHUNK_FAILED`（error 级），连续 3 次会中止后续放置，与"绝不中止放置"矛盾。改为 `!Array.isArray(attrs)` 统一记 `NET_LABEL_FONT_FAILED`。

复核同时**确认**：`build.ts:423` 是唯一带 `fontSize` 的 `modify`，默认值 6 同样除以 100，原值 6 从不直达 `modify`；
六个入口全部到达消费点，且 `null` 不被任何 `... === undefined` 条件吞掉；生成脚本以 async 函数体解析通过，
`null` 在 `recordLabel` 就短路（`null / 100` 永不执行）；`/100→/1`、默认 `6→null`、`6→8`、`null` 被 `??` 强制
四处变异全部被测试捕获（源码按 SHA-256 还原）。**残留**：`tool-schematic` 仍未暴露该选项（引擎 seam 可达、产品工具不可达）；
"两条路径一致"仅指 flag/port 的 `Name`——序列化路径还给导线 `NET` 上字号，primitive 路径不建 `NET` 属性
（导线网名由客户端自绘，见 §14.22.3）。

补记：复核指出"**没有测试真正执行生成的脚本**"（`scriptedBridge` 只截字符串）。已补 3 个用
`AsyncFunction` + 假客户端**实跑**该 chunk 的用例：6→`{fontSize:0.06}`、`null`→零调用、被占位 adopt 的标签仍被设号、
无 id 与非数组 `getAll()` 都只降级为 warning 而 `status` 仍为 `OK`。

## 14.24 「模块符号与文字堆叠」的实测归因（几何修复本轮未交付）

对当前打开的 t19 页（`dsh-t19-real-ic-1792382444751` MAIN）用客户端自身几何逐项量过（独立复核子代理复算，
离线复现与 live 完全一致，几何差 0）。结论与直觉相反：

**证伪**

- **4 个模块框互不重叠也不相接**，最小间距 40 单位（MCU–IO 竖向 40；MCU–POWER 横向 50；IO–CLK 120；POWER–CLK 200）。
- **0/39 个 TEXT 压在任何框线上**：4 个模块标题各自距自己上边框 **10.00** 单位（扣掉描边 0.5 后 9.5）、距左边框 20.00；
  跨框最近也有 50.00。
- **0/166 个可见 ATTR（网标/旗标/位号）压在任何框线上**，且全部落在某个框内部；最近的距框线 30.61。

**证实（真正的两处）**

1. **41/62 段导线正好终止在模块框边框上（0 间距）**。`layout.ts:1978-1980` 的单成员主干 stub 长
   `4 × pinStub = 80`，而 `blocks.ts:39` 的 `FRAME_PAD` **也是 80**；`computeBlockFrames` 只按
   `component.position`/`pin.endpoint` 量内容（`blocks.ts:63-78`），**看不见**这根画到端点外 80 单位的导线。
   于是网格对齐后两者精确重合：`210−80=130`（MCU 左边框）、`600−80=520`（POWER/CLK 左边框）、
   `640+80=720`（右边框）、`280−80=200`（IO 左边框）。这就是"压在框线上"。
2. **119 对"文字压在器件符号上"**：导线的 `NET` 标签锚在该导线**第一个顶点**（`serialize.ts:319`），
   而 `layout.ts:1980` 把第一个顶点设成**引脚端点**，所以 6 单位高的标签墨迹正好横跨【模型值，非回读】`21×9` 的电阻本体，
   例如 `POWER-A0` 墨盒【模型值，非回读】`x[600,628] y[254,260]` 压在【模型值，非回读】`u2 x[609.5,630.5] y[255.5,264.5]` 上，重叠【模型值，非回读】18.50×4.50。
   **这三个数字都不是回读值**：文本原语只暴露 X/Y/FontSize/Content（无宽高），组件只暴露 X/Y（无本体框）。
   而且本页 `NET` 属性为 0 条，这条机制只存在于源码导入路径——详见 §14.30.3 与 §14.30.4。

**为什么本轮没有动几何**：两个候选修法都要重排基线，属于"改了必须重新验证一整轮"的量级，不做无验证上线。

| 候选 | 改动 | 连带影响 |
|---|---|---|
| A. 撑开框（推荐） | `blocks.ts:39` `FRAME_PAD` 80→100，并同步 `layout.ts:75` `SCHEMATIC_FRAME_PAD` 与 `budget.ts:37/53/54/55` 的 `edgePadFramed`/`outwardX`/`outwardTop`/`outwardBottom`（这些常量就是"不许漂移"才抽出来的） | 框线外移 20 单位、41 处 0 间距全部变成 20 单位净空；但 fit box 变大 → 拟合页尺寸/分页/`fill` 全部要重新基线（t18/t19/t23 数字与多份黄金样例） |
| B. 缩短 stub | `layout.ts:1980` `4 * o.pinStub` → `3 * o.pinStub`（80→60） | 同样得到 20 单位净空，且 fit 预算无需改；但每个单成员网的导线长度都变，黄金样例与 t23 的 `stub length min=80 max=80` 断言要改 |

候选 C（把 `NET` 标签锚点从引脚端点移到导线中点）只影响序列化源码里的 ATTR 坐标，爆炸半径最小，
但它是否真能消除观感，取决于"客户端是否自己也画一遍导线网名"（§14.22.3 认为会画）——这一点**尚未验证**，
所以也没有上线。

下一步建议：先做候选 A（几何上可证、观感确定），并接受随之而来的基线重排；或先花一次测量确认候选 C 的前提。


## 14.25 导线网络名的绘制锚点（实测），以及一个会吞网络的 create 陷阱

### 14.25.1 锚点：最长段的中点，且沿该段旋转

探针（在页内空白处新建一条 L 形导线，网名 `ZZTESTANCHOR`）：

```
create([[760,350,800,350],[800,350,800,750]], 'ZZTESTANCHOR')
```

客户端把它**反序存储**为 `[800,750, 800,350, 800,350, 760,350]`（起点变成竖线底端），随后：

- 网名文字以**竖排（旋转 90°）**出现，位置在竖线的**中点附近**（IR y≈550），既不是创建时给的首顶点 (760,350)，也不是存储首顶点 (800,750)，更不是 bbox 中心。
- 证据截图（3× 放大裁剪）：`docs/evidence/current/t25-anchor-crop.png`。

结论：
1. 客户端会**自己**为导线绘制网络名，锚点是**最长段的中点**并沿该段方向旋转。
2. 因此"把 `NET` 锚点移到导线中点"（候选 C）**是空操作**——交付页上 `NET` ATTR 数量为 0，标签不是 ATTR 定位的；这个前提在 §14.22.3 已经量到，现在原因也清楚了。
3. 可行的几何杠杆只有一个：让**每段导线的最长段落在不同泳道**（y 间距 ≥20 单位），标签就会跟着分开。这不需要新增 IR 字段，但会改动 `layout.ts` 的 stub 路由，并重跑黄金样例/分页/填充基线。

### 14.25.2 陷阱：`sch_PrimitiveWire.create` 会吸附合并，甚至删掉一条网络

第一次探针把导线放在 (600,120)-(600,520)（穿过既有导线端点 600,290 / 600,390）。实测后果：

| 观测项 | 探针前 | 探针后 |
| --- | --- | --- |
| 导线数 | 55 | **54** |
| 网络集合 | 含 `CLK-A1` | **`CLK-A1` 消失** |
| `CLK-A0` 的 line | 3 段正常走线 | 6 段混合体（含探针的两段，被反序/拆分） |

即：`create` 在端点/接点相邻时会**合并**进既有导线，**沿用既有网名**，并让被吸收的那条网络从网表里消失——而且 `create` 返回的仍是"成功"，`created += 1` 也会照常计数。

这对 primitive 构建路径是**数据完整性风险**：把设计重建到"已经有导线"的页面（重试、幂等重跑、增量导入）时，可能静默丢掉一条网络。

隔离复验（探针放在距最近导线 40 单位的空白处，并在放置前后对网表做快照比对）：
`added=["ZZTESTANCHOR"] removed=[] changed=[]`，删除后 `residues=0, wireCount=55, distinctNets=55`。

建议的防线（未实现，需决策）：
- 放置导线前检查新线段端点是否落在既有导线端点/线段上（40 单位内），命中则先合并到目标网络或报 `WIRE_SNAP` finding；
- 放置后做**后置校验**：`distinctNets` 只允许增加，任何减少都报 error（这条即使不修吸附也能立刻暴露问题）。

### 14.25.3 像素通道（可复现）

页内 `getCurrentRenderedAreaImage()` 不可用（§14.22.2 已证陈旧）。可用通道：

1. `dpx tab-select 0` → `dpx screenshot`（真实合成器画面）；
2. PowerShell + GDI+ 读像素：绿色 `g > r+35 && g > b+35 && g > 90` 定位导线几何 bbox；蓝色 `b > r+25 && b > g+25 && b > 90` 定位文字行带，按行聚类得到行带 y 区间与间距；
3. 需要看清字形时用 `NearestNeighbor` 放大 3 倍再裁。

本次基线（整页适配视图，画布区 x∈[290,1700) y∈[90,575)）：27 个蓝色行带，MCU 标签列行带高 2px、相邻间距 2.5–8px。这是"改前"的定量密度基线，后续泳道改动用同一指标复测对比。

### 14.25.4 本轮状态

- 页面已按 IR 重建（`t19-real-ic.mjs`：MAIN 910×1170，21 components / 39 texts，errors 0），探针已删除，网表回到 55/55，残留 0。
- 未改任何产品代码；`layout.ts` 的泳道改动需要先决定接受黄金样例/分页基线重排，再动手。

### 14.25.5 更正：primitive 路径的字号旋钮已由队友重新落地

§14.22.4 记录的"已回滚、新增用例为红"只反映当时的中间状态，勿再引用。实际落地情况：

- `3e9e344 feat(schematic-easyeda): size net labels on the primitive build path`
- `1053b64 test(evidence): t25 closed loop for the primitive path's net-label size`

本轮独立核对（只读）：
- `build.ts:336` 的默认值是 `DEFAULT_NET_LABEL_FONT_SIZE`（不是 `null`），即 primitive 路径默认就把 flag/port 标签从客户端自然值 8 单位拉到 6 单位——正是 §14.22.1 量到的最差情形修正。
- `build.ts:427` 是 `modify(attr, { fontSize: labelFontSize / 100 })`——**inch 换算存在且正确**（§14.22.2 第 3 条的坑没有踩到）。
- 标签目标先 `recordLabel` 收集、循环结束后批量 apply（`build.ts:416-427`），避免每个器件全表扫描。
- 采用既有 (x,y) 位置的幂等 adopt 分支也会 `recordLabel`（`build.ts:369`），重试不会把标签留在默认值。

命名冲突提醒：`docs/evidence/current/t25-anchor-crop.png`（本轮 §14.25.1 的锚点证据）与队友的 `docs/evidence/review/t25-primitive-netlabel.mjs` 共用 `t25` 前缀，含义不同，后续编号请从 `t26` 起。

## 14.26 ~~复核 §14.24：撤回「41 处导线压在框线上」~~（**本节结论作废，见 §14.27**）

按 §14.24 的下一步动了手，但动手前后都先量。结果是**§14.24 的 B5 一条不成立**，已在改代码前回滚。

**独立重算**（同一份 t19 文档、同一 `layoutSchematic`、同一 `computeBlockFrames`）：

| 量 | §14.24 记录 | 本次实测 |
|---|---|---|
| 导线 / 线段数 | 55 / 62 | **55 / 62**（一致） |
| 顶点正好落在模块框边框上 | 41 | **0** |
| 顶点到边框的最小非零距离 | 0（声称） | **20** |

**直接坐标**（当前源码产出，不是推算）：

- `layout:wire:POWER_A0` = `[[600,260,540,260]]` → stub **60**，POWER 框左边框 **520**，净空 **20**
- `layout:wire:CLK_A0` = `[[600,780,540,780]]` → 同上，净空 20
- `layout:wire:MCU_10` = `[[210,385,150,385]]` → stub 60，MCU 框左边框 130，净空 20

**归因也错了**：`DEFAULT_PIN_STUB = 20` 且 `pinStub = options.pinStub ?? 20`，若这些 stub 出自
`layout.ts` 的 `4 * o.pinStub`，长度应为 80；实测是 60，**说明它们不是那一行生成的**。§14.24 把 41 处触点
归到那一行，同样不成立。

**结论与处置**

1. §14.24 的 B5（41/62、0 间距、归因 `layout.ts:1980`）**撤回**；同节 B1/B2/B3/B4（框互不重叠、0/39 文字压框线、
   0/166 ATTR 跨界）与 B6（文字压器件符号）是各自独立测的，不受影响。
2. 因此**没有改几何**：把 `4 * pinStub` 改成 `3 * pinStub` 修的是一个测不出来的问题，属无依据改动，已回滚
   （4× 与 3× 两版都编过、都测过，两版都不产生触点）。
3. 本轮唯一代码改动是**去重**：`FRAME_PAD` 原本在 `blocks.ts` 与 `layout.ts` 各写一份 `80`，而后者的
   `SCHEMATIC_FRAME_PAD` 是无人引用的死导出——正是注释里警告的漂移风险。改为单一来源（`blocks.ts` 从 sch 包引入，
   `index.ts` 导出），**行为不变**，612 用例全绿。
4. 真正的观感杠杆仍是 §14.25 的**泳道**方案：客户端在最长段中点自绘网名，只有让每个网的导线落在不同泳道
   （≥20 单位间距）才能把它们拉开；这要重排黄金样例、分页与 fill 基线，必须独占写入并整轮复验。

教训：**"两个常量数值相同"不等于"它们在几何上相遇"**。§14.24 的 80=80 是算术巧合的推断，没有拿交付坐标验证；
本次用一条真实记录（`POWER_A0 = [[600,260,540,260]]`）就把它否掉了。
## 14.27 §14.24 是对的，§14.26 的撤回是错的：一条 stale bundle 导致的误判

交叉复核（独立子代理）判定 §14.26 **unsound**，并给出了可复现的对照。它是对的，结论如下。

### 14.27.1 我错在哪

`packages/schematic/lib/index.js`（tsdown bundle，也是 `package.json` 的 `main`，以及
`docs/evidence/review/t19-real-ic.mjs:12` 真正 import 的文件）当时是 **stale** 的：里面还留着我做临时 A/B 时
编进去的 `dir * 3 * o.pinStub`（60），而源码一直是 `dir * 4 * o.pinStub`（80）。
**`npx tsc -b` 只刷新 `lib/types/*.js`，不重建 `lib/index.js`**；只有 `tsdown`（`pnpm build`）才重建它。

我用错了产物去测源码，于是测到"已修好"的假象，并据此撤掉了一条**真实**的缺陷。§14.26 整节作废。

### 14.27.2 受控 A/B（同一份 t19 IR，唯一变量是构建产物）

| 构建 | 线段 | 落在框线上的顶点 | 最小非零净空 | `POWER_A0` |
|---|---|---|---|---|
| `lib/types`（源码 4×，80） | 62 | **41** | 70 | `[[600,260,520,260]]` |
| stale `lib/index.js`（3×，60） | 62 | **0** | 20 | `[[600,260,540,260]]` |

算术与 §14.24 完全一致：`210−80=130`（MCU 左）、`600−80=520`（POWER/CLK 左）、`640+80=720`（右）、`280−80=200`（IO 左）。
另有 live 侧旁证：交付页文档源里 `layout:wire:POWER_A0` 的 `startX 600, endX 520`，而 POWER 框 `dotX1 520`。

### 14.27.3 落地的修复：stub 4 → 3 个 pin stub

`layout.ts` 单成员主干 stub 改回 `3 * o.pinStub`（60），框距 `SCHEMATIC_FRAME_PAD` 保持 80 → 净空 20。
**只动导线长度，不动任何 budget/分页常量**（`outwardX=180` 本就覆盖 100 单位 overhang，60 < 100）。

闭环（先 `tsdown` 重建 bundle，确认 `lib/index.js:1801` 与 `src/layout.ts:1989` 都是 3× 之后才测）：

| 证据 | 结果 |
|---|---|
| 离线，**从已发布的 bundle** 量 t19 计划 | 55 导线 / 62 段，**落框线 0**，最小净空 **20**，4 个框各自 0 |
| live 交付后读**文档源**（93,286 字符） | 62 段线、4 个框，**落框线 0**，最小净空 **20**；`POWER_A0` `600 → 540` vs 框 `520` |
| live 页面回归 | `MAIN 910×1170`、21 components / 39 texts、fill **46.5%**、**0 error**——与改动前完全一致 |

即：观感缺陷��41 处 0 间距）消除，页面尺寸/密度/分页一个都没变。

### 14.27.4 两条要记住的教训

1. **测"源码"必须用源码的产物。** `lib/index.js` 是 bundle，`tsc -b` 不会更新它；用 stale bundle 量源码等于自己骗自己。
   以后每轮测量前先 `tsdown`，并核对 bundle 与 src 的关键表达式一致（本轮已把这条作为前置检查）。
2. **交叉复核真的有用。** §14.26 是我自己写的、看起来"有数据"的撤回，被独立复核用一次受控 A/B 直接推翻。
   没有这道关，一条真缺陷会被一条假结论永久掩盖。

### 14.23.6 当前 HEAD 的独立复核（不共享上下文的成员执行）

对 `fcee445`（含队友 `3e9e344` + `1053b64`）复跑，未改动任何代码：

| 项 | 结果 |
| --- | --- |
| `tsc -b` | exit 0 |
| `oxlint packages` | 0 warning / 0 error，44 文件 |
| `vitest run --coverage` | 21 文件 **612/612** 通过，`src` 覆盖率仍 100%，exit 0 |
| `t23-pin-edge.mjs`（live） | PASS，`pins=48 wires=48 flags=0`，page 592×570，**stub length min=60 max=60** |

两点必须记下：

1. **stub 长度已是 60，不是 80。** 旧文档/汇报里 "stub 80" 的表述（含 t23 早期的 "stub length 80"）已过期；凡以 80 为前提的余量推算都要按 60 重算。
2. 队友把字号旋钮加到 primitive 路径后，**没有破坏 pin-edge 不变量**（仍 48 导线 / 0 flag），说明那次改动的标签尺寸调用是"放置后追加"、不改变放置计数。

### 14.23.7 泳道路由的前提条件（供下一轮实现者直接照用）

由 §14.23.1 的实测锚点可推出唯一可行的几何方案，且有三条硬约束：

1. 网名画在**最长段中点**并沿该段旋转 ⇒ 要让相邻标签分开 ≥20 单位，必须让**长段本身落在 ≥20 间距的泳道**上；只改 stub 长度、只改 x、只旋转，都不能改变标签的 y 间距。
2. 每个 pin 的 stub 若加一次折弯（pin → 出线 → 竖跳 → 长横段），导线原语数会从 1 段变 3 段 ⇒ **t23 的 `wires=48` 不变量必须改为按段计数**，否则一实施就红。
3. 会重排黄金样例、分页拟合、fill 与 t18/t19 数字 ⇒ 必须与 `budget.ts` 的容量常量同一批提交，不能分批。

建议的**最小先行项**（不需重排任何基线、可独立验证）：给导线放置加后置校验——`distinctNets` 只允许增加，任何减少即报 error。这能立刻暴露 §14.23.2 的吸附丢网，且不触碰几何。
## 14.28 WIRE_NET_LOST 的 live 误报验证 + 产物新鲜度前置闸门

`bfccc1b` 落地的导线后置校验是 **error** 级：一旦误报，会直接阻塞一张本来没问题的图交付。所以必须拿真页面验它。

`docs/evidence/review/t26-wire-net-guard.mjs` 跑的是**真正生成的 chunk**（不是重写一份逻辑），对象是**真正交付的页面**：

| 项 | 结果 |
|---|---|
| 前置闸门（P0.5） | `PASS preflight: bundle 07:05:28 >= newest src 07:05:20` |
| 页面 | `b188905fffe14e3bb0e7ccd16d5faa0a`，**55 个 distinct wire net** |
| chunk 执行 | `status=OK created=0 failures=[]` |
| 网数前后 | **55 → 55** |
| 结论 | 两个方向都跑过、**零误报**、页面未被改动 |

**两遍，因为一遍不够。** 第一版脚本只做了空列表这一遍，交叉复核判定「near-vacuous」——空列表下 `intended` 里一个网都没有，请求网那一半的循环体**根本没执行**，把它写成"零误报"是过度宣称。已改：

- **第一遍 空列表**：不放置任何东西，但快照 / 重读 / 既有网比对在真实 55 个网上跑了一遍。
- **第二遍 回放页面自己的一条真实导线**（`+3V3`，带自己的网名和线）：`seen` 的键正是 `net + '|' + JSON.stringify(line)`，所以它命中**去重跳过**、什么都不创建，却让 `intended` 里有了真实网名 —— 请求网那一半的循环因此真正执行。

证明没动页面：`created=1`（跳过那次的计数）、导线数 55→55、网数 55→55。

**仍然不证明的**：真阳性（人为吸附并报出丢失网名）。那需要一张可以销毁的页面，参考工程不能动。

**未在此脚本里覆盖的**：真阳性（人为吸附、并报出丢失网名）需要一张可以销毁的页面；参考工程不能动，另建 scratch schematic 超出本轮范围。这条路仍由 `build.spec.ts` 里**执行生成脚本**的用例覆盖（请求网被吸收 / 既有网消失 / 网集增长 / 消息含网名）。

### 14.28.1 前置闸门为什么进脚本而不是只写文档

stale bundle 已经**两次**让结论反向：一次让我把真缺陷"撤回"并写进 §14.26，一次让守卫的第一次实现看起来"已验证"。人的记忆不可靠，所以把它做成**证据脚本的第一条断言**：

```js
if (libMtime < src.mtime) { console.error('FAIL preflight: ... run `npx tsdown`'); process.exit(1) }
```

`tsc -b` 刷新 `lib/types/*` 但**不重建** `lib/index.js`（tsdown bundle），而所有证据脚本 import 的都是 bundle —— 这个不对称就是两次翻车的根因。以后任何证据脚本都应该带这三行。

### 14.28.2 豁免预算的上限是**生产语义**，不是变异矩阵的产物

`Math.min(afterUnnamed - beforeUnnamed, 1)` 不是为了让某条用例变红才加的。它是**生产语义改动**：**豁免不随无名槽位数线性增长**。理由必须**独立于变异测试**成立：

1. **实测的吸附不产生无名槽位**。`create()` 合并时，幸存的导线保留**自己的**网名（§14.25.2：55→54，`CLK-A1` 消失，合并后那段仍有可读名字）。所以"无名槽位 = 被吸附的网"这个等式**没有实测支持**；豁免是**容错余量 1**，不是一个会随规模增长的模型。
2. **代价不对称**。漏报是**静默且永久**的（线没了，没人会回头查）；误报是**响亮且可核验**的（人一眼看到网还在，重跑即可）。把余量钉死在 1，就是把不确定性压在便宜的那一侧。
3. **多于一个无名槽位时没有实测模型**。页面进入我们没量过的状态，此时"证据越不可读、能主张的越少"是唯一站得住的姿态，而不是让沉默随噪声一起放大。

**若上述理由站不住，就回退这一行**（去掉 `Math.min(..., 1)`），同时把 S7 用例的期望从"恰好 1 条"改回"0 条"——不要保留一个只为通过测试而存在的上限。

**变异矩阵的更正（t5 实测）**：此前报告的"两向变异各只红 1 条"是**加了 `-t` 过滤**得出的，属于同义反复——只跑一条用例时，红数在结构上只能是 0 或 1，不能当作爆炸半径。**全量套件**（`npx vitest run`，无任何过滤）实测：

| 变异 | 变红 | 被杀用例 |
|---|---|---|
| 改宽：去掉 cap | **1 / 626** | `S7: two new nameless slots excuse one loss, not two` |
| 改窄：cap 改 0 | **3 / 626** | `S7: …`、`spends a nameless slot on at most one missing net`、`does not call a requested net lost when the after read yields no name` |

改宽只红 1 条是**真实**的（其余用例的新增无名槽位都不超过 1，cap 对它们无效）；改窄红 3 条才是它的全貌。

## 14.29 覆盖率口径：`build.ts` 的 100% **不构成**守卫的覆盖背书

`vitest run --coverage` 对 `packages/*/src/**/*.ts` 逐文件 100%，`build.ts` 也在其中。但**这个数字不覆盖导线后置校验**，原因不是漏测，而是插桩的边界：

- 守卫的判定逻辑（`pageTrusted`、`alibis` 与两个比对循环，`build.ts:527-528`）写在 `renderWireChunkScript` 返回的**模板字符串里**（该函数起于 `build.ts:445`）。v8 插桩看到的是宿主函数——一个字符串字面量；字符串内部的一切对覆盖率而言是**数据**，不是代码。
- 因此 `build.ts 100%` 度量的是**包着脚本的那层 TypeScript**。脚本正文里的分支，行数与分支数都不被登记，覆盖率无从看见。

**正确解读方式**（三条）：

1. 100% 是**必要条件，不是充分条件**。它证明宿主代码没有未走的分支，**不证明**生成的脚本里每个分支都被执行过。
2. 问"这个守卫被测过吗"，不能看覆盖率，要问两件事：**哪个用例真的执行了生成的脚本？哪些变异会让它变红？** 前者是 `build.spec.ts` 里用 `AsyncFunction` 跑 chunk 的用例，后者是每次改动附带的变异清单。
3. 复核时静态发现的脚本内缺口，覆盖率**永远抓不到**，只能读发射出来的脚本。（T1–T7 的四次缺口、C1 反例、S7 都是这样被复核发现、而不是被覆盖率发现的。）

**代价与对策**：不把守卫逻辑挪出字符串——那会拆掉"测的就是真脚本"这个性质——而是用**变异测试**补上这个盲区：每个分支至少留一条"改坏它就必须变红"的记录，每次还原后逐字节核对 `build.ts` 的 SHA-256。

同类口径问题在仓库里已有一处：`bin/` 不在 100% 口径内，那里的装配错误也只能靠 live 冒烟兜住（见前文 http-api 一节的「回归覆盖的边界」）。**覆盖率的边界必须写清楚，否则下一个人会把它当成证明。**

## 14.30 回读口径的三处更正：矩形关系、NET 属性、被当成实测的模型值

只读取证脚本：`docs/evidence/review/t31-overlap-classify.mjs`（`node` 直接运行；先做产物新鲜度前置断言，失败即 `exit 1` 且不触网）。

### 14.30.1 坐标约定：矩形从 `TopLeftY` **向下**延伸

标题栏 `rect2`（`TopLeftY=146`、`Height=130`）的单元格线在 y=120/94/68/42、文字在 y=142/116/90/64。
窗口取 y∈[0,160] 时共 **21 条文本、6 个不同 y**（其中 **5 个是标题栏行**——142/116/90/64/38，共 15 条；第 6 个 y=18 是**底部列标带** 1–6，不是标题栏行）：只有"向下延伸"把这 **21/21** 条包在 16..146 内；"向上延伸"是 **0/21**。图框同向佐证：`1162−1154=8`，正好是 1170 高图纸内缩 8 的边框。
（此前写作 13/13，是窗口被写死成 [40,160]、漏掉 y=18/38 两行共 8 条所致；更正记录见 §14.31 的 C5。）
**此前按 `TopLeftY+Height` 计算的矩形关系因此全部上下颠倒。**

### 14.30.2 矩形对：两个独立桶，各报对数与面积

| 桶 | 对数 | 面积（单位²） | 说明 |
|---|---|---|---|
| `containedIn`（真包含） | **11** | **1,855,164** | 内层：sheetInner 1、titleBlock 2、moduleFrame 8 |
| `crossesEdge`（相交/越界） | **0** | **0** | 没有任何两条轮廓真正交叉 |
| 其中 moduleFrame 套 moduleFrame | 0 | 0 | 模块框互不嵌套 |

被记为"4 对越界"的 `rect62/rect64` 对 `rect0/rect1`，逐对实测是**包含**：

| 外层 | 内层 | 内层框 | 尺寸 | 重叠面积 | 越出外层 | 上沿间距 |
|---|---|---|---|---|---|---|
| rect0 | rect62 | [130,570,470,1050] | 340×480 | 163,200 | **0** | 112 |
| rect0 | rect64 | [520,730,720,1050] | 200×320 | 64,000 | **0** | 112 |
| rect1 | rect62 | [130,570,470,1050] | 340×480 | 163,200 | **0** | 104 |
| rect1 | rect64 | [520,730,720,1050] | 200×320 | 64,000 | **0** | 104 |

**判定**：0 单位在外；`1162−1050=112` 是两条**上沿**之间的距离，不是越界量。
此前的 `337,760` 是"向上延伸"读法的产物；正确读法下这 4 对重叠面积合计 **454,400**。
按当前数据，`crossesEdge` 是 **0 对 / 0 面积**——**不存在矩形越界缺陷项**，不能作为独立缺陷上报。

### 14.30.3 `NET` 属性：本页为 0，"119 对"降级为历史/路径相关

- 交付走**原语路径**：`build.ts:490` 调用 `eda.sch_PrimitiveWire.create(line, w.net)`，网名是导线的 `Net` 属性。
  本页 **55 条导线全部有 `Net`，`Key=NET` 的属性 0 条**（662 条属性里 Name 76 / Pin Name 70 / Pin Number 70 / Pin Type 70 / Relevance 69 … 无 NET）。
- "119 对"依赖**源码导入路径**：`eda-core/src/serialize.ts:319` 的
  `emit.attr(wire.id, 'NET', wire.net, first[0], first[1], netLabelFontSize)` 才把 `NET` 标签锚在导线第一个顶点，
  `serialize.spec.ts:378-389` 固化了它的字号（6/5/null）与可见性（`['false','true']`）。
- **结论：119 对在本页无法复现**——它的载体不在这条交付路径上。因此把"119 对压字"从**当前缺陷清单**降级为
  **"历史/路径相关，待复现"**：只有在 `serialize` 产物被导入生成的页面上才可能重现。
- 可复查：脚本的 `netAttributes` 段（`count=0 / wiresCarryingNetProperty=55 / flagComponents=14`）。

### 14.30.4 被当成实测值的模型值（更正）

- **28 单位墨宽**（`x[600,628]`）：模型估计，按字符数×字号的假定比例算出，**不是回读值**——文本原语只暴露 `X/Y/FontSize/Content`，无宽高。
- **`21×9` 器件本体**：模型估计，**不是回读值**——组件只暴露 `X/Y`，没有本体框访问器（`getState_BoundingBox` 不存在，见 t28）。
- 因此 `18.50×4.50` 的重叠量同样是模型输出，**不得**再作为"已量到"的证据引用。上文已就地标注"【模型值，非回读】"。

### 14.30.5 明确不可测的两类（不用估计值填充）

| 类别 | 为什么不可测 | 需要什么才能测 |
|---|---|---|
| 文字墨迹 × 器件本体 | 文本无宽高；器件无本体框 | bbox 访问器；或双方认可的字宽模型（那仍是模型，不是测量） |
| 文字墨迹 × 框标题 | 同上，且文档里没有"哪个文本是框标题"的角色标记 | 给标题文本加角色属性（我们自己可控） |

本轮这两类一律记为**不可测**，不给数字。

## 14.31 数字更正账本

**纪律**：任何被推翻的数字必须**显式撤回并在文档留痕**，不得静默替换。撤回条目保留原始主张、提出者、撤回者、依据与现值；只写"已修复"而不写旧值的，等同于伪造。**本次 t5 就违反了这条**——它只写了"frame×frame 交叉 = 0"，没写"此前是 11 顶点 / 2 导线、现在撤回"，读者无从知道有个数字被推翻过（见 C1 与 §14.31.4）。

### 14.31.1 坐标映射链（先固定读法，再谈数字）

| 环节 | 源码 | 实际作用 |
|---|---|---|
| 生成 | `sheet-chrome.ts:246` | IR 左上原点：外框 `(8,8)–(W−8,H−8)`，对 910×1170 即 `(8,8)–(902,1162)` |
| 下发 | `build.ts:627` | `create(r.x1, r.y1, r.x2-r.x1, r.y2-r.y1)` → `create(8, 8, 894, 1154)` |
| 回读 | 客户端 | `stored_y = pageHeight − IR_y`（反射），`Height` 不变 → 外框 IR`[8,1162]`→stored`[8,1162]`；标题栏 IR`[1024,1154]`→stored`[16,146]` |
| 源码路径（勿混用） | `serialize.ts:204` | `dotY = y - pageHeight`（负值）；这是源码导入路径，不是原语路径 |

实测校验：`rect0 TopLeftY=1162 / Height=1154` → 下沿 8；`rect1 TopLeftY=1154 / Height=1138` → 下沿 16。

**常量链自证**（`sheet-chrome.ts` 现成常量，无需回读即可预测 stored 值）：

| 常量 | 值 | 推出 |
|---|---|---|
| `BORDER_INSET` / `INNER_INSET` | 8 / 16（:95–96） | 外框 IR`[8,1162]`、内框 IR`[16,1154]` |
| `TITLE_BLOCK_WIDTH` | `64×2 + 186×2 + 60` = **560**（:101–105） | 标题栏 x 从 `894−560=334` 起 |
| `ROW_HEIGHT` × `ROW_COUNT` | 26 × 5 = **130**（:106–108） | 块高 130 |
| `blockY` | `y1 − 130 = 1154 − 130 = **1024**`（:237） | 块 IR`[1024,1154]` |

再由 `stored_y = 1170 − IR_y`：块 → `[16,146]`（实测 `rect2`：`TopLeftX=334, TopLeftY=146, W=560, H=130`，四项全中）；五行文字 IR `1028/1054/1080/1106/1132` → stored **`142/116/90/64/38`**，与回读的 5 个 y 逐一吻合。

> **撤回（两段）**：① t5 曾把映射写成"页高 + 内缩 的常数 **减** computed"（常数取 1170+8）——源码无此常数，且不满足实测；② t9 改成 `TopLeftY = y1 + height`（等于把回读值当成 IR 的下沿坐标）——**同样错**：它只对"关于页高一半对称"的矩形成立（外框 `8+1162=1170` 恰好对称），标题栏 `1024+1154=2178≠1170` 立刻反例（按该式得 1154，实测 146）。**真实关系是 `stored_y = pageHeight − IR_y`**，两段撤回均记入 §14.31.2 的 C4/C4b。

### 14.31.2 台账

| # | 原始主张 | 提出 | 撤回 | 依据 | 现值 |
|---|---|---|---|---|---|
| C1 | `wireOnFrameEdge` = **11 个顶点 / 2 条导线** | t1（本成员） | t5（本成员） | 坐标系反读：矩形按 `TopLeftY+Height` 展开，把"包含"算成"压边"；修正后 frame×frame = 0 | **0 顶点 / 0 导线** |
| C2 | **4 对 crossesEdge**，越出 112 单位 | t3（j5） | t5（本成员） | §14.30.2：这 4 对是包含，0 单位在外；112 是两条**上沿**间距 | **crossesEdge 0 对 / 0 面积** |
| C3 | 4 对重叠面积合计 **337,760** | t3（j5） | t5（本成员） | 337,760 是"向上延伸"读法的产物；向下读法下这 4 对是整块包含 | **454,400** |
| C4 | 映射写作"页高+内缩 的常数（1170+8）**减** computed" | t5（本成员） | t9（本成员） | 源码中不存在该常数，且不满足实测 | 撤回，由 C4b 取代 |
| C4b | `TopLeftY = y1 + height`（把回读值当成 IR 下沿坐标） | t9（本成员） | t1（本成员） | 只对关于页高一半对称的矩形成立；标题栏 `1024+1154=2178≠1170` 即反例（该式给 1154，实测 146） | **`stored_y = pageHeight − IR_y`**（常量链见 §14.31.1） |
| C5 | `rowsConsidered` = **13** | t5（本成员） | t9（本成员） | 窗口写死 `[40,160]`，漏掉 y=18/38 两行共 8 条文本 | **21 条 / 6 个不同 y** |
| C6 | `flagComponents` = **13** | t7 | t9（本成员） | 见下方三个计数判据：13 是"仅 ComponentType=netflag"的结果，不是瞬时读数 | **14**（按组件计） |

**C6 的三个计数判据**（同一批对象、不同判据，必须写明用哪个）：

| 判据 | 语义 | 值 |
|---|---|---|
| `getState_PrimitiveId` 前缀 `layout:flag:` | 我们放 flag 时命名的 primitive id 前缀，**与类型无关** | **14** |
| `Global Net Name` 属性父件去重 | 真正携带网名的 flag 实例 | **14** |
| `getState_ComponentType === 'netflag'` | 客户端自己认定的网络端口类型 | **13** |

三者差 1 的原因已实测：`layout:flag:_3V3:bus:240`（`+3V3`，总线 flag）的 `ComponentType` 被客户端存成 **`part`**，其余 13 个是 `netflag`。全量分布 `{part:1, netflag:13}`。
所以 **13 不是"瞬时读数"，是第三种判据**；本账本以"按组件计"为准，现值 **14**，凡引用 `ComponentType` 时必须同时说明它少算总线 flag。

### 14.31.3 当前有效数字（一次性对齐，供后续引用）

- 矩形：`containedIn` **11 对 / 1,855,164 单位²**（sheetInner 1、titleBlock 2、moduleFrame 8）；`crossesEdge` **0 对 / 0 单位²**；`frameInFrame` **0**
- flag：**14**（`byPrefix` 14 = `byGlobalNetName` 14；`Global Net Name` 属性 14 条）
- 文本：全页 **39 条 / 13 个不同 y**；标题栏窗口 `[0,160]` 内 **21 条 / 6 个不同 y**
- 网络：`NET` 属性 **0**；带 `Net` 的导线 **55**
- 页面：MAIN `b275cd23…` + 4 个 P1 残留（t9 重跑新增 `abb8d61f…`，见 §14.31.4）

### 14.31.4 本轮新增的两条代价

1. **t9 重跑了 t32 以验证属性桶**：属性比较从 7 字段扩到 **16 字段**——`Key, Value, X, Y, FontSize, ValueVisible, KeyVisible, ParentPrimitiveId, Rotation, Color, AlignMode, Align, Bold, Italic, UnderLine, FontName`（新增 9 个：`ParentPrimitiveId/Rotation/Color/AlignMode/Align/Bold/Italic/UnderLine/FontName`），实测 **changed 仍为 0**（12 条属性新增、0 变更），证明放 flag 不会改挂既有属性。
2. **该次重跑留下一个新孤儿页**：`abb8d61f70f52909`，`deleteSchematicPage` 返回 `true` 但页面仍在，残留 3→4。脚本 status 仍为 `OK`，因为它的期望集合本就把本次 probe 算作合法残留——这说明 `OK` **不代表清理成功**，只代表"残留符合预期"。

## 14.32 当前可见问题优先级（按回读数据）

全部数字可用 `docs/evidence/review/t36-cross-review-t10.mjs` 复算（只读，不建页）；本节已按 t12 的复核结果更正，不再引用 t10 原始重排数字。

| 项 | 复算值 | 复算方式 | 性质 |
|---|---|---|---|
| 带网导线 | **55** | `sch_PrimitiveWire` 的 `Net` 非空 | 回读 |
| 网名锚点 y 行 | **28** | 导线首顶点去重 y | 回读（锚点=首顶点是模型，客户端实际画点未暴露） |
| 纵向 <6 单位的对 | **53**（同行 33 + 跨行 20） | 两两 `|Δy| < 6` | 回读距离 + 模型阈值 |
| 行距最小 / 中位 | **5 / 10** | 相邻 y 差 | 回读 |
| 最密一行 | **4 个**（y=390） | 按 y 分组取最大 | 回读 |
| 同行最小水平间距 | **40** | 同 y 相邻锚点 `Δx` | 回读 |
| flag 组件 | **14** | 前缀计；按 `ComponentType` 计数得 13（少算总线 flag，见 C6） | 回读 |
| flag 列内 gap | **10 个，含一个 20**（x=250 七个 `[20,10,10,10,10,10]`；x=350 五个全 10） | 同 x 相邻 y 差 | 回读 |
| 内框外文本 | **10**（6 列标 y=1164 + 4 行标 A–D x=8） | 内框 `[16,894]×[16,1154]` | 回读，且**属设计**（图框标注带） |
| 不可见属性 | **496 / 662（75%）** | `KeyVisible≠true 且 ValueVisible≠true` | 回读（体积成本，非视觉） |
| 导线顶点越界 | **0 / 124** | 对 `[8,902]×[8,1162]` | 回读 |
| 矩形关系 | `containedIn` **11 对 / 1,855,164**；`crossesEdge` **0**；`frameInFrame` **0** | §14.30.2 | 回读，无视觉影响 |
| 网名净空 | **4**（=10−6）；交错 20 时 **14**（=20−6） | — | **模型值**：6 是**未证实的字形高度**，不是回读 |
| 网名是否重叠 | "不重叠"仅在 28 宽模型下成立 | — | **模型值**：标签宽度无回读访问器 |

> **口径注（提出：据成员自报为 t3 复核 t1，无独立产物可核；落盘：t5）**：据 t5 自报，t3 在复核 t1 时指出，上表"同行最小水平间距 40"只在**首顶点模型 + 同行**口径成立。改用中点模型，同一算法得 `|Δy|<6` 共 **52 对（同行 34 + 跨行 18）**、同行最小 `Δx` **30**；两模型的 `Δx<28` 与 `Δx<30` 对数均为 **0**。表中所有拥挤度数字（行数、对数、行距、最密行、水平间距）都随锚点模型变化，引用时必须同时写口径（术语见 §14.33 开头的"术语"块）。两模型数字可由 `docs/evidence/review/t38-cross-review-t2.mjs` 重跑。

**优先级结论（按 §14.33 修订）**：①网名标签通道拥挤经两模型复算判定为**假阳性**（`Δx<28` 均为 0，且段长切分改不了 y），**撤销**该修复项，不投入；②flag 交错收益只能算模型值，等字形高度可测后再定；③矩形关系与导线越界为 0，不投入；④不可见属性是体积问题，排在视觉问题之后。

**决策句**：119 对"文字压在器件符号上"对**当前交付路径不适用**——交付走原语路径（`build.ts:490`），页面 `NET` 属性为 0，该机制的载体（`serialize.ts:319` 的 `ATTR NET`）只存在于源码导入路径。故当前优先级不再是"网名标签通道"：该项亦经 §14.33 判定为假阳性。**当前无待修的视觉缺陷项**，剩余工作只有模型值待实测（字形高度）与体积项（不可见属性）。
**撤销条件**：若上层把 `engine.importProject` 暴露成工具或产品功能（届时交付页会带 `NET` 属性），本决策立即失效，119 对须重新纳入测量与排序。

## 14.33 标签通道拥挤：假阳性判定

**术语（本节与 §14.32 共用，不得同词异义）**

- **锚点模型**：标签落点的两种假设——**首顶点模型**（取 `getState_Line()` 首点）与**中点模型**（取最长段中点）。两者都只是模型：客户端实际画点未暴露。
- **口径**（拥挤度口径）：某个锚点模型 × 某个统计定义（同行 / 全对 / 相邻）下的算法。引用任何拥挤度数字都必须带口径。本文其余章节还散落着"交付口径 / 像素口径 / 覆盖率口径"等用法，它们**不属 A/B/C 任何一支**，是**余项（D 桶）**——各自按所在小节的局部定义使用，本文不为 D 立统一定义，也不得把 D 当 A 引用；flag 计数的差异一律写"**判据**"（见 C6），字号换算一律写"**换算约定**"（见 §14.34）。
- **模型值**：依赖未证实常量（字形高 6、标签宽 28）或未观测行为（画点位置）的派生值；与**回读值**相对。净空、是否重叠都是模型值。

### 14.33.1 裁定

t2 提议的"沿导线分散网名锚点"修复项**撤销**，记为**假阳性**。三个可复查事实：

1. 55 条带网导线中 **53 条是单段水平线**，标签 y 只能是导线 y —— 与"最长段中点"这一未验证假设无关；
2. 段长切分只改变沿线位置（x），对 y 行数、行距、最密行没有任何影响，而这三个正是 t2 的目标指标；
3. 按两种锚点模型复算，`Δx<28` 的对数均为 **0** —— 不存在同时纵向贴近、又横向足以压字的标签对。

因此：**不做 B**（不为此进泳道——那是唯一能改 y 的手段，且属 §14.23.7 的前置条件）；**不做 C**（把 `Δx=30` 的对再拉开 2 单位）。

`Δx=30` 的对不止一对：**首顶点模型下 4 对、中点模型下 3 对**，逐对如下（坐标为各自模型下的锚点）：

| 锚点模型 | `Δx=30` 的对 |
|---|---|
| 首顶点（4 对，全部 `Δy=5`） | `+3V3(240,800) ↔ MCU-34(210,795)`、`+3V3(240,800) ↔ MCU-37(210,805)`、`GND(360,800) ↔ MCU-26(390,795)`、`GND(360,800) ↔ MCU-27(390,805)` |
| 中点（3 对） | `+3V3(200,760) ↔ MCU-30(230,755)`（`Δy=5`）、`+3V3(200,760) ↔ MCU-31(230,765)`（`Δy=5`）、`GND(400,805) ↔ MCU-27(370,805)`（`Δy=0`，同行） |

所谓"净空 2 单位"= `30 − 28`，是按 **28 宽的标签模型**推出的**模型值**，不是回读值（标签宽度没有回读访问器）。故不做 C 的理由不是"只有一对、收益小"，而是：**即便把全部 4 对（或 3 对）都拉开 2 单位，收益仍只有 2 个模型单位，且计量依赖一个不可回读的宽度常量**。

### 14.33.2 为什么段长改不了 y

- 线段形态清点（55 条，按连续同向段折叠成一个字母计）：`H` **53** 条、9 段折线 `H-D-H-D-H-D-H-V` 1 条、7 段折线 `H-D-H-D-H-V` 1 条。
- 段长取值集合：`{40, 60, 70, 80}`；两条折线另含 `41.23` / `44.72` 的斜段。
- 对单段水平线，"最长段中点"的 y ≡ 导线 y；插入切分点只会得到两条共线子段，较长者的中点仍在同一 y 上，只改变 x。
- 该结论**不依赖**客户端究竟画在中点、首顶点还是包围盒中心：只要标签落在导线上，其 y 就是导线 y。故 28 个 y 行、最小行距 5、最密一行 4 个，全部是导线 y 的函数。

### 14.33.3 两模型对照（同一批 55 条导线）

| 指标 | 中点模型 | 首顶点模型 |
|---|---|---|
| 锚点 y 行（去重） | **28** | **28** |
| `\|Δy\|<6` 对数（同行 + 跨行） | **52**（34 + 18） | **53**（33 + 20） |
| 同行最小 `Δx` | **30** | **40** |
| 全对最小 `Δx` | 30 | 30 |
| `Δx<28` 对数 | **0** | **0** |
| `Δx<30` 对数 | **0** | **0** |
| `Δx` 取值集合（**全部** `\|Δy\|<6` 对，含跨行） | {30,100,140,150,170,190,200,220,240,250,270,300,320,390,420,490} | {30,40,120,150,180,210,250,280,320,360,390,430} |

复算：`node docs/evidence/review/t38-cross-review-t2.mjs`（只读，exit 0；上表两列即其 `modelA_firstVertex` / `modelB_longestMidpoint` 段，另报 `wires 55 / nettedWires 55 / distinctNets 55 / disconnectedNets []`）。API 面另见 `t40-netlabel-surface.mjs`，y=805 行与 flag 坐标另见 `t39-row805.mjs`。

### 14.33.4 API 面：没有可显式定位的标签对象

- `eda.sch_PrimitiveNetLabel === undefined`；`Object.keys(eda).filter(k => /label/i.test(k))` 为空；21 个 `sch_*` 命名空间中无任何带 Label 的成员。
- `eda.sch_PrimitiveWire` 的 `Object.keys` 与 `getOwnPropertyNames` 均为**空数组**（Proxy，不可枚举）；实例原型链上的方法为 `create, done, getState_{Color,Line,LineType,LineWidth,Net,PrimitiveId,PrimitiveType}, isAsync, reset, setState_{Color,Line,LineType,LineWidth,Net}, toAsync, toSync`。其中**没有任何读取或设置标签位置的接口**。
- 结论：既不能放置标签对象，也不能回读客户端把网名画在了哪里；"沿导线分散"只能靠段长间接影响，而 §14.33.2 已证明该杠杆只作用于 x。

### 14.33.5 三种坐标空间不可混用（对 t2 原句的更正）

t2 曾写"y=805 行的 +3V3 与 MCU-30：dy=5、dx=30"。该句把三个坐标空间混在一起，作废：

| 坐标空间 | 定义 | 例 |
|---|---|---|
| 导线首顶点 | `getState_Line()` 的第一个点 | `+3V3 (240,800)`、`MCU-34 (210,795)` |
| 导线最长段中点 | 中点模型下的标签锚点 | `+3V3 (200,760)`、`MCU-30 (230,755)` |
| flag 组件位置 | `layout:flag:*` 组件的 `getState_X/Y` | `x=250` 列 7 个 flag，y 含 755 |

据此更正：

- **首顶点模型**下 `Δx=30 / Δy=5` 的真实对是 `+3V3 (240,800) ↔ MCU-34 (210,795)`；另有同距三对：`+3V3 ↔ MCU-37`、`GND ↔ MCU-26`、`GND ↔ MCU-27`。
- **中点模型**下 `Δx=30` 的是 `+3V3 (200,760) ↔ MCU-30 (230,755)`、`+3V3 ↔ MCU-31`、`GND (400,805) ↔ MCU-27 (370,805)`（最后一对同行）。
- 中点模型下 **y=805 行**的成员是 `GND (400,805)`、`MCU-27 (370,805)`、`MCU-37 (180,805)`，**不含 MCU-30**。MCU-30 的中点 y=755，到 805 的距离是 **50**，不是 35。
- `(250,755)` 是 **flag 组件**坐标，不是任何导线锚点。

### 14.33.6 何时重新开启

满足任一条即重开本项（须重新测量，不得直接引用本节数字）：

1. 出现可显式定位的标签 API：`sch_PrimitiveNetLabel` 从 `undefined` 变为可用，或 wire 出现 `setState_Label*` / 标签位置访问器；
2. 任一口径下出现 `Δx<28` 的实测对（当前两模型均为 0）；
3. 字形高度（当前为模型值 6）可测，且实测净空 <6；
4. 客户端画点变为可观测（例如截图通道恢复、或导出结果含标签坐标），使"锚点=首顶点/中点"从模型变为实测。

### 14.34 产品侧字号可调：`netLabelFontSize`

**t6 前的状态**：引擎 seam 早已支持该旋钮，但产品工具没暴露，模型只能改 IR 不能改字号。

| 位置 | 内容 |
|---|---|
| `eda-core/src/serialize.ts:151` | `DEFAULT_NET_LABEL_FONT_SIZE = 6`（源文件路径默认） |
| `eda-core/src/serialize.ts:353,395` | 未传时取默认 6，`null` 表示交给客户端 |
| `schematic/src/types.ts:467` | `SchematicEngineVerifyOptions.netLabelFontSize` |
| `schematic-easyeda/src/build.ts:929` | 原语路径同一默认：未传取 6 |
| `schematic-easyeda/src/build.ts:336,343` | 注入页面脚本的 `labelFontSize` |
| `schematic-easyeda/src/build.ts:427` | `sch_PrimitiveAttribute.modify({ fontSize: labelFontSize / 100 })`（格式单位→0.01 in 的 parity） |
| `schematic-easyeda/src/index.ts:206,236,290` | serialize/build/import 三处透传 |
| `tool-schematic/src/index.ts`（改前） | 参数只有 `document/pageSize/titleBlock/verify`，**无字号**（t6 起 generate 暴露，t9 起 validate 同步） |

> 上表行号已于 t9 逐条复核：11 处全部命中（`serialize.ts` 151/353/395、`types.ts` 467、`build.ts` 929/336/343/427、easyeda `index.ts` 206/236/290）。

**变更**：`schematic_generate` 与 `schematic_validate` 都增加可选数值参数 `netLabelFontSize`，共用同一守卫 `netLabelFontSizeFor`、同一非法值策略。generate 透传到 `engine.serialize` 与 `engine.verify`；validate 透传到 `engine.verify`——否则用 5 生成后再 validate，重建时会退回 6。`liveVerify` 同时由六个位置参数改为选项对象，两个调用点不再需要用 `undefined` 占位。

**基准哈希**（`packages/tool-schematic/src/index.ts` 的 SHA-256，按提交内 blob 逐字节计算）：

| 版本 | 提交 | SHA-256 | 性质 |
|---|---|---|---|
| **改前基准** | `57f370e`（即 `786cd3a^`） | `C26C7643A63800774EA02562AF55FB998592DF4DFFEB42151F72B24D63345012` | 真基准：该版本内 `netLabelFontSize` 命中 **0** 处 |
| t6 改后 | `786cd3a` | `C24E4C21F10BA629850408E34AB3395C3EAF2BCB170BBA12826E95A05966100E` | **改后**哈希，**不是**基准（此前报告误标为 baseline，特此更正） |
| t9 改后 | 本节所属提交 | `4433DF82C6EBBA2887DB9227D49470FD2CCB38E4A9C16E64C9FC8474031BDE82` | validate 对称 + `liveVerify` 选项化之后 |

**默认不变**：调用方不传时，工具不向引擎传这个键（不是显式传 6），引擎按 `DEFAULT_NET_LABEL_FONT_SIZE = 6` 解析。测试用固定 `docUuid` 的整页 SHA-256 钉住字节，默认输出与改动前一致；显式传 6 与不传产出的字节也相同，但只有"不传"能保证旧行为。

**换算约定**：**5 单位 = 50 mil = KiCad 默认字号**，用户可按需选择；**默认值保持 6 单位 = 60 mil 不变**。

**非法值**：两层都拒绝、都不夹取——非数（如 `"5"`）由参数 schema 挡下（`INVALID_ARGS`）；0 与负数通过 schema 后由工具守卫挡下（`SCHEMATIC_NET_LABEL_FONT_SIZE`）。理由是夹取会让拼写错误变成"看起来正常、实际被静默改字号"的文档。

**自证**：删掉 generate 侧 `serialize` 的透传 → 1 红 / 4 绿；删掉 validate 侧 `netLabelFontSize` → 1 红 / 7 绿；两次还原后文件 SHA-256 均与改动值一致（本次 `4433DF82…BDE82`）。该文件 **49/49** 绿；全量 **634** 用例通过、行/分支/函数/语句覆盖率仍 100%（与改前同）。

## 14.35 证据脚本新鲜度门：从 mtime 改为内容指纹

### 14.35.1 失效模式（实测）

旧的证据门（t27–t41 中的多数脚本）只比较 mtime：

```js
const gate = { src: newest(pkg + '/eda-core/src', '.ts'), lib: newest(pkg + '/eda-core/lib', '.js') }
if (gate.lib < gate.src) { /* STALE_BUILD, exit 1 */ }
```

`git checkout -- <file>` 还原内容时会重写 mtime，于是**内容与 HEAD 逐字节相同的树也会被判过期**。以 `t41` 与 `packages/eda-core/src/serialize.ts` 实测（文件内容哈希用 SHA-256）：

| 现场 | 文件 SHA-256 | 退出码 | 输出 |
|---|---|---|---|
| A 当前树 | `9DA2C73B…` | 1 | `{"status":"STALE_BUILD","src":…,"lib":…}` |
| B `git checkout` 还原（只改 mtime） | `9DA2C73B…`（=HEAD） | 1 | 与 A 同 |
| C 真实改内容 | `1EC607EC…` | 1 | 与 A 同（仅 src 数字变大） |
| D 再次还原 | `9DA2C73B…`（=HEAD） | 1 | 与 A 同 |

B/D 与 C 的输出无法区分——这既是假阳性（内容已还原仍被拦），又吞掉了真过期的信号（分不清"该重建"与"只是碰了时钟"）。

### 14.35.2 新判据：内容指纹基线

模块 `docs/evidence/review/shared/freshness.mjs`（供所有证据脚本共用）：

- 对每个 `packages/*/src/**/*.ts` 计算 `sha256(relpath\0sha256(bytes))`，按包聚合，**完全不读 mtime**；
- 与 `shared/freshness-baseline.json` 钉住的摘要比较；失败即 `process.exit(1)`，并在调用桥之前返回；
- 失败输出 `{status:'STALE_BUILD', reason:'source content differs from the pinned build baseline', drift:[{package,reason:'content',baseline,current}]}`；
- 其它分支：无基线 → `NO_BASELINE`；基线有 lib 而现在没有 → `lib-missing`；新增包 → `unbaselined`；包消失 → `removed`；
- `node docs/evidence/review/shared/freshness.mjs --update` 重建基线，`--check` 自检。

为什么不直接比较 lib 与 src 的字节：编译产物与源码不同构，无法逐字节比。因此钉的是"**生成当前 lib 的那份源码内容**"。

### 14.35.3 双向自证

- **真过期**：给 `serialize.ts` 追加一行注释后运行 `t41` → `exit 1`，耗时 **263 ms**，`drift` 为 `eda-core`：`d367acbb…` → `2be9482d…`（10 个文件）。同一脚本在干净树上需 **723 ms**（含桥发现与回读），说明过期分支在发起网络调用之前就结束。
- **假过期**：`git checkout` 还原（mtime 已变）后运行 → `exit 0`，输出与改动前那次运行**逐字节相同**（3138 bytes，`-ceq` 为 `True`）。
- **无基线**：指向不存在的基线路径 → `{"status":"NO_BASELINE",…}`，`exit 1`。

### 14.35.4 切换清单

- **已切换到共享模块（4 个）**：`t38-cross-review-t2.mjs`、`t39-row805.mjs`、`t40-netlabel-surface.mjs`（原本无门，本次补上）、`t41-cross-review-t5.mjs`。
- **仍用 mtime 旧门（13 个）**：`t26-wire-net-guard`、`t27-flag-stagger`、`t28-label-overlap`、`t29-flag-stagger-readback`、`t30-cross-review-t2`、`t31-overlap-classify`、`t32-flag-glyph-size`、`t33-flag-glyph-crosscheck`、`t33-verify-t31-classify`、`t34-cross-review-t6b`、`t35-count-definitions`、`t36-cross-review-t10`、`t37-flag-component-type`。
- **另类（未切）**：`t42-cross-review-t10` 用 `git status -- packages` 为空作为门——内容相关，但任何与本次证据无关的脏文件都会让它误报，建议后续也并入本模块。

### 14.35.5 边界

- 基线钉的是 **src**，不是 lib 的字节：lib 若被原地篡改（目录仍在、内容变了）本门察觉不到。它保证的是"当前源码 = 生成该 lib 时的源码"。
- `--update` 是逃生阀：在未重建的情况下更新基线，会让门放行一个过期构建。约定：`--update` 必须紧跟在成功的 `npx tsc -b` 之后，并与源码改动放在同一个提交里。
- **"改内容 → 构建 → 还原源码"不被抓**：基线只钉 src，`hasLib` 只是布尔、`snapshot()` 从不读 lib 字节。先改源码并 `tsc -b`，再 `git checkout` 还原源码，此时 lib 已由被还原掉的那版内容编译，而门看到的是还原后的 src——放行。这是"不钉 lib 字节"的直接后果，不是回归；要堵它只能给编译产物也存哈希。
- **`--update` 在未重建的树上执行无意义**：它只把当前 src 重写成基线，并不验证 lib 与之一致；照此更新后，门会长期放行一个过期构建。故上一条约定（紧跟成功构建）不是流程偏好，而是这个判据成立的前提。
- **构建配置不在覆盖内**：`walkSource` 只收 `src/**/*.{ts,tsx,mts,cts}`，`packageNames` 只看有没有 `src/`。改 `tsconfig.json`、`package.json`（`exports`/依赖）或根配置同样会改变 lib，但指纹不变。
