import type { ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { errorMessage, guardHttpHandler, replyJson } from '../bin/http-guard.mjs'

interface FakeResponse {
  readonly res: ServerResponse
  readonly calls: string[]
  readonly status: () => number
  readonly body: () => string
}

/**
 * Minimal stand-in for `http.ServerResponse` that records what the helpers do
 * and can be told to fail the way a vanished socket does.
 * @param overrides - fields or methods to replace.
 * @returns the response, its recorded calls, and accessors for status/body.
 */
function fakeResponse(overrides: Record<string, unknown> = {}): FakeResponse {
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
      res.destroyed = true
    },
    ...overrides,
  }
  return { res: res as unknown as ServerResponse, calls, status: () => status, body: () => body }
}

const noopRequest = {} as Parameters<Parameters<typeof guardHttpHandler>[0]>[0]

describe('replyJson', () => {
  it('writes the status and JSON body once', () => {
    const fake = fakeResponse()
    expect(replyJson(fake.res, 200, { ok: true })).toBe(true)
    expect(fake.calls).toEqual(['head:200', 'end:{"ok":true}'])
    expect(fake.status()).toBe(200)
    expect(fake.body()).toBe('{"ok":true}')
  })

  it('writes an empty body when the payload is undefined', () => {
    const fake = fakeResponse()
    expect(replyJson(fake.res, 204, undefined)).toBe(true)
    expect(fake.calls).toEqual(['head:204', 'end:'])
  })

  it('refuses to write after headers were sent', () => {
    const fake = fakeResponse()
    replyJson(fake.res, 200, { ok: true })
    fake.calls.length = 0
    expect(replyJson(fake.res, 500, { ok: false })).toBe(false)
    expect(fake.calls).toEqual([])
  })

  it.each([
    ['writableEnded', { writableEnded: true }],
    ['destroyed', { destroyed: true }],
    ['headersSent', { headersSent: true }],
  ])('refuses to write when the response is already %s', (_label, overrides) => {
    const fake = fakeResponse(overrides)
    expect(replyJson(fake.res, 200, { ok: true })).toBe(false)
    expect(fake.calls).toEqual([])
  })

  it('reports failure instead of throwing when the socket rejects the write', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fake = fakeResponse({
      writeHead: () => {
        throw new Error('ERR_HTTP_HEADERS_SENT')
      },
    })
    expect(replyJson(fake.res, 500, { ok: false })).toBe(false)
    expect(spy).toHaveBeenCalledWith('[HTTP] reply failed: ERR_HTTP_HEADERS_SENT')
    spy.mockRestore()
  })

  it('stays silent when the reply is merely skipped', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fake = fakeResponse({ headersSent: true })
    expect(replyJson(fake.res, 200, { ok: true })).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('errorMessage', () => {
  it('unwraps an Error and stringifies anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})

describe('guardHttpHandler', () => {
  it('passes a completing handler through untouched', async () => {
    const fake = fakeResponse()
    const handler = vi.fn(async () => {
      replyJson(fake.res, 200, { ok: true })
    })
    await guardHttpHandler(handler)(noopRequest, fake.res)
    expect(handler).toHaveBeenCalledOnce()
    expect(fake.calls).toEqual(['head:200', 'end:{"ok":true}'])
  })

  it('converts a thrown handler into a 500 instead of a rejection', async () => {
    const fake = fakeResponse()
    const onError = vi.fn()
    const handler = async (): Promise<void> => {
      throw new Error('handler exploded')
    }
    await expect(guardHttpHandler(handler, onError)(noopRequest, fake.res)).resolves.toBeUndefined()
    expect(fake.calls).toEqual(['head:500', 'end:{"success":false,"error":"handler exploded"}'])
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('handler exploded'), expect.any(Error))
  })

  it('destroys the socket rather than double-writing when the handler already replied', async () => {
    const fake = fakeResponse()
    const onError = vi.fn()
    const handler = async (): Promise<void> => {
      replyJson(fake.res, 200, { ok: true })
      throw new Error('late failure')
    }
    await guardHttpHandler(handler, onError)(noopRequest, fake.res)
    expect(fake.calls).toEqual(['head:200', 'end:{"ok":true}', 'destroy'])
    expect(onError).toHaveBeenCalledOnce()
  })

  it('logs through console.error when no sink is provided', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fake = fakeResponse()
    await guardHttpHandler(async () => {
      throw new Error('unlogged')
    })(noopRequest, fake.res)
    expect(spy).toHaveBeenCalledWith('[HTTP] handler failed: unlogged', expect.any(Error))
    spy.mockRestore()
  })

  it('never rejects even when the error sink itself throws', async () => {
    const fake = fakeResponse()
    const onError = vi.fn(() => {
      throw new Error('sink exploded')
    })
    await expect(
      guardHttpHandler(async () => {
        throw new Error('original')
      }, onError)(noopRequest, fake.res),
    ).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledOnce()
    expect(fake.status()).toBe(500)
  })

  it('stringifies a non-Error throw', async () => {
    const fake = fakeResponse()
    const onError = vi.fn()
    await guardHttpHandler((async () => {
      throw 'string failure'
    }) as never, onError)(noopRequest, fake.res)
    expect(fake.body()).toBe('{"success":false,"error":"string failure"}')
    expect(onError).toHaveBeenCalledWith('[HTTP] handler failed: string failure', 'string failure')
  })
})
