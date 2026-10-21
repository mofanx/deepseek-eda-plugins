// t54: offline self-test for t52's restore loop.
//
// No EDA window, no bridge, no real MAIN: `runRestore(deps)` is driven with an
// in-memory world. Every rejection case also asserts `deleteCalls === 0`, so a
// "refused" run that still deleted something cannot pass.
//
// Cases:
//   1. id not in the reviewed 42            -> PRECONDITIONS_FAILED, 0 deleted
//   2. ComponentType is not netflag         -> PRECONDITIONS_FAILED, 0 deleted
//   3. active document is not MAIN          -> PRECONDITIONS_FAILED, 0 deleted
//   4. coordinates moved since the snapshot -> PRECONDITIONS_FAILED, 0 deleted
//   5. valid id + valid state               -> OK, exactly that id deleted
//   6. delta !== 1 after a delete           -> COMPONENT_DELTA_2, 0 recorded
//   7. already gone BEFORE the run          -> ALREADY_GONE_PREFLIGHT, 0 deleted
//   8. already gone DURING the run          -> ALREADY_GONE_DURING_RUN, abort
//
// Run: node docs/evidence/review/t54-restore-selftest.mjs

import { runRestore } from './t52-main-restore.mjs'

const MAIN = 'M'
const row = (id, type = 'netflag', x = 400, y = 200, net = 'MCU-99') => ({ id, type, x, y, net })

function makeWorld ({ rows, wires = 55, wireNets = 55, active = MAIN, pages = [{ uuid: MAIN, name: 'MAIN' }], afterDelete = null }) {
  const state = { rows: rows.map((r) => ({ ...r })), wires, wireNets, active, pages }
  let deleteCalls = 0
  const readAll = async () => ({
    active: state.active,
    pages: state.pages.map((p) => ({ ...p })),
    rows: state.rows.map((r) => ({ ...r })),
    wires: state.wires,
    wireNets: state.wireNets
  })
  const deleteOne = async (id) => {
    deleteCalls++
    const i = state.rows.findIndex((r) => r.id === id)
    if (i >= 0) state.rows.splice(i, 1)
    if (afterDelete) afterDelete(state, id)
    return 'true'
  }
  return { state, readAll, deleteOne, calls: () => deleteCalls }
}

const check = (cond, msg) => { if (!cond) throw new Error(msg) }

