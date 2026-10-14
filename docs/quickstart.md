# Quickstart

English | [中文](quickstart.zh.md)

From a zero-state machine to a generated schematic inside EasyEDA, then the failure modes and how to recover.

## Prerequisites

- Node.js `^22.19.0 || >=24.0.0` and a working `dsh` CLI (DeepSeek Harness runtime).
- EasyEDA Pro client, logged in, able to open a schematic editor tab.
- The npm packages published at `@deepseek-ai/dsh-plugin-eda-*@0.1.0-alpha.1` — see [publishing.md](publishing.md) if they are not on the registry yet; until then the dsh checkout loads this repository directly through its `cordis.patch.yml`.

## Happy path

1. **Install the bundle into a profile.**

   ```sh
   dsh plugin --profile <name> add @deepseek-ai/dsh-plugin-eda-bundle
   ```

   `schematic-bundle` mounts the schematic service, the model tools, and the EasyEDA engine in one shot. If the runtime rejects the plugin on a peer-version check, see the `allow-version` note under Troubleshooting.

2. **Start the web service.**

   ```sh
   dsh --profile <name>
   ```

   Launch the profile that serves the web app (e.g. a `web` profile: `dsh web`). The plugin binds into the dsh app; `schematic_generate` / `schematic_validate` become available to the model in sessions served by that profile.

3. **Open EasyEDA and connect the bridge.**

   Open any schematic project in the EasyEDA Pro editor so a schematic tab is live. The first live call auto-spawns `dsh-eda-bridge` on localhost when nothing answers; the editor-side registration needs either the community `run-api-gateway` extension (it scans the bridge port range) or the built-in gateway triggered by opening `https://pro.lceda.cn/api/landing?port=49620` inside an EasyEDA tab. `dsh-eda-bridge --check` prints the state and the next action without serving.

4. **Generate.**

   In a web session, ask the model for a circuit ("a 555 astable timer driving an LED"). The model calls `schematic_generate` with `verify: true`: the plugin validates the IR, resolves real library bindings, lays out geometry inside the sheet frame, serializes SCH_PAGE source, and delivers it into the open EasyEDA editor through the bridge — components, wires, netflags, module frames included. A successful delivery returns the created document; static findings and the live read-back diff come back as structured fields on the tool result.

   Without a connected EasyEDA client the same call still produces a `.epro2` project archive you can import manually through EasyEDA's file dialog.

## Troubleshooting

### `edaConnected:false` / no EasyEDA window

Run `dsh-eda-bridge --check`. Exit code `0` means a window is registered, `1` means the relay is up but no editor tab registered (open `http://localhost:<port>/landing` for the self-closing helper page, or `https://pro.lceda.cn/api/landing?port=49620` inside EasyEDA to trigger the built-in gateway), `2` means no bridge is listening (start `dsh-eda-bridge` or make any live call so the plugin auto-spawns it), `3` means another process on the port range is speaking an incompatible protocol (restart with `dsh-eda-bridge --force` if that port is really free). A window that registered but went silent is kicked by the bridge's application-level noop probe — the next `--check` then reports code `1` and the landing page re-registers it.

The `/landing` helper exists because the EasyEDA landing page calls `window.close()` after broadcasting, but browsers only honor that on script-opened windows — a tab you navigated to directly stays open. The helper opens it as a popup instead, polls `/health`, and closes the popup once a window registers.

### Plugin rejected on version check

The bundle declares peer ranges matching the verified host line (`@deepseek-ai/dsh-* >=0.2.1-alpha.2 <0.3.0`). An older or newer runtime refuses to load it unless you record an exact-version exemption:

```sh
dsh plugin --profile <name> allow-version @deepseek-ai/dsh-plugin-eda-bundle@0.1.0-alpha.1 --dsh-version <runtime-version> --accept-risk
```

The `--dsh-version` value is the exact version `dsh --version` prints. The exemption is an escape hatch for testing an unverified combination, not confirmation it works — prefer bumping the runtime into the declared range. `dsh plugin --profile <name> revoke-version` removes it; `version-exemptions` lists what is recorded.

### `CREATE_TIMEOUT` on live delivery

`sch_PrimitiveComponent.create` inside the EasyEDA client can wedge in a modal placement state that answers no API call — the call then hangs forever instead of returning. The delivery code races each create against a bound (~10 s) and reports `CREATE_TIMEOUT` so a stuck placement fails that chunk quickly instead of consuming repeated 30-second bridge retries. Recovery is client-side: reload the editor tab (or press ESC in it if an interactive placement ghost is visible) and re-run generation. Module frames, netflags, and netports are unaffected — only device placement wedges this way.

### Page size

`pageSize` constrains layout and validation bounds on the virtual frame, and A3/custom sizes are covered by tests. But the EasyEDA client exposes no page-size API — a delivered live page is always the default A4 frame (the `1170×825` virtual bounds, in 0.01-inch units). Treat any non-A4 `pageSize` as a planning artifact: layout and validation honor it, but only A4 is verified against a live client.

### Delivery ok, but the editor shows a different result

Live read-back compares the created document's netlist and attrs against the IR and reports diffs on the tool result (`verify` fields). Module frames and labels are plain graphics and are excluded from the netlist diff by design.
