/**
 * Drawing-sheet chrome: the border and title block a production schematic is
 * delivered on. EasyEDA's native sheet frame is a built-in `Sheet-Symbol`
 * component that the client only creates through editor actions (the
 * `sch_PrimitiveComponent.create` path hangs for it), so generated pages draw
 * an equivalent frame as non-electrical RECT/TEXT primitives. The result
 * prints and exports like a titled drawing without depending on an
 * unscriptable editor template.
 *
 * Geometry follows the reference project's A3 sheet: a double border inset
 * from the page edge and a four-row title block in the bottom-right corner.
 * The block sits below the framed-layout edge allowance (150 units), so it
 * never overlaps auto-placed module content.
 */
import type { SchematicPageSize } from '@deepseek-ai/dsh-plugin-eda-sch'

/** One chrome rectangle in IR coordinates (top-left origin); a zero-height
 * rectangle is a horizontal rule, a zero-width one a vertical rule. */
export interface SheetChromeRect {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

/** One chrome text run in IR coordinates. */
export interface SheetChromeText {
  readonly x: number
  readonly y: number
  readonly value: string
  readonly fontSize: number
  readonly align?: 'LEFT_TOP' | 'RIGHT_TOP'
}

/** Border and title-block primitives for one page. */
export interface SheetChrome {
  readonly rects: readonly SheetChromeRect[]
  readonly texts: readonly SheetChromeText[]
}

/** Metadata printed into the title block; supplying it enables the chrome. */
export interface EasyEdaSheetFrameOptions {
  /** Project/document title in the `Project` row; defaults to the import name. */
  readonly projectTitle?: string | undefined
  /** Drawing/sheet number printed beside the sheet name. */
  readonly drawingNumber?: string | undefined
  /** Sheet name printed in the title block; defaults to the page name. */
  readonly schematicName?: string | undefined
  /** Revision label; defaults to `V0.1`. */
  readonly version?: string | undefined
  /** Company/owner printed in the bottom-right cell; may be empty. */
  readonly company?: string | undefined
  /** Drawing date (`YYYY-MM-DD`); may be empty. */
  readonly date?: string | undefined
  /** Designer signature cell; may be empty. */
  readonly drawnBy?: string | undefined
  /** Reviewer signature cell; may be empty. */
  readonly checkedBy?: string | undefined
  /** Approver signature cell; may be empty. */
  readonly approvedBy?: string | undefined
}

/** Everything the title block prints; supplied by the serializer per page. */
export interface SheetChromeOptions {
  /** Page frame the chrome is drawn inside. */
  readonly pageSize: SchematicPageSize
  /** Project/document title shown in the `Project` row. */
  readonly projectTitle: string
  /** Sheet/page name shown in the `Sheet` row. */
  readonly pageName: string
  /** Zero-based page index; printed as `1-based/pageCount`. */
  readonly pageIndex: number
  /** Total pages in the delivered schematic. */
  readonly pageCount: number
  /** Paper label (`A4`, `A3`, or `width×height`). */
  readonly sizeLabel: string
  /** Drawing revision printed in the `Rev` row. */
  readonly version: string
  /** Company/owner printed in the `Unit` cell; may be empty. */
  readonly company: string
  /** Drawing date (`YYYY-MM-DD`); may be empty. */
  readonly date: string
  /** Drawing/sheet number; may be empty. */
  readonly drawingNumber?: string | undefined
  /** Sheet name printed in the title block; defaults to `pageName`. */
  readonly schematicName?: string | undefined
  /** Designer signature; may be empty. */
  readonly drawnBy?: string | undefined
  /** Reviewer signature; may be empty. */
  readonly checkedBy?: string | undefined
  /** Approver signature; may be empty. */
  readonly approvedBy?: string | undefined
}

const BORDER_INSET = 8
const INNER_INSET = 16
/**
 * Title block width: two label+value groups plus the page-number corner cell.
 * Kept as a sum so the column constants and the block width cannot drift.
 */
const LABEL_COLUMN = 64
const VALUE_COLUMN = 186
/** Corner cell holding `n/N`, used only by the first row. */
const PAGE_COLUMN = 60
const TITLE_BLOCK_WIDTH = LABEL_COLUMN * 2 + VALUE_COLUMN * 2 + PAGE_COLUMN
const ROW_HEIGHT = 26
/** Five rows: sheet+number, project+size, version+date, drawn+checked, approved+unit. */
const ROW_COUNT = 5
const TEXT_PAD = 6
const VALUE_MAX = 24
const COMPANY_MAX = 24
/** Sheet region grid printed in the border band: 6 columns × 4 rows. */
const REGION_COLUMNS = 6
const REGION_ROWS = 4
/** Region label size and the half-glyph nudge that centres it on its tick. */
const MARK_FONT = 12
const MARK_OFFSET = 3

/** IR y of the title block's top edge; decoration below this line collides
 * with the block. `0` on a page too short to hold it. */
export function titleBlockTop(size: SchematicPageSize): number {
  return Math.max(0, size.height - INNER_INSET - ROW_HEIGHT * ROW_COUNT)
}

/**
 * One dynamic title-block field inside a native drawing-frame symbol. The
 * coordinates come from the symbol's own definition, in the symbol's space;
 * a frame symbol is placed at persisted `(0, 0)` (IR `(0, pageHeight)`), so
 * they are directly the persisted page coordinates the `ATTR` record needs
 * (`IR y = persisted y + pageHeight`).
 */
export interface EasyEdaFrameField {
  /** `ATTR` key the client prints in that cell. */
  readonly key: string
  /** Persisted x of the text anchor. */
  readonly x: number
  /** Persisted y of the text anchor. */
  readonly y: number
  /** Font size, or `null` for the frame's own hidden anchor rows. */
  readonly fontSize: number | null
  readonly align: 'CENTER_MIDDLE' | 'LEFT_MIDDLE'
  /** `false` only for the hidden `Device` binding row. */
  readonly valueVisible?: boolean | undefined
  /** Draw order inside the frame component (matches the reference project). */
  readonly zIndex: number
}

/** System-library drawing-frame symbol placed on every page of one size. */
export interface EasyEdaFrameSymbol {
  /** System-library device uuid the frame component binds. */
  readonly deviceUuid: string
  /** System-library symbol uuid embedded as a project-local copy. */
  readonly symbolUuid: string
  /** Owning (system) library uuid the copies are fetched under. */
  readonly libraryUuid: string
  /** Device name printed in the frame's `DeviceName` attribute. */
  readonly name: string
  /** Dynamic title-block fields this serializer fills in; geometry only. */
  readonly fields: readonly EasyEdaFrameField[]
}

/** System library every built-in drawing-frame symbol belongs to. */
export const EASYEDA_FRAME_LIBRARY_UUID = '0819f05c4eef4c71ace90d822a990e87'

/** A4 (`Sheet-Symbol_A4`) title-block anchors, read from the symbol source. */
const FRAME_FIELDS_A4: readonly EasyEdaFrameField[] = [
  { key: '@Page Name', x: 730, y: -140, fontSize: 15, align: 'CENTER_MIDDLE', zIndex: 77 },
  { key: '@Project Name', x: 920, y: -100, fontSize: 20, align: 'CENTER_MIDDLE', zIndex: 70 },
  { key: '@Update Date', x: 1010, y: -180, fontSize: 15, align: 'LEFT_MIDDLE', zIndex: 72 },
  { key: '@Create Date', x: 1010, y: -160, fontSize: 15, align: 'LEFT_MIDDLE', zIndex: 73 },
  { key: '@Schematic Name', x: 730, y: -170, fontSize: 20, align: 'CENTER_MIDDLE', zIndex: 74 },
  { key: '@Page No', x: 985, y: -61, fontSize: 15, align: 'CENTER_MIDDLE', zIndex: 76 },
]

/** A3 (`Sheet-Symbol_A3`) title-block anchors: A4 shifted right by 485 units. */
const FRAME_FIELDS_A3: readonly EasyEdaFrameField[] = FRAME_FIELDS_A4.map(field => ({ ...field, x: field.x + 485 }))

/** The `Device` binding row every frame component carries (hidden, at origin). */
export const FRAME_DEVICE_FIELD: EasyEdaFrameField = { key: 'Device', x: 0, y: 0, fontSize: null, align: 'CENTER_MIDDLE', valueVisible: false, zIndex: 78 }

/** The `Symbol` binding row; imported components resolve through it. */
export const FRAME_SYMBOL_FIELD: EasyEdaFrameField = { key: 'Symbol', x: 0, y: 0, fontSize: null, align: 'CENTER_MIDDLE', valueVisible: false, zIndex: 71 }

/** A4 landscape drawing frame (`Sheet-Symbol_A4`). */
export const EASYEDA_FRAME_A4: EasyEdaFrameSymbol = {
  deviceUuid: '4b872d674c0b4b0e8ede0a73cf1a0316',
  symbolUuid: 'f2baecf085944dad81faf9a0fd6bfcea',
  libraryUuid: EASYEDA_FRAME_LIBRARY_UUID,
  name: 'Sheet-Symbol_A4',
  fields: FRAME_FIELDS_A4,
}

/** A3 landscape drawing frame (`Sheet-Symbol_A3`). */
export const EASYEDA_FRAME_A3: EasyEdaFrameSymbol = {
  deviceUuid: '25d1e29c59cf4041907f5908f56317a1',
  symbolUuid: '6f8cc47a30c240bbb979c211cee8d9f2',
  libraryUuid: EASYEDA_FRAME_LIBRARY_UUID,
  name: 'Sheet-Symbol_A3',
  fields: FRAME_FIELDS_A3,
}

/**
 * The built-in drawing frame for a page size, or `undefined` for a custom size
 * (which keeps the self-drawn chrome). Placing the frame symbol is what makes
 * the delivered page that size, so this also declares the printed sheet.
 * @param size - page frame the layout planned against.
 * @returns the matching frame symbol descriptor.
 */
export function frameSymbolFor(size: SchematicPageSize): EasyEdaFrameSymbol | undefined {
  if (size.width === 1170 && size.height === 825) return EASYEDA_FRAME_A4
  if (size.width === 1655 && size.height === 1170) return EASYEDA_FRAME_A3
  return undefined
}

/** Truncate a value that would run past its cell, keeping one ellipsis. */
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** Map a page frame to the paper label printed in the title block. */
export function pageSizeLabel(size: SchematicPageSize): string {
  if (size.width === 1170 && size.height === 825) return 'A4'
  if (size.width === 1655 && size.height === 1170) return 'A3'
  return `${size.width}×${size.height}`
}

/**
 * Build the border + title-block primitives for one page.
 * @param options - page frame, page identity, and title-block fields.
 * @returns rectangles and text runs in IR coordinates.
 */
export function computeSheetChrome(options: SheetChromeOptions): SheetChrome {
  const { width, height } = options.pageSize
  const x1 = width - INNER_INSET
  const y1 = height - INNER_INSET
  const blockX = x1 - TITLE_BLOCK_WIDTH
  const blockY = y1 - ROW_HEIGHT * ROW_COUNT
  // Column edges: label1 | value1 | label2 | value2 | page. The page column is
  // only labelled on the first row; the rest of the grid stays blank there.
  const label1X = blockX
  const value1X = label1X + LABEL_COLUMN
  const label2X = value1X + VALUE_COLUMN
  const value2X = label2X + LABEL_COLUMN
  const pageX = x1 - PAGE_COLUMN
  const rects: SheetChromeRect[] = [
    { x1: BORDER_INSET, y1: BORDER_INSET, x2: width - BORDER_INSET, y2: height - BORDER_INSET },
    { x1: INNER_INSET, y1: INNER_INSET, x2: x1, y2: y1 },
    { x1: blockX, y1: blockY, x2: x1, y2: y1 },
  ]
  // The two label columns and the page column run the full block height; the
  // row rules split the five rows so every field keeps its own cell.
  for (const x of [value1X, label2X, value2X, pageX]) rects.push({ x1: x, y1: blockY, x2: x, y2: y1 })
  for (let row = 1; row < ROW_COUNT; row++) {
    const y = blockY + row * ROW_HEIGHT
    rects.push({ x1: blockX, y1: y, x2: x1, y2: y })
  }
  const rowTextY = (row: number): number => blockY + row * ROW_HEIGHT + 4
  const texts: SheetChromeText[] = []
  /** One label+value cell; an empty value leaves the cell blank. */
  const cell = (row: number, labelX: number, valueX: number, label: string, value: string, max = VALUE_MAX): void => {
    texts.push({ x: labelX + TEXT_PAD, y: rowTextY(row), value: label, fontSize: 14 })
    if (value.length > 0) texts.push({ x: valueX + TEXT_PAD, y: rowTextY(row), value: clip(value, max), fontSize: 16 })
  }
  cell(0, label1X, value1X, '图样名称', options.schematicName ?? options.pageName)
  cell(0, label2X, value2X, '图号', options.drawingNumber ?? '')
  cell(1, label1X, value1X, '项目', options.projectTitle, 30)
  cell(1, label2X, value2X, '图幅', options.sizeLabel)
  cell(2, label1X, value1X, '版本', options.version)
  cell(2, label2X, value2X, '日期', options.date)
  cell(3, label1X, value1X, '设计', options.drawnBy ?? '')
  cell(3, label2X, value2X, '审核', options.checkedBy ?? '')
  cell(4, label1X, value1X, '批准', options.approvedBy ?? '')
  cell(4, label2X, value2X, '单位', options.company, COMPANY_MAX)
  // Page counter rides the first row's corner cell, right-aligned.
  texts.push({
    x: x1 - TEXT_PAD,
    y: rowTextY(0),
    value: `${options.pageIndex + 1}/${options.pageCount}`,
    fontSize: 14,
    align: 'RIGHT_TOP',
  })
  // Sheet region markers: the drawing frame divides into six columns and four
  // rows, each ticked across the band between the outer and inner border and
  // labelled (1–6 top/bottom, A–D left/right) like the platform's frame.
  const innerWidth = x1 - INNER_INSET
  const innerHeight = y1 - INNER_INSET
  for (let column = 1; column < REGION_COLUMNS; column++) {
    const x = Math.round(INNER_INSET + innerWidth * column / REGION_COLUMNS)
    rects.push({ x1: x, y1: BORDER_INSET, x2: x, y2: INNER_INSET })
    rects.push({ x1: x, y1, x2: x, y2: height - BORDER_INSET })
  }
  for (let row = 1; row < REGION_ROWS; row++) {
    const y = Math.round(INNER_INSET + innerHeight * row / REGION_ROWS)
    rects.push({ x1: BORDER_INSET, y1: y, x2: INNER_INSET, y2: y })
    rects.push({ x1, y1: y, x2: width - BORDER_INSET, y2: y })
  }
  for (let column = 0; column < REGION_COLUMNS; column++) {
    const value = String(column + 1)
    const x = Math.round(INNER_INSET + innerWidth * (column + 0.5) / REGION_COLUMNS) - MARK_OFFSET
    texts.push({ x, y: (BORDER_INSET + INNER_INSET) / 2 - MARK_FONT / 2, value, fontSize: MARK_FONT })
    texts.push({ x, y: (y1 + height - BORDER_INSET) / 2 - MARK_FONT / 2, value, fontSize: MARK_FONT })
  }
  for (let row = 0; row < REGION_ROWS; row++) {
    const value = String.fromCharCode(65 + row)
    const y = Math.round(INNER_INSET + innerHeight * (row + 0.5) / REGION_ROWS) - MARK_FONT / 2
    texts.push({ x: BORDER_INSET, y, value, fontSize: MARK_FONT })
    texts.push({ x: x1, y, value, fontSize: MARK_FONT })
  }
  return { rects, texts }
}