const cases = [
  {
    name: '01 reject: id not in the reviewed 42',
    async run () {
      const w = makeWorld({ rows: [row('a'), row('keep')] })
      const rep = await runRestore({ readAll: w.readAll, deleteOne: w.deleteOne, set: ['a'], all42: [], snapshot: { components: [row('a')], wires: [] }, limit: 1, execute: true, sleep: async () => {} })
      check(rep.exitCode === 2, `exitCode ${rep.exitCode}`)
      check(rep.aborted === 'PRECONDITIONS_FAILED', `aborted ${rep.aborted}`)
      check(rep.deleted.length === 0, `deleted ${rep.deleted.length}`)
      check(w.calls() === 0, `deleteOne called ${w.calls()} times`)
      return rep
    }
  },
  {
    name: '02 reject: ComponentType is not netflag',
    async run () {
      const w = makeWorld({ rows: [row('a', 'part'), row('keep')] })
      const rep = await runRestore({ readAll: w.readAll, deleteOne: w.deleteOne, set: ['a'], all42: ['a'], snapshot: { components: [row('a')], wires: [] }, limit: 1, execute: true, sleep: async () => {} })
      check(rep.exitCode === 2 && rep.aborted === 'PRECONDITIONS_FAILED', `exit=${rep.exitCode} aborted=${rep.aborted}`)
      check(rep.deleted.length === 0 && w.calls() === 0, 'deleted despite wrong type')
      return rep
    }
  },
  {
    name: '03 reject: active document is not MAIN',
    async run () {
      const w = makeWorld({ rows: [row('a'), row('keep')], active: 'OTHER' })
      const rep = await runRestore({ readAll: w.readAll, deleteOne: w.deleteOne, set: ['a'], all42: ['a'], snapshot: { components: [row('a')], wires: [] }, limit: 1, execute: true, sleep: async () => {} })
      check(rep.exitCode === 2 && rep.aborted === 'PRECONDITIONS_FAILED', `exit=${rep.exitCode} aborted=${rep.aborted}`)
      check(rep.deleted.length === 0 && w.calls() === 0, 'deleted while another document was active')
      return rep
    }
  },
  {
    name: '04 reject: coordinates moved since the snapshot',
    async run () {
      const w = makeWorld({ rows: [row('a', 'netflag', 900, 900), row('keep')] })
      const rep = await runRestore({ readAll: w.readAll, deleteOne: w.deleteOne, set: ['a'], all42: ['a'], snapshot: { components: [row('a', 'netflag', 400, 200)], wires: [] }, limit: 1, execute: true, sleep: async () => {} })
      check(rep.exitCode === 2 && rep.aborted === 'PRECONDITIONS_FAILED', `exit=${rep.exitCode} aborted=${rep.aborted}`)
      check(rep.deleted.length === 0 && w.calls() === 0, 'deleted a moved primitive')
      return rep
    }
  },
  {
    name: '05 accept: valid id and valid state',
    async run () {
      const w = makeWorld({ rows: [row('a'), row('keep')] })
      const rep = await runRestore({ readAll: w.readAll, deleteOne: w.deleteOne, set: ['a'], all42: ['a'], snapshot: { components: [row('a')], wires: [] }, limit: 1, execute: true, sleep: async () => {} })
      check(rep.exitCode === 0 && rep.status === 'OK', `exit=${rep.exitCode} status=${rep.status} aborted=${rep.aborted}`)
      check(rep.deleted.length === 1 && rep.deleted[0] === 'a', `deleted=${JSON.stringify(rep.deleted)}`)
      check(w.calls() === 1, `deleteOne called ${w.calls()} times`)
      check(w.state.rows.length === 1 && w.state.rows[0].id === 'keep', 'the wrong primitive survived')
      return rep
    }
  },
  {
    name: '06 abort: COMPONENT_DELTA is not 1',
    async run () {
      // Deleting 'a' also makes 'x' disappear: the count drops by 2.
      const w = makeWorld({ rows: [row('a'), row('x'), row('keep')], afterDelete: (s) => { const i = s.rows.findIndex((r) => r.id === 'x'); if (i >= 0) s.rows.splice(i, 1) } })
      const rep = await runRestore({ readAll: w.readAll, deleteOne: w.deleteOne, set: ['a'], all42: ['a'], snapshot: { components: [row('a'), row('x')], wires: [] }, limit: 1, execute: true, sleep: async () => {} })
      check(rep.exitCode === 2 && rep.aborted === 'COMPONENT_DELTA_2', `exit=${rep.exitCode} aborted=${rep.aborted}`)
      check(rep.deleted.length === 0, `recorded as deleted: ${JSON.stringify(rep.deleted)}`)
      return rep
    }
  },
  {
    name: '07 abort: id already gone BEFORE the run',
    async run () {
      const w = makeWorld({ rows: [row('keep')] })
      const rep = await runRestore({ readAll: w.readAll, deleteOne: w.deleteOne, set: ['a'], all42: ['a'], snapshot: { components: [row('a')], wires: [] }, limit: 1, execute: true, sleep: async () => {} })
      check(rep.exitCode === 2 && rep.aborted === 'ALREADY_GONE_PREFLIGHT', `exit=${rep.exitCode} aborted=${rep.aborted}`)
      check(rep.deleted.length === 0 && w.calls() === 0, 'deleted after seeing a preflight already-gone')
      return rep
    }
  },
  {
    name: '08 abort: id already gone DURING the run (was a silent skip)',
    async run () {
      // 'b' disappears between two reads; 'c' appears so the count still drops by 1.
      // The loop must stop at the missing id instead of skipping it.
      const w = makeWorld({
        rows: [row('a'), row('b')],
        afterDelete: (s) => {
          const i = s.rows.findIndex((r) => r.id === 'b')
          if (i >= 0) s.rows.splice(i, 1)
          s.rows.push(row('c', 'netflag', 1, 1))
        }
      })
      const rep = await runRestore({ readAll: w.readAll, deleteOne: w.deleteOne, set: ['a', 'b'], all42: ['a', 'b'], snapshot: { components: [row('a'), row('b')], wires: [] }, limit: 2, execute: true, sleep: async () => {} })
      check(rep.exitCode === 2 && rep.aborted === 'ALREADY_GONE_DURING_RUN', `exit=${rep.exitCode} aborted=${rep.aborted}`)
      check(rep.deleted.length === 1 && rep.deleted[0] === 'a', `deleted=${JSON.stringify(rep.deleted)}`)
      check(!rep.deleted.includes('b'), 'b was recorded as deleted after it had vanished')
      return rep
    }
  }
]

let pass = 0
console.log(`t54 restore self-test: ${cases.length} cases, fake bridge only (no EDA window)`)
for (const c of cases) {
  try {
    const rep = await c.run()
    pass++
    console.log(`PASS ${c.name} -> exit=${rep.exitCode} status=${rep.status} aborted=${rep.aborted ?? '-'} deleted=${JSON.stringify(rep.deleted)}`)
  } catch (e) {
    console.log(`FAIL ${c.name} -> ${e.message}`)
  }
}
console.log(`TOTAL ${pass}/${cases.length} passed`)
process.exit(pass === cases.length ? 0 : 2)
