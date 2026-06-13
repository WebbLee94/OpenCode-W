import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import DatabaseManager from './database'
import * as sessionsIpc from './ipc/sessions'
import * as messagesIpc from './ipc/messages'
import * as cleanupIpc from './ipc/cleanup'
import * as analyticsIpc from './ipc/analytics'
import * as backupIpc from './ipc/backup'
import * as todosIpc from './ipc/todos'
import * as eventsIpc from './ipc/events'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import type { IpcResult } from '../shared/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let mainWindow: BrowserWindow | null = null

app.setName('DBScope-OC')

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: '',
    icon: VITE_DEV_SERVER_URL
      ? path.join(process.env.APP_ROOT, 'build', 'icon.png')
      : undefined, // Packaged app uses icon from Info.plist automatically
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  // 显式注册 window.open 处理器
  // 背景：Electron 30 中若不注册 setWindowOpenHandler,window.open 会"静默打开新 BrowserWindow
  //      但返回 null",导致渲染层 if (!win) 误判失败、错误地触发复制链接降级 toast
  // 策略：http(s) 链接允许在新 BrowserWindow 中打开(作为 shell.openExternal 失败后的内置降级)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return { action: 'allow' }
    }
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerIpcHandlers() {
  // App info
  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, (): IpcResult<string> => {
    return { success: true, data: app.getVersion() }
  })
  ipcMain.handle(IPC_CHANNELS.APP_GET_PLATFORM, (): IpcResult<string> => {
    return { success: true, data: process.platform }
  })

  // Database operations
  ipcMain.handle(IPC_CHANNELS.DATABASE_OPEN, async (_event, dbPath: string): Promise<IpcResult<{ path: string }>> => {
    try {
      DatabaseManager.open(dbPath)
      return { success: true, data: { path: dbPath } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DATABASE_HEALTH, (): IpcResult<{ ok: boolean; pageCount: number; freelistPages: number; walSize: number }> => {
    try {
      return { success: true, data: DatabaseManager.healthCheck() }
    } catch {
      return { success: true, data: { ok: false, pageCount: 0, freelistPages: 0, walSize: 0 } }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DATABASE_VACUUM, (): IpcResult<{ before: number; after: number; freed: number }> => {
    try {
      return { success: true, data: DatabaseManager.vacuum() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DATABASE_CHECKPOINT, (): IpcResult<true> => {
    try {
      DatabaseManager.checkpoint()
      return { success: true, data: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // Register feature IPC handlers
  sessionsIpc.registerHandlers()
  messagesIpc.registerHandlers()
  cleanupIpc.registerHandlers()
  analyticsIpc.registerHandlers()
  backupIpc.registerHandlers()
  todosIpc.registerHandlers()
  eventsIpc.registerHandlers()

  // Save file dialog
  ipcMain.handle(IPC_CHANNELS.DIALOG_SAVE_FILE, async (_event, { content, defaultName }: { content: string; defaultName: string }): Promise<IpcResult<{ success: boolean }>> => {
    try {
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: defaultName,
        filters: [
          { name: 'CSV', extensions: ['csv'] },
          { name: 'JSON', extensions: ['json'] },
        ],
      })
      if (!result.canceled && result.filePath) {
        fs.writeFileSync(result.filePath, content, 'utf-8')
        return { success: true, data: { success: true } }
      }
      return { success: true, data: { success: false } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // Open file dialog for database
  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN_FILE, async (): Promise<IpcResult<string>> => {
    try {
      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openFile'],
        filters: [{ name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] }],
      })
      if (result.canceled || result.filePaths.length === 0) return { success: false, error: 'User cancelled' }
      return { success: true, data: result.filePaths[0] }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // Open URL in system default browser (via OS shell)
  // 防止 window.open 在 Electron 中打开内置 webview
  // 协议白名单:仅允许 http(s) 协议,避免 javascript:/file:/cmd: 等协议注入
  ipcMain.handle('shell:openExternal', async (_event, url: string): Promise<IpcResult<true>> => {
    try {
      if (typeof url !== 'string' || !url) {
        return { success: false, error: '链接为空' }
      }
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { success: false, error: '链接格式无效' }
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false, error: `不支持的协议: ${parsed.protocol}` }
      }
      await shell.openExternal(url)
      return { success: true, data: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}

app.whenReady().then(() => {
  // macOS: set Dock icon in dev mode (only PNG, and only if file exists)
  if (process.platform === 'darwin' && VITE_DEV_SERVER_URL) {
    try {
      const iconPath = path.join(process.env.APP_ROOT, 'build', 'icon.png')
      if (fs.existsSync(iconPath)) {
        app.dock.setIcon(iconPath)
      }
    } catch { /* ignore */ }
  }

  // macOS About panel
  app.setAboutPanelOptions({
    applicationName: 'DBScope-OC',
    applicationVersion: app.getVersion(),
    credits: 'by WEBB',
  })

  // Register IPC handlers first (before window creation)
  registerIpcHandlers()

  // Create window (must succeed even if DB fails)
  createWindow()
  backupIpc.startScheduler()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Try to auto-open the default opencode.db (non-blocking)
  const homeDir = os.homedir()
  const defaultDbPath = path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db')
  const testDbPath = path.join(process.env.APP_ROOT!, 'test-data', 'test.db')

  try {
    if (fs.existsSync(defaultDbPath)) {
      DatabaseManager.open(defaultDbPath)
    } else if (fs.existsSync(testDbPath)) {
      DatabaseManager.open(testDbPath)
    }
  } catch (err) {
    console.error('Failed to auto-open database:', err)
    dialog.showErrorBox('数据库打开失败', `自动打开数据库时出错：${(err as Error).message}`)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  DatabaseManager.closeAll()
})
