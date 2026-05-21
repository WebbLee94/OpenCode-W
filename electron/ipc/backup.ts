import { ipcMain, dialog, app } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { BackupDTO, BackupPreviewDTO } from '../../shared/types'
import dbManager from '../database'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

const BACKUP_DIR = path.join(app.getPath('userData'), 'backups')

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
      // Parse timestamp from filename: opencode-backup-2024-01-15T10-30-00.db
      const dateMatch = file.match(/opencode-backup-(.+)\.db/)
      const createdAt = dateMatch ? dateMatch[1].replace(/-/g, (_m, offset) => {
        // Restore ISO format: first 3 segments are date, rest is time
        if (offset < 10) return '-'
        if (offset === 10) return 'T'
        return ':'
      }) : stat.mtime.toISOString()

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
  ipcMain.handle(IPC_CHANNELS.BACKUP_CREATE, async () => {
    const dbPath = dbManager.getCurrentPath()
    if (!dbPath) {
      throw new Error('No database currently open')
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

    return backup
  })

  ipcMain.handle(IPC_CHANNELS.BACKUP_LIST, () => {
    return getBackupFiles()
  })

  ipcMain.handle(
    IPC_CHANNELS.BACKUP_RESTORE,
    async (_event, filePath?: string) => {
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

        if (canceled || filePaths.length === 0) return { success: false }
        backupPath = filePaths[0]
      }

      if (!fs.existsSync(backupPath)) {
        throw new Error('Backup file not found')
      }

      // Close current database
      dbManager.closeAll()

      // Open the backup as the new database
      try {
        dbManager.open(backupPath)
        return { success: true, path: backupPath }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.BACKUP_DELETE,
    (_event, fileName: string) => {
      const filePath = path.join(BACKUP_DIR, fileName)

      // Security check: ensure the file is within the backup directory
      const resolvedPath = path.resolve(filePath)
      if (!resolvedPath.startsWith(path.resolve(BACKUP_DIR))) {
        throw new Error('Invalid backup file path')
      }

      if (!fs.existsSync(resolvedPath)) {
        throw new Error('Backup file not found')
      }

      fs.unlinkSync(resolvedPath)

      // Also remove WAL and SHM files if they exist
      const walPath = resolvedPath + '-wal'
      const shmPath = resolvedPath + '-shm'
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath)
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath)

      return { success: true }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.BACKUP_PREVIEW,
    (_event, fileName: string) => {
      const filePath = path.join(BACKUP_DIR, fileName)

      // Security check
      const resolvedPath = path.resolve(filePath)
      if (!resolvedPath.startsWith(path.resolve(BACKUP_DIR))) {
        throw new Error('Invalid backup file path')
      }

      if (!fs.existsSync(resolvedPath)) {
        throw new Error('Backup file not found')
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

      return preview
    }
  )
}
