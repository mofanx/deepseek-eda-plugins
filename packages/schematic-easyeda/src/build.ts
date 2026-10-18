/**
 * Live EasyEDA build path: project the IR onto a running EasyEDA Pro client,
 * one `eda.*` primitive call at a time, through the injectable
 * {@link EasyEdaBridge} boundary. The in-client interpreter checks document
 * preconditions, creates every placeable primitive, then the host reads back
 * `sys_FileManager.getDocumentSource()` for a round-trip diff and optionally
 * collects the client's own BETA `sch_Drc` detail as advisory findings.
 * @module @deepseek-ai/dsh-plugin-eda-easyeda/build
 */

import { randomUUID } from 'node:crypto'
import { SCHEMATIC_PAGE_A4, SchematicError } from '@deepseek-ai/dsh-plugin-eda-sch'
import type {
  SchematicComponentKind,
  SchematicFinding,
  SchematicIr,
  SchematicLocator,
  SchematicPageSize,
  SchematicIrSheet,
  SchematicSymbolPin,
} from '@deepseek-ai/dsh-plugin-eda-sch'
import type { EasyEdaBridge } from '@deepseek-ai/dsh-plugin-eda-core'
import type { EasyEdaSheetFrameOptions, SheetChromeRect, SheetChromeText } from '@deepseek-ai/dsh-plugin-eda-core'
import { computeBlockFrames, computeSheetChrome, computeSheetSymbolBoxes, pageSizeLabel, serializeEasyEdaProject } from '@deepseek-ai/dsh-plugin-eda-core'
import type { EasyEdaEmbeddedDoc, EasyEdaProjectLibrary, EasyEdaProjectPackage } from '@deepseek-ai/dsh-plugin-eda-core'
import { diffNetlists, parseDocumentSource, readBackAttrs } from '@deepseek-ai/dsh-plugin-eda-core'

/** Options for {@link buildIntoEasyEda}. */
export interface EasyEdaBuildOptions {
  /** Bridge to execute code inside EasyEDA; inject a mock in tests. */
  readonly bridge: EasyEdaBridge
  /** Create the schematic container when the open project has none. Target
   * pages are always created fresh and activated — the build never writes into
   * whatever document happens to be open. */
  readonly createDocument?: boolean | undefined
  /** Collect the BETA `sch_Drc` detail as advisory findings after the build. */
  readonly advisoryDrc?: boolean | undefined
  /**
   * Page frame the module frames and sheet-symbol boxes clamp into. Default
   * {@link SCHEMATIC_PAGE_A4}; pass the size the layout stage planned against
   * (e.g. `SCHEMATIC_PAGE_A3`) or decoration clamps to the A4 rectangle.
   */
  readonly pageSize?: SchematicPageSize | undefined
  /**
   * Page border and title block drawn on each built page; omitted, the
   * primitive path draws no chrome. The import path takes the same fields.
   */
  readonly frame?: EasyEdaSheetFrameOptions | undefined
  /** Per-call timeout override for the bridge executions, in milliseconds. */
  readonly timeoutMs?: number | undefined
  /**
   * Extra attempts per chunked bridge call before it reports failure;
   * defaults to 2 (three attempts total). The bridge enforces a ~30s wall per
   * execution, so chunks — not retries — are what keep large builds moving.
   */
  readonly retries?: number | undefined
  /** Delay between chunk retries in milliseconds; defaults to 500. */
  readonly retryBackoffMs?: number | undefined
  /**
   * Non-part primitives and wires per bridge execution; defaults to 4. Parts
   * always go one per execution because each placement fetches the device and
   * symbol through the client catalog.
   */
  readonly batchSize?: number | undefined
  /**
   * Pin geometry per bound symbol UUID (the `symbolPins` snapshot from
   * `resolveBindings`). When present, the read-back diff also reconciles
   * every pin endpoint against the real symbol pin position, which catches
   * mirrored/offset endpoints that a name-level netlist diff cannot see.
   */
  readonly symbolPins?: ReadonlyMap<string, readonly SchematicSymbolPin[]> | undefined
}

/** Structured outcome of one live build. */
export interface EasyEdaBuildReport {
  /** Primitives the client reports as created. */
  readonly created: number
  /** Page uuids each IR sheet was built into, in sheet order. */
  readonly pageUuids: readonly string[]
  /** Build, round-trip, and advisory findings for routing back to the model. */
  readonly findings: readonly SchematicFinding[]
}

interface BuildComponent {
  irId: string
  kind: SchematicComponentKind
  designator?: string
  netName?: string
  deviceUuid?: string
  /** Owning-library scope of `deviceUuid`; required for system-library parts. */
  deviceLibraryUuid?: string
  subPartName?: string
  x: number
  y: number
  rotation: number
  mirror: boolean
  addIntoBom: boolean
  addIntoPcb: boolean
}

interface BuildWire {
  irId: string
  kind: 'wire' | 'bus'
  dots: number[][]
  net?: string
}

/** One module frame: a dashed rectangle plus its title text. */
interface BuildBlock {
  name: string
  title: string
  x: number
  y: number
  width: number
  height: number
  titleX: number
  titleY: number
}

/** One drawn sheet-symbol box for a `kind: 'block'` component. */
interface BuildSheetSymbol {
  irId: string
  title: string
  x: number
  y: number
  width: number
  height: number
  titleX: number
  titleY: number
  pins: { pinId: string; name: string; x: number; y: number }[]
}

interface BuildSheet {
  components: BuildComponent[]
  wires: BuildWire[]
  blocks: BuildBlock[]
  sheetSymbols: BuildSheetSymbol[]
  /** Page border and title block; empty when no frame was requested. */
  chrome: { rects: SheetChromeRect[]; texts: SheetChromeText[] }
  busEntryIds: string[]
  attrIds: string[]
}

interface BuildPayload {
  createDocument: boolean
  sheets: BuildSheet[]
}

function toBuildPayload(
  ir: SchematicIr,
  createDocument: boolean,
  pageSize: SchematicPageSize,
  frame?: EasyEdaSheetFrameOptions,
): BuildPayload {
  const pageCount = ir.sheets.length
  return {
    createDocument,
    sheets: ir.sheets.map((sheet, sheetIndex) => ({
      components: sheet.components.map(c => ({
        irId: c.id,
        kind: c.kind,
        ...c.designator !== undefined ? { designator: c.designator } : {},
        ...c.netName !== undefined ? { netName: c.netName } : {},
        ...c.deviceUuid !== undefined ? { deviceUuid: c.deviceUuid } : {},
        ...c.deviceLibraryUuid !== undefined ? { deviceLibraryUuid: c.deviceLibraryUuid } : {},
        ...c.partId !== undefined && c.partId !== '' ? { subPartName: c.partId } : {},
        x: c.position?.x ?? 0,
        y: c.position?.y ?? 0,
        rotation: c.rotation ?? 0,
        mirror: c.mirror ?? false,
        addIntoBom: c.addIntoBom ?? true,
        addIntoPcb: c.addIntoPcb ?? true,
      })),
      wires: sheet.wires.flatMap(w => {
        const chains = w.dots ?? []
        // A `dots` array is a list of polylines, not one polyline. EasyEDA's
        // incremental wire create does not persist a nested array reliably
        // (live: only the first chain lands), so split the chains: each becomes
        // its own create call and its own count.
        if (chains.length === 0) return [{ irId: w.id, kind: w.kind, dots: [], ...w.net !== undefined ? { net: w.net } : {} }]
        return chains.map((chain, index) => ({
          irId: chains.length === 1 ? w.id : `${w.id}:${index}`,
          kind: w.kind,
          dots: [chain.map(value => value)],
          ...w.net !== undefined ? { net: w.net } : {},
        }))
      }),
      blocks: computeBlockFrames(sheet, pageSize).map(frame => ({ ...frame })),
      sheetSymbols: computeSheetSymbolBoxes(sheet, pageSize).map(box => ({
        irId: box.componentId,
        title: box.title,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        titleX: box.titleX,
        titleY: box.titleY,
        pins: box.pins.map(pin => ({ pinId: pin.pinId, name: pin.name, x: pin.x, y: pin.y })),
      })),
      chrome: chromeFor(sheet, sheetIndex, sheet.pageSize ?? pageSize, pageCount, frame),
      busEntryIds: sheet.busEntries.map(entry => entry.id),
      attrIds: sheet.attrs.map(attr => attr.id),
    })),
  }
}

/**
 * Compute one page's border and title-block primitives. The chrome is drawn in
 * IR coordinates like every other decoration (the SCH_* primitive API shares
 * the IR's top-left, Y-down space; only the persisted source negates Y), so the
 * serializer and the primitive path print the same page.
 * @param sheet - the sheet being built.
 * @param sheetIndex - zero-based page index printed in the title block.
 * @param pageSize - page frame the layout planned against.
 * @param pageCount - total pages in the document, printed as `n/m`.
 * @param frame - title-block fields; omitted, no chrome is drawn.
 * @returns the page's rectangle and text primitives.
 */
function chromeFor(
  sheet: SchematicIrSheet,
  sheetIndex: number,
  pageSize: SchematicPageSize,
  pageCount: number,
  frame?: EasyEdaSheetFrameOptions,
): { rects: SheetChromeRect[]; texts: SheetChromeText[] } {
  if (frame === undefined) return { rects: [], texts: [] }
  const chrome = computeSheetChrome({
    pageSize,
    projectTitle: frame.projectTitle ?? 'DSH Schematic',
    pageName: sheet.name ?? `P${sheetIndex + 1}`,
    pageIndex: sheetIndex,
    pageCount,
    sizeLabel: pageSizeLabel(pageSize),
    version: frame.version ?? 'V0.1',
    company: frame.company ?? '',
    date: frame.date ?? '',
    drawingNumber: frame.drawingNumber,
    schematicName: frame.schematicName,
    drawnBy: frame.drawnBy,
    checkedBy: frame.checkedBy,
    approvedBy: frame.approvedBy,
  })
  return { rects: chrome.rects.map(rect => ({ ...rect })), texts: chrome.texts.map(text => ({ ...text })) }
}

const THROWN_DETAIL = `const thrownDetail = (e) => {
  if (e && e.message) return String(e.message);
  try { return JSON.stringify(e) } catch (e2) { return String(e) }
};
// A create call on a freshly (re)opened page can throw while the client is
// still initializing the document; one short settle and retry absorbs it.
const placeOnce = async (fn) => {
  try { return await fn() } catch (e) {
    await new Promise(r => setTimeout(r, 300));
    return await fn();
  }
};
// A device create can deadlock client-side (a stale interactive placement
// or an undismissed dialog) and never resolve; racing it turns the hang
// into a per-part failure instead of burning the whole bridge timeout.
const raced = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(undefined), ms))]);
`

/**
 * Render the preparation stage: project/schematic precondition checks plus one
 * fresh, activated, identity-verified page per IR sheet. Placement runs in the
 * per-chunk scripts — a single execution carrying every device outlives the
 * bridge's ~30s wall.
 * @param payload - the primitive payload produced by {@link buildIntoEasyEda}.
 * @returns the JavaScript body to pass to {@link EasyEdaBridge.execute}.
 */
