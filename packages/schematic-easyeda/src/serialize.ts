/**
 * IR → EasyEDA V3 document-source projection, matching the schema the client
 * (editVersion 4.1.x) actually persists and imports: `x`/`y` keys with the
 * Y axis negated relative to the SCH_* API, `attrs` on `COMPONENT`, wire
 * geometry in sibling `LINE` records bound by `lineGroup`, and page-to-
 * schematic binding through the page `META` record. Sheet pins are symbol
 * data and are not emitted; the model supplies binding `ATTR`s instead.
 * The projection is pure; validation is the seam's job and never runs here.
 * @module @deepseek-ai/dsh-schematic-easyeda/serialize
 */

import { randomUUID } from 'node:crypto'
import type {
  SchematicIr,
  SchematicIrAttr,
  SchematicIrComponent,
  SchematicIrSheet,
} from '@deepseek-ai/dsh-schematic'

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
  readonly lines: string[] = []

  nextTicket(): number {
    return ++this.ticket
  }

  /** Emit one ATTR row belonging to `parentId`; `x`/`y` are IR coordinates. */
  attr(parentId: string, key: string, value: string, x: number, y: number): void {
    const id = `attr${this.attrSeq++}`
    const visible = VISIBLE_ATTR_KEYS.has(key)
    this.lines.push(
      `{"type":"ATTR","id":"${id}","ticket":${this.nextTicket()}}||{"groupId":"","locked":false,"zIndex":0,"parentId":${JSON.stringify(parentId)},"key":${JSON.stringify(key)},"value":${JSON.stringify(value)},"keyVisible":${visible ? 'true' : 'null'},"valueVisible":${visible ? 'true' : 'null'},"x":${x},"y":${-y},${ATTR_TAIL}}|`,
    )
  }

  /** Emit one LINE segment belonging to a wire `lineGroup`. */
  line(lineGroup: string, x1: number, y1: number, x2: number, y2: number): void {
    const id = `line${this.lineSeq++}`
    this.lines.push(
      `{"type":"LINE","id":"${id}","ticket":${this.nextTicket()}}||{"lineGroup":${JSON.stringify(lineGroup)},"startX":${x1},"startY":${-y1},"endX":${x2},"endY":${-y2},"strokeColor":null,"strokeStyle":null,"fillColor":null,"strokeWidth":null,"fillStyle":null}|`,
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
    `"x":${component.position?.x ?? 0},"y":${-(component.position?.y ?? 0)},"rotation":${component.rotation ?? 0},"isMirror":${component.mirror ?? false},` +
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
): void {
  emit.lines.push(`{"type":"DOCHEAD","ticket":${emit.nextTicket()}}||{"docType":"SCH_PAGE","client":"${clientId}","uuid":"${docUuid}","updateTime":1,"version":"1","user":{"uuid":"${docUuid}"}}|`)
  if (schematicUuid !== undefined) {
    emit.lines.push(`{"type":"META","ticket":${emit.nextTicket()},"id":"META"}||{"title":"P${sheetIndex + 1}","schematic":"${schematicUuid}","source":"","zIndex":${sheetIndex}}|`)
  }
  emit.lines.push(`{"type":"CANVAS","ticket":${emit.nextTicket()},"id":"CANVAS"}||{"originX":0,"originY":0}|`)
  for (const component of sheet.components) emitComponent(emit, component, bindings)
  for (const wire of sheet.wires) {
    const type = wire.kind === 'bus' ? 'BUS' : 'WIRE'
    emit.lines.push(
      `{"type":"${type}","id":${JSON.stringify(wire.id)},"ticket":${emit.nextTicket()}}||{"groupId":"","locked":false,"zIndex":0}|`,
    )
    for (const dots of wire.dots ?? []) {
      for (let i = 0; i + 3 < dots.length; i += 2) {
        const [x1, y1, x2, y2] = dots.slice(i, i + 4) as [number, number, number, number]
        emit.line(wire.id, x1, y1, x2, y2)
      }
    }
    if (wire.net !== undefined) {
      const first = wire.dots?.[0]
      emit.attr(wire.id, 'NET', wire.net, first?.[0] ?? 0, first?.[1] ?? 0)
    }
  }
  for (const attr of sheet.attrs) emitAttr(emit, attr)
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
    emitSheet(emit, sheet, uuid, clientId, options.schematicUuid, index)
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
  options: { clientId?: string | undefined; title?: string | undefined; library?: EasyEdaProjectLibrary | undefined } = {},
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
    if (sheet !== undefined) emitSheet(emit, sheet, uuid, clientId, schematicUuid, index, bindings)
  })
  return {
    projectJson: JSON.stringify({ title, cbb_project: false }),
    epru: emit.lines.join('\n') + '\n',
    schematicUuid,
    pageUuids,
  }
}
