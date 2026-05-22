import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { DatabaseStats, TokenStats, ToolRanking, SkillUsage, TrendDataPoint } from '../../shared/types'
import dbManager from '../database'

export function registerHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.DASHBOARD_OVERVIEW, () => {
    try {
      const stats: DatabaseStats = dbManager.getStats()
      return { success: true as const, data: stats }
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_TOKENS, () => {
    try {
    const row = dbManager.rawGet<Record<string, number>>(
      `SELECT
        COALESCE(SUM(tokens_input), 0) as inputTokens,
        COALESCE(SUM(tokens_output), 0) as outputTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheRead,
        COALESCE(SUM(tokens_cache_write), 0) as cacheWrite,
        COALESCE(SUM(cost), 0) as estimatedCost
      FROM session`
    )

    const totalInput = row?.inputTokens ?? 0
    const cacheRead = row?.cacheRead ?? 0
    const cacheHitRate = totalInput > 0 ? (cacheRead / totalInput) * 100 : 0

    const tokenStats: TokenStats = {
      inputTokens: totalInput,
      outputTokens: row?.outputTokens ?? 0,
      reasoningTokens: row?.reasoningTokens ?? 0,
      cacheRead,
      cacheWrite: row?.cacheWrite ?? 0,
      estimatedCost: row?.estimatedCost ?? 0,
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
    }

    return { success: true as const, data: tokenStats }
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_TOOL_RANKING, () => {
    try {
    // type is inside data JSON, not a column
    const rows = dbManager.rawQuery<Record<string, unknown>>(
      `SELECT
        COALESCE(json_extract(data, '$.tool'), 'unknown') as toolName,
        COUNT(*) as count
      FROM part
      WHERE json_extract(data, '$.type') = 'tool'
      GROUP BY toolName
      ORDER BY count DESC
      LIMIT 20`
    )

    const ranking: ToolRanking[] = rows.map(r => ({
      toolName: r.toolName as string,
      count: r.count as number,
    }))

    return { success: true as const, data: ranking }
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_SKILL_USAGE, () => {
    try {
    // type is inside data JSON, not a column
    const rows = dbManager.rawQuery<Record<string, unknown>>(
      `SELECT
        COALESCE(json_extract(data, '$.state.input.name'), 'unknown') as skillName,
        COUNT(*) as count
      FROM part
      WHERE json_extract(data, '$.type') = 'tool'
        AND json_extract(data, '$.tool') = 'skill'
      GROUP BY skillName
      ORDER BY count DESC
      LIMIT 20`
    )

    const usage: SkillUsage[] = rows.map(r => ({
      skillName: r.skillName as string,
      count: r.count as number,
    }))

    return { success: true as const, data: usage }
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_TRENDS, () => {
    try {
    // time_created is integer milliseconds - convert to date
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

    // Build a map of date -> data
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

    // Calculate cumulative size growth
    let cumulativeSize = 0
    const sortedDates = [...trendMap.keys()].sort()
    for (const date of sortedDates) {
      const point = trendMap.get(date)!
      const daySizeRow = dbManager.rawGet<{ total: number | null }>(
        `SELECT COALESCE(SUM(LENGTH(data)), 0) as total
        FROM part
        WHERE date(time_created / 1000, 'unixepoch') = ?`,
        [date]
      )
      const daySize = daySizeRow?.total ?? 0
      cumulativeSize += daySize
      point.sizeGrowth = cumulativeSize
    }

    return { success: true as const, data: sortedDates.map(d => trendMap.get(d)!) }
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
}
