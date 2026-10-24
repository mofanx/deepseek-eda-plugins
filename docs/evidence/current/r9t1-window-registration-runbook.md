# r9t1 — EasyEDA 窗口注册 runbook（可照做版）

## 0. 目标与前置条件

目标：在同一浏览器、同一 profile 中，把已加载的 EasyEDA 编辑器窗口注册到本地 relay，使：

- `GET http://127.0.0.1:49620/health`
  - `edaConnected: true`
  - `edaWindowCount: 1`（本次实测目标）
  - `activeWindowId` 非空
- `GET http://127.0.0.1:49620/eda-windows`
  - `windows` 至少 1 条
  - `connected: true`
  - `active: true`
  - `count >= 1`

前置条件：

1. 编辑器标签页已经在**同一个浏览器、同一个 profile**中加载完成，URL 含 `tab=*b275cd23e45c4271bead56f66d4f98fe`。
2. relay 在 `127.0.0.1:49620`，编辑器 gateway 固定端口 `49630`。
3. 全程只操作 **landing 页**；**不要**在编辑器画布里点击或键入，**不要**调用 `save/modify/create/delete/clear`。
4. `t53` 是只读门禁；注册成功后立刻跑。

## 1. 预检：先看状态，不先点

### 1.1 确认 dpx 连的是真实用户浏览器

```powershell
dpx -V
dpx list
dpx tab-list
```

预期：

- `dpx list` 的 `default` 会话有 `user_connected: true`、`auto_connect: true`。
- `tab-list` 里能看到编辑器 URL，且含 `tab=*b275cd23e45c4271bead56f66d4f98fe`。
- 如果只有临时实例/无编辑器 tab，**停止**；不要用临时浏览器冒充同一 profile。

### 1.2 确认起点是 0 窗口

```powershell
[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
Invoke-RestMethod -Uri 'http://127.0.0.1:49620/health' -TimeoutSec 5 |
  ConvertTo-Json -Depth 8 -Compress
Invoke-RestMethod -Uri 'http://127.0.0.1:49620/eda-windows' -TimeoutSec 5 |
  ConvertTo-Json -Depth 8 -Compress
```

本次起点实测：

```json
{"service":"easyeda-bridge","bridge":"dsh-eda-bridge","status":"ok",
 "edaConnected":false,"edaWindowCount":0,"activeWindowId":null,
 "pendingRequests":0}
{"windows":[],"activeWindowId":null,"count":0}
```

判定：`edaWindowCount=0` 且 `/eda-windows.count=0`。如果已经是 1，不要重复注册；先记录，后续用 `/execute` 或 t53 验活。

## 2. 打开 relay 的 `/landing`

```powershell
dpx tab-new 'http://127.0.0.1:49620/landing'
dpx tab-list
```

预期：出现新标签页，URL 为 `http://127.0.0.1:49620/landing`，title 为 `dsh-eda-bridge: register EasyEDA`。

### 已实测的失败与修正（必须写进 runbook）

本次 `tab-new` 返回：

```json
{
  "status": "error",
  "code": "TAB_FAILED",
  "message": "创建标签页失败",
  "detail": "[Errno 13] Permission denied: 'C:\\Users\\yanwuning\\.dp_cli\\sessions\\default.json'"
}
```

但 `dpx tab-list` 紧接着显示 landing tab **已经创建**（`count:2`）。所以：

- `TAB_FAILED` 只说明 dpx 写 session 文件失败，**不等于标签页没创建**；
- 先 `dpx tab-list` 验证；
- 若 landing tab 已存在，按 §3.1 的 URL/title 匹配后 `tab-select`；匹配不到就报错，不盲选；
- 若不存在，给 dpx 对 `~/.dp_cli/sessions` 的写权限后重试；
- **不要**因为该错误改用临时浏览器，否则会破坏“同一浏览器/profile”。

## 3. 绑定 landing，并判定 `#manual` / `#pop` 是否**可见**

### 3.1 按 URL/title 匹配 landing，禁止盲选索引

