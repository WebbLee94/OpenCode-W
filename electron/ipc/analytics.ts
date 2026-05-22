import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { DatabaseStats, TokenStats, ToolRanking, SkillUsage, TrendDataPoint, TrendComparison, TokenGroupDataPoint, TimeRange, IpcResult } from '../../shared/types'
import dbManager from '../database'

/** Build a SQL date filter clause for time_created (ms timestamp) */
function buildDateFilter(tableAlias: string, timeRange?: TimeRange): { sql: string; params: string[] } {
  if (!timeRange) return { sql: '', params: [] }
  return {
    sql: `AND date(${tableAlias ? tableAlias + '.' : ''}time_created / 1000, 'unixepoch') BETWEEN ? AND ?`,
    params: [timeRange.startDate, timeRange.endDate],
  }
}

/** Query trend data for a given date range using GROUP BY */
function queryTrendData(startDate: string, endDate: string): TrendDataPoint[] {
  const sessionRows = dbManager.rawQuery<Record<string, unknown>>(
    `SELECT
      date(time_created / 1000, 'unixepoch') as date,
      COUNT(*) as newSessions
    FROM session
    WHERE date(time_created / 1000, 'unixepoch') BETWEEN ? AND ?
    GROUP BY date
    ORDER BY date ASC`,
    [startDate, endDate]
  )

  const messageRows = dbManager.rawQuery<Record<string, unknown>>(
    `SELECT
      date(time_created / 1000, 'unixepoch') as date,
      COUNT(*) as messageCount
    FROM message
    WHERE date(time_created / 1000, 'unixepoch') BETWEEN ? AND ?
    GROUP BY date
    ORDER BY date ASC`,
    [startDate, endDate]
  )

  // Single GROUP BY query instead of N+1 per-date queries
  const partSizeRows = dbManager.rawQuery<Record<string, unknown>>(
    `SELECT
      date(time_created / 1000, 'unixepoch') as date,
      COALESCE(SUM(LENGTH(data)), 0) as partSize
    FROM part
    WHERE date(time_created / 1000, 'unixepoch') BETWEEN ? AND ?
    GROUP BY date`,
    [startDate, endDate]
  )

  const trendMap = new Map<string, TrendDataPoint>()

  for (const row of sessionRows) {
    const date = row.date as string
    trendMap.set(date, {
      date,
      newSessions: (row.newSessions as number) ?? 0,
      sizeGrowth: 0,
      messageCount: 0,
    })
  }

  for (const row of messageRows) {
    const date = row.date as string
    const existing = trendMap.get(date)
    if (existing) {
      existing.messageCount = (row.messageCount as number) ?? 0
    } else {
      trendMap.set(date, {
        date,
        newSessions: 0,
        sizeGrowth: 0,
        messageCount: (row.messageCount as number) ?? 0,
      })
    }
  }

  // Apply part sizes from single GROUP BY query
  const partSizeMap = new Map<string, number>()
  for (const row of partSizeRows) {
    partSizeMap.set(row.date as string, (row.partSize as number) ?? 0)
  }

  let cumulativeSize = 0
  const sortedDates = [...trendMap.keys()].sort()
  for (const date of sortedDates) {
    cumulativeSize += partSizeMap.get(date) ?? 0
    trendMap.get(date)!.sizeGrowth = cumulativeSize
  }

  return sortedDates.map(d => trendMap.get(d)!)
}

