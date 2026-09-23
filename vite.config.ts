import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

// One ID per build, shared by the page (__BUILD_ID__) and the server (it reads
// dist/build-info.json). A page talking to a server from another build - an old
// revision still taking traffic, a cached page - is then detectable, which is
// what the status strip reports.
const BUILD_ID = `${new Date().toISOString().slice(0, 16).replace('T', ' ')}-${Math.random().toString(36).slice(2, 6)}`;

export default defineConfig(({mode, command}) => {
  // .env.local too, not only the shell environment.
  const backendUrl = process.env.BACKEND_URL || loadEnv(mode, process.cwd(), '').BACKEND_URL;
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'build-info',
        apply: 'build',
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({ buildId: BUILD_ID }) });
        },
      },
    ],
    define: {
      __BUILD_ID__: JSON.stringify(command === 'build' ? BUILD_ID : 'dev'),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // /api goes to a trading server only when BACKEND_URL names one: the
      // hosted app (BACKEND_URL=https://your-app.run.app in .env.local), so a
      // local copy follows it and its buttons act on it.
      ...(backendUrl
        ? { proxy: { '/api': { target: backendUrl, changeOrigin: true } } }
        : {}),
    },
  };
});
