import { describe, expect, it } from 'vitest'
import {
  EASYEDA_FRAME_A3,
  EASYEDA_FRAME_A4,
  EASYEDA_FRAME_LIBRARY_UUID,
  FRAME_DEVICE_FIELD,
  computeSheetChrome,
  frameSymbolFor,
  pageSizeLabel,
  serializeEasyEdaDocument,
  serializeEasyEdaProject,
} from '../src/index.js'
import type { SchematicIr } from '@deepseek-ai/dsh-plugin-eda-sch'

const A4 = { width: 1170, height: 825 }
const A3 = { width: 1655, height: 1170 }

const base = {
  pageSize: A4,
  projectTitle: 'Demo Board',
  pageName: 'CORE',
  pageIndex: 0,
  pageCount: 2,
  sizeLabel: 'A4',
  version: 'V0.1',
  company: 'ACME',
  date: '2026-10-17',
}

const ir = (name: string): SchematicIr => ({
  sheets: [{
    name,
    components: [],
    pins: [],
    wires: [],
    busEntries: [],
    junctions: [],
    attrs: [],
    blocks: [],
  }],
}) as unknown as SchematicIr

describe('sheet chrome', () => {
  it('draws a double border and a four-row title block below the content edge', () => {
    const chrome = computeSheetChrome(base)
    expect(chrome.rects[0]).toEqual({ x1: 8, y1: 8, x2: 1162, y2: 817 })
    expect(chrome.rects[1]).toEqual({ x1: 16, y1: 16, x2: 1154, y2: 809 })
    const block = chrome.rects[2]
    expect(block).toEqual({ x1: 724, y1: 705, x2: 1154, y2: 809 })
    // Framed pages allow content down to height-150 = 675; the block starts lower.
    expect(block!.y1).toBeGreaterThan(675)
    expect(chrome.texts).toContainEqual({ x: 730, y: 709, value: 'Project', fontSize: 16 })
    expect(chrome.texts).toContainEqual({ x: 800, y: 709, value: 'Demo Board', fontSize: 20 })
    expect(chrome.texts).toContainEqual({ x: 1148, y: 735, value: '1/2', fontSize: 16, align: 'RIGHT_TOP' })
    expect(chrome.texts).toContainEqual({ x: 1148, y: 787, value: 'ACME', fontSize: 16, align: 'RIGHT_TOP' })
    expect(chrome.texts.map(run => run.value)).toContain('A4')
    // Region markers: five column ticks on the top and bottom bands, three row
    // ticks on the sides, labelled 1-6 and A-D like the platform's frame.
    expect(chrome.texts.map(run => run.value)).toEqual(expect.arrayContaining(['1', '2', '3', '4', '5', '6', 'A', 'B', 'C', 'D']))
    expect(chrome.rects.filter(rect => rect.y1 === 8 && rect.y2 === 16)).toHaveLength(5)
    expect(chrome.rects.filter(rect => rect.x1 === 8 && rect.x2 === 16)).toHaveLength(3)
  })

  it('clips overlong titles, page names, and companies and keeps short values intact', () => {
    const chrome = computeSheetChrome({
      ...base,
      projectTitle: 'X'.repeat(50),
      pageName: 'Y'.repeat(50),
      company: 'Z'.repeat(40),
    })
    expect(chrome.texts.find(run => run.value.startsWith('X'))?.value).toBe(`${'X'.repeat(27)}…`)
    expect(chrome.texts.find(run => run.value.startsWith('Y'))?.value).toBe(`${'Y'.repeat(27)}…`)
    expect(chrome.texts.find(run => run.value.startsWith('Z'))?.value).toBe(`${'Z'.repeat(25)}…`)
    const short = computeSheetChrome({ ...base, projectTitle: 'A', pageName: 'B', company: 'C' })
    expect(short.texts).toContainEqual({ x: 800, y: 709, value: 'A', fontSize: 20 })
    expect(short.texts).toContainEqual({ x: 800, y: 735, value: 'B', fontSize: 20 })
    expect(short.texts).toContainEqual({ x: 1148, y: 787, value: 'C', fontSize: 16, align: 'RIGHT_TOP' })
  })

  it('labels A4, A3, and custom page frames', () => {
    expect(pageSizeLabel(A4)).toBe('A4')
    expect(pageSizeLabel(A3)).toBe('A3')
    expect(pageSizeLabel({ width: 800, height: 600 })).toBe('800×600')
  })
})

describe('serialized sheet chrome', () => {
  it('emits solid black rules and title-block text on every page', () => {
    const source = serializeEasyEdaDocument(ir('CORE'), {
      pageSize: A3,
      frame: { projectTitle: 'Demo Board', version: 'V2', company: 'ACME', date: '2026-10-17' },
    })
    expect(source).toContain('"strokeStyle":0')
    expect(source).toContain('"strokeColor":"#000000"')
    expect(source).toContain('"color":"#000000"')
    expect(source).toContain('"value":"Demo Board"')
    expect(source).toContain('"value":"CORE"')
    expect(source).toContain('"value":"A3"')
    expect(source).toContain('"value":"1/1"')
    expect(source).toContain('"value":"V2"')
    expect(source).toContain('"value":"ACME"')
  })

  it('leaves bare document sources unchanged when no frame is requested', () => {
    const source = serializeEasyEdaDocument(ir('CORE'))
    expect(source).not.toContain('"value":"Project"')
    expect(source).not.toContain('"strokeStyle":0')
  })

  it('projects chrome into the importable project package', () => {
    const pkg = serializeEasyEdaProject(ir('POWER'), { title: 'Board', frame: { projectTitle: 'Board' }, pageSize: A4 })
    expect(pkg.epru).toContain('"value":"Board"')
    expect(pkg.epru).toContain('"value":"POWER"')
    expect(pkg.epru).toContain('"value":"A4"')
  })
})

describe('frame option defaults', () => {
  it('defaults the project title when the caller passes an empty frame', () => {
    // A frame with no projectTitle must still print the document title cell
    // (serialize.ts falls back to 'DSH Schematic').
    const source = serializeEasyEdaDocument(ir('P1'), { frame: {} })
    expect(source).toContain('DSH Schematic')
  })
})

describe('native frame symbols', () => {
  it('maps the built-in page sizes to their system sheet symbols', () => {
    expect(frameSymbolFor(A4)).toBe(EASYEDA_FRAME_A4)
    expect(frameSymbolFor(A3)).toBe(EASYEDA_FRAME_A3)
    expect(frameSymbolFor({ width: 800, height: 600 })).toBeUndefined()
  })

  it('keeps the A3 title block anchored to the right edge (A4 + 485)', () => {
    for (const field of EASYEDA_FRAME_A4.fields) {
      const a3 = EASYEDA_FRAME_A3.fields.find(candidate => candidate.key === field.key)
      expect(a3?.x).toBe(field.x + 485)
      expect(a3?.y).toBe(field.y)
      expect(a3?.zIndex).toBe(field.zIndex)
    }
  })

  it('hides the Device binding row and pins the system library', () => {
    expect(FRAME_DEVICE_FIELD).toMatchObject({ key: 'Device', valueVisible: false, fontSize: null, zIndex: 78 })
    expect(EASYEDA_FRAME_A4.libraryUuid).toBe(EASYEDA_FRAME_LIBRARY_UUID)
    expect(EASYEDA_FRAME_A3.name).toBe('Sheet-Symbol_A3')
  })
})

