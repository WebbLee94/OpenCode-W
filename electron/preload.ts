// @ts-nocheck
const { contextBridge, ipcRenderer } = require('electron')

const ALLOWED_CHANNELS = [
  'app:getVersion', 'app:getPlatform',
  'dashboard:overview', 'dashboard:tokens', 'dashboard:toolRanking', 'dashboard:skillUsage', 'dashboard:trends',
  'sessions:list', 'sessions:detail', 'sessions:projects', 'sessions:delete',
  'messages:list', 'messages:detail',
  'cleanup:preview', 'cleanup:execute',
  'database:vacuum', 'database:checkpoint', 'database:open', 'database:health',
  'dialog:openFile',
  'backup:create', 'backup:list', 'backup:restore', 'backup:delete', 'backup:preview',
]

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => {
    if (!ALLOWED_CHANNELS.includes(channel)) {
      throw new Error(`IPC channel not allowed: ${channel}`)
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel, callback) => {
    if (!ALLOWED_CHANNELS.includes(channel)) {
      throw new Error(`IPC channel not allowed: ${channel}`)
    }
    const subscription = (_event, ...args) => callback(...args)
    ipcRenderer.on(channel, subscription)
    return () => ipcRenderer.removeListener(channel, subscription)
  },
})
