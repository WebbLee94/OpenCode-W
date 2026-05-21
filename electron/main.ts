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
import { IPC_CHANNELS } from '../shared/ipc-channels'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'DBScope-OC',
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, () => app.getVersion())
  ipcMain.handle(IPC_CHANNELS.APP_GET_PLATFORM, () => process.platform)

  // Database operations
  ipcMain.handle(IPC_CHANNELS.DATABASE_OPEN, async (_event, dbPath: string) => {
    try {
      DatabaseManager.open(dbPath)
      return { success: true, path: dbPath }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DATABASE_HEALTH, () => {
    try {
      return DatabaseManager.healthCheck()
    } catch {
      return { ok: false, pageCount: 0, freelistPages: 0, walSize: 0 }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DATABASE_VACUUM, () => {
    return DatabaseManager.vacuum()
  })

  ipcMain.handle(IPC_CHANNELS.DATABASE_CHECKPOINT, () => {
    DatabaseManager.checkpoint()
    return { success: true }
  })

  // Register feature IPC handlers
  sessionsIpc.registerHandlers()
  messagesIpc.registerHandlers()
  cleanupIpc.registerHandlers()
  analyticsIpc.registerHandlers()
  backupIpc.registerHandlers()

  // Open file dialog for database
  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN_FILE, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  registerIpcHandlers()

  // Try to auto-open the default opencode.db
  const homeDir = os.homedir()
  const defaultDbPath = path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db')
  // Also check for test database
  const testDbPath = path.join(process.env.APP_ROOT!, 'test-data', 'test.db')

  if (fs.existsSync(defaultDbPath)) {
    try {
      DatabaseManager.open(defaultDbPath)
    } catch { /* ignore */ }
  } else if (fs.existsSync(testDbPath)) {
    try {
      DatabaseManager.open(testDbPath)
    } catch { /* ignore */ }
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  DatabaseManager.closeAll()
})
