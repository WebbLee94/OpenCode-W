/**
 * Safe IPC wrapper for the renderer process.
 * Handles the case where window.electronAPI is not available
 * (e.g., when running in a regular browser instead of Electron).
 */

import { IPC_CHANNELS } from '@shared/ipc-channels'

type ChannelName = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS]

export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI
}

export async function invoke<T = unknown>(channel: ChannelName, ...args: unknown[]): Promise<T> {
  if (!window?.electronAPI) {
    throw new Error(
      'Electron API 不可用。请在 Electron 窗口中使用此应用，而不是浏览器。\n' +
      '请运行 npm run dev 启动 Electron 应用。'
    )
  }
  return window.electronAPI.invoke(channel, ...args) as Promise<T>
}

export function on(channel: ChannelName, callback: (...args: unknown[]) => void): () => void {
  if (!window?.electronAPI) {
    console.warn(`Electron API 不可用，无法监听 ${channel}`)
    return () => {}
  }
  return window.electronAPI.on(channel, callback)
}
