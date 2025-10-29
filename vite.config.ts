import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// MV3-friendly filenames without hashing
const output = {
  entryFileNames: 'assets/[name].js',
  chunkFileNames: 'assets/[name].js',
  assetFileNames: 'assets/[name][extname]'
};

export default defineConfig({
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env': '{"NODE_ENV":"production"}',
    'process': '{"env":{"NODE_ENV":"production"}}',
  },
  build: {
    sourcemap: false,
    target: 'chrome137',
    outDir: 'dist',
    rollupOptions: {
      input: {
        inpage: resolve(dirname(fileURLToPath(import.meta.url)), 'src/inpage/index.ts'),
        popup: resolve(dirname(fileURLToPath(import.meta.url)), 'src/popup/index.html')
      },
      output: {
        ...output,
        // Disable code splitting so each entry is a single file (no shared chunks like client.js)
        manualChunks: undefined
      }
    },
    emptyOutDir: true,
    // Keep CSS together with JS to simplify MV3 packaging
    cssCodeSplit: false,
    minify: 'esbuild'
  }
});
