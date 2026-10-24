/**
 * Dashboard 请求生命周期单测（TASK-015 / 016 / 017 验收）：
 *   - 旧范围响应晚到时不覆盖新范围数据
 *   - 同一 key 的 stats 请求单飞，tab 来回切换不重复发起
 *   - 刷新失败时保留旧数据并给出「上一次结果」提示
 *   - 趋势 tab 保活：切走再切回不重新挂载、不重复请求
 *   - 重新挂载命中模块级缓存，不再发起任何 IPC
 *   - 切范围时有可见的更新中状态文案
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Dashboard, { invalidateDashboardCache } from './Dashboard'
import { IPC_CHANNELS } from '@shared/ipc-channels'

const { invokeSafe } = vi.hoisted(() => ({ invokeSafe: vi.fn() }))

vi.mock('@/lib/ipc', () => ({
  invokeSafe,
  isTauri: () => true,
}))

// 图表 mock 把数据写进 DOM 属性，便于断言「旧数据是否保留」。
vi.mock('recharts', () => ({
  PieChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Pie: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Cell: () => null,
  BarChart: ({ data, children }: { data?: unknown; children?: React.ReactNode }) => (
    <div data-testid="bar-chart" data-points={JSON.stringify(data ?? [])}>{children}</div>
  ),
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data?: unknown; children?: React.ReactNode }) => (
    <div data-testid="line-chart" data-points={JSON.stringify(data ?? [])}>{children}</div>
  ),
  Line: () => null,
  CartesianGrid: () => null,
}))

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function overview(rootSessionCount: number) {
  return { rootSessionCount, childSessionCount: 0, projectCount: 0, partCount: 0 }
}

function tokenStats() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    estimatedCost: 0,
    cacheHitRate: 0,
  }
}

function renderDashboard() {
  return render(<MemoryRouter><Dashboard /></MemoryRouter>)
}

function toLocalDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 与 Dashboard 的默认 30 天范围保持一致。 */
function currentRange() {
  return {
    startDate: toLocalDateString(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
    endDate: toLocalDateString(new Date()),
  }
}

/** 默认 mock：health / overview / tokens 正常，排行与趋势返回传入的值。 */
function mockDashboard(channels: Partial<Record<string, unknown>> = {}) {
  invokeSafe.mockImplementation((channel: string, payload?: { groupBy?: string }) => {
    if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
      return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
    }
    if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
      return Promise.resolve(channels[channel] ?? overview(30))
    }
    if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) {
      return Promise.resolve(payload?.groupBy ? [] : tokenStats())
    }
    if (channel in channels) {
      return Promise.resolve(channels[channel])
    }
    return Promise.resolve([])
  })
}

beforeEach(() => {
  invalidateDashboardCache()
})

afterEach(() => {
  cleanup()
  invokeSafe.mockReset()
})

