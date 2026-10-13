// Web build and development server. In development the API is proxied to the development server
// (tools/dev/server.ts, port 8080). The proxy keeps the browser's Host header (no changeOrigin): the server checks
// that Origin and Host match, so a rewritten Host would refuse every POST with bad_origin.
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.DEV_API_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No inline scripts or styles in the output: the server's CSP allows 'self' only.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
