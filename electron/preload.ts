/// <reference types="electron" />

const { contextBridge, ipcRenderer } = require('electron')

// ⚠️ 与 shared/ipc-channels.ts 保持同步 — 新增 channel 需同步更新此处
/** @type {readonly string[]} */
const ALLOWED_CHANNELS = [
  'app:getVersion', 'app:getPlatform',
  'dashboard:overview', 'dashboard:tokens', 'dashboard:toolRanking', 'dashboard:skillUsage', 'dashboard:trends',
  'sessions:list', 'sessions:detail', 'sessions:projects', 'sessions:delete',
  'messages:list', 'messages:detail', 'messages:search', 'messages:list-by-parent',
  'cleanup:preview', 'cleanup:execute',
  'database:vacuum', 'database:checkpoint', 'database:open', 'database:health',
  'dialog:openFile', 'dialog:saveFile',
  'backup:create', 'backup:list', 'backup:restore', 'backup:delete', 'backup:preview', 'backup:config:get', 'backup:config:set', 'backup:auto-backup-check',
  'todos:list', 'todos:bySession', 'todos:by-parent',
  'session-share:get', 'session-shares:list',
  'accounts:list', 'accounts:active', 'accounts:usage',
  'events:list', 'events:detail',
  'sessions:parent', 'sessions:children', 'sessions:rename',
  'dashboard:projects', 'dashboard:workspaces', 'dashboard:modelRanking', 'dashboard:providerStats',
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

/**
 * Save content to a file via the system save dialog.
 * @param {string} content - File content to save
 * @param {string} defaultName - Suggested filename
 * @returns {Promise<IpcResult<{ success: boolean }>>}
 */
function saveFile(content: string, defaultName: string): Promise<unknown> {
  return invoke('dialog:saveFile', { content, defaultName })
}

contextBridge.exposeInMainWorld('electronAPI', { invoke, on, saveFile,
  openExternal: (url: string) => invoke('shell:openExternal', url),
  backupConfigGet: () => invoke('backup:config:get'),
  backupConfigSet: (config: any) => invoke('backup:config:set', config),
  backupAutoCheck: () => invoke('backup:auto-backup-check'),
})
