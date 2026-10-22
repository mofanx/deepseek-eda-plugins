# r10t1 MAIN 打开动作与逐文件核对清单

> 表内的坐标内容、哈希、垂足参数都是脚本现场从文档与图片算出来的，不是抄的；同一份文档重跑会得到逐字节相同的本文件（生成时间只写进同名 JSON）。

## 1. 打开动作：桥是 no-op，工程树才真的把 MAIN 显示出来

分三段记录，因为它们结论不同，混在一起就会说错。

**阶段 1｜编辑器只有 Start Page 时（本会话早先，人工观察）**

| 调用 | 结果 |
|---|---|
| `getSplitScreenTree().tabs` | `["Start Page"]`（tabId `tab_page1`，doctype `-1`） |
| `getDocumentReadyState()` | `notLoaded` |
| `openDocument('b275cd23e45c4271bead56f66d4f98fe')`（页面 uuid） | 返回 `undefined`（无返回值），标签页仍只有 Start Page |
| `activateDocument('1ebf04a8860345ca8be2f73438086217')`（文档 uuid） | 返回 `false`，标签页不变 |
| `sch_PrimitiveText.getAll()` | `0` 条 |

**阶段 2｜从工程树打开（人工，脚本无法复现）**：双击工程 `dsh-t19-real-ic-1792425596633` 下的文档节点后，标签页变成 `["Start Page", "MAIN.dsh-t19-real-ic-1792425596633"]`，`getCurrentSchematicPageInfo().name = "MAIN"`，`sch_PrimitiveText.getAll()` 读到 39 条。存证：`docs/evidence/current/r10t1-main-visible-20261022-224002.png`。

**阶段 3｜本脚本复测（MAIN 已打开，因此预期就是 no-op）**

| 项 | 开跑时 | 三个调用之后 |
|---|---|---|
| 可见标签页 | `Start Page | MAIN.dsh-t19-real-ic-1792425596633` | `Start Page | MAIN.dsh-t19-real-ic-1792425596633` |
| 活动页 | `MAIN` | `MAIN` |
| `getDocumentReadyState()` | `notLoaded` | `notLoaded` |
| `openDocument('1ebf04a8860345ca8be2f73438086217')` | — | 返回 `undefined（无返回值）` |
| `waitForDocumentReady(8000)` | — | `false` |
| `activateDocument('1ebf04a8860345ca8be2f73438086217')` | — | `false` |
| 标签页/活动页是否改变 | — | **否** |

所以"打开 MAIN"这件事的准确说法是：**桥的 open/activate 在本版本里既不能新建标签页、也不能把已有文档切到前台（阶段 1 与 3 都试过）；能生效的路径是工程树双击文档节点**。人工照单执行如下：

1. 用编辑器所在的浏览器（标签 `https://pro.lceda.cn/editor#id=242b6f26fb2e4d198d575355dd271c58`），左侧「工程」面板；
2. 展开 `个人 / eda_ppfgunmg / dsh-t19-real-ic-1792425596633 / main`，**双击**文档节点 `dsh-t19-real-ic-1792425596633`（Schematic `1ebf04a8860345ca8be2f73438086217`）；
3. 标签页出现 `MAIN.dsh-t19-real-ic-1792425596633`，右侧「图纸」为 `MAIN` 即成功；
4. 放大到 **232%（2.323 px/单位**，与 12 块同源）：`eda.dmt_EditorControl.zoomTo(456, 586, 232.3)`；
5. 先对两个定位点确认取景没错：图样名称 (340, 142) 14pt「图样名称」、图幅 (590, 116) 14pt「图幅」。

## 2. 逐文件核对表（17 行）