export function renderPrepareScript(payload: BuildPayload): string {
  return `${THROWN_DETAIL}const doc = ${JSON.stringify(payload)};
const failures = [];
const pageUuids = [];
const project = await eda.dmt_Project.getCurrentProjectInfo();
if (!project) return { status: 'NO_PROJECT', failures, pageUuids };
const openPage = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
let schematicUuid = openPage && openPage.parentSchematicUuid;
if (!schematicUuid) {
  if (!doc.createDocument) return { status: 'NO_ACTIVE_PAGE', failures, pageUuids };
  schematicUuid = await eda.dmt_Schematic.createSchematic();
  if (typeof schematicUuid !== 'string') return { status: 'NO_SCHEMATIC', failures, pageUuids };
}
for (let sheetIndex = 0; sheetIndex < doc.sheets.length; sheetIndex++) {
  // Never write into the currently open document: every sheet gets a fresh
  // page, activated and identity-checked before any primitive is created —
  // building into a foreign open page silently contaminates it.
  // createSchematicPage can throw AFTER creating the page (the client builds
  // its return value from a partially-loaded schematic), so the new page is
  // recovered by diffing the page list when the call does not return a uuid.
  const beforePages = new Set(((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid));
  let targetPageUuid;
  try {
    targetPageUuid = await eda.dmt_Schematic.createSchematicPage(schematicUuid);
  } catch (e) {
    // Page may still have been created; recovered below.
  }
  if (typeof targetPageUuid !== 'string') {
    const fresh = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || [])
      .map(p => p.uuid).filter(u => !beforePages.has(u));
    if (fresh.length === 1) targetPageUuid = fresh[0];
  }
  if (typeof targetPageUuid !== 'string') { failures.push({ code: 'PAGE_CREATE_FAILED', sheetIndex }); pageUuids.push(null); continue; }
  await eda.dmt_EditorControl.openDocument(targetPageUuid);
  const active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
  if (!active || active.uuid !== targetPageUuid) { failures.push({ code: 'PAGE_ACTIVATE_FAILED', sheetIndex }); pageUuids.push(null); continue; }
  pageUuids.push(targetPageUuid);
}
return { status: 'OK', failures, pageUuids };`
}

/**
 * Render one placement chunk for component-kind primitives on an already
 * activated page. The script re-activates the target page and skips primitives
 * whose `(x,y)` position is already occupied, so retrying a timed-out chunk
 * does not duplicate placements.
 * @param components - the chunk's components (parts one per chunk; flags,
 * ports, and shorts batched).
 * @param pageUuid - target page uuid from the preparation stage.
 * @param sheetIndex - sheet index reported back on failures.
 * @returns the JavaScript body to pass to {@link EasyEdaBridge.execute}.
 */
export function renderComponentChunkScript(components: readonly BuildComponent[], pageUuid: string, sheetIndex: number): string {
  return `${THROWN_DETAIL}const doc = { pageUuid: ${JSON.stringify(pageUuid)}, sheetIndex: ${sheetIndex}, components: ${JSON.stringify(components)} };
const failures = [];
let created = 0;
await eda.dmt_EditorControl.openDocument(doc.pageUuid);
const active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
if (!active || active.uuid !== doc.pageUuid) return { status: 'WRONG_PAGE', failures, created };
// Idempotency key is the (x,y) position: a primitive already sitting there
// means an earlier attempt placed it before the bridge timed out.
const occupied = [];
try { occupied.push(...(await eda.sch_PrimitiveComponent.getAll(undefined, false) || [])) } catch (e) {}
for (const c of doc.components) {
  if (occupied.some(p => Math.abs(p.x - c.x) < 0.5 && Math.abs(p.y - c.y) < 0.5)) { created += 1; continue; }
  try {
    let placed;
    if (c.kind === 'part' || c.kind === 'block') {
      if (c.deviceUuid === undefined) { failures.push({ code: 'NO_DEVICE', irId: c.irId, sheetIndex: doc.sheetIndex }); continue; }
      // Binding UUIDs from library lookups are scoped to their owning library;
      // an unscoped lib_Device.get resolves the marketplace default scope and
      // misses system/project copies.
      let device;
      try {
        device = await eda.lib_Device.get(c.deviceUuid, c.deviceLibraryUuid);
      } catch (e) {
        device = await eda.lib_Device.get(c.deviceUuid, undefined);
      }
      if (device === undefined) { failures.push({ code: 'DEVICE_NOT_FOUND', irId: c.irId, sheetIndex: doc.sheetIndex }); continue; }
      placed = await raced(placeOnce(() => eda.sch_PrimitiveComponent.create(device, c.x, c.y, c.subPartName, c.rotation, c.mirror, c.addIntoBom, c.addIntoPcb)).then(v => ['ok', v], e => ['throw', e]), 15000);
      if (placed === undefined) { failures.push({ code: 'CREATE_TIMEOUT', irId: c.irId, sheetIndex: doc.sheetIndex }); continue; }
      if (placed[0] !== 'ok') { failures.push({ code: 'CREATE_THROWN', irId: c.irId, sheetIndex: doc.sheetIndex, detail: thrownDetail(placed[1]) }); continue; }
      placed = placed[1];
      if (placed === undefined) { failures.push({ code: 'CREATE_FAILED', irId: c.irId, sheetIndex: doc.sheetIndex }); continue; }
      if (c.designator !== undefined) await eda.sch_PrimitiveComponent.modify(placed, { designator: c.designator });
      created += 1;
    } else if (c.kind === 'netflag') {
      if (c.netName === undefined) { failures.push({ code: 'MISSING_NET', irId: c.irId, sheetIndex: doc.sheetIndex }); continue; }
      const identification = /^(GND|AGND|DGND|PGND|PE|GROUND|EARTH)/i.test(c.netName) ? 'Ground' : 'Power';
      placed = await placeOnce(() => eda.sch_PrimitiveComponent.createNetFlag(identification, c.netName, c.x, c.y, c.rotation, c.mirror));
      if (placed === undefined) failures.push({ code: 'CREATE_FAILED', irId: c.irId, sheetIndex: doc.sheetIndex }); else created += 1;
    } else if (c.kind === 'netport') {
      if (c.netName === undefined) { failures.push({ code: 'MISSING_NET', irId: c.irId, sheetIndex: doc.sheetIndex }); continue; }
      placed = await placeOnce(() => eda.sch_PrimitiveComponent.createNetPort('BI', c.netName, c.x, c.y, c.rotation, c.mirror));
      if (placed === undefined) failures.push({ code: 'CREATE_FAILED', irId: c.irId, sheetIndex: doc.sheetIndex }); else created += 1;
    } else if (c.kind === 'short') {
      placed = await placeOnce(() => eda.sch_PrimitiveComponent.createShortCircuitFlag(c.x, c.y, c.rotation, c.mirror));
      if (placed === undefined) failures.push({ code: 'CREATE_FAILED', irId: c.irId, sheetIndex: doc.sheetIndex }); else created += 1;
    } else {
      failures.push({ code: 'UNSUPPORTED_KIND', irId: c.irId, sheetIndex: doc.sheetIndex, kind: c.kind });
    }
  } catch (e) {
    failures.push({ code: 'CREATE_THROWN', irId: c.irId, sheetIndex: doc.sheetIndex, detail: thrownDetail(e) });
  }
}
return { status: 'OK', failures, created };`
}

/**
 * Render one placement chunk for wire/bus primitives. Retried chunks dedupe on
 * `(net, line)` read back from the page so a lost response cannot double a
 * wire.
 * @param wires - the chunk's wires (buses included).
 * @param pageUuid - target page uuid from the preparation stage.
 * @param sheetIndex - sheet index reported back on failures.
 * @returns the JavaScript body to pass to {@link EasyEdaBridge.execute}.
 */
export function renderWireChunkScript(wires: readonly BuildWire[], pageUuid: string, sheetIndex: number): string {
  return `${THROWN_DETAIL}const doc = { pageUuid: ${JSON.stringify(pageUuid)}, sheetIndex: ${sheetIndex}, wires: ${JSON.stringify(wires)} };
const failures = [];
let created = 0;
await eda.dmt_EditorControl.openDocument(doc.pageUuid);
const active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
if (!active || active.uuid !== doc.pageUuid) return { status: 'WRONG_PAGE', failures, created };
const seen = new Set();
try {
  for (const w of await eda.sch_PrimitiveWire.getAll() || []) {
    try { seen.add(w.getState_Net() + '|' + JSON.stringify(w.getState_Line())) } catch (e) {}
  }
} catch (e) {}
for (const w of doc.wires) {
  try {
    if (w.net === undefined) { failures.push({ code: 'MISSING_NET', irId: w.irId, sheetIndex: doc.sheetIndex }); continue; }
    // One entry can carry several disjoint polylines. Create and count each
    // chain separately; passing the nested array as one line drops every chain
    // after the first (observed live: multi-chain nets vanish from the netlist).
    const chains = w.dots.length === 0 ? [] : (Array.isArray(w.dots[0]) ? w.dots : [w.dots]);
    // A row with no geometry is a net declaration, not a primitive: pagination
    // keeps authored wire rows without their (unanchored) dots so ATTRs survive.
    // There is nothing to draw, and reporting CREATE_FAILED would block delivery
    // of a document the layout produced on purpose.
    if (chains.length === 0) continue;
    for (const line of chains) {
      if (w.kind !== 'bus' && seen.has(w.net + '|' + JSON.stringify(line))) { created += 1; continue; }
      const placed = w.kind === 'bus'
        ? await placeOnce(() => eda.sch_PrimitiveBus.create(w.net, line))
        : await placeOnce(() => eda.sch_PrimitiveWire.create(line, w.net));
      if (placed === undefined) failures.push({ code: 'CREATE_FAILED', irId: w.irId, sheetIndex: doc.sheetIndex }); else created += 1;
    }
  } catch (e) {
    failures.push({ code: 'CREATE_THROWN', irId: w.irId, sheetIndex: doc.sheetIndex, detail: thrownDetail(e) });
  }
}
return { status: 'OK', failures, created };`
}

/**
 * Render one placement chunk for module frames: a dashed rectangle plus its
 * title text per functional block. Frames are non-electrical decoration, so
 * the chunk reports `created: 0` — they are not part of the placement-count
 * invariant — and dedupes on geometry so a retried chunk never double-draws.
 * @param blocks - the sheet's module frames.
 * @param pageUuid - target page uuid from the preparation stage.
 * @param sheetIndex - sheet index reported back on failures.
 * @returns the JavaScript body to pass to {@link EasyEdaBridge.execute}.
 */
export function renderBlockChunkScript(blocks: readonly BuildBlock[], pageUuid: string, sheetIndex: number): string {
  return `${THROWN_DETAIL}const doc = { pageUuid: ${JSON.stringify(pageUuid)}, sheetIndex: ${sheetIndex}, blocks: ${JSON.stringify(blocks)} };
const failures = [];
await eda.dmt_EditorControl.openDocument(doc.pageUuid);
const active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
if (!active || active.uuid !== doc.pageUuid) return { status: 'WRONG_PAGE', failures, created: 0 };
const rects = [];
try { rects.push(...(await eda.sch_PrimitiveRectangle.getAll() || [])) } catch (e) {}
const texts = [];
try { texts.push(...(await eda.sch_PrimitiveText.getAll() || [])) } catch (e) {}
for (const b of doc.blocks) {
  try {
    const haveRect = rects.some((r) => { try { return Math.abs(r.getState_TopLeftX() - b.x) < 0.5 && Math.abs(r.getState_TopLeftY() - b.y) < 0.5 && Math.abs(r.getState_Width() - b.width) < 0.5 && Math.abs(r.getState_Height() - b.height) < 0.5 } catch (e) { return false } });
    if (!haveRect) {
      const rect = await placeOnce(() => eda.sch_PrimitiveRectangle.create(b.x, b.y, b.width, b.height, 0, 0, null, '', null, 1, 'None'));
      if (rect === undefined) { failures.push({ code: 'FRAME_FAILED', irId: 'block:' + b.name, sheetIndex: doc.sheetIndex }); continue; }
    }
    const haveText = texts.some((t) => { try { return t.getState_Content() === b.title && Math.abs(t.getState_X() - b.titleX) < 0.5 && Math.abs(t.getState_Y() - b.titleY) < 0.5 } catch (e) { return false } });
    if (!haveText) {
      const text = await placeOnce(() => eda.sch_PrimitiveText.create(b.titleX, b.titleY, b.title, 0, '#000088', null, 40, true, false, false, 1));
      if (text === undefined) failures.push({ code: 'FRAME_FAILED', irId: 'block:' + b.name, sheetIndex: doc.sheetIndex });
    }
  } catch (e) {
    failures.push({ code: 'FRAME_FAILED', irId: 'block:' + b.name, sheetIndex: doc.sheetIndex, detail: thrownDetail(e) });
  }
}
return { status: 'OK', failures, created: 0 };`
}

