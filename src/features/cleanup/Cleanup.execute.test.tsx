/**
 * Cleanup 执行后联动单测（TASK-020 验收）：
 *   - 清理成功后仪表盘缓存失效
 *   - schema 派生状态与侧边栏数据源（dbSize / connected）重新刷新
 *   - 结果页只展示基础计数，不暴露 v2 / 旧版副本分列（v1.3.5 呈现）
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Cleanup from './Cleanup'
import { DataSourceContext, type DataSourceState } from '@/features/datasource/DataSourceContext'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import type { SchemaInfoDTO } from '@/features/datasource/useSchemaInfo'

const { invokeSafe, invalidateDashboardCache } = vi.hoisted(() => ({
  invokeSafe: vi.fn(),
  invalidateDashboardCache: vi.fn(),
}))

vi.mock('@/lib/ipc', () => ({
  invokeSafe,
  isTauri: () => true,
}))

vi.mock('@/features/dashboard/Dashboard', () => ({
  invalidateDashboardCache,
  default: () => null,
}))

function info(overrides: Partial<SchemaInfoDTO> = {}): SchemaInfoDTO {
  return {
    mode: 'v2',
    migrationPhase: 'none',
    hasLegacyTables: false,
    v2SessionCount: 3,
    unsupportedReason: null,
    ...overrides,
  }
}

const PREVIEW = {
  sessionCount: 3,
  messageCount: 20,
  partCount: 20,
  estimatedSize: 2048,
  sessions: [
    {
      id: 'ses_a',
      title: '旧会话 A',
      msg_count: 20,
      total_tokens: 0,
      data_size: 2048,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      time_created: 1,
      time_updated: 2,
    },
  ],
  childSessionIds: [],
  v2: { sessionCount: 3, messageCount: 20, partCount: 20, estimatedSize: 2048 },
  legacy: null,
}

const RESULT = {
  deletedSessions: 3,
  deletedMessages: 20,
  deletedParts: 20,
  freedBytes: 1024,
  vacuumBefore: 4096,
  vacuumAfter: 3072,
  v2: { sessionCount: 3, messageCount: 20, partCount: 20, estimatedSize: 2048 },
  legacy: { sessionCount: 1, messageCount: 4, partCount: 6, estimatedSize: 512 },
}

function renderCleanup() {
  const value: DataSourceState = {
    connected: true,
    dbPath: '/tmp/opencode.db',
    dbSize: 4096,
    schema: { kind: 'ready', info: info() },
    schemaRefreshing: false,
    schemaRefreshError: null,
    refreshSchema: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  }
  const utils = render(
    <MemoryRouter initialEntries={['/cleanup']}>
      <DataSourceContext.Provider value={value}>
        <Cleanup />
      </DataSourceContext.Provider>
    </MemoryRouter>,
  )
  return { ...utils, dataSource: value }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  invokeSafe.mockReset()
  invalidateDashboardCache.mockReset()
})

describe('Cleanup 执行后联动', () => {
  it('invalidates dashboard cache, refreshes schema and data source, and shows base result fields', async () => {
    invokeSafe.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.CLEANUP_PREVIEW) return PREVIEW
      if (channel === IPC_CHANNELS.CLEANUP_EXECUTE) return RESULT
      return []
    })

    vi.useFakeTimers()
    const { dataSource } = renderCleanup()

    fireEvent.click(screen.getByRole('button', { name: /下一步: 预览/ }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('预览清理范围')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /确认清理/ }))
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /确认清理/ }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(invokeSafe).toHaveBeenCalledWith(IPC_CHANNELS.CLEANUP_EXECUTE, expect.anything())
    expect(invalidateDashboardCache).toHaveBeenCalledTimes(1)
    expect(dataSource.refreshSchema).toHaveBeenCalledTimes(1)
    expect(dataSource.refresh).toHaveBeenCalledTimes(1)

    // 结果页恢复 v1.3.5 的基础字段，不再按数据形态分列。
    expect(screen.getByText('清理结果')).toBeTruthy()
    expect(screen.getByText('删除会话数')).toBeTruthy()
    expect(screen.getByText('删除消息数')).toBeTruthy()
    expect(screen.getByText('删除 Part 数')).toBeTruthy()
    expect(screen.getByText('实际释放空间')).toBeTruthy()
    expect(screen.getByText('VACUUM 结果')).toBeTruthy()
    expect(screen.getByText('回收空间')).toBeTruthy()

    // 基础结果的数值仍来自顶层字段（freedBytes 1024 / 回收 4096-3072）
    expect(screen.getAllByText('1.0 KB')).toHaveLength(2)

    // 后端仍返回 v2 / legacy，但界面不再暴露
    expect(screen.queryByText('按数据形态')).toBeNull()
    expect(screen.queryByText('v2 数据')).toBeNull()
    expect(screen.queryByText('旧版副本')).toBeNull()
    expect(screen.queryByText(/消息行/)).toBeNull()
  })
})
