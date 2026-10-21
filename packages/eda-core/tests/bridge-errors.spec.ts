import { describe, expect, it } from 'vitest'
import {
  EASYEDA_BRIDGE_LANDING_URL,
  EASYEDA_BRIDGE_REMEDIES,
  HttpEasyEdaBridge,
  bridgeFailureMessage,
  classifyTransportFailure,
} from '@deepseek-ai/dsh-plugin-eda-core'

const health = (edaConnected = true) =>
  new Response(JSON.stringify({ service: 'easyeda-bridge', edaConnected }), { status: 200 })

/** Build the undici-style chain a real fetch rejection carries. */
const transportError = (code: string, message = 'fetch failed') =>
  Object.assign(new Error(message), { cause: Object.assign(new Error(code), { code }) })

const bridgeWith = (fetchFn: typeof fetch) =>
  new HttpEasyEdaBridge('http://127.0.0.1:49620', { fetchFn, timeoutMs: 30, timeoutStreakLimit: 99 })

describe('bridge failure codes', () => {
  it('classifies a connect-phase timeout as CONNECT_TIMEOUT, not a generic timeout', async () => {
    const error = transportError('UND_ERR_CONNECT_TIMEOUT', 'connect timeout')
    const bridge = bridgeWith((async () => { throw error }) as typeof fetch)
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({
      code: 'SCHEMATIC_BRIDGE_CONNECT_TIMEOUT',
      message: expect.stringContaining('NEW TAB IN THE SAME BROWSER'),
    }))
  })

  it('classifies a dropped connection as DISCONNECTED and keeps the original error as cause', async () => {
    const error = transportError('ECONNRESET')
    const bridge = bridgeWith((async () => { throw error }) as typeof fetch)
    let caught: unknown
    try {
      await bridge.execute('x')
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ code: 'SCHEMATIC_BRIDGE_DISCONNECTED' })
    expect((caught as { cause?: unknown }).cause).toBe(error)
    expect((caught as Error).message).toMatch(/restart it with "dsh-eda-bridge"/)
  })

  it('reports WINDOW_LOST when a window that had served a call disappears', async () => {
    let served = false
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/health')) return health(served === false)
      if (!served) {
        served = true
        return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 })
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    }) as typeof fetch
    const bridge = bridgeWith(fetchFn)
    await expect(bridge.execute('first')).resolves.toEqual({ ok: true })
    await expect(bridge.execute('second')).rejects.toThrow(expect.objectContaining({
      code: 'SCHEMATIC_BRIDGE_WINDOW_LOST',
      message: expect.stringContaining('SAME BROWSER'),
    }))
  })

  it('keeps NO_EDA when the client never reached the editor', async () => {
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/health')) return health(false)
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    }) as typeof fetch
    const bridge = bridgeWith(fetchFn)
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({
      code: 'SCHEMATIC_BRIDGE_NO_EDA',
      message: expect.stringContaining('edaConnected:true'),
    }))
  })

  it('turns a 503 "no window" response into WINDOW_LOST once a window was seen', async () => {
    let served = false
    const fetchFn = (async (input: unknown) => {
      if (String(input).endsWith('/health')) return health(true)
      if (!served) {
        served = true
        return new Response(JSON.stringify({ result: 1 }), { status: 200 })
      }
      return new Response('no easyeda window connected', { status: 503 })
    }) as typeof fetch
    const bridge = bridgeWith(fetchFn)
    await bridge.execute('first')
    await expect(bridge.execute('second')).rejects.toThrow(expect.objectContaining({
      code: 'SCHEMATIC_BRIDGE_WINDOW_LOST',
      message: expect.stringContaining('HTTP 503'),
    }))
  })

  it('classifies only known transport causes and leaves generic failures alone', () => {
    expect(classifyTransportFailure(transportError('ETIMEDOUT'))).toBe('SCHEMATIC_BRIDGE_CONNECT_TIMEOUT')
    expect(classifyTransportFailure(transportError('EPIPE'))).toBe('SCHEMATIC_BRIDGE_DISCONNECTED')
    expect(classifyTransportFailure(new Error('boom'))).toBeUndefined()
  })

  it('gives every code a next step and names the landing precondition', () => {
    for (const [code, remedy] of Object.entries(EASYEDA_BRIDGE_REMEDIES)) {
      expect(remedy.nextStep.length, code).toBeGreaterThan(20)
      expect(typeof remedy.retryable, code).toBe('boolean')
    }
    const landingCodes = ['SCHEMATIC_BRIDGE_NO_EDA', 'SCHEMATIC_BRIDGE_WINDOW_LOST'] as const
    for (const code of landingCodes) {
      expect(EASYEDA_BRIDGE_REMEDIES[code].nextStep).toContain(EASYEDA_BRIDGE_LANDING_URL)
      expect(EASYEDA_BRIDGE_REMEDIES[code].nextStep).toMatch(/NEW TAB IN THE SAME BROWSER/)
    }
    expect(bridgeFailureMessage('SCHEMATIC_BRIDGE_WINDOW_LOST', 'detail')).toContain('detail — next:')
  })
})
