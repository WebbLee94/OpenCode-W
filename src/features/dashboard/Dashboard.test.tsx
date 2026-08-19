import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Dashboard from './Dashboard'
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
})
