// t40: is there a NetLabel namespace, and can a wire's label position be set?
import { gateFreshness } from './shared/freshness.mjs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '../../..')
const pkgDir = join(repoRoot, 'packages')
gateFreshness(repoRoot)
const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const r = await bridge.execute(`
const names = Object.keys(eda).filter(k => /^sch_Primitive/.test(k));
const proto = [];
let q = eda.sch_PrimitiveWire;
while (q && q !== Object.prototype) { for (const k of Object.getOwnPropertyNames(q)) proto.push(k); q = Object.getPrototypeOf(q) }
const methods = [...new Set(proto)].filter(k => { try { return typeof eda.sch_PrimitiveWire[k] === 'function' } catch (e) { return false } });
return {
  schNamespaces: names.sort(),
  hasNetLabel: typeof eda.sch_PrimitiveNetLabel,
  wireMethods: methods.sort(),
  wireLabelish: methods.filter(k => /label|net|text/i.test(k)),
};
`, { timeoutMs: 60_000 })
console.log(JSON.stringify(r, null, 1))
