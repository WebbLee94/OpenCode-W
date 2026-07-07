import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { DatabaseStats, TokenStats, ToolRanking, SkillUsage, TokenGroupDataPoint, TimeRange, IpcResult, ModelRankingItem, ProviderStatsItem, SessionTrendItem, CostTrendItem, MessageTrendItem } from '../../shared/types'
import dbManager from '../database'

/** Build a SQL date filter clause for time_created (ms timestamp) */
function buildDateFilter(tableAlias: string, timeRange?: TimeRange): { sql: string; params: string[] } {
  if (!timeRange) return { sql: '', params: [] }
  return {
    sql: `AND date(${tableAlias ? tableAlias + '.' : ''}time_created / 1000, 'unixepoch', 'localtime') BETWEEN ? AND ?`,
    params: [timeRange.startDate, timeRange.endDate],
  }
}

export function registerHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.DASHBOARD_OVERVIEW, (_event, timeRange?: TimeRange): IpcResult<DatabaseStats> => {
    try {
      if (!timeRange) {
        const stats: DatabaseStats = dbManager.getStats()
        return { success: true, data: stats }
      }

      // Time-range filtered stats
      // 会话数按 根/子 拆分：根 = parent_id IS NULL,子 = parent_id IS NOT NULL
      // 走 session_parent_idx 索引,两条独立聚合可并行执行(已并入下方 Promise.all 中)
      const rootSessionCount = dbManager.rawGet<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM session
         WHERE parent_id IS NULL
           AND date(time_created / 1000, 'unixepoch', 'localtime') BETWEEN ? AND ?`,
        [timeRange.startDate, timeRange.endDate]
      )?.cnt ?? 0

      const childSessionCount = dbManager.rawGet<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM session
         WHERE parent_id IS NOT NULL
           AND date(time_created / 1000, 'unixepoch', 'localtime') BETWEEN ? AND ?`,
        [timeRange.startDate, timeRange.endDate]
      )?.cnt ?? 0

      const projectCount = dbManager.rawGet<{ cnt: number }>(
        `SELECT COUNT(DISTINCT project_id) as cnt FROM session WHERE project_id IS NOT NULL AND project_id != '' AND date(time_created / 1000, 'unixepoch', 'localtime') BETWEEN ? AND ?`,
        [timeRange.startDate, timeRange.endDate]
      )?.cnt ?? 0

      const partCount = dbManager.rawGet<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM part WHERE date(time_created / 1000, 'unixepoch', 'localtime') BETWEEN ? AND ?`,
        [timeRange.startDate, timeRange.endDate]
      )?.cnt ?? 0

      // File-level stats remain unchanged
      const baseStats = dbManager.getStats()

      const stats: DatabaseStats = {
        dbSize: baseStats.dbSize,
        rootSessionCount,
        childSessionCount,
        sessionCount: rootSessionCount + childSessionCount,
        projectCount,
        partCount,
        freelistSize: baseStats.freelistSize,
        walSize: baseStats.walSize,
      }

      return { success: true, data: stats }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_TOKENS, (_event, timeRange?: TimeRange, groupBy?: 'day' | 'week' | 'month'): IpcResult<TokenStats | TokenGroupDataPoint[]> => {
    try {
    // Token / cost 真实逐次用量记录在 part 表 type='step-finish' 的 data JSON 中
    // (session 表 tokens_*/cost 是 session 生命周期累计值, 按 session.time_created 归属
    //  会导致跨天 session 的 token 全部算在创建日, 按天/范围统计严重失真)
    const dateFilter = buildDateFilter('p', timeRange)

    if (groupBy) {
      const formatMap: Record<string, string> = {
        day: '%Y-%m-%d',
        week: '%Y-W%W',
        month: '%Y-%m',
      }
      const fmt = formatMap[groupBy] ?? '%Y-%m-%d'

      const rows = dbManager.rawQuery<Record<string, unknown>>(
        `SELECT
          strftime('${fmt}', p.time_created / 1000, 'unixepoch', 'localtime') as period,
          COALESCE(SUM(json_extract(p.data, '$.tokens.input')), 0) as inputTokens,
          COALESCE(SUM(json_extract(p.data, '$.tokens.output')), 0) as outputTokens,
          COALESCE(SUM(json_extract(p.data, '$.tokens.reasoning')), 0) as reasoningTokens,
          COALESCE(SUM(json_extract(p.data, '$.tokens.cache.read')), 0) as cacheRead,
          COALESCE(SUM(json_extract(p.data, '$.tokens.cache.write')), 0) as cacheWrite,
          COALESCE(SUM(json_extract(p.data, '$.cost')), 0) as estimatedCost
        FROM part p
        WHERE json_extract(p.data, '$.type') = 'step-finish' ${dateFilter.sql}
        GROUP BY period
        ORDER BY period ASC`,
        dateFilter.params
      )

      const grouped: TokenGroupDataPoint[] = rows.map(r => ({
        period: r.period as string,
        inputTokens: r.inputTokens as number,
        outputTokens: r.outputTokens as number,
        reasoningTokens: r.reasoningTokens as number,
        cacheRead: r.cacheRead as number,
        cacheWrite: r.cacheWrite as number,
        estimatedCost: r.estimatedCost as number,
      }))

      return { success: true, data: grouped }
    }

    const row = dbManager.rawGet<Record<string, number>>(
      `SELECT
        COALESCE(SUM(json_extract(p.data, '$.tokens.input')), 0) as inputTokens,
        COALESCE(SUM(json_extract(p.data, '$.tokens.output')), 0) as outputTokens,
        COALESCE(SUM(json_extract(p.data, '$.tokens.reasoning')), 0) as reasoningTokens,
        COALESCE(SUM(json_extract(p.data, '$.tokens.cache.read')), 0) as cacheRead,
        COALESCE(SUM(json_extract(p.data, '$.tokens.cache.write')), 0) as cacheWrite,
        COALESCE(SUM(json_extract(p.data, '$.cost')), 0) as estimatedCost
      FROM part p
      WHERE json_extract(p.data, '$.type') = 'step-finish' ${dateFilter.sql}`,
      dateFilter.params
    )

    const inputTokens = row?.inputTokens ?? 0
    const outputTokens = row?.outputTokens ?? 0
    const reasoningTokens = row?.reasoningTokens ?? 0
    const cacheRead = row?.cacheRead ?? 0
    const totalTokens = inputTokens + outputTokens + reasoningTokens
    const cacheReuseRate = totalTokens > 0 ? (cacheRead / totalTokens) * 100 : 0

    const tokenStats: TokenStats = {
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheRead,
      cacheWrite: row?.cacheWrite ?? 0,
      estimatedCost: row?.estimatedCost ?? 0,
      cacheReuseRate: Math.round(cacheReuseRate * 100) / 100,
    }

    return { success: true, data: tokenStats }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_TOOL_RANKING, (_event, timeRange?: TimeRange): IpcResult<ToolRanking[]> => {
    try {
    const dateFilter = buildDateFilter('', timeRange)

    // type is inside data JSON, not a column
    const rows = dbManager.rawQuery<Record<string, unknown>>(
      `SELECT
        COALESCE(json_extract(data, '$.tool'), 'unknown') as toolName,
        COUNT(*) as count
      FROM part
      WHERE json_extract(data, '$.type') = 'tool' ${dateFilter.sql}
      GROUP BY toolName
      ORDER BY count DESC
      LIMIT 20`,
      dateFilter.params
    )

    const ranking: ToolRanking[] = rows.map(r => ({
      toolName: r.toolName as string,
      count: r.count as number,
    }))

    return { success: true, data: ranking }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_SKILL_USAGE, (_event, timeRange?: TimeRange): IpcResult<SkillUsage[]> => {
    try {
    const dateFilter = buildDateFilter('', timeRange)

    // type is inside data JSON, not a column
    const rows = dbManager.rawQuery<Record<string, unknown>>(
      `SELECT
        COALESCE(json_extract(data, '$.state.input.name'), 'unknown') as skillName,
        COUNT(*) as count
      FROM part
      WHERE json_extract(data, '$.type') = 'tool'
        AND json_extract(data, '$.tool') = 'skill' ${dateFilter.sql}
      GROUP BY skillName
      ORDER BY count DESC
      LIMIT 20`,
      dateFilter.params
    )

    const usage: SkillUsage[] = rows.map(r => ({
      skillName: r.skillName as string,
      count: r.count as number,
    }))

    return { success: true, data: usage }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // ─── Route B: Model & Provider Stats ────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_MODEL_RANKING, (_event, timeRange?: TimeRange): IpcResult<ModelRankingItem[]> => {
    try {
      const dateFilter = buildDateFilter('p', timeRange)
      const rows = dbManager.rawQuery<Record<string, unknown>>(
        `SELECT s.model as model,
                COUNT(DISTINCT p.session_id) as sessionCount,
                COALESCE(SUM(json_extract(p.data, '$.tokens.total')), 0) as tokenCount,
                COALESCE(SUM(json_extract(p.data, '$.cost')), 0) as totalCost
         FROM part p
         JOIN session s ON s.id = p.session_id
         WHERE json_extract(p.data, '$.type') = 'step-finish'
           AND s.model IS NOT NULL ${dateFilter.sql}
         GROUP BY s.model
         ORDER BY sessionCount DESC
         LIMIT 10`,
        dateFilter.params
      )
      return { success: true, data: rows.map(r => ({ model: r.model as string, sessionCount: r.sessionCount as number, tokenCount: r.tokenCount as number, totalCost: r.totalCost as number })) }
    } catch (error) { return { success: false, error: (error as Error).message } }
  })

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_PROVIDER_STATS, (_event, timeRange?: TimeRange): IpcResult<ProviderStatsItem[]> => {
    try {
      // session 表无 account_id 列, provider 信息从 session.model JSON 的 providerID 提取
      const dateFilter = buildDateFilter('p', timeRange)
      const rows = dbManager.rawQuery<Record<string, unknown>>(
        `SELECT json_extract(s.model, '$.providerID') as provider,
                COUNT(DISTINCT p.session_id) as sessionCount,
                COALESCE(SUM(json_extract(p.data, '$.tokens.total')), 0) as tokenCount,
                COALESCE(SUM(json_extract(p.data, '$.cost')), 0) as totalCost
         FROM part p
         JOIN session s ON s.id = p.session_id
         WHERE json_extract(p.data, '$.type') = 'step-finish'
           AND json_extract(s.model, '$.providerID') IS NOT NULL ${dateFilter.sql}
         GROUP BY provider
         ORDER BY sessionCount DESC`,
        dateFilter.params
      )
      return { success: true, data: rows.map(r => ({ provider: (r.provider as string) || 'unknown', sessionCount: r.sessionCount as number, tokenCount: r.tokenCount as number, totalCost: r.totalCost as number })) }
    } catch (error) { return { success: false, error: (error as Error).message } }
  })

  // ── Session 增长趋势 ────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.DASHBOARD_SESSION_TREND,
    (_event, timeRange?: TimeRange, rootOnly?: boolean): IpcResult<SessionTrendItem[]> => {
      try {
        const dateFilter = buildDateFilter('', timeRange)
        const rootFilter = rootOnly ? ' AND parent_id IS NULL' : ''
        const rows = dbManager.rawQuery<{ d: string; cnt: number }>(
          `SELECT date(time_created / 1000, 'unixepoch', 'localtime') as d,
                  COUNT(*) as cnt
           FROM session
           WHERE 1=1 ${dateFilter.sql}${rootFilter}
           GROUP BY d
           ORDER BY d ASC`,
          dateFilter.params
        )
        return {
          success: true,
          data: rows.map(r => ({ date: r.d, value: r.cnt, count: r.cnt } as SessionTrendItem)),
        }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // ── 成本趋势 ────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.DASHBOARD_COST_TREND,
    (_event, timeRange?: TimeRange): IpcResult<CostTrendItem[]> => {
      try {
        const dateFilter = buildDateFilter('p', timeRange)
        const rows = dbManager.rawQuery<{ d: string; c: number }>(
          `SELECT date(p.time_created / 1000, 'unixepoch', 'localtime') as d,
                  COALESCE(SUM(json_extract(p.data, '$.cost')), 0) as c
           FROM part p
           WHERE json_extract(p.data, '$.type') = 'step-finish' ${dateFilter.sql}
           GROUP BY d
           ORDER BY d ASC`,
          dateFilter.params
        )
        return {
          success: true,
          data: rows.map(r => ({ date: r.d, value: r.c, totalCost: r.c } as CostTrendItem)),
        }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // ── 消息活跃度趋势 ──────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.DASHBOARD_MESSAGE_TREND,
    (_event, timeRange?: TimeRange): IpcResult<MessageTrendItem[]> => {
      try {
        const dateFilter = buildDateFilter('', timeRange)
        const rows = dbManager.rawQuery<{ d: string; cnt: number }>(
          `SELECT date(m.time_created / 1000, 'unixepoch', 'localtime') as d,
                  COUNT(*) as cnt
           FROM message m
           WHERE 1=1 ${dateFilter.sql}
           GROUP BY d
           ORDER BY d ASC`,
          dateFilter.params
        )
        return {
          success: true,
          data: rows.map(r => ({ date: r.d, value: r.cnt, count: r.cnt } as MessageTrendItem)),
        }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )
}
