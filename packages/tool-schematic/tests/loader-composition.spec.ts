// Real-composition proof: a test-only cordis.yml booted through the vendored
// Loader mounts the seam, the EasyEDA engine, and the tools together, then
// ctx.tools.execute drives schematic_validate / schematic_generate end to end
// and cordis.yml config reaches both the seam and the tool plugin.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SchematicRuntime from '@deepseek-ai/dsh-plugin-eda-sch'
import * as EasyEdaPlugin from '@deepseek-ai/dsh-plugin-eda-easyeda'
import * as ToolSchematic from '@deepseek-ai/dsh-plugin-eda-sch-gen'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const VALID_DOC = {
  sheets: [{
    components: [
      // Non-physical kinds skip the workspace-binding gate, so the doc stays
      // deliverable whether or not an EasyEDA client happens to be attached.
      { id: 'c1', kind: 'netflag', netName: 'GND', position: { x: 0, y: 50 }, pins: [] },
      { id: 'c2', kind: 'netport', netName: 'SIG', position: { x: 10, y: 50 }, pins: [] },
    ],
    wires: [
      { id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'SIG' },
      { id: 'w2', kind: 'wire', dots: [[0, 10, 10, 10]], net: 'GND' },
    ],
    busEntries: [], junctions: [], attrs: [],
  }],
}

const FLOATING_DOC = {
  sheets: [{
    components: [{
      id: 'c1', kind: 'part', designator: 'U1', position: { x: 0, y: 0 },
      deviceUuid: 'dev', symbolUuid: 'sym', footprintUuid: 'fp',
      pins: [{ id: 'p1', name: 'I', number: '1', electric: 'INPUT', endpoint: { x: 0, y: 0 } }],
    }],
    wires: [], busEntries: [], junctions: [], attrs: [],
  }],
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml with the seam, engine, and tool packages.
 * @param toolConfigLines - YAML lines nested under the tool's `config:` key.
 * @returns the booted context.
 */
async function boot(toolConfigLines: readonly string[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-plugin-eda-sch-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-plugin-eda-sch'",
    '  config:',
    "    engine: 'easyeda'",
    // Point the library bridge at an unroutable TEST-NET-1 host so the spec
    // owns the unreachable-library path even on a machine with a live client.
    "- name: '@deepseek-ai/dsh-plugin-eda-easyeda'",
    '  config:',
    "    bridgeHost: '192.0.2.1'",
    '    bridgeTimeoutMs: 50',
    "- name: '@deepseek-ai/dsh-plugin-eda-sch-gen'",
    ...toolConfigLines.length > 0 ? ['  config:', ...toolConfigLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-plugin-eda-sch', SchematicRuntime],
    ['@deepseek-ai/dsh-plugin-eda-easyeda', EasyEdaPlugin],
    ['@deepseek-ai/dsh-plugin-eda-sch-gen', ToolSchematic],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

let counter = 0
function call(ctx: Context, name: string, args: unknown): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`loader-${++counter}`), name, arguments: args })
}

describe('tool-schematic real Loader composition through cordis.yml', () => {
  it('boots the seam plus engine plus tools and emits EasyEDA source', async () => {
    const ctx = await boot()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining(['schematic_generate', 'schematic_validate']))
    // The yml `engine:` pin reaches the seam.
    expect(ctx.schematic.engine().id).toBe('easyeda')

    const out = await call(ctx, 'schematic_generate', { document: VALID_DOC })
    expect(out.isError).toBe(false)
    expect(resultText(out)).toContain('Emitted easyeda document source')
  }, 30_000)

  it('runs the seam gate through schematic_validate in the same composition', async () => {
    const ctx = await boot()
    const out = await call(ctx, 'schematic_validate', { document: FLOATING_DOC })
    const text = resultText(out)
    expect(text).toContain('Static validation failed')
    expect(text).toContain('FLOATING_INPUT_PIN')
  }, 30_000)

  it('applies the yml maxPrimitives cap before the gate runs', async () => {
    const ctx = await boot(['    maxPrimitives: 3'])
    const out = await call(ctx, 'schematic_generate', { document: VALID_DOC })
    expect(out.isError).toBe(true)
    expect(out.error?.info).toMatchObject({ code: 'SCHEMATIC_IR_BOUNDS' })
  }, 30_000)
})
