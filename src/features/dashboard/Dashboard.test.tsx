import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Dashboard, { invalidateDashboardCache } from './Dashboard'
import { IPC_CHANNELS } from '@shared/ipc-channels'

const { invokeSafe, tooltipContents } = vi.hoisted(() => ({
  invokeSafe: vi.fn(),
  /**
   * 被渲染出来的 recharts `<Tooltip content={...}>` 回调（按渲染顺序）。
   *
   * 现有 mock 把 Tooltip 整个丢掉（`Tooltip: () => null`），于是 tooltip 文案
   * 完全没有回归保护。趋势 / 模型 / 项目三处都有自定义 content，这里把它们
   * 抓下来，测试里直接调用并渲染其返回值。
   */
  tooltipContents: [] as Array<TooltipContentFn>,
}))

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
  Tooltip: ({ content }: { content?: TooltipContentFn }) => {
    if (typeof content === 'function') tooltipContents.push(content)
    return null
  },
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Line: () => null,
  CartesianGrid: () => null,
}))

/** recharts 自定义 tooltip content 的最小调用签名（只用到这几个字段）。 */
interface TooltipProbeArgs {
  active?: boolean
  label?: string
  payload?: Array<{
    color?: string
    name?: string
    value?: number
    payload?: Record<string, unknown>
  }>
}

type TooltipContentFn = (args: TooltipProbeArgs) => React.ReactNode

beforeEach(() => {
  // 模块级缓存会在用例之间共享，先清空保证每个用例都从真实首载开始。
  invalidateDashboardCache()
  tooltipContents.length = 0
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

// ── tooltip 口径词 ──────────────────────────────────────────────────────

/** recharts 会把 X 轴的取值作为 `label` 传给自定义 content。 */
const TOOLTIP_PROBE: TooltipProbeArgs = {
  active: true,
  label: '2026-10-24',
  payload: [
    {
      color: '#3B82F6',
      name: '输入',
      value: 1,
      payload: {
        period: '2026-10-24',
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 3,
        cacheRead: 4,
        cacheWrite: 5,
        estimatedCost: 0.5,
        name: 'probe',
        tokens: 123,
        cost: 1.5,
      },
    },
  ],
}

/** 渲染某个被捕获的 Tooltip content，返回其纯文本。 */
function renderTooltipText(content: TooltipContentFn, args: TooltipProbeArgs = TOOLTIP_PROBE): string {
  const { container, unmount } = render(<>{content(args)}</>)
  const text = container.textContent ?? ''
  unmount()
  return text
}

/**
 * 按输出特征定位某个 Tooltip content。
 *
 * 从**后往前**找：每次重渲染都会再推一份 content，最后一份才是当前状态的。
 */
function findTooltipContent(match: (text: string) => boolean, label: string): TooltipContentFn {
  for (let i = tooltipContents.length - 1; i >= 0; i -= 1) {
    if (match(renderTooltipText(tooltipContents[i]))) return tooltipContents[i]
  }
  throw new Error(`没有找到符合条件的 Tooltip：${label}`)
}

/**
 * 默认 mock：health / overview / tokens 正常，且**趋势分组数据非空**
 * （否则趋势折线图不渲染，抓不到它的 tooltip）。
 */
function mockDashboardIpc() {
  invokeSafe.mockImplementation((channel: string, payload?: { groupBy?: string }) => {
    if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
      return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
    }
    if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
      return Promise.resolve({ rootSessionCount: 3, childSessionCount: 1, projectCount: 2, partCount: 42 })
    }
    if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) {
      if (payload?.groupBy) {
        return Promise.resolve([
          { period: '2026-10-24', inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cacheRead: 4, cacheWrite: 5, estimatedCost: 0.5 },
        ])
      }
      return Promise.resolve({ inputTokens: 10, outputTokens: 20, reasoningTokens: 30, cacheRead: 40, cacheWrite: 50, estimatedCost: 0.3, cacheHitRate: 80 })
    }
    if (channel === IPC_CHANNELS.DASHBOARD_MODEL_RANKING) {
      return Promise.resolve([{ model: 'gpt-5', tokenCount: 900, totalCost: 1 }])
    }
    if (channel === IPC_CHANNELS.DASHBOARD_PROVIDER_STATS) {
      return Promise.resolve([{ provider: 'openai', tokenCount: 900, totalCost: 1 }])
    }
    if (channel === IPC_CHANNELS.DASHBOARD_PROJECT_RANKING) {
      return Promise.resolve([{ project: 'my-app', tokenCount: 800, totalCost: 0.8 }])
    }
    return Promise.resolve([])
  })
}

describe('Dashboard tooltip 口径词', () => {
  it('趋势 tooltip 首行是分桶日期，合计行是「当日合计」而不是「Token 总计」', async () => {
    mockDashboardIpc()
    render(<MemoryRouter><Dashboard /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('根/子会话数')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /趋势/ }))

    const trend = findTooltipContent((t) => t.includes('缓存命中率'), '趋势 Token 趋势')
    const text = renderTooltipText(trend)
    // 首行就是这一桶的日期（此前 tooltip 首行没有日期）
    expect(text.startsWith('2026-10-24')).toBe(true)
    // 合计行说清楚是「当日」而不是整个范围的总量
    expect(text).toContain('当日合计: 15')
    expect(text).not.toContain('Token 总计')
  })

  it('切「周」后趋势 tooltip 首行是周编号、合计行变「本周合计」', async () => {
    mockDashboardIpc()
    render(<MemoryRouter><Dashboard /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('根/子会话数')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /趋势/ }))
    fireEvent.click(screen.getByRole('button', { name: '周' }))

    // 口径词跟着分桶粒度走
    await waitFor(() => {
      const trend = findTooltipContent((t) => t.includes('缓存命中率'), '趋势 Token 趋势')
      const text = renderTooltipText(trend, { ...TOOLTIP_PROBE, label: '2026-W43' })
      expect(text).toContain('本周合计: 15')
      expect(text).not.toContain('当日合计')
    })

    const trend = findTooltipContent((t) => t.includes('缓存命中率'), '趋势 Token 趋势')
    const text = renderTooltipText(trend, { ...TOOLTIP_PROBE, label: '2026-W43' })
    // 首行是周编号（2026-W43）
    expect(text.startsWith('2026-W43')).toBe(true)
  })

  it('统计 tab 的模型 / 项目 tooltip 用「所选范围合计」', async () => {
    mockDashboardIpc()
    render(<MemoryRouter><Dashboard /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('根/子会话数')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /统计/ }))
    // 等统计数据落位（Provider 徽标出现 = stats 段已加载）
    await waitFor(() => expect(screen.getByText(/openai: 900\.00 tokens/)).toBeTruthy())

    // 模型 tooltip：没有「费用」行；项目 tooltip：有「费用」行
    const model = findTooltipContent((t) => t.includes('所选范围合计') && !t.includes('费用'), '模型排行')
    expect(renderTooltipText(model)).toContain('所选范围合计: 123.00')
    expect(renderTooltipText(model)).not.toContain('Token 总计')

    const project = findTooltipContent((t) => t.includes('费用'), '项目排行')
    expect(renderTooltipText(project)).toContain('所选范围合计: 123.00')
    expect(renderTooltipText(project)).not.toContain('Token 总计')
  })

  it('概览 Token 统计的总计行标签说明是「所选范围」合计', async () => {
    mockDashboardIpc()
    render(<MemoryRouter><Dashboard /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('根/子会话数')).toBeTruthy())

    expect(screen.getByText('所选范围 Token 合计')).toBeTruthy()
    expect(screen.queryByText('Token 总计')).toBeNull()
  })
})
