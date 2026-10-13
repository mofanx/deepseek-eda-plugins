---
description: "共享的嘉立创EDA客户端设施：run-api-gateway 桥客户端与 dsh-eda-bridge bin、工作区库、文档源读回/网表对账，以及 V3 SCH_PAGE/.epro2 序列化器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-eda-core

[English](README.md) | 中文

## 摘要

`dsh-plugin-eda-core` 承载所有 `dsh-plugin-eda-*` 插件共享的嘉立创EDA客户端设施：用于 run-api-gateway 中继的 `HttpEasyEdaBridge` 客户端、该中继的交付形态 `dsh-eda-bridge` 服务器 bin、`EasyEdaLibrary` 工作区库（LCSC 解析与真实符号引脚几何）、带 `diffNetlists` 的文档源读回，以及 V3 `SCH_PAGE`/`.epro2` 序列化器。它是库而非 cordis 插件——不导出 `apply`、不挂载任何服务；由引擎插件组合使用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

当插件需要触达正在运行的嘉立创EDA客户端、或需要发出其文档源时依赖本包，与插件注册的引擎 id 无关。`dsh-plugin-eda-easyeda` 为生成路径消费它；审查或分析插件复用同一组入口——`HttpEasyEdaBridge`/`EasyEdaLibrary` 提供实机客户端访问，`parseDocumentSource`/`readBackAttrs`/`readBackNetRegions`/`diffNetlists` 提供读回校验，`serializeEasyEdaDocument`/`serializeEasyEdaProject` 提供文档源输出。

实机路径需要在宿主与运行中的嘉立创EDA客户端之间部署 run-api-gateway 桥服务。本包以 `dsh-eda-bridge` bin 的形式交付——`npx dsh-eda-bridge`（或包内 `node bin/dsh-eda-bridge.mjs`）启动本地中继，绑定 49620–49629 中首个空闲端口并在 49630 上加挂专用监听，提供 `GET /health`（`{service:"easyeda-bridge", bridge:"dsh-eda-bridge", edaConnected:…}`）与 `POST /execute`，并在 `/eda` 上接受扩展的 WebSocket 注册、在 `/agent` 上接受 agent 连接（首帧为 `{type:"handshake", service:"easyeda-bridge"}`）。二次调用在已有兼容桥应答时退出；占用同一 service id 的异构实现（health 中 `bridge` 字段不同的不兼容协议）会导致启动失败，除非传入 `--force`。嘉立创EDA客户端侧有两条连接路径：社区 `run-api-gateway` 扩展通过扫描相同端口范围发现桥；编辑器内置网关则在编辑器页签内打开 `https://pro.lceda.cn/api/landing?port=<port>` 触发（`port` 参数仅为元数据——网关固定拨 `ws://127.0.0.1:49630`，随后在 ws 根路径上以 `{type:"register", tabId}` 注册，桥按首条消息将其归类为 EDA 窗口）。49630 被占用时降级为启动警告，社区扩展路径仍可用。

<a id="understand-the-implementation"></a>
## 理解实现

`HttpEasyEdaBridge.discover` 扫描约定端口范围，只接受 `bridge` 字段缺失或为 `dsh-eda-bridge` 的 health 载荷，并按 `SCHEMATIC_BRIDGE_UNAVAILABLE`、`SCHEMATIC_BRIDGE_NO_EDA`、`SCHEMATIC_BRIDGE_TIMEOUT` 分类失败；`execute` 将代码 POST 到 `/execute` 并解包桥信封，带连续超时熔断。`EasyEdaLibrary` 经客户端 `lib_*` 文档 API 解析器件，并从符号源中解析真实引脚几何。`readback` 从持久化的 `WIRE`/`LINE`/`ATTR` 记录重建电气域——schema 不携带引脚记录——`diffNetlists` 再将其与 IR 对账，包括经绑定符号真实几何变换后的引脚端点。`serialize` 按客户端持久化 schema 输出 `DOCHEAD` 开头的文档，并把整个项目打包为 `.epro2` 归档。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

桥 bin 每台机器单例：先启动的插件组合占用端口，嘉立创EDA扩展同时只保留一条 execute 通道。对真实客户端的实机验证由 `dsh-plugin-eda-easyeda` 的 `scripts/live-verify.mjs` 执行，它复用本包的发现与库解析入口。
