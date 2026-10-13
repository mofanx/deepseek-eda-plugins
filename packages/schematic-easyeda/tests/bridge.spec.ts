import { describe, expect, it } from 'vitest'
import {
  EASYEDA_BRIDGE_PORT_MAX,
  EASYEDA_BRIDGE_PORT_MIN,
  HttpEasyEdaBridge,
} from '@deepseek-ai/dsh-plugin-eda-easyeda'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'

/** A scripted fetch: maps each requested URL to a canned Response or a thrown reason. */
function fakeFetch(routes: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return async (input: unknown, init?: RequestInit) => routes(String(input), init)
}

const health = (service: string, edaConnected = true) =>
  new Response(JSON.stringify({ service, edaConnected }), { status: 200 })

describe('HttpEasyEdaBridge.discover', () => {
  it('scans the port range and binds the first easyeda-bridge handshake', async () => {
    const fetchFn = fakeFetch((url) => {
      if (url === `http://127.0.0.1:${EASYEDA_BRIDGE_PORT_MIN}/health`) return new Response('nope', { status: 404 })
      if (url === `http://127.0.0.1:${EASYEDA_BRIDGE_PORT_MIN + 1}/health`) return health('other-service')
      if (url === `http://127.0.0.1:${EASYEDA_BRIDGE_PORT_MIN + 2}/health`) return health('easyeda-bridge')
      return Promise.reject(new Error('closed'))
    })
    const bridge = await HttpEasyEdaBridge.discover({ fetchFn })
    expect(bridge).toBeInstanceOf(HttpEasyEdaBridge)
  })

  it('binds a later port after an earlier probe rejects', async () => {
    const fetchFn = fakeFetch((url) => {
      if (url === `http://127.0.0.1:${EASYEDA_BRIDGE_PORT_MIN}/health`) return Promise.reject(new Error('closed'))
      if (url === `http://127.0.0.1:${EASYEDA_BRIDGE_PORT_MIN + 1}/health`) return health('easyeda-bridge')
      return Promise.reject(new Error('closed'))
    })
    const bridge = await HttpEasyEdaBridge.discover({ fetchFn })
    expect(bridge).toBeInstanceOf(HttpEasyEdaBridge)
  })

  it('skips a health payload marked as a different bridge implementation', async () => {
    const seen: string[] = []
    const foreign = new Response(JSON.stringify({ service: 'easyeda-bridge', bridge: 'agent-platform-daemon', edaConnected: true }), { status: 200 })
    const fetchFn = fakeFetch((url) => {
      seen.push(url)
      if (url === `http://127.0.0.1:${EASYEDA_BRIDGE_PORT_MIN}/health`) return foreign
      if (url === `http://127.0.0.1:${EASYEDA_BRIDGE_PORT_MIN + 1}/health`) return health('easyeda-bridge')
      return Promise.reject(new Error('closed'))
    })
    const bridge = await HttpEasyEdaBridge.discover({ fetchFn })
    expect(bridge).toBeInstanceOf(HttpEasyEdaBridge)
    expect(seen).toContain(`http://127.0.0.1:${EASYEDA_BRIDGE_PORT_MIN + 1}/health`)
  })

  it('honours the host override', async () => {
    const seen: string[] = []
    const fetchFn = fakeFetch((url) => {
      seen.push(url)
      if (url === `http://bridge.internal:${EASYEDA_BRIDGE_PORT_MIN}/health`) return health('easyeda-bridge')
      return Promise.reject(new Error('closed'))
    })
    await HttpEasyEdaBridge.discover({ host: 'bridge.internal', fetchFn })
    expect(seen.every(url => url.startsWith('http://bridge.internal:'))).toBe(true)
  })

  it('throws SCHEMATIC_BRIDGE_NO_EDA when the bridge reports no connected window', async () => {
    const fetchFn = fakeFetch(() => health('easyeda-bridge', false))
    await expect(HttpEasyEdaBridge.discover({ fetchFn }))
      .rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_NO_EDA' }))
  })

  it('throws SCHEMATIC_BRIDGE_UNAVAILABLE when the whole range refuses', async () => {
    const fetchFn = fakeFetch(() => Promise.reject(new Error('closed')))
    await expect(HttpEasyEdaBridge.discover({ fetchFn }))
      .rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_UNAVAILABLE' }))
  })

  it('surfaces a probe timeout as SCHEMATIC_BRIDGE_TIMEOUT', async () => {
    const fetchFn = fakeFetch(() => Promise.reject(new TimeoutReason('SCHEMATIC_BRIDGE_TIMEOUT', 5)))
    await expect(HttpEasyEdaBridge.discover({ fetchFn, timeoutMs: 5 }))
      .rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_TIMEOUT' }))
  })

  it('scans through the full advertised port range', async () => {
    let calls = 0
    const fetchFn = fakeFetch(() => {
      calls += 1
      return Promise.reject(new Error('closed'))
    })
    await expect(HttpEasyEdaBridge.discover({ fetchFn })).rejects.toThrow()
    expect(calls).toBe(EASYEDA_BRIDGE_PORT_MAX - EASYEDA_BRIDGE_PORT_MIN + 1)
  })

  it('falls back to ambient fetch and default timeout when no options are given', async () => {
    // `.invalid` resolves nowhere; the real fetch path ends the scan with a
    // bridge error — UNAVAILABLE on fast refusal, TIMEOUT on a hanging lookup.
    await expect(HttpEasyEdaBridge.discover({ host: 'dsh-bridge.invalid', timeoutMs: 50 }))
      .rejects.toThrow(expect.objectContaining({ name: 'SchematicError' }))
  })
})

