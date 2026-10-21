import { defineConfig, type Plugin } from 'vite';

const BUILD_ID = Date.now().toString(36);

/** Serves the build's id as /version.json, so a tab still running an older build can tell (see update.ts). */
function versionFile(): Plugin {
  return {
    name: 'chessx-version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) });
    },
  };
}

export default defineConfig(({ command }) => ({
  define: {
    __BUILD_ID__: JSON.stringify(command === 'build' ? BUILD_ID : 'dev'),
  },
  plugins: [versionFile()],
  server: {
    port: 5173,
    proxy: {
      // In development the game server runs separately on 8080.
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/api': { target: 'http://localhost:8080' },
      '/uploads': { target: 'http://localhost:8080' },
    },
  },
  build: {
    target: 'es2022',
  },
}));
