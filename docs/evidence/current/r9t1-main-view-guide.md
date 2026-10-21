# MAIN 高清图块索引与第三类（导线穿字/穿符号）候选（r9t1）

> 只读产出。图来自 `r8t1`：12 块分块（2 列 × 6 行，相邻重叠 12%，**2.323 px/单位**）+ 4 张特写（**5.405 px/单位**）。页坐标范围与 sha256 以 `docs/evidence/current/r8t1-main-hires-tiles.json` 为准，本索引逐条核对过文件存在性与哈希。

## 一眼定位

![overview](r9t1-main-overview.png)

12 块按 2×6 拼回整页，每块左上角标 `rXcY`；**红框 A** 是已确认的真实重叠（证据 `r8t1-main-closeup-2.png`，范围 (560, 104)–(700, 130)），**蓝框 W\*** 是本次新增、需人工确认的导线候选（证据 `r8t1-main-tile-r4c0.png`，W1 (196, 783)–(224, 807)、W2 (376, 783)–(404, 807)）。

## 12 块分块

| 块 | 文件 | 页坐标范围 | px/单位 | 值得看的东西 |
|---|---|---|---|---|
| r0c0 | `r8t1-main-tile-r0c0.png` | (-2, -2) - (509.8, 216.7) | 2.323 | 器件：—<br>文字："图样名称", "MAIN", "项目", "dsh-t19-real-ic-17", "版本", "V0.1"<br>网络名：— |
| r0c1 | `r8t1-main-tile-r0c1.png` | (400.2, -2) - (912, 216.7) | 2.323 | 器件：—<br>文字："MAIN", "图号", "dsh-t19-real-ic-17", "图幅", "910×1170", "V0.1"<br>网络名：— |
| r1c0 | `r8t1-main-tile-r1c0.png` | (-2, 189.5) - (509.8, 408.1) | 2.323 | 器件：U4, U5<br>文字：—<br>网络名：IO-A0, IO-A1, IO-B0, IO-B1 |
| r1c1 | `r8t1-main-tile-r1c1.png` | (400.2, 189.5) - (912, 408.1) | 2.323 | 器件：U6, U7<br>文字：—<br>网络名：CLK-A0, CLK-A1, CLK-B0, CLK-B1 |
| r2c0 | `r8t1-main-tile-r2c0.png` | (-2, 380.9) - (509.8, 599.6) | 2.323 | 器件：U4<br>文字："C", "IO"<br>网络名：IO-A0, IO-B0 |
| r2c1 | `r8t1-main-tile-r2c1.png` | (400.2, 380.9) - (912, 599.6) | 2.323 | 器件：U6<br>文字："C", "CLK"<br>网络名：CLK-A0, CLK-B0 |
| r3c0 | `r8t1-main-tile-r3c0.png` | (-2, 572.4) - (509.8, 791.1) | 2.323 | 器件：U1, U?, layout:flag:MCU_17:0(flag), layout:flag:MCU_22:0(flag), layout:flag:MCU_25:0(flag), layout:flag:MCU_29:0(flag), layout:flag:MCU_30:0(flag), layout:flag:MCU_31:0(flag)<br>文字："B"<br>网络名：+3V3, MCU-17, MCU-22, MCU-25, MCU-29, MCU-30, MCU-31, MCU-32, MCU-33, MCU-10 |
| r3c1 | `r8t1-main-tile-r3c1.png` | (400.2, 572.4) - (912, 791.1) | 2.323 | 器件：—<br>文字："B"<br>网络名：— |
| r4c0 | `r8t1-main-tile-r4c0.png` | (-2, 763.9) - (509.8, 982.5) | 2.323 | 器件：U1, layout:flag:GND:bus:360(flag), layout:flag:MCU_22:0(flag), layout:flag:MCU_25:0(flag), layout:flag:MCU_26:0(flag), layout:flag:MCU_27:0(flag), layout:flag:MCU_28:0(flag), layout:flag:MCU_31:0(flag)<br>文字：—<br>网络名：GND, MCU-22, MCU-25, MCU-26, MCU-27, MCU-28, MCU-31, MCU-32, MCU-33, MCU-34 |
| r4c1 | `r8t1-main-tile-r4c1.png` | (400.2, 763.9) - (912, 982.5) | 2.323 | 器件：U2, U3<br>文字：—<br>网络名：POWER-A0, POWER-A1, POWER-B0, POWER-B1 |
| r5c0 | `r8t1-main-tile-r5c0.png` | (-2, 955.3) - (509.8, 1174) | 2.323 | 器件：—<br>文字："1", "2", "3", "A", "MCU"<br>网络名：— |
| r5c1 | `r8t1-main-tile-r5c1.png` | (400.2, 955.3) - (912, 1174) | 2.323 | 器件：—<br>文字："4", "5", "6", "A", "POWER"<br>网络名：— |

