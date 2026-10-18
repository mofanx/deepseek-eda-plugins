---
description: "Optional profile layer that mounts the schematic-generation capability seam, the EasyEDA engine, and its model tools."
kind: "package-bundle"
---

# @deepseek-ai/dsh-plugin-eda-bundle

English | [中文](README.zh.md)

## Summary

Mount the schematic-generation capability family in one selectable profile layer: the `ctx.schematic` seam, the EasyEDA document-source engine, and the model-facing `schematic_generate` / `schematic_validate` tools. It ships switched off in Web and Desktop. Select it in Plugins to enable it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install the published bundle into a profile:

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-plugin-eda-bundle
```

The `dsh.bundle` manifest appends the layer to `dsh.profile.bundles` automatically. In Web or Desktop, open Plugins and enable **Schematic generation** in Official. Switch it off to remove its profile layer.

Enabling or disabling the bundle registers or removes the schematic tools in the running Host, so every Agent sees the change on its next request.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts three Host rows: `optional-schematic` mounts the seam service and validator, `optional-schematic-easyeda` registers the `easyeda` engine on `ctx.schematic`, and `optional-tool-schematic` registers both model tools. The tool layer validates every IR document through the seam before the engine emits; the EasyEDA live-build path stays inert until a run-api-gateway bridge is reachable. Later profile patches can reconfigure or disable any row by id; an override alone does not select the bundle. The [profile composer](../../boot/app-boot/README.md) owns patch ordering and errors.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Schematic capability family](../README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [tool implementation](../tool-schematic/README.md), which owns model context and results.

#### KV Cache effect

The layer adds no request content directly; the tool implementation owns cache effects from tools, prompts, and results. Toggling the bundle changes the tool list of live Sessions, which invalidates their cached request prefix once.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The shipped engine emits EasyEDA V3 document source only. Live placement into a running EasyEDA Pro client requires `dsh-eda-bridge` and a registered editor window; registration works through the community `run-api-gateway` extension or, with no extension installed, through the editor's built-in landing page (`https://pro.lceda.cn/api/landing?port=49620`). Without a registered window, generation still returns document source but nothing is placed in the client.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

None.

</details>
