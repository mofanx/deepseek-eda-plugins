/**
 * Real Loader-path guard for an injected namespace plugin. A default export would make
 * `unwrapExports` collapse the namespace and drop `inject`, causing access to `ctx.schematic` to fail.
 * Hand-built mounting bypasses that path, so this test unwraps through the real Loader first; see
 * postmortem 0001.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SchematicRuntime from '@deepseek-ai/dsh-plugin-eda-sch'
import * as toolSchematic from '@deepseek-ai/dsh-plugin-eda-sch-gen'

describe('dsh-plugin-eda-sch-gen real-load-path guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in toolSchematic).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolSchematic) as Record<string, unknown>
    expect(unwrapped).toBe(toolSchematic)
    expect(unwrapped.name).toBe('tool-schematic')
    expect(unwrapped.inject).toEqual(['tools', 'schematic', 'systemPrompt'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over the unwrapped module without an inject error and registers both tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SchematicRuntime, {})

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolSchematic) as Parameters<Context['plugin']>[0]
    // Mounting the collapsed shape would throw for missing injection here.
    const fiber = await ctx.plugin(unwrapped)
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(expect.arrayContaining(['schematic_generate', 'schematic_validate']))
    await fiber.dispose()
  })
})
