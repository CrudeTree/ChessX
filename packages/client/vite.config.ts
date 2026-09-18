import { defineConfig } from 'vite';

export default defineConfig({
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
});
