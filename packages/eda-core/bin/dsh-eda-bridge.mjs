#!/usr/bin/env node
/**
 * EasyEDA WebSocket Bridge Server
 *
 * Node.js WebSocket server bridging an AI host and a running EasyEDA Pro
 * client. The EasyEDA extension (run-api-gateway) connects outbound through
 * `eda.sys_WebSocket.register()`; the host submits code-execution requests
 * over HTTP or a WebSocket.
 *
 * Architecture:
 *   ┌──────────────┐   HTTP/WS     ┌────────────────┐   WebSocket    ┌──────────┐
 *   │   AI Agent    │ ◄───────────► │  Bridge Server  │ ◄───────────► │  EasyEDA  │
 *   │               │  Port Range   │  (this server)  │  Port Range   │  (Client) │
 *   └──────────────┘  49620-49629  └────────────────┘  49620-49629   └──────────┘
 *                                      │                 ws://127.0.0.1:49630
 *                                      └── also binds ──► (built-in gateway)
 *
 * Port range 49620-49629; the first free port is picked at startup. A second
 * listener binds 49630, the fixed endpoint the editor's built-in
 * run-api-gateway dials after an `api/landing?port=` BroadcastChannel trigger
 * (the `port` param is metadata only — the gateway always uses 49630); a busy
 * 49630 downgrades to a warning, not a failure. A second invocation exits
 * when a compatible bridge already answers /health; a foreign implementation
 * holding the service id (marked via the `bridge` health field) fails startup
 * unless `--force` is passed.
 *
 * Handshake verification:
 * - GET /health returns { service: "easyeda-bridge", ... }
 * - Every WebSocket connection receives { type: "handshake",
 *   service: "easyeda-bridge" } first; clients verify `service` before
 *   trusting the socket.
 *
 * Message protocol (JSON):
 * {
 *   "type": "execute" | "result" | "error" | "ping" | "pong" | "handshake" | "register",
 *   "id": "<request-uuid>",
 *   "code": "<js code string>",            // execute
 *   "windowId": "<eda window id>",         // execute (optional) / register
 *   "result": <any>,                        // result
 *   "error": "<error message>",             // error
 *   "timestamp": <unix ms>
 * }
 *
 * HTTP endpoints:
 * - GET  /health              liveness + EDA connection state
 * - GET  /eda-windows         list connected EDA windows
 * - POST /eda-windows/select  { "windowId": "..." } pick the active window
 * - POST /execute             { "code": "...", "windowId"?: "..." }
 */

import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { createServer, get as httpGet } from 'node:http'
import { createConnection } from 'node:net'

// ─── Port configuration ─────────────────────────────────────────────
const PORT_START = 49620
const PORT_END = 49629
// The editor's built-in run-api-gateway hard-codes ws://127.0.0.1:49630 and
// cannot be pointed elsewhere (the api/landing `port` param is forwarded in
// the register payload only), so the bridge binds it alongside the range.
const BUILTIN_GATEWAY_PORT = 49630
const SERVICE_ID = 'easyeda-bridge'
const IMPLEMENTATION_ID = 'dsh-eda-bridge'
const LISTEN_HOST = '127.0.0.1'

function formatBannerLine(label, value) {
  return `║  ${`${label}:`.padEnd(12)} ${String(value).padEnd(44)}║`
}

// ─── State ──────────────────────────────────────────────────────────
/** @type {Map<string, import('ws').WebSocket>} EDA window ID -> WebSocket */
const edaClients = new Map()

/** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout, windowId: string}>} */
const pendingRequests = new Map()

/** Currently selected EDA window ID on the agent side. */
let activeEdaWindowId = null

const REQUEST_TIMEOUT_MS = 30_000

// ─── Port detection ─────────────────────────────────────────────────

/**
 * Check if a TCP port is already in use.
 * @param {number} port
 * @returns {Promise<boolean>} true when the port accepts a connection
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.setTimeout(300)
    socket.on('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

/**
 * Read the implementation marker of the bridge service on a port, or null
 * when the port does not answer as `easyeda-bridge`. A missing `bridge`
 * field means the legacy bridge-server script — wire-identical, so it is
 * reported as this implementation.
 * @param {number} port
 * @returns {Promise<string|null>} implementation id, or null when not a bridge
 */
