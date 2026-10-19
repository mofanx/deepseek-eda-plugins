/**
 * HTTP reply helpers for the bridge server.
 *
 * The bridge is a long-lived process that every agent depends on, so a client
 * that vanishes mid-response must never take it down. Node throws
 * `ERR_HTTP_HEADERS_SENT` on a second `writeHead`, and an exception thrown out
 * of an `async` request handler becomes an unhandled rejection, which Node
 * (>=15) turns into a process exit. Both failure modes were reachable from
 * `POST /eda-windows/select`: the handler called `res.writeHead` from its
 * `catch` block without checking whether the `try` block had already sent
 * headers, so one `select` with a valid window id killed the bridge. A second
 * path reaches the same ending without any handler bug: when a client aborts
 * mid-body, `for await (const chunk of req)` rejects with `Error: aborted`,
 * which escapes the `async` handler the same way.
 */

/** Minimal surface of `http.ServerResponse` these helpers rely on. */
const isDone = (res) =>
  res.headersSent === true || res.writableEnded === true || res.destroyed === true

/** Message of an unknown thrown value, without trusting it to be an Error. */
export const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error)

/**
 * Send a JSON reply, tolerating a response that is already committed or whose
 * socket has gone away.
 *
 * @param {import('node:http').ServerResponse} res - the response to write to.
 * @param {number} status - HTTP status code.
 * @param {unknown} payload - value serialized as the JSON body.
 * @returns {boolean} true when this call wrote the reply, false when it was
 *   skipped because the response was already sent, ended, or destroyed, or
 *   when the write itself failed (which is logged).
 */
export function replyJson(res, status, payload) {
  if (isDone(res)) return false
  try {
    const body = payload === undefined ? '' : JSON.stringify(payload)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(body)
    return true
  } catch (error) {
    // Skipping an already-sent response is routine and silent; a write that
    // actually failed is not, so it is logged. Without this the client would
    // just hang with no trace in the bridge log.
    console.error(`[HTTP] reply failed: ${errorMessage(error)}`)
    return false
  }
}

/**
 * Wrap an async HTTP handler so it can never reject.
 *
 * A handler that throws after replying is not sent a second status line (that
 * would re-introduce `ERR_HTTP_HEADERS_SENT`); its socket is destroyed
 * instead, which is the only honest signal left to the client. The error is
 * reported to `onError` (default `console.error`) so the failure stays visible
 * in the bridge log.
 *
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler - request handler.
 * @param {(message: string, error: unknown) => void} [onError] - error sink.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} a handler that never rejects.
 */
export function guardHttpHandler(handler, onError) {
  const report = onError ?? ((message, error) => console.error(message, error))
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      const message = `[HTTP] handler failed: ${errorMessage(error)}`
      if (!replyJson(res, 500, { success: false, error: errorMessage(error) })) {
        try {
          res.destroy()
        } catch { /* socket already gone */ }
      }
      try {
        report(message, error)
      } catch { /* a throwing error sink must not re-open the escape hatch */ }
    }
  }
}
