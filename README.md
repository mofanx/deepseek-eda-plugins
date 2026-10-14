# deepseek-eda-plugins

Externalized schematic-generation plugin for DeepSeek Harness. The model produces a typed schematic IR (`schematic_generate`), the seam binds it to real library parts, lays it out, statically validates it, and delivers it into EasyEDA — either serialized as a `.epro2` project or built live in the client through the local bridge.

**Status: first migration landed.** Source and tests are imported; `pnpm install`/`tsc -b`/`vitest`/`coverage`/`oxlint` are green, and dsh loads this checkout through the root [`cordis.patch.yml`](cordis.patch.yml). This repository is the sole source of truth: the transitional `feat/schematic-generation` branch in `deepseek-harness` has been removed (dsh `master` never contained `packages/schematic`). See [docs/migration-plan.md](docs/migration-plan.md).

## Layout

```
packages/
  schematic/            @deepseek-ai/dsh-plugin-eda-sch        Service Definition: ctx.schematic, IR, layout, validator
  eda-core/             @deepseek-ai/dsh-plugin-eda-core       Shared EasyEDA client machinery: bridge client/bin, library, readback, serializers
  schematic-easyeda/    @deepseek-ai/dsh-plugin-eda-easyeda    EasyEDA engine: live build/import/verify orchestration
  tool-schematic/       @deepseek-ai/dsh-plugin-eda-sch-gen    Model tools: schematic_generate, schematic_validate
  schematic-bundle/     @deepseek-ai/dsh-plugin-eda-bundle     dsh.bundle layer (cordis.patch.yml)
```

## Install (once published)

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-plugin-eda-bundle
dsh --profile <name>
```

Live delivery additionally needs the EasyEDA client running the run-api-gateway extension plus `dsh-eda-bridge` (the bin shipped inside `@deepseek-ai/dsh-plugin-eda-core`).

## Commands

```sh
pnpm install
pnpm run build          # tsc -b: emits lib/types per package
pnpm run test           # vitest, source-plane resolution via tsconfig paths
pnpm run test:coverage  # per-file 100% on packages/*/src (same gate as dsh)
pnpm run lint           # oxlint
```

All `@deepseek-ai/dsh-*` dependencies resolve from the npm `0.2.1-alpha.2` line; no sibling checkout is required.
