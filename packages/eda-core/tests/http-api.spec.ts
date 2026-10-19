import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createHttpApi } from '../bin/http-api.mjs'

interface Fake {
  readonly res: ServerResponse
  readonly calls: string[]
  readonly body: () => string
  readonly status: () => number
}

/**
 * Stand-in for `http.ServerResponse` that records writes and can be told to
 * fail like a socket that went away.
 * @param overrides - fields or methods to replace.
 * @returns the response, recorded calls, and status/body accessors.
 */
function fakeResponse(overrides: Record<string, unknown> = {}): Fake {
  let status = 0
  let body = ''
  const calls: string[] = []
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(code: number): unknown {
      calls.push(`head:${code}`)
      status = code
      res.headersSent = true
      return res
    },
    end(payload?: string): unknown {
      calls.push(`end:${payload ?? ''}`)
      body = payload ?? ''
      res.writableEnded = true
      return res
    },
    destroy(): void {
      calls.push('destroy')
    },
    ...overrides,
  }
  return { res: res as unknown as ServerResponse, calls, body: () => body, status: () => status }
}

/** Build a POST request whose async iterator yields the given body once. */
function request(method: string, url: string, body?: string): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  } as unknown as IncomingMessage
}

/**
 * Wire the handler under test with one registered window.
 * @param overrides - dependency replacements.
 * @returns the handler plus the mutable bridge state it was given.
 */
function harness(overrides: Record<string, unknown> = {}) {
  const edaClients = new Map<string, { readyState: number }>([['window-a', { readyState: 1 }]])
  const pendingRequests = new Map<string, unknown>()
  let active: string | null = 'window-a'
  const execute = vi.fn(async () => 42)
  const handler = createHttpApi({
    edaClients,
    pendingRequests,
    serviceId: 'easyeda-bridge',
    implementationId: 'dsh-eda-bridge',
    getActiveWindowId: () => active,
    setActiveWindowId: (windowId: string) => { active = windowId },
    execute,
    ...overrides,
  } as never)
  return { handler, edaClients, pendingRequests, execute, active: () => active }
}

describe('createHttpApi /health', () => {
  it('reports counts, the active window, and a numeric timestamp', async () => {
    const { handler } = harness()
    const fake = fakeResponse()
    await expect(handler(request('GET', '/health'), fake.res)).resolves.toBe(true)
    const payload = JSON.parse(fake.body())
    expect(payload).toMatchObject({
      service: 'easyeda-bridge',
      bridge: 'dsh-eda-bridge',
      status: 'ok',
      edaConnected: true,
      edaWindowCount: 1,
      activeWindowId: 'window-a',
      pendingRequests: 0,
    })
    expect(typeof payload.timestamp).toBe('number')
  })
})

describe('createHttpApi /eda-windows', () => {
  it('lists each window with its connection and active flag', async () => {
    const { handler, edaClients } = harness()
    edaClients.set('window-b', { readyState: 3 })
    const fake = fakeResponse()
    await expect(handler(request('GET', '/eda-windows'), fake.res)).resolves.toBe(true)
    expect(JSON.parse(fake.body())).toEqual({
      windows: [
        { windowId: 'window-a', connected: true, active: true },
        { windowId: 'window-b', connected: false, active: false },
      ],
      activeWindowId: 'window-a',
      count: 2,
    })
  })
})

describe('createHttpApi /eda-windows/select', () => {
  it('switches the active window and echoes it back', async () => {
    // Regression: this endpoint once replied `{ success, activeWindowId }`
    // while the variable in scope was `activeEdaWindowId`. The ReferenceError
    // fired after writeHead(200), the catch block wrote a second status line,
    // and Node killed the bridge. Asserting the echoed id pins the contract.
    const { handler, edaClients, active } = harness()
    edaClients.set('window-b', { readyState: 1 })
    const fake = fakeResponse()
    await expect(handler(request('POST', '/eda-windows/select', '{"windowId":"window-b"}'), fake.res)).resolves.toBe(true)
    expect(fake.status()).toBe(200)
    expect(JSON.parse(fake.body())).toEqual({ success: true, activeWindowId: 'window-b' })
    expect(active()).toBe('window-b')
  })

  it('answers 400 for a body that is not JSON', async () => {
    const { handler } = harness()
    const fake = fakeResponse()
    await handler(request('POST', '/eda-windows/select', 'not-json'), fake.res)
    expect(fake.status()).toBe(400)
    expect(JSON.parse(fake.body())).toEqual({ error: 'Invalid request body' })
  })

  it('answers 404 for an unknown window and keeps the previous selection', async () => {
    const { handler, active } = harness()
    const fake = fakeResponse()
    await handler(request('POST', '/eda-windows/select', '{"windowId":"ghost"}'), fake.res)
    expect(fake.status()).toBe(404)
    expect(JSON.parse(fake.body())).toEqual({ error: 'EDA window "ghost" not found' })
    expect(active()).toBe('window-a')
  })

  it('answers 400 when the request aborts mid-body', async () => {
    const { handler } = harness()
    const fake = fakeResponse()
    const aborted = {
      method: 'POST',
      url: '/eda-windows/select',
      async *[Symbol.asyncIterator]() {
        throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' })
      },
    } as unknown as IncomingMessage
    await handler(aborted, fake.res)
    expect(fake.status()).toBe(400)
  })
})

