/**
 * Dashboard 降级态单测 —— 覆盖规格 08.1 第 5.2 / 5.6 节：
 *   - unsupported：整块受限占位，不发起任何统计 IPC，不显示任何统计数字
 *   - running：UI 不再显示迁移横幅 / 写暂停（写保护由后端自行校验）
 *   - v2 统计降级：tokens 失败仍渲染 overview，占位文案统一
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Dashboard, { invalidateDashboardCache } from './Dashboard'
import { DataSourceContext, type DataSourceState } from '@/features/datasource/DataSourceContext'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import type { SchemaInfoDTO, SchemaUiState } from '@/features/datasource/useSchemaInfo'

const { invokeSafe } = vi.hoisted(() => ({ invokeSafe: vi.fn() }))

vi.mock('@/lib/ipc', () => ({
  invokeSafe,
  isTauri: () => true,
}))

vi.mock('recharts', () => ({
  PieChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Pie: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Cell: () => null,
  BarChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Line: () => null,
  CartesianGrid: () => null,
}))

afterEach(() => {
  cleanup()
  invokeSafe.mockReset()
})

beforeEach(() => {
  // 模块级缓存会在用例之间共享，先清空保证隔离
  invalidateDashboardCache()
})

function info(overrides: Partial<SchemaInfoDTO> = {}): SchemaInfoDTO {
  return {
    mode: 'v1',
    migrationPhase: 'none',
    hasLegacyTables: false,
    v2SessionCount: 0,
    unsupportedReason: null,
    ...overrides,
  }
}

function renderDashboard(schema: SchemaUiState) {
  const value: DataSourceState = {
    connected: true,
    dbPath: '/tmp/opencode.db',
    dbSize: 1024,
    schema,
    schemaRefreshing: false,
    schemaRefreshError: null,
    refreshSchema: vi.fn().mockResolvedValue(undefined),
  }
  return render(
    <MemoryRouter>
      <DataSourceContext.Provider value={value}>
        <Dashboard />
      </DataSourceContext.Provider>
    </MemoryRouter>,
  )
}

const STATS_CHANNELS = [
  IPC_CHANNELS.DASHBOARD_OVERVIEW,
  IPC_CHANNELS.DASHBOARD_TOKENS,
  IPC_CHANNELS.DASHBOARD_TOOL_RANKING,
  IPC_CHANNELS.DASHBOARD_SKILL_USAGE,
  IPC_CHANNELS.DASHBOARD_MODEL_RANKING,
  IPC_CHANNELS.DASHBOARD_PROVIDER_STATS,
  IPC_CHANNELS.DASHBOARD_PROJECT_RANKING,
]

describe('Dashboard 降级态', () => {
  it('unsupported：整块受限占位，不发起任何统计 IPC，也不显示统计数字', async () => {
    invokeSafe.mockResolvedValue({})

    renderDashboard({ kind: 'unsupported', reason: '缺少 session_message / session_v2 等表', path: '/tmp/bad.db' })

    await waitFor(() => expect(screen.getByTestId('schema-blocked-state')).toBeTruthy())
    expect(screen.getByText('无法读取这个数据库')).toBeTruthy()
    expect(screen.getByText(/为避免误判，这里不显示任何统计数字/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新检测' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开所在目录' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '切换数据源' })).toBeTruthy()

    // 禁止出现的文案
    expect(screen.queryByText(/暂无Token数据/)).toBeNull()
    expect(screen.queryByText(/0 个会话/)).toBeNull()
    expect(screen.queryByText(/共 0 条会话/)).toBeNull()
    expect(screen.queryByText(/暂无会话数据/)).toBeNull()
    expect(screen.queryByText(/数据库状态不可用/)).toBeNull()

    // 不发起任何统计 IPC
    const statCalls = invokeSafe.mock.calls.filter(([channel]) => STATS_CHANNELS.includes(channel))
    expect(statCalls).toHaveLength(0)
  })

  it('running：VACUUM / WAL Checkpoint 按钮不再因迁移态在 UI 上禁用', async () => {
    invokeSafe.mockImplementation((channel: string, payload?: { groupBy?: string }) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
        return Promise.resolve({ rootSessionCount: 3, childSessionCount: 1, projectCount: 2, partCount: 42 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS && payload?.groupBy) return Promise.resolve([])
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) {
        return Promise.resolve({ inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cacheRead: 4, cacheWrite: 5, estimatedCost: 1, cacheHitRate: 10 })
      }
      return Promise.resolve([])
    })

    renderDashboard({ kind: 'ready', info: info({ mode: 'v1', migrationPhase: 'running' }) })

    await waitFor(() => expect(screen.getByRole('button', { name: /一键 VACUUM/ })).toBeTruthy())
    expect(screen.queryByTestId('schema-status-banner')).toBeNull()
    expect(screen.queryByText(/清理、删除与恢复已暂停/)).toBeNull()

    const vacuum = screen.getByRole('button', { name: /一键 VACUUM/ }) as HTMLButtonElement
    expect(vacuum.disabled).toBe(false)

    const checkpoint = screen.getByRole('button', { name: /WAL Checkpoint/ }) as HTMLButtonElement
    expect(checkpoint.disabled).toBe(false)

    // 完整性检查入口已从仪表盘移除（改由 CLI 文档承载）
    expect(screen.queryByRole('button', { name: /完整性检查/ })).toBeNull()
  })

  it('v2 统计降级：tokens 失败仍渲染 overview，并展示统一「暂不可用」占位', async () => {
    // 后端真实错误串：compat/stats_v2.rs 的 query_error →「统计查询失败（token）：…」
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
        return Promise.resolve({ rootSessionCount: 3, childSessionCount: 1, projectCount: 2, partCount: 42 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) {
        return Promise.reject(new Error('统计查询失败（token）：no such table: part'))
      }
      return Promise.resolve([])
    })

    renderDashboard({ kind: 'ready', info: info({ mode: 'v2', migrationPhase: 'completed' }) })

    // overview 仍然渲染
    await waitFor(() => expect(screen.getByText('根/子会话数')).toBeTruthy())
    expect(screen.getByText('项目数')).toBeTruthy()
    // v2 口径：消息行数
    expect(screen.getByText('消息行数')).toBeTruthy()
    // 统一「暂不可用」占位，不显示「暂无Token数据」
    expect(screen.getByText('Token 统计暂不可用')).toBeTruthy()
    expect(screen.queryByText('暂无Token数据')).toBeNull()
    // 整页没有被打成「数据加载失败」
    expect(screen.queryByText('数据加载失败')).toBeNull()
  })

  it('统计失败（任意原因）都落到统一「暂不可用」态，前端不再对特定错误串分支', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
        return Promise.resolve({ rootSessionCount: 3, childSessionCount: 1, projectCount: 2, partCount: 42 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) {
        return Promise.reject(new Error('统计查询失败（token）：database is locked'))
      }
      return Promise.resolve([])
    })

    renderDashboard({ kind: 'ready', info: info({ mode: 'v2', migrationPhase: 'completed' }) })

    await waitFor(() => expect(screen.getByText('Token 统计暂不可用')).toBeTruthy())
    expect(screen.queryByText(/1\.4\.0/)).toBeNull()
    expect(screen.queryByText(/正式版/)).toBeNull()
  })

  it('invalidateDashboardCache 丢弃缓存后，仪表盘会重新拉数据（P2-14）', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
        return Promise.resolve({ rootSessionCount: 3, childSessionCount: 1, projectCount: 2, partCount: 42 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) {
        return Promise.resolve({ inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cacheRead: 4, cacheWrite: 5, estimatedCost: 1, cacheHitRate: 10 })
      }
      return Promise.resolve([])
    })

    const overviewCalls = () =>
      invokeSafe.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.DASHBOARD_OVERVIEW)

    // 第一次挂载：拉一次数据并进缓存
    const first = render(<MemoryRouter><Dashboard /></MemoryRouter>)
    await waitFor(() => expect(overviewCalls()).toHaveLength(1))
    first.unmount()

    // 缓存还在 → 再挂载不重新拉（这正是「重开后仍显示旧数字」的成因）
    const second = render(<MemoryRouter><Dashboard /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('根/子会话数')).toBeTruthy())
    expect(overviewCalls()).toHaveLength(1)
    second.unmount()

    // 丢弃缓存 → 再挂载重新拉数据
    invalidateDashboardCache()
    render(<MemoryRouter><Dashboard /></MemoryRouter>)
    await waitFor(() => expect(overviewCalls()).toHaveLength(2))
  })
})