/**
 * Render one placement chunk for the page border and title block: the frame
 * rules plus their text runs. The chrome is non-electrical, so the chunk
 * reports `created: 0` and failures arrive as warnings; retries dedupe against
 * the primitives already on the page (a rect by geometry, a text by content).
 * @param chrome - the page's rectangle and text primitives.
 * @param pageUuid - target page uuid from the preparation stage.
 * @param sheetIndex - sheet index reported back on failures.
 * @returns the JavaScript body to pass to {@link EasyEdaBridge.execute}.
 */
export function renderChromeChunkScript(
  chrome: { rects: readonly SheetChromeRect[]; texts: readonly SheetChromeText[] },
  pageUuid: string,
  sheetIndex: number,
): string {
  return `${THROWN_DETAIL}const doc = { pageUuid: ${JSON.stringify(pageUuid)}, sheetIndex: ${sheetIndex}, chrome: ${JSON.stringify(chrome)} };
const failures = [];
await eda.dmt_EditorControl.openDocument(doc.pageUuid);
const active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
if (!active || active.uuid !== doc.pageUuid) return { status: 'WRONG_PAGE', failures, created: 0 };
const rects = [];
try { rects.push(...(await eda.sch_PrimitiveRectangle.getAll() || [])) } catch (e) {}
const texts = [];
try { texts.push(...(await eda.sch_PrimitiveText.getAll() || [])) } catch (e) {}
for (const r of doc.chrome.rects) {
  try {
    const haveRect = rects.some((o) => { try { return Math.abs(o.getState_TopLeftX() - r.x1) < 0.5 && Math.abs(o.getState_TopLeftY() - r.y1) < 0.5 && Math.abs(o.getState_Width() - (r.x2 - r.x1)) < 0.5 && Math.abs(o.getState_Height() - (r.y2 - r.y1)) < 0.5 } catch (e) { return false } });
    if (!haveRect) {
      const rect = await placeOnce(() => eda.sch_PrimitiveRectangle.create(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1, 0, 0, null, '', null, 1, 'None'));
      if (rect === undefined) failures.push({ code: 'FRAME_FAILED', irId: 'chrome:rect', sheetIndex: doc.sheetIndex });
    }
  } catch (e) {
    failures.push({ code: 'FRAME_FAILED', irId: 'chrome:rect', sheetIndex: doc.sheetIndex, detail: thrownDetail(e) });
  }
}
for (const t of doc.chrome.texts) {
  try {
    const haveText = texts.some((o) => { try { return o.getState_Content() === t.value && Math.abs(o.getState_X() - t.x) < 0.5 && Math.abs(o.getState_Y() - t.y) < 0.5 } catch (e) { return false } });
    if (!haveText) {
      const align = t.align === 'RIGHT_TOP' ? 2 : 1;
      const text = await placeOnce(() => eda.sch_PrimitiveText.create(t.x, t.y, t.value, 0, '#000088', null, t.fontSize, false, false, false, align));
      if (text === undefined) failures.push({ code: 'FRAME_FAILED', irId: 'chrome:text', sheetIndex: doc.sheetIndex });
    }
  } catch (e) {
    failures.push({ code: 'FRAME_FAILED', irId: 'chrome:text', sheetIndex: doc.sheetIndex, detail: thrownDetail(e) });
  }
}
return { status: 'OK', failures, created: 0 };`
}

/**
 * Render one placement chunk for sheet-symbol boxes: the drawn rectangle,
 * title, and pin-name labels of `kind: 'block'` components. The box is
 * non-electrical (the child's same-named netports carry the interface), so
 * the chunk reports `created: 0` and failures arrive as warnings; retries
 * dedupe on the title text already on the page.
 * @param symbols - the sheet's hierarchy blocks.
 * @param pageUuid - target page uuid from the preparation stage.
 * @param sheetIndex - sheet index reported back on failures.
 * @returns the JavaScript body to pass to {@link EasyEdaBridge.execute}.
 */
export function renderSheetSymbolChunkScript(symbols: readonly BuildSheetSymbol[], pageUuid: string, sheetIndex: number): string {
  return `${THROWN_DETAIL}const doc = { pageUuid: ${JSON.stringify(pageUuid)}, sheetIndex: ${sheetIndex}, symbols: ${JSON.stringify(symbols)} };
const failures = [];
await eda.dmt_EditorControl.openDocument(doc.pageUuid);
const active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
if (!active || active.uuid !== doc.pageUuid) return { status: 'WRONG_PAGE', failures, created: 0 };
const texts = [];
try { texts.push(...(await eda.sch_PrimitiveText.getAll() || [])) } catch (e) {}
const seen = new Set();
for (const t of texts) { try { seen.add(t.getState_Content()) } catch (e) {} }
for (const s of doc.symbols) {
  try {
    if (!seen.has(s.title)) {
      const rect = await placeOnce(() => eda.sch_PrimitiveRectangle.create(s.x, s.y, s.width, s.height, 0, 0, null, '', null, 1, 'None'));
      if (rect === undefined) { failures.push({ code: 'FRAME_FAILED', irId: s.irId, sheetIndex: doc.sheetIndex }); continue; }
      const title = await placeOnce(() => eda.sch_PrimitiveText.create(s.titleX, s.titleY, s.title, 0, '#000088', null, 40, true, false, false, 1));
      if (title === undefined) failures.push({ code: 'FRAME_FAILED', irId: s.irId, sheetIndex: doc.sheetIndex });
      seen.add(s.title);
    }
    for (const pin of s.pins) {
      if (seen.has(pin.name)) continue;
      const label = await placeOnce(() => eda.sch_PrimitiveText.create(pin.x, pin.y, pin.name, 0, '#000088', null, 20, true, false, false, 1));
      if (label === undefined) failures.push({ code: 'FRAME_FAILED', irId: s.irId, sheetIndex: doc.sheetIndex }); else seen.add(pin.name);
    }
  } catch (e) {
    failures.push({ code: 'FRAME_FAILED', irId: s.irId, sheetIndex: doc.sheetIndex, detail: thrownDetail(e) });
  }
}
return { status: 'OK', failures, created: 0 };`
}

/**
 * Render the post-build oracle: per-page primitive counts and the client's net
 * names, plus the BETA `sch_Drc` detail when enabled. Everything degrades to a
 * field error instead of throwing so the host can always classify what the
 * client reported.
 * @param pageUuids - the built page uuids to inspect.
 * @param runDrc - whether to invoke `sch_Drc.check` with verbose detail.
 * @returns the JavaScript body to pass to {@link EasyEdaBridge.execute}.
 */
export function renderOracleScript(pageUuids: readonly string[], runDrc: boolean): string {
  return `${THROWN_DETAIL}const out = { counts: [], nets: undefined, netsError: undefined, drc: undefined, drcError: undefined };
for (const uuid of ${JSON.stringify([...pageUuids])}) {
  try {
    await eda.dmt_EditorControl.openDocument(uuid);
    const comps = await eda.sch_PrimitiveComponent.getAll(undefined, false);
    let wires = 0;
    try { const wl = await eda.sch_PrimitiveWire.getAll(); wires += wl ? wl.length : 0 } catch (e) {}
    try { const bl = await eda.sch_PrimitiveBus.getAll(); wires += bl ? bl.length : 0 } catch (e) {}
    // The page's drawing frame is itself a component (componentType "sheet");
    // it is not part of the design and must not count against the IR total.
    let placed = comps ? comps.length : -1;
    if (comps) {
      placed = 0;
      for (const c of comps) {
        let componentType;
        try { componentType = c.getState_ComponentType() } catch (e) { componentType = undefined }
        if (componentType === 'sheet') continue;
        placed += 1;
      }
    }
    out.counts.push({ components: placed, wires });
  } catch (e) { out.counts.push(null); }
}
try {
  // The client computes connectivity asynchronously; a netlist generated
  // immediately after placement can miss just-created nets, so let it settle.
  await new Promise(r => setTimeout(r, 1500));
  let nets;
  try { nets = await eda.sch_Net.getAllNets() } catch (e) {}
  if (!nets || !nets.length) { try { nets = await eda.sch_Net.getCurrentProjectAllNets() } catch (e) {} }
  if (nets && nets.length) {
    out.nets = nets.map(n => typeof n === 'string' ? n : n && (n.name ?? n.net)).filter(n => typeof n === 'string');
  }
  // The Protel netlist file is the only bounded call that carries pad-level
  // detail, and it also backstops net names (sch_Netlist.getNetlist is
  // deprecated and can stall past the bridge wall in a live client). Net blocks
  // read "(", net name, pad rows, ")".
  //
  // The client recomputes connectivity asynchronously, so a single read taken
  // right after the last placement chunk can see a half-built netlist — nets
  // absent, or present with only some of their pads. A verdict drawn from that
  // snapshot is all false positives (observed on a 231-component page: 0 wires,
  // 1 net). Read until two consecutive reads agree, inside a bounded budget.
  const readNetPads = async () => {
    const file = await eda.sch_ManufactureData.getNetlistFile('dsh-oracle', 'Protel2');
    const text = file && await file.text();
    if (typeof text !== 'string') return undefined;
    const parsed = {};
    let inNet = false;
    let net;
    for (const line of text.split(/\\r?\\n/)) {
      const t = line.trim();
      if (t === '(') { inNet = true; net = undefined; continue; }
      if (t === ')') { inNet = false; net = undefined; continue; }
      if (!inNet || t === '') continue;
      if (net === undefined) { net = t.replace(/^"|"$/g, ''); if (parsed[net] === undefined) parsed[net] = []; continue; }
      // A pad row reads "DESIGNATOR-PIN  FOOTPRINT-PIN  TYPE"; the first
      // token is the schematic pad the net actually lands on.
      const pad = t.split(/\\s+/)[0].replace(/^"|"$/g, '');
      if (/^[A-Za-z]+\\d+-\\S+$/.test(pad)) parsed[net].push(pad);
    }
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  };
  try {
    let settled;
    let previousCount = -1;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1800));
      let candidate;
      try { candidate = await readNetPads() } catch (e) { candidate = undefined }
      const count = candidate === undefined ? 0 : Object.keys(candidate).length;
      if (count > 0) settled = candidate;
      if (count > 0 && count === previousCount) break;
      previousCount = count;
    }
    if (settled !== undefined) {
      out.netPads = settled;
      if (!out.nets || !out.nets.length) out.nets = Object.keys(settled);
    }
  } catch (e) {}
} catch (e) { out.netsError = thrownDetail(e) }
if (${runDrc ? 'true' : 'false'}) {
  try { out.drc = await eda.sch_Drc.check(true, false, true) } catch (e) { out.drcError = thrownDetail(e) }
}
return out;`
}

interface ScriptFailure {
  code: string
  irId?: string
  sheetIndex?: number
  kind?: string
  detail?: string
}

interface PrepareResult {
  status: string
  failures: ScriptFailure[]
  /** One slot per IR sheet; `null` where the page could not be prepared. */
  pageUuids: (string | null)[]
}

function isPrepareResult(value: unknown): value is PrepareResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.status === 'string' && Array.isArray(v.failures) && Array.isArray(v.pageUuids)
}

const ERROR_FAILURE_CODES = new Set(['NO_DEVICE', 'DEVICE_NOT_FOUND', 'MISSING_NET', 'CREATE_FAILED', 'CREATE_THROWN', 'CREATE_TIMEOUT', 'PAGE_CREATE_FAILED', 'PAGE_ACTIVATE_FAILED', 'CHUNK_FAILED'])

/** Chunk scripts return this placement shape. */
interface ChunkResult {
  status: string
  failures: ScriptFailure[]
  created: number
}

function isChunkResult(value: unknown): value is ChunkResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.status === 'string' && Array.isArray(v.failures) && typeof v.created === 'number'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Execute one chunk with bounded retries. A timeout does not mean the client
 * skipped the placement, so retries rely on the chunk scripts' in-page
 * idempotency checks rather than re-delivering blind.
 */
