/**
 * Shared EasyEDA client machinery for the `dsh-plugin-eda-*` plugins: the
 * run-api-gateway bridge client (`HttpEasyEdaBridge`), the workspace library
 * (`EasyEdaLibrary`), document-source read-back and netlist diffing, and the
 * V3 `SCH_PAGE`/`.epro2` serializers. Engine plugins (generation today;
 * review or analysis later) compose these primitives; this package carries no
 * cordis plugin of its own.
 * @module @deepseek-ai/dsh-plugin-eda-core
 */

export { serializeEasyEdaDocument, serializeEasyEdaProject } from './serialize.ts'
export type {
  EasyEdaEmbeddedDoc,
  EasyEdaProjectLibrary,
  EasyEdaProjectPackage,
  EasyEdaSerializeOptions,
} from './serialize.ts'
export {
  EASYEDA_BRIDGE_IMPLEMENTATION,
  EASYEDA_BRIDGE_PORT_MAX,
  EASYEDA_BRIDGE_PORT_MIN,
  HttpEasyEdaBridge,
} from './bridge.ts'
export type { EasyEdaBridge, EasyEdaBridgeExecuteOptions, HttpEasyEdaBridgeOptions } from './bridge.ts'
export { diffNetlists, parseDocumentSource, readBackAttrs, readBackNetRegions } from './readback.ts'
export type { ParsedRecord } from './readback.ts'
export { EasyEdaLibrary } from './library.ts'
export type { EasyEdaLibraryOptions } from './library.ts'