## 4 张特写

| 特写 | 文件 | 页坐标范围 | px/单位 | 为什么拍它（r8t1 原始意图） | 框内实际锚点对象 |
|---|---|---|---|---|---|
| closeup-1 | `r8t1-main-closeup-1.png` | (778, 95) - (998, 189) | 5.405 | 核对 t55 的最近文字对（text41 `1/1` / text61 `D`，锚点相距 22.8 单位）是否真重叠 | "1/1" 14pt, "D" 12pt |
| closeup-2 | `r8t1-main-closeup-2.png` | (480, 95) - (700, 189) | 5.405 | 16pt 项目名 text31 的尾部越出单元格，压到 text32「图幅」——文字-文字的真实实例 | "图号" 14pt, "图幅" 14pt, "910×1170" 16pt |
| closeup-3 | `r8t1-main-closeup-3.png` | (230, 95) - (450, 189) | 5.405 | text27「图样名称」锚点落在 rect0 内（锚点包含关系，不等于字形重叠） | "图样名称" 14pt, "MAIN" 16pt, "项目" 14pt, "dsh-t19-real-ic-179242" 16pt |
| closeup-4 | `r8t1-main-closeup-4.png` | (-42, 21) - (178, 115) | 5.405 | rect0 包含 rect1（面积 999164），验证矩形嵌套 | （框内无锚点对象） |

> **修正（r9t2 复核指出）**：closeup-2 的 r8t1 说明写的是"最近文字-符号 151 单位（text29 图号 / u7）"，但 u7 在 (620, 290)，落在裁剪框 (480, 95)–(700, 189) **之外**，画面里根本没有它——**该坐标已从上表删除**。这张图真正拍到的是 `text31`（项目名，16pt，起于 404,116）的尾部越出单元格、压到 `text32`（「图幅」，14pt，590,116）上——是**文字-文字**，不是文字-符号。

## 三类问题的当前状态

| 类别 | 结论 | 证据文件 | 坐标框 |
|---|---|---|---|
| 文字-文字 | **存在 1 个真实实例**：text31（16pt 项目名）压 text32（14pt「图幅」）；另一对 text41/text61 相距 22.8 但**不是**重叠 | `r8t1-main-closeup-2.png`；反例 `r8t1-main-closeup-1.png` | 重叠带 (560, 104)–(700, 130)，见对照图红框 A |
| 文字-符号 | **几何不可判**：符号无包围框、`sch_PrimitivePin` 返回 0 个图元，算不出"文字压符号" | 无（几何不可判，不提供断言） | 无 |
| 导线穿字 | **有候选，需人工在这些具体文件里确认**：2 处"别人的网络名压在导线上" | `r8t1-main-tile-r4c0.png` | W1 (196,783)–(224,807)、W2 (376,783)–(404,807)，见对照图蓝框 |
| 导线穿符号 | **无候选**（按下方规则排除端点后 0 条）；原始规则下 14 条命中**全部在导线端点**，属接线非穿越 | `r8t1-main-tile-r3c0.png`、`r8t1-main-tile-r4c0.png` | 见下表 14 行 |