async function executeChunk(
  bridge: EasyEdaBridge,
  script: string,
  options: { timeoutMs?: number | undefined },
  retries: number,
  backoffMs: number,
): Promise<ChunkResult> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await bridge.execute(script, options)
      if (!isChunkResult(raw)) {
        throw new SchematicError('easyeda chunk returned an unrecognized result shape', 'SCHEMATIC_BRIDGE_PROTOCOL')
      }
      if (raw.status === 'WRONG_PAGE') {
        throw new SchematicError('the target page could not be re-activated for placement', 'SCHEMATIC_BUILD_PAGE_ACTIVATE')
      }
      return raw
    } catch (error) {
      lastError = error
      const code = error instanceof SchematicError ? error.code : ''
      if (code === 'SCHEMATIC_BRIDGE_CIRCUIT_OPEN' || code === 'SCHEMATIC_BRIDGE_NO_EDA') throw error
      if (attempt >= retries) throw error
      await sleep(backoffMs)
    }
  }
  throw lastError
}

function findingCode(scriptCode: string): string {
  switch (scriptCode) {
    case 'NO_DEVICE': return 'SCHEMATIC_BUILD_NO_DEVICE'
    case 'DEVICE_NOT_FOUND': return 'SCHEMATIC_BUILD_DEVICE_NOT_FOUND'
    case 'MISSING_NET': return 'SCHEMATIC_BUILD_MISSING_NET'
    case 'PAGE_CREATE_FAILED': return 'SCHEMATIC_BUILD_PAGE_CREATE'
    case 'PAGE_ACTIVATE_FAILED': return 'SCHEMATIC_BUILD_PAGE_ACTIVATE'
    case 'UNSUPPORTED_KIND': return 'SCHEMATIC_BUILD_UNSUPPORTED_KIND'
    case 'UNSUPPORTED_BUSENTRY': return 'SCHEMATIC_BUILD_UNSUPPORTED_BUSENTRY'
    case 'UNSUPPORTED_ATTR': return 'SCHEMATIC_BUILD_UNSUPPORTED_ATTR'
    case 'FRAME_FAILED': return 'SCHEMATIC_BUILD_FRAME_FAILED'
    case 'CREATE_TIMEOUT': return 'SCHEMATIC_BUILD_CREATE_TIMEOUT'
    default: return 'SCHEMATIC_BUILD_PRIMITIVE_FAILED'
  }
}

function scriptFailureMessage(failure: ScriptFailure): string {
  const target = failure.irId ?? `sheet ${failure.sheetIndex ?? '?'}`
  switch (failure.code) {
    case 'NO_DEVICE': return `component "${target}" has no deviceUuid — the live build places devices, not raw symbols`
    case 'DEVICE_NOT_FOUND': return `component "${target}": device uuid did not resolve in the workspace library`
    case 'MISSING_NET': return `primitive "${target}" has no net name`
    case 'CREATE_FAILED': return `primitive "${target}": the client create call returned undefined`
    case 'CREATE_THROWN': return `primitive "${target}": the client create call threw${failure.detail === undefined ? '' : ` (${failure.detail})`}`
    case 'CREATE_TIMEOUT': return `component "${target}": the device placement call did not return within 15s — the client is likely waiting on a dialog or a pending interactive placement; press ESC or dismiss dialogs in the EasyEDA window and rerun (a part that lands late is deduped by position)`
    case 'PAGE_CREATE_FAILED': return 'the client could not create a schematic page for this sheet'
    case 'PAGE_ACTIVATE_FAILED': return 'the created page did not become the active document — aborting instead of building into the wrong page'
    case 'UNSUPPORTED_KIND': return `component "${target}" kind "${failure.kind ?? '?'}" has no live placement path`
    case 'UNSUPPORTED_BUSENTRY': return `bus entry "${target}": no public API creates BUSENTRY primitives`
    case 'UNSUPPORTED_ATTR': return `ATTR "${target}": free-form attributes have no live placement path`
    case 'FRAME_FAILED': return `module frame "${target}": the client frame/title create call failed${failure.detail === undefined ? '' : ` (${failure.detail})`}`
    case 'CHUNK_FAILED': return `placement chunk containing "${target}" failed after retries${failure.detail === undefined ? '' : ` (${failure.detail})`}`
    default: return `primitive "${target}": build failed`
  }
}

/**
 * Page size whose height defines persisted Y for an imported sheet. A fitted
 * sheet carries its own delivered size (t17: 1510x810 instead of the requested
 * A3 1170); the imported-page read-back diff must use that height or every pin
 * on the page reads as dropped.
 */
function deliveredPageSize(sheet: SchematicIrSheet, requested?: SchematicPageSize): SchematicPageSize | undefined {
  return sheet.pageSize ?? requested
}

/**
 * Build the IR into the running EasyEDA client: precondition checks, then one
 * primitive call per placeable element, then a read-back diff of
 * `getDocumentSource()` against the intended designators and net names, then
 * optional BETA `sch_Drc` advisory detail. Findings are advisory or blocking by
 * severity; the static seam validator remains the authoritative gate.
 * @param ir - the schematic IR (already seam-validated by the caller).
 * @param options - bridge instance and build switches.
 * @returns creation count, built page uuids, and structured findings.
 */
