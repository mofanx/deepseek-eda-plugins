/**
 * run-api-gateway bridge client for the live EasyEDA build path. The bridge is a
 * localhost HTTP relay (port range 49620–49630, `easyeda-bridge` handshake) that
 * evaluates JavaScript bodies inside the running EasyEDA Pro extension runtime.
 * {@link EasyEdaBridge} is the injectable boundary: tests substitute a scripted
 * mock and never touch a real client.
 * @module @deepseek-ai/dsh-plugin-eda-easyeda/bridge
 */

import { SchematicError } from '@deepseek-ai/dsh-plugin-eda-sch'
import { deadline, timeoutOf, TimeoutReason } from '@deepseek-ai/dsh-timeout'

/** True when a fetch rejection was caused by our own bridge deadline. */
function bridgeTimedOut(error: unknown): boolean {
  if (error instanceof TimeoutReason) return error.code === 'SCHEMATIC_BRIDGE_TIMEOUT'
  return timeoutOf(error as { reason?: unknown }, 'SCHEMATIC_BRIDGE_TIMEOUT') !== undefined
}

/** First port the run-api-gateway bridge listens on (protocol constant). */
export const EASYEDA_BRIDGE_PORT_MIN = 49620

/**
 * Last port scanned for a run-api-gateway bridge. The editor's built-in
 * gateway dials the fixed 49630 endpoint, so the bridge also listens there.
 */
export const EASYEDA_BRIDGE_PORT_MAX = 49630

/**
 * Implementation marker this package's bridge (`bin/dsh-eda-bridge.mjs`)
 * reports in `/health`. Other tools may squat the `easyeda-bridge` service id
 * with an incompatible protocol (e.g. a token-authed daemon); a health payload
 * carrying a different `bridge` marker is skipped during discovery. An absent
 * marker means the legacy bridge-server script, which is wire-identical.
 */
export const EASYEDA_BRIDGE_IMPLEMENTATION = 'dsh-eda-bridge'

/** Per-call overrides accepted by {@link EasyEdaBridge.execute}. */
export interface EasyEdaBridgeExecuteOptions {
  /** Timeout for this call in milliseconds; defaults to the client's `timeoutMs`. */
  readonly timeoutMs?: number | undefined
}

/**
 * The injectable bridge boundary: one code-body execution inside the EasyEDA
 * extension runtime. Implementations transport the body verbatim; results are
 * JSON-serializable values the body `return`ed.
 */
export interface EasyEdaBridge {
  /**
   * Evaluate a JavaScript body with the `eda` API object in scope.
   * @param code - async function body; it must `return` the value to send back.
   * @param options - per-call overrides such as a shorter read timeout.
   * @returns the value the body returned.
   */
  execute(code: string, options?: EasyEdaBridgeExecuteOptions): Promise<unknown>
}

/** Options for {@link HttpEasyEdaBridge.discover} and construction. */
export interface HttpEasyEdaBridgeOptions {
  /** Bridge host; the run-api-gateway server is a localhost relay. */
  readonly host?: string | undefined
  /** Fetch implementation to use (injectable for tests). */
  readonly fetchFn?: typeof fetch | undefined
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number | undefined
  /**
   * Consecutive execute timeouts that open the fail-fast circuit. The
   * extension gateway serializes page-side work, so one hung call blocks every
   * later call; the circuit turns the pile-up into instant
   * `SCHEMATIC_BRIDGE_CIRCUIT_OPEN` failures instead of a full-timeout stall
   * per call.
   */
  readonly timeoutStreakLimit?: number | undefined
  /** Cooldown before a half-open probe retries the client, in milliseconds. */
  readonly circuitCooldownMs?: number | undefined
}

interface BridgeHealth {
  service?: unknown
  edaConnected?: unknown
  bridge?: unknown
}

/**
 * HTTP client for the run-api-gateway bridge. `execute` POSTs the code body to
 * `/execute` and unwraps `{result}`/`{type:"result",result}` payloads; remote
 * errors surface as {@link SchematicError} `SCHEMATIC_BRIDGE_EXECUTION`.
 */
export class HttpEasyEdaBridge implements EasyEdaBridge {
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number
  private readonly timeoutStreakLimit: number
  private readonly circuitCooldownMs: number
  private timeoutStreak = 0
  private circuitOpenUntil = 0

  /**
   * @param baseUrl - the discovered bridge base URL, e.g. `http://127.0.0.1:49620`.
   * @param options - fetch override, per-request timeout, and fail-fast tuning.
   */
  constructor(
    private readonly baseUrl: string,
    options: HttpEasyEdaBridgeOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.timeoutStreakLimit = options.timeoutStreakLimit ?? 3
    this.circuitCooldownMs = options.circuitCooldownMs ?? 15_000
  }

