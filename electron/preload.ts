/// <reference types="electron" />

// preload 必须为 CJS 产物（package.json "type": "module" + vite 入口配置 .cjs）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { contextBridge, ipcRenderer } = require('electron')

// ⚠️ 与 shared/ipc-channels.ts 保持同步 — 新增 channel 需同步更新此处
/** @type {readonly string[]} */
const ALLOWED_CHANNELS = [
  'dashboard:overview', 'dashboard:tokens', 'dashboard:toolRanking', 'dashboard:skillUsage',
  'sessions:list', 'sessions:detail', 'sessions:projects', 'sessions:delete',
  'messages:list', 'messages:detail', 'messages:search', 'messages:list-by-parent',
  'cleanup:preview', 'cleanup:execute',
  'database:vacuum', 'database:checkpoint', 'database:open', 'database:health',
  'dialog:openFile',
  'dialog:openDirectory',
  'shell:openExternal',
  'backup:create', 'backup:list', 'backup:restore', 'backup:delete', 'backup:preview',
  'todos:by-parent',
  'session-share:get',
  'sessions:children', 'sessions:rename', 'sessions:move',
  'dashboard:modelRanking', 'dashboard:providerStats',
  'dashboard:sessionTrend', 'dashboard:costTrend', 'dashboard:messageTrend',
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

contextBridge.exposeInMainWorld('electronAPI', { invoke,
  openExternal: (url: string) => invoke('shell:openExternal', url),
  openDirectoryDialog: () => invoke('dialog:openDirectory'),
})