| # | 类别 | 文件（仓库相对） | sha256（前 16） | 页坐标范围 | px/单位 | 框内实际内容 / 该看什么 |
|---|---|---|---|---|---|---|
| 1 | tile r0c0 | `r8t1-main-tile-r0c0.png` | `b1561700395bdfcf` | (-2, -2) — (509.8, 216.7) | 2.323 | 标题栏左半：图样名称 / MAIN / 项目 / 版本 / 设计 / 批准；核对 16pt 项目名是否越过「项目」单元格右边线 |
| 2 | tile r0c1 | `r8t1-main-tile-r0c1.png` | `6ed3feb88c787561` | (400.2, -2) — (912, 216.7) | 2.323 | 标题栏右半：图号 / 图幅 / 910×1170；**A 红框重叠带在这里**（x 560–700, y 104–130） |
| 3 | tile r1c0 | `r8t1-main-tile-r1c0.png` | `9bdb6a7da4604b69` | (-2, 189.5) — (509.8, 408.1) | 2.323 | 按内容核对：器件 2（U4、U5）、网络标志 0、文字 0、网络名 4 |
| 4 | tile r1c1 | `r8t1-main-tile-r1c1.png` | `479fb6ff5d37bcf7` | (400.2, 189.5) — (912, 408.1) | 2.323 | 按内容核对：器件 2（U6、U7）、网络标志 0、文字 0、网络名 4 |
| 5 | tile r2c0 | `r8t1-main-tile-r2c0.png` | `bd3b0273404d2250` | (-2, 380.9) — (509.8, 599.6) | 2.323 | 按内容核对：器件 1（U4）、网络标志 0、文字 2、网络名 2 |
| 6 | tile r2c1 | `r8t1-main-tile-r2c1.png` | `c857f264f63a7ba5` | (400.2, 380.9) — (912, 599.6) | 2.323 | 按内容核对：器件 1（U6）、网络标志 0、文字 2、网络名 2 |
| 7 | tile r3c0 | `r8t1-main-tile-r3c0.png` | `ea1b242ab4db6177` | (-2, 572.4) — (509.8, 791.1) | 2.323 | 按内容核对：器件 2（U1、U?）、网络标志 8（MCU-17、MCU-22、MCU-25 等 8 个）、文字 1、网络名 34 |
| 8 | tile r3c1 | `r8t1-main-tile-r3c1.png` | `7c66fdfb8dccfdd0` | (400.2, 572.4) — (912, 791.1) | 2.323 | 按内容核对：器件 0、网络标志 0、文字 1、网络名 0 |
| 9 | tile r4c0 | `r8t1-main-tile-r4c0.png` | `4486f6769f10c124` | (-2, 763.9) — (509.8, 982.5) | 2.323 | **W1/W2 两条候选都在这里**（蓝框），见第 3 节 |
| 10 | tile r4c1 | `r8t1-main-tile-r4c1.png` | `4b7227e7ad49e28e` | (400.2, 763.9) — (912, 982.5) | 2.323 | 按内容核对：器件 2（U2、U3）、网络标志 0、文字 0、网络名 4 |
| 11 | tile r5c0 | `r8t1-main-tile-r5c0.png` | `9e8f897b4ac2e9fd` | (-2, 955.3) — (509.8, 1174) | 2.323 | 按内容核对：器件 0、网络标志 0、文字 5、网络名 0 |
| 12 | tile r5c1 | `r8t1-main-tile-r5c1.png` | `81a4288b1136abd9` | (400.2, 955.3) — (912, 1174) | 2.323 | 按内容核对：器件 0、网络标志 0、文字 5、网络名 0 |
| 13 | closeup-1 | `r8t1-main-closeup-1.png` | `37a2eb86deb127f7` | (778, 95) — (998, 189) | 5.405 | 特写：器件 0、网络标志 0、文字 2、网络名 0 |
| 14 | closeup-2 | `r8t1-main-closeup-2.png` | `236b74fdf1adc591` | (480, 95) — (700, 189) | 5.405 | **A 红框的像素证据**：16pt 项目名尾部压到 14pt「图幅」 |
| 15 | closeup-3 | `r8t1-main-closeup-3.png` | `65aaae9c1be48e00` | (230, 95) — (450, 189) | 5.405 | text27「图样名称」锚点落在 rect0 内（锚点包含 ≠ 字形重叠） |
| 16 | closeup-4 | `r8t1-main-closeup-4.png` | `94280bf43ba7d6f8` | (-42, 21) — (178, 115) | 5.405 | rect0 包含 rect1（内嵌矩形，面积 999164） |
| 17 | overview | `r9t1-main-overview.png` | `e3dc5360be861dc4` | (‑2, ‑2) — (912, 1174) | 2.323 | 12 块 1:1 拼回的整页图；红框 A、蓝框 W1/W2 的位置以这张图为准 |

绝对路径：