`tab-new` 之后标签顺序可能变化，**不要写死标签索引**。用 `tab-list` 的 URL 与 title 同时匹配，匹配不到或匹配不唯一就报错退出：

```powershell
$tabsJson = dpx tab-list
$tabs = $tabsJson | ConvertFrom-Json
$matches = @($tabs.data.tabs | Where-Object {
  $_.url -match '^http://127\.0\.0\.1:49620/landing(?:[/?#]|$)' -and
  $_.title -eq 'dsh-eda-bridge: register EasyEDA'
})
if ($matches.Count -ne 1) {
  throw "LANDING_TAB_NOT_FOUND_OR_AMBIGUOUS: $($matches.Count) match(es); refuse to blind-select"
}
$landing = $matches[0]
$landing | ConvertTo-Json -Compress
dpx tab-select $landing.id
```

本次实跑匹配到的正是 landing，而不是编辑器：

```json
{"index":0,"id":"EC7339BE9D8DD701CB41CF28B92C3B49",
 "url":"http://127.0.0.1:49620/landing",
 "title":"dsh-eda-bridge: register EasyEDA","pinned":true}
```

```text
已绑定，dpx 命令将在此标签页执行
```

如果 `$matches.Count` 不是 1，命令直接 `throw`，不会盲选到编辑器或别的标签。

### 3.2 DOM 存在性只作辅助，不能当可见性

```powershell
dpx snapshot --mode brief
```

预期快照能显示节点存在：

```text
[2] paragraph "If no popup opened, open the landing page..."  # #manual
  [3] button "open the landing page"                          # #pop
```

但这只是 **存在性**。已连接时 `#manual` 可以 `exists:true` 而 `display:none`，快照仍会列出它；**不得**据此判“可见、可点”。

### 3.3 用可见性探针给出结论

```powershell
$js = @'
(() => {
  const probe = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { exists: false, visible: false, offsetParent: null, rect: null, display: null, visibility: null, hiddenAttr: null };
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const visible = el.offsetParent !== null && r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    return {
      exists: true,
      visible,
      offsetParent: el.offsetParent !== null,
      rect: { width: r.width, height: r.height },
      display: s.display,
      visibility: s.visibility,
      hiddenAttr: el.hidden,
      text: (el.innerText || el.textContent || '').trim().slice(0, 80)
    };
  };
  return { url: location.href, title: document.title, manual: probe('#manual'), pop: probe('#pop') };
})()
'@
dpx eval $js
```

**已连接状态下的本次实跑输出**（`2026-10-24T14:15:17.589Z`；证明旧探针只看存在性的读法是错的）：

```json
{
  "url": "http://127.0.0.1:49620/landing",
  "title": "dsh-eda-bridge: register EasyEDA",
  "manual": {
    "exists": true,
    "visible": false,
    "offsetParent": false,
    "rect": { "width": 0, "height": 0 },
    "display": "none",
    "visibility": "visible",
    "hiddenAttr": true
  },
  "pop": {
    "exists": true,
    "visible": false,
    "offsetParent": false,
    "rect": { "width": 0, "height": 0 },
    "display": "inline-block",
    "visibility": "visible",
    "hiddenAttr": false
  }
}
```

判定规则，必须由可见性字段给出：

- `manual.visible === true` 且 `pop.visible === true`：才允许继续执行真人点击；
- 上面实测是 `manual.visible:false`、`offsetParent:false`、`rect 0×0`、`display:none`：明确判 **`#manual` 不可见**，**不要点击**；这通常说明 relay 已连接（或弹窗已打开），进入 §4 只读检查 `/health` 即可；
- `exists:true` 只说明节点在 DOM 里，**不能**作为“可见、可点”的结论；
- `pop.display:inline-block` 也不代表可点：父级 `#manual` 隐藏时，`pop.offsetParent` 仍为 `null`、rect 仍为 0，结论是 `pop.visible:false`。

自动 popup 被拦时，`#manual` 才是人工入口；**不能**用 JS 直接 `window.open` 替代真实点击。

### 已实测的失败与修正

`tab-new` 失败后直接 `snapshot` 曾报：

