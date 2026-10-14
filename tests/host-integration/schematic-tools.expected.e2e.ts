/** Schematic tools through the shipped headless profile and the optional schematic bundle. */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { scanZstdFrames } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'

interface JsonObject {
  [key: string]: unknown
}

const scenarioDir = fileURLToPath(new URL('./expected/schematic-tools/', import.meta.url))
const streamExpected = join(scenarioDir, 'stream-json.expected.jsonl')
const scenarioPatch = fileURLToPath(new URL('../schematic-snapshot.patch.yml', import.meta.url))
const bundlePatch = fileURLToPath(new URL(
  '../../../../../../packages/schematic/schematic-bundle/cordis.patch.yml',
  import.meta.url,
))
const dshBinScript = fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

function parseJsonl(content: string): JsonObject[] {
  return content.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as JsonObject)
}

async function readPersistedLog(file: string): Promise<string> {
  const content = await readFile(file)
  if (!file.endsWith('.zstd')) return content.toString('utf8')
  const scan = scanZstdFrames(content)
  if (scan.tornStart !== undefined) throw new Error(`persisted snapshot log has a torn Zstandard frame: ${file}`)
  const decoded: Buffer[] = []
  for (const frame of scan.frames) {
    decoded.push(zstdDecompressSync(content.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(decoded).toString('utf8')
}

function normalizeStreamJson(rawStdout: string): string {
  const records = parseJsonl(rawStdout)
  const sessionId = typeof records[0]?.sessionId === 'string' ? records[0].sessionId : '\0no-session\0'
  const cwd = typeof records[0]?.cwd === 'string' ? records[0].cwd : '\0no-cwd\0'
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value === sessionId ? '<session-id>'
        : value.includes(cwd) ? value.replaceAll(cwd, '<cwd>')
          : value
    }
    if (Array.isArray(value)) return value.map(scrub)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as JsonObject).map(([key, item]) => [key, scrub(item)]))
    }
    return value
  }
  return `${records.map(record => JSON.stringify(scrub(record))).join('\n')}\n`
}

it('runs the schematic validate-repair-generate loop through the shipped headless profile', async () => {
  const task = 'Validate the schematic, repair its findings, then emit document source.'
  const result = await runLoaderSmoke({
    label: 'schematic tools headless profile snapshot',
    tempDirPrefix: 'headless-snapshot-schematic-',
    binScript: dshBinScript,
    libBinScript: dshBinScript,
    configPath: scenarioPatch,
    binArgs: [
      '--profile', 'headless',
      '--patch', bundlePatch,
      '--patch', scenarioPatch,
      '--json', task,
    ],
    tsconfigPath,
    env: {
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
    },
    inspect: async (cwd) => {
      const sessionsDir = join(cwd, '.dsh', 'sessions')
      const files = (await readdir(sessionsDir, { recursive: true }))
        .filter(file => file.endsWith('.jsonl') || file.endsWith('.jsonl.zstd'))
      expect(files).toHaveLength(1)
      const content = await readPersistedLog(join(sessionsDir, files[0]!))
      const records = parseJsonl(content)
      const calls = records.filter(record => record.type === 'tool/call')
        .map(record => (record.data as JsonObject | undefined)?.name)
      expect(calls).toEqual(['schematic_validate', 'schematic_generate'])
      const requestHeader = records.find(record => record.type === 'request/header')
      const header = (requestHeader?.data as JsonObject | undefined)?.header as JsonObject | undefined
      const tools = header?.tools as Array<{ name?: string }> | undefined
      expect(tools?.map(tool => tool.name))
        .toEqual(expect.arrayContaining(['schematic_generate', 'schematic_validate']))
    },
  })

  expect(result.stderr).toBe('')
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line) as JsonObject)
  expect(events[0]).toMatchObject({ type: 'session' })
  expect(events.map(event => event.type)).toContain('tool_call')
  expect(events.at(-1)).toMatchObject({
    type: 'final',
    text: 'SCHEMATIC ROUND TRIP COMPLETE: FLOATING_INPUT_PIN repaired and easyeda source emitted.',
  })
  const toolResults = events.filter(event => event.type === 'tool_result')
  const serialized = JSON.stringify(toolResults)
  expect(serialized).toContain('FLOATING_INPUT_PIN')
  expect(serialized).toContain('easyeda')

  const normalized = normalizeStreamJson(result.stdout)
  if (refreshing) await writeFile(streamExpected, normalized)
  expect(parseJsonl(normalized)).toEqual(parseJsonl(await readFile(streamExpected, 'utf8')))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
