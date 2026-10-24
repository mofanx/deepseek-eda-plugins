// r8t5: read-only probe. Asks discover() what it actually throws, and prints
// the FULL message (t53 slices its detail to 200 chars, which hides the tail).
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const repo = resolve('D:/projects/nodejs/deepseek-eda-plugins')
const { HttpEasyEdaBridge } = await import(pathToFileURL(resolve(repo, 'packages/eda-core/lib/index.js')).href)

try {
  const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 15_000 })
  console.log('DISCOVER_OK baseUrl=' + bridge.baseUrl)
} catch (e) {
  console.log('discover threw')
  console.log('  name   = ' + (e && e.name))
  console.log('  code   = ' + (e && e.code))
  console.log('  msgLen = ' + String((e && e.message) || '').length)
  console.log('  message:')
  console.log(String((e && e.message) || e))
}
