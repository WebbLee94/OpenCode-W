import type { IpcResult, UpdateInfo, UpdateProgress, UpdateErrorPayload } from '@shared/types'

/**
 * Type-safe ElectronAPI interface matching the preload.ts contextBridge API.
 * Each channel's return type is wrapped in IpcResult<T> by the main process.
 */
export interface ElectronAPI {
  invoke(channel: string, ...args: unknown[]): Promise<IpcResult>
  openExternal?(url: string): Promise<IpcResult<true>>
  openDirectoryDialog?(): Promise<IpcResult<string | null>>
  update?: {
    check: () => Promise<IpcResult<{ skipped?: boolean }>>
    download: () => Promise<IpcResult<true>>
    install: () => Promise<IpcResult<true>>
    getState: () => Promise<IpcResult<{ state: string; info: UpdateInfo | null }>>
    onAvailable: (cb: (info: UpdateInfo) => void) => () => void
    onNotAvailable: (cb: () => void) => () => void
    onProgress: (cb: (p: UpdateProgress) => void) => () => void
    onDownloaded: (cb: (info: UpdateInfo) => void) => () => void
    onError: (cb: (err: UpdateErrorPayload) => void) => () => void
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
