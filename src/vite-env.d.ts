/// <reference types="vite/client" />

interface Window {
  api: import('../electron/preload').ExposedAPI
}
