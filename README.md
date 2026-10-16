# deepseek-eda-plugins

[![CI](https://github.com/mofanx/deepseek-eda-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/mofanx/deepseek-eda-plugins/actions/workflows/ci.yml)
[![DSH gate](https://github.com/mofanx/deepseek-eda-plugins/actions/workflows/dsh-gate.yml/badge.svg)](https://github.com/mofanx/deepseek-eda-plugins/actions/workflows/dsh-gate.yml)

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

Live delivery additionally needs the EasyEDA client running the run-api-gateway extension plus `dsh-eda-bridge` (the bin shipped inside `@deepseek-ai/dsh-plugin-eda-core`). A first live call auto-spawns the relay when nothing answers on localhost — `dsh-eda-bridge --check` reports the connection state and the next action without serving.

## Commands

```sh
pnpm install
pnpm run build          # tsc -b: emits lib/types per package
pnpm run test           # vitest, source-plane resolution via tsconfig paths
pnpm run test:coverage  # per-file 100% on packages/*/src (same gate as dsh)
pnpm run lint           # oxlint
```

All `@deepseek-ai/dsh-*` dependencies resolve from the npm `0.2.1-alpha.2` line; no sibling checkout is required.

## DSH gate (`dsh-gate.yml`)

`ci.yml` answers "is the code correct" (lint / typecheck / unit tests / build). `dsh-gate.yml` answers a different question that no other check can: **does this plugin actually load on a real DSH host, or does the host silently disable it?**

Two lanes, neither of which substitutes for the other:

| Lane | What it does | Cost |
|---|---|---|
| A · static gate | reads manifests / peer ranges / `exports` | seconds, no host boot |
| B · activation probe | boots DSH once and reads the startup diagnostics | one boot, **no credentials, no EasyEDA client** |

Lane B exists because of a measured fact: `dsh --dump-config` does **not** run the compatibility preflight — an incompatible row appears in the config dump with no `disabled` flag and no diagnostic at all. Only a real boot decides.

Both jobs **build before probing** (`pnpm install --frozen-lockfile && pnpm run build`, then an assertion that every declared entry file exists). Lane B verifies the **delivered artifact**, and a plugin's entry (`lib/index.js`) is a `tsc -b` output that is not in the repository: probing an unbuilt checkout makes every row fail with a bare `ERR_MODULE_NOT_FOUND`, which names the symptom rather than the cause. This was discovered the hard way — the first CI runs were red for exactly this reason, and the probe now reports a dedicated "not built" section so the two can be told apart.

> **That entry-file assertion was, until recently, a no-op for this repository.** All five packages declare `exports["."]` as a **conditional object** (`{"types": …, "default": "./lib/index.js"}`), not a string, and the check bailed out with `跳过（未声明入口）; exit 0` whenever it saw a non-string entry — so it reported success even with **every** build artifact missing. It now resolves the entry the way Node does (`import` > `node` > `default` > `require`; first resolvable branch of an array fallback) and **fails** when it cannot determine one. Nothing was actually broken — lane B independently fails with `ERR_MODULE_NOT_FOUND` on an unbuilt checkout, which is why the hole never produced a false green — but the check was not doing what it said it did. Found by pulling the CI command out and running it locally **with a deliberately removed artifact**: a passing run cannot tell a real assertion from a vacuous one.

The host comes from npm (`@deepseek-ai/dsh@<version>`) — a complete installation with `dsh-base` / `dsh-headless` / `dsh-app-boot`, same source and version as the desktop bundle — so no desktop artifact is needed on the runner, and the lanes run on plain `ubuntu-latest`. The matrix covers both host lines:

| Line | Version | Meaning |
|---|---|---|
| desktop | `0.2.0-rc.2` (npm `latest`) | what users actually install today |
| source | `0.2.1-alpha.4` (npm `alpha`) | the next DSH release |

A scheduled canary job additionally probes the moving `latest` / `alpha` dist-tags to warn early when an upstream release would disable a row; it is allowed to fail and never blocks a PR.

The gate itself is pinned (`TESTING_REV` in the workflow) to a commit of [`mofanx/dsh-plugin-testing`](https://github.com/mofanx/dsh-plugin-testing) — a gate that drifts with `main` cannot be trusted to give the same verdict twice. To run both lanes locally, see the comment block at the end of `dsh-gate.yml`.

> **Internal GitLab mirror.** `.gitlab-ci.yml` in this repository mirrors `.github/workflows/` job for job (`test` / `gate` / `canary`) for the internal GitLab migration. Both files can coexist: GitHub ignores `.gitlab-ci.yml`, GitLab ignores `.github/`, so migrating requires deleting nothing. It is **not verified on a real GitLab runner** — only its YAML validity, its structure and its lane-by-lane correspondence have been checked locally, and the file header lists the three things the internal environment must confirm. Neither file uses YAML anchors/aliases or `!reference`: `- *alias` pointing at a sequence becomes a **nested array**, and whether GitLab flattens that is undocumented, so the shared steps are duplicated verbatim instead.

See [docs/quickstart.md](docs/quickstart.md) ([中文](docs/quickstart.zh.md)) for the end-to-end happy path — `dsh plugin add` → `dsh web` → EasyEDA editor → `schematic_generate` — and the troubleshooting list (bridge `--check` recovery, `allow-version` exemption, `CREATE_TIMEOUT`, the A4-only live-verified page size).
