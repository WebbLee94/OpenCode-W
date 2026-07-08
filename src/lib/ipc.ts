/**
 * Tauri IPC wrapper for the renderer process.
 * Replaces the previous Electron-based IPC layer.
 *
 * All calls go through @tauri-apps/api/core invoke().
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { open as tauriShellOpen } from '@tauri-apps/plugin-shell'
import type { IpcResult } from '@shared/types'

/**
 * Check if we are running inside a Tauri window.
 *
 * Tauri v2 默认注入 `__TAURI_INTERNALS__`（除非设置 `app.withGlobalTauri: true`，
 * 此时也会额外注入 `__TAURI__`）。同时检查两者以兼容两种配置。
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

/**
 * Invoke a Tauri command and return the raw IpcResult<T> wrapper.
 * Callers must manually check `success` and handle `data` or `error`.
 *
 * Tauri 参数绑定模型：
 *   - `invoke('cmd', payload)` 中 payload 是一个 JSON 对象
 *   - payload 的每个 key（自动 camelCase → snake_case 转换）匹配到 Rust 命令的命名参数
 *
 * 包装规则：
 *   - 0 args → 无 payload
 *   - 1 arg (object) → payload = 对象本身（字段直接匹配 Rust 参数名）
 *   - 1 arg (scalar/string) → payload = { value: arg }（Rust 用 `value: T` 接收）
 *   - 2+ args → 合并所有对象字段；标量参数用 `argN` 包装（推荐前端手动合并对象）
 */
export async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  // 过滤掉 null/undefined 参数
  const filtered = args.filter(a => a !== null && a !== undefined)

  let payload: Record<string, unknown> | undefined

  if (filtered.length === 0) {
    payload = undefined
  } else if (filtered.length === 1) {
    const arg = filtered[0]
    if (typeof arg === 'object' && !Array.isArray(arg)) {
      // 对象参数：直接作为 payload，字段匹配 Rust 命名参数
      payload = arg as Record<string, unknown>
    } else {
      // 标量/字符串参数：包装为 { value: arg }
      payload = { value: arg }
    }
  } else {
    // 2+ args：合并所有对象字段，标量参数用 argN 包装
    // 注意：推荐前端调用时手动合并对象以避免歧义
    payload = {}
    for (let i = 0; i < filtered.length; i++) {
      const arg = filtered[i]
      if (typeof arg === 'object' && !Array.isArray(arg)) {
        Object.assign(payload, arg as Record<string, unknown>)
      } else {
        payload[`arg${i}`] = arg
      }
    }
  }

  // Tauri commands use snake_case function names, not colon-separated channel names.
  // Convert channel name (e.g. "dashboard:toolRanking", "messages:list-by-parent")
  // to Rust command name (e.g. "dashboard_tool_ranking", "messages_list_by_parent").
  const commandName = channel
    .replace(/:/g, '_')           // colons → underscores
    .replace(/([a-z])([A-Z])/g, '$1_$2')  // camelCase → snake_case (insert underscore at boundary)
    .replace(/-/g, '_')           // hyphens → underscores
    .toLowerCase()                // normalize to lowercase
  try {
    return await tauriInvoke<IpcResult<T>>(commandName, payload)
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * Invoke a Tauri command and automatically unwrap the IpcResult<T>.
 * On success, returns the data directly.
 * On failure, throws an Error with the error message.
 */
export async function invokeSafe<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await invoke<T>(channel, ...args)
  if (result.success) {
    return result.data
  }
  throw new Error(result.error)
}

/**
 * 打开外部链接
 * 策略：调用 Tauri shell plugin 的 open()；失败则降级到 window.open
 */
export async function openExternal(url: string): Promise<'system' | 'builtin'> {
  if (!url) throw new Error('链接为空')

  // Tauri 环境：优先 shell.open
  if (isTauri()) {
    try {
      await tauriShellOpen(url)
      return 'system'
    } catch {
      // 降级到 window.open
    }
  }

  // 浏览器降级
  const win = window.open(url, '_blank', 'noopener,noreferrer')
  if (!win) throw new Error('打开内置浏览器失败（可能被拦截）')
  return 'builtin'
}
