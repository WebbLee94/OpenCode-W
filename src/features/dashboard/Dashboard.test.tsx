import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Dashboard, { invalidateDashboardCache } from './Dashboard'
import { IPC_CHANNELS } from '@shared/ipc-channels'

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

beforeEach(() => {
  // 模块级缓存会在用例之间共享，先清空保证每个用例都从真实首载开始。
  invalidateDashboardCache()
})

afterEach(() => {
  cleanup()
  invokeSafe.mockReset()
})

describe('Dashboard health hot path', () => {
  it('uses lightweight health on initial load while stats and trends tabs never invoke integrity diagnostics', async () => {
    invokeSafe.mockImplementation((channel: string, payload?: { groupBy?: string }) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
        return Promise.resolve({ rootSessionCount: 0, childSessionCount: 0, projectCount: 0, partCount: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS && payload?.groupBy) return Promise.resolve([])
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) return Promise.resolve({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheRead: 0, cacheWrite: 0, estimatedCost: 0, cacheHitRate: 0 })
      return Promise.resolve([])
    })

    render(<MemoryRouter><Dashboard /></MemoryRouter>)

    await waitFor(() => expect(invokeSafe.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.DATABASE_HEALTH)).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: /统计/ }))
    await waitFor(() => expect(invokeSafe).toHaveBeenCalledWith(IPC_CHANNELS.DASHBOARD_TOOL_RANKING, expect.anything()))
    expect(invokeSafe.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.DATABASE_HEALTH)).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /趋势/ }))
    await waitFor(() => expect(invokeSafe).toHaveBeenCalledWith(IPC_CHANNELS.DASHBOARD_SESSION_TREND, expect.anything(), false))
    expect(invokeSafe.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.DATABASE_HEALTH)).toHaveLength(2)

    expect(invokeSafe.mock.calls.some(([channel]) => channel === IPC_CHANNELS.DATABASE_INTEGRITY_CHECK)).toBe(false)
  })

  it('keeps the aggregate token DTO request separate from grouped chart data', async () => {
    invokeSafe.mockImplementation((channel: string, payload?: { groupBy?: string }) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
        return Promise.resolve({ rootSessionCount: 0, childSessionCount: 0, projectCount: 0, partCount: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS && payload?.groupBy) {
        return Promise.resolve([{ period: '2026-08-01', inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cacheRead: 4, cacheWrite: 5, estimatedCost: 0.1 }])
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) {
        return Promise.resolve({ inputTokens: 10, outputTokens: 20, reasoningTokens: 30, cacheRead: 40, cacheWrite: 50, estimatedCost: 0.3, cacheHitRate: 80 })
      }
      return Promise.resolve([])
    })

    render(<MemoryRouter><Dashboard /></MemoryRouter>)

    // 先等首载完成，再清空调用记录，单独观察刷新这一次的请求。
    await waitFor(() => expect(invokeSafe.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.DASHBOARD_TOKENS)).toHaveLength(2))
    invokeSafe.mockClear()

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(invokeSafe.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.DASHBOARD_TOKENS)).toHaveLength(2))
    const tokenCalls = invokeSafe.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.DASHBOARD_TOKENS)
    expect(tokenCalls.some(([, payload]) => !(payload as { groupBy?: string })?.groupBy)).toBe(true)
    expect(tokenCalls.some(([, payload]) => (payload as { groupBy?: string })?.groupBy === 'day')).toBe(true)
  })

  it('only requests previous trend series for enabled comparisons', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
        return Promise.resolve({ rootSessionCount: 0, childSessionCount: 0, projectCount: 0, partCount: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) return Promise.resolve([])
      return Promise.resolve([])
    })

    render(<MemoryRouter><Dashboard /></MemoryRouter>)
    await waitFor(() => expect(invokeSafe.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.DASHBOARD_TOKENS)).toHaveLength(2))
    invokeSafe.mockClear()

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(invokeSafe.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.DASHBOARD_TOKENS)).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: /趋势/ }))
    await waitFor(() => expect(invokeSafe).toHaveBeenCalledWith(IPC_CHANNELS.DASHBOARD_SESSION_TREND, expect.anything(), false))

    const comparisons = screen.getAllByRole('checkbox')
    comparisons.forEach((checkbox) => fireEvent.click(checkbox))
    invokeSafe.mockClear()

    fireEvent.click(comparisons[0])
    await waitFor(() => expect(invokeSafe).toHaveBeenCalledWith(IPC_CHANNELS.DASHBOARD_COST_TREND, expect.anything()))
    expect(invokeSafe.mock.calls.some(([channel]) => channel === IPC_CHANNELS.DASHBOARD_SESSION_TREND)).toBe(false)
    expect(invokeSafe.mock.calls.some(([channel]) => channel === IPC_CHANNELS.DASHBOARD_MESSAGE_TREND)).toBe(false)
  })

  it('loads and renders project ranking data with folder-name labels on stats tab', async () => {
    const projectData = [
      { project: 'my-app', tokenCount: 5000, totalCost: 0.5 },
      { project: 'backend-api', tokenCount: 3000, totalCost: 0.3 },
      { project: 'frontend', tokenCount: 1000, totalCost: 0.1 },
    ]
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
        return Promise.resolve({ rootSessionCount: 0, childSessionCount: 0, projectCount: 0, partCount: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) return Promise.resolve({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheRead: 0, cacheWrite: 0, estimatedCost: 0, cacheHitRate: 0 })
      if (channel === IPC_CHANNELS.DASHBOARD_PROJECT_RANKING) return Promise.resolve(projectData)
      return Promise.resolve([])
    })

    render(<MemoryRouter><Dashboard /></MemoryRouter>)

    fireEvent.click(screen.getByRole('button', { name: /统计/ }))
    await waitFor(() => expect(invokeSafe).toHaveBeenCalledWith(IPC_CHANNELS.DASHBOARD_PROJECT_RANKING, expect.anything()))

    expect(screen.getByText(/项目 Token 排行 TOP 10/)).toBeDefined()

    const projectCalls = invokeSafe.mock.calls.filter(([ch]) => ch === IPC_CHANNELS.DASHBOARD_PROJECT_RANKING)
    expect(projectCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('keeps project ranking visible after refresh while remaining on the stats tab', async () => {
    const projectData = [
      { project: 'core', tokenCount: 900, totalCost: 0.9 },
    ]
    invokeSafe.mockImplementation((channel: string, payload?: { groupBy?: string }) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
        return Promise.resolve({ rootSessionCount: 0, childSessionCount: 0, projectCount: 0, partCount: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS && payload?.groupBy) {
        return Promise.resolve([{ period: '2026-08-01', inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cacheRead: 4, cacheWrite: 5, estimatedCost: 0.1 }])
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) {
        return Promise.resolve({ inputTokens: 10, outputTokens: 20, reasoningTokens: 30, cacheRead: 40, cacheWrite: 50, estimatedCost: 0.3, cacheHitRate: 80 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_PROJECT_RANKING) {
        return Promise.resolve(projectData)
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOOL_RANKING) return Promise.resolve([])
      if (channel === IPC_CHANNELS.DASHBOARD_SKILL_USAGE) return Promise.resolve([])
      if (channel === IPC_CHANNELS.DASHBOARD_MODEL_RANKING) return Promise.resolve([])
      if (channel === IPC_CHANNELS.DASHBOARD_PROVIDER_STATS) return Promise.resolve([])
      return Promise.resolve([])
    })

    render(<MemoryRouter><Dashboard /></MemoryRouter>)

    fireEvent.click(screen.getByRole('button', { name: /统计/ }))
    await waitFor(() => expect(invokeSafe).toHaveBeenCalledWith(IPC_CHANNELS.DASHBOARD_PROJECT_RANKING, expect.anything()))
    expect(screen.getByText(/项目 Token 排行 TOP 10/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(invokeSafe.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.DASHBOARD_PROJECT_RANKING)).toHaveLength(2))

    expect(screen.getByText(/项目 Token 排行 TOP 10/)).toBeDefined()
  })

  it('does not render an integrity check entry and never calls the diagnostic IPC', async () => {
    invokeSafe.mockImplementation((channel: string, payload?: { groupBy?: string }) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
        return Promise.resolve({ rootSessionCount: 3, childSessionCount: 1, projectCount: 2, partCount: 42 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) {
        return Promise.resolve(payload?.groupBy ? [] : { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheRead: 0, cacheWrite: 0, estimatedCost: 0, cacheHitRate: 0 })
      }
      return Promise.resolve([])
    })

    render(<MemoryRouter><Dashboard /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('3/1')).toBeTruthy())

    // 维护者决定从仪表盘直接移除入口，改由文档给出 CLI 命令。
    expect(screen.queryByRole('button', { name: /完整性检查/ })).toBeNull()
    expect(screen.queryByText('完整性检查')).toBeNull()
    expect(invokeSafe.mock.calls.some(([channel]) => channel === IPC_CHANNELS.DATABASE_INTEGRITY_CHECK)).toBe(false)
  })

  it('shows a persistent vacuum failure notice with actions instead of a raw toast', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
        return Promise.resolve({ rootSessionCount: 0, childSessionCount: 0, projectCount: 0, partCount: 0 })
      }
      if (channel === IPC_CHANNELS.DATABASE_VACUUM) {
        return Promise.reject(new Error('views may not be indexed'))
      }
      return Promise.resolve([])
    })

    render(<MemoryRouter><Dashboard /></MemoryRouter>)
    await waitFor(() => expect(screen.getByRole('button', { name: /一键 VACUUM/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /一键 VACUUM/ }))

    // 常驻提示框（role=alert）：友好结论 + 后续动作，不再用 3 秒 toast
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('磁盘回收未完成，数据本身不受影响')
    expect(alert.textContent).toContain('建议先退出 OpenCode 后重试；或先备份再通过清理向导处理')
    // 失败原因以小字保留，不把 raw error 藏到无处；也不再有生硬的「VACUUM 失败:」前缀
    expect(alert.textContent).toContain('失败原因：views may not be indexed')
    expect(screen.queryByText(/VACUUM 失败/)).toBeNull()

    // 两个可选动作（react-router Link，不新增路由/请求）
    const hrefs = Array.from(alert.querySelectorAll('a')).map(a => a.getAttribute('href'))
    expect(hrefs).toContain('/backup')
    expect(hrefs).toContain('/cleanup')

    // 手动关闭后消失
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
