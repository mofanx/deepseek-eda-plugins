# Publishing

English only — release procedure for the five `@deepseek-ai/dsh-plugin-eda-*` packages.

## Version policy

- All five packages share one version, currently `0.1.0-alpha.1`, on an `0.1.0-alpha.x` prerelease line matching the host's own alpha train. Bump them together: internal `workspace:*` dependencies pack as exact same-version pins, so a partial release cannot resolve.
- Peer ranges track what the code was verified against, not what it might tolerate:
  - `@deepseek-ai/cordis`: `>=4.0.5-alpha.1 <4.1.0`
  - `@deepseek-ai/dsh-*`: `>=0.2.1-alpha.2 <0.3.0`
- Widening the dsh upper bound to `0.3.x` is a verification task, not an edit: rerun the suite and a host-level `dsh plugin add` + `schematic_generate` smoke on a 0.3.x runtime first.
- `dsh` itself is never a dependency — hosts provide cordis and the `dsh-*` service packages.

## Pre-publish checklist

1. `git status` clean; `master` pushed and in sync with `origin`.
2. `pnpm install` then `pnpm run build` — every `lib/index.js` + `lib/types/**` must exist (the `files` list packs nothing that is missing).
3. `pnpm run test:coverage` and `pnpm run lint` green.
4. Registry: these packages publish to **npmjs**, not the local mirror. Confirm `npm config get registry` or pass `--registry https://registry.npmjs.org` explicitly; `npm whoami` must show a user with publish rights on `@deepseek-ai`.
5. Publish in dependency order (or let `pnpm -r publish --access public` sort it): `dsh-plugin-eda-sch` → `dsh-plugin-eda-core` → `dsh-plugin-eda-sch-gen` / `dsh-plugin-eda-easyeda` → `dsh-plugin-eda-bundle`.
6. Smoke the release: `dsh plugin --profile <scratch> add @deepseek-ai/dsh-plugin-eda-bundle`, `dsh --profile <scratch> --dump-config` shows the three `optional-schematic*` rows, and a headless `schematic_validate` call returns `ok: true`.

## Dry-run evidence (0.1.0-alpha.1)

`pnpm pack` output — each tarball carries `package.json`, `lib/index.js`, `lib/types/**`, and both READMEs:

| Package | Extra payload |
|---|---|
| `dsh-plugin-eda-sch` | — |
| `dsh-plugin-eda-core` | `bin/dsh-eda-bridge.mjs` (shebang entry) |
| `dsh-plugin-eda-easyeda` | `scripts/live-verify.mjs` |
| `dsh-plugin-eda-sch-gen` | — |
| `dsh-plugin-eda-bundle` | `cordis.patch.yml`, `icon.svg`, `locale/{en,zh}.json` |

`workspace:*` references pack as exact `0.1.0-alpha.1` pins.
