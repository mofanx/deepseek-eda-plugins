import { describe, expect, it } from 'vitest'
import { computeBlockFrames } from '@deepseek-ai/dsh-plugin-eda-core'
import type { SchematicIrComponent, SchematicIrSheet } from '@deepseek-ai/dsh-plugin-eda-sch'

const sheet = (over: Partial<SchematicIrSheet> = {}): SchematicIrSheet => ({
  components: [], wires: [], busEntries: [], junctions: [], attrs: [], ...over,
})

const part = (
  id: string,
  block: string | undefined,
  x: number,
  y: number,
  endpoints: { x: number; y: number }[] = [],
): SchematicIrComponent => ({
  id,
  kind: 'part',
  designator: id.toUpperCase(),
  ...(block === undefined ? {} : { block }),
  position: { x, y },
  pins: endpoints.map((endpoint, index) => ({
    id: `${id}-p${index}`, name: 'P', number: `${index + 1}`, electric: 'INPUT' as const, endpoint,
  })),
})

describe('computeBlockFrames', () => {
  it('returns no frames when nothing declares a block', () => {
    expect(computeBlockFrames(sheet({ components: [part('u1', undefined, 100, 200)] }))).toEqual([])
    expect(computeBlockFrames(sheet())).toEqual([])
  })

  it('skips members without a resolved position', () => {
    const unplaced: SchematicIrComponent = { id: 'u9', kind: 'part', block: 'pwr', pins: [] }
    expect(computeBlockFrames(sheet({ components: [unplaced] }))).toEqual([])
  })

  it('bounds positions and pin endpoints with the padded title headroom', () => {
    const frames = computeBlockFrames(sheet({
      components: [part('u1', 'power', 100, 200, [{ x: 110, y: 200 }])],
    }))
    expect(frames).toEqual([{
      name: 'power',
      title: 'power',
      x: 20, y: 60, width: 170, height: 220,
      titleX: 40, titleY: 70,
    }])
  })

  it('ignores pins whose endpoint is not yet resolved', () => {
    const member: SchematicIrComponent = {
      id: 'u1', kind: 'part', designator: 'U1', block: 'pwr', position: { x: 100, y: 100 },
      pins: [{ id: 'p1', name: 'P', number: '1', electric: 'INPUT' }],
    }
    const [frame] = computeBlockFrames(sheet({ components: [member] }))
    // y=floor((100-140)/10)*10=-40 clamps onto the page frame.
    expect(frame).toMatchObject({ x: 20, y: 0 })
  })

  it('lets pin endpoints widen the box beyond the component position', () => {
    const [frame] = computeBlockFrames(sheet({
      components: [part('u1', 'io', 100, 100, [{ x: -200, y: 500 }])],
    }))
    // minX=-200 → x=floor(-280/10)*10=-280, clamped to 0; maxX=100 → 180 wide.
    // minY=100 → y=floor(-40/10)*10=-40, clamped to 0; maxY=500 → 580 tall.
    expect(frame).toMatchObject({ x: 0, y: 0, width: 180, height: 580 })
  })

  it('uses the declared block title and orders declared blocks first', () => {
    const frames = computeBlockFrames(sheet({
      blocks: [
        { name: 'mcu', title: 'MCU CORE' },
        { name: 'power', title: 'POWER SUPPLY' },
      ],
      components: [
        part('u2', 'zzz-undeclared', 900, 100),
        part('u1', 'mcu', 100, 100),
        part('u3', 'power', 500, 100),
      ],
    }))
    expect(frames.map(frame => frame.name)).toEqual(['mcu', 'power', 'zzz-undeclared'])
    expect(frames[0]?.title).toBe('MCU CORE')
    expect(frames[1]?.title).toBe('POWER SUPPLY')
    expect(frames[2]?.title).toBe('zzz-undeclared')
  })

  it('clamps the frame onto a smaller custom pageSize', () => {
    const [frame] = computeBlockFrames(sheet({
      components: [part('u1', 'io', 1100, 800)],
    }), { width: 500, height: 400 })
    // Right/bottom clamp at the custom frame instead of A4's 1170/825.
    expect(frame).toMatchObject({ x: 1020, y: 660, width: 0, height: 0 })
    const [frameA3] = computeBlockFrames(sheet({
      components: [part('u1', 'io', 1100, 800)],
    }), { width: 1654, height: 1169 })
    // On A3 the padded box (1100+80 → 1180, 800+80 → 880) fits without clamping.
    expect(frameA3).toMatchObject({ x: 1020, y: 660, width: 160, height: 220 })
  })

  it('mixes declared, titleless declared, and free-form names in stable order', () => {
    const frames = computeBlockFrames(sheet({
      blocks: [{ name: 'd1', title: 'D1' }, { name: 'd2' }],
      components: [
        part('c1', 'd2', 700, 100),
        part('c2', 'omega', 300, 100),
        part('c3', 'd1', 100, 100),
        part('c4', 'alpha', 500, 100),
      ],
    }))
    // Declared blocks lead in declaration order, free-form names follow
    // alphabetically; a titleless declared block falls back to its name.
    expect(frames.map(frame => [frame.name, frame.title])).toEqual([
      ['d1', 'D1'],
      ['d2', 'd2'],
      ['alpha', 'alpha'],
      ['omega', 'omega'],
    ])
  })
})