describe('HttpEasyEdaBridge.execute', () => {
  async function boundBridge(respond: (url: string, init?: RequestInit) => Response | Promise<Response>): Promise<HttpEasyEdaBridge> {
    return HttpEasyEdaBridge.discover({ fetchFn: fakeFetch((url, init) => url.endsWith('/health') ? health('easyeda-bridge') : respond(url, init)) })
  }

  it('POSTs the code body and unwraps {result}', async () => {
    let sent: string | undefined
    const bridge = await boundBridge(async (_url, init) => {
      sent = typeof init?.body === 'string' ? init.body : undefined
      return new Response(JSON.stringify({ result: 42 }), { status: 200 })
    })
    const out = await bridge.execute('return 42')
    expect(out).toBe(42)
    expect(JSON.parse(sent ?? '')).toEqual({ code: 'return 42' })
  })

  it('unwraps the {type:"result"} envelope too', async () => {
    const bridge = await boundBridge(() => new Response(JSON.stringify({ type: 'result', result: { ok: true } }), { status: 200 }))
    await expect(bridge.execute('return {ok:true}')).resolves.toEqual({ ok: true })
  })

  it('unwraps the real bridge envelope {success,result,windowId}', async () => {
    // Observed on the wire against bridge-server.mjs: 200 with
    // {"success":true,"result":…,"windowId":"<uuid>"}.
    const body = { success: true, result: { created: 5 }, windowId: '6616f55d-d6e7-4db9-aac9-684df8c4cc10' }
    const bridge = await boundBridge(() => new Response(JSON.stringify(body), { status: 200 }))
    await expect(bridge.execute('x')).resolves.toEqual({ created: 5 })
  })

  it('turns an error payload into SCHEMATIC_BRIDGE_EXECUTION', async () => {
    for (const body of [{ error: 'boom' }, { type: 'error', error: 'boom' }, { type: 'error' }]) {
      const bridge = await boundBridge(() => new Response(JSON.stringify(body), { status: 200 }))
      await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_EXECUTION' }))
    }
  })

  it('turns a non-OK status into SCHEMATIC_BRIDGE_EXECUTION', async () => {
    const bridge = await boundBridge(() => new Response('down', { status: 502 }))
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_EXECUTION' }))
  })

  it('turns a fetch rejection into SCHEMATIC_BRIDGE_EXECUTION', async () => {
    const bridge = await boundBridge(() => Promise.reject(new Error('conn reset')))
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_EXECUTION' }))
  })

  it('wraps a non-Error fetch rejection with String()', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- non-Error rejection exercises the String() fallback
    const bridge = await boundBridge(() => Promise.reject('raw failure'))
    await expect(bridge.execute('x')).rejects.toThrow(/raw failure/)
  })

  it('constructs with ambient defaults when no options are passed', () => {
    expect(new HttpEasyEdaBridge('http://127.0.0.1:1')).toBeInstanceOf(HttpEasyEdaBridge)
  })

  it('turns an abort-timeout into SCHEMATIC_BRIDGE_TIMEOUT', async () => {
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/health')) return health('easyeda-bridge')
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const reason: unknown = init.signal?.reason
          reject(reason instanceof Error ? reason : new Error(String(reason)))
        })
      })
    }) as typeof fetch
    const bridge = await HttpEasyEdaBridge.discover({ fetchFn, timeoutMs: 5 })
    await expect(bridge.execute('while(true){}')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_TIMEOUT' }))
  })

  it('turns an unrecognized payload into SCHEMATIC_BRIDGE_PROTOCOL', async () => {
    const bridge = await boundBridge(() => new Response(JSON.stringify({ weird: true }), { status: 200 }))
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_PROTOCOL' }))
  })
})