```text
RuntimeError: NO_SUCH_TAB
pinned: CEB3AD7543E8B2BEB1F3A9FE26F0BE6A
available tabs: ['0FD2...', 'DFB4...']
```

原因：旧 pinned tab id 已失效，不是 landing 页面不存在。修正：先 `dpx tab-list`，按上面的 URL/title 匹配得到 landing id，再 `dpx tab-select <landing-id>`，最后 `snapshot`。**不要复用旧 pinned id，也不要盲选索引。**

## 4. 真人点击 `#pop`

仅当 §3.3 的 `manual.visible === true` 且 `pop.visible === true` 时才执行：

```powershell
dpx click '#pop'
Start-Sleep -Seconds 4
Invoke-RestMethod -Uri 'http://127.0.0.1:49620/health' -TimeoutSec 5 |
  ConvertTo-Json -Depth 8 -Compress
Invoke-RestMethod -Uri 'http://127.0.0.1:49620/eda-windows' -TimeoutSec 5 |
  ConvertTo-Json -Depth 8 -Compress
```

等待时间用 **约 4 秒**，不要写未经实测的等待时间：本 runbook 记录的那次点击是 `13:39:33.364Z`，首次读到 `edaWindowCount:1` 是 `13:39:37.358Z`，差 **3.994 秒**。这只是一次观察值，不保证每次恒定；4 秒是保留余量的操作值，不是 SLA。

预期（本次实测）：

```json
{"service":"easyeda-bridge","bridge":"dsh-eda-bridge","status":"ok",
 "edaConnected":true,"edaWindowCount":1,
 "activeWindowId":"25883914a72e5cbb","pendingRequests":0}
{"windows":[{"windowId":"25883914a72e5cbb","connected":true,"active":true}],
 "activeWindowId":"25883914a72e5cbb","count":1}
```

判定：

- `/health.edaWindowCount >= 1`；
- `/health.activeWindowId` 非空；
- `/eda-windows.windows` 至少一条，且 `connected=true`、`active=true`；
- 计数在点击后从 0 翻到 1，才算注册成功。

若约 4 秒后仍为 0：

1. 重新 `dpx tab-list`，确认 landing tab 仍在；
2. `dpx snapshot --mode brief`，确认 `#pop` 仍存在；
3. 再执行一次真实 `dpx click '#pop'`；
4. 记录 `health` 原文与 `#pop`/`#manual` 状态；不要用“环境限制”收尾。

## 5. 成功即跑 t53（只读）

```powershell
cmd /c "node docs/evidence/review/t53-verify-main.mjs > .tmp-r9t2-t53.txt 2>&1"
$code = $LASTEXITCODE
Get-Content .tmp-r9t2-t53.txt -Raw
"EXIT=$code"
```

预期（本次实测，`exit 0`）：

```text
[t53] MAIN invariant gate - read-only
  PASS  components = 21: 21 / expected 21
  PASS  part = 8, netflag = 13: part=8 netflag=13
  PASS  component id set = baseline (both directions): extra=0 missing=0
  PASS  wires = 55 and id|net pairs = baseline: wires=55 pairs=55 extra=0 missing=0
  PASS  pages unchanged, MAIN id intact: pages=2 MAIN=present active=b275cd23e45c4271bead56f66d4f98fe
[t53] PASS exit 0
```

判定：退出码必须为 `0`；否则不能写 PASS，直接把原文和退出码写入证据。

### 已实测的捕获问题与修正

在 PowerShell 里用 `$out = & node ... 2>&1` 捕获时曾报：

```text
Program 'node.exe' failed to run: StandardOutputEncoding is only supported when standard output is redirected.
```

这是 PowerShell 捕获包装的问题，不是 t53 结果。修正：用 `cmd /c "... > file 2>&1"` 落文件，再 `Get-Content -Raw`；先确认 `$LASTEXITCODE`，不要拿空输出当 PASS。

## 6. 当场读 `+3V3` 与活页表

```powershell
cmd /c "node docs/evidence/review/r8t8-live-plus3v3-crosscheck.mjs > .tmp-r9t2-probe.txt 2>&1"
$code = $LASTEXITCODE
Get-Content .tmp-r9t2-probe.txt -Raw
"EXIT=$code"
```

