/**
 * IR → EasyEDA V3 document-source projection, matching the schema the client
 * (editVersion 4.1.x) actually persists and imports: `x`/`y` keys with the
 * Y axis negated relative to the SCH_* API, `attrs` on `COMPONENT`, wire
 * geometry in sibling `LINE` records bound by `lineGroup`, and page-to-
 * schematic binding through the page `META` record. Sheet pins are symbol
 * data and are not emitted; the model supplies binding `ATTR`s instead.
 * The projection is pure; validation is the seam's job and never runs here.
 * @module @deepseek-ai/dsh-plugin-eda-easyeda/serialize
 */

import { randomUUID } from 'node:crypto'
import { SCHEMATIC_PAGE_A4 } from '@deepseek-ai/dsh-plugin-eda-sch'
import type {
  SchematicIr,
  SchematicIrAttr,
  SchematicIrComponent,
  SchematicIrSheet,
  SchematicPageSize,
} from '@deepseek-ai/dsh-plugin-eda-sch'
import { computeBlockFrames } from './blocks.ts'
import { computeSheetChrome, pageSizeLabel } from './sheet-chrome.ts'
import type { EasyEdaSheetFrameOptions } from './sheet-chrome.ts'
import { computeSheetSymbolBoxes } from './hierarchy.ts'

/** Inputs to one document-source projection. */
export interface EasyEdaSerializeOptions {
  /** Document uuid for the first emitted `DOCHEAD`; generated when omitted. */
  readonly docUuid?: string
  /** Eventual-consistency client tag written into each `DOCHEAD`. */
  readonly clientId?: string
  /**
   * Owning schematic uuid; when set, each sheet gains the `META` record that
   * binds a `SCH_PAGE` to its schematic (required inside project imports).
   */
  readonly schematicUuid?: string
  /**
   * Page frame used to clamp module frames and sheet-symbol boxes. Default
   * {@link SCHEMATIC_PAGE_A4}; pass the same size the layout stage planned
   * against (e.g. {@link SCHEMATIC_PAGE_A3}) or decoration clamps to A4.
   */
  readonly pageSize?: SchematicPageSize
  /**
   * Draw a production sheet border and title block on every page. Supplying
   * the frame metadata enables the chrome; omit it for bare document sources.
   */
  readonly frame?: EasyEdaSheetFrameOptions
}

/** Outputs of {@link serializeEasyEdaProject}: the files inside an `.epro2`. */
export interface EasyEdaProjectPackage {
  /** `project2.json` content: the marketplace/sharing metadata stub. */
  readonly projectJson: string
  /** `*.epru` content: every document's `||`-joined log lines. */
  readonly epru: string
  /** Schematic uuid shared by the `SCH` document and every page `META`. */
  readonly schematicUuid: string
  /** `SCH_PAGE` document uuids emitted, in sheet order. */
  readonly pageUuids: readonly string[]
}

/**
 * One library document embedded into an `.epro2` so component references
 * resolve inside the imported project. Real exports copy every referenced
 * `DEVICE`/`SYMBOL`/`FOOTPRINT` under a fresh project-local uuid and repoint
 * the component `ATTR`s at it; a bare library uuid leaves an unresolved
 * empty box on the canvas.
 */
export interface EasyEdaEmbeddedDoc {
  /** Library document uuid the copy was fetched under (`META` `source` origin). */
  readonly sourceUuid: string
  /** Project-local uuid that component `ATTR` values are rewritten to. */
  readonly localUuid: string
  /** `DOCHEAD`-headed document source already localized to `localUuid`. */
  readonly source: string
  /** Document title (`SymbolName`/`FootprintName` attribute values use it). */
  readonly title?: string | undefined
  /** First sub-part id; used as `partId` when the component omits it. */
  readonly partId?: string | undefined
}

/** Project-library copies embedded alongside the schematic documents. */
export interface EasyEdaProjectLibrary {
  readonly devices: readonly EasyEdaEmbeddedDoc[]
  readonly symbols: readonly EasyEdaEmbeddedDoc[]
  readonly footprints: readonly EasyEdaEmbeddedDoc[]
  /**
   * Per-component flag/port bindings (component id → embedded docs) resolved
   * by kind and net name. `netflag`/`netport` IR components carry no library
   * uuids, but the client's persisted flag `COMPONENT` still references a
   * `DEVICE`+`SYMBOL` pair — without it the record is invalid symbol data.
   */
  readonly flags?: ReadonlyMap<string, { readonly device: EasyEdaEmbeddedDoc; readonly symbol: EasyEdaEmbeddedDoc }> | undefined
}