describe('HttpEasyEdaBridge timeout circuit', () => {
  /** A fetch whose /execute hangs until the abort deadline rejects it. */
  const hanging = (init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const reason: unknown = init.signal?.reason
      reject(reason instanceof Error ? reason : new Error(String(reason)))
    })
  })

  async function circuitBridge(
    respond: (init?: RequestInit) => Response | Promise<Response>,
  ): Promise<{ bridge: HttpEasyEdaBridge; calls: () => number }> {
    let calls = 0
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/health')) return health('easyeda-bridge')
      calls += 1
      return respond(init)
    }) as typeof fetch
    const bridge = await HttpEasyEdaBridge.discover({
      fetchFn,
      timeoutMs: 5,
      timeoutStreakLimit: 2,
      circuitCooldownMs: 40,
    })
    return { bridge, calls: () => calls }
  }

  it('fails fast without fetching once the timeout streak opens the circuit', async () => {
    const { bridge, calls } = await circuitBridge(hanging)
    for (let i = 0; i < 2; i++) {
      await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_TIMEOUT' }))
    }
    const before = calls()
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_CIRCUIT_OPEN' }))
    expect(calls()).toBe(before)
  })

  it('closes the circuit when a half-open probe gets a response', async () => {
    let jammed = true
    const { bridge } = await circuitBridge(init =>
      jammed ? hanging(init) : new Response(JSON.stringify({ result: 'pong' }), { status: 200 }))
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_TIMEOUT' }))
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_TIMEOUT' }))
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_CIRCUIT_OPEN' }))
    jammed = false
    await new Promise(resolve => setTimeout(resolve, 50))
    await expect(bridge.execute('x')).resolves.toBe('pong')
    await expect(bridge.execute('x')).resolves.toBe('pong')
  })

  it('reopens the circuit when the half-open probe still times out', async () => {
    const { bridge, calls } = await circuitBridge(hanging)
    for (let i = 0; i < 2; i++) {
      await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_TIMEOUT' }))
    }
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_CIRCUIT_OPEN' }))
    await new Promise(resolve => setTimeout(resolve, 50))
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_TIMEOUT' }))
    const before = calls()
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_CIRCUIT_OPEN' }))
    expect(calls()).toBe(before)
  })

  it('resets the streak when a request between timeouts completes', async () => {
    let hang = true
    const { bridge } = await circuitBridge(init =>
      hang ? hanging(init) : new Response(JSON.stringify({ result: 1 }), { status: 200 }))
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_TIMEOUT' }))
    hang = false
    await expect(bridge.execute('x')).resolves.toBe(1)
    hang = true
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_TIMEOUT' }))
    await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_TIMEOUT' }))
  })

  it('never opens the circuit on non-timeout failures', async () => {
    const { bridge } = await circuitBridge(() => Promise.reject(new Error('conn reset')))
    for (let i = 0; i < 4; i++) {
      await expect(bridge.execute('x')).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_EXECUTION' }))
    }
  })

  it('honours the per-call timeout override over the client default', async () => {
    const { bridge } = await circuitBridge(hanging)
    await expect(bridge.execute('x', { timeoutMs: 5 }))
      .rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_TIMEOUT' }))
  })
})
