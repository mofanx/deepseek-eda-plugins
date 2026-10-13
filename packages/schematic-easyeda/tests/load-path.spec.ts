/**
 * Real Loader-path guard for an injected namespace plugin. A default export would make
 * `unwrapExports` collapse the namespace and drop `inject`, causing access to `ctx.schematic` to fail.
 * Hand-built mounting bypasses that path, so this test unwraps through the real Loader first; see
 * postmortem 0001.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SchematicRuntime from '@deepseek-ai/dsh-plugin-eda-sch'
import * as enginePlugin from '@deepseek-ai/dsh-plugin-eda-easyeda'

describe('dsh-plugin-eda-easyeda real-load-path guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in enginePlugin).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(enginePlugin) as Record<string, unknown>
    expect(unwrapped).toBe(enginePlugin)
    expect(unwrapped.name).toBe('schematic-easyeda')
    expect(unwrapped.inject).toEqual(['schematic'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('registers the easyeda engine over ctx.schematic through the unwrapped module', async () => {
    const ctx = new Context()
    await ctx.plugin(SchematicRuntime, {})

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(enginePlugin) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped)
    expect(ctx.schematic.engine().id).toBe('easyeda')
    await fiber.dispose()
    expect(() => ctx.schematic.engine()).toThrow(expect.objectContaining({ code: 'SCHEMATIC_ENGINE_UNAVAILABLE' }))
  })
})
