import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseStats, TableStats } from '../shared/types'

export class DatabaseManager {
  private static instance: DatabaseManager | null = null
  private connections: Map<string, Database.Database> = new Map()
  private currentPath: string | null = null

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager()
    }
    return DatabaseManager.instance
  }

  open(dbPath: string): Database.Database {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Database file not found: ${dbPath}`)
    }

    const absPath = path.resolve(dbPath)

    // Close existing connection to same path
    if (this.connections.has(absPath)) {
      this.close(absPath)
    }

    const db = new Database(absPath, { readonly: false })
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    this.connections.set(absPath, db)
    this.currentPath = absPath
    return db
  }

  close(dbPath?: string): void {
    const target = dbPath ? path.resolve(dbPath) : this.currentPath
    if (target && this.connections.has(target)) {
      this.connections.get(target)!.close()
      this.connections.delete(target)
      if (this.currentPath === target) {
        this.currentPath = null
      }
    }
  }

  getDb(): Database.Database {
    if (!this.currentPath || !this.connections.has(this.currentPath)) {
      throw new Error('No database currently open')
    }
    return this.connections.get(this.currentPath)!
  }

  getCurrentPath(): string | null {
    return this.currentPath
  }

  healthCheck(): { ok: boolean; pageCount: number; freelistPages: number; walSize: number } {
    const db = this.getDb()
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
      const freelistCount = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count

      // Check WAL size
      let walSize = 0
      if (this.currentPath) {
        const walPath = this.currentPath + '-wal'
        try {
          walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
        } catch {
          /* ignore */
        }
      }

      return {
        ok: integrity.integrity_check === 'ok',
        pageCount,
        freelistPages: freelistCount,
        walSize,
      }
    } catch {
      return { ok: false, pageCount: 0, freelistPages: 0, walSize: 0 }
    }
  }

  getStats(): DatabaseStats {
    const db = this.getDb()
    let dbSize = 0
    let walSize = 0

    if (this.currentPath) {
      try {
        dbSize = fs.statSync(this.currentPath).size
        const walPath = this.currentPath + '-wal'
        walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
      } catch {
        /* ignore */
      }
    }

    const sessionCount = (db.prepare('SELECT COUNT(*) as cnt FROM session').get() as { cnt: number }).cnt
    const projectCount = (
      db.prepare(
        "SELECT COUNT(DISTINCT project_id) as cnt FROM session WHERE project_id IS NOT NULL AND project_id != ''"
      ).get() as { cnt: number }
    ).cnt
    const partCount = (db.prepare('SELECT COUNT(*) as cnt FROM part').get() as { cnt: number }).cnt
    const freelistCount = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count
    const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size

    return {
      dbSize,
      sessionCount,
      projectCount,
      partCount,
      freelistSize: freelistCount * pageSize,
      walSize,
    }
  }

  getTableStats(): TableStats[] {
    const db = this.getDb()
    const tables = ['session', 'message', 'part']
    return tables.map(name => {
      const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${name}`).get() as { cnt: number }
      // Estimate data size
      const sizeRow = db.prepare(`SELECT SUM(LENGTH(data)) as size FROM ${name}`).get() as {
        size: number | null
      }
      return {
        name,
        rowCount: row.cnt,
        dataSize: sizeRow?.size ?? 0,
      }
    })
  }

  vacuum(): { before: number; after: number; freed: number } {
    const db = this.getDb()
    let beforeSize = 0
    if (this.currentPath) {
      beforeSize = fs.statSync(this.currentPath).size
    }
    db.pragma('vacuum')
    let afterSize = 0
    if (this.currentPath) {
      afterSize = fs.statSync(this.currentPath).size
    }
    return { before: beforeSize, after: afterSize, freed: beforeSize - afterSize }
  }

  checkpoint(): void {
    const db = this.getDb()
    db.pragma('wal_checkpoint(TRUNCATE)')
  }

  rawQuery<T>(sql: string, params: unknown[] = []): T[] {
    const db = this.getDb()
    return db.prepare(sql).all(...params) as T[]
  }

  rawGet<T>(sql: string, params: unknown[] = []): T | undefined {
    const db = this.getDb()
    return db.prepare(sql).get(...params) as T | undefined
  }

  run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number } {
    const db = this.getDb()
    const result = db.prepare(sql).run(...params)
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid as number }
  }

  closeAll(): void {
    for (const [p] of this.connections) {
      this.connections.get(p)!.close()
    }
    this.connections.clear()
    this.currentPath = null
  }
}

export default DatabaseManager.getInstance()