/** Binding rewrite tables `serializeEasyEdaProject` derives from a library. */
interface BindingMap {
  readonly devices: ReadonlyMap<string, EasyEdaEmbeddedDoc>
  readonly symbols: ReadonlyMap<string, EasyEdaEmbeddedDoc>
  readonly footprints: ReadonlyMap<string, EasyEdaEmbeddedDoc>
  readonly flags: ReadonlyMap<string, { readonly device: EasyEdaEmbeddedDoc; readonly symbol: EasyEdaEmbeddedDoc }>
}

const ATTR_TAIL = '"rotation":0,"color":null,"fillColor":null,"fontFamily":null,"fontSize":null,"strikeout":null,"underline":null,"italic":null,"fontWeight":null,"vAlign":0,"hAlign":2'

/** ATTR keys whose values are meant to be visible on the canvas. */
const VISIBLE_ATTR_KEYS = new Set(['Designator', 'Name', 'Global Net Name', 'NET'])

class Emitter {
  private ticket = 0
  private attrSeq = 0
  private lineSeq = 0
  private drawSeq = 0
  /**
   * Page height of the document currently being emitted. For a serialized
   * page, EasyEDA's persisted frame is bottom-left, Y-up while IR coordinates
   * are top-left, Y-down, so the emitted Y is `y - pageHeight`. (The `SCH_*`
   * primitive API is different: it accepts the IR top-left coordinate and the
   * client persists `-y`; see `diffNetlists`'s `ySign`.) Emitting plain `-y`
   * here instead mirrored the whole drawing — titles landed below their frames
   * and module order flipped vertically.
   */
  pageHeight = 0
  readonly lines: string[] = []

  nextTicket(): number {
    return ++this.ticket
  }

  /** Emit one ATTR row belonging to `parentId`; `x`/`y` are IR coordinates. */
  attr(parentId: string, key: string, value: string, x: number, y: number): void {
    const id = `attr${this.attrSeq++}`
    const visible = VISIBLE_ATTR_KEYS.has(key)
    this.lines.push(
      `{"type":"ATTR","id":"${id}","ticket":${this.nextTicket()}}||{"groupId":"","locked":false,"zIndex":0,"parentId":${JSON.stringify(parentId)},"key":${JSON.stringify(key)},"value":${JSON.stringify(value)},"keyVisible":${visible ? 'true' : 'null'},"valueVisible":${visible ? 'true' : 'null'},"x":${x},"y":${y - this.pageHeight},${ATTR_TAIL}}|`,
    )
  }

  /** Emit one LINE segment belonging to a wire `lineGroup`. */
  line(lineGroup: string, x1: number, y1: number, x2: number, y2: number): void {
    const id = `line${this.lineSeq++}`
    this.lines.push(
      `{"type":"LINE","id":"${id}","ticket":${this.nextTicket()}}||{"lineGroup":${JSON.stringify(lineGroup)},"startX":${x1},"startY":${y1 - this.pageHeight},"endX":${x2},"endY":${y2 - this.pageHeight},"strokeColor":null,"strokeStyle":null,"fillColor":null,"strokeWidth":null,"fillStyle":null}|`,
    )
  }

  /**
   * Emit one non-electrical RECT record (dashed module frame or solid sheet
   * chrome). The diagonal points are IR coordinates; the persisted source
   * stores `y - pageHeight` (it negates the client's bottom-left, Y-up API
   * space). A zero-height or zero-width rectangle is a rule.
   */
  rect(x1: number, y1: number, x2: number, y2: number, style: { solid?: boolean; color?: string } = {}): void {
    const id = `rect${this.drawSeq++}`
    const strokeColor = style.color === undefined ? 'null' : JSON.stringify(style.color)
    this.lines.push(
      `{"type":"RECT","id":"${id}","ticket":${this.nextTicket()}}||{"partId":"","groupId":"","locked":false,"zIndex":0,"dotX1":${x1},"dotY1":${y1 - this.pageHeight},"dotX2":${x2},"dotY2":${y2 - this.pageHeight},"radiusX":0,"radiusY":0,"rotation":0,"strokeColor":${strokeColor},"strokeStyle":${style.solid === true ? 0 : 1},"fillColor":"","strokeWidth":null,"fillStyle":0}|`,
    )
  }

