import type { IpcResult } from '@shared/types'

/**
 * Type-safe ElectronAPI interface matching the preload.ts contextBridge API.
 * Each channel's return type is wrapped in IpcResult<T> by the main process.
 */
export interface ElectronAPI {
  invoke(channel: string, ...args: unknown[]): Promise<IpcResult>
  on(channel: string, callback: (...args: unknown[]) => void): () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
