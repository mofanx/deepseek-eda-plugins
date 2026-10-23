/**
 * run-api-gateway bridge client for the live EasyEDA build path. The bridge is a
 * localhost HTTP relay (port range 49620–49630, `easyeda-bridge` handshake) that
 * evaluates JavaScript bodies inside the running EasyEDA Pro extension runtime.
 * {@link EasyEdaBridge} is the injectable boundary: tests substitute a scripted
 * mock and never touch a real client.
 * @module @deepseek-ai/dsh-plugin-eda-easyeda/bridge
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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

/**
 * Landing URL that wakes the editor's built-in run-api-gateway and registers
 * the EasyEDA window with the bridge. The `port` param is metadata only — the
 * gateway always dials the fixed `ws://127.0.0.1:49630` endpoint.
 */
export const EASYEDA_BRIDGE_LANDING_URL = 'https://pro.lceda.cn/api/landing?port=49620'

/** Recovery instruction shared by bridge reachability errors. */
const EASYEDA_BRIDGE_REGISTER_HINT = `open ${EASYEDA_BRIDGE_LANDING_URL} as a NEW TAB IN THE SAME BROWSER that holds the web editor tab, after that editor tab has finished loading — a different browser, or opening it before the editor, leaves the relay with no window; to bring a specific schematic into view, double-click its document node in the project tree — openDocument/activateDocument do not switch the visible tab in this build`

/**
 * Stable failure classes a bridge call can end in. Route on the code, never on
 * the message text. The first six predate t3; the last three split failure
 * modes that used to collapse into `NO_EDA` / `TIMEOUT` / `EXECUTION`.
 */
export type EasyEdaBridgeFailureCode =
  | 'SCHEMATIC_BRIDGE_UNAVAILABLE'
  | 'SCHEMATIC_BRIDGE_NO_EDA'
  | 'SCHEMATIC_BRIDGE_TIMEOUT'
  | 'SCHEMATIC_BRIDGE_CIRCUIT_OPEN'
  | 'SCHEMATIC_BRIDGE_EXECUTION'
  | 'SCHEMATIC_BRIDGE_PROTOCOL'
  /** TCP/HTTP connect phase timed out: the relay is not answering at all. */
  | 'SCHEMATIC_BRIDGE_CONNECT_TIMEOUT'
  /** The relay dropped an established connection (reset / socket closed). */
  | 'SCHEMATIC_BRIDGE_DISCONNECTED'
  /** A window was connected earlier in this client, now the relay reports none. */
  | 'SCHEMATIC_BRIDGE_WINDOW_LOST'

/** What a caller should do next for each failure class. */
export interface EasyEdaBridgeRemedy {
  /** True when repeating the same call can succeed without operator action. */
  readonly retryable: boolean
  /** Operator-facing next step; already embedded in the thrown message. */
  readonly nextStep: string
}

/**
 * Remedy table, one entry per {@link EasyEdaBridgeFailureCode}. Messages are
 * built from this table so the guidance cannot drift between call sites.
 */
export const EASYEDA_BRIDGE_REMEDIES: Record<EasyEdaBridgeFailureCode, EasyEdaBridgeRemedy> = {
  SCHEMATIC_BRIDGE_UNAVAILABLE: {
    retryable: true,
    nextStep: `start the relay with "dsh-eda-bridge" (the bin ships inside @deepseek-ai/dsh-plugin-eda-core), then ${EASYEDA_BRIDGE_REGISTER_HINT}`,
  },
  SCHEMATIC_BRIDGE_NO_EDA: {
    retryable: false,
    nextStep: `the relay is up but no editor is registered — ${EASYEDA_BRIDGE_REGISTER_HINT}; confirm /health reports edaConnected:true before retrying`,
  },
  SCHEMATIC_BRIDGE_TIMEOUT: {
    retryable: true,
    nextStep: `the editor may be busy or wedged — retry once; if timeouts persist, reload the editor tab and re-register it: ${EASYEDA_BRIDGE_REGISTER_HINT}`,
  },
  SCHEMATIC_BRIDGE_CONNECT_TIMEOUT: {
    retryable: true,
    nextStep: `the relay accepted no connection in time — check that "dsh-eda-bridge" is running and that port 49620 is reachable, then retry; if it still times out, restart the relay, then ${EASYEDA_BRIDGE_REGISTER_HINT}`,
  },
  SCHEMATIC_BRIDGE_DISCONNECTED: {
    retryable: true,
    nextStep: `an established connection was dropped — retry once; if the relay itself died, restart it with "dsh-eda-bridge", then ${EASYEDA_BRIDGE_REGISTER_HINT}`,
  },
  SCHEMATIC_BRIDGE_WINDOW_LOST: {
    retryable: false,
    nextStep: `the editor window that was registered earlier is gone (reload or client restart) — ${EASYEDA_BRIDGE_REGISTER_HINT}`,
  },
  SCHEMATIC_BRIDGE_CIRCUIT_OPEN: {
    retryable: true,
    nextStep: `the fail-fast circuit is open after consecutive timeouts — wait for the cooldown, then reload the editor tab and re-register it: ${EASYEDA_BRIDGE_REGISTER_HINT}`,
  },
  SCHEMATIC_BRIDGE_EXECUTION: {
    retryable: true,
    nextStep: 'the body ran and failed, or the relay returned an error response — read the original message below, fix the call, then retry',
  },
  SCHEMATIC_BRIDGE_PROTOCOL: {
    retryable: false,
    nextStep: 'the relay answered with an unrecognized shape — check that "dsh-eda-bridge" is the implementation on that port (another daemon may have squatted it)',
  },
}

