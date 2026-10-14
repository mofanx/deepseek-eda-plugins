# Host-integration fixtures

Fixtures for verifying that a dsh checkout loads this repository's plugins.
They were migrated from `deepseek-harness` `apps/cli/tests/profiles/headless/`
before the transitional `feat/schematic-generation` branch was removed.

To re-run the keyless end-to-end check from a dsh checkout:

```sh
pnpm dsh --profile headless \
  --patch <this-repo>/cordis.patch.yml \
  --patch <this-repo>/tests/host-integration/schematic-snapshot.patch.yml \
  --json "<task>"
```

`schematic-llm.mjs` is a mock model provider wired in by the snapshot patch;
`schematic-tools.expected.e2e.ts` and `stream-json.expected.jsonl` are the
recorded-session driver and golden output for the validate → generate loop.
The patch pins the EasyEDA bridge host to an unroutable TEST-NET-1 address so
the golden exercises the deterministic unreachable-library path.
