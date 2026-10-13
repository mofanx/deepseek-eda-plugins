/**
 * Model/JSON-boundary parsing for the schematic IR. `parseSchematicIr` accepts
 * the `document` argument a model hands the tools and returns a typed
 * {@link SchematicIr}, throwing {@link SchematicError} `SCHEMATIC_IR_INVALID` on
 * any shape violation. Same-process callers already holding a typed value do
 * not need it.
 * @module @deepseek-ai/dsh-plugin-eda-sch/ir
 */

import { SchematicError } from './types.ts'
import type {
  SchematicComponentKind,
  SchematicIr,
  SchematicIrAttr,
  SchematicIrBlock,
  SchematicIrBusEntry,
  SchematicIrComponent,
  SchematicIrJunction,
  SchematicIrPin,
  SchematicIrSheet,
  SchematicIrWire,
  SchematicPinElectric,
  SchematicPoint,
} from './types.ts'

const PIN_ELECTRICS: readonly SchematicPinElectric[] = ['UNKNOWN', 'INPUT', 'OUTPUT', 'BI']
const COMPONENT_KINDS: readonly SchematicComponentKind[] = ['part', 'block', 'netflag', 'netport', 'sheet', 'nonelec', 'short']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bad(path: string, expect: string): never {
  throw new SchematicError(`${path}: expected ${expect}`, 'SCHEMATIC_IR_INVALID')
}

function reqString(value: Record<string, unknown>, key: string, path: string): string {
  const field = value[key]
  if (typeof field !== 'string') bad(`${path}.${key}`, 'a string')
  return field
}

function optString(value: Record<string, unknown>, key: string, path: string): string | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'string') bad(`${path}.${key}`, 'a string or undefined')
  return field
}

function optNumber(value: Record<string, unknown>, key: string, path: string): number | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'number' || !Number.isFinite(field)) bad(`${path}.${key}`, 'a finite number or undefined')
  return field
}

function optIndex(value: Record<string, unknown>, key: string, path: string): number | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'number' || !Number.isInteger(field) || field < 0) {
    bad(`${path}.${key}`, 'a non-negative integer or undefined')
  }
  return field
}

function optBoolean(value: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'boolean') bad(`${path}.${key}`, 'a boolean or undefined')
  return field
}

function reqEnum<T extends string>(value: Record<string, unknown>, key: string, allowed: readonly T[], path: string): T {
  const field = value[key]
  if (typeof field !== 'string' || !allowed.includes(field as T)) bad(`${path}.${key}`, `one of ${allowed.join(', ')}`)
  return field as T
}

function parsePoint(value: unknown, path: string): SchematicPoint {
  if (!isRecord(value)) bad(path, 'a point object')
  const x = value.x
  const y = value.y
  if (typeof x !== 'number' || !Number.isFinite(x)) bad(`${path}.x`, 'a finite number')
  if (typeof y !== 'number' || !Number.isFinite(y)) bad(`${path}.y`, 'a finite number')
  return { x, y }
}

function parsePin(value: unknown, path: string): SchematicIrPin {
  if (!isRecord(value)) bad(path, 'a pin object')
  return {
    id: reqString(value, 'id', path),
    name: optString(value, 'name', path),
    number: optString(value, 'number', path),
    electric: reqEnum(value, 'electric', PIN_ELECTRICS, path),
    net: optString(value, 'net', path),
    endpoint: value.endpoint === undefined ? undefined : parsePoint(value.endpoint, `${path}.endpoint`),
    noConnect: optBoolean(value, 'noConnect', path),
    powerName: optString(value, 'powerName', path),
    groupId: optString(value, 'groupId', path),
  }
}

function parseComponent(value: unknown, path: string): SchematicIrComponent {
  if (!isRecord(value)) bad(path, 'a component object')
  const pins = value.pins
  if (!Array.isArray(pins)) bad(`${path}.pins`, 'an array')
  return {
    id: reqString(value, 'id', path),
    kind: reqEnum(value, 'kind', COMPONENT_KINDS, path),
    partId: optString(value, 'partId', path),
    groupId: optString(value, 'groupId', path),
    block: optString(value, 'block', path),
    sheetIndex: optIndex(value, 'sheetIndex', path),
    designator: optString(value, 'designator', path),
    netName: optString(value, 'netName', path),
    position: value.position === undefined ? undefined : parsePoint(value.position, `${path}.position`),
    rotation: optNumber(value, 'rotation', path),
    mirror: optBoolean(value, 'mirror', path),
    deviceUuid: optString(value, 'deviceUuid', path),
    symbolUuid: optString(value, 'symbolUuid', path),
    footprintUuid: optString(value, 'footprintUuid', path),
    deviceLibraryUuid: optString(value, 'deviceLibraryUuid', path),
    symbolLibraryUuid: optString(value, 'symbolLibraryUuid', path),
    footprintLibraryUuid: optString(value, 'footprintLibraryUuid', path),
    lcsc: optString(value, 'lcsc', path),
    addIntoBom: optBoolean(value, 'addIntoBom', path),
    addIntoPcb: optBoolean(value, 'addIntoPcb', path),
    pins: pins.map((pin, index) => parsePin(pin, `${path}.pins[${index}]`)),
  }
}

