import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// tsconfig.base.json has no include, so vite-tsconfig-paths treats it as
// match-all: the paths map applies to every test file and keeps workspace
// imports on the source plane (built lib/ never loads a second copy).
const pathsPlugin = tsconfigPaths({ projects: ['./tsconfig.base.json'] })

export default defineConfig({
  plugins: [pathsPlugin],
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
    exclude: ['packages/schematic-easyeda/tests/live-e2e.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // The bundle contributes only a patch manifest; its src is a stub `export {}`.
      exclude: ['packages/schematic-bundle/src/**'],
      // Same gate as deepseek-harness: per-file 100% on package src.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
        perFile: true,
      },
    },
  },
})