预期（本次实测）：

```json
{
 "total": 21,
 "byType": {"part": 8, "netflag": 13},
 "plus3v3": [{"id":"layout:flag:_3V3:bus:240","type":"part","designator":"U?","name":"+3V3"}],
 "pageCount": 2,
 "pages": [
  {"uuid":"b275cd23e45c4271bead56f66d4f98fe","name":"MAIN"},
  {"uuid":"d224f8d13804e759","name":"P1"}
 ],
 "activeUuid": "b275cd23e45c4271bead56f66d4f98fe"
}
```

判定：

- `total=21`；
- `byType.part=8`、`byType.netflag=13`；
- `+3V3.type=part`；
- `pageCount=2`，页表含 MAIN `b275…` 与 P1 `d224…`；
- `activeUuid` 是 MAIN。

## 7. 本次重放的实际时间线

| UTC | 步骤 | `edaWindowCount` | 结果 |
|---|---|---|---|
| `13:38:56.830Z` | 预检 `/health` | `0` | `edaConnected:false` |
| `13:39:09.940Z` | 记录起点 | `0` | `/eda-windows` count 0 |
| `13:39:10.161Z` | `tab-new /landing` | `0` | `TAB_FAILED` 权限错误，但 tab 已创建 |
| `13:39:12.358Z` | `tab-list` | `0` | 2 tabs，landing 存在 |
| `13:39:23.081Z` | `tab-select <landing-id>`（本次历史实际用索引 1） | `0` | 绑定 landing；可执行命令已改为 URL/title 匹配 |
| `13:39:24.834Z` | `snapshot` | `0` | `#manual` / `#pop` 存在（仅存在性，非可见性结论） |
| `13:39:33.364Z` | `click '#pop'` | `0 -> 1` | 点击成功 |
| `13:39:37.358Z` | 注册后 `/health` | `1` | `activeWindowId=25883914a72e5cbb` |
| `13:39:55.037Z`–`13:39:55.696Z` | `t53` | `1` | exit 0，5/5，21/8/13/55/55/2 |
| `13:40:03.087Z`–`13:40:03.631Z` | `+3V3`/页表探针 | `1` | part 8 / netflag 13，+3V3=part，pages=2 |

本次新活读时间戳：`2026-10-24T13:39:55.037Z`（本地 `2026-10-24T21:39:55.041+08:00`）。它与 `12:36:10.642Z`、`12:36:46.855Z`、`12:37:34.222Z` 均不同。

## 8. 判读 `/health` 与 `/eda-windows` 的边界

- **注册瞬间**：`/health.edaWindowCount>=1` 且 `/eda-windows` 有 `connected:true` 的窗口，才能判“注册成功”。
- **后续是否仍可用**：不能只看 `/health`；窗口 socket 可能已断而 health 仍报 true。判定活读必须实跑 `t53` 或 `/execute`；`t53` 非 0 不能写 PASS。
- **一次成功不等于稳定可用**：本 runbook 只证明本次 `13:39:37Z` 注册及 `13:39:55Z` 的活读；不承诺长期可用。

## 9. 禁止项

- 不在编辑器画布点击或键入；
- 不调用 `save/modify/create/delete/clear/openDocument`；
- 不把 `12:36`/`12:37` 的旧值当作本次新读数；
- `t53` 非 `exit 0` 不写 PASS；
- 不把一次重放成功写成“桥已稳定可用”。

## 10. 本次成功摘要

- 注册触发：同一浏览器 landing 页，自动 popup 被拦，`#manual` 可见；真人点击 `#pop` 后 **3.994 秒**（一次实测）计数 `0 -> 1`，不保证恒定。
- 窗口：`25883914a72e5cbb`，`/eda-windows` `connected:true`、`active:true`。
- 新活读：`t53` exit 0、5/5，`21/8/13/55/55/2`；`+3V3=part`；活页表 2 条 MAIN/P1。
- 证据：`docs/evidence/current/r9t2-second-live-session.json`。
