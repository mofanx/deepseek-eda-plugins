---
description: "Shared EasyEDA client machinery: run-api-gateway bridge client and dsh-eda-bridge bin, workspace library, document-source read-back/netlist diff, and V3 SCH_PAGE/.epro2 serializers."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-eda-core

English | [中文](README.zh.md)

## Summary

`dsh-plugin-eda-core` carries the EasyEDA client machinery every `dsh-plugin-eda-*` plugin shares: the `HttpEasyEdaBridge` client for the run-api-gateway relay, the `dsh-eda-bridge` server bin that relay ships as, the `EasyEdaLibrary` workspace library (LCSC resolution and real symbol-pin geometry), document-source read-back with `diffNetlists`, and the V3 `SCH_PAGE`/`.epro2` serializers. It is a library, not a cordis plugin — it exports no `apply` and mounts nothing; engine plugins compose it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Depend on this package when a plugin needs to reach a running EasyEDA client or emit its document source, regardless of which engine id the plugin registers. `dsh-plugin-eda-easyeda` consumes it for generation; a review or analysis plugin reuses the same surface — `HttpEasyEdaBridge`/`EasyEdaLibrary` for live client access, `parseDocumentSource`/`readBackAttrs`/`readBackNetRegions`/`diffNetlists` for read-back verification, `serializeEasyEdaDocument`/`serializeEasyEdaProject` for source emission.

The live paths need the run-api-gateway bridge server between the host and the running EasyEDA client. This package ships it as the `dsh-eda-bridge` bin — `npx dsh-eda-bridge` (or `node bin/dsh-eda-bridge.mjs` inside the package) starts a localhost relay that binds the first free port in 49620–49629 plus a dedicated listener on 49630, serves `GET /health` (`{service:"easyeda-bridge", bridge:"dsh-eda-bridge", edaConnected:…}`) and `POST /execute`, and accepts the extension's WebSocket registration on `/eda` plus agent connections on `/agent` with a `{type:"handshake", service:"easyeda-bridge"}` first frame. A second invocation exits when a compatible bridge already answers; a foreign implementation holding the service id (an incompatible protocol marked by a different `bridge` health field) fails startup unless `--force` is passed. The EasyEDA client side connects either through the community `run-api-gateway` extension, which discovers the bridge by scanning the same port range, or through the editor's built-in gateway: opening `https://pro.lceda.cn/api/landing?port=<port>` inside the editor tab triggers it (the `port` param is metadata only — the gateway always dials the fixed `ws://127.0.0.1:49630`, then registers with `{type:"register", tabId}` on the ws root, which the bridge classifies as an EDA window by its first message). A busy 49630 downgrades to a startup warning so the community-extension path still works.

<a id="understand-the-implementation"></a>
## Understand the implementation

`HttpEasyEdaBridge.discover` scans the advertised port range, accepts only health payloads whose `bridge` field is absent or `dsh-eda-bridge`, and classifies failure as `SCHEMATIC_BRIDGE_UNAVAILABLE`, `SCHEMATIC_BRIDGE_NO_EDA`, or `SCHEMATIC_BRIDGE_TIMEOUT`; `execute` POSTs code to `/execute` and unwraps the bridge envelope with a consecutive-timeout circuit. `EasyEdaLibrary` resolves parts through the client's `lib_*` document APIs and parses real pin geometry out of symbol sources. `readback` reconstructs electrical regions from persisted `WIRE`/`LINE`/`ATTR` records — the schema carries no pin records — and `diffNetlists` reconciles them against the IR, including pin endpoints transformed from the bound symbol's real geometry. `serialize` emits `DOCHEAD`-headed documents in the client's persisted schema and packs whole projects as `.epro2` archives.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

The bridge bin is a singleton per machine: whichever plugin composition runs first owns the port, and the EasyEDA extension keeps one execute channel at a time. Live verification against a real client is exercised by `dsh-plugin-eda-easyeda`'s `scripts/live-verify.mjs`, which reuses this package's discovery and library surface.
