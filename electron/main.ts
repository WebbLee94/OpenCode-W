import { app, BrowserWindow, ipcMain, dialog } from 'electron'
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
import * as accountsIpc from './ipc/accounts'
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
  accountsIpc.registerHandlers()
  eventsIpc.registerHandlers()

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
