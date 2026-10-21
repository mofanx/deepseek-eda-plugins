// t10: hard confirmation that a probe page really disappeared.
//
// The bridge's `deleteSchematicPage` return value is not trustworthy: this session
// measured `false + still there`, `true + still there` and `true + gone`. A script
// that reads only the return value therefore reports a clean cleanup while the
// page survives, which is how the page count crept up run after run.
//
// So every script that creates a page calls this with the id it recorded before
// deleting, and the verdict comes from a re-listing with increasing waits, never
// from the delete return value.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Re-list pages until `id` disappears or the attempts are exhausted.
 * Each wait is baseMs * 2^i (default 400, 800, 1600 ms).
 * A listing error is treated as "not confirmed", never as gone.
 */
export async function confirmPageGone(list, id, { attempts = 3, baseMs = 400 } = {}) {
  if (typeof id !== 'string' || id === '') {
    return { gone: false, leakedId: id ?? null, attempts: [], error: 'no-probe-id' }
  }
  const steps = []
  for (let i = 0; i < attempts; i++) {
    const waitMs = baseMs * (2 ** i)
    await sleep(waitMs)
    let pages = null
    let error = null
    try {
      pages = await list()
    } catch (e) {
      error = String((e && e.message) || e)
    }
    const present = Array.isArray(pages) ? pages.includes(id) : null
    steps.push({ attempt: i + 1, waitMs, listed: Array.isArray(pages), present, count: Array.isArray(pages) ? pages.length : null, error })
    if (present === false) return { gone: true, leakedId: null, attempts: steps }
  }
  // One last listing so the report names the page only when it is really there.
  let finalCount = null
  try {
    const pages = await list()
    finalCount = Array.isArray(pages) ? pages.length : null
    if (Array.isArray(pages) && !pages.includes(id)) return { gone: true, leakedId: null, attempts: steps, finalCount }
  } catch (e) {
    steps.push({ attempt: attempts + 1, final: true, error: String((e && e.message) || e) })
  }
  return { gone: false, leakedId: id, attempts: steps, finalCount }
}

/**
 * Save the probe page, but only while it is provably the active document.
 *
 * `eda.sch_Document.save()` takes no argument and writes whatever document is
 * active. Called blindly it can persist a concurrent member's page - including
 * their unsaved edits - which is a data-loss bug, not a cleanup bug. So:
 *   1. read the active document id;
 *   2. if it is not the probe, open the probe once and re-read;
 *   3. still not the probe -> DO NOT SAVE, report SKIPPED_FOREIGN_ACTIVE and let
 *      the caller fall through to the delete path (a page we could not save may
 *      simply survive; leaving it is the lesser harm).
 * The probe must never be MAIN: saving MAIN would flush the user's project.
 */
export async function saveOwnDocument({ readActive, openDocument, save, probe, main, sleepMs = 900 }) {
  if (typeof probe !== 'string' || probe === '') return { attempted: false, mode: 'NO_PROBE' }
  if (probe === main) return { attempted: false, mode: 'REFUSED_TARGET_IS_MAIN', probe }
  let activeBefore = null
  try {
    activeBefore = (await readActive()) ?? null
  } catch (e) {
    return { attempted: false, mode: 'READ_ACTIVE_FAILED', error: String((e && e.message) || e) }
  }
  let activeAfter = activeBefore
  let switched = false
  if (activeAfter !== probe) {
    try {
      await openDocument(probe)
    } catch (e) {
      // A failed switch must not be papered over: it is reported as "no save".
    }
    switched = true
    await sleep(sleepMs)
    try {
      activeAfter = (await readActive()) ?? null
    } catch (e) {
      return { attempted: false, mode: 'READ_ACTIVE_FAILED', activeBefore, switched, error: String((e && e.message) || e) }
    }
  }
  if (activeAfter !== probe) {
    return {
      attempted: false,
      mode: 'SKIPPED_FOREIGN_ACTIVE',
      activeBefore,
      activeAfter,
      switched,
      note: 'sch_Document.save() takes no id; saving now would write a document this run does not own',
    }
  }
  try {
    const value = await save()
    return { attempted: true, mode: 'OWN', activeBefore, activeAfter, switched, saved: true, value: value === undefined ? null : value }
  } catch (e) {
    return { attempted: true, mode: 'OWN', activeBefore, activeAfter, switched, saved: false, error: String((e && e.message) || e) }
  }
}
