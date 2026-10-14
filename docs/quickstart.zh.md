# 快速上手

[English](quickstart.md) | 中文

从空白环境到在嘉立创EDA（EasyEDA）里生成一张原理图，再到常见故障与恢复。

## 前置条件

- Node.js `^22.19.0 || >=24.0.0` 与可用的 `dsh` CLI（DeepSeek Harness 运行时）。
- 嘉立创EDA 专业版客户端，已登录，能正常打开原理图编辑页。
- npm 上已发布的 `@deepseek-ai/dsh-plugin-eda-*@0.1.0-alpha.1`——若尚未发布，见 [publishing.md](publishing.md)；在此之前 dsh 检出通过 `cordis.patch.yml` 直接加载本仓库。

## 正常路径

1. **向某个 profile 安装 bundle。**

   ```sh
   dsh plugin --profile <name> add @deepseek-ai/dsh-plugin-eda-bundle
   ```

   `schematic-bundle` 一次性挂上 schematic 服务、模型工具与 EasyEDA 引擎。若运行时因 peer 版本校验拒绝插件，见下方 Troubleshooting 的 `allow-version` 说明。

2. **启动 web 服务。**

   ```sh
   dsh --profile <name>
   ```

   启动承载 web 应用的 profile（例如名为 `web` 的 profile：`dsh web`）。插件随 dsh 应用绑定；该 profile 服务的会话中模型即可调用 `schematic_generate` / `schematic_validate`。

3. **打开 EasyEDA 并接好桥。**

   在嘉立创EDA 编辑器中打开任意原理图工程，保证有活跃的原理图标签页。首次 live 调用时若 localhost 无应答，插件会自动拉起 `dsh-eda-bridge`；编辑器侧的注册需要社区 `run-api-gateway` 扩展（会扫描桥端口范围），或在 EasyEDA 标签页内打开 `https://pro.lceda.cn/api/landing?port=49620` 触发内置网关。`dsh-eda-bridge --check` 只检查不服务，打印当前状态与下一步动作。

4. **生成。**

   在 web 会话里让模型生成电路（例如"一个驱动 LED 的 555 无稳态振荡器"）。模型以 `verify: true` 调用 `schematic_generate`：插件校验 IR、解析真实库绑定、在图幅框内布局几何、序列化 SCH_PAGE 源码，并通过桥把结果投递进打开的 EasyEDA 编辑器——元件、导线、网络旗标、模块分区框一并创建。成功交付返回所建文档；静态 findings 与 live 回读 diff 作为结构化字段随工具结果返回。

   没有 EasyEDA 客户端连接时，同一调用仍会产出 `.epro2` 工程归档，可经 EasyEDA 文件对话框手工导入。

## 故障排查

### `edaConnected:false` / 无 EasyEDA 窗口

运行 `dsh-eda-bridge --check`。退出码 `0` 表示已有窗口注册；`1` 表示中继在线但没有编辑器标签页注册（打开 `http://localhost:<port>/landing` 用自关闭辅助页注册，或在 EasyEDA 内打开 `https://pro.lceda.cn/api/landing?port=49620` 触发内置网关）；`2` 表示端口范围内没有桥在监听（启动 `dsh-eda-bridge`，或发起任一 live 调用让插件自动拉起）；`3` 表示端口被讲不兼容协议的其他进程占用（确认端口确实空闲后以 `dsh-eda-bridge --force` 重启）。已注册但失联的窗口会被桥的应用层 noop 探活踢除——下一次 `--check` 报 `1`，落地页会重新注册。

`/landing` 辅助页存在的原因：EasyEDA 落地页广播后会调 `window.close()`，但浏览器只对脚本打开的窗口放行——直接打开的页签不会自动关闭。辅助页改为以弹窗方式打开它、轮询 `/health`，窗口注册后自动关掉弹窗。

### 插件被版本校验拒绝

bundle 声明的 peer 范围对的是已验证的宿主版本线（`@deepseek-ai/dsh-* >=0.2.1-alpha.2 <0.3.0`）。过老或过新的运行时会拒绝加载，除非为精确版本组合记录豁免：

```sh
dsh plugin --profile <name> allow-version @deepseek-ai/dsh-plugin-eda-bundle@0.1.0-alpha.1 --dsh-version <runtime-version> --accept-risk
```

`--dsh-version` 取 `dsh --version` 打印的确切版本。豁免是测试未验证组合的逃生舱，不等于确认该组合可用——优先把运行时升级到声明范围内。`dsh plugin --profile <name> revoke-version` 撤销豁免；`version-exemptions` 查看已记录的豁免。

### live 投递报 `CREATE_TIMEOUT`

EasyEDA 客户端内的 `sch_PrimitiveComponent.create` 会卡进一种模态放置态，对任何 API 调用都不应答——调用永久挂起而非返回。投递代码给每次 create 套了有界竞速（约 10 秒）并报 `CREATE_TIMEOUT`，让卡死的放置快速失败当前 chunk，而不是反复吃满 30 秒桥超时。恢复在客户端侧：重载编辑器标签页（若能看到交互放置幽灵，按 ESC）后重新生成。模块框、网络旗标与 netport 不受影响——只有器件放置会这样卡死。

### 图幅

`pageSize` 约束的是虚拟框上的布局与校验边界，A3/自定义尺寸有测试覆盖。但 EasyEDA 客户端没有暴露图幅 API——live 投递页恒为默认 A4 图框（`1170×825` 虚拟边界，0.01 英寸单位）。非 A4 的 `pageSize` 请当作规划产物看待：布局与校验遵循它，但实机验证过的图幅只有 A4。

### 投递成功但编辑器里结果不一致

live 回读会把所建文档的网表与属性同 IR 对比，diff 报告在工具结果的 `verify` 字段里。模块框与标题是普通图元，按设计不参与网表 diff。
