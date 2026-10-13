import { defineConfig } from 'tsdown'

// Bundles each package's tsc output (lib/types/*.js) into the published
// runtime entry (lib/index.js). Workspace dependencies stay external so the
// service package keeps one module identity inside the host.
export default defineConfig({
  workspace: ['packages/*'],
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
