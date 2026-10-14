/** Deterministic keyless adapter for the schematic optional-bundle profile snapshot. */

import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

const TITLE_MARKER = 'Generate the session title from this JSON array of human messages'

// A deliberate gate violation: the lone INPUT pin is unconnected, so the seam
// reports FLOATING_INPUT_PIN and the tool asks the model to repair and retry.
const FLOATING_DOC = {
  sheets: [{
    components: [{
      id: 'c1', kind: 'part', designator: 'U1', position: { x: 0, y: 0 },
      deviceUuid: 'dev', symbolUuid: 'sym', footprintUuid: 'fp',
      pins: [{ id: 'p1', name: 'I', number: '1', electric: 'INPUT', endpoint: { x: 0, y: 0 } }],
    }],
    wires: [], busEntries: [], junctions: [], attrs: [],
  }],
}

const VALID_DOC = {
  sheets: [{
    components: [
      {
        id: 'c1', kind: 'part', designator: 'U1', position: { x: 0, y: 0 },
        deviceUuid: 'dev', symbolUuid: 'sym', footprintUuid: 'fp',
        pins: [{ id: 'p1', name: 'O', number: '1', electric: 'OUTPUT', endpoint: { x: 0, y: 0 } }],
      },
      {
        id: 'c2', kind: 'part', designator: 'U2', position: { x: 10, y: 0 },
        deviceUuid: 'dev', symbolUuid: 'sym', footprintUuid: 'fp',
        pins: [{ id: 'p2', name: 'I', number: '1', electric: 'INPUT', endpoint: { x: 10, y: 0 } }],
      },
    ],
    wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'SIG' }],
    busEntries: [], junctions: [], attrs: [],
  }],
}

let nextCall = 0

function calls(messages) {
  return messages.flatMap(message => message.role === 'assistant'
    ? message.content.filter(block => block.type === 'tool-call').map(block => block.name)
    : [])
}

function toolChunks(spec) {
  const id = ToolCallId(`schematic-fixture-${++nextCall}`)
  const args = JSON.stringify(spec.args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: spec.name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: spec.name, arguments: args } },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 9, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class SchematicMockAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  async *stream(options) {
    if (JSON.stringify(options.messages).includes(TITLE_MARKER)) {
      yield* textChunks('Schematic snapshot')
      return
    }
    const names = calls(options.messages)
    if (!names.includes('schematic_validate')) {
      yield* toolChunks({ name: 'schematic_validate', args: { document: FLOATING_DOC } })
      return
    }
    if (!names.includes('schematic_generate')) {
      yield* toolChunks({ name: 'schematic_generate', args: { document: VALID_DOC } })
      return
    }
    yield* textChunks('SCHEMATIC ROUND TRIP COMPLETE: FLOATING_INPUT_PIN repaired and easyeda source emitted.')
  }
}

export const name = 'schematic-mock-llm'
export const inject = ['llm']

/** Register the keyless `schematic-mock` adapter. */
export function apply(ctx) {
  ctx.llm.registerAdapter(['schematic-mock'], new SchematicMockAdapter())
}
