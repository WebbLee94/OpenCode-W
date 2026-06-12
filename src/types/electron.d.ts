import type { IpcResult } from '@shared/types'

/**
 * Type-safe ElectronAPI interface matching the preload.ts contextBridge API.
 * Each channel's return type is wrapped in IpcResult<T> by the main process.
 */
export interface BackupConfig {
  enabled: boolean
  frequency: string
  maxCount: number
  maxAgeDays: number
}

export interface ElectronAPI {
  invoke(channel: string, ...args: unknown[]): Promise<IpcResult>
  on(channel: string, callback: (...args: unknown[]) => void): () => void
  saveFile(content: string, defaultName: string): Promise<IpcResult<{ success: boolean }>>
  openExternal?(url: string): Promise<IpcResult<true>>
  backupConfigGet?(): Promise<BackupConfig>
  backupConfigSet?(config: BackupConfig): Promise<IpcResult<{ success: boolean }>>
  backupAutoCheck?(): Promise<IpcResult<{ success: boolean }>>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
