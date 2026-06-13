/**
 * Safe IPC wrapper for the renderer process.
 * Handles the case where window.electronAPI is not available
 * (e.g., when running in a regular browser instead of Electron).
 */

import { IPC_CHANNELS } from '@shared/ipc-channels'
import type { IpcResult } from '@shared/types'

type ChannelName = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS]

export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI
}

/**
 * Invoke an IPC channel and return the raw IpcResult<T> wrapper.
 * Callers must manually check `success` and handle `data` or `error`.
 */
export async function invoke<T = unknown>(channel: ChannelName, ...args: unknown[]): Promise<IpcResult<T>> {
  if (!window?.electronAPI) {
    throw new Error(
      'Electron API 不可用。请在 Electron 窗口中使用此应用，而不是浏览器。\n' +
      '请运行 npm run dev 启动 Electron 应用。'
    )
  }
  return window.electronAPI.invoke(channel, ...args) as Promise<IpcResult<T>>
}

/**
 * Invoke an IPC channel and automatically unwrap the IpcResult<T>.
 * On success, returns the data directly.
 * On failure, throws an Error with the error message.
 */
export async function invokeSafe<T = unknown>(channel: ChannelName, ...args: unknown[]): Promise<T> {
  const result = await invoke<T>(channel, ...args)
  if (result.success) {
    return result.data
  }
  throw new Error(result.error)
}

/**
 * 打开外部链接的方式
 *  - 'system'  : 系统默认浏览器（经主进程 shell.openExternal）
 *  - 'builtin' : 应用内置 webview（降级：window.open）
 */
export type OpenExternalMethod = 'system' | 'builtin'

/**
 * 在外部打开 URL
 * 策略：优先调用系统默认浏览器（shell.openExternal）；失败则降级到应用内置 webview（window.open）
 * 浏览器环境（无 Electron API）:直接走 window.open
 *
 * 返回实际打开方式,供 UI 给出相应提示
 * 抛出:链接为空 / 两种方式都失败
 */
export async function openExternal(url: string): Promise<OpenExternalMethod> {
  if (!url) throw new Error('链接为空')

  // 浏览器环境:直接走内置 webview
  if (!window?.electronAPI?.openExternal) {
    const win = window.open(url, '_blank', 'noopener,noreferrer')
    if (!win) throw new Error('打开内置浏览器失败（可能被拦截）')
    return 'builtin'
  }

  // 优先:主进程 shell.openExternal
  try {
    const result = await window.electronAPI.openExternal(url)
    if (result?.success) return 'system'
    // 失败 → 降级
  } catch {
    // 主进程异常 → 降级
  }
  // 降级到内置 webview；window.open 被拦截时返回 null,需告知调用方
  const win = window.open(url, '_blank', 'noopener,noreferrer')
  if (!win) throw new Error('内置浏览器也被拦截')
  return 'builtin'
}
