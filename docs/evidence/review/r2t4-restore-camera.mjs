// r2t4: restore the editor camera to the fit-all view (the capture run dropped its connection
// before its own restore step). Read-only: zoomToAllPrimitives is a view operation.
import { HttpEasyEdaBridge } from '../../../packages/schematic-easyeda/lib/index.js'

const b = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const r = await b.execute('return await eda.dmt_EditorControl.zoomToAllPrimitives()', { timeoutMs: 60_000 })
console.log(JSON.stringify(r))