function parseWire(value: unknown, path: string): SchematicIrWire {
  if (!isRecord(value)) bad(path, 'a wire object')
  const dots = value.dots
  if (dots !== undefined && !Array.isArray(dots)) bad(`${path}.dots`, 'an array of polylines')
  const parsed = (dots ?? []).map((line, lineIndex) => {
    if (!Array.isArray(line) || line.length < 4 || line.length % 2 !== 0) {
      bad(`${path}.dots[${lineIndex}]`, 'an even-length coordinate array of at least 4 numbers')
    }
    for (const [index, coord] of line.entries()) {
      if (typeof coord !== 'number' || !Number.isFinite(coord)) {
        bad(`${path}.dots[${lineIndex}][${index}]`, 'a finite number')
      }
    }
    return line as readonly number[]
  })
  return {
    id: reqString(value, 'id', path),
    kind: reqEnum(value, 'kind', ['wire', 'bus'], path),
    dots: parsed,
    net: optString(value, 'net', path),
    groupId: optString(value, 'groupId', path),
  }
}

function parseBusEntry(value: unknown, path: string): SchematicIrBusEntry {
  if (!isRecord(value)) bad(path, 'a bus-entry object')
  const order = value.order
  if (typeof order !== 'number' || !Number.isInteger(order) || order < 0) {
    bad(`${path}.order`, 'a non-negative integer')
  }
  return {
    id: reqString(value, 'id', path),
    busNet: reqString(value, 'busNet', path),
    order,
    point: parsePoint(value.point, `${path}.point`),
    groupId: optString(value, 'groupId', path),
  }
}

function parseAttr(value: unknown, path: string): SchematicIrAttr {
  if (!isRecord(value)) bad(path, 'an attr object')
  return {
    id: reqString(value, 'id', path),
    parentId: reqString(value, 'parentId', path),
    key: reqString(value, 'key', path),
    value: reqString(value, 'value', path),
  }
}

function parseJunction(value: unknown, path: string): SchematicIrJunction {
  if (!isRecord(value)) bad(path, 'a junction object')
  return { point: parsePoint(value.point, `${path}.point`) }
}

function parseBlock(value: unknown, path: string): SchematicIrBlock {
  if (!isRecord(value)) bad(path, 'a block object')
  return {
    name: reqString(value, 'name', path),
    title: optString(value, 'title', path),
  }
}

function parseArray<T>(value: Record<string, unknown>, key: string, parse: (v: unknown, p: string) => T, path: string): readonly T[] {
  const field = value[key]
  if (!Array.isArray(field)) bad(`${path}.${key}`, 'an array')
  return field.map((entry, index) => parse(entry, `${path}.${key}[${index}]`))
}

function optArray<T>(value: Record<string, unknown>, key: string, parse: (v: unknown, p: string) => T, path: string): readonly T[] | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (!Array.isArray(field)) bad(`${path}.${key}`, 'an array or undefined')
  return field.map((entry, index) => parse(entry, `${path}.${key}[${index}]`))
}

/**
 * Parse and validate a model-supplied IR document.
 * @param value - the raw `document` tool argument.
 * @returns the typed schematic IR.
 */
export function parseSchematicIr(value: unknown): SchematicIr {
  if (!isRecord(value)) bad('document', 'an object with a sheets array')
  const sheets = value.sheets
  if (!Array.isArray(sheets)) bad('document.sheets', 'an array')
  if (sheets.length === 0) bad('document.sheets', 'at least one sheet')
  const parsed: SchematicIrSheet[] = sheets.map((sheet, index) => {
    const path = `document.sheets[${index}]`
    if (!isRecord(sheet)) bad(path, 'a sheet object')
    return {
      name: optString(sheet, 'name', path),
      blocks: optArray(sheet, 'blocks', parseBlock, path),
      components: parseArray(sheet, 'components', parseComponent, path),
      wires: parseArray(sheet, 'wires', parseWire, path),
      busEntries: parseArray(sheet, 'busEntries', parseBusEntry, path),
      junctions: parseArray(sheet, 'junctions', parseJunction, path),
      attrs: parseArray(sheet, 'attrs', parseAttr, path),
    }
  })
  return { sheets: parsed }
}
