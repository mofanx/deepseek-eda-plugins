/**
 * Shared EasyEDA client machinery for the `dsh-plugin-eda-*` plugins: the
 * run-api-gateway bridge client (`HttpEasyEdaBridge`), the workspace library
 * (`EasyEdaLibrary`), document-source read-back and netlist diffing, and the
 * V3 `SCH_PAGE`/`.epro2` serializers. Engine plugins (generation today;
 * review or analysis later) compose these primitives; this package carries no
 * cordis plugin of its own.
 * @module @deepseek-ai/dsh-plugin-eda-core
 */

export { computeBlockFrames } from './blocks.ts'
export type { EasyEdaBlockFrame } from './blocks.ts'
export { computeSheetChrome, pageSizeLabel, titleBlockTop, frameSymbolFor, EASYEDA_FRAME_A3, EASYEDA_FRAME_A4, EASYEDA_FRAME_LIBRARY_UUID, FRAME_DEVICE_FIELD, FRAME_SYMBOL_FIELD } from './sheet-chrome.ts'
export type {
  EasyEdaFrameField,
  EasyEdaFrameSymbol,
  EasyEdaSheetFrameOptions,
  SheetChrome,
  SheetChromeOptions,
  SheetChromeRect,
  SheetChromeText,
} from './sheet-chrome.ts'
export { computeSheetSymbolBoxes } from './hierarchy.ts'
export type { EasyEdaSheetSymbolBox, EasyEdaSheetSymbolPin } from './hierarchy.ts'
export { serializeEasyEdaDocument, serializeEasyEdaProject } from './serialize.ts'
export type {
  EasyEdaEmbeddedDoc,
  EasyEdaProjectLibrary,
  EasyEdaProjectPackage,
  EasyEdaSerializeOptions,
} from './serialize.ts'
export {
  EASYEDA_BRIDGE_IMPLEMENTATION,
  EASYEDA_BRIDGE_LANDING_URL,
  EASYEDA_BRIDGE_PORT_MAX,
  EASYEDA_BRIDGE_PORT_MIN,
  HttpEasyEdaBridge,
  spawnEasyEdaBridge,
} from './bridge.ts'
export type { EasyEdaBridge, EasyEdaBridgeExecuteOptions, HttpEasyEdaBridgeOptions } from './bridge.ts'
export { diffNetlists, parseDocumentSource, readBackAttrs, readBackNetRegions } from './readback.ts'
export type { ParsedRecord } from './readback.ts'
export { EasyEdaLibrary } from './library.ts'
export type { EasyEdaLibraryOptions } from './library.ts'
