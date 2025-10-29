import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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
    emptyOutDir: false, // keep files from the main build
    lib: {
      entry: resolve(dirname(fileURLToPath(import.meta.url)), 'src/contentScript/main.tsx'),
      name: 'GrammarlyXContent',
      formats: ['iife'],
      fileName: () => 'assets/contentScript.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name][extname]'
      }
    },
    minify: 'esbuild'
  }
});
