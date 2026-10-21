// t1: self-test for the save guard, with no bridge and no live page.
//
// Why this exists: `eda.sch_Document.save()` takes no document id and writes the
// ACTIVE document. A blind save in a cleanup path can therefore persist another
// member's page (including their unsaved edits). That failure is invisible in a
// normal run - the page count still looks right - so it needs a test that
// provokes it deterministically.
//
// The three cases below are the contract of saveOwnDocument():
//   A. active is already our probe          -> save, mode OWN
//   B. active is foreign but openDocument   -> switch, re-read, save only after
//      restores our probe                      the active id is ours again
//   C. active is foreign and the switch     -> DO NOT save, mode
//      does not work                           SKIPPED_FOREIGN_ACTIVE, saveCalls 0

import { saveOwnDocument } from './shared/page-cleanup.mjs'

const results = []
const check = (name, pass, detail) => results.push({ name, pass, detail })

async function scenario({ active, switchWorks, saveThrows = false }) {
  let saveCalls = 0
  let state = { active }
  const res = await saveOwnDocument({
    probe: 'probe-1',
    main: 'main-1',
    readActive: async () => state.active,
    openDocument: async () => {
      if (switchWorks) state = { active: 'probe-1' }
    },
    save: async () => {
      saveCalls += 1
      if (saveThrows) throw new Error('save exploded')
      return true
    },
    sleepMs: 0,
  })
  return { res, saveCalls, activeAtSave: state.active }
}

{
  const { res, saveCalls, activeAtSave } = await scenario({ active: 'probe-1', switchWorks: false })
  check('A active==probe saves once', res.mode === 'OWN' && res.saved === true && saveCalls === 1, { res, saveCalls, activeAtSave })
}

{
  const { res, saveCalls, activeAtSave } = await scenario({ active: 'foreign-9', switchWorks: true })
  check(
    'B foreign active is switched back before saving',
    res.mode === 'OWN' && res.saved === true && res.switched === true && res.activeBefore === 'foreign-9' && res.activeAfter === 'probe-1' && saveCalls === 1 && activeAtSave === 'probe-1',
    { res, saveCalls, activeAtSave },
  )
}

{
  const { res, saveCalls } = await scenario({ active: 'foreign-9', switchWorks: false })
  check(
    'C unswitchable foreign active is never saved',
    res.mode === 'SKIPPED_FOREIGN_ACTIVE' && res.attempted === false && saveCalls === 0 && res.activeAfter === 'foreign-9',
    { res, saveCalls },
  )
}

{
  const { res, saveCalls } = await scenario({ active: 'probe-1', switchWorks: false, saveThrows: true })
  check('D a throwing save is reported, not swallowed', res.mode === 'OWN' && res.saved === false && typeof res.error === 'string' && saveCalls === 1, { res, saveCalls })
}

{
  const calls = { save: 0 }
  const res = await saveOwnDocument({
    probe: 'main-1',
    main: 'main-1',
    readActive: async () => 'main-1',
    openDocument: async () => {},
    save: async () => {
      calls.save += 1
    },
    sleepMs: 0,
  })
  check('E the probe may never be MAIN', res.mode === 'REFUSED_TARGET_IS_MAIN' && res.attempted === false && calls.save === 0, { res, calls })
}

const failed = results.filter((r) => !r.pass)
console.log(JSON.stringify({ status: failed.length === 0 ? 'OK' : 'FAILED', checks: results }, null, 1))
process.exitCode = failed.length === 0 ? 0 : 1