describe('createHttpApi /execute', () => {
  it('runs the code and returns its result', async () => {
    const { handler, execute } = harness()
    const fake = fakeResponse()
    await expect(handler(request('POST', '/execute', '{"code":"return 42"}'), fake.res)).resolves.toBe(true)
    expect(execute).toHaveBeenCalledWith('return 42', undefined)
    expect(fake.status()).toBe(200)
    expect(JSON.parse(fake.body())).toEqual({ success: true, result: 42, windowId: 'window-a' })
  })

  it('honours an explicit windowId', async () => {
    const { handler, execute } = harness()
    const fake = fakeResponse()
    await handler(request('POST', '/execute', '{"code":"return 1","windowId":"window-b"}'), fake.res)
    expect(execute).toHaveBeenCalledWith('return 1', 'window-b')
    expect(JSON.parse(fake.body())).toEqual({ success: true, result: 42, windowId: 'window-b' })
  })

  it('answers 400 when code is missing or not a string', async () => {
    for (const body of ['{}', '{"code":7}', 'not-json']) {
      const { handler, execute } = harness()
      const fake = fakeResponse()
      await handler(request('POST', '/execute', body), fake.res)
      expect(fake.status()).toBe(400)
      expect(execute).not.toHaveBeenCalled()
    }
  })

  it('maps an unconnected-window failure to 503', async () => {
    const execute = vi.fn(async () => {
      throw new Error('No EDA window connected. Please connect an EDA window first.')
    })
    const { handler } = harness({ execute })
    const fake = fakeResponse()
    await handler(request('POST', '/execute', '{"code":"return 1"}'), fake.res)
    expect(fake.status()).toBe(503)
    expect(JSON.parse(fake.body())).toMatchObject({ success: false })
  })

  it('maps both real unavailability messages to 503 and any other failure to 500', async () => {
    // These strings are the ones the bridge actually rejects with
    // (bin/dsh-eda-bridge.mjs: "No EDA window connected. …" and
    // `EDA window "…" is no longer connected. …`). The second one used to fall
    // through to 500 because the match only looked for "not connected".
    for (const [message, status] of [
      ['No EDA window connected. Please connect an EDA window first.', 503],
      ['EDA window "abc" is no longer connected. Please select another window.', 503],
      ['boom', 500],
    ] as const) {
      const execute = vi.fn(async () => {
        throw new Error(message)
      })
      const { handler } = harness({ execute })
      const fake = fakeResponse()
      await handler(request('POST', '/execute', '{"code":"return 1"}'), fake.res)
      expect(fake.status()).toBe(status)
    }
  })

  it('does not throw when the result cannot be serialized', async () => {
    const execute = vi.fn(async () => ({ big: 10n }))
    const { handler } = harness({ execute })
    const fake = fakeResponse()
    await expect(handler(request('POST', '/execute', '{"code":"return 1"}'), fake.res)).resolves.toBe(true)
    expect(fake.status()).toBe(500)
    expect(JSON.parse(fake.body())).toMatchObject({ success: false })
  })
})

describe('createHttpApi routing', () => {
  it('declines unknown routes so the caller can answer 404', async () => {
    const { handler } = harness()
    const fake = fakeResponse()
    await expect(handler(request('GET', '/nope'), fake.res)).resolves.toBe(false)
    expect(fake.calls).toEqual([])
  })
})
