import { ipcMain, dialog } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { BackupDTO, BackupPreviewDTO, IpcResult } from '../../shared/types'
import dbManager from '../database'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const BACKUP_DIR = path.join(os.homedir(), '.DBScope-OC', 'backups')

function ensureBackupDir(): void {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
  }
}

function getBackupFiles(): BackupDTO[] {
  ensureBackupDir()

  const files = fs.readdirSync(BACKUP_DIR)
  const backups: BackupDTO[] = []

  for (const file of files) {
    if (!file.endsWith('.db')) continue
    const filePath = path.join(BACKUP_DIR, file)
    try {
      const stat = fs.statSync(filePath)
      // Parse timestamp from filename: opencode-backup-2024-01-15T10-30-00-000.db
      const dateMatch = file.match(/opencode-backup-(.+)\.db/)
      const createdAt = dateMatch ? (() => {
        // e.g. "2024-01-15T10-30-00-000" → "2024-01-15T10:30:00.000"
        const raw = dateMatch[1]
        const tIdx = raw.indexOf('T')
        if (tIdx === -1) return stat.mtime.toISOString()
        const datePart = raw.slice(0, tIdx) // "2024-01-15"
        const timePart = raw.slice(tIdx + 1) // "10-30-00-000"
        const timeSegments = timePart.split('-')
        const time = timeSegments.slice(0, 3).join(':') // "10:30:00"
        const ms = timeSegments[3] || '000' // "000"
        return `${datePart}T${time}.${ms}`
      })() : stat.mtime.toISOString()

      backups.push({
        fileName: file,
        filePath,
        fileSize: stat.size,
        createdAt,
        compressed: false,
      })
    } catch {
      /* skip unreadable files */
    }
  }

  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function registerHandlers(): void {
  // ─── Config handlers ──────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.BACKUP_CONFIG_GET, () => readBackupConfig().backup)
  ipcMain.handle(IPC_CHANNELS.BACKUP_CONFIG_SET, (_e, bc: Partial<BackupConfig>) => {
    const cfg = readBackupConfig(); cfg.backup = { ...cfg.backup, ...bc }; writeBackupConfig(cfg); startScheduler()
    return { success: true }
  })
  ipcMain.handle(IPC_CHANNELS.BACKUP_AUTO_CHECK, async () => {
    const cfg = readBackupConfig().backup
    if (cfg.enabled && cfg.frequency === 'onOpen') {
      try {
        const dbPath = dbManager.getCurrentPath()
        if (!dbPath) return { success: false, error: 'No database open' }
        ensureBackupDir(); const ts = Date.now()
        fs.copyFileSync(dbPath, path.join(BACKUP_DIR, `auto-${ts}.db`))
        enforceRetentionPolicy(); return { success: true }
      }
      catch(e) { return { success: false, error: (e as Error).message } }
    }
    return { success: true }
  })

  // ─── Existing handlers ─────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.BACKUP_CREATE, async (): Promise<IpcResult<BackupDTO>> => {
    try {
    const dbPath = dbManager.getCurrentPath()
    if (!dbPath) {
      return { success: false, error: 'No database currently open' }
    }

    ensureBackupDir()

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const fileName = `opencode-backup-${timestamp}.db`
    const filePath = path.join(BACKUP_DIR, fileName)

    // Copy the main database file
    fs.copyFileSync(dbPath, filePath)

    // Also copy WAL and SHM files if they exist
    const walPath = dbPath + '-wal'
    const shmPath = dbPath + '-shm'
    if (fs.existsSync(walPath)) {
      fs.copyFileSync(walPath, filePath + '-wal')
    }
    if (fs.existsSync(shmPath)) {
      fs.copyFileSync(shmPath, filePath + '-shm')
    }

    const stat = fs.statSync(filePath)

    const backup: BackupDTO = {
      fileName,
      filePath,
      fileSize: stat.size,
      createdAt: new Date().toISOString(),
      compressed: false,
    }

    return { success: true, data: backup }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.BACKUP_LIST, (): IpcResult<BackupDTO[]> => {
    try {
      return { success: true, data: getBackupFiles() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.BACKUP_RESTORE,
    async (_event, filePath?: string): Promise<IpcResult<{ path: string }>> => {
      try {
      let backupPath: string

      if (filePath) {
        // Use the provided file path directly
        backupPath = filePath
      } else {
        // Fall back to file dialog
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: 'Select Backup to Restore',
          filters: [{ name: 'SQLite Database', extensions: ['db'] }],
          properties: ['openFile'],
        })

        if (canceled || filePaths.length === 0) return { success: false, error: 'User cancelled' }
        backupPath = filePaths[0]
      }

      if (!fs.existsSync(backupPath)) {
        return { success: false, error: 'Backup file not found' }
      }

      // Save current path for rollback
      const previousPath = dbManager.getCurrentPath()

      // Create a temporary safety backup before restore (transaction-like safety)
      let safetyBackupPath: string | null = null
      if (previousPath && fs.existsSync(previousPath)) {
        try {
          const safetyTimestamp = new Date().toISOString().replace(/[:.]/g, '-')
          safetyBackupPath = path.join(BACKUP_DIR, `safety-${safetyTimestamp}.db`)
          fs.copyFileSync(previousPath, safetyBackupPath)
        } catch {
          // Best effort - proceed even if safety backup fails
        }
      }

      // Close current database
      dbManager.closeAll()

      // Open the backup as the new database
      try {
        dbManager.open(backupPath)
        return { success: true, data: { path: backupPath } }
      } catch (error) {
        // Rollback: try to reopen the previous database
        if (previousPath) {
          try { dbManager.open(previousPath) } catch { /* best effort */ }
        }
        return { success: false, error: (error as Error).message }
      }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.BACKUP_DELETE,
    (_event, fileName: string): IpcResult<true> => {
      try {
      const filePath = path.join(BACKUP_DIR, fileName)

      // Security check: ensure the file is within the backup directory
      const resolvedPath = path.resolve(filePath)
      if (!resolvedPath.startsWith(path.resolve(BACKUP_DIR))) {
        return { success: false, error: 'Invalid backup file path' }
      }

      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: 'Backup file not found' }
      }

      fs.unlinkSync(resolvedPath)

      // Also remove WAL and SHM files if they exist
      const walPath = resolvedPath + '-wal'
      const shmPath = resolvedPath + '-shm'
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath)
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath)

      return { success: true, data: true }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.BACKUP_PREVIEW,
    (_event, fileName: string): IpcResult<BackupPreviewDTO> => {
      try {
      const filePath = path.join(BACKUP_DIR, fileName)

      // Security check
      const resolvedPath = path.resolve(filePath)
      if (!resolvedPath.startsWith(path.resolve(BACKUP_DIR))) {
        return { success: false, error: 'Invalid backup file path' }
      }

      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: 'Backup file not found' }
      }

      const stat = fs.statSync(resolvedPath)

      const backup: BackupDTO = {
        fileName,
        filePath: resolvedPath,
        fileSize: stat.size,
        createdAt: stat.mtime.toISOString(),
        compressed: false,
      }

      // Try to open the backup file read-only to get content counts
      let sessionCount = 0
      let messageCount = 0
      let partCount = 0

      try {
        const tempDb = new Database(resolvedPath, { readonly: true })
        try {
          sessionCount = (tempDb.prepare('SELECT COUNT(*) as cnt FROM session').get() as { cnt: number }).cnt
          messageCount = (tempDb.prepare('SELECT COUNT(*) as cnt FROM message').get() as { cnt: number }).cnt
          partCount = (tempDb.prepare('SELECT COUNT(*) as cnt FROM part').get() as { cnt: number }).cnt
        } finally {
          tempDb.close()
        }
      } catch {
        // If we can't read the backup database, just return 0 counts
      }

      const preview: BackupPreviewDTO = {
        ...backup,
        sessionCount,
        messageCount,
        partCount,
      }

      return { success: true, data: preview }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )
}

// ─── Backup Config & Auto-Scheduler ─────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), '.DBScope-OC', 'config.json')

interface BackupConfig {
  enabled: boolean
  frequency: 'daily' | 'weekly' | 'onOpen'
  maxCount: number
  maxAgeDays: number
}

const DEFAULT_BACKUP: BackupConfig = { enabled: false, frequency: 'daily', maxCount: 10, maxAgeDays: 30 }

function readBackupConfig(): { backup: BackupConfig } {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as { backup?: Partial<BackupConfig> }
    return { backup: { ...DEFAULT_BACKUP, ...(raw.backup ?? {}) } }
  } catch { return { backup: DEFAULT_BACKUP } }
}
function writeBackupConfig(cfg: { backup: BackupConfig }): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8')
}
function enforceRetentionPolicy() {
  const cfg = readBackupConfig().backup
  if (!fs.existsSync(BACKUP_DIR)) return
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.backup.db') || (f.startsWith('opencode-backup-') && f.endsWith('.db')))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime)
  const maxAge = (cfg.maxAgeDays || 30) * 86400000
  const now = Date.now()
  files.forEach((f, i) => {
    if (i >= (cfg.maxCount || 10) || (now - f.mtime > maxAge))
      try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)) } catch { /* file may already be gone */ }
  })
}

let backupTimer: NodeJS.Timeout | null = null
function startScheduler() {
  const cfg = readBackupConfig().backup
  if (!cfg.enabled) return
  if (backupTimer) clearInterval(backupTimer)
  if (cfg.frequency === 'onOpen') return
  const interval = cfg.frequency === 'weekly' ? 604800000 : 86400000
  backupTimer = setInterval(() => {
    try {
      const dbPath = dbManager.getCurrentPath()
      if (!dbPath) return
      ensureBackupDir()
      fs.copyFileSync(dbPath, path.join(BACKUP_DIR, `auto-${Date.now()}.db`))
      enforceRetentionPolicy()
    } catch (e) { console.error('Auto backup failed:', e) }
  }, interval)
}
export { startScheduler }