export async function buildIntoEasyEda(ir: SchematicIr, options: EasyEdaBuildOptions): Promise<EasyEdaBuildReport> {
  const { bridge } = options
  const executeOptions = { timeoutMs: options.timeoutMs }
  const retries = options.retries ?? 2
  const backoffMs = options.retryBackoffMs ?? 500
  const batchSize = Math.max(1, options.batchSize ?? 4)
  const payload = toBuildPayload(ir, options.createDocument ?? false, options.pageSize ?? SCHEMATIC_PAGE_A4, options.frame)

  // Stage 1: preconditions and fresh activated pages. One execution only — it
  // performs no primitive placement.
  const prepared = await bridge.execute(renderPrepareScript(payload), executeOptions)
  if (!isPrepareResult(prepared)) {
    throw new SchematicError('easyeda build returned an unrecognized result shape', 'SCHEMATIC_BRIDGE_PROTOCOL')
  }
  if (prepared.status === 'NO_PROJECT') {
    throw new SchematicError('no EasyEDA project is open — open a project before building', 'SCHEMATIC_BUILD_NO_PROJECT')
  }
  if (prepared.status === 'NO_ACTIVE_PAGE' || prepared.status === 'NO_SCHEMATIC') {
    throw new SchematicError(
      `no active schematic page is available to build into (${prepared.status}); open a schematic page or enable createDocument`,
      'SCHEMATIC_BUILD_NO_ACTIVE_PAGE',
    )
  }
  if (prepared.status !== 'OK') {
    throw new SchematicError(`easyeda build precondition failed: ${prepared.status}`, 'SCHEMATIC_BUILD_PRECONDITION')
  }

  const locatorByIrId = new Map<string, SchematicLocator>()
  for (const [sheetIndex, sheet] of ir.sheets.entries()) {
    for (const component of sheet.components) {
      locatorByIrId.set(component.id, { sheetIndex, componentId: component.id, designator: component.designator })
    }
  }

  const findings: SchematicFinding[] = []
  const pushFailures = (failures: readonly ScriptFailure[]) => {
    for (const failure of failures) {
      const code = findingCode(failure.code)
      const severity = ERROR_FAILURE_CODES.has(failure.code) ? 'error' as const : 'warning' as const
      findings.push({
        code,
        severity,
        message: scriptFailureMessage(failure),
        locator: failure.irId === undefined
          ? { sheetIndex: failure.sheetIndex }
          : { sheetIndex: failure.sheetIndex, ...locatorByIrId.get(failure.irId) },
      })
    }
  }
  pushFailures(prepared.failures)

  // Stage 2: chunked placement. Parts go one per execution (each placement
  // does a catalog fetch and is the slowest step); net flags, net ports,
  // shorts, and wires go in batches. A bridge timeout does not prove the
  // client skipped the work, so retries lean on the in-page (x,y)/(net,line)
  // idempotency checks.
  let created = 0
  let chunkStreak = 0
  const runChunks = async (chunks: { script: string; irIds: string[]; sheetIndex: number }[]) => {
    for (const chunk of chunks) {
      if (chunkStreak >= 3) break
      try {
        const raw = await executeChunk(bridge, chunk.script, executeOptions, retries, backoffMs)
        chunkStreak = 0
        created += raw.created
        pushFailures(raw.failures)
      } catch (error) {
        chunkStreak += 1
        const detail = error instanceof Error ? error.message : String(error)
        pushFailures(chunk.irIds.map(irId => ({ code: 'CHUNK_FAILED', irId, sheetIndex: chunk.sheetIndex, detail })))
      }
    }
  }

  for (const [sheetIndex, sheet] of payload.sheets.entries()) {
    const pageUuid = prepared.pageUuids[sheetIndex]
    if (typeof pageUuid !== 'string') continue
    const chunks: { script: string; irIds: string[]; sheetIndex: number }[] = []
    const parts = sheet.components.filter(c => c.kind === 'part')
    const markers = sheet.components.filter(c => c.kind !== 'part' && c.kind !== 'block')
    for (const part of parts) {
      chunks.push({ script: renderComponentChunkScript([part], pageUuid, sheetIndex), irIds: [part.irId], sheetIndex })
    }
    for (let i = 0; i < markers.length; i += batchSize) {
      const batch = markers.slice(i, i + batchSize)
      chunks.push({ script: renderComponentChunkScript(batch, pageUuid, sheetIndex), irIds: batch.map(c => c.irId), sheetIndex })
    }
    for (let i = 0; i < sheet.wires.length; i += batchSize) {
      const batch = sheet.wires.slice(i, i + batchSize)
      chunks.push({ script: renderWireChunkScript(batch, pageUuid, sheetIndex), irIds: batch.map(w => w.irId), sheetIndex })
    }
    await runChunks(chunks)
    // Module frames go last so the border never shadows a placed primitive.
    // They are decoration: a chunk-level failure reports a warning, not the
    // error a dropped electrical primitive earns.
    if (sheet.blocks.length > 0) {
      try {
        const raw = await executeChunk(bridge, renderBlockChunkScript(sheet.blocks, pageUuid, sheetIndex), executeOptions, retries, backoffMs)
        pushFailures(raw.failures)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        pushFailures(sheet.blocks.map(block => ({ code: 'FRAME_FAILED', irId: `block:${block.name}`, sheetIndex, detail })))
      }
    }
    // Page border and title block: decoration like the module frames, so a
    // failure is a warning. Drawn before the module frames so the border never
    // shadows a module box.
    if (sheet.chrome.rects.length > 0 || sheet.chrome.texts.length > 0) {
      try {
        const raw = await executeChunk(bridge, renderChromeChunkScript(sheet.chrome, pageUuid, sheetIndex), executeOptions, retries, backoffMs)
        pushFailures(raw.failures)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        pushFailures([{ code: 'FRAME_FAILED', irId: 'chrome', sheetIndex, detail }])
      }
    }
    // Hierarchy blocks draw as labelled sheet-symbol boxes — non-electrical,
    // so a failure is a warning rather than a dropped electrical primitive.
    if (sheet.sheetSymbols.length > 0) {
      try {
        const raw = await executeChunk(bridge, renderSheetSymbolChunkScript(sheet.sheetSymbols, pageUuid, sheetIndex), executeOptions, retries, backoffMs)
        pushFailures(raw.failures)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        pushFailures(sheet.sheetSymbols.map(symbol => ({ code: 'FRAME_FAILED', irId: symbol.irId, sheetIndex, detail })))
      }
    }
    for (const busEntryId of sheet.busEntryIds) {
      pushFailures([{ code: 'UNSUPPORTED_BUSENTRY', irId: busEntryId, sheetIndex }])
    }
    for (const attrId of sheet.attrIds) {
      pushFailures([{ code: 'UNSUPPORTED_ATTR', irId: attrId, sheetIndex }])
    }
  }
  if (chunkStreak >= 3) {
    findings.push({
      code: 'SCHEMATIC_BUILD_ABORTED',
      severity: 'error',
      message: 'placement aborted after 3 consecutive chunk failures — the client may be busy (dialogs) or the bridge is wedged; rerun to resume',
    })
  }
  const builtPages = prepared.pageUuids
    .map((uuid, sheetIndex) => ({ uuid, sheetIndex }))
    .filter((page): page is { uuid: string; sheetIndex: number } => typeof page.uuid === 'string')
  const builtPageUuids = builtPages.map(page => page.uuid)

  // Round-trip: re-open each built page and diff its document source against
  // the intended designators and wire nets. Missing evidence is advisory —
  // the client's persisted view is what the user will actually open.
  // Read-back is verification, not delivery: a bridge failure degrades to an
  // advisory finding instead of failing a build the client already applied.
  //
  // A chunk returns once its create calls resolve on the gateway, but the
  // page-side dispatch can still be flushing the last placements — a source
  // read fired immediately after diffs a stale page. Drain the dispatch
  // queue with a no-op probe first; it only returns once every earlier
  // request finished. Then resend the read-back while the call dies on the
  // gateway's per-request budget — an array of per-page results (nulls for
  // pages that refused to open) is authoritative and ends the resend.
  const drainDeadline = Date.now() + (options.timeoutMs ?? 30_000) * 2
  let drained = false
  while (!drained && Date.now() < drainDeadline) {
    try {
      await bridge.execute('return true', { timeoutMs: 15_000 })
      drained = true
    } catch {
      await new Promise(r => setTimeout(r, 1_000))
    }
  }
  const readScript = `const sources = [];
for (const uuid of ${JSON.stringify(builtPageUuids)}) {
  const tab = await eda.dmt_EditorControl.openDocument(uuid);
  if (!tab) { sources.push(null); continue; }
  const active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
  if (!active || active.uuid !== uuid) { sources.push(null); continue; }
  sources.push(await eda.sys_FileManager.getDocumentSource());
}
return sources;`
  // Resend while the execute itself dies (gateway budget, wedged client); a
  // returned value — array or not — is authoritative and ends the resend.
  const readDeadline = Date.now() + (options.timeoutMs ?? 30_000) * 4
  let sources: unknown
  let readError: unknown
  while (Date.now() < readDeadline) {
    try {
      sources = await bridge.execute(readScript, executeOptions)
      break
    } catch (error) {
      readError = error
      if (Date.now() < readDeadline) await new Promise(r => setTimeout(r, 1_000))
    }
  }
  if (Array.isArray(sources)) {
    for (const [index, source] of sources.entries()) {
      const sheetIndex = builtPages[index]?.sheetIndex
      const sheet = sheetIndex === undefined ? undefined : ir.sheets[sheetIndex]
      if (sheet === undefined || sheetIndex === undefined) continue
      if (typeof source !== 'string') {
        findings.push({
          code: 'SCHEMATIC_ROUNDTRIP_UNAVAILABLE',
          severity: 'warning',
          message: `page ${sheetIndex + 1} document source could not be read back for verification`,
          locator: { sheetIndex },
        })
        continue
      }
      const parsed = parseDocumentSource(source)
      const attrs = readBackAttrs(parsed)
      const designators = new Set(attrs.get('Designator') ?? [])
      const texts = new Set(parsed
        .filter(r => r.type === 'TEXT' && typeof r.inner === 'object')
        .map(r => (r.inner as { value?: unknown }).value)
        .filter((v): v is string => typeof v === 'string'))
      for (const component of sheet.components) {
        // Drawn sheet symbols prove themselves by their title TEXT, not a
        // Designator ATTR.
        if (component.kind === 'block' && component.designator !== undefined && !texts.has(component.designator)) {
          findings.push({
            code: 'SCHEMATIC_ROUNDTRIP_DESIGNATOR',
            severity: 'warning',
            message: `read-back source has no sheet-symbol title "${component.designator}"`,
            locator: { sheetIndex, componentId: component.id, designator: component.designator },
          })
          continue
        }
        if (component.kind === 'part' && component.designator !== undefined && !designators.has(component.designator)) {
          findings.push({
            code: 'SCHEMATIC_ROUNDTRIP_DESIGNATOR',
            severity: 'warning',
            message: `read-back source has no Designator "${component.designator}"`,
            locator: { sheetIndex, componentId: component.id, designator: component.designator },
          })
        }
      }
      const nets = new Set(attrs.get('NET') ?? [])
      for (const wire of sheet.wires) {
        // A declaration-only wire row (no drawn geometry) keeps its ATTRs on
        // page 1 but is never drawn, so it has no NET attr to find.
        if ((wire.dots ?? []).length === 0) continue
        if (wire.net !== undefined && !nets.has(wire.net)) {
          findings.push({
            code: 'SCHEMATIC_ROUNDTRIP_NET',
            severity: 'warning',
            message: `read-back source has no NET "${wire.net}"`,
            locator: { sheetIndex, net: wire.net },
          })
        }
      }
      // The primitive build path creates one default page and persists the API
      // coordinate as `-layoutY`; the imported `.epru` path instead persists
      // `layoutY - deliveredPageHeight`. Project this path through the `-y`
      // mirror so a fitted sheet is not diffed against the requested height.
      findings.push(...diffNetlists(sheet, source, sheetIndex, options.symbolPins, options.pageSize, -1))
    }
  } else {
    findings.push({
      code: 'SCHEMATIC_ROUNDTRIP_UNAVAILABLE',
      severity: 'warning',
      message: `document sources could not be read back for verification${readError instanceof Error ? ` (${readError.message})` : ''}`,
    })
  }

  // Client oracle: primitive counts on each built page, client net names, and
  // the BETA `sch_Drc` detail. A failed oracle call degrades to advisory
  // findings — the build itself already reported what it placed.
  const oracle = await bridge.execute(
    renderOracleScript(builtPageUuids, options.advisoryDrc === true),
    executeOptions,
  ).catch(() => undefined)
  const oracleRecord = typeof oracle === 'object' && oracle !== null ? oracle as Record<string, unknown> : undefined
  if (oracleRecord === undefined) {
    findings.push({
      code: 'SCHEMATIC_EDA_ORACLE_UNAVAILABLE',
      severity: 'warning',
      message: 'client oracle did not return — counts, netlist, and DRC evidence are missing',
    })
  } else {
    const counts = Array.isArray(oracleRecord.counts) ? oracleRecord.counts : []
    // A page the build has just filled cannot legitimately report zero wires
    // while the IR declares some — the client simply has not rebuilt
    // connectivity yet, so every net/pad verdict drawn from that snapshot would
    // be a false positive. Only trust that reading when the placement stage
    // itself confirmed it created every primitive; otherwise a genuinely
    // dropped wire would hide behind the same symptom.
    // `kind: 'block'` components project to drawn sheet-symbol graphics, so
    // they are not part of the component-primitive count invariant.
    const expectedTotal = payload.sheets.reduce((total, sheet) =>
      total + sheet.components.filter(c => c.kind !== 'block').length
      + sheet.wires.filter(wire => wire.dots.length > 0).length, 0)
    const placementComplete = created >= expectedTotal
    const unready = new Set<number>()
    for (const [index, count] of counts.entries()) {
      const sheetIndex = builtPages[index]?.sheetIndex
      const sheet = sheetIndex === undefined ? undefined : ir.sheets[sheetIndex]
      if (sheet === undefined || sheetIndex === undefined) continue
      const actual = typeof count === 'object' && count !== null ? count as { components?: unknown; wires?: unknown } : undefined
      const expectedComponents = sheet.components.filter(c => c.kind !== 'block').length
      const expectedWires = payload.sheets[sheetIndex]!.wires.filter(wire => wire.dots.length > 0).length
      if (placementComplete && actual !== undefined && expectedWires > 0 && actual.wires === 0) {
        unready.add(sheetIndex)
        findings.push({
          code: 'SCHEMATIC_EDA_ORACLE_UNAVAILABLE',
          severity: 'warning',
          message: `page ${sheetIndex + 1} reports 0 wire(s) straight after placement — the client had not rebuilt connectivity yet, so its counts, netlist, and pad detail are not evidence`,
          locator: { sheetIndex },
        })
        continue
      }
      if (actual === undefined || actual.components !== expectedComponents || actual.wires !== expectedWires) {
        findings.push({
          code: 'SCHEMATIC_EDA_COUNT_MISMATCH',
          severity: 'error',
          message: `page ${sheetIndex + 1} primitive counts differ from the IR: expected ${expectedComponents} component(s)/${expectedWires} wire(s), client reports ${actual === undefined ? 'unreadable' : `${JSON.stringify(actual.components)} component(s)/${JSON.stringify(actual.wires)} wire(s)`}`,
          locator: { sheetIndex },
        })
      }
    }
    const clientNets = Array.isArray(oracleRecord.nets)
      ? new Set(oracleRecord.nets.filter((n): n is string => typeof n === 'string'))
      : undefined
    if (clientNets === undefined) {
      findings.push({
        code: 'SCHEMATIC_EDA_NETLIST_UNAVAILABLE',
        severity: 'warning',
        message: `client net names could not be read for reconciliation${typeof oracleRecord.netsError === 'string' ? ` (${oracleRecord.netsError})` : ''}`,
      })
    } else {
      for (const [sheetIndex, sheet] of ir.sheets.entries()) {
        if (unready.has(sheetIndex)) continue
        // Declaration-only rows keep every authored wire on page 1 but never
        // reach the client netlist, so they must not be reconciled as names.
        for (const net of new Set(sheet.wires
          .filter(w => (w.dots ?? []).length > 0)
          .map(w => w.net)
          .filter((n): n is string => n !== undefined))) {
          if (!clientNets.has(net)) {
            findings.push({
              code: 'SCHEMATIC_EDA_NET_MISMATCH',
              severity: 'error',
              message: `client netlist has no net "${net}"`,
              locator: { sheetIndex, net },
            })
          }
        }
      }
    }
    // Pad-level reconciliation. Net *names* cannot see a wire that lands on
    // the wrong pin of the right part — a mirrored pin endpoint keeps every
    // name intact while wiring the design incorrectly — so when the oracle
    // reports per-net pads, every IR pin's `DESIGNATOR-PIN` must appear on its
    // declared net and nothing else of that part may. Pads belonging to other
    // pages of the same project are ignored: the client netlist is
    // project-wide while the IR document is one page.
    const padMap = typeof oracleRecord.netPads === 'object' && oracleRecord.netPads !== null
      ? oracleRecord.netPads as Record<string, unknown>
      : undefined
    if (padMap !== undefined) {
      for (const [sheetIndex, sheet] of ir.sheets.entries()) {
        if (unready.has(sheetIndex)) continue
        // Scope the designator filter to this sheet. Designators can repeat
        // across pages, so a project-wide set would accept a pad from a sibling
        // page as "belonging" here and report a false mismatch.
        const designatorsInSheet = new Set<string>()
        for (const component of sheet.components) {
          if (component.designator !== undefined) designatorsInSheet.add(component.designator)
        }
        const expected = new Map<string, Set<string>>()
        for (const component of sheet.components) {
          for (const pin of component.pins) {
            if (pin.net === undefined || pin.number === undefined || component.designator === undefined) continue
            const pads = expected.get(pin.net) ?? new Set<string>()
            pads.add(`${component.designator}-${pin.number}`)
            expected.set(pin.net, pads)
          }
        }
        for (const [net, wanted] of expected) {
          const raw = padMap[net]
          if (!Array.isArray(raw)) continue
          const reported = new Set<string>()
          for (const entry of raw) {
            if (typeof entry !== 'string') continue
            const cut = entry.lastIndexOf('-')
            if (cut <= 0 || !designatorsInSheet.has(entry.slice(0, cut))) continue
            reported.add(entry)
          }
          const missing = [...wanted].filter(pad => !reported.has(pad))
          const extra = [...reported].filter(pad => !wanted.has(pad))
          if (missing.length === 0 && extra.length === 0) continue
          findings.push({
            code: 'SCHEMATIC_EDA_NET_PAD_MISMATCH',
            severity: 'error',
            message: `client netlist for "${net}" lands on the wrong pins: missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`,
            locator: { sheetIndex, net },
            suggestion: 'a wire or flag sits on a neighbouring pin — check the pin-endpoint convention of the bound symbol geometry',
          })
        }
      }
    }
    if (options.advisoryDrc === true) {
      if (Array.isArray(oracleRecord.drc)) {
        for (const detail of oracleRecord.drc) {
          const record = typeof detail === 'object' && detail !== null ? detail as Record<string, unknown> : undefined
          const rule = typeof record?.rule === 'string' && record.rule !== '' ? record.rule : undefined
          const type = typeof record?.type === 'string' ? record.type : undefined
          const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
          if (type === 'fatalError' || rule === undefined) {
            findings.push({
              code: 'SCHEMATIC_EDA_ABNORMAL_DATA',
              severity: 'error',
              message: `client DRC reports corrupted document data: ${text}`,
            })
          } else if (rule === 'CHECKFLOATPIN') {
            // A pin the IR declares `noConnect` is *meant* to float; the client
            // has no such notion, so it reports it like any other open pin.
            const noConnect = new Set<string>()
            for (const component of ir.sheets.flatMap(sheet => sheet.components)) {
              for (const pin of component.pins) {
                if (pin.noConnect === true && component.designator !== undefined && pin.number !== undefined) {
                  noConnect.add(`${component.designator}-${pin.number}`)
                }
              }
            }
            const primitives = Array.isArray(record?.primitives) ? record.primitives : undefined
            const unexpected = primitives === undefined
              ? undefined
              : primitives.filter((primitive) => {
                const item = typeof primitive === 'object' && primitive !== null ? primitive as Record<string, unknown> : undefined
                const designator = typeof item?.designator === 'string' ? item.designator : undefined
                const pinNumber = typeof item?.name === 'string' ? item.name : undefined
                if (designator === undefined || pinNumber === undefined) return true
                return !noConnect.has(`${designator}-${pinNumber}`)
              })
            if (unexpected !== undefined && unexpected.length === 0) continue
            findings.push({
              code: 'SCHEMATIC_EDA_FLOATING_PIN',
              severity: 'error',
              message: `client DRC: floating pin — ${unexpected === undefined ? text : JSON.stringify({ ...record, primitives: unexpected })}`,
            })
          } else if (rule === 'SHOWFLOATING') {
            findings.push({
              code: 'SCHEMATIC_EDA_FLOATING_NET',
              severity: 'warning',
              message: `client DRC: floating net — ${text}`,
            })
          } else {
            findings.push({
              code: 'SCHEMATIC_EDA_DRC',
              severity: 'warning',
              message: `client DRC: ${text}`,
            })
          }
        }
      } else {
        findings.push({
          code: 'SCHEMATIC_EDA_DRC_UNAVAILABLE',
          severity: 'warning',
          message: `client DRC did not return detail (${typeof oracleRecord.drcError === 'string' ? oracleRecord.drcError : 'unexpected result'})`,
        })
      }
    }
  }

  return { created, pageUuids: builtPageUuids, findings }
}