  /** Emit one non-electrical TEXT record (module/block label or sheet chrome); `x`/`y` are IR coordinates. */
  text(x: number, y: number, value: string, fontSize = 40, align: 'LEFT_TOP' | 'RIGHT_TOP' = 'LEFT_TOP', color = '#000088'): void {
    const id = `text${this.drawSeq++}`
    const ink = JSON.stringify(color)
    this.lines.push(
      `{"type":"TEXT","id":"${id}","ticket":${this.nextTicket()}}||{"x":${x},"y":${y - this.pageHeight},"rotation":0,"color":${ink},"fontFamily":null,"fontSize":${fontSize},"fontWeight":true,"italic":false,"underline":false,"align":"${align}","value":${JSON.stringify(value)},"fillColor":${ink},"zIndex":0}|`,
    )
  }
}

function emitComponent(emit: Emitter, component: SchematicIrComponent, bindings?: BindingMap): void {
  const flag = bindings?.flags.get(component.id)
  const symbol = flag?.symbol ?? (component.symbolUuid === undefined ? undefined : bindings?.symbols.get(component.symbolUuid))
  const device = flag?.device ?? (component.deviceUuid === undefined ? undefined : bindings?.devices.get(component.deviceUuid))
  const footprint = component.footprintUuid === undefined ? undefined : bindings?.footprints.get(component.footprintUuid)
  const partId = component.partId ?? symbol?.partId ?? ''
  const inner = `"locked":false,"zIndex":0,"partId":${JSON.stringify(partId)},"groupId":${JSON.stringify(component.groupId ?? '')},` +
    `"x":${component.position?.x ?? 0},"y":${(component.position?.y ?? 0) - emit.pageHeight},"rotation":${component.rotation ?? 0},"isMirror":${component.mirror ?? false},` +
    '"attrs":{"Footprints":"[]","Devices":"[]","DeviceName":null,"FootprintName":null,"pinClass":{},"differentialPairClass":{},"Symbols":"[]"}'
  emit.lines.push(
    `{"type":"COMPONENT","id":${JSON.stringify(component.id)},"ticket":${emit.nextTicket()}}||{${inner}}|`,
  )
  const { x = 0, y = 0 } = component.position ?? {}
  if (component.deviceUuid !== undefined || flag !== undefined) emit.attr(component.id, 'Device', device?.localUuid ?? component.deviceUuid ?? '', x, y)
  if (component.symbolUuid !== undefined || flag !== undefined) emit.attr(component.id, 'Symbol', symbol?.localUuid ?? component.symbolUuid ?? '', x, y)
  if (component.footprintUuid !== undefined) emit.attr(component.id, 'Footprint', footprint?.localUuid ?? component.footprintUuid, x, y)
  if (component.designator !== undefined) emit.attr(component.id, 'Designator', component.designator, x, y)
  if (component.netName !== undefined) {
    emit.attr(component.id, 'Name', component.netName, x, y)
    if (component.kind === 'netflag') emit.attr(component.id, 'Global Net Name', component.netName, x, y)
  }
}

function emitAttr(emit: Emitter, attr: SchematicIrAttr): void {
  emit.attr(attr.parentId, attr.key, attr.value, 0, 0)
}