function bridgeImplementation(port) {
  return new Promise((resolve) => {
    const req = httpGet(`http://127.0.0.1:${port}/health`, { timeout: 800 }, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          resolve(json.service === SERVICE_ID ? (typeof json.bridge === 'string' ? json.bridge : IMPLEMENTATION_ID) : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

/**
 * Detect an already-running bridge service in the port range.
 * @returns {Promise<{port: number, implementation: string}|null>} the existing
 * instance's port and implementation marker, or null
 */
async function findExistingInstance() {
  const ports = []
  for (let port = PORT_START; port <= PORT_END; port++) ports.push(port)
  ports.push(BUILTIN_GATEWAY_PORT)
  for (const port of ports) {
    const implementation = await bridgeImplementation(port)
    if (implementation !== null) return { port, implementation }
  }
  return null
}

/**
 * Find the first available port in range.
 * @returns {Promise<number>}
 */
async function findAvailablePort() {
  for (let port = PORT_START; port <= PORT_END; port++) {
    if (!await isPortInUse(port)) return port
  }
  throw new Error(`All ports in range ${PORT_START}-${PORT_END} are in use`)
}

// ─── HTTP server (agents submit code via HTTP POST) ─────────────────
const httpHandler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // Health check — carries the service identifier for handshake verification
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      service: SERVICE_ID,
      bridge: IMPLEMENTATION_ID,
      status: 'ok',
      edaConnected: edaClients.size > 0,
      edaWindowCount: edaClients.size,
      activeWindowId: activeEdaWindowId,
      pendingRequests: pendingRequests.size,
      timestamp: Date.now(),
    }))
    return
  }

  // List all connected EDA windows
  if (req.method === 'GET' && req.url === '/eda-windows') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    const windows = []
    for (const [windowId, ws] of edaClients) {
      windows.push({
        windowId,
        connected: ws.readyState === 1,
        active: windowId === activeEdaWindowId,
      })
    }
    res.end(JSON.stringify({
      windows,
      activeWindowId: activeEdaWindowId,
      count: edaClients.size,
    }))
    return
  }

  // Select the active EDA window
  if (req.method === 'POST' && req.url === '/eda-windows/select') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { windowId } = JSON.parse(body)
      if (!edaClients.has(windowId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `EDA window "${windowId}" not found` }))
        return
      }
      activeEdaWindowId = windowId
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, activeWindowId }))
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid request body' }))
    }
    return
  }

  // Execute code on the EDA client
  if (req.method === 'POST' && req.url === '/execute') {
    let body = ''
    for await (const chunk of req) body += chunk

    try {
      const payload = JSON.parse(body)
      const code = payload.code
      const windowId = payload.windowId // optional; defaults to the active window
      if (!code || typeof code !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing "code" field (string)' }))
        return
      }

      const result = await executeOnEda(code, windowId)
      // Serialize before writeHead: an unserializable result must reach the
      // error branch below, not crash the server on a second writeHead.
      const reply = JSON.stringify({ success: true, result, windowId: windowId || activeEdaWindowId })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(reply)
    } catch (err) {
      // The caller may have aborted its HTTP request while the EDA-side
      // execute was still running — writes on a dead socket must not take
      // the server down.
      try {
        if (res.headersSent || res.writableEnded || res.destroyed) return
        const status = err.message?.includes('not connected') ? 503 : 500
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: err.message }))
      } catch { /* response socket already gone */ }
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
}

// ─── WebSocket handlers ─────────────────────────────────────────────

function attachEdaClient(ws) {
  let registeredWindowId = null
  // Liveness tracking for the heartbeat sweep below: a dead-but-unclosed
  // socket (editor reload, wedged gateway page) would otherwise keep the
  // window registered forever while every execute queues up and times out.
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  const onMessage = (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      // The built-in gateway registers with tabId; the community extension
      // uses windowId — either identifies an EDA window the same way.
      if (msg.type === 'register' && (msg.windowId || msg.tabId)) {
        registeredWindowId = msg.windowId ?? msg.tabId
        edaClients.set(registeredWindowId, ws)
        // Auto-select the first window, or replace a lost selection
        if (edaClients.size === 1 || !activeEdaWindowId) {
          activeEdaWindowId = registeredWindowId
        }
        console.log(`[WS] EDA window registered: ${registeredWindowId}, total: ${edaClients.size}`)
        return
      }
      handleEdaMessage(msg, registeredWindowId || 'unregistered')
    } catch (err) {
      console.error('[WS] Failed to parse EDA message:', err.message)
    }
  }

  ws.on('message', onMessage)

  ws.on('close', (code, reason) => {
    console.log(`[WS] EDA window disconnected: ${registeredWindowId} (${code} ${reason})`)
    if (registeredWindowId) {
      edaClients.delete(registeredWindowId)
      if (activeEdaWindowId === registeredWindowId) {
        activeEdaWindowId = edaClients.keys().next().value || null
      }
      // Reject requests still in flight for the departed window
      for (const [id, req] of pendingRequests) {
        if (req.windowId === registeredWindowId) {
          clearTimeout(req.timer)
          req.reject(new Error(`EDA window "${registeredWindowId}" disconnected`))
          pendingRequests.delete(id)
        }
      }
    }
  })

  ws.on('error', (err) => {
    console.error('[WS] EDA client error:', err.message)
  })

  return onMessage
}