/** Library documents resolved for one `.epro2` import package. */
export interface EasyEdaImportLibrary {
  /** Embedded `DEVICE`/`SYMBOL`/`FOOTPRINT` copies for the serializer. */
  readonly library: EasyEdaProjectLibrary
  /** Per-binding fetch failures; affected components keep library uuids. */
  readonly findings: readonly SchematicFinding[]
}

const hex16 = (): string => randomUUID().replaceAll('-', '').slice(0, 16)

function maxTicket(source: string): number {
  let max = 0
  for (const match of source.matchAll(/"ticket":(\d+)/g)) max = Math.max(max, Number(match[1]))
  return max
}

/**
 * Rewrite a fetched library document into a project-local copy: fresh
 * `DOCHEAD` uuid plus a `META` record pointing back at the library origin,
 * matching the shape real exports persist (`source` = `<uuid>|<library>`).
 */
function localizeLibraryDoc(source: string, localUuid: string, meta: Record<string, unknown>): string {
  const lines = source.split('\n').filter(line => line !== '')
  const head = lines[0]
  if (head === undefined) return source
  const rewritten = head
    .replace(/"uuid":"[^"]*"/, `"uuid":"${localUuid}"`)
    .replace(/"user":\{[^}]*\}/, `"user":{"uuid":"${localUuid}"}`)
  const metaLine = `{"type":"META","ticket":${maxTicket(source) + 1},"id":"META"}||${JSON.stringify(meta)}|`
  return [rewritten, ...lines.slice(1), metaLine].join('\n')
}
/**
 * Fetch every distinct component binding's `DEVICE`/`SYMBOL`/`FOOTPRINT`
 * document through the bridge and localize the copies for embedding. Device
 * associations pull in their own symbol/footprint documents so the
 * synthesized `DEVICE` attributes resolve too. Components whose fetch fails
 * keep their library uuids and report a `SCHEMATIC_IMPORT_LIBDOC` warning —
 * the client renders them as unresolved boxes, which the finding names.
 * @param ir - the schematic IR to collect bindings from.
 * @param bridge - a connected bridge into the running client.
 * @param timeoutMs - per-call timeout override for the library batch.
 * @returns embedded docs for {@link serializeEasyEdaProject} and findings.
 */
export async function collectProjectLibrary(
  ir: SchematicIr,
  bridge: EasyEdaBridge,
  timeoutMs?: number,
): Promise<EasyEdaImportLibrary> {
  const wanted: { devices: Record<string, string>; symbols: Record<string, string>; footprints: Record<string, string> } = {
    devices: {}, symbols: {}, footprints: {},
  }
  const flagQueries: { id: string; queries: string[] }[] = []
  for (const sheet of ir.sheets) {
    for (const component of sheet.components) {
      if (component.deviceUuid !== undefined) wanted.devices[component.deviceUuid] ??= component.deviceLibraryUuid ?? ''
      if (component.symbolUuid !== undefined) wanted.symbols[component.symbolUuid] ??= component.symbolLibraryUuid ?? ''
      if (component.footprintUuid !== undefined) wanted.footprints[component.footprintUuid] ??= component.footprintLibraryUuid ?? ''
      if (component.deviceUuid === undefined && component.netName !== undefined) {
        if (component.kind === 'netport') {
          flagQueries.push({ id: component.id, queries: ['Netport'] })
        } else if (component.kind === 'netflag') {
          flagQueries.push({
            id: component.id,
            queries: /^(GND|AGND|DGND|PGND|PE|GROUND|EARTH)/i.test(component.netName)
              ? ['Ground-GND', 'GND']
              : [`Power-${component.netName}`, 'Power-VCC'],
          })
        }
      }
    }
  }
  const raw = await bridge.execute(`
const sysLib = await eda.lib_LibrariesList.getSystemLibraryUuid().catch(() => undefined)
const wanted = ${JSON.stringify(wanted)}
const flagQueries = ${JSON.stringify(flagQueries)}
const scopeOf = (s) => s || sysLib
const getWith = async (api, uuid, scope) => {
  try { return await eda[api].get(uuid, scopeOf(scope)) }
  catch (e) { try { return await eda[api].get(uuid, undefined) } catch (e2) { return undefined } }
}
const srcWith = async (api, uuid, scope) => {
  try { return await eda[api].getDocumentSource(uuid, scopeOf(scope)) }
  catch (e) { try { return await eda[api].getDocumentSource(uuid, undefined) } catch (e2) { return undefined } }
}
const out = { devices: {}, symbols: {}, footprints: {}, flags: {}, errors: [] }
// Flags bind a name-specific flag device ('Ground-GND', 'Power-VCC', 'Netport')
// rather than a part binding; search resolves the device, its association
// supplies the flag symbol, and both feed the normal doc pipeline.
for (const f of flagQueries) {
  for (const q of f.queries) {
    const hits = await eda.lib_Device.search(q, sysLib).catch(() => undefined)
    const hit = Array.isArray(hits) ? hits.find(h => typeof h?.uuid === 'string') : undefined
    if (hit === undefined) continue
    const info = await getWith('lib_Device', hit.uuid, sysLib)
    if (info === undefined) continue
    const symUuid = info.association?.symbolUuid ?? info.association?.symbol?.uuid
    out.flags[f.id] = { device: hit.uuid, symbol: symUuid }
    wanted.devices[hit.uuid] = sysLib
    if (typeof symUuid === 'string' && symUuid !== '') wanted.symbols[symUuid] = sysLib
    break
  }
}
for (const [uuid, scope] of Object.entries(wanted.devices)) {
  const info = await getWith('lib_Device', uuid, scope)
  if (info === undefined) { out.errors.push({ kind: 'device', uuid }); continue }
  out.devices[uuid] = { info, scope: scopeOf(scope) }
  const assoc = info.association ?? {}
  const symUuid = assoc.symbolUuid ?? assoc.symbol?.uuid
  const fpUuid = assoc.footprintUuid ?? assoc.footprint?.uuid
  if (typeof symUuid === 'string' && symUuid !== '' && !(symUuid in wanted.symbols)) wanted.symbols[symUuid] = assoc.symbol?.libraryUuid ?? scope
  if (typeof fpUuid === 'string' && fpUuid !== '' && !(fpUuid in wanted.footprints)) wanted.footprints[fpUuid] = assoc.footprint?.libraryUuid ?? scope
}
for (const [uuid, scope] of Object.entries(wanted.symbols)) {
  const info = await getWith('lib_Symbol', uuid, scope)
  const source = await srcWith('lib_Symbol', uuid, scope)
  if (info === undefined || source === undefined) { out.errors.push({ kind: 'symbol', uuid }); continue }
  out.symbols[uuid] = { info, source, scope: scopeOf(scope) }
}
for (const [uuid, scope] of Object.entries(wanted.footprints)) {
  const info = await getWith('lib_Footprint', uuid, scope)
  const source = await srcWith('lib_Footprint', uuid, scope)
  if (info === undefined || source === undefined) { out.errors.push({ kind: 'footprint', uuid }); continue }
  out.footprints[uuid] = { info, source, scope: scopeOf(scope) }
}
return out
`, { timeoutMs }) as {
    devices?: Record<string, { info?: Record<string, unknown>; scope?: string }>
    symbols?: Record<string, { info?: Record<string, unknown>; source?: string; scope?: string }>
    footprints?: Record<string, { info?: Record<string, unknown>; source?: string; scope?: string }>
    flags?: Record<string, { device?: string; symbol?: string }>
    errors?: { kind?: string; uuid?: string }[]
  }

  const symbols: EasyEdaEmbeddedDoc[] = []
  const footprints: EasyEdaEmbeddedDoc[] = []
  const devices: EasyEdaEmbeddedDoc[] = []
  const localDevice = new Map<string, EasyEdaEmbeddedDoc>()
  const localSymbol = new Map<string, EasyEdaEmbeddedDoc>()
  const localFootprint = new Map<string, EasyEdaEmbeddedDoc>()
  const partIdOf = (info: Record<string, unknown> | undefined, source: string): string | undefined => {
    const names = info?.subPartNames
    // Frame symbols report an empty first sub-part name but still carry a real
    // `PART` id in their source; an empty name must not win over that id.
    if (Array.isArray(names) && typeof names[0] === 'string' && names[0] !== '') return names[0]
    return source.match(/"type":"PART"[^|]*"id":"([^"]+)"/)?.[1]
  }
  const meta = (info: Record<string, unknown> | undefined) => ({
    title: typeof info?.name === 'string' ? info.name : '',
    description: typeof info?.description === 'string' ? info.description : '',
    tags: Array.isArray(info?.classification) ? info.classification : [],
  })
  for (const [uuid, entry] of Object.entries(raw.symbols ?? {})) {
    if (typeof entry.source !== 'string') continue
    const localUuid = hex16()
    // Symbol kinds are typed in the library (2 part, 18 netflag, 19 netport);
    // the embedded META must mirror the real type or the client reports invalid
    // symbol data on annotation primitives.
    const doc: EasyEdaEmbeddedDoc = {
      sourceUuid: uuid,
      localUuid,
      source: localizeLibraryDoc(entry.source, localUuid, {
        ...meta(entry.info),
        docType: typeof entry.info?.type === 'number' ? entry.info.type : 2,
        source: `${uuid}|${entry.scope ?? ''}`,
      }),
      title: meta(entry.info).title,
      partId: partIdOf(entry.info, entry.source),
    }
    symbols.push(doc)
    localSymbol.set(uuid, doc)
  }
  for (const [uuid, entry] of Object.entries(raw.footprints ?? {})) {
    if (typeof entry.source !== 'string') continue
    const localUuid = hex16()
    const doc: EasyEdaEmbeddedDoc = {
      sourceUuid: uuid,
      localUuid,
      title: meta(entry.info).title,
      source: localizeLibraryDoc(entry.source, localUuid, {
        ...meta(entry.info),
        source: `${uuid}|${entry.scope ?? ''}`,
      }),
    }
    footprints.push(doc)
    localFootprint.set(uuid, doc)
  }
  for (const [uuid, entry] of Object.entries(raw.devices ?? {})) {
    const info = entry.info ?? {}
    const association = (typeof info.association === 'object' && info.association !== null ? info.association : {}) as Record<string, unknown>
    const property = (typeof info.property === 'object' && info.property !== null ? info.property : {}) as Record<string, unknown>
    const other = (typeof property.otherProperty === 'object' && property.otherProperty !== null ? property.otherProperty : {}) as Record<string, unknown>
    const pickUuid = (value: unknown): string | undefined =>
      typeof value === 'string' && value !== '' ? value : undefined
    const assocSym = pickUuid(association.symbolUuid) ?? pickUuid((association.symbol as Record<string, unknown> | undefined)?.uuid)
    const assocFp = pickUuid(association.footprintUuid) ?? pickUuid((association.footprint as Record<string, unknown> | undefined)?.uuid)
    const sym = assocSym === undefined ? undefined : localSymbol.get(assocSym)
    const fp = assocFp === undefined ? undefined : localFootprint.get(assocFp)
    const localUuid = hex16()
    const model3d = other['3D Model']
    const doc: EasyEdaEmbeddedDoc = {
      sourceUuid: uuid,
      localUuid,
      source: [
        `{"type":"DOCHEAD","ticket":1}||{"docType":"DEVICE","client":"dsh","uuid":"${localUuid}","updateTime":1,"version":"1","editVersion":"4.1.71","user":{"uuid":"${localUuid}"}}|`,
        `{"type":"META","ticket":2,"id":"META"}||${JSON.stringify({
          title: typeof info.name === 'string' ? info.name : '',
          tags: Array.isArray(info.classification) ? info.classification : [],
          source: `${uuid}|${entry.scope ?? ''}`,
          images: Array.isArray(association.images) ? association.images : [],
          attributes: {
            ...other,
            ...(typeof model3d === 'string' && !model3d.includes('|') ? { '3D Model': `${model3d}|${entry.scope ?? ''}` } : {}),
            ...(sym === undefined ? {} : { Symbol: sym.localUuid }),
            ...(fp === undefined ? {} : { Footprint: fp.localUuid }),
            ...(sym === undefined ? {} : { SymbolName: JSON.stringify({ name: sym.title, uuid: sym.localUuid, source: '' }) }),
            ...(fp === undefined ? {} : { FootprintName: JSON.stringify({ name: fp.title, uuid: fp.localUuid, source: '' }) }),
          },
        })}|`,
      ].join('\n'),
    }
    devices.push(doc)
    localDevice.set(uuid, doc)
  }
  const flags = new Map<string, { device: EasyEdaEmbeddedDoc; symbol: EasyEdaEmbeddedDoc }>()
  for (const [componentId, binding] of Object.entries(raw.flags ?? {})) {
    const device = typeof binding.device === 'string' ? localDevice.get(binding.device) : undefined
    const symbol = typeof binding.symbol === 'string' ? localSymbol.get(binding.symbol) : undefined
    if (device !== undefined && symbol !== undefined) flags.set(componentId, { device, symbol })
  }
  const findings: SchematicFinding[] = (raw.errors ?? []).map(error => ({
    code: 'SCHEMATIC_IMPORT_LIBDOC',
    severity: 'warning' as const,
    message: `${error.kind ?? 'library'} document ${error.uuid ?? '?'} could not be fetched; components bound to it render as unresolved boxes`,
  }))
  return { library: { devices, symbols, footprints, flags }, findings }
}

