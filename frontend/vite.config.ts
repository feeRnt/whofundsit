import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Keep MapLibre out of dev pre-bundling: its worker is wired as a bundled
  // ?url asset, and pre-bundling breaks that URL in the browser.
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  // Match the ES-module worker MapLibre ships.
  worker: {
    format: 'es',
  },
  // Dev only: same-origin API so the page works from any host on the LAN.
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
  // deck.gl + maplibre-gl are inherently ~2MB; splitting them would
  // complicate the globe overlay + worker setup. Revisit post-demo.
  build: {
    chunkSizeWarningLimit: 2500,
  },
})
