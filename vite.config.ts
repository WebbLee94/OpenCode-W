/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const host = process.env.TAURI_DEV_HOST || 'localhost'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  clearScreen: false,
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    strictPort: true,
    host,
    port: 5173,
    origin: 'http://localhost:5173',
    watch: {
      ignored: [
        '**/src-tauri/**',
        '**/node_modules/**',
        '**/.git/**',
      ],
    },
    hmr: {
      host,
      port: 5173,
      protocol: 'ws',
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.{test,spec}.{js,ts,jsx,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
})
