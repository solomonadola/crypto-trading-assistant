import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  // .env.local etc. too, not only the shell environment.
  const backendUrl = process.env.BACKEND_URL || loadEnv(mode, process.cwd(), '').BACKEND_URL;
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify - file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // /api goes to a trading server only when BACKEND_URL names one - the
      // hosted app (BACKEND_URL=https://your-app.run.app in .env.local), so
      // this copy follows it and can send it actions, or a local
      // `bun run server` (http://localhost:3001). Without one, the proxy
      // logged a connection error on every /api/status check; unproxied, the
      // check simply finds no server and the browser trades itself.
      ...(backendUrl
        ? { proxy: { '/api': { target: backendUrl, changeOrigin: true } } }
        : {}),
    },
  };
});
