/**
 * JSON endpoints of the bridge HTTP server, extracted from the bin so they can
 * be exercised without binding a port.
 *
 * Dependency injection is deliberate: `activeEdaWindowId` is module state in
 * the bin, and the select endpoint once shipped a typo that referenced a
 * non-existent `activeWindowId`. That `ReferenceError` was thrown *after*
 * `res.writeHead(200)`, so the handler's own `catch` tried to send a second
 * status line and Node killed the process with `ERR_HTTP_HEADERS_SENT` — every
 * agent lost its bridge to one `POST /eda-windows/select`. Routing the state
 * through `getActiveWindowId`/`setActiveWindowId` keeps the endpoint testable
 * so the class of bug is caught by a unit test instead of production.
 */
import { replyJson } from './http-guard.mjs'

/** Read a request body as UTF-8 text. */
const readBody = async (req) => {
  let body = ''
  for await (const chunk of req) body += chunk
  return body
}

/**
 * Build the JSON request handler.
 *
 * @param {object} deps - injected bridge state and operations.
 * @param {Map<string, {readyState: number}>} deps.edaClients - registered EDA windows.
 * @param {Map<string, unknown>} deps.pendingRequests - in-flight execute requests.
 * @param {string} deps.serviceId - handshake service identifier.
 * @param {string} deps.implementationId - bridge implementation identifier.
 * @param {() => string | null} deps.getActiveWindowId - current active window.
 * @param {(windowId: string) => void} deps.setActiveWindowId - switch active window.
 * @param {(code: string, windowId?: string) => Promise<unknown>} deps.execute - run code on the EDA side.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>} handler resolving true when it answered the request.
 */
export function createHttpApi({
  edaClients,
  pendingRequests,
  serviceId,
  implementationId,
  getActiveWindowId,
  setActiveWindowId,
  execute,
}) {
  return async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      replyJson(res, 200, {
        service: serviceId,
        bridge: implementationId,
        status: 'ok',
        edaConnected: edaClients.size > 0,
        edaWindowCount: edaClients.size,
        activeWindowId: getActiveWindowId(),
        pendingRequests: pendingRequests.size,
        timestamp: Date.now(),
      })
      return true
    }

    if (req.method === 'GET' && req.url === '/eda-windows') {
      const windows = []
      for (const [windowId, ws] of edaClients) {
        windows.push({ windowId, connected: ws.readyState === 1, active: windowId === getActiveWindowId() })
      }
      replyJson(res, 200, { windows, activeWindowId: getActiveWindowId(), count: edaClients.size })
      return true
    }

    if (req.method === 'POST' && req.url === '/eda-windows/select') {
      let windowId
      try {
        ;({ windowId } = JSON.parse(await readBody(req)))
      } catch {
        // Parse failures are the only thing that maps to 400; keeping them
        // apart from write failures means a vanished client is never reported
        // as bad JSON.
        replyJson(res, 400, { error: 'Invalid request body' })
        return true
      }
      if (!edaClients.has(windowId)) {
        replyJson(res, 404, { error: `EDA window "${windowId}" not found` })
        return true
      }
      setActiveWindowId(windowId)
      replyJson(res, 200, { success: true, activeWindowId: getActiveWindowId() })
      return true
    }

    if (req.method === 'POST' && req.url === '/execute') {
      let payload
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        replyJson(res, 400, { error: 'Invalid request body' })
        return true
      }
      const code = payload?.code
      if (!code || typeof code !== 'string') {
        replyJson(res, 400, { error: 'Missing "code" field (string)' })
        return true
      }
      try {
        const result = await execute(code, payload.windowId)
        // Serialize before writeHead: an unserializable result must reach the
        // error branch below, not become a second writeHead.
        const reply = JSON.stringify({ success: true, result, windowId: payload.windowId || getActiveWindowId() })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(reply)
      } catch (err) {
        // The two unavailability messages `executeOnEda` raises are
        // "No EDA window connected. …" (nothing registered) and
        // `EDA window "…" is no longer connected. …` (the selected window went
        // away). Both mean the same to a caller — the request never reached an
        // editor — so both map to 503 rather than a generic 500. Matching
        // `not connected` alone missed the second one, which is why the
        // alternation spells out all three phrasings.
        const message = String(err?.message ?? '')
        const unavailable = /no eda window connected|not connected|no longer connected/i.test(message)
        replyJson(res, unavailable ? 503 : 500, { success: false, error: err?.message })
      }
      return true
    }

    return false
  }
}
