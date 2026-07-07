/**
 * 版本更新 IPC 处理器
 * 包装 electron-updater,提供手动模式(check / download / install)与事件推送
 */
import { app, ipcMain, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import fs from 'node:fs'
import path from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  UpdateState,
  UpdateInfo,
  UpdateProgress,
  UpdateErrorPayload,
} from '../../shared/types'

interface Deps {
  getMainWindow: () => BrowserWindow | null
}

let currentState: UpdateState = 'idle'
let currentInfo: UpdateInfo | null = null

function setState(next: UpdateState): void {
  currentState = next
}

interface UpdateCache {
  lastCheckedAt: string
  lastVersion: string
}

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'update-cache.json')
}

function loadCache(): UpdateCache | null {
  const f = cacheFile()
  if (!fs.existsSync(f)) return null
  try {
    return JSON.parse(fs.readFileSync(f, 'utf-8')) as UpdateCache
  } catch {
    return null
  }
}

function saveCache(cache: UpdateCache): void {
  fs.writeFileSync(cacheFile(), JSON.stringify(cache), 'utf-8')
}

function send<T>(channel: string, payload: T): void {
  const win = mainWindowGetter?.()
  win?.webContents.send(channel, payload)
}

let mainWindowGetter: Deps['getMainWindow'] | null = null

export function getCurrentState(): { state: UpdateState; info: UpdateInfo | null } {
  return { state: currentState, info: currentInfo }
}

export function registerHandlers(deps: Deps): void {
  mainWindowGetter = deps.getMainWindow

  // 事件订阅
  autoUpdater.on('update-available', (info) => {
    currentInfo = {
      version: info.version,
      releaseDate: info.releaseDate ?? '',
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
      sizeBytes: 0, // electron-updater 在 available 阶段不提供大小
    }
    setState('available')
    saveCache({ lastCheckedAt: new Date().toISOString(), lastVersion: info.version })
    send(IPC_CHANNELS.UPDATE_EVENT_AVAILABLE, currentInfo)
  })

  autoUpdater.on('update-not-available', () => {
    setState('idle')
    saveCache({ lastCheckedAt: new Date().toISOString(), lastVersion: '' })
    send(IPC_CHANNELS.UPDATE_EVENT_NOT_AVAILABLE, null)
  })

  autoUpdater.on('download-progress', (progress) => {
    const payload: UpdateProgress = {
      bytesPerSecond: progress.bytesPerSecond,
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    }
    send(IPC_CHANNELS.UPDATE_EVENT_PROGRESS, payload)
  })

  autoUpdater.on('update-downloaded', (info) => {
    if (currentInfo) {
      currentInfo = { ...currentInfo, version: info.version, sizeBytes: 0 }
    }
    setState('downloaded')
    send(IPC_CHANNELS.UPDATE_EVENT_DOWNLOADED, currentInfo)
  })

  autoUpdater.on('error', (err) => {
    const payload: UpdateErrorPayload = {
      code: 'unknown',
      message: err?.message ?? '未知错误',
    }
    send(IPC_CHANNELS.UPDATE_EVENT_ERROR, payload)
  })

  // 通道注册
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    if (!app.isPackaged) {
      // dev 模式跳过真实请求
      return { success: true, data: { skipped: true } }
    }
    try {
      setState('idle')
      await autoUpdater.checkForUpdates()
      return { success: true, data: { skipped: false } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async () => {
    try {
      setState('downloading')
      await autoUpdater.downloadUpdate()
      return { success: true, data: true }
    } catch (err) {
      setState('available') // 回滚到可重试状态
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => {
    setState('installing')
    // quitAndInstall 是同步发起的;返回 success 仅表示发起成功
    setImmediate(() => autoUpdater.quitAndInstall())
    return { success: true, data: true }
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_STATE, () => {
    return { success: true, data: getCurrentState() }
  })

  ipcMain.handle('update:get-last-check', () => {
    return { success: true, data: loadCache() }
  })
}
