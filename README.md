# deepseek-schematic-plugin

Externalized schematic-generation plugin for DeepSeek Harness. The model produces a typed schematic IR (`schematic_generate`), the seam binds it to real library parts, lays it out, statically validates it, and delivers it into EasyEDA — either serialized as a `.epro2` project or built live in the client through the local bridge.

**Status: migration skeleton.** Package manifests, TypeScript/vitest/oxlint infrastructure, and the bundle patch are in place; source code still lives in [`deepseek-harness`](../deepseek-harness/packages/schematic/) and moves per [docs/migration-plan.md](docs/migration-plan.md).

## Layout

```
packages/
  schematic/            @deepseek-ai/dsh-schematic            Service Definition: ctx.schematic, IR, layout, validator
  schematic-easyeda/    @deepseek-ai/dsh-schematic-easyeda    EasyEDA engine: serialize + live build/import/verify
  tool-schematic/       @deepseek-ai/dsh-tool-schematic       Model tools: schematic_generate, schematic_validate
  schematic-bundle/     @deepseek-ai/dsh-schematic-bundle     dsh.bundle layer (cordis.patch.yml)
  bridge/               @deepseek-ai/dsh-schematic-easyeda-bridge   Local bridge server bin (live path prerequisite)
```

## Install (once published)

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-schematic-bundle
dsh --profile <name>
```

Live delivery additionally needs the EasyEDA client running the run-api-gateway extension plus `npx @deepseek-ai/dsh-schematic-easyeda-bridge` (or the equivalent bin inside a profile install).

## Commands

```sh
pnpm install
pnpm run build          # tsc -b: emits lib/types per package
pnpm run test           # vitest, source-plane resolution via tsconfig paths
pnpm run test:coverage  # per-file 100% on packages/*/src (same gate as dsh)
pnpm run lint           # oxlint
```

For development against an unpublished sibling dsh checkout, link the peer packages locally instead of using the published `0.0.1-rc.1` versions — see the version-skew section of the migration plan.
