// r6t1 step 0: is the read-only bridge available? Probe only, no writes.
import { HttpEasyEdaBridge } from '../../../packages/schematic-easyeda/lib/index.js'

try {
  const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 15_000 })
  const pages = await bridge.execute('return await eda.dmt_Schematic.getAllSchematicPagesInfo()', { timeoutMs: 20_000 })
  console.log('BRIDGE OK pages=' + (Array.isArray(pages) ? pages.length : 'n/a'))
  process.exit(0)
} catch (error) {
  console.log('BRIDGE UNAVAILABLE: ' + (error?.message ?? error))
  process.exit(2)
}
