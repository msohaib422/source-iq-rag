import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The client talks to the Express API through a relative `/api` prefix in
 * development. Vite proxies that prefix to the backend, so there is no CORS
 * round-trip and no hard-coded hostname in the bundle.
 *
 * In production the same relative prefix is used, which means the API must be
 * served on the same origin (or behind a reverse proxy that forwards /api).
 * Set VITE_API_URL at build time to point at an absolute URL instead.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_DEV_API_URL || 'http://127.0.0.1:5000';

  return {
    plugins: [react()],
    server: {
      port: Number(env.VITE_PORT || 5173),
      host: env.VITE_HOST || '127.0.0.1',
      strictPort: false,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          // Streaming (SSE) must not be buffered by the proxy.
          configure: (proxy) => {
            proxy.on('proxyRes', (proxyRes) => {
              if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
                proxyRes.headers['cache-control'] = 'no-cache, no-transform';
              }
            });
          },
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: mode !== 'production',
      chunkSizeWarningLimit: 900,
    },
    preview: {
      port: Number(env.VITE_PREVIEW_PORT || 4173),
    },
  };
});