import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@devbridge/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api':    { target: 'http://localhost:4000', changeOrigin: true },
      '/ws':     { target: 'ws://localhost:4000',   ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir:    'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          state:  ['zustand', 'eventemitter3'],
        },
      },
    },
  },
});