export function registerHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.DASHBOARD_OVERVIEW, (_event, timeRange?: TimeRange): IpcResult<DatabaseStats> => {
    try {
      if (!timeRange) {
        const stats: DatabaseStats = dbManager.getStats()
        return { success: true, data: stats }
      }

      // Time-range filtered stats
      const sessionCount = dbManager.rawGet<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM session WHERE date(time_created / 1000, 'unixepoch') BETWEEN ? AND ?`,
        [timeRange.startDate, timeRange.endDate]
      )?.cnt ?? 0

      const projectCount = dbManager.rawGet<{ cnt: number }>(
        `SELECT COUNT(DISTINCT project_id) as cnt FROM session WHERE project_id IS NOT NULL AND project_id != '' AND date(time_created / 1000, 'unixepoch') BETWEEN ? AND ?`,
        [timeRange.startDate, timeRange.endDate]
      )?.cnt ?? 0

      const partCount = dbManager.rawGet<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM part WHERE date(time_created / 1000, 'unixepoch') BETWEEN ? AND ?`,
        [timeRange.startDate, timeRange.endDate]
      )?.cnt ?? 0

      // File-level stats remain unchanged
      const baseStats = dbManager.getStats()

      const stats: DatabaseStats = {
        dbSize: baseStats.dbSize,
        sessionCount,
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
    const dateFilter = buildDateFilter('', timeRange)

    if (groupBy) {
      const formatMap: Record<string, string> = {
        day: '%Y-%m-%d',
        week: '%Y-W%W',
        month: '%Y-%m',
      }
      const fmt = formatMap[groupBy] ?? '%Y-%m-%d'

      const rows = dbManager.rawQuery<Record<string, unknown>>(
        `SELECT
          strftime('${fmt}', time_created / 1000, 'unixepoch') as period,
          COALESCE(SUM(tokens_input), 0) as inputTokens,
          COALESCE(SUM(tokens_output), 0) as outputTokens,
          COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
          COALESCE(SUM(tokens_cache_read), 0) as cacheRead,
          COALESCE(SUM(tokens_cache_write), 0) as cacheWrite,
          COALESCE(SUM(cost), 0) as estimatedCost
        FROM session
        WHERE 1=1 ${dateFilter.sql}
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
        COALESCE(SUM(tokens_input), 0) as inputTokens,
        COALESCE(SUM(tokens_output), 0) as outputTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheRead,
        COALESCE(SUM(tokens_cache_write), 0) as cacheWrite,
        COALESCE(SUM(cost), 0) as estimatedCost
      FROM session
      WHERE 1=1 ${dateFilter.sql}`,
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

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_TRENDS, (_event, timeRange?: TimeRange): IpcResult<TrendDataPoint[] | TrendComparison> => {
    try {
    if (!timeRange) {
      // No time range: return all data as before
      const sessionRows = dbManager.rawQuery<Record<string, unknown>>(
        `SELECT
          date(time_created / 1000, 'unixepoch') as date,
          COUNT(*) as newSessions
        FROM session
        GROUP BY date
        ORDER BY date ASC`
      )

      const messageRows = dbManager.rawQuery<Record<string, unknown>>(
        `SELECT
          date(time_created / 1000, 'unixepoch') as date,
          COUNT(*) as messageCount
        FROM message
        GROUP BY date
        ORDER BY date ASC`
      )

      // Single GROUP BY query instead of N+1 per-date queries
      const partSizeRows = dbManager.rawQuery<Record<string, unknown>>(
        `SELECT
          date(time_created / 1000, 'unixepoch') as date,
          COALESCE(SUM(LENGTH(data)), 0) as partSize
        FROM part
        GROUP BY date`
      )

      const trendMap = new Map<string, TrendDataPoint>()

      for (const row of sessionRows) {
        const date = row.date as string
        trendMap.set(date, {
          date,
          newSessions: (row.newSessions as number) ?? 0,
          sizeGrowth: 0,
          messageCount: 0,
        })
      }

      for (const row of messageRows) {
        const date = row.date as string
        const existing = trendMap.get(date)
        if (existing) {
          existing.messageCount = (row.messageCount as number) ?? 0
        } else {
          trendMap.set(date, {
            date,
            newSessions: 0,
            sizeGrowth: 0,
            messageCount: (row.messageCount as number) ?? 0,
          })
        }
      }

      // Apply part sizes from single GROUP BY query
      const partSizeMap = new Map<string, number>()
      for (const row of partSizeRows) {
        partSizeMap.set(row.date as string, (row.partSize as number) ?? 0)
      }

      let cumulativeSize = 0
      const sortedDates = [...trendMap.keys()].sort()
      for (const date of sortedDates) {
        cumulativeSize += partSizeMap.get(date) ?? 0
        trendMap.get(date)!.sizeGrowth = cumulativeSize
      }

      return { success: true, data: sortedDates.map(d => trendMap.get(d)!) }
    }

    // With time range: return current + previous period comparison
    const { startDate, endDate } = timeRange

    // Calculate previous period
    const startMs = new Date(startDate).getTime()
    const endMs = new Date(endDate).getTime()
    const dayDiff = Math.round((endMs - startMs) / (1000 * 60 * 60 * 24))
    const previousEnd = new Date(startMs)
    const previousStart = new Date(startMs - dayDiff * 24 * 60 * 60 * 1000)

    const previousEndDate = previousEnd.toISOString().slice(0, 10)
    const previousStartDate = previousStart.toISOString().slice(0, 10)

    const current = queryTrendData(startDate, endDate)
    const previous = queryTrendData(previousStartDate, previousEndDate)

    const comparison: TrendComparison = { current, previous }
    return { success: true, data: comparison }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}