/** Options for {@link importIntoEasyEda}. */
export interface EasyEdaImportOptions {
  /** Bridge to execute code inside EasyEDA; inject a mock in tests. */
  readonly bridge: EasyEdaBridge
  /** Friendly name of the imported project; defaults to `DSH Schematic`. */
  readonly projectName?: string | undefined
  /** Eventual-consistency client tag written into each `DOCHEAD`. */
  readonly clientId?: string | undefined
  /**
   * Allow closing every open document tab in the current project to satisfy
   * `openProject`. Defaults to `false` — the fallback mutates the user's
   * editor layout, so it is opt-in rather than unconditional.
   */
  readonly allowTabClose?: boolean | undefined
  /**
   * Pin geometry per bound symbol UUID (the `symbolPins` snapshot from
   * `resolveBindings`); reconciles pin endpoints against real symbol pins
   * during the read-back diff — see {@link EasyEdaBuildOptions.symbolPins}.
   */
  readonly symbolPins?: ReadonlyMap<string, readonly SchematicSymbolPin[]> | undefined
  /**
   * Page frame the serialized module frames clamp into. Defaults to A4; pass
   * the size the layout stage planned against (e.g. `SCHEMATIC_PAGE_A3`).
   */
  readonly pageSize?: SchematicPageSize | undefined
  /**
   * Sheet border/title-block metadata. Defaults to a frame titled with the
   * project name; pass custom fields (version/company/date) to override.
   */
  readonly frame?: EasyEdaSheetFrameOptions | undefined
  /** Per-call timeout override for the bridge execution, in milliseconds. */
  readonly timeoutMs?: number | undefined
}

/** Structured outcome of one `.epro2` project import. */
export interface EasyEdaImportReport {
  /** Uuid of the imported project. */
  readonly projectUuid: string
  /** Page uuids the importer attached to the schematic, in sheet order where known. */
  readonly pageUuids: readonly string[]
  /** Import and round-trip findings for routing back to the model. */
  readonly findings: readonly SchematicFinding[]
}

/**
 * Render the in-client body that packs `project2.json` + `*.epru` into a
 * store-method zip and hands it to
 * `sys_FileManager.importProjectByProjectFile` (BETA). The script returns as
 * soon as the import call resolves: the client auto-opens the new project,
 * and while that switch is in flight every `eda.*` call serializes behind
 * it — the caller drains the dispatch queue and confirms identity through
 * {@link renderImportReadbackScript} instead.
 * @param pkg - the serialized project payload.
 * @param projectName - friendly name of the imported project.
 * @returns the JavaScript body to pass to {@link EasyEdaBridge.execute}.
 */
export function renderImportScript(pkg: EasyEdaProjectPackage, projectName: string): string {
  return `const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t })();
const crc32 = (bytes) => { let c = 0xFFFFFFFF; for (const b of bytes) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 };
const enc = new TextEncoder();
// Race an eda.* call against a soft deadline: a hung client-side API must not
// stall this script past the gateway's request budget.
const raced = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);
const zipEntries = [['project2.json', ${JSON.stringify(pkg.projectJson)}], ['dsh-import.epru', ${JSON.stringify(pkg.epru)}]];
const chunks = []; const central = []; let offset = 0;
for (const [name, content] of zipEntries) {
  const nameB = enc.encode(name); const data = enc.encode(content); const crc = crc32(data);
  const lh = new DataView(new ArrayBuffer(30));
  lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, 0, true);
  lh.setUint16(10, 0, true); lh.setUint16(12, 0, true); lh.setUint32(14, crc, true);
  lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
  lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
  chunks.push(new Uint8Array(lh.buffer), nameB, data);
  const cd = new DataView(new ArrayBuffer(46));
  cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
  cd.setUint16(8, 0, true); cd.setUint16(10, 0, true); cd.setUint16(12, 0, true); cd.setUint16(14, 0, true);
  cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
  cd.setUint16(28, nameB.length, true); cd.setUint32(42, offset, true);
  central.push(new Uint8Array(cd.buffer), nameB);
  offset += 30 + nameB.length + data.length;
}
const cdStart = offset; const cdBytes = central.reduce((s, c) => s + c.length, 0);
const eo = new DataView(new ArrayBuffer(22));
eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, zipEntries.length, true); eo.setUint16(10, zipEntries.length, true);
eo.setUint32(12, cdBytes, true); eo.setUint32(16, cdStart, true);
chunks.push(...central, new Uint8Array(eo.buffer));
let team;
try {
  const teams = (await eda.dmt_Team.getAllTeamsInfo()) || [];
  // A logged-out client can answer with a non-empty array whose first slot is
  // null (or a team proxy whose uuid getter itself dereferences null). Guard
  // the element access, not just the array length, so the caller gets the
  // actionable NO_TEAM status instead of an opaque TypeError.
  team = teams.find(entry => {
    try { return entry && typeof entry.uuid === 'string' } catch (e) { return false }
  });
} catch (e) { team = undefined }
// A logged-out client can still expose a syntactically valid team entry while
// its current-team state is null; the import API then dereferences that null
// internally. Probe the active team too, inside the same bounded race used by
// every other client call in this script, and reject a null/malformed answer.
try {
  const active = await raced(eda.dmt_Team.getCurrentTeamInfo(), 3000)
  if (!active || typeof active.uuid !== 'string') team = undefined
} catch (e) { team = undefined }
if (!team) return { status: 'NO_TEAM' };
// Same-name projects collide in the workspace; pick a free suffix upfront.
// The scan reads every workspace project name serially — unbounded, that
// alone outlives the request budget on a large workspace (or wedges the
// gateway queue when one getProjectInfo hangs), so every call is raced and
// the whole scan is capped; a missed name only risks a cosmetic duplicate,
// since the import itself is uuid-keyed.
let projectName = ${JSON.stringify(projectName)};
try {
  const uuids = await raced(eda.dmt_Project.getAllProjectsUuid(team.uuid), 5000) || [];
  const names = new Set();
  const deadline = Date.now() + 6000;
  for (let i = 0; i < uuids.length && Date.now() < deadline; i += 8) {
    await Promise.all(uuids.slice(i, i + 8).map(async (u) => {
      const info = await raced(eda.dmt_Project.getProjectInfo(u), 1200);
      const n = info && (info.name ?? info.friendlyName);
      if (typeof n === 'string') names.add(n);
      // Project names can come back owner-prefixed ("owner/name"); the import
      // option takes the bare name, so collide on the basename too.
      if (typeof n === 'string' && n.includes('/')) names.add(n.slice(n.lastIndexOf('/') + 1));
    }));
  }
  for (let attempt = 1; names.has(projectName) && attempt < 20; attempt++) {
    projectName = ${JSON.stringify(projectName)} + ' v' + (attempt + 1);
  }
} catch (e) {}
const file = new File([new Blob(chunks)], 'dsh-import.epro2', { type: 'application/octet-stream' });
let project;
try {
  project = await raced(eda.sys_FileManager.importProjectByProjectFile(file, 'JLCEDA Pro', undefined, {
    operation: 'New Project',
    newProjectOwnerTeamUuid: team.uuid,
    newProjectName: projectName,
    newProjectFriendlyName: projectName,
  }), 20000);
} catch (e) {
  // A logged-out client can throw inside the import API while it dereferences
  // its missing team/project state. Return it as data so the host can turn an
  // opaque gateway 500 into an actionable sign-in/select-team message.
  return { status: 'IMPORT_THROWN', detail: String(e && e.message ? e.message : e) };
}
if (!project) return { status: 'IMPORT_REJECTED' };
// The client auto-opens the freshly imported project, and while that switch
// is in flight every eda.* call serializes behind it — on a slow client the
// open outlives the whole request budget. Return now: the host drains the
// dispatch queue with no-op probes and the read-back stage confirms the
// project identity. project can lack a uuid while the import still lands,
// so the identity may have to be resolved by name later.
return { status: 'OK', projectUuid: project.uuid ?? null, projectName };`
}

