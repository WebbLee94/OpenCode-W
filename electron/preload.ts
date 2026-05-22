/// <reference types="electron" />

const { contextBridge, ipcRenderer } = require('electron')

// ⚠️ 与 shared/ipc-channels.ts 保持同步 — 新增 channel 需同步更新此处
/** @type {readonly string[]} */
const ALLOWED_CHANNELS = [
  'app:getVersion', 'app:getPlatform',
  'dashboard:overview', 'dashboard:tokens', 'dashboard:toolRanking', 'dashboard:skillUsage', 'dashboard:trends',
  'sessions:list', 'sessions:detail', 'sessions:projects', 'sessions:delete',
  'messages:list', 'messages:detail', 'messages:search',
  'cleanup:preview', 'cleanup:execute',
  'database:vacuum', 'database:checkpoint', 'database:open', 'database:health',
  'dialog:openFile',
  'backup:create', 'backup:list', 'backup:restore', 'backup:delete', 'backup:preview',
  'todos:list', 'todos:bySession',
  'session-share:get',
  'accounts:list', 'accounts:active',
  'events:list', 'events:detail',
]

/**
 * @typedef {import('../shared/types').IpcResult} IpcResult
 */

/**
 * Invoke an IPC channel with arguments.
 * @param {string} channel - The IPC channel name
 * @param {...*} args - Arguments to pass
 * @returns {Promise<IpcResult>}
 */
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  if (!ALLOWED_CHANNELS.includes(channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`)
  }
  return ipcRenderer.invoke(channel, ...args)
}

/**
 * Subscribe to an IPC channel.
 * @param {string} channel - The IPC channel name
 * @param {function(...*): void} callback - Callback function
 * @returns {function(): void} Unsubscribe function
 */
function on(channel: string, callback: (...args: unknown[]) => void): () => void {
  if (!ALLOWED_CHANNELS.includes(channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`)
  }
  const subscription = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
  ipcRenderer.on(channel, subscription)
  return () => ipcRenderer.removeListener(channel, subscription)
}

contextBridge.exposeInMainWorld('electronAPI', { invoke, on })
