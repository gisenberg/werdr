import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // The lazily loaded, pinned terminal library embeds its 612 KiB WASM parser.
    chunkSizeWarningLimit: 1100,
  },
});
