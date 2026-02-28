import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals:     true,
    environment: 'node',
    coverage: {
      provider:   'v8',
      reporter:   ['text', 'json', 'html'],
      exclude:    ['**/node_modules/**', '**/dist/**', '**/*.d.ts', '**/vitest.config.*'],
    },
    include:  ['packages/*/src/**/*.{test,spec}.ts'],
    exclude:  ['**/node_modules/**', '**/dist/**'],
    typecheck: {
      enabled: false,
    },
  },
  resolve: {
    alias: {
      '@devbridge/shared': resolve(__dirname, 'packages/shared/src'),
    },
  },
});