/** Build the operator-facing message for a failure class. */
export function bridgeFailureMessage(code: EasyEdaBridgeFailureCode, detail?: string): string {
  const remedy = EASYEDA_BRIDGE_REMEDIES[code]
  return detail === undefined ? remedy.nextStep : `${detail} — next: ${remedy.nextStep}`
}

/** Every string a thrown value carries: its code, message, and chained causes. */
function failureText(value: unknown): string {
  const parts: string[] = []
  let current: unknown = value
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (typeof current === 'string') {
      parts.push(current)
      break
    }
    if (typeof current !== 'object') break
    const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (typeof code === 'string') parts.push(code)
    if (typeof message === 'string') parts.push(message)
    current = cause
  }
  return parts.join(' | ')
}

/**
 * Map a transport-level throw to the specific class it belongs to, or
 * `undefined` when it is a generic execution failure (keep `EXECUTION`).
 * @param error - the value `fetch` rejected with.
 * @returns the failure code, or undefined when no known transport cause matches.
 */
export function classifyTransportFailure(error: unknown): EasyEdaBridgeFailureCode | undefined {
  const text = failureText(error)
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|connect time(?:d )?out/i.test(text)) return 'SCHEMATIC_BRIDGE_CONNECT_TIMEOUT'
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|socket hang up|other side closed|ECONNREFUSED/i.test(text)) return 'SCHEMATIC_BRIDGE_DISCONNECTED'
  return undefined
}

/**
 * Spawn the bundled `dsh-eda-bridge` bin detached so a first live call can
 * bring the relay up itself. `DSH_EDA_BRIDGE_BIN` overrides the script path;
 * tests point it at a fixture that exits immediately.
 * @returns the detached child process so a caller that spawned it can reap it.
 */