> 上表沿用 r8t1 §14.35.18 的口径：closeup-2 记为**文字-文字**；"文字-符号"独立成类、如实标注不可判，不再借用文字证据。
>
> **第三类总判定：有候选，需人工在这些具体文件里确认**——导线穿字 2 处（W1/W2，`r8t1-main-tile-r4c0.png`）；导线穿符号按声明规则 0 条，原始规则 14 条但全部落在接线端点。

## 第三类的算法与阈值（可复算）

- **导线**：`sch_PrimitiveWire.Line` 是扁平坐标序列 `[x1,y1,x2,y2,x3,y3,…]`，相邻两点构成一段；本页 55 条导线共 69 段。
- **文字的两套来源**：`sch_PrimitiveText` 只有 39 条；真正的文字大头是 `sch_PrimitiveAttribute`——662 条，其中 342 条有坐标且非空。只用前者会得出"没有候选"的错误结论。
- **规则（代码逐字实现下面这一条）**：对每条导线线段 $s$ 与每个锚点 $p$，取垂足参数 $t\in[0,1]$ 与距离 $d$；
  - 候选成立当且仅当 $d \le 6$（文字锚点）且 $t \in (0.05, 0.95)$；或 $d \le 12$（器件锚点，**代理**，因为无包围框）且 $t \in (0.05, 0.95)$ 且该器件 $`ComponentType \ne 'netflag'`$。
  - **为什么排除 $t$ 的端点**：导线**终止**在锚点上是接线，不是穿越。本页 14 个"$d\le 12$"命中里 **14/14 的 $t=1$**，即全部是线端接线。
  - **为什么排除 netflag**：13/14 命中是网络标志，它们的锚点就是接线点，按定义不可能"穿过"符号本体。
  - **12 单位的依据**：本页小网络标志字形本体半径约 10–12 单位；由于 API 不给宽高，这是**代理值**，不是实测包围框——已在结论里标为不可判类的一部分。
- **归属分类**（决定 attribute 命中是不是真候选）：`own-wire-label`（标签属于它所在的那条线，正常）/ `pin-annotation`（`ParentPrimitiveId` 以 `-eNN` 结尾，画在符号体内的管脚标注，正常）/ `other`（别的网络的标签压在导线上，**候选**）。
- 本页结果：中段命中 34 条，其中 32 条管脚标注、0 条自有标签、**2 条 other**。

### 不排除端点与 netflag 时的全部 14 条命中（供读者自行判断）

| # | 器件 | 类型 | 页坐标 | 距离 | t | 是否端点 | 导线/网络 | 落在 |
|---|---|---|---|---|---|---|---|---|
| 1 | U? | part | (200, 720) | 0 | 1 | **是** | layout:wire:_3V3:flags / +3V3 | tile-r3c0 |
| 2 | layout:flag:GND:bus:360 | netflag | (400, 840) | 0 | 1 | **是** | layout:wire:GND:flags / GND | tile-r4c0 |
| 3 | layout:flag:MCU_17:0 | netflag | (250, 725) | 0 | 1 | **是** | layout:wire:MCU_17:flags / MCU-17 | tile-r3c0 |
| 4 | layout:flag:MCU_22:0 | netflag | (350, 775) | 0 | 1 | **是** | layout:wire:MCU_22:flags / MCU-22 | tile-r3c0 |
| 5 | layout:flag:MCU_25:0 | netflag | (350, 785) | 0 | 1 | **是** | layout:wire:MCU_25:flags / MCU-25 | tile-r3c0 |
| 6 | layout:flag:MCU_26:0 | netflag | (350, 795) | 0 | 1 | **是** | layout:wire:MCU_26:flags / MCU-26 | tile-r4c0 |
| 7 | layout:flag:MCU_27:0 | netflag | (350, 805) | 0 | 1 | **是** | layout:wire:MCU_27:flags / MCU-27 | tile-r4c0 |
| 8 | layout:flag:MCU_28:0 | netflag | (350, 815) | 0 | 1 | **是** | layout:wire:MCU_28:flags / MCU-28 | tile-r4c0 |
| 9 | layout:flag:MCU_29:0 | netflag | (250, 745) | 0 | 1 | **是** | layout:wire:MCU_29:flags / MCU-29 | tile-r3c0 |
| 10 | layout:flag:MCU_30:0 | netflag | (250, 755) | 0 | 1 | **是** | layout:wire:MCU_30:flags / MCU-30 | tile-r3c0 |
| 11 | layout:flag:MCU_31:0 | netflag | (250, 765) | 0 | 1 | **是** | layout:wire:MCU_31:flags / MCU-31 | tile-r3c0 |
| 12 | layout:flag:MCU_32:0 | netflag | (250, 775) | 0 | 1 | **是** | layout:wire:MCU_32:flags / MCU-32 | tile-r3c0 |
| 13 | layout:flag:MCU_33:0 | netflag | (250, 785) | 0 | 1 | **是** | layout:wire:MCU_33:flags / MCU-33 | tile-r3c0 |
| 14 | layout:flag:MCU_34:0 | netflag | (250, 795) | 0 | 1 | **是** | layout:wire:MCU_34:flags / MCU-34 | tile-r4c0 |