function attachAgentClient(ws) {
  const onMessage = async (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'execute') {
        try {
          const result = await executeOnEda(msg.code, msg.windowId)
          ws.send(JSON.stringify({
            type: 'result',
            id: msg.id,
            result,
            timestamp: Date.now(),
          }))
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'error',
            id: msg.id,
            error: err.message,
            timestamp: Date.now(),
          }))
        }
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', id: msg.id, timestamp: Date.now() }))
      }
    } catch (err) {
      console.error('[WS] Failed to parse agent message:', err.message)
    }
  }

  ws.on('message', onMessage)

  ws.on('close', () => {
    console.log('[WS] Agent client disconnected')
  })

  return onMessage
}

function createBridgeServer() {
  const srv = createServer(httpHandler)
  const wss = new WebSocketServer({ server: srv })

  wss.on('connection', (ws, req) => {
    if (req.url === '/eda' || req.url === '/agent') {
      const clientType = req.url === '/eda' ? 'eda' : 'agent'
      console.log(`[WS] New ${clientType} connection from ${req.socket.remoteAddress}`)
      ws.send(JSON.stringify({ type: 'handshake', service: SERVICE_ID, clientType, timestamp: Date.now() }))
      return clientType === 'eda' ? attachEdaClient(ws) : attachAgentClient(ws)
    }

    // The built-in gateway dials the ws root, so an unrecognised path is
    // classified by its first message — register{windowId|tabId} marks an
    // EDA window, anything else an agent.
    console.log(`[WS] New unclassified connection from ${req.socket.remoteAddress} (${req.url})`)
    ws.send(JSON.stringify({ type: 'handshake', service: SERVICE_ID, clientType: 'unknown', timestamp: Date.now() }))
    let settled = false
    ws.on('message', (raw) => {
      if (settled) return
      settled = true
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'register' && (msg.windowId || msg.tabId)) {
          return attachEdaClient(ws)(raw)
        }
      } catch { /* a malformed first message falls through to agent handling */ }
      attachAgentClient(ws)(raw)
    })
  })

  return srv
}

const httpServer = createBridgeServer()
const gatewayServer = createBridgeServer()
let gatewayAttempted = false

// Heartbeat: ping every registered EDA window and terminate any that missed
// the previous pong. `terminate()` fires 'close', which unregisters the
// window — health then reports edaConnected:false instead of a stale entry.
const HEARTBEAT_MS = 15_000
setInterval(() => {
  for (const client of edaClients.values()) {
    if (client.isAlive === false) {
      try { client.terminate() } catch { /* socket already gone */ }
      continue
    }
    client.isAlive = false
    try { client.ping() } catch { try { client.terminate() } catch { /* socket already gone */ } }
  }
}, HEARTBEAT_MS).unref()

// ─── Core logic ─────────────────────────────────────────────────────

/**
 * Send a message to a connected EDA window.
 * @param {string} windowId - target EDA window ID
 * @param {object} msg - message to send
 */
function sendToEda(windowId, msg) {
  const edaClient = edaClients.get(windowId)
  if (!edaClient) {
    throw new Error(`EDA window "${windowId}" not found in connected clients`)
  }
  if (edaClient.readyState !== 1) {
    throw new Error(`EDA window "${windowId}" is not in connected state (readyState: ${edaClient.readyState})`)
  }
  try {
    edaClient.send(JSON.stringify(msg))
  } catch (err) {
    throw new Error(`Failed to send to EDA window "${windowId}": ${err.message}`)
  }
}

/**
 * Execute JavaScript inside the EDA client and return its result.
 * @param {string} code - JavaScript evaluated in the EDA extension context
 * @param {string} [windowId] - target window; defaults to the active window
 * @returns {Promise<any>} the client's `result` payload
 */
function executeOnEda(code, windowId) {
  return new Promise((resolve, reject) => {
    const targetWindowId = windowId || activeEdaWindowId

    if (!targetWindowId) {
      reject(new Error('No EDA window connected. Please connect an EDA window first.'))
      return
    }

    if (!edaClients.has(targetWindowId) || edaClients.get(targetWindowId).readyState !== 1) {
      reject(new Error(`EDA window "${targetWindowId}" is no longer connected. Please select another window.`))
      return
    }

    const id = randomUUID()
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error(`Request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`))
    }, REQUEST_TIMEOUT_MS)

    pendingRequests.set(id, { resolve, reject, timer, windowId: targetWindowId })

    try {
      sendToEda(targetWindowId, {
        type: 'execute',
        id,
        code,
        windowId: targetWindowId,
        timestamp: Date.now(),
      })
    } catch (err) {
      clearTimeout(timer)
      pendingRequests.delete(id)
      reject(err)
    }
  })
}