```
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-tile-r0c0.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-tile-r0c1.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-tile-r1c0.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-tile-r1c1.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-tile-r2c0.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-tile-r2c1.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-tile-r3c0.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-tile-r3c1.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-tile-r4c0.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-tile-r4c1.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-tile-r5c0.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-tile-r5c1.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-closeup-1.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-closeup-2.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-closeup-3.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r8t1-main-closeup-4.png
D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r9t1-main-overview.png
```

## 3. 三处必看

### A｜红框 (560, 104) — (700, 130)：16pt 项目名压 14pt「图幅」

- 文件：`r9t1-main-overview.png`（整页定位）、`r8t1-main-closeup-2.png`（5.405 px/单位，像素证据）
- 现场读数：项目名 (404, 116) 16pt「dsh-t19-real-ic-1792425596633」；「图幅」(590, 116) 14pt「图幅」
- 判定：两段文字同一 y 带内字形交叠（A 框宽 140、高 26，恰好裹住交叠段）。这是三类里**唯一已确认为真的文字-文字实例**。
- 人工确认方式：打开 closeup-2，看 16pt 那行右端是否进入 14pt「图幅」的字身。

### W1｜(210, 795)：MCU-34 的标签压在 +3V3 导线上

- 文件：`r8t1-main-tile-r4c0.png`（整页定位用 `r9t1-main-overview.png` 蓝框 W1）
- 现场读数：图元 `attr111`（父级 `layout:wire:MCU_34:flags`）的值「MCU-34」在 (210, 795)，到 `layout:wire:_3V3:flags`（net `+3V3`）的垂距 5、垂足 t=0.75
- 判定要点：垂足 t=0.75 在中段，**不是**接线端点；标签属于另一条网络。

### W2｜(390, 795)：MCU-26 的标签压在 GND 导线上

- 文件：`r8t1-main-tile-r4c0.png`
- 现场读数：图元 `attr102`（父级 `layout:wire:MCU_26:flags`）的值「MCU-26」在 (390, 795)，到 `layout:wire:GND:flags`（net `GND`）的垂距 5、垂足 t=0.75
- 判定要点：同 W1；两条相距 180 单位，互不遮挡，可分别判读。

**与 r9t1 证据的差异（必须说清）**：`r9t1-main-third-class.json` 把这两条的 `distance` 记为 **0**。本次按导线折线（`Line` 每段 4 个数）逐段复算，最近的外网络线段距离是 **5**、垂足 t=0.75——因为标签锚点落在**自己导线**的端点上，与 +3V3/GND 的水平段还差半个线宽。**结论（这两条是候选）不变，但那个 0 应读作 5.0**；以像素为准：`tile-r4c0` 中 (210,795) 与 (390,795) 处的 MCU-xx 标签确实与外网络的 `+3V3`/`GND` 字样及竖线相叠。

**选条依据的边界**：若只用「≤6 单位 + 垂足在中段」两条，会命中 **13** 条——MCU 标签是整列排布的，相邻标签到同一条 +3V3/GND 竖段的距离都是 5。也就是说**几何本身挑不出 W1/W2**；r9t1 的「2 条」用了文字框相交判据，本清单不复现那个判据，只复算锚点距离。所以最终判定请以 `tile-r4c0` 的像素为准：这里列的 13 条是「同列全部候选」，不是「只有 2 条」。

## 4. 自证

- 文件核对：17 行全部存在（17/17）；其中 16 行来自 manifest，sha256 与登记值一致 16/16，overview 为现场计算 `e3dc5360be861dc4`。
- MAIN 不变量（跑前 → 跑后）：21/8/13/55/55/2 → 21/8/13/55/55/2，**逐项相同**。
- 零写入：脚本对 EDA 只调 `getAll` / `getState_*` / `getSplitScreenTree` / `getDocumentReadyState` / `getCurrentSchematicPageInfo` / `getAllSchematicPagesInfo`；`openDocument`/`activateDocument` 是视图操作且如上表所示无任何副作用。
- 写接口 grep（本文件）：保存 / 删除 / 修改 / 清空四类调用均 **0** 命中；唯一以 c-r-e-a-t-e 开头的命中是 Node 的 `createHash`（算 sha256，2 处），与 EDA 无关；`openDocument`/`activateDocument` 单独列出，均为视图调用且如上表无副作用。
- 相机/缩放：脚本**未调用任何 zoom API**，编辑器缩放保持 53%（截图上可见）。
- 写盘仅三处：本清单、其 JSON、存证 PNG——最后一项是 `dpx screenshot` 的像素输出，不是文档写入。