function emitSheet(
  emit: Emitter,
  sheet: SchematicIrSheet,
  docUuid: string,
  clientId: string,
  schematicUuid: string | undefined,
  sheetIndex: number,
  bindings?: BindingMap,
  pageSize: SchematicPageSize = SCHEMATIC_PAGE_A4,
  frame?: EasyEdaSheetFrameOptions,
  pageCount = 1,
): void {
  // A page the layout fitted to its content (幅面收敛) is delivered on that
  // smaller sheet; the frame, its title block, and the module-frame clamp all
  // follow the delivered size rather than the planned one.
  const size = sheet.pageSize ?? pageSize
  emit.pageHeight = size.height
  emit.lines.push(`{"type":"DOCHEAD","ticket":${emit.nextTicket()}}||{"docType":"SCH_PAGE","client":"${clientId}","uuid":"${docUuid}","updateTime":1,"version":"1","user":{"uuid":"${docUuid}"}}|`)
  if (schematicUuid !== undefined) {
    emit.lines.push(`{"type":"META","ticket":${emit.nextTicket()},"id":"META"}||{"title":${JSON.stringify(sheet.name ?? `P${sheetIndex + 1}`)},"schematic":"${schematicUuid}","source":"","zIndex":${sheetIndex}}|`)
  }
  emit.lines.push(`{"type":"CANVAS","ticket":${emit.nextTicket()},"id":"CANVAS"}||{"originX":0,"originY":0}|`)
  if (frame !== undefined) {
    const chrome = computeSheetChrome({
      pageSize: size,
      projectTitle: frame.projectTitle ?? 'DSH Schematic',
      pageName: sheet.name ?? `P${sheetIndex + 1}`,
      pageIndex: sheetIndex,
      pageCount,
      sizeLabel: pageSizeLabel(size),
      version: frame.version ?? 'V0.1',
      company: frame.company ?? '',
      date: frame.date ?? '',
      drawingNumber: frame.drawingNumber,
      schematicName: frame.schematicName,
      drawnBy: frame.drawnBy,
      checkedBy: frame.checkedBy,
      approvedBy: frame.approvedBy,
    })
    for (const rule of chrome.rects) emit.rect(rule.x1, rule.y1, rule.x2, rule.y2, { solid: true, color: '#000000' })
    for (const run of chrome.texts) emit.text(run.x, run.y, run.value, run.fontSize, run.align ?? 'LEFT_TOP', '#000000')
  }
  for (const component of sheet.components) {
    // A `kind: 'block'` component carries no library binding — an unresolved
    // COMPONENT record renders an empty "?" box — so it projects to drawn
    // sheet-symbol graphics instead of a component record.
    if (component.kind === 'block') continue
    emitComponent(emit, component, bindings)
  }
  // A row with no geometry is a declaration only (pagination keeps authored
  // wire rows without their unanchored dots so ATTRs survive). Projecting it
  // would emit a WIRE with no LINE children plus a NET ATTR at the origin, so
  // the row and the ATTRs that hang off it are skipped entirely.
  const geometrylessWires = new Set(sheet.wires
    .filter(wire => (wire.dots ?? []).length === 0)
    .map(wire => wire.id))
  for (const wire of sheet.wires) {
    const chains = wire.dots ?? []
    if (chains.length === 0) continue
    const type = wire.kind === 'bus' ? 'BUS' : 'WIRE'
    emit.lines.push(
      `{"type":"${type}","id":${JSON.stringify(wire.id)},"ticket":${emit.nextTicket()}}||{"groupId":"","locked":false,"zIndex":0}|`,
    )
    for (const dots of chains) {
      for (let i = 0; i + 3 < dots.length; i += 2) {
        const [x1, y1, x2, y2] = dots.slice(i, i + 4) as [number, number, number, number]
        emit.line(wire.id, x1, y1, x2, y2)
      }
    }
    if (wire.net !== undefined) {
      const first = chains[0] as readonly number[]
      emit.attr(wire.id, 'NET', wire.net, first[0] as number, first[1] as number)
    }
  }
  for (const attr of sheet.attrs) {
    if (geometrylessWires.has(attr.parentId)) continue
    emitAttr(emit, attr)
  }
  // Module frames are non-electrical RECT/TEXT records; read-back and the
  // netlist diff only consume ATTR/COMPONENT/WIRE/LINE, so they never join
  // the connectivity comparison.
  for (const frame of computeBlockFrames(sheet, size)) {
    emit.rect(frame.x, frame.y, frame.x + frame.width, frame.y + frame.height)
    emit.text(frame.titleX, frame.titleY, frame.title)
  }
  // Hierarchy blocks draw as a labelled sheet-symbol box with one pin-name
  // label per interface pin; pin endpoints land on the box edges so wires
  // terminate flush.
  for (const box of computeSheetSymbolBoxes(sheet, pageSize)) {
    emit.rect(box.x, box.y, box.x + box.width, box.y + box.height)
    emit.text(box.titleX, box.titleY, box.title)
    for (const pin of box.pins) emit.text(pin.x, pin.y, pin.name, 20, pin.align)
  }
}

/**
 * Project the IR to EasyEDA V3 `SCH_PAGE` document source. Multi-sheet IR
 * emits one `DOCHEAD`-headed document per sheet, in sheet order.
 * @param ir - the schematic IR to emit.
 * @param options - document uuid, client tag, and schematic-binding overrides.
 * @returns the `||`-joined document-source text, one record per line.
 */