/**
 * Handle messages received from an EDA window.
 * @param {object} msg - parsed message
 * @param {string} windowId - window that sent it
 */
function handleEdaMessage(msg, windowId) {
  if (msg.type === 'ping') {
    const edaClient = edaClients.get(windowId)
    if (edaClient && edaClient.readyState === 1) {
      try {
        edaClient.send(JSON.stringify({ type: 'pong', id: msg.id, timestamp: Date.now() }))
      } catch (err) {
        console.error(`[WS] Failed to send pong to ${windowId}:`, err.message)
      }
    } else {
      console.warn(`[WS] Cannot send pong: window ${windowId} not found or disconnected`)
    }
    return
  }

  if (msg.type === 'pong') {
    return
  }

  if (msg.type === 'result' || msg.type === 'error') {
    const pending = pendingRequests.get(msg.id)
    if (pending) {
      clearTimeout(pending.timer)
      pendingRequests.delete(msg.id)
      if (msg.type === 'result') {
        pending.resolve(msg.result)
      } else {
        pending.reject(new Error(msg.error || 'Unknown EDA error'))
      }
    }
    return
  }

  console.log('[EDA] Unknown message type:', msg.type, 'from window:', windowId)
}

// ─── Start ──────────────────────────────────────────────────────────
async function start() {
  try {
    // Singleton: an identical bridge already serving the range is reused. A
    // foreign implementation squatting the service id (e.g. a token-authed
    // platform daemon) cannot serve this protocol, so refuse rather than
    // silently claim success; --force binds a separate port alongside it.
    const existing = await findExistingInstance()
    if (existing) {
      if (existing.implementation === IMPLEMENTATION_ID) {
        console.log(`Bridge server is already running on port ${existing.port}; no new instance started.`)
        process.exit(0)
      }
      if (!process.argv.includes('--force')) {
        console.error(`A different easyeda-bridge implementation (${existing.implementation}) is already running on port ${existing.port}.`)
        console.error('Stop it first, or pass --force to bind a separate port anyway.')
        process.exit(1)
      }
      console.error(`Warning: a different easyeda-bridge implementation (${existing.implementation}) is on port ${existing.port}; continuing under --force.`)
    }

    const port = await findAvailablePort()

    // The built-in gateway port is a fixed second endpoint; a busy 49630
    // (foreign bridge, older instance) only forfeits that trigger path. Guard
    // the bind so the EADDRINUSE retry below does not re-listen this server.
    if (!gatewayServer.listening && !gatewayAttempted) {
      gatewayAttempted = true
      gatewayServer.once('error', (err) => {
        console.error(`Built-in gateway port ${BUILTIN_GATEWAY_PORT} unavailable: ${err.message}`)
      })
      gatewayServer.listen(BUILTIN_GATEWAY_PORT, LISTEN_HOST, () => {
        console.log(`Built-in gateway endpoint listening on ws://${LISTEN_HOST}:${BUILTIN_GATEWAY_PORT}`)
      })
    }

    httpServer.listen(port, LISTEN_HOST, () => {
      console.log(`
╔══════════════════════════════════════════════════════════════╗
║         EasyEDA WebSocket Bridge Server                      ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
${formatBannerLine('Port', port)}
${formatBannerLine('Listen Host', `${LISTEN_HOST} (localhost only)`)}
${formatBannerLine('Port Range', `${PORT_START}-${PORT_END}`)}
${formatBannerLine('Service ID', SERVICE_ID)}
║                                                              ║
║  HTTP API:    http://localhost:${port}                         ║
║  WS (EDA):   ws://localhost:${port}/eda                       ║
║  WS (Agent): ws://localhost:${port}/agent                     ║
║  WS (built-in gateway): ws://localhost:${BUILTIN_GATEWAY_PORT}          ║
║                                                              ║
║  Endpoints:                                                  ║
║    GET  /health     - liveness & EDA connection state        ║
║    POST /execute    - run code {"code": "..."}               ║
║                                                              ║
║  Handshake:                                                  ║
║    /health returns { service: "${SERVICE_ID}" }       ║
║    WS sends { type: "handshake", service: "..." }            ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
      `)
    })

    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} became occupied. Restarting...`)
        httpServer.close()
        start()
      } else {
        throw err
      }
    })
  } catch (err) {
    console.error(`${err.message}`)
    process.exit(1)
  }
}

start()
