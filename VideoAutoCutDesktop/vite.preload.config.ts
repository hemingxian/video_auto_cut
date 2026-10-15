import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'electron/preload.ts',
      formats: ['cjs'],
      fileName: () => 'preload.cjs',
    },
    minify: false,
    outDir: 'dist-electron',
    rollupOptions: {
      external: ['electron'],
    },
    target: 'node22',
  },
})
