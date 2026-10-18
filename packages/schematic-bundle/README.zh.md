---
description: "可选 profile 层，挂载原理图生成能力接缝、EasyEDA 引擎及其模型工具。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-eda-bundle

[English](README.md) | 中文

## 概述

以一个可选 profile 层挂载原理图生成能力族：`ctx.schematic` 接缝、EasyEDA 文档源引擎，以及面向模型的 `schematic_generate` / `schematic_validate` 工具。它在 Web 和 Desktop 中默认关闭，在插件页中启用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把已发布的 bundle 安装进 profile：

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-plugin-eda-bundle
```

`dsh.bundle` 清单会自动把该层追加到 `dsh.profile.bundles`。然后在 Web 或 Desktop 中打开插件页，在 Official 分组启用 **原理图生成**。关闭即可移除该 profile 层。

启用或停用该 bundle 会在运行中的 Host 注册或移除原理图工具，因此每个 Agent 在下一次请求时看到变化。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入三个 Host 行：`optional-schematic` 挂载接缝服务与校验器，`optional-schematic-easyeda` 在 `ctx.schematic` 上注册 `easyeda` 引擎，`optional-tool-schematic` 注册两个模型工具。工具层先经接缝校验每份 IR 文档，通过后才交给引擎输出；EasyEDA 在线构建路径在 run-api-gateway bridge 可达之前保持惰性。后续 profile patch 可按 id 重配或禁用任一行；仅有 override 不会选中该 bundle。patch 顺序与错误由 [profile 组装器](../../boot/app-boot/README.zh.md) 负责。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[原理图能力族](../README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接体现在[工具实现](../tool-schematic/README.zh.md)中，模型上下文与结果由它负责。

#### KV Cache 影响

该层本身不增加请求内容；工具、提示词与结果的缓存影响由工具实现负责。切换 bundle 会改变存活 Session 的工具列表，使其缓存的请求前缀失效一次。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 随附引擎只输出 EasyEDA V3 文档源。向运行中的 EasyEDA Pro 客户端在线放置图元需要 `dsh-eda-bridge` 与已注册的编辑器窗口；注册可走社区 `run-api-gateway` 扩展，也可在**不安装扩展**的情况下走编辑器内置 landing 页（`https://pro.lceda.cn/api/landing?port=49620`）。没有已注册窗口时，生成仍返回文档源，但不会写入客户端。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文——点击展开</summary>

无。

</details>
