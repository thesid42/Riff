import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        // Media generation polls the provider server-side; keep the proxy open longer
        // than the longest job timeout (300s video) so replies are never dropped in transit.
        timeout: 330_000,
        proxyTimeout: 330_000,
      },
    },
  },
});