  /**
   * Scan the run-api-gateway port range for the `easyeda-bridge` handshake and
   * return a bound client. Throws `SCHEMATIC_BRIDGE_UNAVAILABLE` when no port
   * answers, and `SCHEMATIC_BRIDGE_NO_EDA` when a bridge answers but no EasyEDA
   * window is connected.
   * @param options - host, fetch override, and per-request timeout.
   * @returns a bridge client bound to the discovered port.
   */
  static async discover(options: HttpEasyEdaBridgeOptions = {}): Promise<HttpEasyEdaBridge> {
    const host = options.host ?? '127.0.0.1'
    const fetchFn = options.fetchFn ?? fetch
    const timeoutMs = options.timeoutMs ?? 30_000
    for (let port = EASYEDA_BRIDGE_PORT_MIN; port <= EASYEDA_BRIDGE_PORT_MAX; port++) {
      const baseUrl = `http://${host}:${port}`
      let health: BridgeHealth | undefined
      const d = deadline(undefined, timeoutMs, 'SCHEMATIC_BRIDGE_TIMEOUT')
      try {
        const res = await fetchFn(`${baseUrl}/health`, { signal: d.signal })
        if (!res.ok) continue
        health = await res.json() as BridgeHealth
      } catch (error) {
        // A closed port or non-JSON listener is not the bridge; keep scanning.
        if (bridgeTimedOut(error)) {
          throw new SchematicError(`easyeda bridge probe timed out at ${baseUrl} after ${timeoutMs}ms`, 'SCHEMATIC_BRIDGE_TIMEOUT')
        }
        continue
      } finally {
        // Explicit dispose: tsx/esbuild's `using` transform hoists the
        // pending-error slot to function scope, so a `using` inside this
        // try would re-throw an earlier iteration's error here.
        d[Symbol.dispose]()
      }
      if (health.service !== 'easyeda-bridge') continue
      if (typeof health.bridge === 'string' && health.bridge !== EASYEDA_BRIDGE_IMPLEMENTATION) continue
      if (health.edaConnected === false) {
        throw new SchematicError(`easyeda bridge at ${baseUrl} has no EasyEDA window connected`, 'SCHEMATIC_BRIDGE_NO_EDA')
      }
      return new HttpEasyEdaBridge(baseUrl, options)
    }
    throw new SchematicError(
      `no easyeda bridge found on ${host} ports ${EASYEDA_BRIDGE_PORT_MIN}–${EASYEDA_BRIDGE_PORT_MAX}`,
      'SCHEMATIC_BRIDGE_UNAVAILABLE',
    )
  }

  /** Short-deadline `/health` read used to classify an execute timeout. */
  private async probeHealth(): Promise<BridgeHealth | undefined> {
    try {
      using d = deadline(undefined, Math.min(this.timeoutMs, 5_000), 'SCHEMATIC_BRIDGE_TIMEOUT')
      const res = await this.fetchFn(`${this.baseUrl}/health`, { signal: d.signal })
      if (!res.ok) return undefined
      return await res.json() as BridgeHealth
    } catch {
      return undefined
    }
  }

  /**
   * Execute a code body via `POST /execute`. Consecutive timeouts open a
   * fail-fast circuit because the page-side gateway serializes executions —
   * retrying behind a hung call only queues more work. Any HTTP response
   * proves the queue drained and closes the circuit.
   * @param code - async function body evaluated with `eda` in scope.
   * @param options - per-call overrides such as a shorter read timeout.
   * @returns the unwrapped result value.
   */
  async execute(code: string, options?: EasyEdaBridgeExecuteOptions): Promise<unknown> {
    if (Date.now() < this.circuitOpenUntil) {
      throw new SchematicError(
        `easyeda bridge execute is fail-fast after ${this.timeoutStreak} consecutive timeouts; next probe at ${new Date(this.circuitOpenUntil).toISOString()}`,
        'SCHEMATIC_BRIDGE_CIRCUIT_OPEN',
      )
    }
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs
    let res: Response
    try {
      using d = deadline(undefined, timeoutMs, 'SCHEMATIC_BRIDGE_TIMEOUT')
      res = await this.fetchFn(`${this.baseUrl}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: d.signal,
      })
    } catch (error) {
      if (bridgeTimedOut(error)) {
        this.timeoutStreak += 1
        if (this.timeoutStreak >= this.timeoutStreakLimit) {
          this.circuitOpenUntil = Date.now() + this.circuitCooldownMs
        }
        // A window that died between registration and execute (editor reload
        // drops the gateway socket) keeps `/health` claiming edaConnected
        // until the server's heartbeat sweeps it. Re-ask before reporting a
        // timeout: a drained window list deserves the actionable NO_EDA.
        if ((await this.probeHealth())?.edaConnected === false) {
          throw new SchematicError(
            `easyeda bridge at ${this.baseUrl} lost its EasyEDA window — reopen the api/landing page to re-register the editor`,
            'SCHEMATIC_BRIDGE_NO_EDA',
          )
        }
        throw new SchematicError(`easyeda bridge execute timed out after ${timeoutMs}ms`, 'SCHEMATIC_BRIDGE_TIMEOUT')
      }
      throw new SchematicError(`easyeda bridge execute failed: ${error instanceof Error ? error.message : String(error)}`, 'SCHEMATIC_BRIDGE_EXECUTION')
    }
    // A completed response — even an error one — means the client-side queue
    // drained; the circuit closes.
    this.timeoutStreak = 0
    if (!res.ok) {
      throw new SchematicError(`easyeda bridge execute returned HTTP ${res.status}`, 'SCHEMATIC_BRIDGE_EXECUTION')
    }
    const body = await res.json() as Record<string, unknown>
    if ('error' in body || body.type === 'error') {
      throw new SchematicError(`easyeda bridge execution error: ${String(body.error ?? body.type)}`, 'SCHEMATIC_BRIDGE_EXECUTION')
    }
    if ('result' in body) return body.result
    throw new SchematicError('easyeda bridge returned an unrecognized response shape', 'SCHEMATIC_BRIDGE_PROTOCOL')
  }
}