describe('Dashboard 请求生命周期', () => {
  it('discards a late response from an older time range', async () => {
    const held: { payload?: unknown; deferred: Deferred<ReturnType<typeof overview>> }[] = []
    let hold = false
    invokeSafe.mockImplementation((channel: string, payload?: { groupBy?: string }) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
        if (hold) {
          const d = deferred<ReturnType<typeof overview>>()
          held.push({ payload, deferred: d })
          return d.promise
        }
        return Promise.resolve(overview(30))
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) {
        return Promise.resolve(payload?.groupBy ? [] : tokenStats())
      }
      return Promise.resolve([])
    })

    renderDashboard()
    await waitFor(() => expect(screen.getByText('30/0')).toBeTruthy())

    hold = true
    fireEvent.click(screen.getByRole('button', { name: '7天' }))
    fireEvent.click(screen.getByRole('button', { name: '90天' }))
    await waitFor(() => expect(held).toHaveLength(2))

    // 新范围先返回，旧范围后返回：旧响应必须被 generation 丢弃。
    await act(async () => { held[1].deferred.resolve(overview(90)) })
    await waitFor(() => expect(screen.getByText('90/0')).toBeTruthy())

    await act(async () => { held[0].deferred.resolve(overview(7)) })
    expect(screen.getByText('90/0')).toBeTruthy()
    expect(screen.queryByText('7/0')).toBeNull()
  })

  it('runs one stats request per key even when tabbing away and back', async () => {
    const gate = deferred<void>()
    let toolCalls = 0
    invokeSafe.mockImplementation((channel: string, payload?: { groupBy?: string }) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) return Promise.resolve(overview(30))
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) {
        return Promise.resolve(payload?.groupBy ? [] : tokenStats())
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOOL_RANKING) {
        toolCalls += 1
        return gate.promise.then(() => [{ toolName: 'read', count: 3 }])
      }
      if (channel === IPC_CHANNELS.DASHBOARD_SKILL_USAGE) {
        return gate.promise.then(() => [{ skillName: 'brainstorming', count: 2 }])
      }
      if (channel === IPC_CHANNELS.DASHBOARD_MODEL_RANKING) return gate.promise.then(() => [])
      if (channel === IPC_CHANNELS.DASHBOARD_PROVIDER_STATS) return gate.promise.then(() => [])
      if (channel === IPC_CHANNELS.DASHBOARD_PROJECT_RANKING) return gate.promise.then(() => [])
      return Promise.resolve([])
    })

    renderDashboard()
    fireEvent.click(screen.getByRole('button', { name: /统计/ }))
    await waitFor(() => expect(toolCalls).toBe(1))

    fireEvent.click(screen.getByRole('button', { name: /概览/ }))
    fireEvent.click(screen.getByRole('button', { name: /统计/ }))
    await act(async () => { /* 让 effect 跑一轮 */ })
    expect(toolCalls).toBe(1)

    await act(async () => { gate.resolve() })
    await waitFor(() => expect(screen.getAllByTestId('bar-chart').some(
      el => el.getAttribute('data-points')?.includes('read'),
    )).toBe(true))
  })

  it('keeps previous stats data when a refresh fails', async () => {
    let fail = false
    invokeSafe.mockImplementation((channel: string, payload?: { groupBy?: string }) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) return Promise.resolve(overview(30))
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) {
        return Promise.resolve(payload?.groupBy ? [] : tokenStats())
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOOL_RANKING) {
        return fail ? Promise.reject(new Error('tool query failed')) : Promise.resolve([{ toolName: 'old-tool', count: 5 }])
      }
      if (channel === IPC_CHANNELS.DASHBOARD_SKILL_USAGE) return Promise.resolve([])
      if (channel === IPC_CHANNELS.DASHBOARD_MODEL_RANKING) return Promise.resolve([])
      if (channel === IPC_CHANNELS.DASHBOARD_PROVIDER_STATS) return Promise.resolve([])
      if (channel === IPC_CHANNELS.DASHBOARD_PROJECT_RANKING) {
        return fail ? Promise.reject(new Error('project query failed')) : Promise.resolve([])
      }
      return Promise.resolve([])
    })

    renderDashboard()
    fireEvent.click(screen.getByRole('button', { name: /统计/ }))
    await waitFor(() => expect(screen.getAllByTestId('bar-chart').some(
      el => el.getAttribute('data-points')?.includes('old-tool'),
    )).toBe(true))

    fail = true
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))

    await waitFor(() => expect(screen.getAllByText(/更新失败，仍显示上一次结果/).length).toBeGreaterThan(0))
    // 旧数据仍留在图表里，且没有退化成空态。
    expect(screen.getAllByTestId('bar-chart').some(
      el => el.getAttribute('data-points')?.includes('old-tool'),
    )).toBe(true)
    expect(screen.queryByText('暂无工具使用数据')).toBeNull()
  })

  it('mounts the trends panel once and keeps it alive across tab switches', async () => {
    mockDashboard()
    renderDashboard()

    fireEvent.click(screen.getByRole('button', { name: /趋势/ }))
    await waitFor(() => expect(invokeSafe).toHaveBeenCalledWith(IPC_CHANNELS.DASHBOARD_SESSION_TREND, expect.anything(), false))
    const panel = screen.getByTestId('trends-panel')
    expect(panel.hidden).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /统计/ }))
    await waitFor(() => expect(invokeSafe).toHaveBeenCalledWith(IPC_CHANNELS.DASHBOARD_TOOL_RANKING, expect.anything()))
    expect(screen.getByTestId('trends-panel')).toBe(panel)
    expect(panel.hidden).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /趋势/ }))
    await act(async () => { /* 等 effect 判定 */ })
    expect(panel.hidden).toBe(false)
    // 只数「当前范围」的趋势请求；对比上期会另外请求 prevRange，不算重复挂载。
    const range = currentRange()
    const currentRangeTrendCalls = invokeSafe.mock.calls.filter(
      ([channel, payload, onlyRoot]) =>
        channel === IPC_CHANNELS.DASHBOARD_SESSION_TREND &&
        onlyRoot === false &&
        (payload as { startDate?: string; endDate?: string } | undefined)?.startDate === range.startDate &&
        (payload as { startDate?: string; endDate?: string } | undefined)?.endDate === range.endDate,
    )
    expect(currentRangeTrendCalls).toHaveLength(1)
  })

  it('re-mounts from the module cache without any IPC', async () => {
    mockDashboard()
    const first = renderDashboard()
    await waitFor(() => expect(screen.getByText('30/0')).toBeTruthy())

    first.unmount()
    invokeSafe.mockClear()

    renderDashboard()
    expect(screen.getByText('30/0')).toBeTruthy()
    await act(async () => { /* 让挂载 effect 跑完 */ })
    expect(invokeSafe).not.toHaveBeenCalled()
  })

  it('shows an updating status while switching ranges with stale data on screen', async () => {
    const gate = deferred<ReturnType<typeof overview>>()
    let hold = false
    invokeSafe.mockImplementation((channel: string, payload?: { groupBy?: string }) => {
      if (channel === IPC_CHANNELS.DATABASE_HEALTH) {
        return Promise.resolve({ ok: true, pageCount: 1, freelistPages: 0, walSize: 0 })
      }
      if (channel === IPC_CHANNELS.DASHBOARD_OVERVIEW) {
        return hold ? gate.promise : Promise.resolve(overview(30))
      }
      if (channel === IPC_CHANNELS.DASHBOARD_TOKENS) {
        return Promise.resolve(payload?.groupBy ? [] : tokenStats())
      }
      return Promise.resolve([])
    })

    renderDashboard()
    await waitFor(() => expect(screen.getByText('30/0')).toBeTruthy())

    hold = true
    fireEvent.click(screen.getByRole('button', { name: '7天' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('正在更新数据，当前显示上一次结果'))
    // 进度文案出现时，旧数据仍在页面上。
    expect(screen.getByText('30/0')).toBeTruthy()

    await act(async () => { gate.resolve(overview(7)) })
    await waitFor(() => expect(screen.getByText('7/0')).toBeTruthy())
  })
})
