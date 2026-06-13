import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { SessionDTO, SessionDetailDTO, SessionFilter, SessionShareDTO, TokenStats, ToolRanking, IpcResult } from '../../shared/types'
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
    childCount: (row.childCount as number) ?? 0,
  }
}

export function registerHandlers(): void {
  // Check if session table has parent_id column (added in later OpenCode versions)
  let hasParentColumn: boolean | null = null
  const checkParentColumn = () => {
    if (hasParentColumn !== null) return hasParentColumn
    try {
      const cols = dbManager.rawQuery<{ name: string }>(`PRAGMA table_info(session)`)
      hasParentColumn = cols.some(c => c.name === 'parent_id')
    } catch { hasParentColumn = false }
    return hasParentColumn
  }

  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_LIST,
    (_event, filter?: SessionFilter): IpcResult<{ data: SessionDTO[]; total: number; page: number; pageSize: number }> => {
      try {
      const page = filter?.page ?? 1
      const pageSize = Math.min(filter?.pageSize ?? 50, 200)
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
      if (filter?.startDate) {
        conditions.push('date(s.time_created / 1000, \'unixepoch\') >= ?')
        params.push(filter.startDate)
      }
      if (filter?.endDate) {
        conditions.push('date(s.time_created / 1000, \'unixepoch\') <= ?')
        params.push(filter.endDate)
      }
      // Parent filter — only apply if column exists
      if (checkParentColumn()) {
        if (filter?.parentFilter === 'children') {
          conditions.push('s.parent_id IS NOT NULL')
        } else if (!filter?.parentFilter || filter?.parentFilter === 'root') {
          conditions.push('s.parent_id IS NULL')
        }
        // 'all' — no parent filter
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      // Validate sort column to prevent SQL injection
      const allowedSortColumns = ['time_created', 'time_updated', 'title', 'cost', 'msg_count', 'total_tokens', 'data_size', 'tokens_input', 'tokens_output', 'childCount']
      const safeSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'time_updated'
      const safeSortOrder = sortOrder === 'asc' ? 'ASC' : 'DESC'
      const computedColumns = ['msg_count', 'total_tokens', 'data_size', 'childCount']
      const orderExpr = computedColumns.includes(safeSortBy) ? safeSortBy : `s.${safeSortBy}`

      const runQuery = (wc: string) => {
        const childSelect = ', COALESCE((SELECT COUNT(*) FROM session c WHERE c.parent_id = s.id), 0) as childCount'
        const countRow = dbManager.rawGet<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM session s ${wc}`, params)
        const total = countRow?.cnt ?? 0
        const rows = dbManager.rawQuery<Record<string, unknown>>(
          `SELECT s.*, COALESCE(msg_cnt.cnt, 0) as msg_count, (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0)) as total_tokens, COALESCE(part_size.total, 0) as data_size${childSelect} FROM session s LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM message GROUP BY session_id) msg_cnt ON s.id = msg_cnt.session_id LEFT JOIN (SELECT session_id, SUM(LENGTH(data)) as total FROM part GROUP BY session_id) part_size ON s.id = part_size.session_id ${wc} ORDER BY ${orderExpr} ${safeSortOrder} LIMIT ? OFFSET ?`,
          [...params, pageSize, offset]
        )
        return { total, rows }
      }

      const { total, rows } = runQuery(whereClause)
      return { success: true, data: { data: rows.map(mapSessionRow), total, page, pageSize } }
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

      const inputTokens = tokenStatsRow?.inputTokens ?? 0
      const outputTokens = tokenStatsRow?.outputTokens ?? 0
      const reasoningTokens = tokenStatsRow?.reasoningTokens ?? 0
      const cacheRead = tokenStatsRow?.cacheRead ?? 0
      const totalTokens = inputTokens + outputTokens + reasoningTokens
      const cacheReuseRate = totalTokens > 0 ? (cacheRead / totalTokens) * 100 : 0

      const tokenStats: TokenStats = {
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheRead,
        cacheWrite: tokenStatsRow?.cacheWrite ?? 0,
        estimatedCost: tokenStatsRow?.estimatedCost ?? 0,
        cacheReuseRate: Math.round(cacheReuseRate * 100) / 100,
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

  // Session share — get share info for a session
  ipcMain.handle(
    IPC_CHANNELS.SESSION_SHARE_GET,
    (_event, sessionId: string): IpcResult<SessionShareDTO | null> => {
      try {
        const row = dbManager.rawGet<SessionShareDTO>(
          'SELECT * FROM session_share WHERE session_id = ?',
          [sessionId]
        )
        return { success: true, data: row ?? null }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
      }
  )

  // ─── Session Rename ────────────────────────────────────────────

  ipcMain.handle('sessions:rename', async (_event, { sessionId, title }: { sessionId: string; title: string }) => {
    try {
      dbManager.getDb().prepare('UPDATE session SET title = ? WHERE id = ?').run(title, sessionId)
      return { success: true }
    } catch (e) { return { success: false, error: (e as Error).message } }
  })

  // ─── Route B: Session Parent/Children ────────────────────────────

  ipcMain.handle(IPC_CHANNELS.SESSIONS_PARENT, (_event, sessionId: string): IpcResult<SessionDTO | null> => {
    if (!checkParentColumn()) return { success: true, data: null }
    try {
      const s = dbManager.rawGet<{ parent_id: string | null }>('SELECT parent_id FROM session WHERE id = ?', [sessionId])
      if (!s?.parent_id) return { success: true, data: null }
      const parent = dbManager.rawGet<SessionDTO>('SELECT id, title, time_created FROM session WHERE id = ?', [s.parent_id])
      return { success: true, data: parent ?? null }
    } catch (error) { return { success: false, error: (error as Error).message } }
  })

  ipcMain.handle(IPC_CHANNELS.SESSIONS_CHILDREN, (_event, sessionId: string): IpcResult<SessionDTO[]> => {
    if (!checkParentColumn()) return { success: true, data: [] }
    try {
      const children = dbManager.rawQuery<Record<string, unknown>>(
        `SELECT
          s.id, s.title, s.directory, s.model, s.agent, s.project_id,
          s.tokens_input, s.tokens_output, s.tokens_reasoning,
          s.tokens_cache_read, s.tokens_cache_write, s.cost,
          s.time_created, s.time_updated,
          COALESCE(msg_cnt.cnt, 0) as msg_count,
          (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0)) as total_tokens,
          COALESCE(part_size.total, 0) as data_size
        FROM session s
        LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM message GROUP BY session_id) msg_cnt ON s.id = msg_cnt.session_id
        LEFT JOIN (SELECT session_id, SUM(LENGTH(data)) as total FROM part GROUP BY session_id) part_size ON s.id = part_size.session_id
        WHERE s.parent_id = ?
        ORDER BY s.time_created ASC`,
        [sessionId]
      )
      const mapped = children.map(mapSessionRow)
      return { success: true, data: mapped }
    } catch (error) { return { success: false, error: (error as Error).message } }
  })
}
