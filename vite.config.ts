import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  preview: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8000' } },
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
})