export function spawnEasyEdaBridge(): ChildProcess {
  const script = process.env.DSH_EDA_BRIDGE_BIN ?? fileURLToPath(new URL('../bin/dsh-eda-bridge.mjs', import.meta.url))
  const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', console.warn)
  child.unref()
  return child
}

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
  /**
   * When a localhost scan finds no bridge, spawn the bundled
   * `dsh-eda-bridge` bin detached and rescan briefly (default `true`). Set
   * `false` to keep discovery purely passive — tests and locked-down
   * runtimes.
   */
  readonly autoSpawn?: boolean | undefined
  /**
   * Injectable spawn used by auto-spawn (tests substitute a stub); defaults
   * to {@link spawnEasyEdaBridge}.
   */
  readonly spawnBridge?: (() => unknown) | undefined
  /** How long auto-spawn waits for the spawned bridge to answer, in milliseconds. */
  readonly autoSpawnWaitMs?: number | undefined
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
   * Set once this client has completed a call, which proves an editor window was
   * registered. A later "no window" is then a loss, not an initial state.
   */
  private sawWindow = false

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
   * answers, `SCHEMATIC_BRIDGE_NO_EDA` when a bridge answers but no EasyEDA
   * window is connected — both messages carry the recovery steps — and
   * `SCHEMATIC_BRIDGE_TIMEOUT` when a probe stalls. When a localhost scan
   * finds nothing, the bundled `dsh-eda-bridge` bin is spawned detached and
   * the scan retries for `autoSpawnWaitMs`; `autoSpawn: false` keeps
   * discovery purely passive.
   * @param options - host, fetch override, timeouts, and auto-spawn controls.
   * @returns a bridge client bound to the discovered port.
   */
  static async discover(options: HttpEasyEdaBridgeOptions = {}): Promise<HttpEasyEdaBridge> {
    const host = options.host ?? '127.0.0.1'
    try {
      return await HttpEasyEdaBridge.scanRange(options, host)
    } catch (error) {
      // Spawning a local relay cannot fix a scan of a remote host.
      const passive = options.autoSpawn === false || (host !== '127.0.0.1' && host !== 'localhost')
      if (passive || (error as SchematicError).code !== 'SCHEMATIC_BRIDGE_UNAVAILABLE') throw error
    }
    try {
      (options.spawnBridge ?? spawnEasyEdaBridge)()
    } catch { /* the rescan below reports the outcome */ }
    const waitUntil = Date.now() + (options.autoSpawnWaitMs ?? 4_000)
    for (;;) {
      try {
        return await HttpEasyEdaBridge.scanRange(options, host)
      } catch (error) {
        if ((error as SchematicError).code !== 'SCHEMATIC_BRIDGE_UNAVAILABLE') throw error
        if (Date.now() >= waitUntil) {
          throw new SchematicError(
            `no easyeda bridge found on ${host} ports ${EASYEDA_BRIDGE_PORT_MIN}–${EASYEDA_BRIDGE_PORT_MAX} after auto-spawn — start it manually with "dsh-eda-bridge", then ${EASYEDA_BRIDGE_REGISTER_HINT}`,
            'SCHEMATIC_BRIDGE_UNAVAILABLE',
          )
        }
        await new Promise(resolve => setTimeout(resolve, 150))
      }
    }
  }

  /**
   * One pass over the advertised port range; throws `UNAVAILABLE`, `NO_EDA`,
   * or `TIMEOUT` when no usable bridge answers.
   */
  private static async scanRange(options: HttpEasyEdaBridgeOptions, host: string): Promise<HttpEasyEdaBridge> {
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
        throw new SchematicError(`easyeda bridge at ${baseUrl} has no EasyEDA window connected — ${EASYEDA_BRIDGE_REGISTER_HINT}`, 'SCHEMATIC_BRIDGE_NO_EDA')
      }
      return new HttpEasyEdaBridge(baseUrl, options)
    }
    throw new SchematicError(
      `no easyeda bridge found on ${host} ports ${EASYEDA_BRIDGE_PORT_MIN}–${EASYEDA_BRIDGE_PORT_MAX} — start it with "dsh-eda-bridge" (the bin ships inside @deepseek-ai/dsh-plugin-eda-core), then ${EASYEDA_BRIDGE_REGISTER_HINT}`,
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
        // timeout: a drained window list deserves the actionable error. A
        // client that already completed a call reports WINDOW_LOST; a client
        // that never reached the editor keeps the initial NO_EDA class.
        if ((await this.probeHealth())?.edaConnected === false) {
          const code: EasyEdaBridgeFailureCode = this.sawWindow ? 'SCHEMATIC_BRIDGE_WINDOW_LOST' : 'SCHEMATIC_BRIDGE_NO_EDA'
          throw new SchematicError(
            bridgeFailureMessage(code, `easyeda bridge at ${this.baseUrl} reports no connected editor window`),
            code,
            { cause: error },
          )
        }
        throw new SchematicError(
          bridgeFailureMessage('SCHEMATIC_BRIDGE_TIMEOUT', `easyeda bridge execute timed out after ${timeoutMs}ms`),
          'SCHEMATIC_BRIDGE_TIMEOUT',
          { cause: error },
        )
      }
      const transport = classifyTransportFailure(error)
      if (transport !== undefined) {
        throw new SchematicError(
          bridgeFailureMessage(transport, `easyeda bridge execute could not reach ${this.baseUrl}`),
          transport,
          { cause: error },
        )
      }
      throw new SchematicError(
        bridgeFailureMessage('SCHEMATIC_BRIDGE_EXECUTION', `easyeda bridge execute failed: ${error instanceof Error ? error.message : String(error)}`),
        'SCHEMATIC_BRIDGE_EXECUTION',
        { cause: error },
      )
    }
    // A completed response — even an error one — means the client-side queue
    // drained; the circuit closes.
    this.timeoutStreak = 0
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // The relay answers 503 with an explanatory body when its window list is
      // empty; that is a loss (or an initial absence), not a body failure.
      if (res.status === 503 && /no\s+(?:easyeda\s+)?window|eda(?:connected)?\s*[:=]\s*false|not connected/i.test(detail)) {
        const code: EasyEdaBridgeFailureCode = this.sawWindow ? 'SCHEMATIC_BRIDGE_WINDOW_LOST' : 'SCHEMATIC_BRIDGE_NO_EDA'
        throw new SchematicError(
          bridgeFailureMessage(code, `easyeda bridge execute returned HTTP 503: ${detail.slice(0, 200)}`),
          code,
          { cause: new Error(`HTTP 503 ${detail.slice(0, 200)}`) },
        )
      }
      throw new SchematicError(
        bridgeFailureMessage('SCHEMATIC_BRIDGE_EXECUTION', `easyeda bridge execute returned HTTP ${res.status}`),
        'SCHEMATIC_BRIDGE_EXECUTION',
        { cause: new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`) },
      )
    }
    const body = await res.json() as Record<string, unknown>
    if ('error' in body || body.type === 'error') {
      throw new SchematicError(
        bridgeFailureMessage('SCHEMATIC_BRIDGE_EXECUTION', `easyeda bridge execution error: ${String(body.error ?? body.type)}`),
        'SCHEMATIC_BRIDGE_EXECUTION',
      )
    }
    if ('result' in body) {
      this.sawWindow = true
      return body.result
    }
    throw new SchematicError(bridgeFailureMessage('SCHEMATIC_BRIDGE_PROTOCOL'), 'SCHEMATIC_BRIDGE_PROTOCOL')
  }
}
