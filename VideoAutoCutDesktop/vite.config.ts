import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    fs: {
      allow: [resolve(import.meta.dirname), resolve(import.meta.dirname, '../VideoAutoCut/fonts')],
    },
  },
  build: {
    rollupOptions: {
      input: {
        app: resolve(import.meta.dirname, 'index.html'),
        materialLibraryReference: resolve(import.meta.dirname, 'material-library-reference.html'),
        shotMaterialPickerReference: resolve(import.meta.dirname, 'shot-material-picker-reference.html'),
        storyboardEditorReference: resolve(import.meta.dirname, 'storyboard-editor-reference.html'),
      },
    },
  },
})
