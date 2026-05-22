import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { SessionDTO, SessionDetailDTO, SessionFilter, TokenStats, ToolRanking, IpcResult } from '../../shared/types'
import dbManager from '../database'

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

export function registerHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_LIST,
    (_event, filter?: SessionFilter): IpcResult<{ data: SessionDTO[]; total: number; page: number; pageSize: number }> => {
      try {
      const page = filter?.page ?? 1
      const pageSize = filter?.pageSize ?? 50
      const offset = (page - 1) * pageSize
      const sortBy = filter?.sortBy ?? 'time_updated'
      const sortOrder = filter?.sortOrder ?? 'desc'

      // Build WHERE clause
      const conditions: string[] = []
      const params: unknown[] = []

      if (filter?.search) {
        conditions.push('(s.title LIKE ? OR s.id LIKE ?)')
        params.push(`%${filter.search}%`, `%${filter.search}%`)
      }
      if (filter?.projectId) {
        conditions.push('s.directory = ?')
        params.push(filter.projectId)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      // Validate sort column to prevent SQL injection
      const allowedSortColumns = ['time_created', 'time_updated', 'title', 'cost', 'msg_count', 'total_tokens', 'data_size', 'tokens_input', 'tokens_output']
      const safeSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'time_updated'
      const safeSortOrder = sortOrder === 'asc' ? 'ASC' : 'DESC'
      // Computed columns (aliases) must not use s. prefix in ORDER BY
      const computedColumns = ['msg_count', 'total_tokens', 'data_size']
      const orderExpr = computedColumns.includes(safeSortBy) ? safeSortBy : `s.${safeSortBy}`

      // Count total
      const countRow = dbManager.rawGet<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM session s ${whereClause}`,
        params
      )
      const total = countRow?.cnt ?? 0

      // Query sessions with aggregated data
      const rows = dbManager.rawQuery<Record<string, unknown>>(
        `SELECT
          s.*,
          COALESCE(msg_cnt.cnt, 0) as msg_count,
          (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0)) as total_tokens,
          COALESCE(part_size.total, 0) as data_size
        FROM session s
        LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM message GROUP BY session_id) msg_cnt ON s.id = msg_cnt.session_id
        LEFT JOIN (SELECT session_id, SUM(LENGTH(data)) as total FROM part GROUP BY session_id) part_size ON s.id = part_size.session_id
        ${whereClause}
        ORDER BY ${orderExpr} ${safeSortOrder}
        LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      )

      return {
        success: true,
        data: {
          data: rows.map(mapSessionRow),
          total,
          page,
          pageSize,
        },
      }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_DETAIL,
    (_event, sessionId: string): IpcResult<SessionDetailDTO | null> => {
      try {
      // Get session base info
      const row = dbManager.rawGet<Record<string, unknown>>(
        `SELECT
          s.*,
          COALESCE(msg_cnt.cnt, 0) as msg_count,
          (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0)) as total_tokens,
          COALESCE(part_size.total, 0) as data_size
        FROM session s
        LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM message GROUP BY session_id) msg_cnt ON s.id = msg_cnt.session_id
        LEFT JOIN (SELECT session_id, SUM(LENGTH(data)) as total FROM part GROUP BY session_id) part_size ON s.id = part_size.session_id
        WHERE s.id = ?`,
        [sessionId]
      )

      if (!row) return { success: true, data: null }

      const session = mapSessionRow(row)

      // Compute token stats
      const tokenStatsRow = dbManager.rawGet<Record<string, number>>(
        `SELECT
          COALESCE(SUM(tokens_input), 0) as inputTokens,
          COALESCE(SUM(tokens_output), 0) as outputTokens,
          COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
          COALESCE(SUM(tokens_cache_read), 0) as cacheRead,
          COALESCE(SUM(tokens_cache_write), 0) as cacheWrite,
          COALESCE(SUM(cost), 0) as estimatedCost
        FROM session WHERE id = ?`,
        [sessionId]
      )

      const totalInput = tokenStatsRow?.inputTokens ?? 0
      const cacheRead = tokenStatsRow?.cacheRead ?? 0
      const cacheHitRate = totalInput > 0 ? (cacheRead / totalInput) * 100 : 0

      const tokenStats: TokenStats = {
        inputTokens: tokenStatsRow?.inputTokens ?? 0,
        outputTokens: tokenStatsRow?.outputTokens ?? 0,
        reasoningTokens: tokenStatsRow?.reasoningTokens ?? 0,
        cacheRead,
        cacheWrite: tokenStatsRow?.cacheWrite ?? 0,
        estimatedCost: tokenStatsRow?.estimatedCost ?? 0,
        cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      }

      // Get tool ranking - type is inside data JSON
      const toolRows = dbManager.rawQuery<Record<string, unknown>>(
        `SELECT
          json_extract(data, '$.tool') as toolName,
          COUNT(*) as count
        FROM part
        WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.tool') IS NOT NULL
        GROUP BY toolName
        ORDER BY count DESC`,
        [sessionId]
      )

      const toolRanking: ToolRanking[] = toolRows.map(r => ({
        toolName: r.toolName as string,
        count: r.count as number,
      }))

      // Get skill list - type is inside data JSON
      const skillRows = dbManager.rawQuery<Record<string, unknown>>(
        `SELECT DISTINCT json_extract(data, '$.state.input.name') as skillName
        FROM part
        WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.tool') = 'skill' AND json_extract(data, '$.state.input.name') IS NOT NULL`,
        [sessionId]
      )

      const skillList: string[] = skillRows.map(r => r.skillName as string)

      const detail: SessionDetailDTO = {
        ...session,
        tokenStats,
        toolRanking,
        skillList,
      }

      return { success: true, data: detail }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.SESSIONS_PROJECTS, (): IpcResult<string[]> => {
    try {
      const rows = dbManager.rawQuery<{ directory: string }>(
        "SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL AND directory != '' ORDER BY directory"
      )
      return { success: true, data: rows.map(r => r.directory) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_DELETE,
    (_event, sessionId: string): IpcResult<{ deleted: boolean; deletedParts: number; deletedMessages: number; deletedSessions: number }> => {
      try {
      const partResult = dbManager.run('DELETE FROM part WHERE session_id = ?', [sessionId])
      const messageResult = dbManager.run('DELETE FROM message WHERE session_id = ?', [sessionId])
      const sessionResult = dbManager.run('DELETE FROM session WHERE id = ?', [sessionId])

      return {
        success: true,
        data: {
          deleted: sessionResult.changes > 0,
          deletedParts: partResult.changes,
          deletedMessages: messageResult.changes,
          deletedSessions: sessionResult.changes,
        },
      }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )
}