export function serializeEasyEdaDocument(ir: SchematicIr, options: EasyEdaSerializeOptions = {}): string {
  const emit = new Emitter()
  const clientId = options.clientId ?? 'dsh'
  ir.sheets.forEach((sheet, index) => {
    const uuid = index === 0 && options.docUuid !== undefined
      ? options.docUuid
      : randomUUID().replaceAll('-', '')
    emitSheet(emit, sheet, uuid, clientId, options.schematicUuid, index, undefined, options.pageSize ?? SCHEMATIC_PAGE_A4, options.frame, ir.sheets.length)
  })
  return emit.lines.join('\n') + '\n'
}

/**
 * Project the IR to a complete importable project payload: a `CONFIG`
 * document, one `SCH` document, and one `SCH_PAGE` per IR sheet, packaged as
 * the two entries of an `.epro2` zip (`project2.json` + `*.epru`). When
 * `options.library` supplies embedded `DEVICE`/`SYMBOL`/`FOOTPRINT` copies,
 * they are emitted ahead of the pages and every component binding `ATTR` is
 * rewritten to the project-local uuid — without the copies the client
 * renders components as unresolved empty boxes.
 * @param ir - the schematic IR to emit.
 * @param options - client tag, naming overrides, and embedded library docs.
 * @returns the container payload to zip and feed `importProjectByProjectFile`.
 */
export function serializeEasyEdaProject(
  ir: SchematicIr,
  options: {
    clientId?: string | undefined
    title?: string | undefined
    library?: EasyEdaProjectLibrary | undefined
    /** Page frame for module frames/sheet symbols; defaults to A4. */
    pageSize?: SchematicPageSize | undefined
    /** Draw the production border/title block; presence enables the chrome. */
    frame?: EasyEdaSheetFrameOptions | undefined
  } = {},
): EasyEdaProjectPackage {
  const clientId = options.clientId ?? 'dsh'
  const title = options.title ?? 'DSH Schematic'
  const schematicUuid = randomUUID().replaceAll('-', '')
  const pageUuids = ir.sheets.map(() => randomUUID().replaceAll('-', ''))
  const emit = new Emitter()
  emit.lines.push(`{"type":"DOCHEAD","ticket":${emit.nextTicket()}}||{"docType":"CONFIG","client":"${clientId}","uuid":"CONFIG","updateTime":1,"version":"1","user":{"uuid":"CONFIG"}}|`)
  emit.lines.push(`{"type":"UNIVERSAL","ticket":${emit.nextTicket()},"id":"UNIVERSAL"}||{"allowLibRename":true,"defaultNetName":true,"wireMultipleNet":true,"netFlagCrossLayerConnection":true,"netLabelCrossPageConnection":true,"busGenerateNetClass":true,"relevanceDisplayRow":"SINGLE","relevanceBelongSchPage":"NAME"}|`)
  emit.lines.push(`{"type":"META","ticket":${emit.nextTicket()},"id":"META"}||{"defaultSheet":"${pageUuids[0] ?? ''}"}|`)
  emit.lines.push(`{"type":"DOCHEAD","ticket":${emit.nextTicket()}}||{"docType":"SCH","client":"${clientId}","uuid":"${schematicUuid}","updateTime":1,"version":"1","user":{"uuid":"${schematicUuid}"}}|`)
  emit.lines.push(`{"type":"META","ticket":${emit.nextTicket()},"id":"META"}||{"title":${JSON.stringify(title)},"source":"","board":"","zIndex":null}|`)
  const library = options.library
  if (library !== undefined) {
    for (const doc of [...library.devices, ...library.symbols, ...library.footprints]) emit.lines.push(doc.source)
  }
  const bindings: BindingMap | undefined = library === undefined
    ? undefined
    : {
      devices: new Map(library.devices.map(doc => [doc.sourceUuid, doc])),
      symbols: new Map(library.symbols.map(doc => [doc.sourceUuid, doc])),
      footprints: new Map(library.footprints.map(doc => [doc.sourceUuid, doc])),
      flags: library.flags ?? new Map(),
    }
  pageUuids.forEach((uuid, index) => {
    const sheet = ir.sheets[index]
    /* v8 ignore next -- pageUuids derives from ir.sheets.map, so the index is always in range */
    if (sheet !== undefined) emitSheet(emit, sheet, uuid, clientId, schematicUuid, index, bindings, options.pageSize ?? SCHEMATIC_PAGE_A4, options.frame, ir.sheets.length)
  })
  return {
    projectJson: JSON.stringify({ title, cbb_project: false }),
    epru: emit.lines.join('\n') + '\n',
    schematicUuid,
    pageUuids,
  }
}
