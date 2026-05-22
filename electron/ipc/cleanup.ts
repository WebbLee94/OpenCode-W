import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { CleanupPreviewDTO, CleanupResultDTO, CleanupFilter, SessionDTO, IpcResult } from '../../shared/types'
import dbManager from '../database'

const DANGEROUS_PATTERNS = [
  /;/, /\bDROP\b/i, /\bDELETE\b/i, /\bINSERT\b/i,
  /\bUPDATE\b/i, /\bALTER\b/i, /--/, /\/\*/,
]

const ALLOWED_PATTERN = /^(?:[\s\w.'"(),%0-9]|AND|OR|LIKE|IN|NOT|IS|NULL|=|!=|>=|<=|<>|>|<)+$/i

function validateCustomWhere(clause: string): boolean {
  if (DANGEROUS_PATTERNS.some(p => p.test(clause))) return false
  if (!ALLOWED_PATTERN.test(clause)) return false
  return true
}

function mapSessionRow(row: Record<string, unknown>): SessionDTO {
  const timeCreated = typeof row.time_created === 'string'
    ? new Date(row.time_created).getTime()
    : (row.time_created as number)
  const timeUpdated = typeof row.time_updated === 'string'
    ? new Date(row.time_updated).getTime()
    : (row.time_updated as number)

  return {
    id: row.id as string,
    title: (row.title as string) ?? '',
    directory: row.directory as string | undefined,
    model: row.model as string | undefined,
    agent: row.agent as string | undefined,
    project_id: row.project_id as string | undefined,
    msg_count: (row.msg_count as number) ?? 0,
    total_tokens: (row.total_tokens as number) ?? 0,
    data_size: (row.data_size as number) ?? 0,
    tokens_input: (row.tokens_input as number) ?? 0,
    tokens_output: (row.tokens_output as number) ?? 0,
    tokens_reasoning: (row.tokens_reasoning as number) ?? 0,
    time_created: timeCreated,
    time_updated: timeUpdated,
    cost: row.cost as number | undefined,
  }
}

function buildCleanupWhereClause(filter: CleanupFilter): { sql: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  switch (filter.strategy) {
    case 'time': {
      const days = filter.days ?? 30
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
      conditions.push('s.time_updated < ?')
      params.push(cutoff)
      break
    }
    case 'size': {
      const sizeBytes = (filter.sizeMB ?? 100) * 1024 * 1024
      conditions.push('COALESCE(part_size.total, 0) > ?')
      params.push(sizeBytes)
      break
    }
    case 'project': {
      if (filter.projectId) {
        conditions.push('s.project_id = ?')
        params.push(filter.projectId)
      }
      break
    }
    case 'custom': {
      if (filter.customWhere) {
        if (!validateCustomWhere(filter.customWhere)) {
          throw new Error('Invalid custom WHERE clause')
        }
        conditions.push(filter.customWhere)
      }
      break
    }
  }

  // Exclude specified session IDs
  if (filter.excludedSessionIds && filter.excludedSessionIds.length > 0) {
    const placeholders = filter.excludedSessionIds.map(() => '?').join(',')
    conditions.push(`s.id NOT IN (${placeholders})`)
    params.push(...filter.excludedSessionIds)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return { sql: whereClause, params }
}

export function registerHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CLEANUP_PREVIEW,
    (_event, filter: CleanupFilter): IpcResult<CleanupPreviewDTO> => {
      try {
        const { sql: whereClause, params } = buildCleanupWhereClause(filter)

        // Get matching sessions
        const rows = dbManager.rawQuery<Record<string, unknown>>(
          `SELECT
          s.*,
          COALESCE(msg_cnt.cnt, 0) as msg_count,
          (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0)) as total_tokens,
          COALESCE(part_size.total, 0) as data_size
        FROM session s
        LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM message GROUP BY session_id) msg_cnt ON s.id = msg_cnt.session_id
        LEFT JOIN (SELECT session_id, SUM(LENGTH(data)) as total FROM part GROUP BY session_id) part_size ON s.id = part_size.session_id
        ${whereClause}`,
          params
        )

        const sessions: SessionDTO[] = rows.map(mapSessionRow)
        const sessionIds = sessions.map(s => s.id)

        if (sessionIds.length === 0) {
          const preview: CleanupPreviewDTO = {
            sessionCount: 0,
            messageCount: 0,
            partCount: 0,
            estimatedSize: 0,
            sessions: [],
          }
          return { success: true, data: preview }
        }

        const placeholders = sessionIds.map(() => '?').join(',')

        const messageCount = (
          dbManager.rawGet<{ cnt: number }>(
            `SELECT COUNT(*) as cnt FROM message WHERE session_id IN (${placeholders})`,
            sessionIds
          )?.cnt ?? 0
        )

        const partCount = (
          dbManager.rawGet<{ cnt: number }>(
            `SELECT COUNT(*) as cnt FROM part WHERE session_id IN (${placeholders})`,
            sessionIds
          )?.cnt ?? 0
        )

        const estimatedSize = (
          dbManager.rawGet<{ total: number | null }>(
            `SELECT COALESCE(SUM(LENGTH(data)), 0) as total FROM part WHERE session_id IN (${placeholders})`,
            sessionIds
          )?.total ?? 0
        )

        const preview: CleanupPreviewDTO = {
          sessionCount: sessions.length,
          messageCount,
          partCount,
          estimatedSize,
          sessions,
        }

        return { success: true, data: preview }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLEANUP_EXECUTE,
    (_event, filter: CleanupFilter): IpcResult<CleanupResultDTO> => {
      try {
        const { sql: whereClause, params } = buildCleanupWhereClause(filter)

        // Get matching session IDs
        const rows = dbManager.rawQuery<{ id: string }>(
          `SELECT id FROM session s ${whereClause}`,
          params
        )

        const sessionIds = rows.map(r => r.id)

        if (sessionIds.length === 0) {
          const result: CleanupResultDTO = {
            deletedSessions: 0,
            deletedMessages: 0,
            deletedParts: 0,
            freedBytes: 0,
            vacuumBefore: 0,
            vacuumAfter: 0,
          }
          return { success: true, data: result }
        }

        const placeholders = sessionIds.map(() => '?').join(',')

        // Get size before deletion
        const sizeBefore = (
          dbManager.rawGet<{ total: number | null }>(
            `SELECT COALESCE(SUM(LENGTH(data)), 0) as total FROM part WHERE session_id IN (${placeholders})`,
            sessionIds
          )?.total ?? 0
        )

        // Wrap deletion in transaction
        let deletedParts = 0
        let deletedMessages = 0
        let deletedSessions = 0
        dbManager.rawRun('BEGIN TRANSACTION')
        try {
          // Delete in order: parts -> messages -> sessions (respect foreign keys)
          deletedParts = dbManager.run(
            `DELETE FROM part WHERE session_id IN (${placeholders})`,
            sessionIds
          ).changes

          deletedMessages = dbManager.run(
            `DELETE FROM message WHERE session_id IN (${placeholders})`,
            sessionIds
          ).changes

          deletedSessions = dbManager.run(
            `DELETE FROM session WHERE id IN (${placeholders})`,
            sessionIds
          ).changes

          dbManager.rawRun('COMMIT')
        } catch (txError) {
          dbManager.rawRun('ROLLBACK')
          throw txError
        }

        // Vacuum to reclaim space
        const vacuumResult = dbManager.vacuum()

        const result: CleanupResultDTO = {
          deletedSessions,
          deletedMessages,
          deletedParts,
          freedBytes: sizeBefore,
          vacuumBefore: vacuumResult.before,
          vacuumAfter: vacuumResult.after,
        }

        return { success: true, data: result }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )
}