/**
 * Render the read-back stage of an import as a standalone client script —
 * the gateway bounds a single execute to ~30s, so project-identity
 * confirmation, page enumeration, and per-page source reads run as their
 * own request after the import stage lands and the dispatch queue drains.
 * Only pages emitted by the archive count: enumerating without scoping can
 * return the previously open project's documents, and diffing the IR
 * against a foreign document produces false netlist findings.
 * @param pageUuids - page uuids this archive emitted (`pkg.pageUuids`).
 * @param projectUuid - uuid returned by the import call, or null when the
 * client resolved the import without one (matched by `projectName` then).
 * @param projectName - the name the import stage actually used.
 * @param allowTabClose - whether openProject may close the current
 * project's open document tabs when the client refuses to switch.
 * @returns the script text for `bridge.execute`.
 */
export function renderImportReadbackScript(
  pageUuids: readonly string[],
  projectUuid: string | null,
  projectName: string,
  allowTabClose = false,
): string {
  return `const raced = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);
const expectedPages = ${JSON.stringify(pageUuids)};
const wantedUuid = ${JSON.stringify(projectUuid)};
const wantedName = ${JSON.stringify(projectName)};
const isOurs = (p) => p && (p.uuid === wantedUuid || (wantedUuid === null && p.name === wantedName));
// Confirm the auto-opened project is ours; a refused switch falls back to
// explicit openProject after closing document tabs under allowTabClose.
let current = null;
for (let i = 0; i < 4 && !isOurs(current); i++) {
  current = await raced(eda.dmt_Project.getCurrentProjectInfo(), 5000);
  if (!isOurs(current)) await new Promise(r => setTimeout(r, 1000));
}
let opened = isOurs(current);
let openTabs = 0;
if (!opened) {
  const tabIds = [];
  const walkTabs = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walkTabs);
    if (typeof n.tabId === 'string') tabIds.push(n.tabId);
    for (const k in n) walkTabs(n[k]);
  };
  walkTabs(await raced(eda.dmt_EditorControl.getSplitScreenTree(), 4000));
  openTabs = tabIds.length;
  if (${allowTabClose ? 'true' : 'false'}) {
    for (const t of tabIds) await raced(eda.dmt_EditorControl.closeDocument(t), 4000);
  }
  if (wantedUuid !== null) {
    opened = await raced(eda.dmt_Project.openProject(wantedUuid), 8000) === true;
    current = await raced(eda.dmt_Project.getCurrentProjectInfo(), 4000);
    opened = opened || isOurs(current);
  }
}
if (!opened) return { status: 'OPEN_FAILED', openTabs };
const pages = [];
for (let attempt = 0; attempt < 20 && pages.length < expectedPages.length; attempt++) {
  const all = await raced(eda.dmt_Schematic.getAllSchematicPagesInfo(), 4000) || [];
  for (const u of expectedPages) if (!pages.includes(u) && all.some(p => p.uuid === u)) pages.push(u);
  if (pages.length < expectedPages.length) await new Promise(r => setTimeout(r, 500));
}
const sources = [];
for (const uuid of pages) {
  await raced(eda.dmt_EditorControl.openDocument(uuid), 8000);
  const active = await raced(eda.dmt_Schematic.getCurrentSchematicPageInfo(), 4000);
  if (!active || active.uuid !== uuid) { sources.push(null); continue; }
  sources.push(await raced(eda.sys_FileManager.getDocumentSource(), 8000));
}
return { status: 'OK', projectUuid: current && current.uuid, pageUuids: pages, sources };`
}

/**
 * Import the IR as a new project through `importProjectByProjectFile` (BETA):
 * the IR is serialized to `CONFIG`/`SCH`/`SCH_PAGE` logs in the client's
 * persisted schema together with project-local copies of every referenced
 * `DEVICE`/`SYMBOL`/`FOOTPRINT` document (the client renders components as
 * empty boxes without them), zipped as `.epro2`, imported, then every
 * attached page is read back for a name/net round-trip diff.
 * @param ir - the schematic IR (already seam-validated by the caller).
 * @param options - bridge instance, project name, tab-close consent, and
 * client tag.
 * @returns imported project uuid, page uuids, and structured findings.
 */
export async function importIntoEasyEda(ir: SchematicIr, options: EasyEdaImportOptions): Promise<EasyEdaImportReport> {
  // A no-op execute used to detect that the client's serialized dispatch
  // queue has drained after the import triggered an automatic project open.
  const IMPORT_DRAIN_PROBE = 'return true'
  const { bridge } = options
  const projectName = options.projectName ?? 'DSH Schematic'
  const pageSize = options.pageSize ?? SCHEMATIC_PAGE_A4
  const collected = await collectProjectLibrary(ir, bridge, options.timeoutMs)
    .catch((error: unknown) => ({
      library: { devices: [], symbols: [], footprints: [] },
      findings: [{
        code: 'SCHEMATIC_IMPORT_LIBDOC',
        severity: 'warning' as const,
        message: `project-library collection failed (${error instanceof Error ? error.message : String(error)}); components render as unresolved boxes`,
      }],
    }))
  const pkg = serializeEasyEdaProject(ir, {
    clientId: options.clientId,
    title: projectName,
    library: collected.library,
    pageSize,
    frame: options.frame ?? { projectTitle: projectName },
  })
  const raw = await bridge.execute(
    renderImportScript(pkg, projectName),
    { timeoutMs: options.timeoutMs },
  ) as { status?: string, detail?: string, projectUuid?: string | null, projectName?: string }
  if (raw.status === 'NO_TEAM') {
    throw new SchematicError(
      'no team resolved for the import destination — if the editor is logged out or has no active team, sign in, select a team, and retry',
      'SCHEMATIC_IMPORT_NO_TEAM',
    )
  }
  if (raw.status === 'IMPORT_THROWN') {
    throw new SchematicError(
      `EasyEDA import failed before creating the project: ${raw.detail ?? 'client error'} — if the editor is logged out or has no active team, sign in, select a team, and retry`,
      'SCHEMATIC_IMPORT_FAILED',
    )
  }
  if (raw.status !== 'OK') {
    throw new SchematicError('the client rejected the generated project package', 'SCHEMATIC_IMPORT_REJECTED')
  }

  // The client auto-opens the imported project and serializes every later
  // in-page call behind that switch; a slow open outlives the per-request
  // gateway budget, so drain the dispatch queue with no-op probes — a probe
  // only returns once every request ahead of it finished.
  const projectUuid = typeof raw.projectUuid === 'string' ? raw.projectUuid : null
  const openWaitMs = (options.timeoutMs ?? 30_000) * 8
  const openDeadline = Date.now() + openWaitMs
  let drained = false
  while (!drained && Date.now() < openDeadline) {
    try {
      await bridge.execute(IMPORT_DRAIN_PROBE, { timeoutMs: 15_000 })
      drained = true
    } catch {
      // The probe is still queued behind the project switch — retry.
      await new Promise(r => setTimeout(r, 1_000))
    }
  }
  // Draining only proves the dispatch queue emptied; the project open is a
  // client-side action that can still be in flight, and a read-back sent too
  // early dies on the gateway's per-request budget (HTTP 500/timeout). Resend
  // the same script inside the open budget until one attempt completes.
  let readBack: { status?: string, projectUuid?: string, openTabs?: number, pageUuids?: string[], sources?: (string | null)[] } | undefined
  if (drained) {
    const script = renderImportReadbackScript(pkg.pageUuids, projectUuid, raw.projectName ?? projectName, options.allowTabClose === true)
    while (readBack === undefined && Date.now() < openDeadline) {
      try {
        readBack = await bridge.execute(script, { timeoutMs: options.timeoutMs }) as typeof readBack
      } catch {
        await new Promise(r => setTimeout(r, 1_000))
      }
    }
  }
  if (readBack === undefined || readBack.status === 'OPEN_FAILED') {
    return {
      projectUuid: projectUuid ?? '',
      pageUuids: [],
      findings: [{
        code: 'SCHEMATIC_IMPORT_OPEN_FAILED',
        severity: 'error',
        message: readBack === undefined
          ? `project imported but the client did not finish opening it within ${openWaitMs}ms — read-back skipped`
          : `project imported but the client refused to open it` +
            (typeof readBack.openTabs === 'number' && readBack.openTabs > 0 && options.allowTabClose !== true
              ? ` — ${readBack.openTabs} document tab(s) block the project switch; set allowTabClose to close them, or close them in the editor`
              : ' — read-back skipped so no foreign document is diffed'),
      }],
    }
  }
  const pageUuids = Array.isArray(readBack.pageUuids) ? readBack.pageUuids : []
  const sources = Array.isArray(readBack.sources) ? readBack.sources : []

  const findings: SchematicFinding[] = [...collected.findings]
  if (typeof raw.projectName === 'string' && raw.projectName !== projectName) {
    findings.push({
      code: 'SCHEMATIC_IMPORT_RENAMED',
      severity: 'warning',
      message: `project name "${projectName}" was already taken; imported as "${raw.projectName}"`,
    })
  }
  if (pageUuids.length < ir.sheets.length) {
    findings.push({
      code: 'SCHEMATIC_IMPORT_PAGE_LOST',
      severity: 'error',
      message: `importer attached ${pageUuids.length} of ${ir.sheets.length} sheets`,
    })
  }
  for (const [index, source] of sources.entries()) {
    const sheet = ir.sheets[index]
    if (sheet === undefined) break
    if (typeof source !== 'string') {
      findings.push({ code: 'SCHEMATIC_IMPORT_READBACK', severity: 'warning', message: `imported page ${index + 1} source could not be read back`, locator: { sheetIndex: index } })
      continue
    }
    const parsed = parseDocumentSource(source)
    const attrs = readBackAttrs(parsed)
    const names = new Set([...(attrs.get('Designator') ?? []), ...(attrs.get('Name') ?? []), ...(attrs.get('NET') ?? [])])
    // Drawn sheet symbols persist their title as a TEXT record, not an ATTR.
    for (const record of parsed) {
      if (record.type === 'TEXT' && typeof record.inner === 'object') {
        const value = (record.inner as { value?: unknown }).value
        if (typeof value === 'string') names.add(value)
      }
    }
    for (const component of sheet.components) {
      const expected = component.designator ?? component.netName
      if (expected !== undefined && !names.has(expected)) {
        findings.push({
          code: 'SCHEMATIC_IMPORT_DESIGNATOR',
          severity: 'warning',
          message: `imported page ${index + 1} source has no "${expected}" attr`,
          locator: { sheetIndex: index, componentId: component.id, designator: component.designator },
        })
      }
    }
    for (const wire of sheet.wires) {
      // Pagination keeps every authored wire row on page 1 with no drawn dots;
      // those rows are declarations, not geometry, so they must not be
      // asserted against this page's NET attrs.
      if ((wire.dots ?? []).length === 0) continue
      if (wire.net !== undefined && !names.has(wire.net)) {
        findings.push({
          code: 'SCHEMATIC_IMPORT_NET',
          severity: 'warning',
          message: `imported page ${index + 1} source has no NET "${wire.net}"`,
          locator: { sheetIndex: index, net: wire.net },
        })
      }
    }
    // Same delivered-height rule as the verify path: a fitted sheet's
    // persisted Y uses its own height, not the requested page size.
    findings.push(...diffNetlists(sheet, source, index, options.symbolPins, deliveredPageSize(sheet, options.pageSize)))
  }

  return { projectUuid: projectUuid ?? readBack.projectUuid ?? '', pageUuids, findings }
}