> 这 14 条按原始规则（仅 $d\le 12$）全部成立；按上方的完整规则，因 $t=1$ 且多为 netflag，**全部被排除**，故"导线穿符号"记为**无候选**。两种读法都列出来，读者不必相信我的过滤。
- **符号**：`getState_` 没有宽高，`sch_PrimitivePin` 返回 **0 个图元**，拿不到包围框；器件锚点代理（12 单位）在排除端点后命中 0 条，因此本任务不对"导线穿符号"下结论——**几何不可判**。

### 导线 × 文字图元（39 条）

命中：0 对。为了让"无命中"可被质疑，下面附最近距离——最近的文字图元离任何导线仍有 **130** 单位，远大于 6 单位阈值。

| 最近 | 文字 | 内容 | 页坐标 | 最近距离 | 最近导线/网络 |
|---|---|---|---|---|---|
| 1 | text65 | `POWER` | (540, 910) | 130 | layout:wire:POWER_A0 / POWER-A0 |
| 2 | text67 | `IO` | (220, 390) | 130 | layout:wire:IO_A0 / IO-A0 |
| 3 | text69 | `CLK` | (540, 390) | 130 | layout:wire:CLK_A0 / CLK-A0 |
| 4 | text63 | `MCU` | (150, 905) | 135 | layout:wire:MCU_36 / MCU-36 |
| 5 | text56 | `B` | (150, 715) | 143.14 | layout:wire:MCU_16 / MCU-16 |

### 导线 × 外来标签（候选，需人工确认）

| # | 标签 | 所属 | 页坐标 | 距导线 | 压到的导线/网络 | 落在 |
|---|---|---|---|---|---|---|
| W1 | Name = `MCU-34` | layout:wire:MCU_34:flags | (210, 795) | 0 | layout:wire:_3V3:flags / +3V3 | tile-r4c0 |
| W2 | Name = `MCU-26` | layout:wire:MCU_26:flags | (390, 795) | 0 | layout:wire:GND:flags / GND | tile-r4c0 |

## 自证

- 文件核对：16 个 r8t1 图块，存在 16，sha256 一致 16；整页对照图 `r9t1-main-overview.png` 存在（730125 字节，PNG 魔数正确）；机器可读对照 `r9t1-main-third-class.json` 存在；本文自身存在；全部引用逐个核过，不再只核 manifest 那 16 个。
- 零写入：EDA 侧无任何保存/删除/新建/修改/清空/打开文档调用（grep 0 命中），只用了两个页面读取 API 与 getAll/getState_；`wrote=0`；未发出任何 zoom 调用。全部图形输出用 System.Drawing 写 PNG。
- MAIN 不变量：跑前 21/8/13/55/55/2。
